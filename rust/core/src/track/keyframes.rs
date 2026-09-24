//! Keyframe candidate scoring (R4d step 4) — split from the former monolithic `track.rs` (R6-B,
//! final-verify-report.md item 10). `keyframes.ts::evaluateCandidates`'s audit and native-refinement phases:
//! hypothesis matching + analysis-scale audit over every keyframe, then (only for audited candidates) native
//! patch refinement. The `Math.exp` confidence formula and the sort/best/rival selection stay in TS (see
//! `RefinedCandidate`'s doc comment below for why).

use crate::features::{match_features, Feature};
use crate::geometry::Rect;
use crate::motion::{
    audit_translation, refine_patches, translation_hypotheses, Gray, MatchPoints, Patch, Point,
};

/// R4d step 4: one keyframe `evaluate_candidates_audit`/`_refine` score a query against — the parts of
/// `keyframes.ts`'s `Keyframe` (features/gray/patches) the Rust port needs. `x`/`y`/`canvasId` and the
/// caller's `canonical` map stay TS-side: the final sort/best/rival selection that needs them runs there too
/// (see `RefinedCandidate`'s doc comment for why).
pub struct CandidateKeyframe<'a> {
    pub features: &'a [Feature],
    pub gray: Gray<'a>,
    pub patches: &'a [Patch<'a>],
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
/// plane at all based on whether this returns anything (R4d step 4: "native refinement only for candidates that
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
/// `m.support >= 10 && m.unique >= 6 && m.confidence >= .45`, no `Math.exp` involved). `confidence` itself is
/// left to the TS caller: `keyframes.ts::evaluateCandidates`'s final `Math.min(.95, .45 + .5 * (1 -
/// Math.exp(-unique / 7))) * Math.exp(-error / 20)` is finished there, on the host's own `Math.exp`, for the
/// same bit-exactness reason as `OdometryEstimate.confidence` (see that struct's doc comment) — AND because the
/// TS-side sort/best/rival selection that follows depends on that exact value (it is the sort key), this Rust
/// call stops at "the audited, refined candidate list", not the final pick.
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
