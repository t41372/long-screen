//! ABI surface of the engine's tile cache (`long_screen_engine::tiles`, mirrored by `src/core/wasm/tiles.ts`).
//!
//! Tile planes live in engine memory; the adapter reads and writes them through the pointers `ls_tiles_planes`
//! reports, which stay valid while the tile is resident (or, after `ls_tiles_evict`, until `ls_tiles_release`).
//! A tile key crosses as the canvas id's UTF-8 bytes plus level, x and y.

use crate::memory::{slice, slice_mut, HandleTable};
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen_engine::tiles::{StoredTile, Tile, TileCache, TileKey};
use std::collections::HashMap;

/// `ls_tiles_planes` output: 8 × (u32 pointer, u32 byte length) for pixels, coverage, provisional, quality,
/// conflicts, owner, score, frozen; u32 dirty, u32 existed, f64 touched (NaN when never written).
pub const TILE_PLANES_BYTES: usize = 80;
/// `ls_tiles_insert` stored-planes descriptor: the same 8 × (u32 pointer, u32 byte length); pointer 0 = absent.
pub const TILE_STORED_BYTES: usize = 64;
/// Status for a tile id that is neither resident nor evicted-and-unreleased.
pub const STATUS_NO_TILE: i32 = -2;

pub(crate) struct Tiles {
    pub(crate) cache: TileCache,
    /// Evicted tiles the adapter has not released yet.
    outgoing: HashMap<u32, Tile>,
}

static mut TILES: HandleTable<Tiles> = HandleTable::new();

pub(crate) fn tiles(handle: u32) -> Option<&'static mut Tiles> {
    // SAFETY: only the main instance touches TILES, through these exports and `compositor.rs`; no pool helper
    // reaches this module.
    unsafe { (*std::ptr::addr_of_mut!(TILES)).get(handle) }
}

/// # Safety
/// `ptr` holds `len` readable bytes.
pub(crate) unsafe fn read_str(ptr: u32, len: u32) -> Option<String> {
    let bytes = slice(ptr, len as usize)?;
    String::from_utf8(bytes.to_vec()).ok()
}

fn key(canvas: u32, canvas_len: u32, level: u32, x: i32, y: i32) -> Option<TileKey> {
    // SAFETY: adapter-owned bytes, bounds checked.
    let canvas = unsafe { read_str(canvas, canvas_len) }?;
    Some(TileKey {
        canvas,
        level,
        x,
        y,
    })
}

#[no_mangle]
pub extern "C" fn ls_tiles_new(size: u32, memory_mb: f64) -> i32 {
    match TileCache::new(size as usize, memory_mb) {
        // SAFETY: see `tiles`.
        Ok(cache) => unsafe {
            (*std::ptr::addr_of_mut!(TILES)).insert(Tiles {
                cache,
                outgoing: HashMap::new(),
            })
        },
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_tiles_free(handle: u32) {
    // SAFETY: see `tiles`.
    unsafe { (*std::ptr::addr_of_mut!(TILES)).free(handle) }
}

#[no_mangle]
pub extern "C" fn ls_tiles_configure_budget(handle: u32, memory_mb: f64, reserved: f64) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    t.cache.configure_budget(memory_mb, reserved);
    STATUS_OK
}

/// `areas` holds `count` (f64 width, f64 height) pairs. Returns the tiles added, −1 on a bad argument.
#[no_mangle]
pub extern "C" fn ls_tiles_ensure_footprint(handle: u32, areas: u32, count: u32) -> f64 {
    let Some(t) = tiles(handle) else {
        return -1.0;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(bytes) = (unsafe { slice(areas, count as usize * 16) }) else {
        return -1.0;
    };
    let areas: Vec<(f64, f64)> = bytes
        .chunks_exact(16)
        .map(|c| {
            (
                f64::from_le_bytes(c[0..8].try_into().unwrap()),
                f64::from_le_bytes(c[8..16].try_into().unwrap()),
            )
        })
        .collect();
    t.cache.ensure_footprint(&areas) as f64
}

#[no_mangle]
pub extern "C" fn ls_tiles_max(handle: u32) -> f64 {
    tiles(handle).map_or(-1.0, |t| t.cache.max_tiles() as f64)
}

#[no_mangle]
pub extern "C" fn ls_tiles_set_max(handle: u32, max: f64) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if max.is_nan() || max < 0.0 {
        return STATUS_BAD_ARGUMENT;
    }
    t.cache.set_max_tiles(max as u64);
    STATUS_OK
}

/// `out` receives f64 encoded, decoded, evictions, peak resident (32 bytes).
#[no_mangle]
pub extern "C" fn ls_tiles_stats(handle: u32, out: u32) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 32) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let s = t.cache.stats();
    for (i, v) in [s.encoded, s.decoded, s.evictions, s.peak_resident]
        .into_iter()
        .enumerate()
    {
        dst[i * 8..i * 8 + 8].copy_from_slice(&(v as f64).to_le_bytes());
    }
    STATUS_OK
}

/// Makes a resident tile the most recently used one. Returns its id, 0 when it is not resident.
#[no_mangle]
pub extern "C" fn ls_tiles_touch(
    handle: u32,
    canvas: u32,
    canvas_len: u32,
    level: u32,
    x: i32,
    y: i32,
) -> i32 {
    let (Some(t), Some(k)) = (tiles(handle), key(canvas, canvas_len, level, x, y)) else {
        return STATUS_BAD_ARGUMENT;
    };
    t.cache.touch(&k).map_or(0, |id| id as i32)
}

/// Evicts the least recently used tile when the cache is full. Returns its id (its planes stay readable until
/// `ls_tiles_release`), 0 when there is room.
#[no_mangle]
pub extern "C" fn ls_tiles_evict(handle: u32) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    match t.cache.evict() {
        Some(tile) => {
            let id = tile.id();
            t.outgoing.insert(id, tile);
            id as i32
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn ls_tiles_release(handle: u32, id: u32) {
    if let Some(t) = tiles(handle) {
        t.outgoing.remove(&id);
    }
}

fn plane(stored: &[u8], at: usize) -> Option<Option<Vec<u8>>> {
    let (ptr, len) = (
        u32::from_le_bytes(stored[at..at + 4].try_into().unwrap()),
        u32::from_le_bytes(stored[at + 4..at + 8].try_into().unwrap()),
    );
    if ptr == 0 {
        return Some(None);
    }
    // SAFETY: adapter-owned buffer, bounds checked.
    unsafe { slice(ptr, len as usize) }.map(|b| Some(b.to_vec()))
}

fn words<T>(bytes: Option<Vec<u8>>, from: fn([u8; 4]) -> T) -> Option<Option<Vec<T>>> {
    match bytes {
        None => Some(None),
        Some(b) if b.len() % 4 == 0 => Some(Some(
            b.chunks_exact(4)
                .map(|c| from(c.try_into().unwrap()))
                .collect(),
        )),
        Some(_) => None,
    }
}

/// Adds a tile as the most recently used one: from the stored planes `stored` describes (`TILE_STORED_BYTES`;
/// the pixels are required), or empty when `stored` is 0. Returns its id.
#[no_mangle]
pub extern "C" fn ls_tiles_insert(
    handle: u32,
    canvas: u32,
    canvas_len: u32,
    level: u32,
    x: i32,
    y: i32,
    stored: u32,
) -> i32 {
    let (Some(t), Some(k)) = (tiles(handle), key(canvas, canvas_len, level, x, y)) else {
        return STATUS_BAD_ARGUMENT;
    };
    let stored = if stored == 0 {
        None
    } else {
        // SAFETY: adapter-owned descriptor, bounds checked.
        let Some(d) = (unsafe { slice(stored, TILE_STORED_BYTES) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        let planes: Option<Vec<Option<Vec<u8>>>> = (0..8).map(|i| plane(d, i * 8)).collect();
        let Some(mut planes) = planes else {
            return STATUS_BAD_ARGUMENT;
        };
        let (Some(owner), Some(score)) = (
            words(planes[5].take(), u32::from_le_bytes),
            words(planes[6].take(), f32::from_le_bytes),
        ) else {
            return STATUS_BAD_ARGUMENT;
        };
        let Some(pixels) = planes[0].take() else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(StoredTile {
            pixels,
            coverage: planes[1].take(),
            provisional: planes[2].take(),
            quality: planes[3].take(),
            conflicts: planes[4].take(),
            owner,
            score,
            frozen: planes[7].take(),
        })
    };
    match t.cache.insert(k, stored) {
        Ok(id) => id as i32,
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

/// Where a resident (or evicted, unreleased) tile's planes are; see `TILE_PLANES_BYTES`.
#[no_mangle]
pub extern "C" fn ls_tiles_planes(handle: u32, id: u32, out: u32) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(tile) = t.cache.get(id).or_else(|| t.outgoing.get(&id)) else {
        return STATUS_NO_TILE;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, TILE_PLANES_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let planes: [(*const u8, usize); 8] = [
        (tile.pixels.as_ptr(), tile.pixels.len()),
        (tile.coverage.as_ptr(), tile.coverage.len()),
        (tile.provisional.as_ptr(), tile.provisional.len()),
        (tile.quality.as_ptr(), tile.quality.len()),
        (tile.conflicts.as_ptr(), tile.conflicts.len()),
        (tile.owner.as_ptr() as *const u8, tile.owner.len() * 4),
        (tile.score.as_ptr() as *const u8, tile.score.len() * 4),
        (tile.frozen.as_ptr(), tile.frozen.len()),
    ];
    for (i, (ptr, len)) in planes.into_iter().enumerate() {
        dst[i * 8..i * 8 + 4].copy_from_slice(&(ptr as usize as u32).to_le_bytes());
        dst[i * 8 + 4..i * 8 + 8].copy_from_slice(&(len as u32).to_le_bytes());
    }
    dst[64..68].copy_from_slice(&(tile.dirty as u32).to_le_bytes());
    dst[68..72].copy_from_slice(&(tile.existed as u32).to_le_bytes());
    dst[72..80].copy_from_slice(&tile.touched.unwrap_or(f64::NAN).to_le_bytes());
    STATUS_OK
}

fn tile_mut(handle: u32, id: u32) -> Option<&'static mut Tile> {
    let t = tiles(handle)?;
    match t.cache.get_mut(id) {
        Some(tile) => Some(tile),
        None => t.outgoing.get_mut(&id),
    }
}

#[no_mangle]
pub extern "C" fn ls_tiles_set_dirty(handle: u32, id: u32, dirty: u32) -> i32 {
    let Some(tile) = tile_mut(handle, id) else {
        return STATUS_NO_TILE;
    };
    tile.dirty = dirty != 0;
    STATUS_OK
}

/// `touched` NaN clears it (never written).
#[no_mangle]
pub extern "C" fn ls_tiles_set_touched(handle: u32, id: u32, touched: f64) -> i32 {
    let Some(tile) = tile_mut(handle, id) else {
        return STATUS_NO_TILE;
    };
    tile.touched = (!touched.is_nan()).then_some(touched);
    STATUS_OK
}

/// Ids of the dirty resident tiles a flush must store, least recently used first; with `settled_before` (NaN =
/// every dirty tile) only those last written before it. Writes at most `capacity` u32 ids; returns the count.
#[no_mangle]
pub extern "C" fn ls_tiles_dirty(handle: u32, settled_before: f64, out: u32, capacity: u32) -> i32 {
    let Some(t) = tiles(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let ids = t
        .cache
        .dirty((!settled_before.is_nan()).then_some(settled_before));
    let n = ids.len().min(capacity as usize);
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, n * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (i, id) in ids.iter().take(n).enumerate() {
        dst[i * 4..i * 4 + 4].copy_from_slice(&id.to_le_bytes());
    }
    ids.len() as i32
}

/// The adapter encoded one tile for storage.
#[no_mangle]
pub extern "C" fn ls_tiles_encoded(handle: u32) {
    if let Some(t) = tiles(handle) {
        t.cache.encoded();
    }
}

/// The adapter stored a resident tile: clean, with a stored copy.
#[no_mangle]
pub extern "C" fn ls_tiles_saved(handle: u32, id: u32) {
    if let Some(t) = tiles(handle) {
        t.cache.saved(id);
    }
}

/// Covered pixels of a resident or outgoing tile; −1 when there is none.
#[no_mangle]
pub extern "C" fn ls_tiles_observed(handle: u32, id: u32) -> f64 {
    let Some(t) = tiles(handle) else {
        return -1.0;
    };
    t.cache
        .get(id)
        .or_else(|| t.outgoing.get(&id))
        .map_or(-1.0, |tile| tile.observed() as f64)
}

#[no_mangle]
pub extern "C" fn ls_tiles_clear(handle: u32) {
    if let Some(t) = tiles(handle) {
        t.cache.clear();
    }
}
