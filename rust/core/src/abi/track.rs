//! `extern "C"` surface for `crate::track`'s stateless tracking verdicts (R4b phase 3a): hub module for the
//! track trio's ABI layer plus the shared buffer-marshalling helpers `track_reacquire`/`track_keyframes` both
//! need (`read_patches`, `fill_native_plane`, `resolve_native`). Split (R6-B, final-verify-report.md item 10:
//! this was one 842-line file) into `track_odometry` (`ls_track_odometry`), `track_reacquire`
//! (`ls_track_reacquire`/`ls_track_drift_correction`), `track_keyframes` (`ls_keyframes_evaluate_candidates`);
//! `extern "C"` names are resolved by the linker, so no call-site elsewhere changes.
//!
//! The stateless verdicts here (`ls_track_uncertainty` through `ls_track_region_zoom`) are
//! scalar-in/scalar-or-small-buffer-out and cannot fail on a bad argument (there is no pointer to validate
//! except `ls_track_region_zoom`'s match buffer), so those use no status convention — a boolean is `0`/`1` in
//! an `i32`, a multi-way verdict is a small tag, and `Option<f64>` uses `f64::NAN` as its "none" sentinel
//! (every real result here is finite, matching `ls_detect_scale`'s own convention that it never returns NaN).
//! `ls_track_odometry`/`ls_track_reacquire`/`ls_track_drift_correction`/`ls_keyframes_evaluate_candidates`
//! (in the sibling modules) DO validate adapter-owned buffer pointers and DO use `STATUS_BAD_ARGUMENT` on
//! failure — see each export's own doc comment for its success-path convention.

use super::motion::read_match_points;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::PATCH_BYTES;
use crate::abi::{STATUS_BAD_ARGUMENT, STATUS_OK};
use crate::motion::{Gray, Patch};
use crate::track;

fn b(v: bool) -> i32 {
    if v {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn ls_track_uncertainty(confidence: f64, ambiguous: u32, weak_step: u32) -> i32 {
    b(track::uncertainty(
        confidence,
        ambiguous != 0,
        weak_step != 0,
    ))
}

/// `has_match == 0` means "no historical match" (`match === undefined` in the TS original).
#[no_mangle]
pub extern "C" fn ls_track_relocalize_verdict(
    has_match: u32,
    ambiguous: u32,
    confidence: f64,
    zoom_change: u32,
) -> i32 {
    let m = (has_match != 0).then_some(track::MatchInfo {
        ambiguous: ambiguous != 0,
        confidence,
    });
    b(track::relocalize_verdict(m, zoom_change != 0))
}

/// `crate::track::FragmentCauseGate` as a tag: 0 = none, 1 = zoom-change, 2 = probe-scale.
#[no_mangle]
pub extern "C" fn ls_track_fragment_cause_gate(
    zoom_change: u32,
    has_previous_gray: u32,
    blind: u32,
) -> i32 {
    match track::fragment_cause_gate(zoom_change != 0, has_previous_gray != 0, blind != 0) {
        track::FragmentCauseGate::None => 0,
        track::FragmentCauseGate::ZoomChange => 1,
        track::FragmentCauseGate::ProbeScale => 2,
    }
}

/// `decision`: 0 = tracked, 1 = static, 2 = blind, 3 = lost (see `crate::track::occlusion_eligible`).
#[no_mangle]
pub extern "C" fn ls_track_occlusion_eligible(
    has_previous: u32,
    kind_moving: u32,
    decision: u32,
) -> i32 {
    b(track::occlusion_eligible(
        has_previous != 0,
        kind_moving != 0,
        decision as u8,
    ))
}

/// Writes `(x, y)` as two little-endian f64s to `out`.
fn write_point(out: &mut [u8], p: (f64, f64)) {
    out[0..8].copy_from_slice(&p.0.to_le_bytes());
    out[8..16].copy_from_slice(&p.1.to_le_bytes());
}

#[no_mangle]
pub extern "C" fn ls_track_target_pose(
    kx: f64,
    ky: f64,
    ox: f64,
    oy: f64,
    sx: f64,
    sy: f64,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned, 16-byte output buffer.
    let Some(dst) = (unsafe { slice_mut(out, 16) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    write_point(dst, track::target_pose((kx, ky), (ox, oy), (sx, sy)));
    STATUS_OK
}

/// `has_global == 0` means "no revisit match" (`global === undefined`). Writes the pose to `out` (16
/// bytes) only when the return value is `1`; `out` is left untouched otherwise (mirrors the TS
/// `undefined` case, where the caller never reads a pose).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_attach_verdict(
    has_global: u32,
    kx: f64,
    ky: f64,
    ox: f64,
    oy: f64,
    ambiguous: u32,
    confidence: f64,
    resolved_target_eq_canvas: u32,
    sx: f64,
    sy: f64,
    out: u32,
) -> i32 {
    let global = (has_global != 0).then_some(track::GlobalMatch {
        keyframe: (kx, ky),
        offset: (ox, oy),
        ambiguous: ambiguous != 0,
        confidence,
    });
    match track::attach_verdict(global, resolved_target_eq_canvas != 0, (sx, sy)) {
        Some(pose) => {
            // SAFETY: adapter-owned, 16-byte output buffer.
            let Some(dst) = (unsafe { slice_mut(out, 16) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            write_point(dst, pose);
            1
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn ls_track_odometry_weight(weak_step: u32) -> f64 {
    track::odometry_weight(weak_step != 0)
}

#[no_mangle]
pub extern "C" fn ls_track_thin_overlap_eligible(
    weak_step: u32,
    weak: u32,
    ambiguous: u32,
    confidence: f64,
    error: f64,
) -> i32 {
    b(track::thin_overlap_eligible(
        weak_step != 0,
        weak != 0,
        ambiguous != 0,
        confidence,
        error,
    ))
}

/// Writes `(target.x, target.y, discrepancy)` (24 bytes) to `out` when eligible; returns `1`/`0`. `out`
/// is left untouched when the return value is `0` (mirrors the TS `undefined` case).
#[no_mangle]
pub extern "C" fn ls_track_thin_overlap_correction(
    ckx: f64,
    cky: f64,
    ox: f64,
    oy: f64,
    px: f64,
    py: f64,
    out: u32,
) -> i32 {
    match track::thin_overlap_correction((ckx, cky), (ox, oy), (px, py)) {
        Some((target, discrepancy)) => {
            // SAFETY: adapter-owned, 24-byte output buffer.
            let Some(dst) = (unsafe { slice_mut(out, 24) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            write_point(dst, target);
            dst[16..24].copy_from_slice(&discrepancy.to_le_bytes());
            1
        }
        None => 0,
    }
}

/// `crate::track::LoopVerdict` as a tag: 0 = closure, 1 = inconsistent, 2 = ambiguous, 3 = none.
/// Always writes `discrepancy` (8 bytes) to `out` — unlike the correction exports above, the TS original
/// always returns a discrepancy alongside the verdict.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_loop_closure_verdict(
    gkx: f64,
    gky: f64,
    gox: f64,
    goy: f64,
    g_ambiguous: u32,
    g_confidence: f64,
    sx: f64,
    sy: f64,
    px: f64,
    py: f64,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned, 8-byte output buffer.
    let Some(dst) = (unsafe { slice_mut(out, 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (verdict, discrepancy) = track::loop_closure_verdict(
        (gkx, gky),
        (gox, goy),
        g_ambiguous != 0,
        g_confidence,
        (sx, sy),
        (px, py),
    );
    dst[0..8].copy_from_slice(&discrepancy.to_le_bytes());
    match verdict {
        track::LoopVerdict::Closure => 0,
        track::LoopVerdict::Inconsistent => 1,
        track::LoopVerdict::Ambiguous => 2,
        track::LoopVerdict::None => 3,
    }
}

/// `has_anchor`/`has_last_node == 0` mirror `anchor`/`lastNodeFrame` undefined.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_needs_keyframe(
    kind_moving: u32,
    has_anchor: u32,
    ax: f64,
    ay: f64,
    px: f64,
    py: f64,
    has_last_node: u32,
    last_node_frame: i32,
    rect_w: f64,
    rect_h: f64,
    frame_index: i32,
    field_difference: f64,
) -> i32 {
    let anchor = (has_anchor != 0).then_some((ax, ay));
    let last_node = (has_last_node != 0).then_some(last_node_frame);
    b(track::needs_keyframe(
        kind_moving != 0,
        anchor,
        (px, py),
        last_node,
        (rect_w, rect_h),
        frame_index,
        field_difference,
    ))
}

/// `has_region_zoom == 0` mirrors `regionZoom === undefined`.
#[no_mangle]
pub extern "C" fn ls_track_zoom_changed(
    has_region_zoom: u32,
    region_zoom: f64,
    field_zoom: f64,
) -> i32 {
    let rz = (has_region_zoom != 0).then_some(region_zoom);
    b(track::zoom_changed(rz, field_zoom))
}

/// `track.ts::regionZoom` fused with `detect_scale` (see `crate::track::region_zoom`). `NaN` means
/// `undefined` (never a real `detect_scale` result); a bad match buffer also yields `NaN` (matches
/// `ls_detect_scale`'s convention of a neutral default on a bad argument, since this export has no
/// separate status channel).
#[no_mangle]
pub extern "C" fn ls_track_region_zoom(kind_moving: u32, matches: u32, count: u32) -> f64 {
    // SAFETY: adapter-owned buffer, bounds checked by `read_match_points`.
    match unsafe { read_match_points(matches, count) } {
        Some(points) => track::region_zoom(kind_moving != 0, &points).unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

/// # Safety
/// `ptr` points at `count × PATCH_BYTES` descriptors (`rust/core/src/abi/motion.rs::ls_refine_patches`'s wire
/// format) whose `data` pointers each cover `size × size` readable bytes.
pub(crate) unsafe fn read_patches<'a>(ptr: u32, count: u32) -> Option<Vec<Patch<'a>>> {
    let bytes = slice(ptr, count as usize * PATCH_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(PATCH_BYTES) {
        let size = u32::from_le_bytes(c[8..12].try_into().unwrap()) as usize;
        let data_ptr = u32::from_le_bytes(c[12..16].try_into().unwrap());
        let data = slice(data_ptr, size * size)?;
        out.push(Patch {
            x: i32::from_le_bytes(c[0..4].try_into().unwrap()),
            y: i32::from_le_bytes(c[4..8].try_into().unwrap()),
            size,
            data,
        });
    }
    Some(out)
}

/// Fills `native_plane` (`native_width × native_height` bytes) with `current_frame`'s luma
/// (`native_width × native_height × 4` RGBA bytes) — `crate::raster::grayscale`, the same kernel
/// `ls_grayscale`/`core().grayscaleInto` already wrap, called directly (same crate, no ABI round trip) so the
/// two lazy-fill call sites below (`ls_track_reacquire`, `ls_track_drift_correction`) share one implementation.
///
/// # Safety
/// `current_frame` points at `native_width × native_height × 4` readable bytes; `native_plane` at
/// `native_width × native_height` writable bytes.
pub(crate) unsafe fn fill_native_plane(
    current_frame: u32,
    native_plane: u32,
    native_width: u32,
    native_height: u32,
) -> bool {
    let n = native_width as usize * native_height as usize;
    let (Some(rgba), Some(plane)) = (slice(current_frame, n * 4), slice_mut(native_plane, n))
    else {
        return false;
    };
    crate::raster::grayscale(rgba, plane);
    true
}

/// Resolves the "native luma source" every `ls_track_reacquire`/`ls_track_drift_correction` call needs, lazily:
/// `native_mode` 0 means `native_ptr` already holds a ready `native_width × native_height` luma buffer (the
/// non-resident-current-frame fallback the TS wrapper computes eagerly, exactly as the original `native()`
/// thunk did — see `src/core/wasm/track.ts`); `native_mode` 1 means `native_ptr` is the shared RESIDENT native
/// plane, filled from `current_frame_ptr` only if `already_filled == 0` (R4c 3b-ii: "computed lazily core-side
/// ... at most once per frame"). Returns `(gray, filled_now)`; `filled_now` is only ever true in mode 1, and
/// only on the call that actually did the fill — the caller reports it back to TS so the SAME per-frame memo
/// `solve.ts`'s `native()` closure already uses (shared with every other native-luma consumer, e.g.
/// keyframe-step.ts) is updated too, not just this call's own view.
///
/// # Safety
/// See `fill_native_plane`; in mode 0, `native_ptr` points at `native_width × native_height` readable bytes.
#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn resolve_native<'a>(
    native_mode: u32,
    native_ptr: u32,
    current_frame_ptr: u32,
    already_filled: u32,
    native_width: u32,
    native_height: u32,
) -> Option<(Gray<'a>, bool)> {
    let (w, h) = (native_width as usize, native_height as usize);
    if native_mode == 0 {
        let data = slice(native_ptr, w * h)?;
        return Some((
            Gray {
                width: w,
                height: h,
                data,
            },
            false,
        ));
    }
    let filled_now = if already_filled == 0 {
        if !fill_native_plane(current_frame_ptr, native_ptr, native_width, native_height) {
            return None;
        }
        true
    } else {
        false
    };
    let data = slice(native_ptr, w * h)?;
    Some((
        Gray {
            width: w,
            height: h,
            data,
        },
        filled_now,
    ))
}
