//! ABI surface for temporal-conflict block components (mirrors `src/core/wasm/temporal.ts`).

use crate::abi::memory::{in_bounds, slice, slice_mut};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::temporal::{components, overwrite_tile, OverwriteTile, QUALITY_BLOCK};

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
