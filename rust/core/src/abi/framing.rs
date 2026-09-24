//! Presentation-canvas synthesis: layout/coordinate mapping, background statistics, and the two per-tile
//! passes `buildFramedCanvas` drives (`src/core/wasm/framing.ts` mirrors this file).

use crate::abi::memory::{in_bounds, slice, slice_mut};
use crate::abi::wire::{read_rect, Reader, VOTING_REGION_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::framing::{
    backgrounds, fold_evidence, frame_coordinate, frame_layout, paint_tile, Coordinate, Layout,
    OutputTile, SourceTile,
};
use crate::region::{Mask as RegionMask, Region};

/// Bytes of one serialised `Layout` (`ls_frame_layout`'s `out`): pane rect (32), content rect (32), dx f64 (8),
/// dy f64 (8), seam_x f64 (8), width f64 (8), height f64 (8).
pub(crate) const LAYOUT_BYTES: usize = 104;
const SOURCE_TILE_BYTES: usize = 40;

fn write_layout(dst: &mut [u8], layout: &Layout) {
    let w = |dst: &mut [u8], at: usize, v: f64| dst[at..at + 8].copy_from_slice(&v.to_le_bytes());
    w(dst, 0, layout.pane.x);
    w(dst, 8, layout.pane.y);
    w(dst, 16, layout.pane.width);
    w(dst, 24, layout.pane.height);
    w(dst, 32, layout.content.x);
    w(dst, 40, layout.content.y);
    w(dst, 48, layout.content.width);
    w(dst, 56, layout.content.height);
    w(dst, 64, layout.dx);
    w(dst, 72, layout.dy);
    w(dst, 80, layout.seam_x);
    w(dst, 88, layout.width);
    w(dst, 96, layout.height);
}

fn read_layout(src: &[u8]) -> Layout {
    let r = Reader(src);
    Layout {
        pane: read_rect(&src[0..32]),
        content: read_rect(&src[32..64]),
        dx: r.f64(64),
        dy: r.f64(72),
        seam_x: r.f64(80),
        width: r.f64(88),
        height: r.f64(96),
    }
}

/// Computes `frameLayout`. `pane` is one 32-byte rect (`region.crop || region.rect`); `out` is `LAYOUT_BYTES`.
#[no_mangle]
pub extern "C" fn ls_frame_layout(
    source_width: f64,
    source_height: f64,
    pane: u32,
    bounds_width: f64,
    bounds_height: f64,
    out: u32,
) -> i32 {
    let (Some(pane), Some(out)) = (unsafe { slice(pane, 32) }, unsafe {
        slice_mut(out, LAYOUT_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let layout = frame_layout(
        source_width,
        source_height,
        read_rect(pane),
        bounds_width,
        bounds_height,
    );
    write_layout(out, &layout);
    crate::abi::STATUS_OK
}

/// Computes `frameCoordinate` for test/diagnostic use (not on the per-tile hot path, which classifies pixels
/// inline in `ls_frame_paint_tile`). Returns 0 (content), 1 (extension), 2 (source — `out` holds x, y as two
/// f64), or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
pub extern "C" fn ls_frame_coordinate(layout: u32, x: f64, y: f64, out: u32) -> i32 {
    let (Some(layout), Some(out)) = (unsafe { slice(layout, LAYOUT_BYTES) }, unsafe {
        slice_mut(out, 16)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match frame_coordinate(&read_layout(layout), x, y) {
        Coordinate::Content => 0,
        Coordinate::Extension => 1,
        Coordinate::Source(sx, sy) => {
            out[0..8].copy_from_slice(&sx.to_le_bytes());
            out[8..16].copy_from_slice(&sy.to_le_bytes());
            2
        }
    }
}

/// Computes the modal background rows/columns for `pane` in `source` (`backgrounds()`); `rows_out` holds
/// `source_height` u32s, `columns_out` holds `source_width` u32s.
#[no_mangle]
pub extern "C" fn ls_frame_backgrounds(
    source: u32,
    source_width: u32,
    source_height: u32,
    pane: u32,
    rows_out: u32,
    columns_out: u32,
) -> i32 {
    let (w, h) = (source_width as usize, source_height as usize);
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (Some(source), Some(pane), Some(rows_out), Some(columns_out)) = (
        unsafe { slice(source, w * h * 4) },
        unsafe { slice(pane, 32) },
        unsafe { slice_mut(rows_out, h * 4) },
        unsafe { slice_mut(columns_out, w * 4) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (rows, columns) = backgrounds(source, w, h, read_rect(pane));
    for (d, v) in rows_out.chunks_exact_mut(4).zip(rows) {
        d.copy_from_slice(&v.to_le_bytes());
    }
    for (d, v) in columns_out.chunks_exact_mut(4).zip(columns) {
        d.copy_from_slice(&v.to_le_bytes());
    }
    crate::abi::STATUS_OK
}

/// Reads `count` little-endian u32s out of a bounds-checked byte slice (background rows/columns: small,
/// computed once per canvas, so a copy here is not worth an alignment-dependent reinterpret).
fn read_u32s(bytes: &[u8], count: usize) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .take(count)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// # Safety
/// `ptr` points at `count × VOTING_REGION_BYTES` bytes whose embedded pointers cover the sizes they declare.
unsafe fn read_regions(ptr: u32, count: u32) -> Option<Vec<Region>> {
    let bytes = slice(ptr, count as usize * VOTING_REGION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(VOTING_REGION_BYTES) {
        let r = Reader(c);
        let rect = read_rect(&c[0..32]);
        let exclusions = crate::abi::wire::read_rects(slice(r.u32(32), r.u32(36) as usize * 32)?);
        let crop = crate::abi::wire::read_optional_rect(r.u32(40)).ok()?;
        let mask = if r.u32(48) == 0 {
            None
        } else {
            let (mw, mh) = (r.u32(52) as usize, r.u32(56) as usize);
            if mw == 0 || mh == 0 {
                return None;
            }
            Some(RegionMask {
                width: mw,
                height: mh,
                factor: r.u32(60),
                data: slice(r.u32(48), mw * mh)?.to_vec(),
            })
        };
        out.push(Region {
            rect,
            exclusions,
            crop,
            solid: r.u32(44) != 0,
            mask,
        });
    }
    Some(out)
}

/// Pass 1 of `buildFramedCanvas` for one output tile: paints native-chrome and background-extension pixels
/// (`bounds` = `boundsFor(tx, ty)`, already clipped to the framed canvas). Content-rect pixels are left
/// untouched for `ls_frame_fold_evidence` (or, absent overlapping source evidence, whatever `pixels`/`coverage`
/// already held — a resumed run's tile is not zeroed first). Descriptor (76 bytes): u32 layout ptr, bounds rect
/// (4×f64), u32 source rgba ptr, u32 source width, u32 source height, u32 bg rows ptr, u32 bg columns ptr,
/// u32 ignore-region ptr (`VOTING_REGION_BYTES` entries), u32 ignore-region count, u32 tile size, u32 output
/// pixels ptr, u32 output coverage ptr.
#[no_mangle]
pub extern "C" fn ls_frame_paint_tile(desc: u32) -> i32 {
    let Some(d) = (unsafe { slice(desc, 76) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = Reader(d);
    let Some(layout_bytes) = (unsafe { slice(r.u32(0), LAYOUT_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let layout = read_layout(layout_bytes);
    let bounds = read_rect(&d[4..36]);
    let (sw, sh) = (r.u32(40) as usize, r.u32(44) as usize);
    if sw == 0 || sh == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (Some(source), Some(bg_rows), Some(bg_columns)) = (
        unsafe { slice(r.u32(36), sw * sh * 4) },
        unsafe { slice(r.u32(48), sh * 4) },
        unsafe { slice(r.u32(52), sw * 4) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (bg_rows, bg_columns) = (read_u32s(bg_rows, sh), read_u32s(bg_columns, sw));
    let ignore_count = r.u32(60);
    let ignore = if ignore_count == 0 {
        Vec::new()
    } else {
        match unsafe { read_regions(r.u32(56), ignore_count) } {
            Some(v) => v,
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let size = r.u32(64) as usize;
    if size == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let n = size * size;
    let (Some(pixels), Some(coverage)) = (unsafe { slice_mut(r.u32(68), n * 4) }, unsafe {
        slice_mut(r.u32(72), n.div_ceil(8))
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut out = OutputTile {
        size,
        pixels,
        coverage,
        provisional: &mut [],
        quality: &mut [],
        score: &mut [],
        owner: &mut [],
        conflicts: &mut [],
        frozen: &mut [],
    };
    paint_tile(
        &mut out,
        &layout,
        bounds,
        source,
        sw,
        sh,
        &bg_rows,
        &bg_columns,
        &ignore,
    );
    crate::abi::STATUS_OK
}

/// Pass 2 of `buildFramedCanvas` for one output tile: folds up to four overlapping resident source tiles'
/// pixels, coverage, provisional bits and 16×16 block evidence (quality/score/owner/conflicts/frozen) into
/// the output tile. Descriptor (96 bytes): u32 layout ptr, bounds rect (4×f64), f64 source canvas bounds.x,
/// f64 source canvas bounds.y, u32 tile size, u32 output pixels/coverage/provisional/quality/score/owner/
/// conflicts/frozen ptrs, u32 source tile count (0–4), u32 source tile array ptr. Each `SOURCE_TILE_BYTES`
/// (40) entry: i32 sx, i32 sy, u32 pixels/coverage/provisional/quality/score/owner/conflicts/frozen ptrs.
#[no_mangle]
pub extern "C" fn ls_frame_fold_evidence(desc: u32) -> i32 {
    let Some(d) = (unsafe { slice(desc, 96) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = Reader(d);
    let Some(layout_bytes) = (unsafe { slice(r.u32(0), LAYOUT_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let layout = read_layout(layout_bytes);
    let bounds = read_rect(&d[4..36]);
    let (source_bounds_x, source_bounds_y) = (r.f64(36), r.f64(44));
    let size = r.u32(52) as usize;
    if size == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let n = size * size;
    let blocks = (size / 16) * (size / 16);
    let (owner_ptr, score_ptr) = (r.u32(76), r.u32(72));
    if owner_ptr == 0
        || score_ptr == 0
        || owner_ptr % 4 != 0
        || score_ptr % 4 != 0
        || !in_bounds(owner_ptr, blocks * 4)
        || !in_bounds(score_ptr, blocks * 4)
    {
        return STATUS_BAD_ARGUMENT;
    }
    let (
        Some(pixels),
        Some(coverage),
        Some(provisional),
        Some(quality),
        Some(conflicts),
        Some(frozen),
    ) = (
        unsafe { slice_mut(r.u32(56), n * 4) },
        unsafe { slice_mut(r.u32(60), n.div_ceil(8)) },
        unsafe { slice_mut(r.u32(64), n.div_ceil(8)) },
        unsafe { slice_mut(r.u32(68), blocks) },
        unsafe { slice_mut(r.u32(80), blocks) },
        unsafe { slice_mut(r.u32(84), blocks) },
    )
    else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: 4-byte aligned and bounds checked above; distinct allocations from the other tile buffers.
    let score = unsafe { std::slice::from_raw_parts_mut(score_ptr as *mut f32, blocks) };
    let owner = unsafe { std::slice::from_raw_parts_mut(owner_ptr as *mut u32, blocks) };
    let source_count = r.u32(88) as usize;
    if source_count > 4 {
        return STATUS_BAD_ARGUMENT;
    }
    let Some(entries) = (unsafe { slice(r.u32(92), source_count * SOURCE_TILE_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut sources = Vec::with_capacity(source_count);
    for c in entries.chunks_exact(SOURCE_TILE_BYTES) {
        let sr = Reader(c);
        let (sscore_ptr, sowner_ptr) = (sr.u32(24), sr.u32(28));
        if sscore_ptr == 0
            || sowner_ptr == 0
            || sscore_ptr % 4 != 0
            || sowner_ptr % 4 != 0
            || !in_bounds(sscore_ptr, blocks * 4)
            || !in_bounds(sowner_ptr, blocks * 4)
        {
            return STATUS_BAD_ARGUMENT;
        }
        let (
            Some(spixels),
            Some(scoverage),
            Some(sprovisional),
            Some(squality),
            Some(sconflicts),
            Some(sfrozen),
        ) = (
            unsafe { slice(sr.u32(8), n * 4) },
            unsafe { slice(sr.u32(12), n.div_ceil(8)) },
            unsafe { slice(sr.u32(16), n.div_ceil(8)) },
            unsafe { slice(sr.u32(20), blocks) },
            unsafe { slice(sr.u32(32), blocks) },
            unsafe { slice(sr.u32(36), blocks) },
        )
        else {
            return STATUS_BAD_ARGUMENT;
        };
        // SAFETY: 4-byte aligned and bounds checked above; distinct allocations from the other tile buffers.
        let sscore = unsafe { std::slice::from_raw_parts(sscore_ptr as *const f32, blocks) };
        let sowner = unsafe { std::slice::from_raw_parts(sowner_ptr as *const u32, blocks) };
        sources.push(SourceTile {
            sx: sr.i32(0) as i64,
            sy: sr.i32(4) as i64,
            pixels: spixels,
            coverage: scoverage,
            provisional: sprovisional,
            quality: squality,
            score: sscore,
            owner: sowner,
            conflicts: sconflicts,
            frozen: sfrozen,
        });
    }
    let mut out = OutputTile {
        size,
        pixels,
        coverage,
        provisional,
        quality,
        score,
        owner,
        conflicts,
        frozen,
    };
    fold_evidence(
        &mut out,
        &layout,
        source_bounds_x,
        source_bounds_y,
        bounds,
        &sources,
    );
    crate::abi::STATUS_OK
}
