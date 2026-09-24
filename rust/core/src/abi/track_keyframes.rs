//! `ls_keyframes_evaluate_candidates`: `extern "C"` surface for `crate::track::evaluate_candidates_audit` /
//! `evaluate_candidates_refine` — split out of the former monolithic `abi/track.rs`. See `abi/track.rs`'s
//! module doc comment for the split; `read_patches` and `resolve_native` stay there (shared with
//! `track_reacquire`).

use crate::abi::features::read_features;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::track::{read_patches, resolve_native};
use crate::abi::wire::{read_rect, FEATURE_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::features::Feature;
use crate::motion::{Gray, Patch};
use crate::track;

/// `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor (this module's own wire format, 64 bytes): u32
/// featuresPtr, featureCount, patchesPtr, patchCount, grayPtr, grayWidth, grayHeight, canonicalIdx, f64 x, f64
/// y, f64 dx, f64 dy. `canonicalIdx`/`dx`/`dy` are the caller's `canonical` map already resolved and interned
/// per keyframe (see `track::CandidateKeyframe`'s doc comment) — a keyframe with no attachment carries its own
/// interned canvas index and `dx = dy = 0`.
pub(crate) const KEYFRAME_BYTES: usize = 64;

/// One keyframe's owned/borrowed pieces, read from the wire (features owned — `read_features` allocates; gray
/// and patches borrow adapter memory).
type CandidateRaw<'a> = (
    Vec<Feature>,
    Vec<Patch<'a>>,
    Gray<'a>,
    u32,
    f64,
    f64,
    f64,
    f64,
);

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
        let canonical_idx = u32::from_le_bytes(c[28..32].try_into().unwrap());
        let x = f64::from_le_bytes(c[32..40].try_into().unwrap());
        let y = f64::from_le_bytes(c[40..48].try_into().unwrap());
        let dx = f64::from_le_bytes(c[48..56].try_into().unwrap());
        let dy = f64::from_le_bytes(c[56..64].try_into().unwrap());
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
            canonical_idx,
            x,
            y,
            dx,
            dy,
        ));
    }
    Some(out)
}

/// `ls_keyframes_evaluate_candidates`'s `out` header (8 bytes): u32 filledNative, u32 padding. `filledNative` is
/// meaningful on BOTH `0` and `1` returns — the audit-empty case is the only one where it is always `false` (see
/// this export's doc comment); a `0` after refinement ran (no strong candidate) can still have filled native luma.
const CANDIDATE_HEADER_BYTES: usize = 8;
/// The single chosen candidate record (56 bytes), following the header: u32 keyframeIndex, i32 x, i32 y, u32
/// support, u32 unique, u32 ambiguous, u32 padding, f64 error, f64 analysisError, f64 confidence.
pub(crate) const CANDIDATE_RECORD_BYTES: usize = 56;

/// `keyframes.ts::evaluateCandidates` fused into one call, end to end: the audit phase (match + hypotheses +
/// the analysis-scale audit, no native luma; `crate::track::evaluate_candidates_audit`) over every keyframe,
/// THEN, only if at least one candidate passed the audit, the lazy native-plane fill (`resolve_native`, shared
/// with `ls_track_reacquire`/`ls_track_drift_correction`), native-patch refinement
/// (`crate::track::evaluate_candidates_refine`), and the confidence/score/sort/strong-best/rival-ambiguity
/// selection (`crate::track::select_candidate`) that picks the one candidate to return. `out` must have room
/// for `CANDIDATE_HEADER_BYTES + CANDIDATE_RECORD_BYTES` bytes. Returns `1` (a candidate was chosen — `out`
/// holds it), `0` (no candidate passed the audit, or none of the audited-and-refined candidates was strong
/// enough to choose; native luma was touched in the second case but not the first — see `filledNative`), or
/// `STATUS_BAD_ARGUMENT`.
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
        .map(
            |(features, patches, gray, canonical_idx, x, y, dx, dy)| track::CandidateKeyframe {
                features,
                gray: *gray,
                patches,
                x: *x,
                y: *y,
                canonical_idx: *canonical_idx,
                dx: *dx,
                dy: *dy,
            },
        )
        .collect();
    // SAFETY: caller sized `out` for the header plus one record (this export's doc comment). Sliced and zeroed
    // up front so the header is always initialised (`filledNative = false`) before any early return, including
    // the "no candidate passed the audit; native never touched" one below.
    let Some(dst) = (unsafe { slice_mut(out, CANDIDATE_HEADER_BYTES + CANDIDATE_RECORD_BYTES) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.fill(0);
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
    dst[0..4].copy_from_slice(&(filled_now as u32).to_le_bytes());
    let Some(chosen) = track::select_candidate(&refined, &candidate_keyframes) else {
        return 0;
    };
    let d = &mut dst[CANDIDATE_HEADER_BYTES..];
    d[0..4].copy_from_slice(&(chosen.keyframe_index as u32).to_le_bytes());
    d[4..8].copy_from_slice(&chosen.x.to_le_bytes());
    d[8..12].copy_from_slice(&chosen.y.to_le_bytes());
    d[12..16].copy_from_slice(&chosen.support.to_le_bytes());
    d[16..20].copy_from_slice(&chosen.unique.to_le_bytes());
    d[20..24].copy_from_slice(&(chosen.ambiguous as u32).to_le_bytes());
    d[32..40].copy_from_slice(&chosen.error.to_le_bytes());
    d[40..48].copy_from_slice(&chosen.analysis_error.to_le_bytes());
    d[48..56].copy_from_slice(&chosen.confidence.to_le_bytes());
    1
}
