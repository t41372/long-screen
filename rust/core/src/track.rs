//! Per-region, per-frame tracking decisions (R4b phase 3a): the *stateless* verdicts of
//! `src/pipeline/solve/track.ts`, byte-for-byte ports of the frozen oracle in
//! `tests/support/reference/track.ts`. Every function here is pure: plain scalars/tuples in, a plain
//! result out, no I/O, no state carried between calls (the stateful per-region tracker — previous
//! features, velocity, anchor patches — is phase 3b).
//!
//! `js_hypot` (not `f64::hypot`) is used everywhere the TS original used `Math.hypot`: V8's hypot and
//! libm's hypot round differently in the last bit for some inputs (see `crate::geometry::js_hypot`).

use crate::features::{match_features, Feature};
use crate::geometry::{js_ceil, js_hypot, Rect};
use crate::motion::{
    audit_translation, detect_scale, refine_native, refine_patches, translation_hypotheses, Gray,
    MatchPoints, Motion, Patch, Point,
};
use crate::region::Region;

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
    // `!(g.confidence > 0.72)`, spelled via `partial_cmp` to satisfy `clippy::neg_cmp_op_on_partial_ord` WITHOUT
    // changing the truth table: `Some(Greater)` is the only value the negation excludes, so a NaN confidence
    // (`partial_cmp` gives `None`) still takes this branch, exactly as `!(NaN > 0.72)` (`NaN > x` is always
    // `false` in IEEE 754) evaluates to `true` in the TS original.
    if resolved_target_eq_canvas
        || g.ambiguous
        || g.confidence.partial_cmp(&0.72) != Some(std::cmp::Ordering::Greater)
    {
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

/// `track.ts::odometry`'s decision: `Tracked` carries a real displacement, `Static`/`Lost` share the
/// difference-sampling fallback (the TS original's `decision === 'lost' ? 'lost' : 'static'` split).
#[derive(PartialEq, Eq, Debug)]
pub enum OdometryDecision {
    Tracked,
    Static,
    Lost,
}

/// `track.ts::OdometryEstimate`'s `contentChange` (`undefined` when the audit's blocks all agreed).
pub struct ContentChange {
    pub agreement: f64,
    pub blocks: u32,
}

pub struct OdometryEstimate {
    pub decision: OdometryDecision,
    pub delta: (f64, f64),
    /// On `Tracked`: the raw hypothesis confidence (`best.m.confidence`), NOT the TS original's fully computed
    /// step confidence — `src/core/wasm/track.ts` finishes `Math.max(.05, …) * Math.exp(-stepError / 20) * …`
    /// so that multiply runs on the host's own `Math.exp`, bit-exact with the pre-refactor engine (see the
    /// comment at this field's one call site below). On `Static`/`Lost`: the input `confidence`, unchanged.
    pub confidence: f64,
    pub ambiguous: bool,
    pub weak_step: bool,
    /// `f64::INFINITY` on the `Static`/`Lost` branches, exactly like the TS original's `stepError`.
    pub step_error: f64,
    pub content_change: Option<ContentChange>,
}

/// One region's odometry inputs, fused into a single call (R4c 3b-i): `matchFeatures` +
/// `translationHypotheses` + the audit filter/sort + up to 6 native refinements with the velocity prior +
/// rival detection + confidence, and — only on the fallback path — the static/lost difference sampling.
/// `previous`/`current` are full native RGBA frames (`width × height × 4`); `region` is only read on the
/// fallback path (`track.ts::odometry`'s `regionContains` loop) and may be omitted when the caller knows
/// the fast path always succeeds in practice — omitting it on a frame that actually needs it just treats
/// every sample as "contained", matching `regionContains`'s own `!region.mask` shortcut.
pub struct OdometryInputs<'a> {
    pub f: f64,
    pub radius: i32,
    pub mask: Option<(&'a [u8], u8)>,
    pub roi: Rect,
    pub rect: Rect,
    pub region: Option<&'a Region>,
    pub image_width: f64,
    pub image_height: f64,
    pub previous: &'a [u8],
    pub current: &'a [u8],
    pub previous_gray: Gray<'a>,
    pub g: Gray<'a>,
    pub velocity: (f64, f64),
    pub previous_features: &'a [Feature],
    pub own_features: &'a [Feature],
    /// Carried in from before this call; returned unchanged on the `Static`/`Lost` branches, exactly as the
    /// TS original left the outer `confidence` local untouched there.
    pub confidence: f64,
}

/// `track.ts::odometry`.
pub fn odometry(inputs: OdometryInputs) -> OdometryEstimate {
    let OdometryInputs {
        f,
        radius,
        mask,
        roi,
        rect,
        region,
        image_width,
        image_height,
        previous,
        current,
        previous_gray,
        g,
        velocity,
        previous_features,
        own_features,
        confidence,
    } = inputs;

    let raw_matches = match_features(previous_features, own_features, true);
    let match_points: Vec<MatchPoints> = raw_matches
        .iter()
        .map(|m| {
            let a = &previous_features[m.a as usize];
            let b = &own_features[m.b as usize];
            MatchPoints {
                ax: a.x as f64,
                ay: a.y as f64,
                bx: b.x as f64,
                by: b.y as f64,
                unique: m.unique,
            }
        })
        .collect();

    let models: Vec<_> = translation_hypotheses(&match_points, 16)
        .into_iter()
        .filter(|m| m.support >= 4)
        .collect();
    // Period-aliased hypotheses on repeated content audit equally well; the constant-velocity prior orders
    // them before the native decision so the true small step is never dropped in favour of a one-row-off
    // alias with more (arbitrary) matches.
    let prior = |mx: f64, my: f64| 0.02 * js_hypot(mx * f - velocity.0, my * f - velocity.1);
    let mut scored: Vec<_> = models
        .into_iter()
        .map(|m| {
            let audit = audit_translation(previous_gray, g, m.x, m.y, Some(roi), f > 1.0);
            (m, audit)
        })
        .filter(|(_, audit)| {
            audit.overlap > 0.10
                && audit.error.is_finite()
                && ((audit.error < 14.0 && audit.mismatch < 0.2)
                    || (audit.agreement >= 0.4
                        && audit.agreeing >= 3
                        && audit.agreeing_error < 8.0))
        })
        .collect();
    // Matches the TS original's exact left-to-right evaluation of
    // `Math.min(a.error, a.agreeingError) + prior(a.m) - Math.min(b.error, b.agreeingError) - prior(b.m)`:
    // two chained subtractions, not `(ka) - (kb)` — floating point subtraction is not associative, so grouping
    // them differently can flip the sign in a near-tie and reorder the cut this comparator feeds into
    // `refined`'s `.take(6)`.
    scored.sort_by(|(am, aa), (bm, ba)| {
        let d = aa.error.min(aa.agreeing_error) + prior(am.x, am.y)
            - ba.error.min(ba.agreeing_error)
            - prior(bm.x, bm.y);
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut refined: Vec<_> = scored
        .into_iter()
        .take(6)
        .map(|(m, audit)| {
            let n = refine_native(
                previous,
                current,
                image_width as usize,
                image_height as usize,
                Point {
                    x: m.x * f,
                    y: m.y * f,
                },
                rect,
                mask,
                radius,
            );
            let key = n.error + 0.02 * js_hypot(n.x as f64 - velocity.0, n.y as f64 - velocity.1);
            (m, audit, n, key)
        })
        .filter(|(_, _, n, _)| n.error.is_finite())
        .collect();
    refined.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal));

    if let Some(best_index) = (!refined.is_empty()).then_some(0usize) {
        let (best_m, best_audit, best_n, _) = &refined[best_index];
        if best_n.error < 14.0 {
            let delta = (best_n.x as f64, best_n.y as f64);
            let rival = refined.iter().enumerate().find(|(i, (_, _, n, _))| {
                *i != best_index
                    && js_hypot(n.x as f64 - best_n.x as f64, n.y as f64 - best_n.y as f64) > 2.0
                    && n.error < best_n.error + 2.0
            });
            let ambiguous = rival.is_some() || (best_m.ambiguous && refined.len() > 1);
            // A fast jump leaves a thin strip of shared content. Periodic layouts align just as well one
            // period away, so such a step is a best guess to be re-examined by revisit evidence, not a
            // settled fact.
            let weak_step = best_audit.overlap < 0.25;
            let step_error = best_n.error;
            let content_change = if best_audit.agreement < 0.85 && best_audit.blocks >= 4 {
                Some(ContentChange {
                    agreement: best_audit.agreement,
                    blocks: best_audit.blocks,
                })
            } else {
                None
            };
            // `confidence` here is the raw hypothesis confidence (`best.m.confidence`), NOT the TS original's
            // `Math.max(.05, best.m.confidence) * Math.exp(-best.n.error / 20) * ...` — that last multiply
            // stays in `src/core/wasm/track.ts` so it runs on the SAME `Math.exp` the differential harness's
            // pre-refactor engine uses (V8's, not Rust libm's, which can round the last bit differently for
            // this call's continuous, effectively-arbitrary `stepError` input; unlike the few other `.exp()`
            // call sites in `motion.rs`, whose inputs are small integer ratios that never land on a rounding
            // boundary in practice).
            return OdometryEstimate {
                decision: OdometryDecision::Tracked,
                delta,
                confidence: best_m.confidence,
                ambiguous,
                weak_step,
                step_error,
                content_change,
            };
        }
    }

    let mut difference = 0.0;
    let mut samples = 0u32;
    let mut y = js_ceil(roi.y) as f64;
    while y < roi.y + roi.height {
        let mut x = js_ceil(roi.x) as f64;
        while x < roi.x + roi.width {
            let contained =
                region.is_none_or(|r| r.contains(x * f, y * f, image_width, image_height));
            if contained {
                let (yi, xi) = (y as usize, x as usize);
                difference += (previous_gray.data[yi * g.width + xi] as f64
                    - g.data[yi * g.width + xi] as f64)
                    .abs();
                samples += 1;
            }
            x += 7.0;
        }
        y += 7.0;
    }
    let decision = if difference / (samples.max(1) as f64) > 5.0 {
        OdometryDecision::Lost
    } else {
        OdometryDecision::Static
    };
    OdometryEstimate {
        decision,
        delta: (0.0, 0.0),
        confidence,
        ambiguous: false,
        weak_step: false,
        step_error: f64::INFINITY,
        content_change: None,
    }
}

/// `track.ts::reacquire`'s hypothesis-generation half (R4c 3b-ii): `matchFeatures` + `translationHypotheses`
/// filtered by `support >= 6`, with NO native luma involved. Split out from the native-refinement half
/// (`reacquire_refine`) so the ABI layer can decide whether the resident native luma plane needs filling at
/// all this call — the original TS `native()` thunk was only ever evaluated once `models.slice(0, 4)` actually
/// had a candidate (`reacquire`'s own doc comment); an empty result here means the caller must return "no
/// reacquisition" without touching native luma, exactly like the original's `models.length === 0` path.
pub fn reacquire_hypotheses(anchor_features: &[Feature], own_features: &[Feature]) -> Vec<Motion> {
    let raw_matches = match_features(anchor_features, own_features, true);
    let match_points: Vec<MatchPoints> = raw_matches
        .iter()
        .map(|m| {
            let a = &anchor_features[m.a as usize];
            let b = &own_features[m.b as usize];
            MatchPoints {
                ax: a.x as f64,
                ay: a.y as f64,
                bx: b.x as f64,
                by: b.y as f64,
                unique: m.unique,
            }
        })
        .collect();
    translation_hypotheses(&match_points, 8)
        .into_iter()
        .filter(|m| m.support >= 6)
        .collect()
}

/// `track.ts::reacquire`'s output; `confidence` is the raw hypothesis confidence (`top.m.confidence`), not the
/// TS original's `Math.max(.05, …) * Math.exp(-top.n.error / 20) * (ambiguous ? .6 : 1)` — that multiply stays
/// in `src/core/wasm/track.ts`, on the host's own `Math.exp`, for the same bit-exactness reason as
/// `OdometryEstimate.confidence` (see that struct's doc comment and the WHY comment at its one TS call site).
pub struct ReacquireEstimate {
    pub x: i32,
    pub y: i32,
    pub ambiguous: bool,
    pub confidence: f64,
    pub error: f64,
}

/// `track.ts::reacquire`'s native-refinement half, given the (non-empty) `models` `reacquire_hypotheses`
/// already found and an ALREADY-FILLED native luma plane (the ABI layer's job, once it knows `models` is
/// non-empty — see this module's doc comment). `None` covers both the original's "no candidate refined below
/// the error threshold" and "a rival candidate exists" branches (the original returns `undefined` for both,
/// not just marks the result ambiguous — unlike `odometry`'s rival check).
pub fn reacquire_refine(
    models: &[Motion],
    patches: &[Patch<'_>],
    native: Gray<'_>,
    rect: Rect,
    f: f64,
    radius: i32,
) -> Option<ReacquireEstimate> {
    let mut options: Vec<_> = models
        .iter()
        .take(4)
        .map(|m| {
            let n = refine_patches(
                patches,
                native,
                rect,
                Point {
                    x: m.x * f,
                    y: m.y * f,
                },
                radius,
            );
            (m, n)
        })
        .filter(|(_, n)| n.error < 12.0)
        .collect();
    options.sort_by(|a, b| {
        a.1.error
            .partial_cmp(&b.1.error)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (top_m, top_n) = options.first()?;
    let has_rival = options.iter().skip(1).any(|(_, n)| {
        js_hypot(n.x as f64 - top_n.x as f64, n.y as f64 - top_n.y as f64) > 2.0
            && n.error < top_n.error + 2.0
    });
    if has_rival {
        return None;
    }
    Some(ReacquireEstimate {
        x: top_n.x,
        y: top_n.y,
        ambiguous: top_m.ambiguous,
        confidence: top_m.confidence,
        error: top_n.error,
    })
}

/// `track.ts::driftCorrection`'s output; `error` lets the TS caller finish
/// `Math.max(confidence, .96 * Math.exp(-error / 20))` on the host's own `Math.exp` (same bit-exactness reason
/// as `ReacquireEstimate.confidence`).
pub struct DriftEstimate {
    pub x: f64,
    pub y: f64,
    pub error: f64,
}

/// `track.ts::driftCorrection`. Unlike `reacquire`, there is no gate: the original always evaluates `native()`
/// here, so the ABI layer always fills the native luma plane (if not already filled this frame) before calling
/// this — there is no "skip the fill" branch to preserve.
pub fn drift_correction(
    patches: &[Patch<'_>],
    native: Gray<'_>,
    rect: Rect,
    anchor: (f64, f64),
    pose: (f64, f64),
    radius: i32,
) -> Option<DriftEstimate> {
    let expected = Point {
        x: pose.0 - anchor.0,
        y: pose.1 - anchor.1,
    };
    let n = refine_patches(patches, native, rect, expected, radius);
    if n.error < 12.0 && n.runner_up > n.error + 1.5 {
        Some(DriftEstimate {
            x: anchor.0 + n.x as f64,
            y: anchor.1 + n.y as f64,
            error: n.error,
        })
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
