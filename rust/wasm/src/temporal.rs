//! ABI surface for the per-tile write of a resolved temporal patch (`ls_overwrite_tile`, a kernel the compositor
//! tests call directly) and the temporal record wire format the engine compositor's exports share
//! (`compositor.rs`). The temporal index itself lives in the engine compositor (`long_screen::engine::compositor`).

use crate::memory::{in_bounds, slice, slice_mut};
use crate::STATUS_BAD_ARGUMENT;
use long_screen::kernels::temporal::{
    overwrite_tile, OverwriteTile, TemporalRecord, QUALITY_BLOCK,
};

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
    // `overwrite_tile` (rust/long-screen/src/kernels/temporal.rs) indexes `tile.pixels`/`tile.owner` from each block unchecked
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

/// Bytes per serialised temporal record header: 10-byte ASCII id (ids are always exactly 10 digits,
/// `format!("{:010}", n)`), 32-byte rect, u32 chosenFrame, f64 chosenTime, u32 complete, u32 revisions,
/// u32 blockCount. Used both directions: `ls_compositor_load_temporal` reads one per stored row and
/// `ls_compositor_flush_take` writes one per changed row.
pub const TEMPORAL_RECORD_HEADER_BYTES: usize = 66;
pub(crate) fn write_record_header(out: &mut [u8], record: &TemporalRecord, block_count: u32) {
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
pub(crate) unsafe fn read_blocks(ptr: u32, count: u32) -> Option<Vec<(i32, i32)>> {
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
pub(crate) fn write_blocks(out: &mut [u8], blocks: &[(i32, i32)]) {
    for (i, &(bx, by)) in blocks.iter().enumerate() {
        out[i * 8..i * 8 + 4].copy_from_slice(&bx.to_le_bytes());
        out[i * 8 + 4..i * 8 + 8].copy_from_slice(&by.to_le_bytes());
    }
}
