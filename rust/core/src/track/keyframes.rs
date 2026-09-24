//! Keyframe candidate scoring — split out of the former monolithic `track.rs`.
//! `keyframes.ts::evaluateCandidates` fused end to end: hypothesis matching + analysis-scale audit over every
//! keyframe, native-patch refinement for the audited candidates, the confidence formula, and the
//! score/sort/strong-best/rival-ambiguity selection (`select_candidate`) that picks the one candidate `find()`
//! returns.

use crate::features::{match_features, Feature};
use crate::geometry::{js_hypot, Rect};
use crate::motion::{
    audit_translation, refine_patches, translation_hypotheses, Gray, MatchPoints, Patch, Point,
};

/// One keyframe `evaluate_candidates_audit`/`_refine`/`select_candidate` score a query against — the parts of
/// `keyframes.ts`'s `Keyframe` (features/gray/patches/position) the Rust port needs. `x`/`y` is the keyframe's
/// own native-pixel pose; `canonical_idx`/`dx`/`dy` is the caller's `canonical` map already resolved and interned
/// per keyframe (a keyframe with no attachment resolves to its own canvas, `dx = dy = 0`) — `select_candidate`'s
/// rival check compares candidates by this resolved (canvas index, x, y), never by raw `canvasId`, exactly like
/// `keyframes.ts`'s `position()` closure did.
pub struct CandidateKeyframe<'a> {
    pub features: &'a [Feature],
    pub gray: Gray<'a>,
    pub patches: &'a [Patch<'a>],
    pub x: f64,
    pub y: f64,
    pub canonical_idx: u32,
    pub dx: f64,
    pub dy: f64,
}

/// One (keyframe, hypothesis) pair that passed `keyframes.ts::evaluateCandidates`'s analysis-scale audit —
/// native-pixel work not run yet (see `evaluate_candidates_refine`'s doc comment for why the phases are split).
#[derive(Clone, Copy)]
pub struct AuditedCandidate {
    pub keyframe_index: usize,
    pub guess_x: f64,
    pub guess_y: f64,
    pub support: u32,
    pub unique: u32,
    pub hyp_confidence: f64,
    pub ambiguous: bool,
    pub analysis_error: f64,
}

/// `keyframes.ts::evaluateCandidates`'s match + hypothesis + analysis-scale-audit phase, over every keyframe —
/// no native luma touched here, so the ABI layer can decide whether to fill the (possibly resident) native
/// plane at all based on whether this returns anything ("native refinement only for candidates that
/// pass the audit").
pub fn evaluate_candidates_audit(
    keyframes: &[CandidateKeyframe<'_>],
    features: &[Feature],
    gray: Gray<'_>,
    roi: Rect,
    factor: f64,
) -> Vec<AuditedCandidate> {
    let mut out = Vec::new();
    for (ki, k) in keyframes.iter().enumerate() {
        let raw_matches = match_features(k.features, features, true);
        let match_points: Vec<MatchPoints> = raw_matches
            .iter()
            .map(|m| {
                let a = &k.features[m.a as usize];
                let b = &features[m.b as usize];
                MatchPoints {
                    ax: a.x as f64,
                    ay: a.y as f64,
                    bx: b.x as f64,
                    by: b.y as f64,
                    unique: m.unique,
                }
            })
            .collect();
        let models = translation_hypotheses(&match_points, 16);
        for m in models.iter().take(8) {
            if m.support < 6 {
                continue;
            }
            // Analysis-scale audit tolerates sub-factor misalignment; the decision is made on native pixels.
            let audit = audit_translation(k.gray, gray, m.x, m.y, Some(roi), factor > 1.0);
            if audit.overlap < 0.22
                || !audit.error.is_finite()
                || (audit.mismatch > 0.12 && audit.agreement < 0.5)
            {
                continue;
            }
            out.push(AuditedCandidate {
                keyframe_index: ki,
                guess_x: m.x * factor,
                guess_y: m.y * factor,
                support: m.support,
                unique: m.unique,
                hyp_confidence: m.confidence,
                ambiguous: m.ambiguous,
                analysis_error: audit.error,
            });
        }
    }
    out
}

/// One audited candidate after native-patch refinement; `strong` is already decided here (`keyframes.ts`'s
/// `m.support >= 10 && m.unique >= 6 && m.confidence >= .45`, no `exp` involved).
#[derive(Clone, Copy)]
pub struct RefinedCandidate {
    pub keyframe_index: usize,
    pub x: i32,
    pub y: i32,
    pub support: u32,
    pub unique: u32,
    pub ambiguous: bool,
    pub error: f64,
    pub analysis_error: f64,
    pub strong: bool,
}

/// `keyframes.ts::evaluateCandidates`'s native-refinement phase: called by the ABI layer only once it knows
/// `audited` is non-empty, so the (possibly resident) native luma plane is filled lazily, at most once —
/// exactly like `reacquire`/`driftCorrection` (see `abi::track::resolve_native`).
pub fn evaluate_candidates_refine(
    audited: &[AuditedCandidate],
    keyframes: &[CandidateKeyframe<'_>],
    native: Gray<'_>,
    region: Rect,
    radius: i32,
) -> Vec<RefinedCandidate> {
    let mut out = Vec::new();
    for c in audited {
        let refined = refine_patches(
            keyframes[c.keyframe_index].patches,
            native,
            region,
            Point {
                x: c.guess_x,
                y: c.guess_y,
            },
            radius,
        );
        if !refined.error.is_finite() || refined.error > 12.0 {
            continue;
        }
        out.push(RefinedCandidate {
            keyframe_index: c.keyframe_index,
            x: refined.x,
            y: refined.y,
            support: c.support,
            unique: c.unique,
            ambiguous: c.ambiguous,
            error: refined.error,
            analysis_error: c.analysis_error,
            strong: c.support >= 10 && c.unique >= 6 && c.hyp_confidence >= 0.45,
        });
    }
    out
}

/// `keyframes.ts::evaluateCandidates`'s final pick, after `evaluate_candidates_refine`: the confidence formula, a
/// stable descending sort by score over the finite-scored candidates, the first `strong` candidate in that
/// order, and the rival/ambiguity check against every other candidate's resolved position.
pub struct SelectedCandidate {
    pub keyframe_index: usize,
    pub x: i32,
    pub y: i32,
    pub support: u32,
    pub unique: u32,
    pub ambiguous: bool,
    pub error: f64,
    pub analysis_error: f64,
    /// `min(0.95, 0.45 + 0.5 * (1 - exp(-unique / 7))) * exp(-error / 20)`, using `f64::exp` — see
    /// `odometry.rs`'s `OdometryEstimate.confidence` doc comment for why this no longer needs the host's
    /// `Math.exp` for bit-identity.
    pub confidence: f64,
}

fn candidate_confidence(unique: u32, error: f64) -> f64 {
    (0.45 + 0.5 * (1.0 - (-(unique as f64) / 7.0).exp())).min(0.95) * (-error / 20.0).exp()
}

fn candidate_score(support: u32, unique: u32, confidence: f64) -> f64 {
    (support as f64 * 0.25 + unique as f64) * confidence
}

/// A refined candidate's position in the canvas space rivals are compared in: the keyframe's own pose plus this
/// candidate's offset, translated through the keyframe's already-resolved canonical attachment (identity when
/// the keyframe has none) — `keyframes.ts`'s `position()` closure.
fn candidate_position(
    r: &RefinedCandidate,
    keyframes: &[CandidateKeyframe<'_>],
) -> (u32, f64, f64) {
    let k = &keyframes[r.keyframe_index];
    (
        k.canonical_idx,
        k.x + r.x as f64 + k.dx,
        k.y + r.y as f64 + k.dy,
    )
}

pub fn select_candidate(
    refined: &[RefinedCandidate],
    keyframes: &[CandidateKeyframe<'_>],
) -> Option<SelectedCandidate> {
    struct Scored {
        index: usize,
        score: f64,
        confidence: f64,
    }
    // A non-finite score (confidence or error reaching NaN/±Infinity from a degenerate refinement — unreachable
    // today only because `evaluate_candidates_refine` already drops any non-finite `error`, but this function
    // has no other way to enforce that on its own input) is excluded before sorting rather than folded into the
    // comparator via `partial_cmp().unwrap_or(Equal)`: that fallback is NOT a total order (it can make two
    // otherwise-unequal scores compare "equal" through a NaN third element), and `slice::sort_by`'s total-order
    // check panics on exactly that inconsistency once the slice is long enough to take its merge path — a wasm
    // trap, against this crate's never-trap FFI rule. `Array.prototype.sort` has no such check (a NaN
    // comparator result is simply "no preference" for that one pairwise comparison), which is why the original
    // TS never had this failure mode. A non-finite score can never be a sensible choice anyway, so it is simply
    // never a candidate, never a rival.
    let mut scored: Vec<Scored> = refined
        .iter()
        .enumerate()
        .filter_map(|(index, r)| {
            let confidence = candidate_confidence(r.unique, r.error);
            let score = candidate_score(r.support, r.unique, confidence);
            score.is_finite().then_some(Scored {
                index,
                score,
                confidence,
            })
        })
        .collect();
    // Total order over the remaining (all-finite) scores, so `partial_cmp` never returns `None` — stable, so
    // ties keep the audit's original order, matching `Array.prototype.sort`.
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    let best_at = scored.iter().position(|s| refined[s.index].strong)?;
    let best = &scored[best_at];
    let (best_canvas, best_x, best_y) = candidate_position(&refined[best.index], keyframes);
    // Any other plausible place, weak or strong, that lands somewhere else makes the revisit ambiguous —
    // repeated content looks alike. `.8`/`6` are the measured thresholds this selection has always used: a
    // rival must score within 80% of the best AND either resolve to a different canvas or land more than 6
    // native pixels away to count as a competing explanation.
    let rival = scored.iter().enumerate().any(|(i, s)| {
        i != best_at && {
            let (canvas, x, y) = candidate_position(&refined[s.index], keyframes);
            (canvas != best_canvas || js_hypot(x - best_x, y - best_y) > 6.0)
                && s.score > best.score * 0.8
        }
    });
    let r = &refined[best.index];
    Some(SelectedCandidate {
        keyframe_index: r.keyframe_index,
        x: r.x,
        y: r.y,
        support: r.support,
        unique: r.unique,
        ambiguous: r.ambiguous || rival,
        error: r.error,
        analysis_error: r.analysis_error,
        confidence: best.confidence,
    })
}

#[cfg(test)]
mod select_candidate_tests {
    use super::*;

    /// A keyframe with no features/gray/patches — `select_candidate` never reads them, only
    /// `x`/`y`/`canonical_idx`/`dx`/`dy`.
    fn kf(x: f64, y: f64, canonical_idx: u32) -> CandidateKeyframe<'static> {
        CandidateKeyframe {
            features: &[],
            gray: Gray {
                width: 0,
                height: 0,
                data: &[],
            },
            patches: &[],
            x,
            y,
            canonical_idx,
            dx: 0.0,
            dy: 0.0,
        }
    }
    fn rc(
        keyframe_index: usize,
        support: u32,
        unique: u32,
        error: f64,
        strong: bool,
    ) -> RefinedCandidate {
        RefinedCandidate {
            keyframe_index,
            x: 0,
            y: 0,
            support,
            unique,
            ambiguous: false,
            error,
            analysis_error: 0.0,
            strong,
        }
    }

    #[test]
    fn the_only_strong_candidate_is_chosen_and_its_confidence_is_in_range() {
        let keyframes = [kf(0.0, 0.0, 0)];
        let refined = [rc(0, 10, 6, 2.0, true)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert_eq!(chosen.keyframe_index, 0);
        assert!(!chosen.ambiguous);
        assert!(chosen.confidence > 0.0 && chosen.confidence <= 0.95);
    }

    #[test]
    fn a_higher_scoring_but_non_strong_candidate_is_skipped_for_the_first_strong_one() {
        // Candidate 0 scores far higher (support=50, unique=50) but is not strong; candidate 1 is the only
        // strong candidate and must be the one chosen, exactly like `results.find((r) => r.strong)` on a
        // descending-score sort — "highest score" and "chosen" are not the same thing.
        let keyframes = [kf(0.0, 0.0, 0), kf(0.0, 0.0, 0)];
        let refined = [rc(0, 50, 50, 0.0, false), rc(1, 10, 6, 2.0, true)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert_eq!(chosen.keyframe_index, 1);
    }

    #[test]
    fn no_strong_candidate_returns_none() {
        let keyframes = [kf(0.0, 0.0, 0)];
        let refined = [rc(0, 3, 2, 1.0, false)];
        assert!(select_candidate(&refined, &keyframes).is_none());
    }

    #[test]
    fn a_rival_over_the_08_score_boundary_on_a_different_canonical_canvas_marks_ambiguous() {
        // Both candidates share unique=0, error=0 (confidence = 0.45 for both), isolating the boundary to a
        // plain support ratio: rival/best = 9/10 = .9 > .8.
        let keyframes = [kf(0.0, 0.0, 0), kf(1000.0, 1000.0, 1)];
        let refined = [rc(0, 10, 0, 0.0, true), rc(1, 9, 0, 0.0, false)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert!(chosen.ambiguous, "9/10 = .9 is over the .8 rival boundary");
    }

    #[test]
    fn a_rival_under_the_08_score_boundary_does_not_mark_ambiguous() {
        // rival/best = 7/10 = .7 < .8, on a different canonical canvas — the geometry condition alone is not
        // enough; the score gate must also clear .8.
        let keyframes = [kf(0.0, 0.0, 0), kf(1000.0, 1000.0, 1)];
        let refined = [rc(0, 10, 0, 0.0, true), rc(1, 7, 0, 0.0, false)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert!(
            !chosen.ambiguous,
            "7/10 = .7 is under the .8 rival boundary"
        );
    }

    #[test]
    fn a_same_canvas_close_candidate_is_not_a_rival_even_with_a_high_score() {
        // rival/best = 9/10 = .9 clears the score gate, but both keyframes resolve to the SAME canonical
        // canvas and land within 6 native px of each other — not a competing explanation, just noisy agreement.
        let keyframes = [kf(0.0, 0.0, 0), kf(3.0, 0.0, 0)];
        let refined = [rc(0, 10, 0, 0.0, true), rc(1, 9, 0, 0.0, false)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert!(
            !chosen.ambiguous,
            "same canvas, 3px apart: agreement, not a rival"
        );
    }

    #[test]
    fn a_different_canonical_canvas_at_the_same_point_is_still_a_rival() {
        // Same (x, y) as the best candidate but a DIFFERENT resolved canvas — the rival test's canvas check must
        // fire on its own, independent of the >6px distance check.
        let keyframes = [kf(0.0, 0.0, 0), kf(0.0, 0.0, 1)];
        let refined = [rc(0, 10, 0, 0.0, true), rc(1, 9, 0, 0.0, false)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert!(
            chosen.ambiguous,
            "same point, different canonical canvas: still a rival"
        );
    }

    #[test]
    fn non_finite_scores_are_excluded_without_panicking_in_a_large_candidate_set() {
        // `slice::sort_by`'s total-order check only walks the merge path (where it can detect and panic on an
        // inconsistent comparator) once the slice is long enough — the reviewer's probe needed length >= 21.
        // Candidates 0..23 all have a non-finite `error` (NaN, or an error so extreme its `exp()` term
        // overflows to +Infinity), so `partial_cmp().unwrap_or(Equal)` on their scores against each other would
        // have been the exact inconsistent-comparator shape that panics; here they are excluded before the sort
        // ever runs. Candidate 24 is the only one with an ordinary finite score and must still be found.
        let mut keyframes = Vec::new();
        let mut refined = Vec::new();
        for i in 0..24 {
            keyframes.push(kf(0.0, 0.0, 0));
            let error = if i % 2 == 0 {
                f64::NAN
            } else {
                f64::NEG_INFINITY
            };
            refined.push(rc(i, 10, 6, error, true));
        }
        keyframes.push(kf(0.0, 0.0, 0));
        refined.push(rc(24, 10, 6, 2.0, true));
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert_eq!(chosen.keyframe_index, 24);
        assert!(chosen.confidence.is_finite());
    }

    #[test]
    fn an_exact_score_tie_keeps_the_first_candidate_in_input_order() {
        // Two candidates with identical support/unique/error score identically (a genuine finite tie, not a
        // NaN one) — the stable sort must not reorder them, matching `Array.prototype.sort`'s stability.
        let keyframes = [kf(0.0, 0.0, 0), kf(0.0, 0.0, 0)];
        let refined = [rc(0, 10, 6, 2.0, true), rc(1, 10, 6, 2.0, true)];
        let chosen = select_candidate(&refined, &keyframes).unwrap();
        assert_eq!(
            chosen.keyframe_index, 0,
            "a tied score keeps the first candidate in input order"
        );
    }
}
