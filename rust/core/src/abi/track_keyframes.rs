//! `ls_keyframes_evaluate_candidates`: `extern "C"` surface for `crate::track::evaluate_candidates_audit` /
//! `evaluate_candidates_refine` (R4d step 4) — split from the former monolithic `abi/track.rs` (R6-B,
//! final-verify-report.md item 10). See `abi/track.rs`'s module doc comment for the split; `read_patches` and
//! `resolve_native` stay there (shared with `track_reacquire`).

use crate::abi::features::read_features;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::track::{read_patches, resolve_native};
use crate::abi::wire::{read_rect, FEATURE_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::features::Feature;
use crate::motion::{Gray, Patch};
use crate::track;

/// `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor (this module's own wire format, 32 bytes): u32
/// featuresPtr, featureCount, patchesPtr, patchCount, grayPtr, grayWidth, grayHeight, padding.
const KEYFRAME_BYTES: usize = 32;

/// One keyframe's owned/borrowed pieces, read from the wire (features owned — `read_features` allocates; gray
/// and patches borrow adapter memory).
type CandidateRaw<'a> = (Vec<Feature>, Vec<Patch<'a>>, Gray<'a>);

/// # Safety
/// `ptr` points at `count × KEYFRAME_BYTES` descriptors (this module's wire format, doc'd at
/// `ls_keyframes_evaluate_candidates`); each descriptor's `featuresPtr`/`patchesPtr`/`grayPtr` must cover the
/// byte ranges its counts/dimensions imply (patches per `read_patches`'s own contract).
unsafe fn read_candidate_keyframes<'a>(ptr: u32, count: u32) -> Option<Vec<CandidateRaw<'a>>> {
    let bytes = slice(ptr, count as usize * KEYFRAME_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(KEYFRAME_BYTES) {
        let features_ptr = u32::from_le_bytes(c[0..4].try_into().unwrap());
        let feature_count = u32::from_le_bytes(c[4..8].try_into().unwrap());
        let patches_ptr = u32::from_le_bytes(c[8..12].try_into().unwrap());
        let patch_count = u32::from_le_bytes(c[12..16].try_into().unwrap());
        let gray_ptr = u32::from_le_bytes(c[16..20].try_into().unwrap());
        let gray_width = u32::from_le_bytes(c[20..24].try_into().unwrap());
        let gray_height = u32::from_le_bytes(c[24..28].try_into().unwrap());
        let feature_bytes = slice(features_ptr, feature_count as usize * FEATURE_BYTES)?;
        let features = read_features(feature_bytes);
        let patches = read_patches(patches_ptr, patch_count)?;
        let gray_data = slice(gray_ptr, gray_width as usize * gray_height as usize)?;
        out.push((
            features,
            patches,
            Gray {
                width: gray_width as usize,
                height: gray_height as usize,
                data: gray_data,
            },
        ));
    }
    Some(out)
}

/// `ls_keyframes_evaluate_candidates`'s `out` header (8 bytes): u32 filledNative, u32 padding — only meaningful
/// when the return value is > 0 (a `0` return never touches native, see this export's doc comment).
const CANDIDATE_HEADER_BYTES: usize = 8;
/// One returned candidate record (48 bytes), following the header: u32 keyframeIndex, i32 x, i32 y, u32
/// support, u32 unique, u32 ambiguous, u32 strong, u32 padding, f64 error, f64 analysisError.
const CANDIDATE_RECORD_BYTES: usize = 48;

/// R4d step 4: `keyframes.ts::evaluateCandidates` fused into one call — the audit phase (match + hypotheses +
/// the analysis-scale audit, no native luma; `crate::track::evaluate_candidates_audit`) over every keyframe,
/// THEN, only if at least one candidate passed the audit, the lazy native-plane fill (`resolve_native`, shared
/// with `ls_track_reacquire`/`ls_track_drift_correction`) and native-patch refinement
/// (`crate::track::evaluate_candidates_refine`). Returns the audited-and-refined candidate list, NOT the final
/// pick — `keyframes.ts` finishes the `Math.exp` confidence formula and the sort/best/rival selection in TS
/// (see `crate::track::RefinedCandidate`'s doc comment for why). `out` must have room for a
/// `CANDIDATE_HEADER_BYTES`-byte header plus `keyframe_count × 8` records (the same `models.slice(0, 8)` cap
/// `evaluate_candidates_audit` applies per keyframe). Returns the candidate count (`0` means "no candidate
/// passed the audit"; native luma was never touched) or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_keyframes_evaluate_candidates(
    keyframes: u32,
    keyframe_count: u32,
    features: u32,
    feature_count: u32,
    gray: u32,
    gray_width: u32,
    gray_height: u32,
    roi: u32,
    region: u32,
    factor: f64,
    radius: u32,
    native_mode: u32,
    native_ptr: u32,
    current_frame_ptr: u32,
    already_filled: u32,
    native_width: u32,
    native_height: u32,
    out: u32,
) -> i32 {
    let (gw, gh) = (gray_width as usize, gray_height as usize);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(feature_bytes), Some(gray_bytes), Some(roi_bytes), Some(region_bytes)) = (
        unsafe { slice(features, feature_count as usize * FEATURE_BYTES) },
        unsafe { slice(gray, gw * gh) },
        unsafe { slice(roi, 32) },
        unsafe { slice(region, 32) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: this module's own wire format (KEYFRAME_BYTES), bounds checked inside.
    let Some(raw_keyframes) = (unsafe { read_candidate_keyframes(keyframes, keyframe_count) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let query_features = read_features(feature_bytes);
    let query_gray = Gray {
        width: gw,
        height: gh,
        data: gray_bytes,
    };
    let candidate_keyframes: Vec<track::CandidateKeyframe> = raw_keyframes
        .iter()
        .map(|(features, patches, gray)| track::CandidateKeyframe {
            features,
            gray: *gray,
            patches,
        })
        .collect();
    let audited = track::evaluate_candidates_audit(
        &candidate_keyframes,
        &query_features,
        query_gray,
        read_rect(roi_bytes),
        factor,
    );
    if audited.is_empty() {
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
    let refined = track::evaluate_candidates_refine(
        &audited,
        &candidate_keyframes,
        native,
        read_rect(region_bytes),
        radius as i32,
    );
    // SAFETY: caller sized `out` for the header plus `keyframe_count × 8` records (this export's doc comment).
    let Some(dst) = (unsafe {
        slice_mut(
            out,
            CANDIDATE_HEADER_BYTES + refined.len() * CANDIDATE_RECORD_BYTES,
        )
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&(filled_now as u32).to_le_bytes());
    dst[4..8].fill(0);
    for (r, d) in refined
        .iter()
        .zip(dst[CANDIDATE_HEADER_BYTES..].chunks_exact_mut(CANDIDATE_RECORD_BYTES))
    {
        d[0..4].copy_from_slice(&(r.keyframe_index as u32).to_le_bytes());
        d[4..8].copy_from_slice(&r.x.to_le_bytes());
        d[8..12].copy_from_slice(&r.y.to_le_bytes());
        d[12..16].copy_from_slice(&r.support.to_le_bytes());
        d[16..20].copy_from_slice(&r.unique.to_le_bytes());
        d[20..24].copy_from_slice(&(r.ambiguous as u32).to_le_bytes());
        d[24..28].copy_from_slice(&(r.strong as u32).to_le_bytes());
        d[28..32].fill(0);
        d[32..40].copy_from_slice(&r.error.to_le_bytes());
        d[40..48].copy_from_slice(&r.analysis_error.to_le_bytes());
    }
    refined.len() as i32
}
