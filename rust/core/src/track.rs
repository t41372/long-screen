//! Per-region, per-frame tracking decisions (R4b phase 3a): the *stateless* verdicts of
//! `src/pipeline/solve/track.ts`, byte-for-byte ports of the frozen oracle in
//! `tests/support/reference/track.ts`. Every function here is pure: plain scalars/tuples in, a plain
//! result out, no I/O, no state carried between calls (the stateful per-region tracker — previous
//! features, velocity, anchor patches — is phase 3b).
//!
//! `js_hypot` (not `f64::hypot`) is used everywhere the TS original used `Math.hypot`: V8's hypot and
//! libm's hypot round differently in the last bit for some inputs (see `crate::geometry::js_hypot`).

use crate::geometry::js_hypot;
use crate::motion::{detect_scale, MatchPoints};

/// `track.ts::uncertainty`.
pub fn uncertainty(confidence: f64, ambiguous: bool, weak_step: bool) -> bool {
    confidence < 0.60 || ambiguous || weak_step
}

/// The historical-match half of `track.ts::relocalizeVerdict`'s input (`match` there); `None` mirrors
/// the original's `match === undefined`.
pub struct MatchInfo {
    pub ambiguous: bool,
    pub confidence: f64,
}

/// `track.ts::relocalizeVerdict`.
pub fn relocalize_verdict(m: Option<MatchInfo>, zoom_change: bool) -> bool {
    match m {
        Some(m) => !m.ambiguous && m.confidence > 0.6 && !zoom_change,
        None => false,
    }
}

/// The three branches `track.ts::fragmentCause` chooses between: the trivial "gate" (R4b's "pure
/// part"). `ZoomChange` means the caller returns `{ scale: fieldZoom, error: 0 }` directly;
/// `ProbeScale` means the caller runs the existing `probeScale` kernel; `None` means "no cause"
/// (`undefined`).
#[derive(PartialEq, Eq, Debug)]
pub enum FragmentCauseGate {
    ZoomChange,
    ProbeScale,
    None,
}

/// `track.ts::fragmentCause`'s branch selection (checked in the same order: zoom change first).
pub fn fragment_cause_gate(
    zoom_change: bool,
    has_previous_gray: bool,
    blind: bool,
) -> FragmentCauseGate {
    if zoom_change {
        FragmentCauseGate::ZoomChange
    } else if has_previous_gray && !blind {
        FragmentCauseGate::ProbeScale
    } else {
        FragmentCauseGate::None
    }
}

/// `track.ts::occlusionEligible`. `decision` is the odometry/gate outcome tag shared with the ABI
/// layer: 0 = tracked, 1 = static, 2 = blind, 3 = lost (only tracked/static are eligible).
pub fn occlusion_eligible(has_previous: bool, kind_moving: bool, decision: u8) -> bool {
    has_previous && kind_moving && (decision == 0 || decision == 1)
}

/// `track.ts::targetPose`.
pub fn target_pose(keyframe: (f64, f64), offset: (f64, f64), shift: (f64, f64)) -> (f64, f64) {
    (
        keyframe.0 + offset.0 + shift.0,
        keyframe.1 + offset.1 + shift.1,
    )
}

/// The `global` revisit match `track.ts::attachVerdict` takes.
pub struct GlobalMatch {
    pub keyframe: (f64, f64),
    pub offset: (f64, f64),
    pub ambiguous: bool,
    pub confidence: f64,
}

/// `track.ts::attachVerdict`. `resolved_target_eq_canvas` is the caller's `resolvedTarget ===
/// canvasId` (string comparison stays in TS); the returned pose still needs pairing with
/// `resolvedTarget` by the caller, which is why this returns only the pose, not the target string.
pub fn attach_verdict(
    global: Option<GlobalMatch>,
    resolved_target_eq_canvas: bool,
    shift: (f64, f64),
) -> Option<(f64, f64)> {
    let g = global?;
    if resolved_target_eq_canvas || g.ambiguous || !(g.confidence > 0.72) {
        return None;
    }
    Some(target_pose(g.keyframe, g.offset, shift))
}

/// `track.ts::odometryWeight`.
pub fn odometry_weight(weak_step: bool) -> f64 {
    if weak_step {
        0.05
    } else {
        1.0
    }
}

/// `track.ts::thinOverlapEligible`.
pub fn thin_overlap_eligible(
    weak_step: bool,
    weak: bool,
    ambiguous: bool,
    confidence: f64,
    error: f64,
) -> bool {
    (weak_step || weak) && !ambiguous && confidence > 0.72 && error < 8.0
}

/// `track.ts::thinOverlapCorrection`. Returns `(target, discrepancy)`.
pub fn thin_overlap_correction(
    canonical_keyframe: (f64, f64),
    offset: (f64, f64),
    pose: (f64, f64),
) -> Option<((f64, f64), f64)> {
    let target = (
        canonical_keyframe.0 + offset.0,
        canonical_keyframe.1 + offset.1,
    );
    let discrepancy = js_hypot(target.0 - pose.0, target.1 - pose.1);
    if discrepancy >= 16.0 {
        Some((target, discrepancy))
    } else {
        None
    }
}

/// `track.ts::LoopVerdict`, in the ABI tag order (0..3) `abi/track.rs` returns.
#[derive(PartialEq, Eq, Debug)]
pub enum LoopVerdict {
    Closure,
    Inconsistent,
    Ambiguous,
    None,
}

/// `track.ts::loopClosureVerdict`. Computes the discrepancy itself, like the TS original.
pub fn loop_closure_verdict(
    global_keyframe: (f64, f64),
    global_offset: (f64, f64),
    global_ambiguous: bool,
    global_confidence: f64,
    shift: (f64, f64),
    pose: (f64, f64),
) -> (LoopVerdict, f64) {
    let discrepancy = js_hypot(
        global_keyframe.0 + shift.0 + global_offset.0 - pose.0,
        global_keyframe.1 + shift.1 + global_offset.1 - pose.1,
    );
    if !global_ambiguous && global_confidence > 0.72 && discrepancy < 16.0 {
        (LoopVerdict::Closure, discrepancy)
    } else if discrepancy >= 16.0 {
        (LoopVerdict::Inconsistent, discrepancy)
    } else if global_ambiguous {
        (LoopVerdict::Ambiguous, discrepancy)
    } else {
        (LoopVerdict::None, discrepancy)
    }
}

/// `track.ts::needsKeyframe`. `last_node_frame: None` mirrors the original's `lastNodeFrame ===
/// undefined` ("no node exists yet"); `anchor: None` mirrors `anchor` undefined (→ `Infinity`
/// distance) exactly like the TS ternary did on `anchor ? ... : Infinity`.
/// `f64::max`/`f64::min` (not `Math.max`/`Math.min`) are used for the rect-dimension floor: Rust's
/// versions return the non-NaN operand where JS's propagate NaN, but `rect.width`/`rect.height` are
/// always finite region dimensions here, so the two never observably diverge for this call.
#[allow(clippy::too_many_arguments)]
pub fn needs_keyframe(
    kind_moving: bool,
    anchor: Option<(f64, f64)>,
    pose: (f64, f64),
    last_node_frame: Option<i32>,
    rect: (f64, f64),
    frame_index: i32,
    field_difference: f64,
) -> bool {
    let Some(last_node_frame) = last_node_frame else {
        return true;
    };
    if !kind_moving {
        return false;
    }
    let anchor_distance = match anchor {
        Some(a) => js_hypot(pose.0 - a.0, pose.1 - a.1),
        None => f64::INFINITY,
    };
    let frames_since_last_node = (frame_index - last_node_frame) as f64;
    anchor_distance > f64::max(48.0, f64::min(rect.0, rect.1) * 0.30)
        || (frames_since_last_node > 90.0 && field_difference > 0.2)
}

/// `track.ts::zoomChanged`.
pub fn zoom_changed(region_zoom: Option<f64>, field_zoom: f64) -> bool {
    match region_zoom {
        Some(rz) => (rz - 1.0).abs() > 0.04,
        None => (field_zoom - 1.0).abs() > 0.04,
    }
}

/// `track.ts::regionZoom`: the eligibility gate (`kind === 'moving' && ... >= 8`) fused with the
/// existing `detect_scale` kernel it conditionally calls, so the ABI layer makes one call instead of
/// counting uniques in TS first. `detect_scale` is unchanged (R4b: "detectScale is already Rust").
pub fn region_zoom(kind_moving: bool, matches: &[MatchPoints]) -> Option<f64> {
    if !kind_moving {
        return None;
    }
    let unique_count = matches.iter().filter(|m| m.unique).count();
    if unique_count >= 8 {
        Some(detect_scale(matches))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncertainty_thresholds() {
        assert!(uncertainty(0.5999999999999999, false, false));
        assert!(!uncertainty(0.6, false, false));
        assert!(uncertainty(0.9, true, false));
        assert!(uncertainty(0.9, false, true));
    }

    #[test]
    fn needs_keyframe_no_prior_node_always_true() {
        assert!(needs_keyframe(
            true,
            None,
            (0.0, 0.0),
            None,
            (100.0, 100.0),
            5,
            0.0
        ));
        assert!(needs_keyframe(
            false,
            None,
            (0.0, 0.0),
            None,
            (100.0, 100.0),
            5,
            0.0
        ));
    }

    #[test]
    fn needs_keyframe_fixed_kind_never_after_first_node() {
        assert!(!needs_keyframe(
            false,
            Some((0.0, 0.0)),
            (1000.0, 1000.0),
            Some(0),
            (100.0, 100.0),
            500,
            1.0
        ));
    }

    #[test]
    fn needs_keyframe_anchor_distance_threshold() {
        // rect min*0.3 = 30 < 48, so the floor of 48 applies.
        assert!(!needs_keyframe(
            true,
            Some((0.0, 0.0)),
            (48.0, 0.0),
            Some(0),
            (100.0, 100.0),
            1,
            0.0
        ));
        assert!(needs_keyframe(
            true,
            Some((0.0, 0.0)),
            (48.0001, 0.0),
            Some(0),
            (100.0, 100.0),
            1,
            0.0
        ));
    }

    #[test]
    fn loop_closure_verdict_branches() {
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.9, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::Closure);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.9, (0.0, 0.0), (20.0, 0.0));
        assert_eq!(v, LoopVerdict::Inconsistent);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), true, 0.9, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::Ambiguous);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.5, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::None);
    }

    #[test]
    fn region_zoom_gate() {
        assert!(region_zoom(false, &[]).is_none());
        let few: Vec<MatchPoints> = (0..7)
            .map(|i| MatchPoints {
                ax: i as f64,
                ay: 0.0,
                bx: i as f64,
                by: 0.0,
                unique: true,
            })
            .collect();
        assert!(region_zoom(true, &few).is_none());
        let enough: Vec<MatchPoints> = (0..8)
            .map(|i| MatchPoints {
                ax: i as f64,
                ay: 0.0,
                bx: i as f64 + 1.0,
                by: 0.0,
                unique: true,
            })
            .collect();
        assert!(region_zoom(true, &enough).is_some());
    }
}
