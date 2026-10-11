//! Frame-to-frame odometry — split out of the former monolithic `track.rs`.
//! `track.ts::odometry` fused into one call: analysis-scale hypotheses,
//! block-aware audit, up to 6 native refinements + rival detection + confidence, falling back to the
//! difference sample that decides `static` vs `lost`.

use crate::kernels::features::{match_features, Feature};
use crate::kernels::geometry::{js_ceil, js_hypot, Rect};
use crate::kernels::motion::{
    audit_translation, refine_native_at, select_native_points, translation_hypotheses, Gray,
    MatchPoints, NativeRefinement, Point,
};
use crate::kernels::region::Region;

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

/// A step the plain native error rejected but `rescuable` measured as unambiguous: what `Tracked` would have
/// carried. The caller takes it only where the frame would otherwise start a new fragment (after re-acquiring the
/// anchor and relocalising have both failed), so every frame those already place stays as it was.
pub struct Rescue {
    pub delta: (f64, f64),
    pub confidence: f64,
    pub ambiguous: bool,
    pub weak_step: bool,
    pub step_error: f64,
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
    /// On `Static`/`Lost`: the rescued step, when there is one.
    pub rescue: Option<Rescue>,
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

/// Native mean error below which a step is tracked.
const TRACKED_ERROR: f64 = 14.0;
/// A step over [`TRACKED_ERROR`] can still be rescued when the offsets around it cost clearly more (runner-up above
/// [`RESCUE_SEPARATION`] × the error) and its trimmed error ([`NativeRefinement::trimmed`]) is a small share of what
/// a misplaced offset costs (below [`RESCUE_SHARE`] × the runner-up). Both are ratios because the errors scale with
/// the content's contrast: the same steps of an HDR recording cost about twice as much once its colours are right as
/// when its coded values were shown dark. Measured on 8 real steps the plain mean rejected — a sticky sidebar (error
/// 14.3, trimmed 2.8, runner-up 50.5), a translucent tab bar (14.9, 5.0, 55.7) and fast flicks of 101–198 px
/// (18.0–25.7, 8.4–12.7, 51.3–54.2): runner-up / error 2.07–3.73, trimmed / runner-up 0.06–0.25. Every other
/// hypothesis the matches proposed had a runner-up within 1.1 × its error and a trimmed error at 0.66 or more of its
/// runner-up.
const RESCUE_SEPARATION: f64 = 1.5;
const RESCUE_SHARE: f64 = 0.35;

/// Whether a step the plain mean rejected is still a measurement: the points of a part that does not scroll (and,
/// on a fast step, the encoder's loss) alone pushed the mean up — the rest match closely and no nearby offset does.
fn rescuable(n: &NativeRefinement) -> bool {
    n.error >= TRACKED_ERROR
        && n.error.is_finite()
        && n.runner_up > RESCUE_SEPARATION * n.error
        && n.trimmed < RESCUE_SHARE * n.runner_up
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

    let mut rescue = None;
    if let Some(best_index) = (!refined.is_empty()).then_some(0usize) {
        let (best_m, best_audit, best_n, _) = &refined[best_index];
        if best_n.error < TRACKED_ERROR || rescuable(best_n) {
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
            // Finished here, in Rust, with `libm::exp` (the same code on every engine and native host) rather
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
                * libm::exp(-step_error / 20.0)
                * if ambiguous { 0.6 } else { 1.0 }
                * if weak_step { 0.5 } else { 1.0 };
            if best_n.error < TRACKED_ERROR {
                return OdometryEstimate {
                    decision: OdometryDecision::Tracked,
                    delta,
                    confidence,
                    ambiguous,
                    weak_step,
                    step_error,
                    content_change,
                    rescue: None,
                };
            }
            rescue = Some(Rescue {
                delta,
                confidence,
                ambiguous,
                weak_step,
                step_error,
            });
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
    // Blank space can dominate the mean difference of a sparse page. It cannot overrule a measured,
    // nonzero step: keep that step on the lost/reacquisition path where the caller can use its rescue.
    let moved = rescue.as_ref().is_some_and(|r| r.delta != (0.0, 0.0));
    let decision = if moved || difference / (samples.max(1) as f64) > 5.0 {
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
        rescue,
    }
}

#[cfg(test)]
mod tests {
    use super::rescuable;
    use crate::kernels::motion::NativeRefinement;

    fn n(error: f64, trimmed: f64, runner_up: f64) -> NativeRefinement {
        NativeRefinement {
            x: 0,
            y: 0,
            error,
            samples: 600,
            runner_up,
            trimmed,
        }
    }

    // Failure cases for the rescue gate: a step the plain mean accepts counted as a rescue (it never needs one); the
    // measured rescues (a sticky sidebar, a translucent tab bar, the slowest and the fastest flick) refused; a rescue
    // granted when the trimmed error is not low next to what a misplaced offset costs, when another offset close by
    // nearly matches (an aliased step on repeated content), when there were too few points to measure anything, or
    // for a hypothesis that is simply wrong.
    #[test]
    fn only_an_unambiguous_step_the_plain_mean_rejected_is_rescuable() {
        assert!(!rescuable(&n(13.9, 2.0, 50.0)));
        for (error, trimmed, runner_up) in [
            (14.33, 2.8, 50.48),
            (14.90, 5.0, 55.71),
            (20.2, 8.7, 52.0),
            (25.0, 12.7, 51.8),
        ] {
            assert!(
                rescuable(&n(error, trimmed, runner_up)),
                "{error} {trimmed} {runner_up}"
            );
        }
        assert!(!rescuable(&n(14.33, 20.0, 50.48)));
        assert!(!rescuable(&n(14.33, 2.8, 20.0)));
        assert!(!rescuable(&n(f64::INFINITY, 2.8, f64::INFINITY)));
        assert!(!rescuable(&n(51.8, 39.1, 54.0)));
    }
    // The phase/fixed-toolbar regression lives here because the engine consumes Rescue in Rust;
    // the legacy standalone Wasm odometry call no longer exposes it.
    #[test]
    fn sparse_text_motion_survives_analysis_phase_and_fixed_chrome() {
        use super::{odometry, OdometryDecision, OdometryInputs};
        use crate::kernels::features::extract_features;
        use crate::kernels::geometry::Rect;
        use crate::kernels::motion::Gray;
        use crate::kernels::raster::{downscale_gray, downscaled_size};
        let (width, height) = (400, 900);
        let page = |offset: usize, toolbar: usize| {
            let mut data = vec![0; width * height * 4];
            for y in 0..height {
                for x in 0..width {
                    let world_y = y + offset;
                    let (line, yy, word, xx) = (world_y / 140, world_y % 140, x / 60, x % 60);
                    let mut value = 248;
                    if (40..58).contains(&yy) && xx > 8 && xx < 38 {
                        let ink = ((line * 193 + word * 73 + xx / 3 * 19) >> ((yy - 40) / 3)) & 1;
                        if ink != 0 {
                            value = 45;
                        }
                    }
                    if y < toolbar && x > 40 && x < 360 {
                        value = if (x * 13 + y * 73 + x * y % 79) % 47 < 23 {
                            20
                        } else {
                            240
                        };
                    }
                    data[(y * width + x) * 4..(y * width + x) * 4 + 4]
                        .copy_from_slice(&[value, value, value, 255]);
                }
            }
            data
        };
        for f in [2usize, 3, 4, 5] {
            for toolbar in [32, 96] {
                let previous = page(0, toolbar);
                let current = page(67, toolbar);
                let (w, h) = downscaled_size(width, height, f);
                let mut a = vec![0; w * h];
                let mut b = vec![0; w * h];
                downscale_gray(&previous, width, height, f, &mut a);
                downscale_gray(&current, width, height, f, &mut b);
                let previous_features = extract_features(&a, w, h, 480, None);
                let own_features = extract_features(&b, w, h, 480, None);
                let rect = Rect {
                    x: 0.0,
                    y: 0.0,
                    width: width as f64,
                    height: height as f64,
                };
                let result = odometry(OdometryInputs {
                    f: f as f64,
                    radius: 3.max(f.div_ceil(2) as i32 + 1),
                    mask: None,
                    roi: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: w as f64,
                        height: h as f64,
                    },
                    rect,
                    region: None,
                    image_width: width as f64,
                    image_height: height as f64,
                    previous: &previous,
                    current: &current,
                    previous_gray: Gray {
                        width: w,
                        height: h,
                        data: &a,
                    },
                    g: Gray {
                        width: w,
                        height: h,
                        data: &b,
                    },
                    velocity: (0.0, 0.0),
                    previous_features: &previous_features,
                    own_features: &own_features,
                    confidence: 1.0,
                });
                assert_ne!(
                    result.decision,
                    OdometryDecision::Static,
                    "factor {f}, toolbar {toolbar}"
                );
                let delta = if result.decision == OdometryDecision::Tracked {
                    result.delta
                } else {
                    result
                        .rescue
                        .expect("measured motion must remain rescuable")
                        .delta
                };
                assert_eq!(delta, (0.0, 67.0), "factor {f}, toolbar {toolbar}");
            }
        }
    }
}
