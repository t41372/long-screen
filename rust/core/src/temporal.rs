//! Temporal-conflict compositing: pure algorithms behind `Compositor` (src/core/compositor.ts) that do not
//! themselves touch KV storage. `components`, the pixel-write half of `overwritePatch` (`overwrite_tile`), the
//! in-memory temporal index (`TemporalIndex`) and `resolveTemporal`'s decision (`TemporalIndex::decide` +
//! `mask_complete` + `TemporalIndex::commit`) all live here (see docs/ARCHITECTURE.md §十 "合成与瞬态像素" for
//! the invariants they keep — `complete` means "rewrote every previously covered pixel of the block", maskComplete
//! is all-or-nothing over the whole connected component, frozen blocks still heal provisional pixels).

use crate::geometry::{js_round, Rect};
use std::collections::{HashMap, HashSet};

pub const QUALITY_BLOCK: usize = 16;

#[inline]
fn bit(bits: &[u8], p: usize) -> bool {
    bits[p >> 3] & (1 << (p & 7)) != 0
}
#[inline]
fn set_bit(bits: &mut [u8], p: usize) {
    bits[p >> 3] |= 1 << (p & 7);
}
#[inline]
fn clear_bit(bits: &mut [u8], p: usize) {
    bits[p >> 3] &= !(1 << (p & 7));
}

/// Mutable view of the tile buffers `overwrite_tile` touches. `frozen` is written here (unlike
/// `compositor::TileBuffers`, where `composite_tile` only ever reads it) because `overwritePatch` sets it under
/// the 'stable' policy.
pub struct OverwriteTile<'a> {
    pub size: usize,
    pub pixels: &'a mut [u8],
    pub coverage: &'a mut [u8],
    pub provisional: &'a mut [u8],
    pub quality: &'a mut [u8],
    pub conflicts: &'a mut [u8],
    pub owner: &'a mut [u32],
    pub frozen: &'a mut [u8],
}

#[derive(Default, Debug, PartialEq)]
pub struct OverwriteStats {
    pub added: u32,
    /// Every pixel written inside `blocks`, not only pixels whose value actually differed — mirrors
    /// `PatchResult.conflictPixels` in src/core/compositor.ts.
    pub conflict_pixels: u32,
    pub provisional_delta: i32,
    pub changed: bool,
}

/// Mirrors `Compositor.overwritePatch`'s per-tile inner loop (src/core/compositor.ts): unconditionally copies
/// every pixel of `blocks` (absolute block coordinates already restricted to this tile) from `rgba` into the
/// tile, marking coverage, healing any provisional bit, and bumping owner/quality/conflicts/frozen evidence.
/// The caller (`resolveTemporal`) has already proven the whole written set world-consistent (`maskComplete`)
/// before calling this, so every pixel here is guaranteed in-bounds — this mirrors, not re-derives, that guarantee.
#[allow(clippy::too_many_arguments)]
pub fn overwrite_tile(
    tile: &mut OverwriteTile<'_>,
    rgba: &[u8],
    img_width: i64,
    blocks: &[(i64, i64)],
    ox: i64,
    oy: i64,
    tx: i64,
    ty: i64,
    frame: u32,
    confidence: f64,
    stable: bool,
) -> OverwriteStats {
    let size = tile.size as i64;
    let b = QUALITY_BLOCK as i64;
    let per_tile = size / b;
    let mut stats = OverwriteStats::default();
    // Same rounding as `composite_tile`'s quality byte (rust/core/src/compositor.rs): Math.round, not Rust's
    // round-half-away-from-zero, for the .5 case.
    let quality = js_round(confidence * 255.0) as u8;
    for &(bx, by) in blocks {
        for y in by * b..by * b + b {
            for x in bx * b..bx * b + b {
                let src = (((y - oy) * img_width + (x - ox)) * 4) as usize;
                let dst = (((y - ty * size) * size + (x - tx * size)) * 4) as usize;
                tile.pixels[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
                let px = dst / 4;
                if !bit(tile.coverage, px) {
                    set_bit(tile.coverage, px);
                    stats.added += 1;
                }
                if bit(tile.provisional, px) {
                    clear_bit(tile.provisional, px);
                    stats.provisional_delta -= 1;
                }
                stats.changed = true;
                stats.conflict_pixels += 1;
            }
        }
        let local_bx = bx - tx * per_tile;
        let local_by = by - ty * per_tile;
        let q = (local_by * per_tile + local_bx) as usize;
        tile.owner[q] = frame + 1;
        tile.quality[q] = quality;
        tile.conflicts[q] = 1;
        if stable {
            tile.frozen[q] = 1;
        }
    }
    stats
}

/// One 8-connected component of conflicting `size`-px blocks: its bounding rect in native pixels, and every
/// block absolute coordinate that belongs to it (never just the bounding box — a concave, e.g. L-shaped,
/// conflict must not drag a pixel-identical block in its bounding box into the patch).
pub struct Component {
    pub x0: i32,
    pub y0: i32,
    pub width: i32,
    pub height: i32,
    pub blocks: Vec<(i32, i32)>,
}

/// Mirrors `Compositor.components` (src/core/compositor.ts): 8-connected components of `cells`, absolute block
/// coordinates. `cells` must already be in the caller's chosen seed order (TS sorts by tile-then-local-block
/// order before calling); a `HashSet` has no ordering guarantee, so a component's seed is the first `cells`
/// entry not yet claimed by an earlier component, walked in that same order — matching
/// `cells.values().next().value` on a `Set` built from the same sorted array. Within a component, block order
/// does not affect the result (the caller only ever treats it as a set).
pub fn components(cells: &[(i32, i32)], size: i32) -> Vec<Component> {
    let mut remaining: HashSet<(i32, i32)> = cells.iter().copied().collect();
    let mut out = Vec::new();
    for &seed in cells {
        if !remaining.remove(&seed) {
            continue;
        }
        let mut queue = vec![seed];
        let mut i = 0;
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        while i < queue.len() {
            let (x, y) = queue[i];
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let n = (x + dx, y + dy);
                    if remaining.remove(&n) {
                        queue.push(n);
                    }
                }
            }
            i += 1;
        }
        out.push(Component {
            x0: x0 * size,
            y0: y0 * size,
            width: (x1 - x0 + 1) * size,
            height: (y1 - y0 + 1) * size,
            blocks: queue,
        });
    }
    out
}

// --- Temporal index + resolveTemporal's decision (mirrors src/core/compositor.ts's `TemporalIndex`,
// `resolveTemporal`, `persistedBlocks`). ---

fn rect_union(a: Rect, b: Rect) -> Rect {
    if a.width <= 0.0 || a.height <= 0.0 {
        return b;
    }
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    Rect {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
    }
}

fn rect_intersect(a: Rect, b: Rect) -> Rect {
    let (x, y) = (a.x.max(b.x), a.y.max(b.y));
    Rect {
        x,
        y,
        width: ((a.x + a.width).min(b.x + b.width) - x).max(0.0),
        height: ((a.y + a.height).min(b.y + b.height) - y).max(0.0),
    }
}

/// Persisted block order: ascending integer keys are (by, bx) row-major (`persistedBlocks` in
/// src/core/compositor.ts, which sorts the packed `blockKey` — packing was only a JS Set/Map key-typing
/// necessity; the same (by, bx) row-major order is expressed directly here).
fn persisted_blocks(keys: &HashSet<(i32, i32)>) -> Vec<(i32, i32)> {
    let mut v: Vec<(i32, i32)> = keys.iter().copied().collect();
    v.sort_by_key(|&(bx, by)| (by, bx));
    v
}

/// One in-memory temporal record (`ResidentTemporal` in src/core/compositor.ts — `blocks` there is the
/// persisted, derived-on-write form of `keys` here).
#[derive(Clone, Debug, PartialEq)]
pub struct TemporalRecord {
    pub id: String,
    pub rect: Rect,
    pub keys: HashSet<(i32, i32)>,
    pub chosen_frame: u32,
    pub chosen_time: f64,
    pub complete: bool,
    pub revisions: u32,
}

/// An insertion-ordered set of record ids: mirrors a JS `Set<string>` (`index.dirty` / `index.deleted`).
/// `insert` of an id already present is a no-op (never moves it, matching `Set.add`); `remove` deletes it
/// wherever it sits without disturbing the order of what remains (matching `Set.delete`); a genuinely new id is
/// appended at the end. Deliberately NOT an indexmap `IndexSet` with `swap_remove` (which reorders on removal) —
/// see the row-order tripwire in tests/unit/compositor.test.ts.
#[derive(Default, Clone)]
struct OrderedIds {
    order: Vec<String>,
}
impl OrderedIds {
    fn insert(&mut self, id: &str) {
        if !self.order.iter().any(|x| x == id) {
            self.order.push(id.to_string());
        }
    }
    fn remove(&mut self, id: &str) {
        if let Some(pos) = self.order.iter().position(|x| x == id) {
            self.order.remove(pos);
        }
    }
    fn take(&mut self) -> Vec<String> {
        std::mem::take(&mut self.order)
    }
}

/// Mirrors a JS `Map<string, TemporalRecord>` (`index.records`): `set` on an existing key overwrites the value
/// in place without moving it; `set` on a new key appends it; `delete` removes it without reordering the rest;
/// `values_in_order` walks insertion order, exactly `for (const t of index.records.values())`.
#[derive(Default)]
struct RecordMap {
    order: Vec<String>,
    map: HashMap<String, TemporalRecord>,
}
impl RecordMap {
    fn get(&self, id: &str) -> Option<&TemporalRecord> {
        self.map.get(id)
    }
    fn set(&mut self, record: TemporalRecord) {
        if !self.map.contains_key(&record.id) {
            self.order.push(record.id.clone());
        }
        self.map.insert(record.id.clone(), record);
    }
    fn delete(&mut self, id: &str) {
        if self.map.remove(id).is_some() {
            if let Some(pos) = self.order.iter().position(|x| x == id) {
                self.order.remove(pos);
            }
        }
    }
    fn values_in_order(&self) -> impl Iterator<Item = &TemporalRecord> {
        self.order.iter().map(move |id| &self.map[id])
    }
}

/// State stashed between `TemporalIndex::decide` and `TemporalIndex::commit` for the one component currently
/// being resolved (never more than one outstanding at a time — `resolveTemporal` is synchronous end to end
/// apart from the pixel write, which happens between the two Rust calls, never overlapping them).
struct PendingResolve {
    record: TemporalRecord,
    old_existed: bool,
    expanded: bool,
    choose: bool,
    olds_to_delete: Vec<String>,
    rect: Rect,
    write_blocks: Vec<(i32, i32)>,
    frame: u32,
    time: f64,
}

#[derive(Default)]
pub struct TemporalIndex {
    records: RecordMap,
    dirty: OrderedIds,
    deleted: OrderedIds,
    pending: Option<PendingResolve>,
}

pub struct CommitOut {
    pub chosen: bool,
    pub emit_incomplete: bool,
    pub rect: Rect,
}

impl TemporalIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seeds one persisted row (`temporalIndex()`'s KV load loop in src/core/compositor.ts calls this once per
    /// row, in KV scan order — ascending id).
    pub fn load(&mut self, record: TemporalRecord) {
        self.records.set(record);
    }

    /// The decision half of `resolveTemporal` up to (not including) the maskComplete walk — everything that
    /// does not need atlas/occlusion/consistency pixels. Stashes the candidate record and returns how many
    /// blocks `mask_complete` + the second call will need a buffer for (0 means this component's record cannot
    /// be chosen this frame, regardless of what the mask check would say), plus the (possibly incremented)
    /// fresh-id sequence counter.
    ///
    /// `next_seq` is NOT this index's own state: `Compositor.temporalSequence` in src/core/compositor.ts is a
    /// single counter shared across every canvas the Compositor ever touches (not reset per canvas), so the
    /// caller threads it through every `decide()` call on every canvas's handle and keeps the returned value —
    /// never derived from loaded ids, which is why a fresh id can collide with a still-loaded row (see the
    /// id-collision tripwire tests in tests/unit/compositor.test.ts).
    #[allow(clippy::too_many_arguments)]
    pub fn decide(
        &mut self,
        comp_bounds: Rect,
        comp_blocks: &[(i32, i32)],
        frame: u32,
        time: f64,
        visible: Rect,
        latest_policy: bool,
        mut next_seq: u64,
    ) -> (usize, u64) {
        // `olds`: every existing record whose ±16px expanded rect overlaps this component's bounds, in
        // `index.records` iteration (insertion) order — never just `olds[0]`, several nearby records can merge.
        let mut olds: Vec<String> = Vec::new();
        for rec in self.records.values_in_order() {
            let expanded_rect = Rect {
                x: rec.rect.x - 16.0,
                y: rec.rect.y - 16.0,
                width: rec.rect.width + 32.0,
                height: rec.rect.height + 32.0,
            };
            let ix = rect_intersect(expanded_rect, comp_bounds);
            if ix.width > 0.0 && ix.height > 0.0 {
                olds.push(rec.id.clone());
            }
        }
        let old_id = olds.first().cloned();
        // Union is built into the LARGEST overlapping record's own key set to avoid re-hashing tens of
        // thousands of keys per component — a JS `Set` reuse in the original; Rust ownership makes true
        // in-place aliasing across `records.delete` below awkward, so this clones it once instead (harmless:
        // nothing else observes that record's old key set again after this call).
        let mut rect = comp_bounds;
        let mut previous_size: usize = 0;
        let mut largest_id: Option<String> = None;
        let mut largest_size: usize = 0;
        for id in &olds {
            let rec = self.records.get(id).unwrap();
            rect = rect_union(rect, rec.rect);
            previous_size += rec.keys.len();
            if largest_id.is_none() || rec.keys.len() > largest_size {
                largest_size = rec.keys.len();
                largest_id = Some(id.clone());
            }
        }
        let mut mask: HashSet<(i32, i32)> = largest_id
            .as_ref()
            .map(|id| self.records.get(id).unwrap().keys.clone())
            .unwrap_or_default();
        for id in &olds {
            if Some(id) != largest_id.as_ref() {
                for k in &self.records.get(id).unwrap().keys {
                    mask.insert(*k);
                }
            }
        }
        for k in comp_blocks {
            mask.insert(*k);
        }
        let old_rec = old_id.as_ref().and_then(|id| self.records.get(id)).cloned();
        let geometry_changed = match &old_rec {
            None => true,
            Some(o) => {
                rect.x != o.rect.x
                    || rect.y != o.rect.y
                    || rect.width != o.rect.width
                    || rect.height != o.rect.height
            }
        };
        // The union contains every previous block by construction, so membership differs exactly when the
        // size grew — comparing against the plain sum (`previous_size`), computed BEFORE the union, not the
        // union's own size.
        let membership_changed = match &old_rec {
            None => true,
            Some(_) => mask.len() != previous_size,
        };
        let expanded = geometry_changed || membership_changed;
        let mut record = match &old_rec {
            Some(o) => TemporalRecord {
                id: o.id.clone(),
                rect,
                keys: mask.clone(),
                chosen_frame: o.chosen_frame,
                chosen_time: o.chosen_time,
                complete: o.complete,
                revisions: o.revisions,
            },
            None => {
                let id = format!("{:010}", next_seq);
                next_seq += 1;
                TemporalRecord {
                    id,
                    rect,
                    keys: mask.clone(),
                    chosen_frame: frame,
                    chosen_time: time,
                    complete: false,
                    revisions: 0,
                }
            }
        };
        if expanded {
            record.complete = false;
        }
        let iv = rect_intersect(rect, visible);
        let complete_visible = iv.width == rect.width && iv.height == rect.height;
        let choose = complete_visible
            && (old_rec.is_none()
                || !old_rec.as_ref().unwrap().complete
                || expanded
                || latest_policy);
        let write_blocks = if choose {
            persisted_blocks(&mask)
        } else {
            Vec::new()
        };
        let write_block_count = write_blocks.len();
        let olds_to_delete: Vec<String> = olds.into_iter().filter(|id| *id != record.id).collect();
        self.pending = Some(PendingResolve {
            record,
            old_existed: old_rec.is_some(),
            expanded,
            choose,
            olds_to_delete,
            rect,
            write_blocks,
            frame,
            time,
        });
        (write_block_count, next_seq)
    }

    /// The write-block set `decide` computed for the currently pending component (empty if none is pending, or
    /// if it decided not to choose this component this frame) — read by the caller to run `mask_complete`
    /// before calling `commit`.
    pub fn pending_write_blocks(&self) -> &[(i32, i32)] {
        self.pending
            .as_ref()
            .map(|p| p.write_blocks.as_slice())
            .unwrap_or(&[])
    }

    /// Finalises the component `decide` staged: mirrors `resolveTemporal`'s tail (record commit into
    /// `records`/`dirty`/`deleted`, and the `INCOMPLETE_TEMPORAL_PATCH` condition). `mask_complete_ok` is the
    /// result of running `mask_complete` over `pending_write_blocks()` — irrelevant when `decide` already chose
    /// not to attempt this component (`chosen` is then `false` regardless of this argument).
    pub fn commit(&mut self, mask_complete_ok: bool) -> Option<CommitOut> {
        let mut pending = self.pending.take()?;
        let chosen = pending.choose && mask_complete_ok;
        if chosen {
            pending.record.chosen_frame = pending.frame;
            pending.record.chosen_time = pending.time;
            pending.record.complete = true;
            pending.record.revisions += 1;
        }
        let emit_incomplete =
            !pending.record.complete && (!pending.old_existed || pending.expanded);
        let rect = pending.rect;
        let record_id = pending.record.id.clone();
        self.records.set(pending.record);
        self.dirty.insert(&record_id);
        self.deleted.remove(&record_id);
        for id in &pending.olds_to_delete {
            self.records.delete(id);
            self.dirty.remove(id);
            self.deleted.insert(id);
        }
        Some(CommitOut {
            chosen,
            emit_incomplete,
            rect,
        })
    }

    /// Sizes for the buffers `flush_take` will need: how many ids `deleted` (persisted rows to delete) and
    /// `dirty` (persisted rows to (re)write) hold, and the total block count across every dirty record's
    /// current key set (`persistedBlocks` output length, summed) — flush() writes exactly these rows, deletions
    /// first, in this order, mirrors `Compositor.flush()`.
    pub fn flush_sizes(&self) -> (usize, usize, usize) {
        let dirty_block_total: usize = self
            .dirty
            .order
            .iter()
            .map(|id| self.records.get(id).map(|r| r.keys.len()).unwrap_or(0))
            .sum();
        (
            self.deleted.order.len(),
            self.dirty.order.len(),
            dirty_block_total,
        )
    }

    /// Drains `deleted` (in order) and `dirty` (in order, with each record's current content and
    /// persisted-order block list), clearing both. The counts must match a `flush_sizes()` call made with no
    /// `decide`/`commit`/`load` in between (the caller sizes its output buffers from that call).
    pub fn flush_take(&mut self) -> (Vec<String>, Vec<DirtyRow>) {
        let deleted = self.deleted.take();
        let dirty_ids = self.dirty.take();
        let dirty = dirty_ids
            .into_iter()
            .map(|id| {
                let rec = self.records.get(&id).unwrap().clone();
                let blocks = persisted_blocks(&rec.keys);
                (rec, blocks)
            })
            .collect();
        (deleted, dirty)
    }
}

/// One dirty record ready to persist: its current content plus its block set in persisted (ascending (by, bx))
/// order.
pub type DirtyRow = (TemporalRecord, Vec<(i32, i32)>);

/// Native-screen occluder membership (mirrors `occluded` in src/core/compositor.ts): occlusions are always
/// full-width bands, so rect containment on (sx, sy) is exact.
fn occluded(occlusions: &[Rect], sx: f64, sy: f64) -> bool {
    occlusions
        .iter()
        .any(|o| sx >= o.x && sx < o.x + o.width && sy >= o.y && sy < o.y + o.height)
}

/// The pixel-level completeness walk from `resolveTemporal` (src/core/compositor.ts): every pixel of every
/// `write_blocks` block must fall inside the region (`labels[y*atlas_width+x] == code`, treating out-of-bounds
/// as not contained), be unoccluded, and — when a consistency mask is given — be flagged consistent. All-or-
/// nothing: the first failing pixel stops the walk (mirrors the original's early-exit `maskComplete` flag; no
/// side effects happen in the loop besides that flag, so early-exit and scan-to-completion agree).
#[allow(clippy::too_many_arguments)]
pub fn mask_complete(
    write_blocks: &[(i32, i32)],
    labels: &[u8],
    atlas_width: i64,
    atlas_height: i64,
    code: u8,
    occlusions: &[Rect],
    consistent: Option<&[u8]>,
    ox: i64,
    oy: i64,
) -> bool {
    // `consistent` (when given) is always image-sized, and `image.width`/`image.height` are asserted equal to
    // the atlas's own dimensions at every call site (`Compositor.add`, src/core/compositor.ts), so `atlas_width`
    // is also `consistent`'s row stride — no separate `image_width` needed. `contains` below already proves
    // `sx < atlas_width && sy < atlas_height` before any `consistent` index is taken.
    let b = QUALITY_BLOCK as i64;
    for &(bx, by) in write_blocks {
        let (bx, by) = (bx as i64, by as i64);
        for y in by * b..by * b + b {
            let sy = y - oy;
            for x in bx * b..bx * b + b {
                let sx = x - ox;
                let contains = sx >= 0
                    && sy >= 0
                    && sx < atlas_width
                    && sy < atlas_height
                    && labels[(sy * atlas_width + sx) as usize] == code;
                if !contains || occluded(occlusions, sx as f64, sy as f64) {
                    return false;
                }
                if let Some(c) = consistent {
                    if c[(sy * atlas_width + sx) as usize] == 0 {
                        return false;
                    }
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_block() {
        let comps = components(&[(3, 4)], 16);
        assert_eq!(comps.len(), 1);
        assert_eq!(
            (comps[0].x0, comps[0].y0, comps[0].width, comps[0].height),
            (48, 64, 16, 16)
        );
        assert_eq!(comps[0].blocks, vec![(3, 4)]);
    }

    #[test]
    fn l_shape_stays_concave() {
        // An L: (0,0), (1,0), (0,1) — 8-connected, one component, but its bounding box (2x2) must not
        // silently gain the empty (1,1) cell in the output block list.
        let comps = components(&[(0, 0), (1, 0), (0, 1)], 16);
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].blocks.len(), 3);
        assert_eq!((comps[0].width, comps[0].height), (32, 32));
    }

    #[test]
    fn diagonal_touch_connects() {
        // 8-connected: a purely diagonal touch still joins one component.
        let comps = components(&[(0, 0), (1, 1)], 16);
        assert_eq!(comps.len(), 1);
    }

    #[test]
    fn disjoint_cells_split_and_keep_seed_order() {
        let comps = components(&[(0, 0), (10, 10), (0, 1)], 16);
        assert_eq!(comps.len(), 2);
        // Seed order: (0,0) is claimed first and absorbs (0,1); (10,10) starts the second component.
        assert_eq!(comps[0].blocks.len(), 2);
        assert_eq!(comps[1].blocks, vec![(10, 10)]);
    }

    #[test]
    fn overwrite_writes_pixels_and_evidence() {
        let size = 32usize;
        let blocks = (size / QUALITY_BLOCK).pow(2);
        let mut pixels = vec![0u8; size * size * 4];
        let mut coverage = vec![0u8; size * size / 8];
        let mut provisional = vec![0xffu8; size * size / 8]; // every pixel provisional beforehand
        let (mut quality, mut conflicts, mut owner, mut frozen) = (
            vec![0u8; blocks],
            vec![0u8; blocks],
            vec![0u32; blocks],
            vec![0u8; blocks],
        );
        let mut tile = OverwriteTile {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            conflicts: &mut conflicts,
            owner: &mut owner,
            frozen: &mut frozen,
        };
        let img_width = 32i64;
        let rgba: Vec<u8> = (0..img_width * img_width)
            .flat_map(|i| [i as u8, 1, 2, 255])
            .collect();
        let stats = overwrite_tile(
            &mut tile,
            &rgba,
            img_width,
            &[(0, 0)],
            0,
            0,
            0,
            0,
            3,
            0.7,
            true,
        );
        assert_eq!(stats.added, 256);
        assert_eq!(stats.conflict_pixels, 256);
        assert_eq!(stats.provisional_delta, -256);
        assert!(stats.changed);
        assert_eq!(tile.owner[0], 4);
        assert_eq!(tile.quality[0], 179); // js_round(0.7 * 255 = 178.5) rounds half up
        assert_eq!(tile.conflicts[0], 1);
        assert_eq!(tile.frozen[0], 1);
        assert_eq!(tile.pixels[0], 0);
        assert_eq!(tile.pixels[4], 1);
    }

    #[test]
    fn overwrite_respects_non_stable_policy() {
        let size = 16usize;
        let mut pixels = vec![0u8; size * size * 4];
        let mut coverage = vec![0u8; size * size / 8];
        let mut provisional = vec![0u8; size * size / 8];
        let (mut quality, mut conflicts, mut owner, mut frozen) =
            (vec![0u8; 1], vec![0u8; 1], vec![0u32; 1], vec![0u8; 1]);
        let mut tile = OverwriteTile {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            conflicts: &mut conflicts,
            owner: &mut owner,
            frozen: &mut frozen,
        };
        let rgba = vec![9u8; 16 * 16 * 4];
        overwrite_tile(&mut tile, &rgba, 16, &[(0, 0)], 0, 0, 0, 0, 0, 0.0, false);
        assert_eq!(tile.frozen[0], 0);
        assert_eq!(tile.quality[0], 0); // round(0.0 * 255)
    }

    // --- TemporalIndex: mirrors the row-order/id-collision tripwires in tests/unit/compositor.test.ts against
    // the pure Rust index directly, without going through the FFI/Compositor layer. ---

    fn block_rect(bx: i32, by: i32, w: i32, h: i32) -> Rect {
        Rect {
            x: (bx * 16) as f64,
            y: (by * 16) as f64,
            width: (w * 16) as f64,
            height: (h * 16) as f64,
        }
    }
    fn keys(blocks: &[(i32, i32)]) -> HashSet<(i32, i32)> {
        blocks.iter().copied().collect()
    }
    /// Runs `decide` → (a fully permissive `mask_complete`, since these tests only exercise index bookkeeping)
    /// → `commit`, exactly the two-call sequence `Compositor.resolveTemporal` performs per component. `seq`
    /// mirrors `Compositor.temporalSequence` (src/core/compositor.ts): a counter threaded through every
    /// `decide()` call, never owned by `TemporalIndex` itself (it is shared across every canvas's handle).
    fn resolve(
        index: &mut TemporalIndex,
        comp_blocks: &[(i32, i32)],
        frame: u32,
        visible: Rect,
        seq: &mut u64,
    ) -> CommitOut {
        let bounds = comp_blocks
            .iter()
            .fold(None::<Rect>, |acc, &(bx, by)| {
                let r = block_rect(bx, by, 1, 1);
                Some(acc.map_or(r, |a| rect_union(a, r)))
            })
            .unwrap();
        let (_, next_seq) = index.decide(
            bounds,
            comp_blocks,
            frame,
            frame as f64,
            visible,
            false,
            *seq,
        );
        *seq = next_seq;
        index.commit(true).unwrap()
    }

    #[test]
    fn flush_order_survives_a_delete_then_reinsert_shaped_sequence() {
        // Mirrors "compositor: flush() persists temporal rows in exact index insertion/deletion order" in
        // tests/unit/compositor.test.ts: records A,B,C,D created in order at blocks 0,4,8,12 (visible span 0..13).
        let visible = block_rect(0, 0, 13, 1);
        let mut index = TemporalIndex::new();
        let mut seq = 0u64;
        for &b in &[0, 4, 8, 12] {
            resolve(&mut index, &[(b, 0)], b as u32, visible, &mut seq);
        }
        let ids = |n: u64| format!("{:010}", n);
        assert_eq!(index.records.order, vec![ids(0), ids(1), ids(2), ids(3)]);
        index.flush_take(); // matches the TS test's `await compositor.flush()` here, clearing dirty/deleted
                            // Frame 5: a bridge (blocks 4..8) merges B and C (old = B, since B is iterated before C); a standalone
                            // touch at block 12 (D) does not expand/re-choose it (already complete under 'stable') but still dirties it.
        let out_bridge = resolve(
            &mut index,
            &[(4, 0), (5, 0), (6, 0), (7, 0), (8, 0)],
            5,
            visible,
            &mut seq,
        );
        assert!(out_bridge.chosen);
        index.decide(
            block_rect(12, 0, 1, 1),
            &[(12, 0)],
            5,
            5.0,
            visible,
            false,
            seq,
        );
        assert_eq!(
            index.pending_write_blocks().len(),
            0,
            "D neither expands nor re-chooses — decide() must not offer a mask to check"
        );
        let out_d = index.commit(false).unwrap();
        assert!(!out_d.chosen);
        assert_eq!(index.dirty.order, vec![ids(1), ids(3)]);
        assert_eq!(index.deleted.order, vec![ids(2)]);
        // Frame 6: a mega-conflict spanning blocks 0..12 absorbs A, merged-B, and D into one record kept at A's id.
        let all_blocks: Vec<(i32, i32)> = (0..=12).map(|bx| (bx, 0)).collect();
        let out_mega = resolve(&mut index, &all_blocks, 6, visible, &mut seq);
        assert!(out_mega.chosen);
        assert_eq!(index.dirty.order, vec![ids(0)], "B and D — both still dirty and never flushed — are deleted before ever reaching a flush");
        assert_eq!(index.deleted.order, vec![ids(2), ids(1), ids(3)]);
        let (deleted, dirty) = index.flush_take();
        assert_eq!(deleted, vec![ids(2), ids(1), ids(3)]);
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].0.id, ids(0));
        assert_eq!(dirty[0].1.len(), 13);
        assert_eq!(index.dirty.order.len(), 0);
        assert_eq!(index.deleted.order.len(), 0);
    }

    #[test]
    fn fresh_id_colliding_with_a_live_record_overwrites_it_in_place() {
        let visible = block_rect(0, 0, 6, 1);
        let mut index = TemporalIndex::new();
        index.load(TemporalRecord {
            id: "0000000000".into(),
            rect: block_rect(5, 0, 1, 1),
            keys: keys(&[(5, 0)]),
            chosen_frame: 0,
            chosen_time: 0.0,
            complete: true,
            revisions: 1,
        });
        let mut seq = 0u64;
        let out = resolve(&mut index, &[(0, 0)], 1, visible, &mut seq);
        assert!(out.chosen);
        assert_eq!(
            index.records.order,
            vec!["0000000000".to_string()],
            "no second row — the id collision clobbers the loaded one in place"
        );
        assert_eq!(
            index.records.get("0000000000").unwrap().rect,
            block_rect(0, 0, 1, 1)
        );
        assert_eq!(index.deleted.order.len(), 0);
    }

    #[test]
    fn fresh_id_colliding_with_a_deleted_id_is_appended_and_undeletes_it() {
        let visible = block_rect(0, 0, 12, 1);
        let mut index = TemporalIndex::new();
        index.load(TemporalRecord {
            id: "0000000000".into(),
            rect: block_rect(0, 0, 1, 1),
            keys: keys(&[(0, 0)]),
            chosen_frame: 0,
            chosen_time: 0.0,
            complete: true,
            revisions: 1,
        });
        index.load(TemporalRecord {
            id: "0000000001".into(),
            rect: block_rect(1, 0, 1, 1),
            keys: keys(&[(1, 0)]),
            chosen_frame: 0,
            chosen_time: 0.0,
            complete: true,
            revisions: 1,
        });
        let mut seq = 0u64;
        // Merge blocks 0 and 1: old = "0000000000" (olds[0] is always the first-iterated overlap), "0000000001" deleted.
        resolve(&mut index, &[(0, 0), (1, 0)], 1, visible, &mut seq);
        assert_eq!(index.deleted.order, vec!["0000000001".to_string()]);
        // Two disjoint, non-overlapping conflicts (blocks 5 and 9): fresh ids pad(0)="0000000000" (live — clobbered
        // in place) then pad(1)="0000000001" (deleted — appended at the end and un-deleted).
        resolve(&mut index, &[(5, 0)], 2, visible, &mut seq);
        resolve(&mut index, &[(9, 0)], 2, visible, &mut seq);
        assert_eq!(
            index.deleted.order.len(),
            0,
            "no delete() should ever be emitted for \"0000000001\" now"
        );
        assert_eq!(
            index.records.order,
            vec!["0000000000".to_string(), "0000000001".to_string()]
        );
        assert_eq!(
            index.records.get("0000000001").unwrap().rect,
            block_rect(9, 0, 1, 1)
        );
        let (deleted, dirty) = index.flush_take();
        assert_eq!(deleted.len(), 0);
        assert_eq!(
            dirty.iter().map(|(r, _)| r.id.clone()).collect::<Vec<_>>(),
            vec!["0000000000".to_string(), "0000000001".to_string()]
        );
    }
}
