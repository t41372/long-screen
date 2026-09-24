//! Per-region, per-frame tracking decisions (R4b/R4c/R4d): the *stateless* verdicts and stateful-shell-facing
//! kernels of `src/pipeline/solve/track.ts`, byte-for-byte ports of the frozen oracle in
//! `tests/support/reference/track.ts`. Every function is pure: plain scalars/tuples in, a plain result out, no
//! I/O, no state carried between calls (the stateful per-region tracker — previous features, velocity, anchor
//! patches — stays in TS, R4c 3b-iii measured no gain from a stateful core-side tracker).
//!
//! Split (R6-B, final-verify-report.md item 10: this was one 842-line file) into one module per concern,
//! mirroring `regions/`'s precedent: `verdicts` (small stateless decisions), `odometry` (frame-to-frame
//! tracking), `reacquire` (anchor re-acquisition + drift correction), `keyframes` (candidate scoring). Every
//! item is re-exported here so `crate::track::X` paths elsewhere (the ABI layer, this module's own tests) are
//! unchanged by the split.

mod keyframes;
mod odometry;
mod reacquire;
mod verdicts;

pub use keyframes::*;
pub use odometry::*;
pub use reacquire::*;
pub use verdicts::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motion::MatchPoints;

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
