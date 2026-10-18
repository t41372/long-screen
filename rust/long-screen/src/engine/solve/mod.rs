//! The solve pass as a session the host drives frame by frame: per-region tracking (odometry, anchor
//! re-acquisition, drift control, relocalization, fragments), keyframes and revisits, fragment attachment, the
//! pose graph's nodes and edges, displacement-spread consistency voting, and each frame's placements.
//!
//! The session keeps what the TypeScript pass kept in memory: per-region state, the previous frame's pixels,
//! analysis gray and features, the previous plan's placements, the attachments, the canvases it created, the pose
//! graph, the keyframe index's postings and the voting ring. Keyframes themselves are rows the host stores
//! (`keyframe/<id>`) and reads back: a revisit search is declare-then-provide ([`Poll::NeedKeyframes`] →
//! [`SolveSession::provide_keyframes`]).
//!
//! One frame:
//! 1. [`SolveSession::begin_frame`] with the frame's scan record. A duplicate frame whose previous plan can be
//!    replayed is finished right there ([`Begin::Duplicate`]); otherwise the session asks for the pixels.
//! 2. The host writes the RGBA frame into [`SolveSession::frame_mut`] and calls [`SolveSession::run_frame`] with
//!    the analysis gray it computed (WebGPU) or `None`, and the frame's stored features or `None`.
//! 3. While the result is [`Poll::NeedKeyframes`], the host loads those rows and calls
//!    [`SolveSession::provide_keyframes`].
//! 4. [`Poll::Done`] carries the placements and finalised voting records. Before each poll result, and after an
//!    error, the host takes the frame's [`Effect`]s ([`SolveSession::take_effects`]) and applies them in order:
//!    they are the rows and diagnostics the pass produced, in the order it produced them.
//!
//! After the last frame the host drains the voting ring ([`SolveSession::drain_voting`]) and relaxes the pose
//! graph ([`SolveSession::graph_mut`]), a few sweeps per step.

mod region;

use crate::engine::attachments::{Attachment, Attachments};
use crate::engine::diagnostic::{Diagnostic, Severity};
use crate::engine::keyframes::{KeyframeIndex, Retrieval};
use crate::engine::pose_graph::{PoseGraph, PoseGraphError, Write};
use crate::kernels::features::{extract_features, Feature};
use crate::kernels::geometry::Rect;
use crate::kernels::raster::{downscale_gray, downscaled_size, grayscale};
use crate::kernels::region::{Mask, Region as Shape};
use crate::kernels::voting::{Finalized, Ring};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// Bytes of analysis frames the consistency voting ring keeps (docs/ARCHITECTURE.md §七).
pub const VOTING_RING_BYTES: usize = 24 * 1024 * 1024;
/// Features extracted from a frame whose stored features are missing.
pub const FALLBACK_FEATURES: usize = 480;
/// Native patches a moving region's keyframe keeps, and their side.
pub const PATCH_COUNT: usize = 24;
pub const PATCH_SIZE: usize = 32;
/// How far a pose may reach: the compositor's addressable range less a margin larger than any frame.
pub const POSE_BOUND: f64 = crate::engine::compositor::CANVAS_PIXEL_BOUND - 65536.0;

/// Whether `(x, y)` is a pose the pass may write: finite and inside [`POSE_BOUND`].
pub fn is_valid_pose(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && x.abs() < POSE_BOUND && y.abs() < POSE_BOUND
}

/// The label a registration plane gives a moving region's screen-fixed pixels: the atlas uses 0 and 1–254.
pub(super) const UNREGISTERED: u8 = 255;

/// One non-ignored region the pass tracks.
pub struct SolveRegion {
    pub id: String,
    pub name: String,
    /// `moving` regions are tracked; every other kind is placed once at the origin.
    pub moving: bool,
    /// Its kind as the canvas row stores it (`moving`, `fixed`).
    pub kind: String,
    pub unassigned: bool,
    /// The region's code in the atlas label plane.
    pub code: u8,
    pub shape: Shape,
}

pub struct SolveConfig {
    pub width: usize,
    pub height: usize,
    /// Integer analysis factor.
    pub factor: u32,
    /// Native refinement radius.
    pub radius: i32,
    /// The source's per-channel decode noise.
    pub noise: f64,
    pub voting_budget: usize,
    pub regions: Vec<SolveRegion>,
}

/// The scan record fields the pass reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScanFields {
    pub duplicate: bool,
    pub zoom: f64,
    pub difference: f64,
}

/// A row-major 8-bit plane.
#[derive(Clone, Debug, PartialEq)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// Native luma texture sampled around a keyframe feature.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyPatch {
    pub x: f64,
    pub y: f64,
    pub size: usize,
    pub data: Vec<u8>,
}

/// One `keyframe/<id>` row.
#[derive(Clone, Debug, PartialEq)]
pub struct Keyframe {
    pub id: String,
    pub node: String,
    pub canvas_id: String,
    pub layer: String,
    pub frame: u32,
    pub features: Vec<Feature>,
    pub gray: Arc<Plane>,
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub patches: Vec<KeyPatch>,
}

/// One `canvas/<id>` row as the solve pass writes it; every count the render pass fills in starts at zero.
#[derive(Clone, Debug, PartialEq)]
pub struct CanvasMeta {
    pub id: String,
    pub layer: String,
    pub name: String,
    pub kind: String,
    pub fragment: u32,
    pub first_time: f64,
    pub last_time: f64,
    pub attached_to: Option<String>,
}

/// One region's observation in a frame (a placement of `plan/<frame>`).
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub layer: String,
    pub canvas_id: String,
    pub node: String,
    pub x: f64,
    pub y: f64,
    pub confidence: f64,
    pub uncertain: bool,
    pub time: f64,
    pub skip: bool,
    pub occlusions: Vec<Rect>,
}

/// The cause a new fragment's diagnostic names: a magnification change (`scale`, `error`), or none.
pub type FragmentScale = Option<(f64, f64)>;

/// Something the pass did that the host must carry out, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Store `canvas/<id>`; `created` also counts a new canvas.
    Canvas {
        meta: CanvasMeta,
        created: bool,
    },
    /// Store `attach/<id>`.
    Attachment(Attachment),
    /// Store `keyframe/<id>`.
    Keyframe(Arc<Keyframe>),
    /// Store pose graph rows: one `put` or one `putMany`.
    Graph(Write),
    Diagnostic(Diagnostic),
}

/// One region slot's finalised voting verdict: the analysis box it covers and its two LSB-first bitsets.
#[derive(Clone, Debug, PartialEq)]
pub struct VotingVerdict {
    pub region: String,
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
    pub bits: Vec<u8>,
    pub clean: Vec<u8>,
}

/// One finalised frame of the voting ring (a `consistency/<frame>` row when it has verdicts).
#[derive(Clone, Debug, PartialEq)]
pub struct VotingRecord {
    pub index: u32,
    pub verdicts: Vec<VotingVerdict>,
    pub voted_layers: u32,
    pub thin_layers: u32,
}

/// A solved frame.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameDone {
    /// One per region, in region order.
    pub placements: Vec<Placement>,
    /// Whether the frame joined the voting ring (some moving region observed it); `voting` is then what its
    /// bytes pushed out of the ring.
    pub joined_ring: bool,
    pub voting: Vec<VotingRecord>,
}

/// The outcome of [`SolveSession::begin_frame`].
#[derive(Clone, Debug, PartialEq)]
pub enum Begin {
    /// The frame repeats the previous one exactly: its plan is the previous plan at this frame's time.
    Duplicate(Vec<Placement>),
    /// Write the frame into [`SolveSession::frame_mut`], then [`SolveSession::run_frame`]; `gray` says whether
    /// an analysis gray is wanted (a duplicate frame reuses the previous one).
    NeedFrame { gray: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Poll {
    /// Load these `keyframe/<id>` rows and [`SolveSession::provide_keyframes`] them, in this order.
    NeedKeyframes(Vec<String>),
    Done(FrameDone),
}

#[derive(Clone, Debug, PartialEq)]
pub enum SolveError {
    Graph(PoseGraphError),
    /// The host called a step out of order or handed in malformed input.
    BadInput(&'static str),
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::Graph(e) => e.fmt(f),
            SolveError::BadInput(what) => write!(f, "CORE_BAD_ARGUMENT: {what}."),
        }
    }
}

impl std::error::Error for SolveError {}

impl From<PoseGraphError> for SolveError {
    fn from(e: PoseGraphError) -> Self {
        SolveError::Graph(e)
    }
}

/// Per-region tracking state carried from frame to frame.
struct RegionState {
    /// Set only when the additional phase rescue actually places a frame. An anchor that already
    /// recovers the step keeps the legacy path. None is a valid sparse-feature fallback.
    phase_support: bool,
    registration_support: Option<Rect>,
    /// Cells of a moving region that stay on screen while it moves; registration leaves them out.
    screen_fixed: Option<crate::kernels::track::ScreenFixed>,
    canvas_id: String,
    fragment: u32,
    pose: (f64, f64),
    /// Last accepted native displacement; a weak prior that breaks ties between period-aliased hypotheses.
    velocity: (f64, f64),
    /// The last pose-graph node of this region's chain: its id and frame.
    last_node: Option<(String, u32)>,
    anchor: Option<Arc<Keyframe>>,
    previous_features: Option<Vec<Feature>>,
    /// The previous frame carried no usable texture in this region.
    blind: bool,
    /// The last accepted step had little overlap.
    weak: bool,
    /// A textured frame has been seen, so the canvas origin is defined.
    started: bool,
}

/// The frame being solved.
struct FrameWork {
    index: u32,
    time: f64,
    scan: ScanFields,
    gray: Arc<Plane>,
    features: Arc<Vec<Feature>>,
    placements: Vec<Placement>,
    /// The region being stepped, and its step when it is waiting for keyframes.
    region: usize,
    step: Option<Box<region::Step>>,
    joined_ring: bool,
}

enum Stage {
    Idle,
    AwaitFrame {
        index: u32,
        time: f64,
        scan: ScanFields,
    },
    Frame(Box<FrameWork>),
}

pub struct SolveSession {
    width: usize,
    height: usize,
    factor: u32,
    radius: i32,
    analysis: (usize, usize),
    regions: Vec<SolveRegion>,
    states: Vec<RegionState>,
    /// Voting slot of each region (moving regions only).
    voting_slot: Vec<Option<usize>>,
    voting: Ring,
    canvas_slots: HashMap<String, u32>,
    graph: PoseGraph,
    index: KeyframeIndex,
    attachments: Attachments,
    canvases: HashMap<String, CanvasMeta>,
    frames: [Vec<u8>; 2],
    /// The slot holding the previous solved frame, and the slot the next frame is written into.
    previous_slot: Option<usize>,
    current_slot: usize,
    native: Vec<u8>,
    native_filled: bool,
    previous_gray: Option<Arc<Plane>>,
    previous_features: Option<Arc<Vec<Feature>>>,
    previous_plan: Option<Vec<Placement>>,
    /// The atlas label plane with every moving region's screen-fixed cells recoded to [`UNREGISTERED`], and the
    /// plane it was made from; rebuilt when a region's left-out cells change.
    registration_labels: Option<(Arc<Vec<u8>>, Vec<u8>)>,
    registration_stale: bool,
    stage: Stage,
    effects: Vec<Effect>,
    /// Test seams that replace a core decision, to reach the recovery paths real input rarely does.
    #[cfg(test)]
    seams: tests::Seams,
}

fn clone_shape(s: &Shape) -> Shape {
    Shape {
        rect: s.rect,
        exclusions: s.exclusions.clone(),
        crop: s.crop,
        solid: s.solid,
        mask: s.mask.as_ref().map(|m| Mask {
            width: m.width,
            height: m.height,
            factor: m.factor,
            data: m.data.clone(),
        }),
    }
}

/// A feature as it reaches the pass from storage: its score is a 32-bit float.
fn stored(mut f: Feature) -> Feature {
    f.score = f.score as f32 as f64;
    f
}

impl SolveSession {
    pub fn new(config: SolveConfig) -> SolveSession {
        let SolveConfig {
            width,
            height,
            factor,
            radius,
            noise,
            voting_budget,
            regions,
        } = config;
        let factor = factor.max(1);
        let analysis = downscaled_size(width, height, factor as usize);
        let mut voting_slot = Vec::with_capacity(regions.len());
        let mut voting_regions = Vec::new();
        for r in &regions {
            if r.moving {
                voting_slot.push(Some(voting_regions.len()));
                voting_regions.push(clone_shape(&r.shape));
            } else {
                voting_slot.push(None);
            }
        }
        let voting = Ring::new(
            factor as i32,
            noise,
            width,
            height,
            analysis.0,
            analysis.1,
            voting_budget,
            voting_regions,
        );
        let states = regions
            .iter()
            .map(|r| RegionState {
                phase_support: false,
                registration_support: None,
                screen_fixed: r.moving.then(|| {
                    let rect = r.shape.rect;
                    let f = factor as f64;
                    let (x0, y0) = ((rect.x / f).floor(), (rect.y / f).floor());
                    crate::kernels::track::ScreenFixed::new(
                        x0 as i64,
                        y0 as i64,
                        (((rect.x + rect.width) / f).ceil() - x0).max(0.0) as usize,
                        (((rect.y + rect.height) / f).ceil() - y0).max(0.0) as usize,
                    )
                }),
                canvas_id: String::new(),
                fragment: 0,
                pose: (0.0, 0.0),
                velocity: (0.0, 0.0),
                last_node: None,
                anchor: None,
                previous_features: None,
                blind: false,
                weak: false,
                started: false,
            })
            .collect();
        SolveSession {
            width,
            height,
            factor,
            radius,
            analysis,
            regions,
            states,
            voting_slot,
            voting,
            canvas_slots: HashMap::new(),
            graph: PoseGraph::new(),
            index: KeyframeIndex::new(),
            attachments: Attachments::new(),
            canvases: HashMap::new(),
            frames: [vec![0; width * height * 4], vec![0; width * height * 4]],
            previous_slot: None,
            current_slot: 0,
            native: vec![0; width * height],
            native_filled: false,
            previous_gray: None,
            previous_features: None,
            previous_plan: None,
            registration_labels: None,
            registration_stale: false,
            stage: Stage::Idle,
            effects: Vec::new(),
            #[cfg(test)]
            seams: tests::Seams::default(),
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Analysis gray size `(width, height)`.
    pub fn analysis_size(&self) -> (usize, usize) {
        self.analysis
    }

    /// The pose graph: the host hydrates it before the first frame and relaxes it after the last.
    pub fn graph(&self) -> &PoseGraph {
        &self.graph
    }

    pub fn graph_mut(&mut self) -> &mut PoseGraph {
        &mut self.graph
    }

    /// Hands the pose graph over (to relax it once the frames are done), leaving an empty one.
    pub fn take_graph(&mut self) -> PoseGraph {
        std::mem::take(&mut self.graph)
    }

    /// The effects produced since the last call, in order.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// Starts frame `index` at `time` with its scan record.
    pub fn begin_frame(
        &mut self,
        index: u32,
        time: f64,
        scan: ScanFields,
    ) -> Result<Begin, SolveError> {
        if !matches!(self.stage, Stage::Idle) {
            return Err(SolveError::BadInput("a frame is already in progress"));
        }
        if scan.duplicate && self.states.iter().all(|s| !s.blind) {
            if let Some(previous) = &mut self.previous_plan {
                for p in previous.iter_mut() {
                    p.time = time;
                }
                let placements = previous.clone();
                for s in &mut self.states {
                    s.velocity = (0.0, 0.0);
                }
                return Ok(Begin::Duplicate(placements));
            }
        }
        self.current_slot = match self.previous_slot {
            Some(p) => 1 - p,
            None => 0,
        };
        self.stage = Stage::AwaitFrame { index, time, scan };
        Ok(Begin::NeedFrame {
            gray: !(scan.duplicate && self.previous_gray.is_some()),
        })
    }

    /// The RGBA slot the frame [`Begin::NeedFrame`] asked for is written into (`width × height × 4` bytes).
    pub fn frame_mut(&mut self) -> &mut [u8] {
        &mut self.frames[self.current_slot]
    }

    /// Solves the frame written into [`Self::frame_mut`]. `gray` is its analysis gray when the host computed one
    /// (else the session computes it); `features` its stored features, if any. `labels` is the atlas label plane
    /// (`width × height`).
    pub fn run_frame(
        &mut self,
        gray: Option<Vec<u8>>,
        features: Option<Vec<Feature>>,
        labels: &[u8],
    ) -> Result<Poll, SolveError> {
        let Stage::AwaitFrame { index, time, scan } =
            std::mem::replace(&mut self.stage, Stage::Idle)
        else {
            return Err(SolveError::BadInput("no frame was asked for"));
        };
        if labels.len() != self.width * self.height {
            return Err(SolveError::BadInput(
                "the label plane does not match the frame",
            ));
        }
        let (aw, ah) = self.analysis;
        let gray = match (scan.duplicate, &self.previous_gray, gray) {
            (true, Some(previous), _) => previous.clone(),
            (_, _, Some(data)) => {
                if data.len() != aw * ah {
                    return Err(SolveError::BadInput(
                        "analysis gray size differs from the run",
                    ));
                }
                Arc::new(Plane {
                    width: aw,
                    height: ah,
                    data,
                })
            }
            _ => {
                let mut data = vec![0; aw * ah];
                downscale_gray(
                    &self.frames[self.current_slot],
                    self.width,
                    self.height,
                    self.factor as usize,
                    &mut data,
                );
                Arc::new(Plane {
                    width: aw,
                    height: ah,
                    data,
                })
            }
        };
        let features = match features {
            Some(f) if !scan.duplicate => Arc::new(f.into_iter().map(stored).collect()),
            _ => match (scan.duplicate, &self.previous_features) {
                (true, Some(previous)) => previous.clone(),
                _ => Arc::new(
                    extract_features(&gray.data, aw, ah, FALLBACK_FEATURES, None)
                        .into_iter()
                        .map(stored)
                        .collect(),
                ),
            },
        };
        self.native_filled = false;
        self.stage = Stage::Frame(Box::new(FrameWork {
            index,
            time,
            scan,
            gray,
            features,
            placements: Vec::with_capacity(self.regions.len()),
            region: 0,
            step: None,
            joined_ring: false,
        }));
        self.advance(labels, None)
    }

    /// Hands in the rows [`Poll::NeedKeyframes`] named, in that order; `None` for a row the store did not have.
    pub fn provide_keyframes(
        &mut self,
        rows: Vec<Option<Keyframe>>,
        labels: &[u8],
    ) -> Result<Poll, SolveError> {
        let waiting = match &self.stage {
            Stage::Frame(work) => work.step.as_ref().is_some_and(|s| s.waiting()),
            _ => false,
        };
        if !waiting {
            return Err(SolveError::BadInput("no keyframes were asked for"));
        }
        self.advance(labels, Some(rows))
    }

    /// Steps regions until one waits for keyframes or the frame is done.
    fn advance(
        &mut self,
        labels: &[u8],
        mut rows: Option<Vec<Option<Keyframe>>>,
    ) -> Result<Poll, SolveError> {
        loop {
            let Stage::Frame(work) = &mut self.stage else {
                return Err(SolveError::BadInput("no frame in progress"));
            };
            if work.region == self.regions.len() {
                return Ok(Poll::Done(self.finish_frame()));
            }
            let i = work.region;
            let step = work.step.take();
            let ctx = region::FrameCtx {
                index: work.index,
                time: work.time,
                scan: work.scan,
                gray: work.gray.clone(),
                features: work.features.clone(),
            };
            let result = match step {
                None => self.step_region(i, &ctx, labels),
                Some(step) => self.resume_region(i, &ctx, *step, rows.take().unwrap_or_default()),
            };
            let Stage::Frame(work) = &mut self.stage else {
                unreachable!()
            };
            match result {
                Ok(region::Outcome::Placed(placement, observed)) => {
                    work.joined_ring |= observed;
                    work.placements.push(placement);
                    work.region += 1;
                }
                Ok(region::Outcome::Wait(step, ids)) => {
                    work.step = Some(step);
                    return Ok(Poll::NeedKeyframes(ids));
                }
                Err(e) => {
                    self.stage = Stage::Idle;
                    return Err(e);
                }
            }
        }
    }

    /// Joins the ring, remembers this frame as the previous one, and returns what the frame produced.
    fn finish_frame(&mut self) -> FrameDone {
        let Stage::Frame(work) = std::mem::replace(&mut self.stage, Stage::Idle) else {
            unreachable!()
        };
        let FrameWork {
            index,
            gray,
            features,
            placements,
            joined_ring,
            ..
        } = *work;
        let voting = if joined_ring {
            let finalized = self.voting.push_frame(index);
            self.records(finalized)
        } else {
            Vec::new()
        };
        self.previous_plan = Some(placements.clone());
        self.previous_features = Some(features);
        self.previous_slot = Some(self.current_slot);
        self.previous_gray = Some(gray);
        FrameDone {
            placements,
            joined_ring,
            voting,
        }
    }

    fn records(&self, finalized: Vec<Finalized>) -> Vec<VotingRecord> {
        let moving: Vec<&SolveRegion> = self.regions.iter().filter(|r| r.moving).collect();
        finalized
            .into_iter()
            .map(|f| VotingRecord {
                index: f.index,
                verdicts: f
                    .verdicts
                    .into_iter()
                    .map(|v| {
                        let b = self.voting.slots[v.slot].box_;
                        VotingVerdict {
                            region: moving[v.slot].id.clone(),
                            x0: b.x0,
                            y0: b.y0,
                            w: b.w,
                            h: b.h,
                            bits: v.bits,
                            clean: v.clean,
                        }
                    })
                    .collect(),
                voted_layers: f.voted_layers,
                thin_layers: f.thin_layers,
            })
            .collect()
    }

    /// Finalises every frame still resident in the voting ring (the end of the pass).
    pub fn drain_voting(&mut self) -> Vec<VotingRecord> {
        let finalized = self.voting.drain();
        self.records(finalized)
    }

    /// Fills the native luma plane from the current frame, once per frame.
    fn native(&mut self) -> &[u8] {
        if !self.native_filled {
            grayscale(&self.frames[self.current_slot], &mut self.native);
            self.native_filled = true;
        }
        &self.native
    }

    fn canvas_slot(&mut self, canvas_id: &str) -> u32 {
        let next = self.canvas_slots.len() as u32;
        *self
            .canvas_slots
            .entry(canvas_id.to_string())
            .or_insert(next)
    }

    /// Starts region `i`'s canvas `<id>-part-<fragment>` at `time`.
    fn new_canvas(&mut self, i: usize, time: f64) {
        let region = &self.regions[i];
        let state = &mut self.states[i];
        state.canvas_id = format!("{}-part-{}", region.id, state.fragment);
        let name = if state.fragment > 0 {
            format!("{} · 未定位片段 {}", region.name, state.fragment)
        } else {
            region.name.clone()
        };
        let meta = CanvasMeta {
            id: state.canvas_id.clone(),
            layer: region.id.clone(),
            name,
            kind: region.kind.clone(),
            fragment: state.fragment,
            first_time: time,
            last_time: time,
            attached_to: None,
        };
        self.canvases.insert(meta.id.clone(), meta.clone());
        self.effects.push(Effect::Canvas {
            meta,
            created: true,
        });
    }

    fn diagnostic(&mut self, d: Diagnostic) {
        self.effects.push(Effect::Diagnostic(d));
    }

    fn graph_writes(&mut self, writes: Vec<Write>) {
        self.effects.extend(writes.into_iter().map(Effect::Graph));
    }

    /// Candidate keyframes of region `i` for a query at `frame`: emits the budget warning when due.
    fn retrieve(
        &mut self,
        i: usize,
        frame: u32,
        own: &[Feature],
        exclude: Option<&str>,
    ) -> Retrieval {
        let descriptors: Vec<_> = own.iter().map(|f| f.descriptor).collect();
        let retrieval =
            self.index
                .retrieve(&self.regions[i].id, frame, &descriptors, exclude, None);
        if retrieval.budget_warning {
            self.diagnostic(Diagnostic::new(
                crate::engine::keyframes::BUDGET_DIAGNOSTIC,
                Severity::Warning,
            ));
        }
        retrieval
    }
}

#[cfg(test)]
mod tests;
