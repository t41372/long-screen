#!/usr/bin/env python3
"""Add a conservative native-refinement fallback for dominant audit near misses.

This runs after apply-map-robustness.py. Exact replacements make source drift fail CI.
"""

from pathlib import Path

TARGET = Path("rust/long-screen/src/kernels/track/odometry.rs")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source match, found {count}")
    return source.replace(old, new, 1)


source = TARGET.read_text(encoding="utf-8")

old_import = r'''    audit_translation, refine_native_at, sampling_insensitive_error, select_native_points,
    translation_hypotheses, Gray, MatchPoints, NativeRefinement, Point,
'''
new_import = r'''    audit_translation, refine_native_at, sampling_insensitive_error, select_native_points,
    translation_hypotheses, Audit, Gray, MatchPoints, Motion, NativeRefinement, Point,
'''
source = replace_once(source, old_import, new_import, "import audit and motion")

anchor = r'''fn content_change_rescuable(
    n: &NativeRefinement,
    agreement: f64,
    agreeing: u32,
    agreeing_error: f64,
) -> bool {
    n.error >= TRACKED_ERROR
        && n.error.is_finite()
        && n.trimmed < TRACKED_ERROR
        && n.trimmed < CONTENT_CHANGE_RESCUE_SHARE * n.runner_up
        && agreement >= 0.4
        && agreeing >= 3
        && agreeing_error < 8.0
}
'''
addition = anchor + r'''
/// The analysis audit is intentionally strict, but a live 2-D canvas can put one redrawn label in nearly every
/// 32-pixel block. When *all* models miss the normal audit, let exactly one overwhelmingly supported feature model
/// reach native refinement. Native evidence still decides whether it is a measurement; this gate only avoids
/// discarding the candidate before that evidence is computed.
const NEAR_MISS_MIN_SUPPORT: u32 = 64;
const NEAR_MISS_MIN_CONFIDENCE: f64 = 0.75;
const NEAR_MISS_MIN_AGREEMENT: f64 = 0.20;

fn near_miss_audit(m: &Motion, audit: &Audit) -> bool {
    !m.ambiguous
        && m.support >= NEAR_MISS_MIN_SUPPORT
        && m.confidence >= NEAR_MISS_MIN_CONFIDENCE
        && js_hypot(m.x, m.y) > 1.0
        && audit.overlap > 0.50
        && audit.error < 20.0
        && audit.mismatch < 0.35
        && audit.agreement >= NEAR_MISS_MIN_AGREEMENT
        && audit.agreeing >= 20
        && audit.agreeing_error < 8.0
}

fn dominant_near_miss(m: &Motion, audit: &Audit, runner_support: u32) -> bool {
    near_miss_audit(m, audit) && m.support >= runner_support.saturating_mul(2)
}

/// A dominant near miss is accepted only when the native image independently shows a large, distinct basin: the
/// stable 75% clears the ordinary tracked bar and costs less than 45% of an offset more than two pixels away.
fn near_miss_rescuable(m: &Motion, audit: &Audit, n: &NativeRefinement) -> bool {
    near_miss_audit(m, audit)
        && n.error >= TRACKED_ERROR
        && n.error.is_finite()
        && n.samples >= 64
        && n.trimmed < TRACKED_ERROR
        && n.trimmed < CONTENT_CHANGE_RESCUE_SHARE * n.runner_up
}
'''
source = replace_once(source, anchor, addition, "insert near-miss gates")

old_scored = r'''    let mut scored: Vec<_> = models
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
'''
new_scored = r'''    let audited: Vec<_> = models
        .into_iter()
        .map(|m| {
            let audit = audit_translation(previous_gray, g, m.x, m.y, Some(roi), f > 1.0);
            (m, audit)
        })
        .collect();
    let mut scored: Vec<_> = audited
        .iter()
        .filter(|(_, audit)| {
            audit.overlap > 0.10
                && audit.error.is_finite()
                && ((audit.error < 14.0 && audit.mismatch < 0.2)
                    || (audit.agreement >= 0.4
                        && audit.agreeing >= 3
                        && audit.agreeing_error < 8.0))
        })
        .cloned()
        .collect();
    if scored.is_empty() {
        let runner_support = audited.get(1).map_or(0, |(m, _)| m.support);
        if let Some((m, audit)) = audited
            .first()
            .filter(|(m, audit)| dominant_near_miss(m, audit, runner_support))
        {
            scored.push((m.clone(), *audit));
        }
    }
'''
source = replace_once(source, old_scored, new_scored, "retain one dominant audit near miss")

old_measured = r'''            || content_change_rescuable(
                best_n,
                best_audit.agreement,
                best_audit.agreeing,
                best_audit.agreeing_error,
            )
            || best_n.error.is_finite() && {
'''
new_measured = r'''            || content_change_rescuable(
                best_n,
                best_audit.agreement,
                best_audit.agreeing,
                best_audit.agreeing_error,
            )
            || near_miss_rescuable(best_m, best_audit, best_n)
            || best_n.error.is_finite() && {
'''
source = replace_once(source, old_measured, new_measured, "accept native-confirmed near miss")

old_test_import = r'''    use super::{content_change_rescuable, measured_between_pixels, rescuable};
'''
new_test_import = r'''    use super::{
        content_change_rescuable, dominant_near_miss, measured_between_pixels,
        near_miss_rescuable, rescuable,
    };
'''
source = replace_once(source, old_test_import, new_test_import, "import near-miss tests")

old_motion_import = r'''    use crate::kernels::motion::{
        sampling_insensitive_error, select_native_points, NativeRefinement,
    };
'''
new_motion_import = r'''    use crate::kernels::motion::{
        sampling_insensitive_error, select_native_points, Audit, Motion, NativeRefinement,
    };
'''
source = replace_once(source, old_motion_import, new_motion_import, "import near-miss fixtures")

marker = r'''    const PAGE: (usize, usize) = (400, 900);
'''
tests = r'''    fn motion(support: u32, confidence: f64, ambiguous: bool) -> Motion {
        Motion {
            x: -20.0,
            y: 45.0,
            support,
            unique: support,
            confidence,
            error: 0.0,
            ambiguous,
        }
    }

    fn audit(agreement: f64, error: f64, mismatch: f64) -> Audit {
        Audit {
            error,
            mismatch,
            overlap: 0.84,
            samples: 1_000,
            blocks: 136,
            agreeing: (agreement * 136.0).round() as u32,
            agreement,
            agreeing_error: 6.6,
        }
    }

    #[test]
    fn only_a_dominant_native_confirmed_audit_near_miss_is_rescuable() {
        let m = motion(125, 0.88, false);
        let a = audit(0.375, 16.32, 0.255);
        assert!(dominant_near_miss(&m, &a, 23));
        assert!(near_miss_rescuable(&m, &a, &n(18.8, 8.7, 20.8)));

        assert!(!dominant_near_miss(&m, &a, 63));
        assert!(!dominant_near_miss(&motion(63, 0.88, false), &a, 20));
        assert!(!dominant_near_miss(&motion(125, 0.74, false), &a, 20));
        assert!(!dominant_near_miss(&motion(125, 0.88, true), &a, 20));
        assert!(!dominant_near_miss(&m, &audit(0.19, 16.0, 0.25), 20));
        assert!(!dominant_near_miss(&m, &audit(0.4, 20.0, 0.25), 20));
        assert!(!dominant_near_miss(&m, &audit(0.4, 16.0, 0.35), 20));

        assert!(!near_miss_rescuable(&m, &a, &n(13.9, 5.0, 25.0)));
        assert!(!near_miss_rescuable(&m, &a, &n(18.8, 14.0, 40.0)));
        assert!(!near_miss_rescuable(&m, &a, &n(18.8, 8.7, 19.0)));
    }

''' + marker
source = replace_once(source, marker, tests, "insert near-miss tests")

TARGET.write_text(source, encoding="utf-8")
