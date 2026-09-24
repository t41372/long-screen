//! `ls_track_reacquire`/`ls_track_drift_correction`: `extern "C"` surface for `crate::track::reacquire_hypotheses`
//! / `reacquire_refine` / `drift_correction` — split out of the former monolithic `abi/track.rs`. See
//! `abi/track.rs`'s module doc comment for the split; `read_patches`
//! and `resolve_native` stay there (shared with `track_keyframes`).

use crate::abi::features::read_features;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::track::{read_patches, resolve_native};
use crate::abi::wire::{read_rect, FEATURE_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::track;

/// `ls_track_reacquire`'s `out` layout (40 bytes): i32 x, i32 y, u32 ambiguous, u32 padding, f64 confidence,
/// f64 error, u32 filledNative, u32 padding.
const TRACK_REACQUIRE_OUT_BYTES: usize = 40;

/// `track.ts::reacquire` — `matchFeatures` + `translationHypotheses` (no native luma needed; see
/// `crate::track::reacquire_hypotheses`), then, only when that found a candidate, the native-plane lazy fill
/// (see `resolve_native`) and up to 4 patch refinements + rival rejection (`crate::track::reacquire_refine`).
/// Returns `1` (found), `0` (no candidate, or a rival rejected the top one), or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_reacquire(
    anchor_features: u32,
    anchor_feature_count: u32,
    own_features: u32,
    own_feature_count: u32,
    anchor_patches: u32,
    patch_count: u32,
    rect: u32,
    f: f64,
    radius: u32,
    native_mode: u32,
    native_ptr: u32,
    current_frame_ptr: u32,
    already_filled: u32,
    native_width: u32,
    native_height: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(anchor_bytes), Some(own_bytes), Some(rect_bytes), Some(dst)) = (
        unsafe {
            slice(
                anchor_features,
                anchor_feature_count as usize * FEATURE_BYTES,
            )
        },
        unsafe { slice(own_features, own_feature_count as usize * FEATURE_BYTES) },
        unsafe { slice(rect, 32) },
        unsafe { slice_mut(out, TRACK_REACQUIRE_OUT_BYTES) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.fill(0);
    let anchor_features_v = read_features(anchor_bytes);
    let own_features_v = read_features(own_bytes);
    let models = track::reacquire_hypotheses(&anchor_features_v, &own_features_v);
    if models.is_empty() {
        return 0;
    }
    // SAFETY: bounds checked inside; a bad pointer here is the caller's error, not "no candidate".
    let Some((native, filled_now)) = (unsafe {
        resolve_native(
            native_mode,
            native_ptr,
            current_frame_ptr,
            already_filled,
            native_width,
            native_height,
        )
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[36..40].copy_from_slice(&(filled_now as u32).to_le_bytes());
    // SAFETY: adapter-owned patch descriptors, bounds checked.
    let Some(patches) = (unsafe { read_patches(anchor_patches, patch_count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match track::reacquire_refine(
        &models,
        &patches,
        native,
        read_rect(rect_bytes),
        f,
        radius as i32,
    ) {
        Some(r) => {
            dst[0..4].copy_from_slice(&r.x.to_le_bytes());
            dst[4..8].copy_from_slice(&r.y.to_le_bytes());
            dst[8..12].copy_from_slice(&(r.ambiguous as u32).to_le_bytes());
            dst[16..24].copy_from_slice(&r.confidence.to_le_bytes());
            dst[24..32].copy_from_slice(&r.error.to_le_bytes());
            1
        }
        None => 0,
    }
}

/// `ls_track_drift_correction`'s `out` layout (40 bytes): f64 x, f64 y, f64 error, u32 filledNative, u32 padding,
/// f64 confidenceFloor.
pub(crate) const TRACK_DRIFT_CORRECTION_OUT_BYTES: usize = 40;

/// `track.ts::driftCorrection` — no gate (the original always evaluates `native()`), so this always
/// resolves native luma (lazy fill, see `resolve_native`) before the one patch refinement. Returns `1`
/// (corrected), `0` (not corrected), or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_drift_correction(
    anchor_patches: u32,
    patch_count: u32,
    rect: u32,
    ax: f64,
    ay: f64,
    px: f64,
    py: f64,
    radius: u32,
    native_mode: u32,
    native_ptr: u32,
    current_frame_ptr: u32,
    already_filled: u32,
    native_width: u32,
    native_height: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(rect_bytes), Some(dst)) = (unsafe { slice(rect, 32) }, unsafe {
        slice_mut(out, TRACK_DRIFT_CORRECTION_OUT_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.fill(0);
    // SAFETY: bounds checked inside.
    let Some((native, filled_now)) = (unsafe {
        resolve_native(
            native_mode,
            native_ptr,
            current_frame_ptr,
            already_filled,
            native_width,
            native_height,
        )
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[24..28].copy_from_slice(&(filled_now as u32).to_le_bytes());
    // SAFETY: adapter-owned patch descriptors, bounds checked.
    let Some(patches) = (unsafe { read_patches(anchor_patches, patch_count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match track::drift_correction(
        &patches,
        native,
        read_rect(rect_bytes),
        (ax, ay),
        (px, py),
        radius as i32,
    ) {
        Some(r) => {
            dst[0..8].copy_from_slice(&r.x.to_le_bytes());
            dst[8..16].copy_from_slice(&r.y.to_le_bytes());
            dst[16..24].copy_from_slice(&r.error.to_le_bytes());
            dst[32..40].copy_from_slice(&r.confidence_floor.to_le_bytes());
            1
        }
        None => 0,
    }
}
