//! The solve session's failure cases, written down before the session was: steps called out of order or with
//! malformed input; the duplicate-frame shortcut taken when a region is blind or there is no plan to replay; a
//! revisit search that never resumes, or resumes with rows the store lost; a pose driven non-finite or out of range
//! by odometry or drift control, which must start a fresh fragment and never reach a placement; an attachment or
//! thin-overlap correction with an invalid pose, which must be rejected before anything is stored; a step the plain
//! native error rejected but odometry measured, which must be placed instead of starting a fragment (and only then),
//! and which an anchor re-acquisition that contradicts it must not replace; and frames still in the voting ring when
//! the frames end, which must still be finalised.
//!
//! Frames are windows onto a synthetic textured page; [`Seams`] replaces a core decision where a test needs one.

use super::*;
use crate::engine::pose_graph::PoseRow;
use crate::kernels::track::{
    DriftEstimate, OdometryDecision, OdometryEstimate, ReacquireEstimate, Rescue,
};

type OdometrySeam = Box<dyn FnMut(u32, &mut OdometryEstimate) -> bool>;
type Seam<T> = Box<dyn FnMut(&mut Option<T>)>;

/// Replacements for core decisions. `odometry` may edit a frame's estimate and returns whether that frame's anchor
/// re-acquisition fails; `reacquire` may replace a re-acquisition's result; `thin` also opens the thin-overlap gate.
#[derive(Default)]
pub(crate) struct Seams {
    pub odometry: Option<OdometrySeam>,
    pub reacquire_fails: bool,
    pub reacquire: Option<Seam<ReacquireEstimate>>,
    pub drift: Option<Seam<DriftEstimate>>,
    pub attach: Option<Seam<(f64, f64)>>,
    pub thin: Option<Seam<((f64, f64), f64)>>,
}

const W: usize = 160;
const H: usize = 120;
const PAGE: usize = 900;

/// A page of overlapping random rectangles over a noise floor: corners everywhere, no repeating period.
fn page() -> Vec<u8> {
    let mut seed = 0x2545_f491u32;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut luma: Vec<u8> = (0..W * PAGE).map(|_| 100 + (next() % 24) as u8).collect();
    for _ in 0..1600 {
        let (w, h) = (4 + next() as usize % 22, 3 + next() as usize % 14);
        let (x, y) = (next() as usize % (W - w), next() as usize % (PAGE - h));
        let v = (next() % 256) as u8;
        for row in y..y + h {
            luma[row * W + x..row * W + x + w].fill(v);
        }
    }
    let mut rgba = vec![255u8; W * PAGE * 4];
    for (i, &v) in luma.iter().enumerate() {
        rgba[i * 4..i * 4 + 3].copy_from_slice(&[v, v / 2 + 40, 255 - v]);
    }
    rgba
}

fn window(page: &[u8], offset: usize) -> &[u8] {
    &page[offset * W * 4..(offset + H) * W * 4]
}

fn session(moving: bool) -> SolveSession {
    session_sized(moving, W, H)
}

fn session_sized(moving: bool, width: usize, height: usize) -> SolveSession {
    session_with(moving, width, height, Vec::new(), Vec::new())
}

fn session_with(
    moving: bool,
    width: usize,
    height: usize,
    exclusions: Vec<Rect>,
    epochs: Vec<RegionEpoch>,
) -> SolveSession {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        width: width as f64,
        height: height as f64,
    };
    SolveSession::new(SolveConfig {
        width,
        height,
        factor: 2,
        radius: 3,
        noise: 0.0,
        voting_budget: VOTING_RING_BYTES,
        regions: vec![SolveRegion {
            id: "body".into(),
            name: "页面".into(),
            moving,
            kind: if moving { "moving" } else { "fixed" }.into(),
            unassigned: false,
            code: 1,
            shape: Shape {
                rect,
                exclusions,
                crop: None,
                solid: false,
                mask: None,
            },
            epochs,
        }],
    })
}

fn scan() -> ScanFields {
    ScanFields {
        duplicate: false,
        zoom: 1.0,
        difference: 0.5,
    }
}

/// A host: stores keyframe rows, hands them back when asked, and keeps every effect.
#[derive(Default)]
struct Host {
    keyframes: HashMap<String, Keyframe>,
    effects: Vec<Effect>,
    asked: usize,
    lose_rows: bool,
    /// Scan difference below drift control's threshold.
    still: bool,
}

impl Host {
    fn take(&mut self, s: &mut SolveSession) {
        for e in s.take_effects() {
            if let Effect::Keyframe(k) = &e {
                self.keyframes.insert(k.id.clone(), (**k).clone());
            }
            self.effects.push(e);
        }
    }

    fn frame(&mut self, s: &mut SolveSession, index: u32, pixels: &[u8]) -> FrameDone {
        let fields = ScanFields {
            difference: if self.still { 0.05 } else { 0.5 },
            ..scan()
        };
        match s.begin_frame(index, index as f64 / 30.0, fields).unwrap() {
            Begin::NeedFrame { .. } => {}
            Begin::Duplicate(_) => panic!("not a duplicate"),
        }
        s.frame_mut().copy_from_slice(pixels);
        let labels = vec![1u8; s.width() * s.height()];
        let mut poll = s.run_frame(None, None, &labels);
        loop {
            self.take(s);
            match poll.unwrap() {
                Poll::Done(done) => return done,
                Poll::NeedKeyframes(ids) => {
                    self.asked += 1;
                    let rows = ids
                        .iter()
                        .map(|id| {
                            (!self.lose_rows)
                                .then(|| self.keyframes.get(id).cloned())
                                .flatten()
                        })
                        .collect();
                    poll = s.provide_keyframes(rows, &labels);
                }
            }
        }
    }

    fn codes(&self) -> Vec<&'static str> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Diagnostic(d) => Some(d.code),
                _ => None,
            })
            .collect()
    }

    fn canvases(&self) -> Vec<&CanvasMeta> {
        self.effects
            .iter()
            .filter_map(|e| match e {
                Effect::Canvas {
                    meta,
                    created: true,
                } => Some(meta),
                _ => None,
            })
            .collect()
    }
}

/// Scrolls `steps` frames of `step` pixels down the page.
fn scroll(
    host: &mut Host,
    s: &mut SolveSession,
    page: &[u8],
    steps: u32,
    step: usize,
) -> Vec<FrameDone> {
    (0..steps)
        .map(|i| host.frame(s, i, window(page, i as usize * step)))
        .collect()
}

#[test]
fn steps_out_of_order_are_refused() {
    let mut s = session(true);
    let labels = vec![1u8; W * H];
    assert_eq!(
        s.run_frame(None, None, &labels),
        Err(SolveError::BadInput("no frame was asked for"))
    );
    assert!(s.provide_keyframes(Vec::new(), &labels).is_err());
    s.begin_frame(0, 0.0, scan()).unwrap();
    assert!(s.begin_frame(1, 0.1, scan()).is_err());
    assert_eq!(
        s.run_frame(None, None, &labels[1..]),
        Err(SolveError::BadInput(
            "the label plane does not match the frame"
        ))
    );
    // A host gray of the wrong size.
    s.begin_frame(0, 0.0, scan()).unwrap();
    assert!(s.run_frame(Some(vec![0; 3]), None, &labels).is_err());
}

#[test]
fn a_steady_scroll_stays_on_one_canvas_at_the_scrolled_offset() {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let frames = scroll(&mut host, &mut s, &page, 12, 7);
    for (i, f) in frames.iter().enumerate() {
        let p = &f.placements[0];
        assert_eq!(p.canvas_id, "body-part-0", "frame {i}");
        assert_eq!((p.x, p.y), (0.0, (i * 7) as f64), "frame {i}");
        assert!(!p.skip);
    }
    assert_eq!(host.canvases().len(), 1);
    // Every frame observed by the moving region joins the ring.
    assert!(frames.iter().all(|f| f.joined_ring));
}

#[test]
fn the_duplicate_shortcut_needs_a_plan_and_no_blind_region() {
    let page = page();
    let mut s = session(true);
    let dup = ScanFields {
        duplicate: true,
        ..scan()
    };
    // No plan yet: the pixels are asked for.
    assert!(matches!(
        s.begin_frame(0, 0.0, dup),
        Ok(Begin::NeedFrame { gray: true })
    ));
    s.frame_mut().copy_from_slice(window(&page, 0));
    let labels = vec![1u8; W * H];
    let Poll::Done(first) = s.run_frame(None, None, &labels).unwrap() else {
        panic!("no keyframes exist yet")
    };
    // A plan exists and no region is blind: replayed at the new time, pixels untouched.
    match s.begin_frame(1, 0.5, dup).unwrap() {
        Begin::Duplicate(placements) => {
            assert_eq!(placements.len(), 1);
            assert_eq!(placements[0].time, 0.5);
            assert_eq!(placements[0].canvas_id, first.placements[0].canvas_id);
        }
        other => panic!("expected the shortcut, got {other:?}"),
    }
    // A blank frame makes the region blind: the next duplicate is solved, reusing the previous gray.
    let mut blank = session(true);
    blank.begin_frame(0, 0.0, scan()).unwrap();
    blank.frame_mut().fill(128);
    let Poll::Done(done) = blank.run_frame(None, None, &labels).unwrap() else {
        panic!()
    };
    assert!(done.placements[0].skip);
    assert!(matches!(
        blank.begin_frame(1, 0.1, dup),
        Ok(Begin::NeedFrame { gray: false })
    ));
}

#[test]
fn a_revisit_asks_for_keyframes_and_closes_the_loop() {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let offsets: Vec<usize> = (0..40)
        .map(|i| i * 12)
        .chain((0..40).rev().map(|i| i * 12))
        .collect();
    for (i, &o) in offsets.iter().enumerate() {
        host.frame(&mut s, i as u32, window(&page, o));
    }
    assert!(host.asked > 0, "no revisit search reached the store");
    assert!(host.codes().contains(&"LOOP_CLOSURE"), "{:?}", host.codes());
    assert!(s.graph().loops() > 0);
}

#[test]
fn lost_keyframe_rows_are_no_match() {
    let page = page();
    let (mut host, mut s) = (
        Host {
            lose_rows: true,
            ..Host::default()
        },
        session(true),
    );
    let offsets: Vec<usize> = (0..40)
        .map(|i| i * 12)
        .chain((0..40).rev().map(|i| i * 12))
        .collect();
    for (i, &o) in offsets.iter().enumerate() {
        host.frame(&mut s, i as u32, window(&page, o));
    }
    assert!(host.asked > 0);
    assert!(!host.codes().contains(&"LOOP_CLOSURE"));
}

/// Poisons the first tracked odometry step of frame 3 onwards with `delta`.
fn poisoned_odometry(delta: (f64, f64)) -> (Host, Vec<FrameDone>) {
    let page = page();
    // Drift control off: core's patch search adds the radius to the pose's integer guess, which a debug build's
    // overflow check rejects for a pose this far out (a release build wraps, and the search finds nothing).
    let (mut host, mut s) = (
        Host {
            still: true,
            ..Host::default()
        },
        session(true),
    );
    let mut done = false;
    s.seams.odometry = Some(Box::new(move |frame, est| {
        if !done && frame >= 3 && est.decision == OdometryDecision::Tracked {
            done = true;
            est.delta = delta;
        }
        false
    }));
    let frames = scroll(&mut host, &mut s, &page, 8, 7);
    (host, frames)
}

fn assert_isolated(host: &Host, frames: &[FrameDone]) {
    assert_eq!(
        host.codes()
            .iter()
            .filter(|c| **c == "NONFINITE_POSE")
            .count(),
        1,
        "{:?}",
        host.codes()
    );
    assert!(
        host.canvases().len() > 1,
        "the recovery starts a fresh canvas"
    );
    for f in frames {
        for p in &f.placements {
            assert!(is_valid_pose(p.x, p.y), "placement {p:?}");
        }
    }
    for e in &host.effects {
        if let Effect::Graph(Write::Put(PoseRow::Node(n))) = e {
            assert!(is_valid_pose(n.x, n.y));
        }
    }
}

#[test]
fn a_non_finite_odometry_step_starts_a_fresh_fragment() {
    let (host, frames) = poisoned_odometry((f64::NAN, f64::NAN));
    assert_isolated(&host, &frames);
}

#[test]
fn an_out_of_range_odometry_step_starts_a_fresh_fragment() {
    for v in [1e12, POSE_BOUND, f64::INFINITY, f64::NEG_INFINITY] {
        let (host, frames) = poisoned_odometry((0.0, v));
        assert_isolated(&host, &frames);
    }
}

#[test]
fn a_non_finite_drift_correction_starts_a_fresh_fragment() {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let mut done = false;
    s.seams.drift = Some(Box::new(move |d| {
        if !done && d.is_some() {
            done = true;
            *d = Some(DriftEstimate {
                x: f64::NAN,
                y: 3.0,
                error: 0.0,
                confidence_floor: 0.5,
            });
        }
    }));
    let frames = scroll(&mut host, &mut s, &page, 10, 7);
    assert_isolated(&host, &frames);
}

#[test]
fn an_invalid_attachment_or_correction_is_rejected_before_it_is_stored() {
    let page = page();
    let offsets: Vec<usize> = (0..40)
        .map(|i| i * 12)
        .chain((0..40).rev().map(|i| i * 12))
        .collect();
    let (mut host, mut s) = (Host::default(), session(true));
    let calls = std::rc::Rc::new(std::cell::Cell::new((0, 0)));
    let (a, t) = (calls.clone(), calls.clone());
    s.seams.attach = Some(Box::new(move |v| {
        a.set((a.get().0 + 1, a.get().1));
        *v = Some((f64::NAN, 0.0));
    }));
    s.seams.thin = Some(Box::new(move |c| {
        t.set((t.get().0, t.get().1 + 1));
        *c = Some(((0.0, f64::INFINITY), 1.0));
    }));
    for (i, &o) in offsets.iter().enumerate() {
        host.frame(&mut s, i as u32, window(&page, o));
    }
    assert!(host.asked > 0);
    assert!(
        calls.get().0 > 0 && calls.get().1 > 0,
        "both seams saw a revisit: {:?}",
        calls.get()
    );
    let codes = host.codes();
    assert!(!codes.contains(&"FRAGMENT_ATTACHED"));
    assert!(!codes.contains(&"TRAJECTORY_CORRECTED"));
    assert!(!codes.contains(&"NONFINITE_POSE"));
    assert!(!host
        .effects
        .iter()
        .any(|e| matches!(e, Effect::Attachment(_))));
}

/// Rejects the first tracked step of frame 3 onwards (and its anchor re-acquisition), offering the measured step as a
/// rescue or not.
fn rejected(rescue: bool) -> (Host, Vec<FrameDone>) {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let mut done = false;
    s.seams.odometry = Some(Box::new(move |frame, est| {
        if done || frame < 3 || est.decision != OdometryDecision::Tracked {
            return false;
        }
        done = true;
        est.decision = OdometryDecision::Lost;
        est.rescue = rescue.then_some(Rescue {
            phase_support: false,
            delta: est.delta,
            confidence: est.confidence,
            ambiguous: est.ambiguous,
            weak_step: est.weak_step,
            step_error: est.step_error,
        });
        true
    }));
    let frames = scroll(&mut host, &mut s, &page, 8, 7);
    (host, frames)
}

#[test]
fn a_rejected_step_that_odometry_measured_is_placed_instead_of_a_fragment() {
    let (host, frames) = rejected(true);
    assert_eq!(host.canvases().len(), 1, "{:?}", host.codes());
    for (i, f) in frames.iter().enumerate() {
        assert_eq!(f.placements[0].y, (i * 7) as f64);
    }
    let (host, _) = rejected(false);
    assert!(
        host.codes().contains(&"UNPLACED_FRAGMENT")
            || host.codes().contains(&"SCALE_CHANGE_FRAGMENT")
    );
    assert_eq!(host.canvases().len(), 2);
}

/// Rejects the first tracked step of frame 3 onwards and offers it as a rescue, as [`rejected`] does, but lets the
/// anchor re-acquisition succeed with `found` (relative to the anchor, frame 0 at the origin: the scroll stays within
/// a keyframe's distance until frame 3).
fn reacquired(found: ReacquireEstimate) -> (Host, Vec<FrameDone>) {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let mut done = false;
    s.seams.odometry = Some(Box::new(move |frame, est| {
        if done || frame < 3 || est.decision != OdometryDecision::Tracked {
            return false;
        }
        done = true;
        est.decision = OdometryDecision::Lost;
        est.rescue = Some(Rescue {
            phase_support: false,
            delta: est.delta,
            confidence: 0.3,
            ambiguous: false,
            weak_step: false,
            step_error: 20.0,
        });
        false
    }));
    let mut found = Some(found);
    s.seams.reacquire = Some(Box::new(move |top| {
        if let Some(found) = found.take() {
            *top = Some(found);
        }
    }));
    let frames = scroll(&mut host, &mut s, &page, 8, 7);
    (host, frames)
}

// Failure cases for a re-acquisition that contradicts odometry's rescue: one that snaps back onto the anchor (a
// screen-fixed panel matches at zero offset, with more confidence than the rescue), and an ambiguous, barely
// confident one on a periodic alias. Either replaced the measured step, and every later frame inherited the error.
// One that agrees with the rescue to within a few pixels still places the frame, through the anchor.
#[test]
fn a_reacquisition_that_contradicts_the_rescue_does_not_replace_it() {
    let estimate = |y: i32, ambiguous: bool, confidence: f64| ReacquireEstimate {
        x: 0,
        y,
        ambiguous,
        confidence,
        error: 4.0,
    };
    for (found, case) in [
        (estimate(0, false, 0.45), "snap-back"),
        (estimate(-90, true, 0.04), "alias"),
    ] {
        let (host, frames) = reacquired(found);
        assert_eq!(host.canvases().len(), 1, "{case}: {:?}", host.codes());
        for (i, f) in frames.iter().enumerate() {
            assert_eq!(f.placements[0].y, (i * 7) as f64, "{case}, frame {i}");
        }
    }
    let (_, frames) = reacquired(estimate(24, false, 0.9));
    assert_eq!(frames[3].placements[0].y, 24.0);
}

#[test]
fn a_fixed_region_is_placed_once_at_the_origin() {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(false));
    let frames = scroll(&mut host, &mut s, &page, 4, 7);
    assert_eq!(host.canvases().len(), 1);
    assert!(frames
        .iter()
        .all(|f| (f.placements[0].x, f.placements[0].y) == (0.0, 0.0) && !f.joined_ring));
}

#[test]
fn frames_still_in_the_ring_are_finalised_by_the_drain() {
    let page = page();
    let (mut host, mut s) = (Host::default(), session(true));
    let frames = scroll(&mut host, &mut s, &page, 6, 7);
    let pushed: usize = frames.iter().map(|f| f.voting.len()).sum();
    let drained = s.drain_voting();
    assert_eq!(
        pushed + drained.len(),
        6,
        "every observed frame is finalised once"
    );
    assert!(drained.iter().all(|r| r.voted_layers <= 1));
}

// A phase hypothesis is not permission to change an already recovered tracking path.
#[test]
fn registration_support_activates_only_when_the_phase_rescue_is_used() {
    for fail_anchor in [false, true] {
        let page = page();
        let mut host = Host::default();
        let mut s = session(true);
        s.seams.odometry = Some(Box::new(move |frame, est| {
            if frame != 3 {
                return false;
            }
            est.decision = OdometryDecision::Lost;
            est.rescue = Some(Rescue {
                phase_support: true,
                delta: est.delta,
                confidence: 0.3,
                ambiguous: false,
                weak_step: false,
                step_error: 20.0,
            });
            fail_anchor
        }));
        if !fail_anchor {
            s.seams.reacquire = Some(Box::new(|top| {
                *top = Some(ReacquireEstimate {
                    x: 0,
                    y: 21,
                    ambiguous: false,
                    confidence: 0.9,
                    error: 1.0,
                });
            }));
        }
        scroll(&mut host, &mut s, &page, 4, 7);
        assert_eq!(s.states[0].phase_support, fail_anchor);
    }
}

#[test]
fn registration_support_preserves_a_thin_overlap_step() {
    let original = page();
    let (w, h) = (W * 4, H * 4);
    let mut page = vec![0; w * PAGE * 4 * 4];
    for y in 0..PAGE * 4 {
        for x in 0..w {
            let from = ((y / 4) * W + x / 4) * 4;
            let to = (y * w + x) * 4;
            page[to..to + 4].copy_from_slice(&original[from..from + 4]);
        }
    }
    for active in [false, true] {
        for jump in [200usize, 300, 420] {
            let mut host = Host::default();
            let mut s = session_sized(true, w, h);
            let support = Rect {
                x: 64.0,
                y: 48.0,
                width: 512.0,
                height: 384.0,
            };
            if active {
                s.states[0].phase_support = true;
                s.states[0].registration_support = Some(support);
            }
            for (i, offset) in [0, 28, 56, 56 + jump, 84 + jump].into_iter().enumerate() {
                let pixels = &page[offset * w * 4..(offset + h) * w * 4];
                let done = host.frame(&mut s, i as u32, pixels);
                if active && i == 0 {
                    assert!(s.states[0]
                        .previous_features
                        .as_ref()
                        .unwrap()
                        .iter()
                        .all(|p| support.contains(p.x as f64 * 2.0, p.y as f64 * 2.0)));
                }
                assert_eq!(done.placements[0].x, 0.0);
                assert_eq!(
                    done.placements[0].y, offset as f64,
                    "support {active}, jump {jump}, frame {i}"
                );
            }
            assert_eq!(host.canvases().len(), 1);
        }
    }
}

// Failure cases for ownership epochs in the solve session: a frame before an epoch already using its exclusions;
// the switch happening a frame late, or only on frames that mint a keyframe; the voting slot keeping the old inside
// and interior cells; a region without epochs being touched; the region's own exclusions lost when an epoch adds or
// removes some.
#[test]
fn a_region_takes_each_epochs_exclusions_from_its_first_frame() {
    let page = page();
    let own = Rect {
        x: 0.0,
        y: 0.0,
        width: W as f64,
        height: 4.0,
    };
    let band = Rect {
        x: 0.0,
        y: 40.0,
        width: W as f64,
        height: 20.0,
    };
    let epochs = vec![
        RegionEpoch {
            from: 3,
            exclusions: vec![band],
        },
        RegionEpoch {
            from: 6,
            exclusions: Vec::new(),
        },
    ];
    let mut s = session_with(true, W, H, vec![own], epochs);
    let interior_of = |s: &SolveSession| {
        s.voting.slots[0]
            .interior
            .iter()
            .filter(|&&c| c == 1)
            .count()
    };
    let mut host = Host::default();
    let mut interiors = Vec::new();
    for i in 0..8u32 {
        host.frame(&mut s, i, window(&page, i as usize * 7));
        let expected = if (3..6).contains(&i) {
            vec![own, band]
        } else {
            vec![own]
        };
        assert_eq!(s.regions[0].shape.exclusions, expected, "frame {i}");
        interiors.push(interior_of(&s));
    }
    assert!(
        interiors[3] < interiors[2],
        "the band leaves the interior: {interiors:?}"
    );
    assert_eq!(interiors[2], interiors[6], "and comes back");
    assert_eq!(interiors[3], interiors[5]);
    // Without epochs nothing changes, frame after frame.
    let mut plain = session(true);
    let before = plain.voting.slots[0].interior.clone();
    for i in 0..4u32 {
        Host::default().frame(&mut plain, i, window(&page, i as usize * 7));
    }
    assert!(plain.regions[0].shape.exclusions.is_empty());
    assert_eq!(plain.voting.slots[0].interior, before);
}
