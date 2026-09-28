//! Tile compositing: merges one observation into a resident tile's pixels, coverage and quality bookkeeping.

use crate::abi::memory::{in_bounds, slice, slice_mut};
use crate::abi::wire::{read_rect, read_rects, Reader, COMPOSITE_HEADER_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::compositor::{composite_tile, Observation, TileBuffers, QUALITY_BLOCK};

/// Tile descriptor (40 bytes): u32 pixels, coverage, provisional, quality, conflicts, owner, score, frozen
/// pointers, u32 size, u32 padding. Observation descriptor (64 bytes): u32 rgba, u32 width, u32 height,
/// u32 labels (0 = rectangular fast path), u32 code, u32 occlusions ptr, u32 occlusion count, u32 consistent
/// ptr (0 = all consistent), f64 confidence, u32 uncertain, u32 frame, f64 source noise, 8 bytes padding.
/// `world` points at one rect; `out` holds COMPOSITE_HEADER_BYTES + 8 × block count.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_composite_tile(
    tile: u32,
    observation: u32,
    world: u32,
    ox: i32,
    oy: i32,
    tx: i32,
    ty: i32,
    out: u32,
) -> i32 {
    // SAFETY: descriptors are adapter-owned, bounds checked field by field below.
    let (Some(t), Some(o), Some(world)) = (
        unsafe { slice(tile, 40) },
        unsafe { slice(observation, 64) },
        unsafe { slice(world, 32) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (t, o) = (Reader(t), Reader(o));
    let size = t.u32(32) as usize;
    if size == 0 || !size.is_multiple_of(QUALITY_BLOCK) {
        return STATUS_BAD_ARGUMENT;
    }
    let n = size * size;
    let blocks = (size / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
    let (width, height) = (o.u32(4) as usize, o.u32(8) as usize);
    if width == 0 || height == 0 {
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
        Some(rgba),
        Some(dst),
    ) = (unsafe {
        (
            slice_mut(t.u32(0), n * 4),
            slice_mut(t.u32(4), n.div_ceil(8)),
            slice_mut(t.u32(8), n.div_ceil(8)),
            slice_mut(t.u32(12), blocks),
            slice_mut(t.u32(16), blocks),
            slice(t.u32(28), blocks),
            slice(o.u32(0), width * height * 4),
            slice_mut(out, COMPOSITE_HEADER_BYTES + 8 * blocks),
        )
    })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let (owner_ptr, score_ptr) = (t.u32(20), t.u32(24));
    if owner_ptr == 0
        || score_ptr == 0
        || owner_ptr % 4 != 0
        || score_ptr % 4 != 0
        || !in_bounds(owner_ptr, blocks * 4)
        || !in_bounds(score_ptr, blocks * 4)
    {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: 4-byte aligned, bounds checked, adapter-owned.
    let owner = unsafe { std::slice::from_raw_parts_mut(owner_ptr as *mut u32, blocks) };
    let score = unsafe { std::slice::from_raw_parts_mut(score_ptr as *mut f32, blocks) };
    let labels = if o.u32(12) == 0 {
        None
    } else {
        // SAFETY: label plane covers the frame.
        match unsafe { slice(o.u32(12), width * height) } {
            Some(l) => Some((l, o.u32(16) as u8)),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let occlusion_count = o.u32(24) as usize;
    // SAFETY: occlusion rects are adapter-owned.
    let occlusions = if occlusion_count == 0 {
        Vec::new()
    } else {
        match unsafe { slice(o.u32(20), occlusion_count * 32) } {
            Some(b) => read_rects(b),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let consistent = if o.u32(28) == 0 {
        None
    } else {
        // SAFETY: mask covers the frame.
        match unsafe { slice(o.u32(28), width * height) } {
            Some(c) => Some(c),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let obs = Observation {
        rgba,
        width,
        height,
        labels,
        occlusions: &occlusions,
        consistent,
        confidence: o.f64(32),
        noise: o.f64(48),
        uncertain: o.u32(40) != 0,
        frame: o.u32(44),
    };
    let mut buffers = TileBuffers {
        size,
        pixels,
        coverage,
        provisional,
        quality,
        conflicts,
        owner,
        score,
        frozen,
        disputes: if t.u32(36) == 0 {
            None
        } else {
            // SAFETY: separate adapter-owned block array, validated against linear memory.
            let Some(values) = (unsafe { slice_mut(t.u32(36), blocks) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            Some(values)
        },
    };
    let stats = composite_tile(
        &mut buffers,
        &obs,
        read_rect(world),
        ox as i64,
        oy as i64,
        tx as i64,
        ty as i64,
    );
    dst[0..4].copy_from_slice(&stats.added.to_le_bytes());
    dst[4..8].copy_from_slice(&stats.conflicts.to_le_bytes());
    dst[8..12].copy_from_slice(&stats.uncertain.to_le_bytes());
    dst[12..16].copy_from_slice(&stats.provisional_delta.to_le_bytes());
    dst[16..20].copy_from_slice(&(stats.changed as u32).to_le_bytes());
    dst[20..24].copy_from_slice(&(stats.conflict_blocks.len() as u32).to_le_bytes());
    for (i, (bx, by)) in stats.conflict_blocks.iter().enumerate() {
        let at = COMPOSITE_HEADER_BYTES + i * 8;
        dst[at..at + 4].copy_from_slice(&bx.to_le_bytes());
        dst[at + 4..at + 8].copy_from_slice(&by.to_le_bytes());
    }
    crate::abi::STATUS_OK
}
