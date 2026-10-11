//! The tile cache: every canvas tile the render, reveal and presentation passes paint, held in engine memory under
//! a working-memory budget with least-recently-used eviction (docs/ARCHITECTURE.md §十 "瓦片缓存").
//!
//! The cache never touches storage. When a tile the caller asks for is not resident, the caller makes room with
//! [`TileCache::evict`] (each evicted tile is handed back so the host can store it if it is dirty) and then
//! supplies the tile's stored planes, or none for a tile that was never written, with [`TileCache::insert`]. Which
//! tiles a flush must write comes from [`TileCache::dirty`]; the host encodes and stores them and reports each back
//! with [`TileCache::saved`]. Tile pixels are stored raw: encoding them (PNG) is the host's business.
//!
//! The clock is the host's too: a write records the host's timestamp in [`Tile::touched`], and a periodic flush
//! passes the time of the previous one so tiles still being painted every frame are left for later.

use std::collections::HashMap;

/// Side of one quality/ownership block in native pixels.
pub const QUALITY_BLOCK: usize = 16;

/// Identifies one tile: canvas, pyramid level and tile coordinates. Its storage path is `canvas/level/x_y`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub canvas: String,
    pub level: u32,
    pub x: i32,
    pub y: i32,
}

impl TileKey {
    pub fn new(canvas: &str, level: u32, x: i32, y: i32) -> Self {
        Self {
            canvas: canvas.to_string(),
            level,
            x,
            y,
        }
    }

    /// `canvas/level/x_y`, the suffix of the tile's `tile/` and `tile-index/` storage keys.
    pub fn path(&self) -> String {
        format!("{}/{}/{}_{}", self.canvas, self.level, self.x, self.y)
    }
}

/// One resident tile: RGBA pixels and the side planes kept per pixel (coverage, provisional) and per 16×16 block
/// (quality, conflicts, owner frame + 1, score, frozen).
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub key: TileKey,
    pub pixels: Vec<u8>,
    pub coverage: Vec<u8>,
    pub provisional: Vec<u8>,
    pub quality: Vec<u8>,
    pub conflicts: Vec<u8>,
    pub owner: Vec<u32>,
    pub score: Vec<f32>,
    pub frozen: Vec<u8>,
    /// Written since it was last stored.
    pub dirty: bool,
    /// Has a stored copy (it was loaded from one, or stored since).
    pub existed: bool,
    /// The host's timestamp of the last write that dirtied it; `None` reads as 0.
    pub touched: Option<f64>,
    id: u32,
    last_use: u64,
}

impl Tile {
    /// Stable while the tile stays resident; a reloaded tile gets a new one.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Covered pixels, the `observed` field of the tile's `tile-index/` row.
    pub fn observed(&self) -> u64 {
        count_covered(&self.coverage)
    }
}

/// What the host read back for a tile it stored earlier. `None` planes (rows written before that plane existed)
/// start empty, as a fresh tile's do.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoredTile {
    pub pixels: Vec<u8>,
    pub coverage: Option<Vec<u8>>,
    pub provisional: Option<Vec<u8>>,
    pub quality: Option<Vec<u8>>,
    pub conflicts: Option<Vec<u8>>,
    pub owner: Option<Vec<u32>>,
    pub score: Option<Vec<f32>>,
    pub frozen: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TileCacheStats {
    /// Tiles encoded for storage (reported by the host through [`TileCache::encoded`]).
    pub encoded: u64,
    /// Tiles loaded from a stored copy.
    pub decoded: u64,
    pub evictions: u64,
    pub peak_resident: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileError {
    /// The tile size is not a positive multiple of [`QUALITY_BLOCK`].
    BadSize,
    /// A stored tile's pixels do not hold `size × size` RGBA pixels.
    BadPixels,
    /// The key is already resident.
    Resident,
}

/// Set bits in a coverage bitmap.
pub fn count_covered(coverage: &[u8]) -> u64 {
    coverage.iter().map(|b| b.count_ones() as u64).sum()
}

/// Bytes the budget counts per tile pixel: RGBA plus the side planes and bookkeeping.
const BYTES_PER_PIXEL: f64 = 4.3;

/// The in-memory tile cache.
#[derive(Debug)]
pub struct TileCache {
    size: usize,
    max_tiles: u64,
    tiles: HashMap<u32, Tile>,
    by_key: HashMap<TileKey, u32>,
    clock: u64,
    next_id: u32,
    stats: TileCacheStats,
}

impl TileCache {
    /// A cache for `size`-pixel tiles under a `memory_mb` working-memory budget, of which it reserves 30% for
    /// tiles (the rest is for native frames, decoder surfaces, features and the page).
    pub fn new(size: usize, memory_mb: f64) -> Result<Self, TileError> {
        if size < QUALITY_BLOCK || !size.is_multiple_of(QUALITY_BLOCK) {
            return Err(TileError::BadSize);
        }
        let per_tile = (size * size) as f64 * BYTES_PER_PIXEL;
        let max_tiles = ((memory_mb * 1024.0 * 1024.0 * 0.30 / per_tile).floor() as u64).max(2);
        Ok(Self {
            size,
            max_tiles,
            tiles: HashMap::new(),
            by_key: HashMap::new(),
            clock: 0,
            next_id: 0,
            stats: TileCacheStats::default(),
        })
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn max_tiles(&self) -> u64 {
        self.max_tiles
    }

    /// Overrides the limit (tests use small fixed caches).
    pub fn set_max_tiles(&mut self, max_tiles: u64) {
        self.max_tiles = max_tiles;
    }

    pub fn stats(&self) -> TileCacheStats {
        self.stats
    }

    pub fn len(&self) -> usize {
        self.tiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }

    /// Rebalances the same budget between passes: 80% of what `reserved_bytes` leaves of `memory_mb`.
    pub fn configure_budget(&mut self, memory_mb: f64, reserved_bytes: f64) {
        let available = (memory_mb * 1024.0 * 1024.0 - reserved_bytes).max(0.0);
        let per_tile = (self.size * self.size) as f64 * BYTES_PER_PIXEL;
        self.max_tiles = ((available * 0.8 / per_tile).floor() as u64).max(2);
    }

    /// Tiles a `width`×`height` area can touch at any integer pose (a partial tile on each side).
    pub fn footprint(&self, width: f64, height: f64) -> u64 {
        let size = self.size as f64;
        ((width / size).ceil() as u64 + 1) * ((height / size).ceil() as u64 + 1)
    }

    /// Raises the limit to at least what one frame paints: the footprint of each of `areas` (every region it
    /// places, each on its own canvas), plus two. An LRU cache smaller than the set one frame touches turns every
    /// frame into a full miss cycle, so the budget yields here. Returns the tiles added, 0 if none.
    pub fn ensure_footprint(&mut self, areas: &[(f64, f64)]) -> u64 {
        let needed = areas
            .iter()
            .map(|&(w, h)| self.footprint(w, h))
            .sum::<u64>()
            + 2;
        if self.max_tiles >= needed {
            return 0;
        }
        let added = needed - self.max_tiles;
        self.max_tiles = needed;
        added
    }

    /// Whether `key` is resident, without changing the eviction order.
    pub fn is_resident(&self, key: &TileKey) -> bool {
        self.by_key.contains_key(key)
    }

    /// A resident tile becomes the most recently used one; returns its id, `None` when it is not resident.
    pub fn touch(&mut self, key: &TileKey) -> Option<u32> {
        let id = *self.by_key.get(key)?;
        self.clock += 1;
        self.tiles.get_mut(&id).unwrap().last_use = self.clock;
        Some(id)
    }

    /// Makes room for one more tile: while the cache is full, the least recently used tile leaves it and is
    /// returned, so the host can store it when it is dirty. Call until `None` before [`TileCache::insert`].
    pub fn evict(&mut self) -> Option<Tile> {
        if (self.tiles.len() as u64) < self.max_tiles || self.tiles.is_empty() {
            return None;
        }
        let id = self
            .tiles
            .values()
            .min_by_key(|t| t.last_use)
            .map(|t| t.id)
            .unwrap();
        let tile = self.tiles.remove(&id).unwrap();
        self.by_key.remove(&tile.key);
        self.stats.evictions += 1;
        Some(tile)
    }

    /// Adds `key` as the most recently used tile, from its stored copy or, with `None`, empty. Returns its id.
    pub fn insert(&mut self, key: TileKey, stored: Option<StoredTile>) -> Result<u32, TileError> {
        if self.by_key.contains_key(&key) {
            return Err(TileError::Resident);
        }
        let n = self.size * self.size;
        let bits = n.div_ceil(8);
        let blocks = (self.size / QUALITY_BLOCK) * (self.size / QUALITY_BLOCK);
        let existed = stored.is_some();
        let s = stored.unwrap_or_else(|| StoredTile {
            pixels: vec![0; n * 4],
            ..StoredTile::default()
        });
        if s.pixels.len() != n * 4 {
            return Err(TileError::BadPixels);
        }
        if existed {
            self.stats.decoded += 1;
        }
        self.next_id += 1;
        self.clock += 1;
        let id = self.next_id;
        let tile = Tile {
            key: key.clone(),
            pixels: s.pixels,
            coverage: s.coverage.unwrap_or_else(|| vec![0; bits]),
            provisional: s.provisional.unwrap_or_else(|| vec![0; bits]),
            quality: s.quality.unwrap_or_else(|| vec![0; blocks]),
            conflicts: s.conflicts.unwrap_or_else(|| vec![0; blocks]),
            owner: s.owner.unwrap_or_else(|| vec![0; blocks]),
            score: s.score.unwrap_or_else(|| vec![0.0; blocks]),
            frozen: s.frozen.unwrap_or_else(|| vec![0; blocks]),
            dirty: false,
            existed,
            touched: None,
            id,
            last_use: self.clock,
        };
        self.tiles.insert(id, tile);
        self.by_key.insert(key, id);
        self.stats.peak_resident = self.stats.peak_resident.max(self.tiles.len() as u64);
        Ok(id)
    }

    pub fn get(&self, id: u32) -> Option<&Tile> {
        self.tiles.get(&id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Tile> {
        self.tiles.get_mut(&id)
    }

    pub fn id_of(&self, key: &TileKey) -> Option<u32> {
        self.by_key.get(key).copied()
    }

    /// Marks a tile written at the host's time `now`.
    pub fn mark_dirty(&mut self, id: u32, now: f64) {
        if let Some(t) = self.tiles.get_mut(&id) {
            t.dirty = true;
            t.touched = Some(now);
        }
    }

    /// Dirty resident tiles a flush must store, least recently used first. With `settled_before`, only tiles
    /// whose last write precedes it: tiles still being painted every frame wait for a later flush or eviction.
    pub fn dirty(&self, settled_before: Option<f64>) -> Vec<u32> {
        let mut out: Vec<&Tile> = self
            .tiles
            .values()
            .filter(|t| t.dirty && settled_before.is_none_or(|s| t.touched.unwrap_or(0.0) < s))
            .collect();
        out.sort_by_key(|t| t.last_use);
        out.into_iter().map(|t| t.id).collect()
    }

    /// The host encoded one tile for storage.
    pub fn encoded(&mut self) {
        self.stats.encoded += 1;
    }

    /// The host stored a resident tile: it is clean and has a stored copy.
    pub fn saved(&mut self, id: u32) {
        if let Some(t) = self.tiles.get_mut(&id) {
            t.dirty = false;
            t.existed = true;
        }
    }

    /// Drops every resident tile (the host flushes first).
    pub fn clear(&mut self) {
        self.tiles.clear();
        self.by_key.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(x: i32) -> TileKey {
        TileKey::new("c", 0, x, 0)
    }

    #[test]
    fn rejects_a_size_that_is_not_a_block_multiple() {
        assert_eq!(TileCache::new(0, 128.0).unwrap_err(), TileError::BadSize);
        assert_eq!(TileCache::new(24, 128.0).unwrap_err(), TileError::BadSize);
        assert!(TileCache::new(16, 128.0).is_ok());
    }

    #[test]
    fn budget_never_drops_below_two_tiles() {
        let mut cache = TileCache::new(512, 0.0).unwrap();
        assert_eq!(cache.max_tiles(), 2);
        cache.configure_budget(1.0, 1e12);
        assert_eq!(cache.max_tiles(), 2);
    }

    #[test]
    fn budget_matches_the_page_formula() {
        // floor(128 MiB × 0.30 / (512² × 4.3)) and floor((256 MiB − 100 MiB) × 0.8 / (512² × 4.3)).
        let mut cache = TileCache::new(512, 128.0).unwrap();
        assert_eq!(cache.max_tiles(), 35);
        cache.configure_budget(256.0, 100.0 * 1024.0 * 1024.0);
        assert_eq!(cache.max_tiles(), 116);
    }

    #[test]
    fn footprint_floor_only_raises_the_limit() {
        let mut cache = TileCache::new(512, 128.0).unwrap();
        cache.set_max_tiles(10);
        // (ceil(1000/512)+1)×(ceil(600/512)+1) = 3×3, plus 2×2 for the second area, plus 2.
        assert_eq!(
            cache.ensure_footprint(&[(1000.0, 600.0), (100.0, 100.0)]),
            5
        );
        assert_eq!(cache.max_tiles(), 15);
        assert_eq!(cache.ensure_footprint(&[(100.0, 100.0)]), 0);
        assert_eq!(cache.max_tiles(), 15);
    }

    #[test]
    fn a_stored_tile_with_the_wrong_pixel_count_is_refused() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        let stored = StoredTile {
            pixels: vec![0; 10],
            ..StoredTile::default()
        };
        assert_eq!(
            cache.insert(key(0), Some(stored)),
            Err(TileError::BadPixels)
        );
        assert!(cache.is_empty());
        assert_eq!(cache.stats().decoded, 0);
    }

    #[test]
    fn inserting_a_resident_key_is_refused() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        cache.insert(key(0), None).unwrap();
        assert_eq!(cache.insert(key(0), None), Err(TileError::Resident));
    }

    #[test]
    fn eviction_takes_the_least_recently_used_tile_and_only_when_full() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        cache.set_max_tiles(2);
        assert!(cache.evict().is_none());
        cache.insert(key(0), None).unwrap();
        cache.insert(key(1), None).unwrap();
        // Touching 0 makes 1 the oldest.
        cache.touch(&key(0)).unwrap();
        let out = cache.evict().unwrap();
        assert_eq!(out.key, key(1));
        assert!(cache.evict().is_none());
        assert_eq!(cache.stats().evictions, 1);
        assert!(!cache.is_resident(&key(1)));
    }

    #[test]
    fn eviction_with_an_empty_cache_and_a_zero_limit_stops() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        cache.set_max_tiles(0);
        assert!(cache.evict().is_none());
    }

    #[test]
    fn missing_planes_start_empty_and_a_stored_tile_counts_as_decoded() {
        let mut cache = TileCache::new(32, 128.0).unwrap();
        let id = cache
            .insert(
                key(0),
                Some(StoredTile {
                    pixels: vec![7; 32 * 32 * 4],
                    owner: Some(vec![]),
                    ..StoredTile::default()
                }),
            )
            .unwrap();
        let t = cache.get(id).unwrap();
        assert!(t.existed && !t.dirty);
        assert_eq!(t.coverage.len(), 128);
        assert_eq!(t.quality.len(), 4);
        // A stored empty plane is kept as stored (pyramid rows carry empty owner/score).
        assert!(t.owner.is_empty());
        assert_eq!(cache.stats().decoded, 1);
        assert_eq!(cache.stats().peak_resident, 1);
    }

    #[test]
    fn settled_flush_skips_tiles_written_since_the_previous_flush() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        let a = cache.insert(key(0), None).unwrap();
        let b = cache.insert(key(1), None).unwrap();
        let c = cache.insert(key(2), None).unwrap();
        cache.mark_dirty(a, 10.0);
        cache.mark_dirty(b, 30.0);
        cache.mark_dirty(c, 20.0);
        cache.touch(&key(0));
        assert_eq!(cache.dirty(Some(25.0)), vec![c, a]);
        // Equal to the previous flush is not settled.
        assert_eq!(cache.dirty(Some(20.0)), vec![a]);
        assert_eq!(cache.dirty(None), vec![b, c, a]);
        cache.saved(a);
        assert_eq!(cache.dirty(None), vec![b, c]);
        assert!(cache.get(a).unwrap().existed);
    }

    #[test]
    fn untouched_dirty_tile_reads_as_written_at_zero() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        let a = cache.insert(key(0), None).unwrap();
        cache.get_mut(a).unwrap().dirty = true;
        assert_eq!(cache.dirty(Some(0.0)), Vec::<u32>::new());
        assert_eq!(cache.dirty(Some(1.0)), vec![a]);
    }

    #[test]
    fn a_reloaded_tile_gets_a_new_id() {
        let mut cache = TileCache::new(16, 128.0).unwrap();
        cache.set_max_tiles(1);
        let a = cache.insert(key(0), None).unwrap();
        let out = cache.evict().unwrap();
        let b = cache.insert(key(0), None).unwrap();
        assert_ne!(a, b);
        assert_eq!(out.id(), a);
        assert!(cache.get(a).is_none());
    }
}
