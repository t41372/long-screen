//! Frame-to-frame odometry — split out of the former monolithic `track.rs`.
//! `track.ts::odometry` fused into one call: analysis-scale hypotheses,
//! block-aware audit, up to 6 native refinements + rival detection + confidence, falling back to the
//! difference sample that decides `static` vs `lost`.

use crate::features::{match_features, Feature};
use crate::geometry::{js_ceil, js_hypot, Rect};
use crate::motion::{
    audit_translation, refine_native, translation_hypotheses, Gray, MatchPoints, Point,
};
use crate::region::Region;

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
    /// On `Tracked`: the fully computed step confidence (`best.m.confidence.max(0.05) * exp(-stepError / 20) *
    /// ambiguous/weakStep factors`) — see the comment at this field's one call site below for why the `exp`
    /// factor is finished here rather than by the TS caller. On `Static`/`Lost`: the input `confidence`, unchanged.
    pub confidence: f64,
    pub ambiguous: bool,
    pub weak_step: bool,
    /// `f64::INFINITY` on the `Static`/`Lost` branches, exactly like the TS original's `stepError`.
    pub step_error: f64,
    pub content_change: Option<ContentChange>,
}

/// One region's odometry inputs, fused into a single call: `matchFeatures` +
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
            // Finished here, in Rust, with `f64::exp` (a software libm, identical across every engine) rather
            // than by the TS caller with `Math.exp`: JS engines' `Math.exp` implementations differ in the last
            // bit on some inputs, and `stepError` is a continuous, effectively-arbitrary float, so finishing this
            // multiply in TS would let the same recording reach a different confidence — and, at a threshold, a
            // different decision — in Chrome vs. Safari (see docs/ARCHITECTURE.md §十二).
            // `f64::max` also differs from `Math.max` on a NaN `confidence` (never observed in practice —
            // `best_m.confidence` comes from `translation_hypotheses`, which never produces NaN): Rust's
            // `max(0.05)` returns `0.05` for a NaN input, where `Math.max(.05, NaN)` returns `NaN`. Rust's
            // behaviour is the more robust of the two (a floor, not a NaN that then poisons every factor
            // multiplied against it), so this is kept rather than reproduced.
            let confidence = best_m.confidence.max(0.05)
                * (-step_error / 20.0).exp()
                * if ambiguous { 0.6 } else { 1.0 }
                * if weak_step { 0.5 } else { 1.0 };
            return OdometryEstimate {
                decision: OdometryDecision::Tracked,
                delta,
                confidence,
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
