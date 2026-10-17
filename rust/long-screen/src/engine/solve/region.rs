//! One region's step in one frame: the tracking decisions of `crate::kernels::track`, applied in their fixed
//! order — gate, odometry, anchor re-acquisition, the decision (tracked with drift control, static, blind, lost
//! with relocalization, rescue or a new fragment), pose recovery, the keyframe half (revisit search, attachment,
//! thin-overlap correction, the graph node and its loop edges, the new keyframe), and the placement with its
//! voting observation and sticky occlusions.
//!
//! A step that needs keyframe rows stops at the search and is resumed with them ([`Outcome::Wait`]).

use super::{
    is_valid_pose, Effect, FragmentScale, Keyframe, Placement, Plane, ScanFields, SolveError,
    SolveSession, PATCH_COUNT, PATCH_SIZE,
};
use crate::engine::attachments::{attachment_shift, resolve_target, Attachment};
use crate::engine::diagnostic::{Diagnostic, Severity, Value};
use crate::engine::keyframes::Retrieval;
use crate::engine::pose_graph::EdgeKind;
use crate::kernels::chrome::sticky_occlusions;
use crate::kernels::features::{match_features, Feature};
use crate::kernels::geometry::{js_round, Rect};
use crate::kernels::motion::{extract_patches, probe_scale, Gray, MatchPoints, Patch};
use crate::kernels::region::filter_features;
use crate::kernels::track::{self, FragmentCauseGate, LoopVerdict, OdometryDecision, Rescue};
use std::collections::HashMap;
use std::sync::Arc;

/// Confidence on branches with no measurement to derive one from.
const STATIC_CONFIDENCE: f64 = 0.3;
const BLIND_CONFIDENCE: f64 = 0.0;
const FRAGMENT_CONFIDENCE: f64 = 0.20;
const NONFINITE_CONFIDENCE: f64 = 0.0;
/// Pose-graph edge weights of the three loop edges, and of an odometry edge a thin-overlap correction replaced.
const LOOP_WEIGHT_CORRECTED: f64 = 6.0;
const LOOP_WEIGHT_RELINK: f64 = 5.0;
const LOOP_WEIGHT_CLOSURE: f64 = 4.0;
const CORRECTED_EDGE_WEIGHT: f64 = 0.05;
/// Drift control re-measures against the anchor only on frames whose content changed this much.
const DRIFT_DIFFERENCE: f64 = 0.12;
/// Revisit search starts after this frame.
const REVISIT_AFTER: u32 = 3;
/// A region needs this many own features to be trackable.
const TEXTURED_FEATURES: usize = 8;
/// Candidate scales a lost region's scale probe tries.
const PROBE_SCALES: [f64; 8] = [
    1.1,
    1.25,
    1.5,
    2.0,
    1.0 / 1.1,
    1.0 / 1.25,
    1.0 / 1.5,
    1.0 / 2.0,
];

/// The frame's shared inputs, the same for every region.
pub(super) struct FrameCtx {
    pub index: u32,
    pub time: f64,
    pub scan: ScanFields,
    pub gray: Arc<Plane>,
    pub features: Arc<Vec<Feature>>,
}

pub(super) enum Outcome {
    /// The region's placement, and whether it observed the frame for voting.
    Placed(Placement, bool),
    /// The step stopped at a revisit search: load these keyframes, then resume.
    Wait(Box<Step>, Vec<String>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Decision {
    Tracked,
    Static,
    Blind,
    Lost,
}

impl Decision {
    /// `crate::kernels::track::occlusion_eligible`'s tag.
    fn tag(self) -> u8 {
        match self {
            Decision::Tracked => 0,
            Decision::Static => 1,
            Decision::Blind => 2,
            Decision::Lost => 3,
        }
    }
}

enum Gate {
    Start,
    FixedInit,
    Fixed,
    Blind,
    Lost,
    Odometry,
}

/// Where a waiting step resumes.
enum Search {
    Lost(Retrieval),
    Revisit(Retrieval),
}

/// A revisit search result (`Relocalization`).
#[derive(Clone)]
struct Found {
    keyframe: Arc<Keyframe>,
    offset: (f64, f64),
    confidence: f64,
    ambiguous: bool,
    support: u32,
    unique: u32,
    error: f64,
}

/// The keyframe half's locals.
struct KeyLocals {
    old_anchor: Option<Arc<Keyframe>>,
    global: Option<Found>,
    attached_from: Option<String>,
    attach_match: Option<Found>,
    corrected: Option<(f64, f64)>,
    corrected_shift: (f64, f64),
    edge_weight: f64,
}

/// One region's frame-local state.
pub(super) struct Step {
    own: Vec<Feature>,
    /// Native screen-space registration window; `roi` remains relative to the full output region.
    registration_rect: Rect,
    full_overlap_rescue: bool,
    textured: bool,
    zoom_change: bool,
    roi: Rect,
    confidence: f64,
    uncertain: bool,
    relocalized: bool,
    skip: bool,
    ambiguous: bool,
    lost: bool,
    decision: Decision,
    delta: (f64, f64),
    via_anchor: Option<(f64, f64)>,
    weak_step: bool,
    step_error: f64,
    rescue: Option<Rescue>,
    keys: Option<KeyLocals>,
    search: Option<Search>,
}

impl Step {
    pub(super) fn waiting(&self) -> bool {
        self.search.is_some()
    }
}

/// `Math.max`: NaN when either is NaN.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        // +0 over -0, as Math.max does.
        if a == 0.0 && (a.is_sign_positive() || b.is_sign_positive()) {
            0.0
        } else {
            a
        }
    } else {
        a.max(b)
    }
}

fn gray(p: &Plane) -> Gray<'_> {
    Gray {
        width: p.width,
        height: p.height,
        data: &p.data,
    }
}

fn patches(k: &Keyframe, support: Option<Rect>) -> Vec<Patch<'_>> {
    let mut out = Vec::with_capacity(k.patches.len());
    for p in &k.patches {
        if support.is_some_and(|r| {
            p.x < r.x
                || p.y < r.y
                || p.x + p.size as f64 > r.x + r.width
                || p.y + p.size as f64 > r.y + r.height
        }) {
            continue;
        }
        out.push(Patch {
            x: p.x as i32,
            y: p.y as i32,
            size: p.size,
            data: &p.data,
        });
    }
    out
}

/// `String(n).padStart(10, '0')`.
fn pad(n: u32) -> String {
    format!("{n:0>10}")
}

impl SolveSession {
    /// Steps region `i` from the start; stops at a revisit search that has candidates to load.
    pub(super) fn step_region(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        labels: &[u8],
    ) -> Result<Outcome, SolveError> {
        let mut s = self.setup(i, ctx);
        // 0. Which branch this frame takes before any tracking math runs.
        match self.gate(i, ctx, &s) {
            Gate::Odometry => self.odometry_step(i, ctx, &mut s, labels),
            Gate::Start => {
                self.states[i].started = true;
                self.states[i].canvas_id = String::new();
                self.new_canvas(i, ctx.time);
            }
            Gate::FixedInit => self.new_canvas(i, ctx.time),
            Gate::Fixed => {}
            Gate::Blind => s.decision = Decision::Blind,
            Gate::Lost => s.decision = Decision::Lost,
        }
        // 1. Re-acquire the anchor on native patches after blind frames or a failed odometry step.
        self.reacquire_step(i, &mut s);
        // 2. Apply the decision.
        if self.regions[i].moving {
            match s.decision {
                Decision::Tracked => self.apply_tracked(i, ctx, &mut s),
                Decision::Static => self.apply_static(i, ctx, &mut s),
                Decision::Blind => self.apply_blind(i, ctx, &mut s),
                Decision::Lost => {
                    s.lost = true;
                    let exclude = self.states[i].anchor.as_ref().map(|a| a.id.clone());
                    let retrieval = self.retrieve(i, ctx.index, &s.own, exclude.as_deref());
                    if !retrieval.candidates.is_empty() {
                        let ids = retrieval.candidates.clone();
                        s.search = Some(Search::Lost(retrieval));
                        return Ok(Outcome::Wait(Box::new(s), ids));
                    }
                    self.apply_lost(i, ctx, &mut s, None);
                }
            }
        }
        self.after_decision(i, ctx, s)
    }

    /// Resumes a step that waited for keyframe rows.
    pub(super) fn resume_region(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        mut s: Step,
        rows: Vec<Option<Keyframe>>,
    ) -> Result<Outcome, SolveError> {
        match s.search.take() {
            Some(Search::Lost(retrieval)) => {
                let found = self.evaluate(i, ctx, &s, &retrieval, rows);
                self.apply_lost(i, ctx, &mut s, found);
                self.after_decision(i, ctx, s)
            }
            Some(Search::Revisit(retrieval)) => {
                let found = self.evaluate(i, ctx, &s, &retrieval, rows);
                self.keyframe_rest(i, ctx, s, found)
            }
            None => Err(SolveError::BadInput("no keyframes were asked for")),
        }
    }

    /// The region's read-mostly values and the mutable locals at their starting values.
    fn patch_support(&self, i: usize, s: &Step) -> Option<Rect> {
        let full = self.regions[i].shape.rect;
        (s.registration_rect != full).then_some(Rect {
            x: s.registration_rect.x - full.x,
            y: s.registration_rect.y - full.y,
            width: s.registration_rect.width,
            height: s.registration_rect.height,
        })
    }

    fn setup(&self, i: usize, ctx: &FrameCtx) -> Step {
        let r = &self.regions[i];
        let state = &self.states[i];
        let f = self.factor as f64;
        let rect = r.shape.rect;
        let roi = Rect {
            x: rect.x / f,
            y: rect.y / f,
            width: rect.width / f,
            height: rect.height / f,
        };
        let own = filter_features(
            &r.shape,
            &ctx.features,
            f,
            self.width as f64,
            self.height as f64,
        );
        let (registration_rect, own) =
            track::registration_features(rect, self.states[i].registration_support, own, f);
        let textured = own.len() >= TEXTURED_FEATURES;
        let prior: Vec<MatchPoints> = if r.moving {
            let previous = state.previous_features.as_deref().unwrap_or(&[]);
            match_features(previous, &own, true)
                .iter()
                .map(|m| {
                    let (a, b) = (&previous[m.a as usize], &own[m.b as usize]);
                    MatchPoints {
                        ax: a.x as f64,
                        ay: a.y as f64,
                        bx: b.x as f64,
                        by: b.y as f64,
                        unique: m.unique,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        let zoom = track::region_zoom(r.moving, &prior);
        let zoom_change = track::zoom_changed(zoom, ctx.scan.zoom);
        Step {
            own,
            registration_rect,
            full_overlap_rescue: false,
            textured,
            zoom_change,
            roi,
            confidence: if r.unassigned { 0.2 } else { 1.0 },
            uncertain: r.unassigned,
            relocalized: false,
            skip: false,
            ambiguous: false,
            lost: false,
            decision: Decision::Tracked,
            delta: (0.0, 0.0),
            via_anchor: None,
            weak_step: false,
            step_error: f64::INFINITY,
            rescue: None,
            keys: None,
            search: None,
        }
    }

    fn gate(&self, i: usize, ctx: &FrameCtx, s: &Step) -> Gate {
        let (moving, state) = (self.regions[i].moving, &self.states[i]);
        let has_previous = self.previous_slot.is_some() && self.previous_gray.is_some();
        if moving && !state.started {
            if s.textured {
                Gate::Start
            } else {
                Gate::Blind
            }
        } else if !moving {
            if ctx.index == 0 {
                Gate::FixedInit
            } else {
                Gate::Fixed
            }
        } else if !s.textured {
            Gate::Blind
        } else if state.blind || s.zoom_change || !has_previous {
            Gate::Lost
        } else {
            Gate::Odometry
        }
    }

    /// Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision.
    fn odometry_step(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step, labels: &[u8]) {
        let r = &self.regions[i];
        let state = &self.states[i];
        let previous_gray = self
            .previous_gray
            .as_ref()
            .expect("gated on a previous frame");
        let previous_slot = self.previous_slot.expect("gated on a previous frame");
        let inputs = track::OdometryInputs {
            f: self.factor as f64,
            radius: self.radius,
            mask: Some((labels, r.code)),
            roi: Rect {
                x: s.registration_rect.x / self.factor as f64,
                y: s.registration_rect.y / self.factor as f64,
                width: s.registration_rect.width / self.factor as f64,
                height: s.registration_rect.height / self.factor as f64,
            },
            rect: s.registration_rect,
            region: Some(&r.shape),
            image_width: self.width as f64,
            image_height: self.height as f64,
            previous: &self.frames[previous_slot],
            current: &self.frames[self.current_slot],
            previous_gray: gray(previous_gray),
            g: gray(&ctx.gray),
            velocity: state.velocity,
            previous_features: state.previous_features.as_deref().unwrap_or(&[]),
            own_features: &s.own,
            confidence: s.confidence,
        };
        #[allow(unused_mut)]
        let mut est = track::odometry(inputs);
        // A large jump may leave texture only at the output region's edge. The support
        // window must not turn that observable overlap into a new fragment.
        if s.registration_rect != r.shape.rect
            && est.decision == OdometryDecision::Lost
            && est.rescue.is_none()
        {
            let own = filter_features(
                &r.shape,
                &ctx.features,
                self.factor as f64,
                self.width as f64,
                self.height as f64,
            );
            let previous = filter_features(
                &r.shape,
                self.previous_features
                    .as_deref()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                self.factor as f64,
                self.width as f64,
                self.height as f64,
            );
            let full = track::odometry(track::OdometryInputs {
                roi: s.roi,
                rect: r.shape.rect,
                previous_features: &previous,
                own_features: &own,
                ..inputs
            });
            // Keep normal anchor/relocalization priority; a full-window measurement is
            // used only if those also fail. A screen-fixed zero shift cannot replace a lost step.
            if full.decision == OdometryDecision::Tracked && full.delta != (0.0, 0.0) {
                s.full_overlap_rescue = true;
                est.rescue = Some(Rescue {
                    phase_support: false,
                    delta: full.delta,
                    confidence: full.confidence,
                    ambiguous: full.ambiguous,
                    weak_step: full.weak_step,
                    step_error: full.step_error,
                });
            } else if full.rescue.as_ref().is_some_and(|r| r.delta != (0.0, 0.0)) {
                s.full_overlap_rescue = true;
                est.rescue = full.rescue;
            }
        }
        #[cfg(test)]
        if let Some(seam) = self.seams.odometry.as_mut() {
            self.seams.reacquire_fails |= seam(ctx.index, &mut est);
        }
        s.decision = match est.decision {
            OdometryDecision::Tracked => Decision::Tracked,
            OdometryDecision::Static => Decision::Static,
            OdometryDecision::Lost => Decision::Lost,
        };
        s.delta = est.delta;
        s.ambiguous = est.ambiguous;
        s.weak_step = est.weak_step;
        s.confidence = est.confidence;
        s.step_error = est.step_error;
        s.rescue = est.rescue;
        if let Some(change) = est.content_change {
            let canvas_id = self.states[i].canvas_id.clone();
            self.diagnostic(
                Diagnostic::new("PARTIAL_CONTENT_CHANGE", Severity::Info)
                    .at(ctx.index, ctx.time)
                    .canvas(&canvas_id)
                    .param("percent", js_round((1.0 - change.agreement) * 100.0) as f64),
            );
        }
    }

    /// Re-acquires the anchor on native patches after blind frames or a failed odometry step.
    fn reacquire_step(&mut self, i: usize, s: &mut Step) {
        let Some(anchor) = self.states[i].anchor.clone() else {
            return;
        };
        if !(s.decision == Decision::Lost && !s.zoom_change && self.regions[i].moving) {
            return;
        }
        let models = track::reacquire_hypotheses(&anchor.features, &s.own);
        if models.is_empty() {
            return;
        }
        let (rect, f, radius, w, h) = (
            self.regions[i].shape.rect,
            self.factor as f64,
            self.radius,
            self.width,
            self.height,
        );
        let anchor_patches = patches(&anchor, self.patch_support(i, s));
        let native = Gray {
            width: w,
            height: h,
            data: self.native(),
        };
        let top = track::reacquire_refine(&models, &anchor_patches, native, rect, f, radius);
        #[cfg(test)]
        #[allow(unused_mut)]
        let mut top = top.filter(|_| !std::mem::take(&mut self.seams.reacquire_fails));
        #[cfg(test)]
        if let Some(seam) = self.seams.reacquire.as_mut() {
            seam(&mut top);
        }
        if let Some(top) = top {
            // A rescue that the re-acquisition contradicts keeps the frame lost: relocalization, then the rescue.
            let pose = self.states[i].pose;
            let implied = (
                anchor.x + top.x as f64 - pose.0,
                anchor.y + top.y as f64 - pose.1,
            );
            if s.rescue
                .as_ref()
                .is_some_and(|r| track::reacquisition_contradicts_rescue(implied, r.delta))
            {
                return;
            }
            s.decision = Decision::Tracked;
            s.via_anchor = Some((top.x as f64, top.y as f64));
            s.ambiguous = top.ambiguous;
            s.confidence = top.confidence;
        }
    }

    /// Tracked: advances the pose (through the re-acquired anchor, or by the odometry step plus drift control).
    fn apply_tracked(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step) {
        let rect = self.regions[i].shape.rect;
        let support = self.patch_support(i, s);
        if let Some((vx, vy)) = s.via_anchor {
            let state = &mut self.states[i];
            let anchor = state
                .anchor
                .as_ref()
                .expect("re-acquired through the anchor");
            state.pose = (anchor.x + vx, anchor.y + vy);
            state.velocity = (0.0, 0.0);
        } else if ctx.index > 0 && self.previous_slot.is_some() {
            let state = &mut self.states[i];
            state.pose = (state.pose.0 + s.delta.0, state.pose.1 + s.delta.1);
            state.velocity = s.delta;
            // Drift control: re-measure the pose against the anchor's native patches while they are in view.
            if let Some(anchor) = state.anchor.clone() {
                if ctx.scan.difference >= DRIFT_DIFFERENCE {
                    let (pose, radius, w, h) = (state.pose, self.radius, self.width, self.height);
                    let native = Gray {
                        width: w,
                        height: h,
                        data: self.native(),
                    };
                    #[allow(unused_mut)]
                    let mut drift = track::drift_correction(
                        &patches(&anchor, support),
                        native,
                        rect,
                        (anchor.x, anchor.y),
                        pose,
                        radius,
                    );
                    #[cfg(test)]
                    if let Some(seam) = self.seams.drift.as_mut() {
                        seam(&mut drift);
                    }
                    if let Some(d) = drift {
                        self.states[i].pose = (d.x, d.y);
                        s.confidence = js_max(s.confidence, d.confidence_floor);
                    }
                }
            }
        }
        s.uncertain = track::uncertainty(s.confidence, s.ambiguous, s.weak_step);
        let (canvas_id, pose) = (self.states[i].canvas_id.clone(), self.states[i].pose);
        if s.weak_step {
            self.diagnostic(
                Diagnostic::new("THIN_OVERLAP_STEP", Severity::Warning)
                    .at(ctx.index, ctx.time)
                    .canvas(&canvas_id)
                    .confidence(s.confidence),
            );
        }
        if s.uncertain {
            let mut diagnostic = Diagnostic::new("LOW_CONFIDENCE_PLACEMENT", Severity::Warning)
                .at(ctx.index, ctx.time)
                .canvas(&canvas_id)
                .confidence(s.confidence)
                .region(Rect {
                    x: pose.0 + rect.x,
                    y: pose.1 + rect.y,
                    width: rect.width,
                    height: rect.height,
                })
                .param("ambiguous", s.ambiguous as u8 as f64);
            if s.registration_rect != rect {
                let mut detail = vec![
                    ("registrationScreenRect", Value::rect(s.registration_rect)),
                    ("outputScreenRect", Value::rect(rect)),
                ];
                if s.full_overlap_rescue && s.via_anchor.is_none() && !s.relocalized {
                    detail.push(("fullRegionFallback", Value::Bool(true)));
                }
                diagnostic = diagnostic.detail(Value::Object(detail));
            }
            self.diagnostic(diagnostic);
        }
    }

    fn apply_static(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step) {
        self.states[i].velocity = (0.0, 0.0);
        s.confidence = STATIC_CONFIDENCE;
        s.uncertain = true;
        let canvas_id = self.states[i].canvas_id.clone();
        self.diagnostic(
            Diagnostic::new("LOW_CONFIDENCE_PLACEMENT", Severity::Warning)
                .at(ctx.index, ctx.time)
                .canvas(&canvas_id)
                .confidence(s.confidence),
        );
    }

    fn apply_blind(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step) {
        s.skip = true;
        s.confidence = BLIND_CONFIDENCE;
        s.uncertain = true;
        self.states[i].velocity = (0.0, 0.0);
        let canvas_id = self.states[i].canvas_id.clone();
        self.diagnostic(
            Diagnostic::new("UNOBSERVABLE_FRAME", Severity::Warning)
                .at(ctx.index, ctx.time)
                .canvas(&canvas_id),
        );
    }

    /// Lost: relocalizes onto an existing canvas, takes odometry's rescued step, or starts a new fragment.
    fn apply_lost(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step, found: Option<Found>) {
        let verdict = found.as_ref().is_some_and(|m| {
            track::relocalize_verdict(
                Some(track::MatchInfo {
                    ambiguous: m.ambiguous,
                    confidence: m.confidence,
                }),
                s.zoom_change,
            )
        });
        if let (true, Some(m)) = (verdict, found) {
            let canvas = resolve_target(&self.attachments, &m.keyframe.canvas_id).to_string();
            let shift = attachment_shift(&self.attachments, &m.keyframe.canvas_id);
            let state = &mut self.states[i];
            state.canvas_id = canvas;
            state.pose = track::target_pose((m.keyframe.x, m.keyframe.y), m.offset, shift);
            state.last_node = None;
            state.anchor = Some(m.keyframe.clone());
            state.velocity = (0.0, 0.0);
            s.confidence = m.confidence;
            s.relocalized = true;
            let canvas_id = state.canvas_id.clone();
            self.diagnostic(
                Diagnostic::new("RELOCALIZED", Severity::Info)
                    .at(ctx.index, ctx.time)
                    .canvas(&canvas_id)
                    .confidence(s.confidence)
                    .detail(Value::Object(vec![
                        ("anchorFrame", Value::Number(m.keyframe.frame as f64)),
                        ("support", Value::Number(m.support as f64)),
                        ("unique", Value::Number(m.unique as f64)),
                        ("error", Value::Number(m.error)),
                        ("offset", Value::point(m.offset.0, m.offset.1)),
                    ])),
            );
        } else if let (Some(rescue), false) = (s.rescue.as_ref(), s.zoom_change) {
            // Odometry measured the step although its plain native error rejected it: a tracked step at its own
            // low confidence instead of a new fragment.
            s.lost = false;
            s.decision = Decision::Tracked;
            s.delta = rescue.delta;
            s.confidence = rescue.confidence;
            s.ambiguous = rescue.ambiguous;
            s.weak_step = rescue.weak_step;
            s.step_error = rescue.step_error;
            if rescue.phase_support && !self.states[i].phase_support {
                self.states[i].registration_support = track::registration_support(
                    self.regions[i].shape.rect,
                    &s.own,
                    self.factor as f64,
                );
                self.states[i].phase_support = true;
                let (rect, own) = track::registration_features(
                    self.regions[i].shape.rect,
                    self.states[i].registration_support,
                    std::mem::take(&mut s.own),
                    self.factor as f64,
                );
                s.registration_rect = rect;
                s.own = own;
            }
            self.apply_tracked(i, ctx, s);
        } else {
            // Name the cause: a magnification change is a different pixel grid, not a lost trajectory.
            let scale: FragmentScale = match track::fragment_cause_gate(
                s.zoom_change,
                self.previous_gray.is_some(),
                self.states[i].blind,
            ) {
                FragmentCauseGate::ZoomChange => Some((ctx.scan.zoom, 0.0)),
                FragmentCauseGate::ProbeScale => probe_scale(
                    gray(
                        self.previous_gray
                            .as_ref()
                            .expect("gated on a previous gray"),
                    ),
                    gray(&ctx.gray),
                    &s.own,
                    Some(s.roi),
                    &PROBE_SCALES,
                ),
                FragmentCauseGate::None => None,
            };
            let state = &mut self.states[i];
            state.fragment += 1;
            state.pose = (0.0, 0.0);
            state.last_node = None;
            state.anchor = None;
            state.velocity = (0.0, 0.0);
            self.new_canvas(i, ctx.time);
            s.confidence = FRAGMENT_CONFIDENCE;
            s.uncertain = true;
            let canvas_id = self.states[i].canvas_id.clone();
            let d = match scale {
                Some((scale, error)) => Diagnostic::new("SCALE_CHANGE_FRAGMENT", Severity::Warning)
                    .param("scale", scale)
                    .detail(Value::Object(vec![
                        ("scale", Value::Number(scale)),
                        ("error", Value::Number(error)),
                    ])),
                None => Diagnostic::new("UNPLACED_FRAGMENT", Severity::Warning),
            };
            self.diagnostic(
                d.at(ctx.index, ctx.time)
                    .canvas(&canvas_id)
                    .confidence(s.confidence),
            );
        }
    }

    /// A pose that ended up non-finite or out of range isolates the observation into a fresh fragment.
    fn recover_nonfinite_pose(&mut self, i: usize, ctx: &FrameCtx, s: &mut Step) {
        let (x, y) = self.states[i].pose;
        if is_valid_pose(x, y) {
            return;
        }
        self.diagnostic(Diagnostic::new("NONFINITE_POSE", Severity::Error).at(ctx.index, ctx.time));
        let state = &mut self.states[i];
        state.fragment += 1;
        state.pose = (0.0, 0.0);
        state.last_node = None;
        state.anchor = None;
        s.confidence = NONFINITE_CONFIDENCE;
        s.uncertain = true;
        self.new_canvas(i, ctx.time);
    }

    /// After the decision: pose recovery, then the keyframe half when a keyframe is due.
    fn after_decision(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        mut s: Step,
    ) -> Result<Outcome, SolveError> {
        self.recover_nonfinite_pose(i, ctx, &mut s);
        if s.skip {
            return Ok(self.close_region(i, ctx, s));
        }
        let (r, state) = (&self.regions[i], &self.states[i]);
        let needs = track::needs_keyframe(
            r.moving,
            state.anchor.as_ref().map(|a| (a.x, a.y)),
            state.pose,
            state.last_node.as_ref().map(|n| n.1 as i32),
            (r.shape.rect.width, r.shape.rect.height),
            ctx.index as i32,
            ctx.scan.difference,
        );
        if !needs {
            return Ok(self.close_region(i, ctx, s));
        }
        let old_anchor = state.anchor.clone();
        s.keys = Some(KeyLocals {
            old_anchor: old_anchor.clone(),
            global: None,
            attached_from: None,
            attach_match: None,
            corrected: None,
            corrected_shift: (0.0, 0.0),
            edge_weight: track::odometry_weight(s.weak_step),
        });
        // Revisit search at every keyframe: same canvas → loop closure; another canvas → the fragment is tied back.
        if !s.lost && !s.skip && r.moving && ctx.index > REVISIT_AFTER {
            let exclude = old_anchor.as_ref().map(|a| a.id.clone());
            let retrieval = self.retrieve(i, ctx.index, &s.own, exclude.as_deref());
            if !retrieval.candidates.is_empty() {
                let ids = retrieval.candidates.clone();
                s.search = Some(Search::Revisit(retrieval));
                return Ok(Outcome::Wait(Box::new(s), ids));
            }
        }
        self.keyframe_rest(i, ctx, s, None)
    }

    /// Scores the loaded candidate keyframes (`KeyframeIndex.find`'s evaluation): the admitted rows in the order
    /// asked for, each keyframe's canvas resolved through the attachments.
    fn evaluate(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        s: &Step,
        retrieval: &Retrieval,
        rows: Vec<Option<Keyframe>>,
    ) -> Option<Found> {
        let keyframes: Vec<Arc<Keyframe>> = rows
            .into_iter()
            .flatten()
            .filter(|k| retrieval.admits(k.frame))
            .map(Arc::new)
            .collect();
        if keyframes.is_empty() {
            return None;
        }
        let mut canonical: HashMap<&str, (String, (f64, f64))> = HashMap::new();
        let mut interned: HashMap<String, u32> = HashMap::new();
        let mut resolved = Vec::with_capacity(keyframes.len());
        for k in &keyframes {
            let (canvas, shift) = canonical
                .entry(k.canvas_id.as_str())
                .or_insert_with(|| {
                    (
                        resolve_target(&self.attachments, &k.canvas_id).to_string(),
                        attachment_shift(&self.attachments, &k.canvas_id),
                    )
                })
                .clone();
            let next = interned.len() as u32;
            let idx = *interned.entry(canvas).or_insert(next);
            resolved.push((idx, shift));
        }
        let patch_lists: Vec<Vec<Patch>> = keyframes
            .iter()
            .map(|k| patches(k, self.patch_support(i, s)))
            .collect();
        let candidates: Vec<track::CandidateKeyframe> = keyframes
            .iter()
            .zip(&patch_lists)
            .zip(&resolved)
            .map(
                |((k, p), &(canonical_idx, (dx, dy)))| track::CandidateKeyframe {
                    features: &k.features,
                    gray: gray(&k.gray),
                    patches: p,
                    x: k.x,
                    y: k.y,
                    canonical_idx,
                    dx,
                    dy,
                },
            )
            .collect();
        let audited = track::evaluate_candidates_audit(
            &candidates,
            &s.own,
            gray(&ctx.gray),
            s.roi,
            self.factor as f64,
        );
        if audited.is_empty() {
            return None;
        }
        let (rect, radius, w, h) = (
            self.regions[i].shape.rect,
            self.radius,
            self.width,
            self.height,
        );
        let native = Gray {
            width: w,
            height: h,
            data: self.native(),
        };
        let refined =
            track::evaluate_candidates_refine(&audited, &candidates, native, rect, radius);
        let chosen = track::select_candidate(&refined, &candidates)?;
        Some(Found {
            keyframe: keyframes[chosen.keyframe_index].clone(),
            offset: (chosen.x as f64, chosen.y as f64),
            confidence: chosen.confidence,
            ambiguous: chosen.ambiguous,
            support: chosen.support,
            unique: chosen.unique,
            error: chosen.error,
        })
    }

    /// The keyframe half after the revisit search: attachment, thin-overlap correction, the graph node and its
    /// edges, and the new keyframe.
    fn keyframe_rest(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        mut s: Step,
        found: Option<Found>,
    ) -> Result<Outcome, SolveError> {
        let mut keys = s.keys.take().expect("the keyframe half started");
        // A match whose keyframe pose or offset is invalid can only come from a corrupted row: no revisit.
        keys.global = found.filter(|m| {
            is_valid_pose(m.keyframe.x, m.keyframe.y) && is_valid_pose(m.offset.0, m.offset.1)
        });
        self.apply_attachment(i, ctx, &mut keys);
        self.apply_thin_overlap_correction(i, ctx, &s, &mut keys);
        let (canvas_id, pose, previous) = {
            let state = &self.states[i];
            (
                state.canvas_id.clone(),
                state.pose,
                state.last_node.as_ref().map(|n| n.0.clone()),
            )
        };
        let (node, writes) = self.graph.add(
            &canvas_id,
            ctx.index,
            pose,
            previous.as_deref(),
            keys.edge_weight,
        )?;
        self.graph_writes(writes);
        if let (Some(_), Some(global)) = (keys.corrected, &keys.global) {
            let writes = self.graph.connect(
                &global.keyframe.node,
                &node.id,
                global.offset.0 + keys.corrected_shift.0,
                global.offset.1 + keys.corrected_shift.1,
                LOOP_WEIGHT_CORRECTED,
                EdgeKind::Loop,
            )?;
            self.graph_writes(writes);
        }
        self.connect_relink_or_loop_closure(i, ctx, &s, &keys, &node.id)?;
        let last = self.graph.get(&node.id).map(|n| (n.id.clone(), n.frame));
        self.states[i].last_node = last;
        self.mint_keyframe(i, ctx, &s, &node.id);
        s.keys = Some(keys);
        Ok(self.close_region(i, ctx, s))
    }

    /// Ties an independent fragment rigidly onto an existing canvas when the revisit clears the attach verdict.
    fn apply_attachment(&mut self, i: usize, ctx: &FrameCtx, keys: &mut KeyLocals) {
        let Some(global) = keys.global.clone() else {
            return;
        };
        let target = resolve_target(&self.attachments, &global.keyframe.canvas_id).to_string();
        let shift = attachment_shift(&self.attachments, &global.keyframe.canvas_id);
        let canvas_id = self.states[i].canvas_id.clone();
        #[allow(unused_mut)]
        let mut verdict = track::attach_verdict(
            Some(track::GlobalMatch {
                keyframe: (global.keyframe.x, global.keyframe.y),
                offset: global.offset,
                ambiguous: global.ambiguous,
                confidence: global.confidence,
            }),
            target == canvas_id,
            shift,
        );
        #[cfg(test)]
        if let Some(seam) = self.seams.attach.as_mut() {
            seam(&mut verdict);
        }
        // A verdict outside the addressable range is rejected as if there were none.
        let Some(pose) = verdict.filter(|p| is_valid_pose(p.0, p.1)) else {
            return;
        };
        let state_pose = self.states[i].pose;
        let attachment = Attachment {
            id: canvas_id.clone(),
            target: target.clone(),
            dx: pose.0 - state_pose.0,
            dy: pose.1 - state_pose.1,
            frame: ctx.index,
            confidence: global.confidence,
            node: global.keyframe.node.clone(),
        };
        self.attachments
            .insert(canvas_id.clone(), attachment.clone());
        self.effects.push(Effect::Attachment(attachment.clone()));
        if let Some(meta) = self.canvases.get_mut(&canvas_id) {
            meta.attached_to = Some(target.clone());
            let meta = meta.clone();
            self.effects.push(Effect::Canvas {
                meta,
                created: false,
            });
        }
        self.diagnostic(
            Diagnostic::new("FRAGMENT_ATTACHED", Severity::Info)
                .at(ctx.index, ctx.time)
                .canvas(&attachment.target)
                .confidence(global.confidence)
                .detail(Value::Object(vec![
                    ("id", Value::Text(attachment.id.clone())),
                    ("target", Value::Text(attachment.target.clone())),
                    ("dx", Value::Number(attachment.dx)),
                    ("dy", Value::Number(attachment.dy)),
                    ("frame", Value::Number(attachment.frame as f64)),
                    ("confidence", Value::Number(attachment.confidence)),
                    ("node", Value::Text(attachment.node.clone())),
                ])),
        );
        keys.attached_from = Some(canvas_id);
        keys.attach_match = Some(global);
        let state = &mut self.states[i];
        state.canvas_id = target;
        state.pose = pose;
        state.last_node = None;
        state.velocity = (0.0, 0.0);
    }

    /// Corrects a thin-overlap step against a same-canvas revisit before the node exists, so the odometry edge
    /// records the corrected geometry with a weight as thin as its evidence.
    fn apply_thin_overlap_correction(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        s: &Step,
        keys: &mut KeyLocals,
    ) {
        let Some(global) = keys.global.clone() else {
            return;
        };
        let state = &self.states[i];
        #[allow(unused_mut)]
        let mut eligible = track::thin_overlap_eligible(
            s.weak_step,
            state.weak,
            global.ambiguous,
            global.confidence,
            global.error,
        );
        #[cfg(test)]
        {
            eligible |= self.seams.thin.is_some();
        }
        if keys.attached_from.is_some()
            || resolve_target(&self.attachments, &global.keyframe.canvas_id) != state.canvas_id
            || !eligible
        {
            return;
        }
        // The keyframe may sit on a fragment attached onto this canvas: translate its raw pose first.
        let shift = attachment_shift(&self.attachments, &global.keyframe.canvas_id);
        let canonical = (global.keyframe.x + shift.0, global.keyframe.y + shift.1);
        #[allow(unused_mut)]
        let mut correction = track::thin_overlap_correction(canonical, global.offset, state.pose);
        #[cfg(test)]
        if let Some(seam) = self.seams.thin.as_mut() {
            seam(&mut correction);
        }
        // A correction outside the addressable range is treated as none.
        let Some((target, discrepancy)) = correction.filter(|(t, _)| is_valid_pose(t.0, t.1))
        else {
            return;
        };
        let state = &self.states[i];
        keys.corrected = Some(target);
        keys.corrected_shift = shift;
        keys.edge_weight = CORRECTED_EDGE_WEIGHT;
        let (canvas_id, from) = (state.canvas_id.clone(), state.pose);
        self.diagnostic(
            Diagnostic::new("TRAJECTORY_CORRECTED", Severity::Warning)
                .at(ctx.index, ctx.time)
                .canvas(&canvas_id)
                .confidence(global.confidence)
                .param("discrepancy", discrepancy)
                .detail(Value::Object(vec![
                    ("discrepancy", Value::Number(discrepancy)),
                    ("from", Value::point(from.0, from.1)),
                    ("to", Value::point(target.0, target.1)),
                    ("revisitError", Value::Number(global.error)),
                    ("stepError", Value::Number(s.step_error)),
                    ("weakStep", Value::Bool(s.weak_step)),
                ])),
        );
        let state = &mut self.states[i];
        state.pose = target;
        state.weak = false;
    }

    /// The edge from the new node back to history: a relink after relocalizing or attaching, else on a same-canvas
    /// revisit a loop closure, a rejected conflict, or an unresolved ambiguous match.
    fn connect_relink_or_loop_closure(
        &mut self,
        i: usize,
        ctx: &FrameCtx,
        s: &Step,
        keys: &KeyLocals,
        node: &str,
    ) -> Result<(), SolveError> {
        let (canvas_id, pose) = (self.states[i].canvas_id.clone(), self.states[i].pose);
        if (s.relocalized && keys.old_anchor.is_some()) || keys.attached_from.is_some() {
            let writes = self.graph.unpin(node)?;
            self.graph_writes(writes);
            let link = match &keys.attach_match {
                Some(m) => m.keyframe.clone(),
                None => keys.old_anchor.clone().expect("relocalized with an anchor"),
            };
            // The pose is canonical and the link's x/y raw in its own canvas: their difference is the edge.
            let writes = self.graph.connect(
                &link.node,
                node,
                pose.0 - link.x,
                pose.1 - link.y,
                LOOP_WEIGHT_RELINK,
                EdgeKind::Loop,
            )?;
            self.graph_writes(writes);
        } else if let Some(global) = &keys.global {
            if resolve_target(&self.attachments, &global.keyframe.canvas_id) != canvas_id {
                return Ok(());
            }
            let shift = attachment_shift(&self.attachments, &global.keyframe.canvas_id);
            let (verdict, discrepancy) = track::loop_closure_verdict(
                (global.keyframe.x, global.keyframe.y),
                global.offset,
                global.ambiguous,
                global.confidence,
                shift,
                pose,
            );
            match verdict {
                LoopVerdict::Closure => {
                    let writes = self.graph.connect(
                        &global.keyframe.node,
                        node,
                        global.offset.0 + shift.0,
                        global.offset.1 + shift.1,
                        LOOP_WEIGHT_CLOSURE,
                        EdgeKind::Loop,
                    )?;
                    self.graph_writes(writes);
                    self.diagnostic(
                        Diagnostic::new("LOOP_CLOSURE", Severity::Info)
                            .at(ctx.index, ctx.time)
                            .canvas(&canvas_id)
                            .confidence(global.confidence),
                    );
                }
                LoopVerdict::Inconsistent => self.diagnostic(
                    Diagnostic::new("INCONSISTENT_LOOP_REJECTED", Severity::Warning)
                        .at(ctx.index, ctx.time)
                        .canvas(&canvas_id)
                        .confidence(global.confidence)
                        .param("discrepancy", discrepancy),
                ),
                LoopVerdict::Ambiguous => self.diagnostic(
                    Diagnostic::new("AMBIGUOUS_LOOP", Severity::Warning)
                        .at(ctx.index, ctx.time)
                        .canvas(&canvas_id),
                ),
                LoopVerdict::None => {}
            }
        }
        Ok(())
    }

    /// The frame's keyframe for this region (with native patches when it moves), as its new anchor.
    fn mint_keyframe(&mut self, i: usize, ctx: &FrameCtx, s: &Step, node: &str) {
        let f = self.factor as f64;
        let (moving, rect, id) = (
            self.regions[i].moving,
            self.regions[i].shape.rect,
            self.regions[i].id.clone(),
        );
        let patches = if moving {
            let points: Vec<(f64, f64)> = s
                .own
                .iter()
                .map(|p| (p.x as f64 - s.roi.x, p.y as f64 - s.roi.y))
                .collect();
            let (w, h) = (self.width, self.height);
            let native = self.native();
            extract_patches(native, w, h, rect, &points, f, PATCH_COUNT, PATCH_SIZE)
                .into_iter()
                .map(|p| super::KeyPatch {
                    x: p.x,
                    y: p.y,
                    size: p.size,
                    data: p.data,
                })
                .collect()
        } else {
            Vec::new()
        };
        let state = &self.states[i];
        let keyframe = Arc::new(Keyframe {
            id: format!("{id}/{}", pad(ctx.index)),
            node: node.to_string(),
            canvas_id: state.canvas_id.clone(),
            layer: id.clone(),
            frame: ctx.index,
            features: s.own.clone(),
            gray: ctx.gray.clone(),
            x: state.pose.0,
            y: state.pose.1,
            scale_x: f,
            scale_y: f,
            patches,
        });
        self.states[i].anchor = Some(keyframe.clone());
        if moving {
            let descriptors: Vec<_> = keyframe.features.iter().map(|f| f.descriptor).collect();
            self.effects.push(Effect::Keyframe(keyframe.clone()));
            self.index
                .add(&keyframe.id, &id, keyframe.frame, &descriptors);
        }
    }

    /// The second pose recovery, then the voting observation, sticky occlusions and the placement — all with the
    /// region's final pose and canvas this frame.
    fn close_region(&mut self, i: usize, ctx: &FrameCtx, mut s: Step) -> Outcome {
        self.recover_nonfinite_pose(i, ctx, &mut s);
        let (moving, layer, region) = (
            self.regions[i].moving,
            self.regions[i].id.clone(),
            self.regions[i]
                .shape
                .crop
                .unwrap_or(self.regions[i].shape.rect),
        );
        let mut observed = false;
        if moving && !s.skip {
            let slot = self.voting_slot[i].expect("a moving region has a voting slot");
            let canvas_id = self.states[i].canvas_id.clone();
            let canvas = self.canvas_slot(&canvas_id);
            let pose = self.states[i].pose;
            self.voting
                .observe(slot, canvas, pose.0, pose.1, &ctx.gray.data);
            observed = true;
        }
        let has_previous = self.previous_slot.is_some();
        let canvas_id = self.states[i].canvas_id.clone();
        let occlusions = match self.previous_slot {
            Some(previous) if track::occlusion_eligible(has_previous, moving, s.decision.tag()) => {
                let carry: Vec<Rect> = self
                    .previous_plan
                    .as_ref()
                    .and_then(|plan| {
                        plan.iter()
                            .find(|p| p.layer == layer && p.canvas_id == canvas_id)
                    })
                    .map(|p| p.occlusions.clone())
                    .unwrap_or_default();
                sticky_occlusions(
                    &self.frames[previous],
                    &self.frames[self.current_slot],
                    self.width,
                    self.height,
                    region,
                    s.delta.0,
                    s.delta.1,
                    &carry,
                )
            }
            _ => Vec::new(),
        };
        if let Some(first) = occlusions.first() {
            self.diagnostic(
                Diagnostic::new("STICKY_OCCLUSION", Severity::Info)
                    .at(ctx.index, ctx.time)
                    .canvas(&canvas_id)
                    .region(*first),
            );
        }
        let state = &mut self.states[i];
        let placement = Placement {
            layer,
            canvas_id,
            node: state
                .last_node
                .as_ref()
                .map(|n| n.0.clone())
                .unwrap_or_default(),
            x: state.pose.0,
            y: state.pose.1,
            confidence: s.confidence,
            uncertain: s.uncertain,
            time: ctx.time,
            skip: s.skip,
            occlusions,
        };
        if moving {
            state.blind = !s.textured;
            state.weak = if s.decision == Decision::Tracked {
                s.weak_step
            } else {
                false
            };
        }
        state.previous_features = Some(s.own);
        Outcome::Placed(placement, observed)
    }
}
