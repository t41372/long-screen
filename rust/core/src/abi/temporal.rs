//! ABI surface for temporal-conflict block components, the temporal index and resolveTemporal's decision
//! (mirrors `src/core/wasm/temporal.ts`).

use crate::abi::memory::{in_bounds, slice, slice_mut, HandleTable};
use crate::abi::wire::read_rects;
use crate::abi::{STATUS_BAD_ARGUMENT, STATUS_OK};
use crate::temporal::{
    components, mask_complete, overwrite_tile, OverwriteTile, TemporalIndex, TemporalRecord,
    QUALITY_BLOCK,
};
use std::collections::HashSet;

/// Bytes per serialised component header: i32 x0, y0, width, height (native pixels), u32 block count.
pub const TEMPORAL_COMPONENT_HEADER_BYTES: usize = 20;

/// `cells` holds `count` (i32 x, i32 y) absolute block-coordinate pairs, already in the caller's seed order.
/// `header_out` must hold `count * TEMPORAL_COMPONENT_HEADER_BYTES` bytes (an upper bound on the component
/// count — one component can never have more members than input cells) and `blocks_out` must hold
/// `count * 8` bytes (every input cell appears in exactly one output component). Returns the component count,
/// or a negative status on a bad argument.
#[no_mangle]
pub extern "C" fn ls_temporal_components(
    cells: u32,
    count: u32,
    size: i32,
    header_out: u32,
    blocks_out: u32,
) -> i32 {
    if size <= 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let n = count as usize;
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(input) = (unsafe { slice(cells, n * 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut pairs = Vec::with_capacity(n);
    for chunk in input.chunks_exact(8) {
        let x = i32::from_le_bytes(chunk[0..4].try_into().unwrap());
        let y = i32::from_le_bytes(chunk[4..8].try_into().unwrap());
        pairs.push((x, y));
    }
    let comps = components(&pairs, size);
    // SAFETY: adapter-owned buffers, bounds checked; caller sizes both for the worst case (`n` components,
    // `n` total blocks).
    let (Some(header), Some(blocks)) = (
        unsafe { slice_mut(header_out, comps.len() * TEMPORAL_COMPONENT_HEADER_BYTES) },
        unsafe { slice_mut(blocks_out, n * 8) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut boff = 0usize;
    for (i, c) in comps.iter().enumerate() {
        let h = &mut header
            [i * TEMPORAL_COMPONENT_HEADER_BYTES..(i + 1) * TEMPORAL_COMPONENT_HEADER_BYTES];
        h[0..4].copy_from_slice(&c.x0.to_le_bytes());
        h[4..8].copy_from_slice(&c.y0.to_le_bytes());
        h[8..12].copy_from_slice(&c.width.to_le_bytes());
        h[12..16].copy_from_slice(&c.height.to_le_bytes());
        h[16..20].copy_from_slice(&(c.blocks.len() as u32).to_le_bytes());
        for &(bx, by) in &c.blocks {
            blocks[boff..boff + 4].copy_from_slice(&bx.to_le_bytes());
            blocks[boff + 4..boff + 8].copy_from_slice(&by.to_le_bytes());
            boff += 8;
        }
    }
    comps.len() as i32
}

/// Bytes per tile descriptor for `ls_overwrite_tile`: u32 pixels, coverage, provisional, quality, conflicts,
/// owner, frozen pointers, u32 tile size.
pub const OVERWRITE_TILE_HEADER_BYTES: usize = 32;
/// Bytes per `ls_overwrite_tile` output: u32 added, u32 conflictPixels, i32 provisionalDelta, u32 changed.
pub const OVERWRITE_OUTPUT_BYTES: usize = 16;

/// Mirrors `Compositor.overwritePatch`'s per-tile loop (src/core/compositor.ts::overwritePatch), ported to
/// `temporal::overwrite_tile`. `blocks` holds `block_count` (i32 bx, i32 by) absolute block-coordinate pairs,
/// already restricted to this tile by the caller. `stable` is 1 under the 'stable' policy (sets `frozen`), 0
/// under 'latest'.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_overwrite_tile(
    tile: u32,
    rgba: u32,
    img_width: i32,
    img_height: i32,
    blocks: u32,
    block_count: u32,
    ox: i32,
    oy: i32,
    tx: i32,
    ty: i32,
    frame: u32,
    confidence: f64,
    stable: u32,
    out: u32,
) -> i32 {
    if img_width <= 0 || img_height <= 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned descriptor, bounds checked field by field below.
    let Some(t) = (unsafe { slice(tile, OVERWRITE_TILE_HEADER_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let t = super::wire::Reader(t);
    let size = t.u32(28) as usize;
    if size == 0 || !size.is_multiple_of(QUALITY_BLOCK) {
        return STATUS_BAD_ARGUMENT;
    }
    let n = size * size;
    let tile_blocks = (size / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
    let owner_ptr = t.u32(20);
    if owner_ptr == 0 || !owner_ptr.is_multiple_of(4) || !in_bounds(owner_ptr, tile_blocks * 4) {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: every buffer is validated against linear memory; tile buffers are distinct allocations.
    let (
        Some(pixels),
        Some(coverage),
        Some(provisional),
        Some(quality),
        Some(conflicts),
        Some(frozen),
    ) = (unsafe {
        (
            slice_mut(t.u32(0), n * 4),
            slice_mut(t.u32(4), n.div_ceil(8)),
            slice_mut(t.u32(8), n.div_ceil(8)),
            slice_mut(t.u32(12), tile_blocks),
            slice_mut(t.u32(16), tile_blocks),
            slice_mut(t.u32(24), tile_blocks),
        )
    })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: 4-byte aligned and bounds checked above, adapter-owned, distinct from the byte buffers above.
    let owner = unsafe { std::slice::from_raw_parts_mut(owner_ptr as *mut u32, tile_blocks) };
    let count = block_count as usize;
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(rgba) = (unsafe { slice(rgba, (img_width as usize) * (img_height as usize) * 4) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let block_pairs = if count == 0 {
        Vec::new()
    } else {
        // SAFETY: adapter-owned buffer, bounds checked.
        let Some(b) = (unsafe { slice(blocks, count * 8) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        b.chunks_exact(8)
            .map(|c| {
                (
                    i32::from_le_bytes(c[0..4].try_into().unwrap()) as i64,
                    i32::from_le_bytes(c[4..8].try_into().unwrap()) as i64,
                )
            })
            .collect::<Vec<_>>()
    };
    // `overwrite_tile` (rust/core/src/temporal.rs) indexes `tile.pixels`/`tile.owner` from each block unchecked
    // — by contract (abi/mod.rs's memory contract: "an invalid request returns a negative status instead of
    // trapping") every pointer this ABI hands a kernel must already be proven in-bounds, so a bad `blocks`
    // entry has to be rejected here, not in the kernel. Unreachable in practice: the caller only ever passes
    // blocks `maskComplete` already proved consistent, but a future caller (or a corrupted call) must get a
    // status, not a trap. Every block's tile-local coordinates must land inside this tile (matching the owner/
    // quality/conflicts/frozen arrays, sized `tile_blocks`), and its pixel footprint must land inside `rgba`
    // (the source frame) once translated by `ox`/`oy`.
    let per_tile = (size / QUALITY_BLOCK) as i64;
    let b = QUALITY_BLOCK as i64;
    for &(bx, by) in &block_pairs {
        let local_bx = bx - tx as i64 * per_tile;
        let local_by = by - ty as i64 * per_tile;
        if local_bx < 0 || local_bx >= per_tile || local_by < 0 || local_by >= per_tile {
            return STATUS_BAD_ARGUMENT;
        }
        let x0 = bx * b - ox as i64;
        let y0 = by * b - oy as i64;
        if x0 < 0 || y0 < 0 || x0 + b > img_width as i64 || y0 + b > img_height as i64 {
            return STATUS_BAD_ARGUMENT;
        }
    }
    let mut buffers = OverwriteTile {
        size,
        pixels,
        coverage,
        provisional,
        quality,
        conflicts,
        owner,
        frozen,
    };
    let stats = overwrite_tile(
        &mut buffers,
        rgba,
        img_width as i64,
        &block_pairs,
        ox as i64,
        oy as i64,
        tx as i64,
        ty as i64,
        frame,
        confidence,
        stable != 0,
    );
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, OVERWRITE_OUTPUT_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&stats.added.to_le_bytes());
    dst[4..8].copy_from_slice(&stats.conflict_pixels.to_le_bytes());
    dst[8..12].copy_from_slice(&stats.provisional_delta.to_le_bytes());
    dst[12..16].copy_from_slice(&(stats.changed as u32).to_le_bytes());
    0
}

// --- Temporal index + resolveTemporal's decision (mirrors src/core/compositor.ts's `TemporalIndex`/
// `resolveTemporal` via `src/core/wasm/temporal.ts`). One handle per canvas's in-memory index, created lazily
// and freed by `Compositor.dispose()` — drained with `ls_temporal_flush_sizes`/`ls_temporal_flush_take` first,
// the same pair `flush()` itself uses, since `dispose()` runs before the pipeline's final `flush()`
// (src/pipeline/render.ts), so the handle must not still be needed by then. ---

static mut TEMPORAL: HandleTable<TemporalIndex> = HandleTable::new();

fn temporal_handles() -> &'static mut HandleTable<TemporalIndex> {
    // SAFETY: only the main instance touches TEMPORAL, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(TEMPORAL) }
}

#[no_mangle]
pub extern "C" fn ls_temporal_index_new() -> i32 {
    temporal_handles().insert(TemporalIndex::new())
}

#[no_mangle]
pub extern "C" fn ls_temporal_index_free(handle: u32) {
    temporal_handles().free(handle);
}

/// Bytes per serialised temporal record header: 10-byte ASCII id (space-padded on write, trimmed on read isn't
/// needed — ids are always exactly 10 digits, `format!("{:010}", n)`), 32-byte rect, u32 chosenFrame, f64
/// chosenTime, u32 complete, u32 revisions, u32 blockCount. Used both directions: `ls_temporal_index_load`
/// reads one (the KV load loop in `temporalIndex()`, src/core/compositor.ts, calls it once per row in KV scan
/// order) and `ls_temporal_flush_take` writes one per dirty row.
pub const TEMPORAL_RECORD_HEADER_BYTES: usize = 66;

fn write_record_header(out: &mut [u8], record: &TemporalRecord, block_count: u32) {
    let id = record.id.as_bytes();
    out[0..10.min(id.len())].copy_from_slice(&id[..10.min(id.len())]);
    out[10..18].copy_from_slice(&record.rect.x.to_le_bytes());
    out[18..26].copy_from_slice(&record.rect.y.to_le_bytes());
    out[26..34].copy_from_slice(&record.rect.width.to_le_bytes());
    out[34..42].copy_from_slice(&record.rect.height.to_le_bytes());
    out[42..46].copy_from_slice(&record.chosen_frame.to_le_bytes());
    out[46..54].copy_from_slice(&record.chosen_time.to_le_bytes());
    out[54..58].copy_from_slice(&(record.complete as u32).to_le_bytes());
    out[58..62].copy_from_slice(&record.revisions.to_le_bytes());
    out[62..66].copy_from_slice(&block_count.to_le_bytes());
}

/// # Safety
/// `ptr` points at `count * 8` readable bytes: `count` (i32 bx, i32 by) pairs.
unsafe fn read_blocks(ptr: u32, count: u32) -> Option<Vec<(i32, i32)>> {
    let bytes = slice(ptr, count as usize * 8)?;
    Some(
        bytes
            .chunks_exact(8)
            .map(|c| {
                (
                    i32::from_le_bytes(c[0..4].try_into().unwrap()),
                    i32::from_le_bytes(c[4..8].try_into().unwrap()),
                )
            })
            .collect(),
    )
}
fn write_blocks(out: &mut [u8], blocks: &[(i32, i32)]) {
    for (i, &(bx, by)) in blocks.iter().enumerate() {
        out[i * 8..i * 8 + 4].copy_from_slice(&bx.to_le_bytes());
        out[i * 8 + 4..i * 8 + 8].copy_from_slice(&by.to_le_bytes());
    }
}

/// Seeds one persisted row into `handle`'s index. Called once per row, in KV scan (ascending id) order.
#[no_mangle]
pub extern "C" fn ls_temporal_index_load(handle: u32, header: u32, blocks: u32) -> i32 {
    // SAFETY: adapter-owned descriptor, bounds checked.
    let Some(h) = (unsafe { slice(header, TEMPORAL_RECORD_HEADER_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let id = String::from_utf8_lossy(&h[0..10]).into_owned();
    let rect = super::wire::read_rect(&h[10..42]);
    let r = super::wire::Reader(h);
    let (chosen_frame, chosen_time, complete, revisions, block_count) =
        (r.u32(42), r.f64(46), r.u32(54) != 0, r.u32(58), r.u32(62));
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(block_list) = (unsafe { read_blocks(blocks, block_count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(index) = temporal_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    index.load(TemporalRecord {
        id,
        rect,
        keys: block_list.into_iter().collect::<HashSet<_>>(),
        chosen_frame,
        chosen_time,
        complete,
        revisions,
    });
    STATUS_OK
}

/// The decision half of `resolveTemporal` (everything up to the maskComplete walk). `next_seq` mirrors
/// `Compositor.temporalSequence` (src/core/compositor.ts) — a counter shared across every canvas, threaded
/// through by the caller, not owned by this index. `out` receives `write_block_count` (u32, 4 bytes; the caller
/// sizes a buffer of that many `(i32, i32)` pairs for `ls_temporal_mask_complete_and_commit`) then the
/// (possibly incremented) `next_seq` (f64, 8 bytes) — 12 bytes total.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_temporal_decide(
    handle: u32,
    comp_bounds: u32,
    comp_blocks: u32,
    comp_block_count: u32,
    frame: u32,
    time: f64,
    visible: u32,
    latest_policy: u32,
    next_seq: f64,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned descriptors, bounds checked.
    let (Some(bounds_bytes), Some(visible_bytes)) = (unsafe { slice(comp_bounds, 32) }, unsafe {
        slice(visible, 32)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let bounds = super::wire::read_rect(bounds_bytes);
    let visible_rect = super::wire::read_rect(visible_bytes);
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(blocks) = (unsafe { read_blocks(comp_blocks, comp_block_count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(index) = temporal_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // `next_seq` mirrors `Compositor.temporalSequence` (src/core/compositor.ts): a single counter shared across
    // every canvas the Compositor touches, not owned by any one canvas's `TemporalIndex` — the caller threads
    // it through every `decide()` call (on every canvas's handle) and keeps the returned value.
    let (write_block_count, next_seq) = index.decide(
        bounds,
        &blocks,
        frame,
        time,
        visible_rect,
        latest_policy != 0,
        next_seq as u64,
    );
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 12) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&(write_block_count as u32).to_le_bytes());
    dst[4..12].copy_from_slice(&(next_seq as f64).to_le_bytes());
    STATUS_OK
}

/// The pixel-level maskComplete walk plus the commit half of `resolveTemporal`, in one call: reads the atlas
/// label plane, occlusions and (optional) consistency mask, decides whether the pending component (from the
/// last `ls_temporal_decide` on this handle) is actually written, finalises the index either way, and — when
/// chosen — copies the write-block list (already sized by `ls_temporal_decide`'s `write_block_count`) to
/// `write_blocks_out` for the caller to pass to `overwriteTile`. `out` receives: u32 chosen, u32 emitIncomplete,
/// then the record's rect (32 bytes, f64 x/y/width/height) — 40 bytes total.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_temporal_mask_complete_and_commit(
    handle: u32,
    labels: u32,
    atlas_width: i32,
    atlas_height: i32,
    code: u32,
    occlusions: u32,
    occlusion_count: u32,
    consistent: u32,
    ox: i32,
    oy: i32,
    write_blocks_out: u32,
    write_block_count: u32,
    out: u32,
) -> i32 {
    if atlas_width <= 0 || atlas_height <= 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let Some(index) = temporal_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let pending_blocks = index.pending_write_blocks().to_vec();
    if pending_blocks.len() != write_block_count as usize {
        return STATUS_BAD_ARGUMENT;
    }
    let mask_ok = if write_block_count == 0 {
        false
    } else {
        // SAFETY: adapter-owned buffer, bounds checked; the atlas label plane is exactly `atlas_width *
        // atlas_height` bytes (rust/core/src/abi/regions.rs::ls_regions_label_atlas).
        let Some(labels_bytes) =
            (unsafe { slice(labels, atlas_width as usize * atlas_height as usize) })
        else {
            return STATUS_BAD_ARGUMENT;
        };
        let occ_rects = if occlusion_count == 0 {
            Vec::new()
        } else {
            // SAFETY: adapter-owned buffer, bounds checked.
            let Some(occ_bytes) = (unsafe { slice(occlusions, occlusion_count as usize * 32) })
            else {
                return STATUS_BAD_ARGUMENT;
            };
            read_rects(occ_bytes)
        };
        let consistent_bytes = if consistent == 0 {
            None
        } else {
            // SAFETY: adapter-owned buffer, bounds checked; image-sized == atlas-sized (asserted by the caller).
            let Some(c) =
                (unsafe { slice(consistent, atlas_width as usize * atlas_height as usize) })
            else {
                return STATUS_BAD_ARGUMENT;
            };
            Some(c)
        };
        mask_complete(
            &pending_blocks,
            labels_bytes,
            atlas_width as i64,
            atlas_height as i64,
            code as u8,
            &occ_rects,
            consistent_bytes,
            ox as i64,
            oy as i64,
        )
    };
    // Read the write-block bytes out BEFORE `commit` (which consumes the pending state) — `write_blocks_out` is
    // sized to `write_block_count` by the caller from `ls_temporal_decide`'s return, so this is safe even when
    // the mask check fails and the buffer ends up unused.
    if write_block_count > 0 {
        // SAFETY: adapter-owned buffer, sized by the caller to `write_block_count * 8` bytes.
        let Some(dst) = (unsafe { slice_mut(write_blocks_out, write_block_count as usize * 8) })
        else {
            return STATUS_BAD_ARGUMENT;
        };
        write_blocks(dst, &pending_blocks);
    }
    let Some(commit) = index.commit(mask_ok) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 40) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&(commit.chosen as u32).to_le_bytes());
    dst[4..8].copy_from_slice(&(commit.emit_incomplete as u32).to_le_bytes());
    dst[8..16].copy_from_slice(&commit.rect.x.to_le_bytes());
    dst[16..24].copy_from_slice(&commit.rect.y.to_le_bytes());
    dst[24..32].copy_from_slice(&commit.rect.width.to_le_bytes());
    dst[32..40].copy_from_slice(&commit.rect.height.to_le_bytes());
    STATUS_OK
}

/// Sizes for the buffers `ls_temporal_flush_take` will need. `out` receives u32 deletedCount, u32 dirtyCount,
/// u32 dirtyBlockTotal (12 bytes) — mirrors `Compositor.flush()`'s per-canvas body (src/core/compositor.ts),
/// used both by `flush()` itself and by `dispose()` (which drains every canvas's handle before freeing it,
/// since it runs before the pipeline's final `flush()` — src/pipeline/render.ts).
#[no_mangle]
pub extern "C" fn ls_temporal_flush_sizes(handle: u32, out: u32) -> i32 {
    let Some(index) = temporal_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (deleted_count, dirty_count, dirty_block_total) = index.flush_sizes();
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 12) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&(deleted_count as u32).to_le_bytes());
    dst[4..8].copy_from_slice(&(dirty_count as u32).to_le_bytes());
    dst[8..12].copy_from_slice(&(dirty_block_total as u32).to_le_bytes());
    STATUS_OK
}

/// Drains `deleted` (in order, `deleted_count` × 10-byte ids into `deleted_out`) and `dirty` (in order,
/// `dirty_count` × `TEMPORAL_RECORD_HEADER_BYTES` headers into `dirty_headers_out`, with every dirty record's
/// blocks concatenated in row order into `dirty_blocks_out`), clearing both sets. The three counts must come
/// from a `ls_temporal_flush_sizes` call on this handle with no `ls_temporal_decide`/`_commit`/`_load` in
/// between.
#[no_mangle]
pub extern "C" fn ls_temporal_flush_take(
    handle: u32,
    deleted_out: u32,
    deleted_count: u32,
    dirty_headers_out: u32,
    dirty_blocks_out: u32,
    dirty_count: u32,
) -> i32 {
    let Some(index) = temporal_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // Validate the caller's counts against `flush_sizes()` (the same figures the caller is required to have
    // just read them from — see the doc comment above) and every output slice BEFORE calling `flush_take()`,
    // which mutates the index by draining `dirty`/`deleted`. `flush_take()` has no way to put rows back, so
    // calling it first and only then discovering a bad count or pointer (the previous order here) silently
    // dropped every dirty/deleted row on a mismatch instead of returning an error with the index unchanged.
    let (want_deleted, want_dirty, want_total_blocks) = index.flush_sizes();
    if deleted_count as usize != want_deleted || dirty_count as usize != want_dirty {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(deleted_dst) = (unsafe { slice_mut(deleted_out, deleted_count as usize * 10) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(headers_dst), Some(blocks_dst)) = (
        unsafe {
            slice_mut(
                dirty_headers_out,
                dirty_count as usize * TEMPORAL_RECORD_HEADER_BYTES,
            )
        },
        unsafe { slice_mut(dirty_blocks_out, want_total_blocks * 8) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (deleted, dirty) = index.flush_take();
    // `flush_sizes()` and `flush_take()` observe the same index with no mutation between them (this function
    // holds the only `&mut` access to it), so these can only disagree if that invariant is broken elsewhere;
    // the buffers above are already sized and validated against `want_*`, so a divergence here is a bug in
    // this file, not a caller error to report.
    debug_assert_eq!(deleted.len(), want_deleted);
    debug_assert_eq!(dirty.len(), want_dirty);
    for (i, id) in deleted.iter().enumerate() {
        let b = id.as_bytes();
        deleted_dst[i * 10..i * 10 + 10.min(b.len())].copy_from_slice(&b[..10.min(b.len())]);
    }
    let mut boff = 0usize;
    for (i, (record, blocks)) in dirty.iter().enumerate() {
        write_record_header(
            &mut headers_dst
                [i * TEMPORAL_RECORD_HEADER_BYTES..(i + 1) * TEMPORAL_RECORD_HEADER_BYTES],
            record,
            blocks.len() as u32,
        );
        write_blocks(&mut blocks_dst[boff..boff + blocks.len() * 8], blocks);
        boff += blocks.len() * 8;
    }
    STATUS_OK
}
