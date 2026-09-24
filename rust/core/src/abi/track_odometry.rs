//! `ls_track_odometry`: `extern "C"` surface for `crate::track::odometry` — split out of the former
//! monolithic `abi/track.rs`. See `abi/track.rs`'s module doc comment
//! for the split.

use crate::abi::features::read_features;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::voting::read_voting_regions;
use crate::abi::wire::{read_rect, FEATURE_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::motion::Gray;
use crate::track;

/// `ls_track_odometry`'s `out` layout (`TRACK_ODOMETRY_OUT_BYTES` in `src/core/wasm/track.ts`): f64 delta.x,
/// f64 delta.y, f64 confidence, u32 ambiguous, u32 weakStep, f64 stepError, u32 hasContentChange, u32 padding,
/// f64 contentChange.agreement, u32 contentChange.blocks, u32 padding (64 bytes total).
const TRACK_ODOMETRY_OUT_BYTES: usize = 64;

/// `track.ts::odometry` fused into one call — `matchFeatures` + `translationHypotheses` + the audit
/// filter/sort + up to 6 native refinements with the velocity prior + rival detection + confidence, falling
/// back (only when no hypothesis refines below the native-error threshold) to the analysis-grid difference
/// sample that decides `static` vs `lost`. `previous`/`current` are full native RGBA frames
/// (`image_width × image_height × 4` bytes); `previous_gray`/`g` are analysis-resolution luma
/// (`gray_width × gray_height` bytes). `region == 0` means "no region" (the difference-sample fallback then
/// treats every sample as contained, matching `Region::contains`'s own no-mask shortcut — every `'moving'`
/// region odometry actually runs against always carries a real region, so this is a defensive fallback, not a
/// path exercised in practice). Returns the decision tag (0 tracked, 1 static, 2 lost) or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_track_odometry(
    previous: u32,
    current: u32,
    image_width: u32,
    image_height: u32,
    previous_gray: u32,
    g: u32,
    gray_width: u32,
    gray_height: u32,
    previous_features: u32,
    previous_feature_count: u32,
    own_features: u32,
    own_feature_count: u32,
    roi: u32,
    rect: u32,
    region: u32,
    labels: u32,
    code: u32,
    f: f64,
    radius: u32,
    vx: f64,
    vy: f64,
    confidence: f64,
    out: u32,
) -> i32 {
    let (iw, ih) = (image_width as usize, image_height as usize);
    let (gw, gh) = (gray_width as usize, gray_height as usize);
    // Checked before use: `iw`/`ih`/`gw`/`gh`/the feature counts are caller-supplied (ultimately an untrusted
    // decoded frame's own declared dimensions), and each gets multiplied below to size a `slice()` call —
    // release builds have `overflow-checks = false` (rust/Cargo.toml), so an unchecked product could silently
    // wrap to a small length, which `slice()` would accept, while this function keeps indexing with the
    // original (un-wrapped) iw/ih/gw/gh — walking past that too-small slice into a wasm trap, not the negative
    // status abi/mod.rs promises. Needs roughly 2^30+ pixels to reach on a 32-bit wasm usize.
    let (
        Some(frame_pixels),
        Some(gray_pixels),
        Some(previous_feature_bytes_len),
        Some(own_feature_bytes_len),
    ) = (
        iw.checked_mul(ih),
        gw.checked_mul(gh),
        (previous_feature_count as usize).checked_mul(FEATURE_BYTES),
        (own_feature_count as usize).checked_mul(FEATURE_BYTES),
    )
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(frame_bytes) = frame_pixels.checked_mul(4) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: every buffer is adapter-owned; every length is bounds checked before the slice is trusted.
    let (
        Some(previous_bytes),
        Some(current_bytes),
        Some(previous_gray_bytes),
        Some(g_bytes),
        Some(previous_feature_bytes),
        Some(own_feature_bytes),
        Some(dst),
    ) = (
        unsafe { slice(previous, frame_bytes) },
        unsafe { slice(current, frame_bytes) },
        unsafe { slice(previous_gray, gray_pixels) },
        unsafe { slice(g, gray_pixels) },
        unsafe { slice(previous_features, previous_feature_bytes_len) },
        unsafe { slice(own_features, own_feature_bytes_len) },
        unsafe { slice_mut(out, TRACK_ODOMETRY_OUT_BYTES) },
    )
    else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: `roi`/`rect` each point at one 32-byte rect (never optional for this call).
    let (Some(roi_bytes), Some(rect_bytes)) =
        (unsafe { slice(roi, 32) }, unsafe { slice(rect, 32) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let region_defs = if region == 0 {
        None
    } else {
        // SAFETY: one `VOTING_REGION_BYTES` region descriptor, bounds checked by `read_voting_regions`.
        match unsafe { read_voting_regions(region, 1) } {
            Some(defs) => Some(defs),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let mask = if labels == 0 {
        None
    } else {
        // SAFETY: label plane covers the native frame. `frame_pixels` is the already-overflow-checked iw*ih.
        match unsafe { slice(labels, frame_pixels) } {
            Some(l) => Some((l, code as u8)),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let previous_features = read_features(previous_feature_bytes);
    let own_features = read_features(own_feature_bytes);
    let result = track::odometry(track::OdometryInputs {
        f,
        radius: radius as i32,
        mask,
        roi: read_rect(roi_bytes),
        rect: read_rect(rect_bytes),
        region: region_defs.as_ref().map(|defs| &defs[0]),
        image_width: iw as f64,
        image_height: ih as f64,
        previous: previous_bytes,
        current: current_bytes,
        previous_gray: Gray {
            width: gw,
            height: gh,
            data: previous_gray_bytes,
        },
        g: Gray {
            width: gw,
            height: gh,
            data: g_bytes,
        },
        velocity: (vx, vy),
        previous_features: &previous_features,
        own_features: &own_features,
        confidence,
    });
    dst[0..8].copy_from_slice(&result.delta.0.to_le_bytes());
    dst[8..16].copy_from_slice(&result.delta.1.to_le_bytes());
    dst[16..24].copy_from_slice(&result.confidence.to_le_bytes());
    dst[24..28].copy_from_slice(&(result.ambiguous as u32).to_le_bytes());
    dst[28..32].copy_from_slice(&(result.weak_step as u32).to_le_bytes());
    dst[32..40].copy_from_slice(&result.step_error.to_le_bytes());
    match &result.content_change {
        Some(c) => {
            dst[40..44].copy_from_slice(&1u32.to_le_bytes());
            dst[44..48].fill(0);
            dst[48..56].copy_from_slice(&c.agreement.to_le_bytes());
            dst[56..60].copy_from_slice(&c.blocks.to_le_bytes());
            dst[60..64].fill(0);
        }
        None => dst[40..64].fill(0),
    }
    match result.decision {
        track::OdometryDecision::Tracked => 0,
        track::OdometryDecision::Static => 1,
        track::OdometryDecision::Lost => 2,
    }
}
