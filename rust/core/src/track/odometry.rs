//! Frame-to-frame odometry — split out of the former monolithic `track.rs`.
//! `track.ts::odometry` fused into one call: analysis-scale hypotheses,
//! block-aware audit, up to 6 native refinements + rival detection + confidence, falling back to the
//! difference sample that decides `static` vs `lost`.

use crate::features::{match_features, Feature};
use crate::geometry::{js_ceil, js_hypot, Rect};
use crate::motion::{
    audit_translation, refine_native_at, select_native_points, translation_hypotheses, Gray,
    MatchPoints, Point,
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
    // Points depend only on `current`/`rect`/`mask`/`g`/`f`, not on any hypothesis, so they are selected once —
    // lazily, only when at least one hypothesis survived the audit — and reused for all (up to 6) native
    // refinements below instead of rescanning the region per candidate. `g` (this frame's own analysis gray)
    // and `f` guide the selection coarse-to-fine instead of a full-resolution native scan — see
    // `select_native_points`'s doc comment.
    let points = if scored.is_empty() {
        Vec::new()
    } else {
        select_native_points(
            current,
            image_width as usize,
            image_height as usize,
            rect,
            mask,
            Some((g, (f as usize).max(1))),
        )
    };
    let mut refined: Vec<_> = scored
        .into_iter()
        .take(6)
        .map(|(m, audit)| {
            let n = refine_native_at(
                previous,
                current,
                image_width as usize,
                image_height as usize,
                Point {
                    x: m.x * f,
                    y: m.y * f,
                },
                mask,
                radius,
                &points,
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
    let (mut textured_difference, mut textured_samples) = (0.0, 0u32);
    let max_samples = ((js_ceil(roi.x + roi.width) - js_ceil(roi.x)).max(0) as u64)
        * ((js_ceil(roi.y + roi.height) - js_ceil(roi.y)).max(0) as u64);
    let mut y = js_ceil(roi.y) as f64;
    'rows: while y < roi.y + roi.height {
        let mut x = js_ceil(roi.x) as f64;
        while x < roi.x + roi.width {
            let contained =
                region.is_none_or(|r| r.contains(x * f, y * f, image_width, image_height));
            if contained {
                let (yi, xi) = (y as usize, x as usize);
                let i = yi * g.width + xi;
                let delta = (previous_gray.data[i] as f64 - g.data[i] as f64).abs();
                difference += delta;
                samples += 1;
                if xi > 0 && xi + 1 < g.width && yi > 0 && yi + 1 < g.height {
                    let textured = |gray: &[u8]| {
                        (gray[i - 1] as i32 - gray[i + 1] as i32)
                            .abs()
                            .max((gray[i - g.width] as i32 - gray[i + g.width] as i32).abs())
                            >= 12
                    };
                    if textured(previous_gray.data) || textured(g.data) {
                        textured_difference += delta;
                        textured_samples += 1;
                    }
                }
                // Remaining differences are nonnegative and membership can only reduce the divisor.
                if difference > 5.0 * max_samples as f64 {
                    break 'rows;
                }
            }
            x += 1.0;
        }
        y += 1.0;
    }
    // A sparse page can move substantially while most pixels remain background (e.mov frame 823).
    // Silence in the blank area must not outweigh disagreement on the available structure.
    let decision = if samples == 0
        || difference > 5.0 * samples as f64
        || (textured_samples >= 12 && textured_difference > 5.0 * textured_samples as f64)
    {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Failure cases: content changes between the old 7px probes; empty membership; threshold-exact
    // noise; fractional ROI edges. Exercise the real fallback through odometry, not a test-only scorer.
    fn fallback(a: &[u8], b: &[u8], roi: Rect, region: Option<&Region>) -> OdometryDecision {
        let (width, height) = (49, 35);
        let rgba = vec![0; width * height * 4];
        odometry(OdometryInputs {
            f: 1.0,
            radius: 1,
            mask: None,
            roi,
            rect: roi,
            region,
            image_width: width as f64,
            image_height: height as f64,
            previous: &rgba,
            current: &rgba,
            previous_gray: Gray {
                data: a,
                width,
                height,
            },
            g: Gray {
                data: b,
                width,
                height,
            },
            velocity: (0.0, 0.0),
            previous_features: &[],
            own_features: &[],
            confidence: 0.9,
        })
        .decision
    }

    #[test]
    fn fallback_sees_changes_between_grid_probes() {
        let roi = Rect {
            x: 0.0,
            y: 0.0,
            width: 49.0,
            height: 35.0,
        };
        let a = vec![0; 49 * 35];
        let b: Vec<u8> = (0..49 * 35)
            .map(|i| {
                if i % 49 % 7 == 0 && i / 49 % 7 == 0 {
                    0
                } else {
                    200
                }
            })
            .collect();
        assert_eq!(fallback(&a, &b, roi, None), OdometryDecision::Lost);
    }

    #[test]
    fn fallback_does_not_dilute_sparse_moving_texture_with_blank_background() {
        let roi = Rect {
            x: 0.0,
            y: 0.0,
            width: 49.0,
            height: 35.0,
        };
        let mut a = vec![0; 49 * 35];
        let mut b = a.clone();
        for y in 10..13 {
            for x in 10..13 {
                a[y * 49 + x] = 255;
                b[y * 49 + x + 14] = 255;
            }
        }
        assert_eq!(fallback(&a, &b, roi, None), OdometryDecision::Lost);
    }

    #[test]
    fn fallback_requires_observations_and_preserves_noise_threshold() {
        let roi = Rect {
            x: 0.5,
            y: 0.5,
            width: 47.5,
            height: 33.5,
        };
        let a = vec![80; 49 * 35];
        for (value, expected) in [
            (80, OdometryDecision::Static),
            (85, OdometryDecision::Static),
            (86, OdometryDecision::Lost),
        ] {
            assert_eq!(fallback(&a, &vec![value; a.len()], roi, None), expected);
        }
        let region = Region {
            rect: roi,
            exclusions: vec![roi],
            crop: None,
            solid: false,
            mask: None,
        };
        assert_eq!(fallback(&a, &a, roi, Some(&region)), OdometryDecision::Lost);
    }
}
