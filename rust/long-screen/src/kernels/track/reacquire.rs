//! Anchor re-acquisition and drift correction — split out of the former monolithic `track.rs`.
//! `track.ts::reacquire`/`driftCorrection`, each split into a
//! hypothesis/audit half with no native luma and a native-patch refinement half, so the ABI layer can decide
//! whether the resident native luma plane needs filling at all before calling the refinement half.

use crate::kernels::features::{match_features, Feature};
use crate::kernels::geometry::{js_hypot, Rect};
use crate::kernels::motion::{
    refine_patches, refine_spatial_patches, translation_hypotheses, Gray, MatchPoints, Motion,
    Patch, Point,
};

/// `track.ts::reacquire`'s hypothesis-generation half: `matchFeatures` + `translationHypotheses`
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

/// `track.ts::reacquire`'s output; `confidence` is the fully computed
/// `top.m.confidence.max(0.05) * exp(-error / 20) * (ambiguous ? 0.6 : 1)`, using the unweighted native residual
/// and `libm::exp` (the same code on every engine — see `odometry.rs`'s `OdometryEstimate.confidence` doc comment for why this
/// is no longer finished by the TS caller with `Math.exp`).
pub struct ReacquireEstimate {
    pub x: i32,
    pub y: i32,
    pub ambiguous: bool,
    pub confidence: f64,
    /// Ordinary native residual at the selected offset; spatial weighting only selects the motion.
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
            let n = refine_spatial_patches(
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
    let ambiguous = top_m.ambiguous;
    // Area weights choose the motion, not the source quality. Keep the ordinary texture residual for
    // confidence, or adding unsampled space would change which frame the compositor prefers.
    let error = refine_patches(
        patches,
        native,
        rect,
        Point {
            x: top_n.x as f64,
            y: top_n.y as f64,
        },
        0,
    )
    .error;
    // `f64::max(0.05)` returns `0.05` for a NaN `confidence` where `Math.max(.05, NaN)` returns `NaN` (see
    // odometry.rs's `OdometryEstimate.confidence` doc comment for the same difference and why it is kept) —
    // never observed in practice, since `top_m.confidence` comes from `translation_hypotheses`, which never
    // produces NaN.
    let confidence =
        top_m.confidence.max(0.05) * libm::exp(-error / 20.0) * if ambiguous { 0.6 } else { 1.0 };
    Some(ReacquireEstimate {
        x: top_n.x,
        y: top_n.y,
        ambiguous,
        confidence,
        error,
    })
}

/// `track.ts::driftCorrection`'s output. `confidence_floor` is `0.96 * exp(-error / 20)` (`libm::exp`, identical
/// on every engine); the TS caller takes `Math.max(carriedInConfidence, confidenceFloor)`, a plain comparison
/// with no transcendental function left to vary between engines.
pub struct DriftEstimate {
    pub x: f64,
    pub y: f64,
    pub error: f64,
    pub confidence_floor: f64,
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
            confidence_floor: 0.96 * libm::exp(-n.error / 20.0),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Dense fixed controls must not outvote sparse page texture merely by supplying more patches.
    // The same observations with no page movement must still re-acquire the stationary anchor.
    #[test]
    fn reacquisition_balances_clustered_controls_against_the_page() {
        let (w, h, step, size) = (256, 960, 96, 16);
        let page = |x: usize, y: usize| 180 + ((x * 37 + y * 71 + x * y * 13) % 64) as u8;
        let frame = |dy: usize| {
            let mut data = vec![0; w * h];
            for y in 0..h {
                for x in 0..w {
                    data[y * w + x] = if !(64..h - 64).contains(&y) {
                        64 + ((x * 43 + y * 29 + x * y * 17) % 128) as u8
                    } else {
                        page(x, y + dy)
                    };
                }
            }
            data
        };
        let anchor = frame(0);
        let current = frame(step);
        let mut origins: Vec<_> = [16, h - 32]
            .into_iter()
            .flat_map(|y| (0..8).map(move |i| (8 + i * 30, y)))
            .collect();
        origins.extend([200, 400, 600, 800].map(|y| (120, y)));
        let data: Vec<Vec<u8>> = origins
            .iter()
            .map(|&(x, y)| {
                (0..size)
                    .flat_map(|py| {
                        anchor[(y + py) * w + x..(y + py) * w + x + size]
                            .iter()
                            .copied()
                    })
                    .collect()
            })
            .collect();
        let patches: Vec<_> = origins
            .iter()
            .zip(&data)
            .map(|(&(x, y), data)| Patch {
                x: x as i32,
                y: y as i32,
                size,
                data,
            })
            .collect();
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            width: w as f64,
            height: h as f64,
        };
        let models: Vec<_> = [step, 0]
            .map(|dy| Motion {
                x: 0.0,
                y: dy as f64,
                support: 30,
                unique: 30,
                confidence: 1.0,
                error: 0.0,
                ambiguous: false,
            })
            .into();
        for (pixels, expected) in [(&current, step), (&anchor, 0)] {
            let found = reacquire_refine(
                &models,
                &patches,
                Gray {
                    width: w,
                    height: h,
                    data: pixels,
                },
                rect,
                1.0,
                3,
            )
            .expect("one globally supported anchor");
            assert_eq!((found.x, found.y), (0, expected as i32));
        }
    }
    // Extending the pane beyond the sampled patches must not change their source quality.
    // Area weights establish motion support; the same native residual still means the same quality.
    #[test]
    fn anchor_quality_does_not_depend_on_unsampled_pane_extent() {
        let (w, h, size) = (160, 320, 32);
        let reference: Vec<u8> = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                32 + ((x * 13 + y * 31 + x * y * 17) % 128) as u8
            })
            .collect();
        let origins = [(16, 16), (96, 112)];
        let data: Vec<Vec<u8>> = origins
            .iter()
            .map(|&(x, y)| {
                (0..size)
                    .flat_map(|dy| {
                        reference[(y + dy) * w + x..(y + dy) * w + x + size]
                            .iter()
                            .copied()
                    })
                    .collect()
            })
            .collect();
        let patches: Vec<_> = origins
            .iter()
            .zip(&data)
            .map(|(&(x, y), data)| Patch {
                x: x as i32,
                y: y as i32,
                size,
                data,
            })
            .collect();
        let mut current = reference.clone();
        for y in 112..112 + size {
            for x in 96..96 + size {
                current[y * w + x] += 8;
            }
        }
        let models = [Motion {
            x: 0.0,
            y: 0.0,
            support: 30,
            unique: 30,
            confidence: 1.0,
            error: 0.0,
            ambiguous: false,
        }];
        let estimates: Vec<_> = [160, 320]
            .into_iter()
            .map(|height| {
                reacquire_refine(
                    &models,
                    &patches,
                    Gray {
                        width: w,
                        height: h,
                        data: &current,
                    },
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        width: w as f64,
                        height: height as f64,
                    },
                    1.0,
                    3,
                )
                .unwrap()
            })
            .collect();
        for estimate in &estimates {
            assert_eq!((estimate.x, estimate.y), (0, 0));
        }
        assert_eq!(estimates[0].confidence, estimates[1].confidence);
        assert_eq!(estimates[0].error, 4.0); // One equally sized patch differs by eight, the other is exact.
    }
}
