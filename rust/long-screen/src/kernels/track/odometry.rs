//! Frame-to-frame odometry — split out of the former monolithic `track.rs`.
//! `track.ts::odometry` fused into one call: analysis-scale hypotheses,
//! block-aware audit, up to 6 native refinements + rival detection + confidence, falling back to the
//! difference sample that decides `static` vs `lost`.

use crate::kernels::features::{match_features, Feature};
use crate::kernels::geometry::{js_ceil, js_hypot, Rect};
use crate::kernels::motion::{
    audit_translation, refine_native_at, sampling_insensitive_error, screen_fixed_split_error,
    select_native_points, translation_hypotheses, Gray, MatchPoints, NativeRefinement, Point,
    TranslationAudit,
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

/// A measured step kept behind anchor re-acquisition and relocalization. It may recover a
/// phase-sensitive native rejection or an overlap that the interior registration window missed.
/// The caller uses it only where the frame would otherwise start a new fragment.
pub struct Rescue {
    /// This rescue has additional phase and spatial evidence; registration may use a separate support window.
    pub phase_support: bool,
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
#[derive(Clone, Copy)]
pub struct OdometryInputs<'a> {
    pub f: f64,
    pub radius: i32,
    pub mask: Option<(&'a [u8], u8)>,
    /// Where the previous frame's pixels may be read, when that is not `mask`: a nested container
    /// (`engine::solve::Nest`) shares its parent's labels but showed its content only inside last frame's clip,
    /// and a row that scrolled in from outside it would be scored against the parent's pixels there.
    pub reference: Option<(&'a [u8], u8)>,
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
/// Matches a hypothesis needs to be refined natively.
const MIN_SUPPORT: u32 = 4;
/// When no hypothesis has [`MIN_SUPPORT`] matches, the best this many of the rest (three matches each, the least
/// `translation_hypotheses` proposes) are audited and refined instead, and the native check decides. Without them a
/// dark, sparse frame that moved fell through to the difference sample, whose blank pixels call it static: on an HDR
/// recording of a painting (test_4, frame 1080) the frame had four matches, the true 112-px step was the one
/// hypothesis and had three of them, the mean difference was 0.6, and every later frame was placed 111 px off,
/// leaving seams through the mouth and eyebrows and 36 rejected loop closures.
const FEW_MATCH_MODELS: usize = 2;
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

/// Whether a step the plain mean rejected is still a measurement because its content moved by a fraction of a pixel:
/// under the sampling-insensitive cost ([`sampling_insensitive_error`]) the chosen offset clears the tracked bar, and
/// the offsets more than two pixels away miss it, by the same separation [`rescuable`] asks for. A recording
/// downscaled by a non-integer factor moves by a fraction of a pixel on almost every step, and the native points sit
/// on the strongest edges, so the plain mean at the correct offset grows with the phase: on a recording downscaled
/// by 0.804, 303 of 393 steps cost 14.2–47.7, and 185 of them (27.1–47.7, runner-up 45–62) were not rescuable
/// either. Their insensitive cost is 0–12.5 (median 0.17) at the plain mean's offset and 22.8–34.7 more than two
/// pixels away; on the same recording at full size the plain mean tracks 392 of the 393 steps. The insensitive
/// cost's bottom is flat within a pixel, so the plain mean still places the step.
fn measured_between_pixels(error: f64, runner_up: f64) -> bool {
    error < TRACKED_ERROR && runner_up >= TRACKED_ERROR && runner_up > RESCUE_SEPARATION * error
}

/// Whether a step is measured once the region may hold a screen-fixed part ([`screen_fixed_split_error`]): the offset
/// explains more of the points than zero does, the split cost clears the tracked bar, and the offsets more than two
/// pixels away cost [`RESCUE_SEPARATION`] times as much and at least 4 more. A part that stays on screen inside a
/// moving region is the smaller part; when most of the region stayed put, the region did not move and the part that
/// did is something inside it (a nested pane, an animation), as on a Mac recording (own_a, frames 1024–1040) where 58 %
/// of the features stayed and the rest moved by 54 px a frame. The bar on the runner-up is relative, not
/// [`TRACKED_ERROR`], because the screen-fixed points lower every offset's split cost by their share: on new_ip_7
/// (status bar, search bar and chips over a map, about a third of the points) the 122 true steps that reached this
/// check split to 0.3–4.1 with runner-ups of 6.2–10.8, and none of the 83 wrong candidates had a runner-up above 1.07
/// times its own cost.
fn split_measured(error: f64, runner_up: f64, moved: f64) -> bool {
    moved > 0.5
        && error < TRACKED_ERROR
        && runner_up > RESCUE_SEPARATION * error
        && runner_up >= error + 4.0
}

/// `track.ts::odometry`.
pub fn odometry(inputs: OdometryInputs) -> OdometryEstimate {
    let OdometryInputs {
        f,
        radius,
        mask,
        reference,
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

    // The native points are chosen in this frame (`mask`); their shifted partners are read from the previous one.
    let reference = reference.or(mask);
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

    let hypotheses = translation_hypotheses(&match_points, 16);
    let models: Vec<_> = if hypotheses.iter().any(|m| m.support >= MIN_SUPPORT) {
        hypotheses
            .into_iter()
            .filter(|m| m.support >= MIN_SUPPORT)
            .collect()
    } else {
        hypotheses.into_iter().take(FEW_MATCH_MODELS).collect()
    };
    // Period-aliased hypotheses on repeated content audit equally well; the constant-velocity prior orders
    // them before the native decision so the true small step is never dropped in favour of a one-row-off
    // alias with more (arbitrary) matches.
    let prior = |mx: f64, my: f64| 0.02 * js_hypot(mx * f - velocity.0, my * f - velocity.1);
    // Multiple tolerant candidates share the same filtered image pair. Zero or one
    // candidate keeps the standalone path; release the buffers before native refinement.
    let prepared =
        (f > 1.0 && models.len() > 1).then(|| TranslationAudit::new(previous_gray, g, true));
    let mut scored: Vec<_> = models
        .into_iter()
        .map(|m| {
            let audit = match &prepared {
                Some(pair) => pair.measure(m.x, m.y, Some(roi)),
                None => audit_translation(previous_gray, g, m.x, m.y, Some(roi), f > 1.0),
            };
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
    drop(prepared);
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
                reference,
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
    let mut phase_support = false;
    if let Some(best_index) = (!refined.is_empty()).then_some(0usize) {
        let (best_m, best_audit, best_n, _) = &refined[best_index];
        let measured = best_n.error < TRACKED_ERROR
            || rescuable(best_n)
            || best_n.error.is_finite() && {
                let (error, runner_up) = sampling_insensitive_error(
                    previous,
                    current,
                    image_width as usize,
                    image_height as usize,
                    (best_n.x, best_n.y),
                    reference,
                    radius,
                    &points,
                );
                measured_between_pixels(error, runner_up) || {
                    phase_support = !best_m.ambiguous
                        && !refined.iter().enumerate().any(|(i, (_, _, n, _))| {
                            i != best_index
                                && js_hypot(
                                    n.x as f64 - best_n.x as f64,
                                    n.y as f64 - best_n.y as f64,
                                ) > 2.0
                                && n.error < best_n.error + 4.0
                        })
                        && super::phase::supports_translation(
                            error,
                            runner_up,
                            best_m,
                            best_audit,
                            &match_points,
                            roi,
                        );
                    phase_support
                }
            };
        if measured {
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
                phase_support,
                delta,
                confidence,
                ambiguous,
                weak_step,
                step_error,
            });
        }
    }

    // A region that holds a screen-fixed part keeps a zero-offset hypothesis alive on every frame, and the plain mean
    // then charges the true step for every point of that part. When nothing else measured the step, or only a zero
    // offset did, a non-zero candidate is still measured if splitting the points between it and zero clears the
    // tracked bar while offsets more than two pixels from it do not (see `split_measured`).
    if rescue.as_ref().is_none_or(|r| r.delta == (0.0, 0.0)) {
        let split: Vec<(usize, f64, f64, f64)> = refined
            .iter()
            .enumerate()
            .filter(|(_, (_, _, n, _))| (n.x, n.y) != (0, 0))
            .map(|(i, (_, _, n, _))| {
                let (error, runner_up, moved) = screen_fixed_split_error(
                    previous,
                    current,
                    image_width as usize,
                    image_height as usize,
                    (n.x, n.y),
                    reference,
                    radius,
                    &points,
                );
                (i, error, runner_up, moved)
            })
            .collect();
        let chosen = split
            .iter()
            .filter(|(_, error, runner_up, moved)| split_measured(*error, *runner_up, *moved))
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(&(i, error, _, _)) = chosen {
            let (m, audit, n, _) = &refined[i];
            let ambiguous = split.iter().any(|&(j, other, _, _)| {
                let o = &refined[j].2;
                j != i
                    && js_hypot(o.x as f64 - n.x as f64, o.y as f64 - n.y as f64) > 2.0
                    && other < error + 2.0
            }) || (m.ambiguous && refined.len() > 1);
            let weak_step = audit.overlap < 0.25;
            let confidence = m.confidence.max(0.05)
                * libm::exp(-n.error / 20.0)
                * if ambiguous { 0.6 } else { 1.0 }
                * if weak_step { 0.5 } else { 1.0 };
            rescue = Some(Rescue {
                phase_support: false,
                delta: (n.x as f64, n.y as f64),
                confidence,
                ambiguous,
                weak_step,
                step_error: n.error,
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
    use super::{measured_between_pixels, rescuable};
    use crate::kernels::geometry::Rect;
    use crate::kernels::motion::{
        sampling_insensitive_error, select_native_points, NativeRefinement,
    };

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
    const PAGE: (usize, usize) = (400, 900);

    /// A sparse text page scrolled by `offset` native pixels under a fixed `toolbar`, as RGBA. A fractional offset
    /// is the average of the two whole-pixel renderings around it: the half-pixel phase a non-integer downscale of
    /// a recording gives every step.
    fn page(offset: f64, toolbar: usize) -> Vec<u8> {
        render(offset, |x, y, offset| {
            let world_y = y + offset;
            let (line, yy, word, xx) = (world_y / 140, world_y % 140, x / 60, x % 60);
            if y < toolbar && x > 40 && x < 360 {
                return if (x * 13 + y * 73 + x * y % 79) % 47 < 23 {
                    20
                } else {
                    240
                };
            }
            if (40..58).contains(&yy) && xx > 8 && xx < 38 {
                let ink = ((line * 193 + word * 73 + xx / 3 * 19) >> ((yy - 40) / 3)) & 1;
                if ink != 0 {
                    return 45;
                }
            }
            248
        })
    }

    /// [`PAGE`]-sized RGBA of `value(x, y, offset)`, a fractional `offset` averaged from the whole pixels around it.
    fn render(offset: f64, value: impl Fn(usize, usize, usize) -> u8) -> Vec<u8> {
        let (width, height) = PAGE;
        let (low, high) = (offset.floor() as usize, offset.ceil() as usize);
        let mut data = vec![0; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let v = (value(x, y, low) as u32 + value(x, y, high) as u32).div_ceil(2) as u8;
                data[(y * width + x) * 4..(y * width + x) * 4 + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        data
    }

    /// Odometry from `previous` to `current` (both [`PAGE`]-sized RGBA) at analysis factor `f`, as the engine runs it.
    fn measure(previous: &[u8], current: &[u8], f: usize) -> super::OdometryEstimate {
        use super::{odometry, OdometryInputs};
        use crate::kernels::features::extract_features;
        use crate::kernels::motion::Gray;
        use crate::kernels::raster::{downscale_gray, downscaled_size};
        let (width, height) = PAGE;
        let (w, h) = downscaled_size(width, height, f);
        let mut a = vec![0; w * h];
        let mut b = vec![0; w * h];
        downscale_gray(previous, width, height, f, &mut a);
        downscale_gray(current, width, height, f, &mut b);
        let previous_features = extract_features(&a, w, h, 480, None);
        let own_features = extract_features(&b, w, h, 480, None);
        odometry(OdometryInputs {
            f: f as f64,
            radius: 3.max(f.div_ceil(2) as i32 + 1),
            mask: None,
            reference: None,
            roi: Rect {
                x: 0.0,
                y: 0.0,
                width: w as f64,
                height: h as f64,
            },
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
            },
            region: None,
            image_width: width as f64,
            image_height: height as f64,
            previous,
            current,
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
        })
    }

    /// The step odometry measured: tracked, or kept as a rescue for the caller.
    fn measured_step(result: super::OdometryEstimate) -> Option<(f64, f64)> {
        match result.decision {
            super::OdometryDecision::Tracked => Some(result.delta),
            _ => result.rescue.map(|r| r.delta),
        }
    }

    // The phase/fixed-toolbar regression lives here because the engine consumes Rescue in Rust;
    // the legacy standalone Wasm odometry call no longer exposes it.
    #[test]
    fn sparse_text_motion_survives_analysis_phase_and_fixed_chrome() {
        for f in [2usize, 3, 4, 5] {
            for toolbar in [32, 96] {
                let result = measure(&page(0.0, toolbar), &page(67.0, toolbar), f);
                assert_ne!(
                    result.decision,
                    super::OdometryDecision::Static,
                    "factor {f}, toolbar {toolbar}"
                );
                assert_eq!(
                    measured_step(result),
                    Some((0.0, 67.0)),
                    "factor {f}, toolbar {toolbar}"
                );
            }
        }
    }

    // A recording downscaled by a non-integer factor moves its content by fractional native pixels, so every edge the
    // native refinement samples lands between two pixels and the correct whole-pixel offset costs as much as a wrong
    // one under the plain mean. Such a step is still a measurement and must stay available to the caller, at either
    // whole pixel next to it, or the region starts a new fragment wherever re-acquisition also misses.
    #[test]
    fn a_step_between_two_pixels_is_still_measured() {
        for f in [2usize, 3, 4, 5] {
            for toolbar in [0, 32] {
                let result = measure(&page(0.0, toolbar), &page(67.5, toolbar), f);
                assert_ne!(
                    result.decision,
                    super::OdometryDecision::Static,
                    "factor {f}, toolbar {toolbar}"
                );
                let step = measured_step(result);
                assert!(
                    step == Some((0.0, 67.0)) || step == Some((0.0, 68.0)),
                    "factor {f}, toolbar {toolbar}: {step:?}"
                );
            }
        }
    }

    // Failure cases for the between-pixels rule: a half-pixel step left unmeasured although only its phase costs, a
    // displacement of a few pixels forgiven as phase, and rows that repeat within the search radius accepted although
    // no offset stands out from the others.
    #[test]
    fn only_a_fraction_of_a_pixel_is_forgiven() {
        let (width, height) = PAGE;
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            width: width as f64,
            height: height as f64,
        };
        let measured = |previous: &[u8], current: &[u8], dy: i32| {
            let points = select_native_points(current, width, height, rect, None, None);
            let (error, runner_up) = sampling_insensitive_error(
                previous,
                current,
                width,
                height,
                (0, dy),
                None,
                3,
                &points,
            );
            measured_between_pixels(error, runner_up)
        };
        let (previous, current) = (page(0.0, 0), page(67.5, 0));
        for dy in [67, 68] {
            assert!(measured(&previous, &current, dy), "{dy}");
        }
        for dy in [64, 65, 70, 71] {
            assert!(!measured(&previous, &current, dy), "{dy}");
        }
        let rows = |offset| {
            render(offset, |x, y, offset| {
                if (x % 7 < 3) != ((y + offset) % 3 == 0) {
                    45
                } else {
                    248
                }
            })
        };
        let (previous, current) = (rows(0.0), rows(67.5));
        for dy in [67, 68] {
            assert!(!measured(&previous, &current, dy), "repeated rows, {dy}");
        }
    }

    /// A textured map under a screen-fixed bar of `toolbar` rows (dense, high contrast, like a search bar and status bar
    /// over a map), panned by `offset` native pixels; the map is two thirds of the frame or more.
    fn map(offset: f64, toolbar: usize) -> Vec<u8> {
        render(offset, |x, y, offset| {
            if y < toolbar && x > 40 && x < 360 {
                return if (x * 13 + y * 73 + x * y % 79) % 47 < 23 {
                    20
                } else {
                    240
                };
            }
            let (bx, by) = (x / 3, (y + offset) / 3);
            (150 + (bx.wrapping_mul(73_856_093) ^ by.wrapping_mul(19_349_663)) % 97) as u8
        })
    }

    // Failure cases for a moving region that holds a screen-fixed part (a search bar, status bar and chips over a map,
    // new_ip_7): the fixed part's points match at zero on every frame, so the plain mean puts the zero offset ahead of
    // the true step and keeps it as the rescue, also when the map moved by a fraction of a pixel; a frame that did not
    // move measured as a step; and, when the fixed part is the larger one, the part that moved taken for the region.
    #[test]
    fn a_step_under_a_screen_fixed_part_is_still_measured() {
        for f in [2usize, 3, 4] {
            for (offset, steps) in [(67.0, [67.0, 67.0]), (67.5, [67.0, 68.0])] {
                let result = measure(&map(0.0, 300), &map(offset, 300), f);
                let step = measured_step(result);
                assert!(
                    step == Some((0.0, steps[0])) || step == Some((0.0, steps[1])),
                    "factor {f}, offset {offset}: {step:?}"
                );
            }
            let still = measure(&map(67.0, 300), &map(67.0, 300), f);
            assert!(
                matches!(measured_step(still), None | Some((0.0, 0.0))),
                "factor {f}"
            );
            // The bar is now most of the frame: what moved is something inside a region that stayed put.
            let inside = measured_step(measure(&map(0.0, 700), &map(67.0, 700), f));
            assert!(
                matches!(inside, None | Some((0.0, 0.0))),
                "factor {f}: {inside:?}"
            );
        }
    }

    /// A dark page with five dim 28 × 16 marks, scrolled by `offset`: the frame gives the matcher only a handful of
    /// features, so the true step can be backed by three matches.
    fn dark(offset: f64) -> Vec<u8> {
        const MARKS: [(usize, usize); 5] =
            [(60, 300), (250, 420), (130, 610), (300, 760), (80, 900)];
        render(offset, |x, y, offset| {
            let world_y = y + offset;
            for (mx, my) in MARKS {
                if (mx..mx + 28).contains(&x) && (my..my + 16).contains(&world_y) {
                    let (u, v) = (x - mx, world_y - my);
                    return if (u * 7 + v * 3 + u * v) % 11 < 5 {
                        96
                    } else {
                        30
                    };
                }
            }
            18
        })
    }

    // Failure cases for a dark, sparse frame: a real step declared static because the one hypothesis that has it is
    // backed by three matches (fewer than the four a hypothesis needs), so every later frame inherits the missed step;
    // a spurious hypothesis with the same support taken instead of it; and a frame that did not move measured as a
    // step. At factor 3 the matches propose the true step and a spurious one, three matches each.
    #[test]
    fn a_step_backed_by_three_matches_is_still_measured() {
        for f in [2usize, 3, 4] {
            let result = measure(&dark(0.0), &dark(112.0), f);
            assert_ne!(
                result.decision,
                super::OdometryDecision::Static,
                "factor {f}"
            );
            assert_eq!(measured_step(result), Some((0.0, 112.0)), "factor {f}");
            let still = measure(&dark(112.0), &dark(112.0), f);
            assert!(
                matches!(measured_step(still), None | Some((0.0, 0.0))),
                "factor {f}"
            );
        }
    }
}
