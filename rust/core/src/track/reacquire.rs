//! Anchor re-acquisition and drift correction (R4c 3b-ii) — split from the former monolithic `track.rs`
//! (R6-B, final-verify-report.md item 10). `track.ts::reacquire`/`driftCorrection`, each split into a
//! hypothesis/audit half with no native luma and a native-patch refinement half, so the ABI layer can decide
//! whether the resident native luma plane needs filling at all before calling the refinement half.

use crate::features::{match_features, Feature};
use crate::geometry::{js_hypot, Rect};
use crate::motion::{
    refine_patches, translation_hypotheses, Gray, MatchPoints, Motion, Patch, Point,
};

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
