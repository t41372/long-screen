//! Per-region tracking kernels: translation evidence, keyframe scoring and stateless verdicts.
//! Stateful sequencing and registration-window lifetime belong to `engine::solve`; these kernels do no I/O.
//! `phase` supplies the additional evidence and geometry support used only after a phase rescue is needed.
//! The historical TS implementations remain parity references for unchanged paths.

mod keyframes;
mod odometry;
mod phase;
mod reacquire;
mod screen_fixed;
mod verdicts;

pub use keyframes::*;
pub use odometry::*;
pub use phase::{registration_features, registration_support};
pub use reacquire::*;
pub use screen_fixed::ScreenFixed;
pub use verdicts::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::motion::MatchPoints;

    // Failure cases, from a recording's trace (implied step, rescue): the ambiguous alias at frame 230
    // ((0, -1562), (0, 228)), a snap-back onto a screen-fixed panel at frame 1394 ((0, 0), (0, -336)) and frame 1527
    // ((0, -358), (0, -800)) kept over the rescue; the same step measured both ways (frame 1175, (0, 951) and (0, 948))
    // or a step of zero both ways refused.
    #[test]
    fn a_reacquisition_contradicts_the_rescue_only_by_a_different_place() {
        assert!(reacquisition_contradicts_rescue(
            (0.0, -1562.0),
            (0.0, 228.0)
        ));
        assert!(reacquisition_contradicts_rescue((0.0, 0.0), (0.0, -336.0)));
        assert!(reacquisition_contradicts_rescue(
            (0.0, -358.0),
            (0.0, -800.0)
        ));
        assert!(reacquisition_contradicts_rescue((16.0, 0.0), (0.0, 0.0)));
        assert!(!reacquisition_contradicts_rescue(
            (0.0, 951.0),
            (0.0, 948.0)
        ));
        assert!(!reacquisition_contradicts_rescue((0.0, 0.0), (0.0, 0.0)));
        assert!(!reacquisition_contradicts_rescue((11.0, 11.0), (0.0, 0.0)));
    }

    #[test]
    fn uncertainty_thresholds() {
        assert!(uncertainty(0.5999999999999999, false, false));
        assert!(!uncertainty(0.6, false, false));
        assert!(uncertainty(0.9, true, false));
        assert!(uncertainty(0.9, false, true));
    }

    #[test]
    fn needs_keyframe_no_prior_node_always_true() {
        assert!(needs_keyframe(
            true,
            None,
            (0.0, 0.0),
            None,
            (100.0, 100.0),
            5,
            0.0
        ));
        assert!(needs_keyframe(
            false,
            None,
            (0.0, 0.0),
            None,
            (100.0, 100.0),
            5,
            0.0
        ));
    }

    #[test]
    fn needs_keyframe_fixed_kind_never_after_first_node() {
        assert!(!needs_keyframe(
            false,
            Some((0.0, 0.0)),
            (1000.0, 1000.0),
            Some(0),
            (100.0, 100.0),
            500,
            1.0
        ));
    }

    #[test]
    fn needs_keyframe_anchor_distance_threshold() {
        // rect min*0.3 = 30 < 48, so the floor of 48 applies.
        assert!(!needs_keyframe(
            true,
            Some((0.0, 0.0)),
            (48.0, 0.0),
            Some(0),
            (100.0, 100.0),
            1,
            0.0
        ));
        assert!(needs_keyframe(
            true,
            Some((0.0, 0.0)),
            (48.0001, 0.0),
            Some(0),
            (100.0, 100.0),
            1,
            0.0
        ));
    }

    #[test]
    fn loop_closure_verdict_branches() {
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.9, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::Closure);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.9, (0.0, 0.0), (20.0, 0.0));
        assert_eq!(v, LoopVerdict::Inconsistent);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), true, 0.9, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::Ambiguous);
        let (v, _) =
            loop_closure_verdict((0.0, 0.0), (0.0, 0.0), false, 0.5, (0.0, 0.0), (1.0, 0.0));
        assert_eq!(v, LoopVerdict::None);
    }

    #[test]
    fn region_zoom_gate() {
        assert!(region_zoom(false, &[]).is_none());
        let few: Vec<MatchPoints> = (0..7)
            .map(|i| MatchPoints {
                ax: i as f64,
                ay: 0.0,
                bx: i as f64,
                by: 0.0,
                unique: true,
            })
            .collect();
        assert!(region_zoom(true, &few).is_none());
        let enough: Vec<MatchPoints> = (0..8)
            .map(|i| MatchPoints {
                ax: i as f64,
                ay: 0.0,
                bx: i as f64 + 1.0,
                by: 0.0,
                unique: true,
            })
            .collect();
        assert!(region_zoom(true, &enough).is_some());
    }
}
