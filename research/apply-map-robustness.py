#!/usr/bin/env python3
"""Apply the current map-robustness experiment to the native odometry core.

This is deliberately an exact source-to-source transform so CI fails loudly when main moves.
The emitted git diff is archived by the research workflow and becomes the candidate patch.
"""

from pathlib import Path

TARGET = Path("rust/long-screen/src/kernels/track/odometry.rs")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source match, found {count}")
    return source.replace(old, new, 1)


source = TARGET.read_text(encoding="utf-8")

old_rescue = r'''fn rescuable(n: &NativeRefinement) -> bool {
    n.error >= TRACKED_ERROR
        && n.error.is_finite()
        && n.runner_up > RESCUE_SEPARATION * n.error
        && n.trimmed < RESCUE_SHARE * n.runner_up
}
'''
new_rescue = old_rescue + r'''
/// A map, game canvas or other live 2-D surface can redraw a minority of its strongest edges while the stable
/// background still translates rigidly. The per-cell sampler intentionally chooses strong edges, so that minority
/// is over-represented in the plain mean. Accept it only when the already-computed block audit independently found
/// a distributed consensus, the stable 75% of native samples clears the normal tracked-error bar, and an offset more
/// than two pixels away costs over 2.2x as much. Unlike the sub-pixel fallback this needs no extra image pass.
const CONTENT_CHANGE_RESCUE_SHARE: f64 = 0.45;

fn content_change_rescuable(
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
source = replace_once(source, old_rescue, new_rescue, "insert content-change rescue")

old_measured = r'''        let measured = best_n.error < TRACKED_ERROR
            || rescuable(best_n)
            || best_n.error.is_finite() && {
                let (error, runner_up) = sampling_insensitive_error(
                    previous,
                    current,
                    image_width as usize,
                    image_height as usize,
                    (best_n.x, best_n.y),
                    mask,
                    radius,
                    &points,
                );
                measured_between_pixels(error, runner_up)
            };
'''
new_measured = r'''        let measured = best_n.error < TRACKED_ERROR
            || rescuable(best_n)
            || content_change_rescuable(
                best_n,
                best_audit.agreement,
                best_audit.agreeing,
                best_audit.agreeing_error,
            )
            || best_n.error.is_finite() && {
                let (error, runner_up) = sampling_insensitive_error(
                    previous,
                    current,
                    image_width as usize,
                    image_height as usize,
                    (best_n.x, best_n.y),
                    mask,
                    radius,
                    &points,
                );
                measured_between_pixels(error, runner_up)
            };
'''
source = replace_once(source, old_measured, new_measured, "use content-change rescue")

old_sort = r'''    refined.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal));

    let mut rescue = None;
'''
new_sort = r'''    refined.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal));

    // Native-only research probe. It is compiled out of Wasm and does no work unless explicitly enabled.
    // Keep it next to the final evidence bundle so a failed real recording can be diagnosed without changing
    // any decision, score, ordering or persisted output.
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var_os("LONG_SCREEN_TRACE_ODOMETRY").is_some() {
        match refined.first() {
            Some((m, audit, n, key)) => eprintln!(
                concat!(
                    "LS_ODO f={:.3} velocity=({:.3},{:.3}) points={} ",
                    "model=({:.3},{:.3}) support={} model_conf={:.6} model_ambiguous={} ",
                    "audit_overlap={:.6} audit_error={:.6} audit_mismatch={:.6} ",
                    "audit_agreement={:.6} audit_agreeing={} audit_agreeing_error={:.6} audit_blocks={} ",
                    "native=({},{}) native_error={:.6} native_trimmed={:.6} ",
                    "native_runner_up={:.6} native_samples={} change_rescue={} key={:.6}"
                ),
                f,
                velocity.0,
                velocity.1,
                points.len(),
                m.x,
                m.y,
                m.support,
                m.confidence,
                m.ambiguous,
                audit.overlap,
                audit.error,
                audit.mismatch,
                audit.agreement,
                audit.agreeing,
                audit.agreeing_error,
                audit.blocks,
                n.x,
                n.y,
                n.error,
                n.trimmed,
                n.runner_up,
                n.samples,
                content_change_rescuable(n, audit.agreement, audit.agreeing, audit.agreeing_error),
                key,
            ),
            None => eprintln!(
                "LS_ODO f={f:.3} velocity=({:.3},{:.3}) points={} no_refined_hypothesis",
                velocity.0,
                velocity.1,
                points.len(),
            ),
        }
    }

    let mut rescue = None;
'''
source = replace_once(source, old_sort, new_sort, "insert odometry trace")

old_import = "    use super::{measured_between_pixels, rescuable};\n"
new_import = "    use super::{content_change_rescuable, measured_between_pixels, rescuable};\n"
source = replace_once(source, old_import, new_import, "import rescue helper in tests")

old_test_tail = r'''        assert!(!rescuable(&n(f64::INFINITY, 2.8, f64::INFINITY)));
        assert!(!rescuable(&n(51.8, 39.1, 54.0)));
    }
    const PAGE: (usize, usize) = (400, 900);
'''
new_test_tail = r'''        assert!(!rescuable(&n(f64::INFINITY, 2.8, f64::INFINITY)));
        assert!(!rescuable(&n(51.8, 39.1, 54.0)));
    }

    #[test]
    fn only_spatially_consistent_local_content_change_is_rescuable() {
        // Two real map steps: the plain mean is contaminated by redrawn labels/POIs, while the stable majority and
        // the block audit independently agree on the same translation.
        assert!(content_change_rescuable(
            &n(18.765, 8.690, 20.752),
            0.441,
            63,
            6.802,
        ));
        assert!(content_change_rescuable(
            &n(24.920, 11.390, 28.350),
            0.500,
            50,
            5.700,
        ));

        // It is not a second general-purpose error threshold: the plain mean must have rejected the step, the
        // stable majority must itself clear that threshold, a distant offset must be clearly worse, and the
        // independent block audit must have enough low-error support.
        assert!(!content_change_rescuable(&n(13.9, 5.0, 25.0), 0.5, 20, 5.0));
        assert!(!content_change_rescuable(&n(18.0, 14.0, 40.0), 0.5, 20, 5.0));
        assert!(!content_change_rescuable(&n(18.0, 8.5, 18.0), 0.5, 20, 5.0));
        assert!(!content_change_rescuable(&n(18.0, 7.0, 24.0), 0.39, 20, 5.0));
        assert!(!content_change_rescuable(&n(18.0, 7.0, 24.0), 0.5, 2, 5.0));
        assert!(!content_change_rescuable(&n(18.0, 7.0, 24.0), 0.5, 20, 8.0));
        assert!(!content_change_rescuable(
            &n(f64::INFINITY, 7.0, 24.0),
            0.5,
            20,
            5.0,
        ));
    }
    const PAGE: (usize, usize) = (400, 900);
'''
source = replace_once(source, old_test_tail, new_test_tail, "insert content-change rescue tests")

TARGET.write_text(source, encoding="utf-8")
