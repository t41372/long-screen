//! The render pass (docs/ARCHITECTURE.md §七): every solved placement of every frame resolved to its final canvas
//! and pose, checked against the frames either side of it, and painted into the tile cache by the [`Compositor`].
//!
//! A [`RenderSession`] holds what the pass keeps for its whole length: the region table, the attachment chain, a
//! three-slot frame ring (previous, current, lookahead), the world-consistency mask, the last-painted pixels of every
//! fixed region, the last placement of every layer, a four-slot window over solve's voting records, and the canvas
//! metadata the pass updates. The host drives it one frame at a time:
//!
//! 1. [`RenderSession::wanted_votes`] names the `consistency/<frame>` records the window does not hold yet; the host
//!    reads them and hands them to [`RenderSession::begin`] with the frame's plan and its neighbours' plans.
//! 2. [`RenderSession::step`] runs the frame's placements in order until it needs something only the host has:
//!    a canvas's stored metadata ([`RenderStep::NeedMeta`] → [`RenderSession::provide_meta`]), a decoded frame's
//!    pixels ([`RenderStep::NeedFrame`] → write them into [`RenderSession::frame_slot`]), a tile or a canvas's
//!    temporal records (the compositor's own needs, passed through), and returns [`RenderStep::Done`] with the
//!    frame's observation row once every placement is through.
//! 3. [`RenderSession::take_events`] after every step (also a failed one) returns the diagnostics raised so far,
//!    in emission order; [`RenderSession::take_dirty_metas`] on the host's flush cadence returns the canvases whose
//!    metadata changed since the last flush, in first-changed order.
//!
//! The session borrows the tile cache, the compositor and the pose graph for each step (a [`RenderIo`]); it owns none
//! of them, so the host keeps flushing tiles and temporal records exactly as before. It reads no clock: `now` comes
//! with every step and only stamps the tiles it writes.
//!
//! Frames enter the ring only when a placement first needs them, and a new frame takes the slot filled longest ago
//! among those holding none of the frame in progress and its two neighbours. A placement keeps the slots it was
//! given while it loads the frames it still lacks, so a slot one of them holds must not be reused. After two frames
//! that paint nothing, the next frame t loads itself before frame t−1; reusing plainly the slot filled longest ago
//! then put frame t+2 into frame t's slot while frame t+1 still compared against it, so frame t+1's mask read frame
//! t+2's pixels in frame t's place.

use crate::engine::attachments::{render_shift, resolve_target, Attachment, Attachments};
use crate::engine::compositor::{
    CompositeError, Compositor, CompositorDiagnostic, Frame, Placement, Step as CompositorStep,
};
use crate::engine::diagnostic::{Diagnostic, Severity, Value};
use crate::engine::pose_graph::{PoseGraph, PoseGraphError};
use crate::engine::tiles::{TileCache, TileKey};
use crate::kernels::consistency::{
    consistency_mask, fixed_mask, sum_limit, FixedMaskInput, MaskInput, Neighbour, Vote,
};
use crate::kernels::fixed_history::FixedHistory;
use crate::kernels::geometry::{js_round, Rect};
use crate::kernels::raster::fixed_update;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::Arc;

/// A fixed region that settled into a new state in more than this share of its frames is not one bar with a few
/// states but content changing under it (test_8's translucent header: 325 of 599 frames; real bars: at most 83
/// of 1,258). It keeps its first frame instead of its last state. A short recording needs more
/// than [`DYNAMIC_FRAMES`] such frames too: one bar appearing in a four-frame clip is not content moving under it.
const DYNAMIC_SHARE: f64 = 0.2;
const DYNAMIC_FRAMES: u32 = 10;

pub use crate::engine::solve::{is_valid_pose, POSE_BOUND};

/// Frames the ring holds: the previous, the current and the lookahead frame.
pub const RING_FRAMES: usize = 3;
/// Voting records the window keeps: a frame and both neighbours, plus one, so consecutive frames read one new
/// record each.
pub const VOTING_WINDOW: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionKind {
    Moving,
    Fixed,
    Ignore,
}

/// One region of the run's atlas.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderRegion {
    pub id: String,
    pub kind: RegionKind,
    /// The region's rect on screen.
    pub rect: Rect,
    /// Its code in the atlas label plane and how many pixels the atlas gives it.
    pub code: u8,
    pub owned_pixels: f64,
}

/// One placement of a stored plan (`plan/<frame>`), in the row's field order. `skip` and `occlusions` are absent
/// from the row unless set, and stay absent in the observation row built from it.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanPlacement {
    pub layer: String,
    pub canvas_id: String,
    pub node: String,
    pub x: f64,
    pub y: f64,
    pub confidence: f64,
    pub uncertain: bool,
    pub time: f64,
    pub skip: Option<bool>,
    pub occlusions: Option<Vec<Rect>>,
}

impl PlanPlacement {
    fn skipped(&self) -> bool {
        self.skip == Some(true)
    }
}

/// What render reads of a stored plan.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FramePlan {
    pub placements: Vec<PlanPlacement>,
    pub duplicate: bool,
}

/// Solve's displacement-spread verdict for one region of one frame (`consistency/<frame>`, docs/ARCHITECTURE.md §七):
/// the analysis-resolution box it scored and two bitsets over it, LSB first — cells found inconsistent, cells found
/// confidently consistent.
#[derive(Clone, Debug, PartialEq)]
pub struct ConsistencyVote {
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
    pub bits: Vec<u8>,
    pub clean: Vec<u8>,
}

/// One frame's `consistency/<frame>` record, by region id.
pub type ConsistencyRecord = HashMap<String, ConsistencyVote>;

/// The fields of a canvas's stored metadata (`canvas/<id>`) the render pass updates; the host keeps the rest of the
/// row and writes these back into it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasMeta {
    pub bounds: Rect,
    pub tile_count: f64,
    pub observed_pixels: f64,
    pub uncertain_pixels: f64,
    pub conflict_pixels: f64,
    pub provisional_pixels: f64,
    pub last_time: f64,
}

/// One placement's line in the observation ledger (`observation/<frame>`): the canvas it targeted, its final
/// render-time placement, and either its pixel contribution or which shortcut skipped painting it.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderDecision {
    pub canvas_id: String,
    pub placement: PlanPlacement,
    pub added_pixels: f64,
    pub conflict_pixels: f64,
    pub uncertain_pixels: f64,
    /// Written as `skipped: true` when set, absent otherwise.
    pub skipped: bool,
    /// Written as `reusedExactObservation: true` when set, absent otherwise.
    pub reused_exact_observation: bool,
}

/// The `observation/<frame>` row.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub frame: u32,
    pub time: f64,
    pub decisions: Vec<RenderDecision>,
}

/// What a finished frame leaves the host: its ledger row, and the canvas of the last moving-region placement it
/// painted or reused (the progress event's canvas), if any.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameOutcome {
    pub observation: Observation,
    pub latest: Option<String>,
}

/// The pass-level counters a step changes, cumulative over the session.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RenderCounters {
    /// Placements the duplicate or fixed-region-unchanged shortcut did not paint.
    pub skipped_paints: u64,
    /// Tiles first painted.
    pub tiles: f64,
    /// Pixels first painted.
    pub observed_pixels: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenderStep {
    /// The canvas's stored metadata is needed: [`RenderSession::provide_meta`], then step again.
    NeedMeta(String),
    /// The frame's pixels are needed: write them into [`RenderSession::frame_slot`], then step again.
    NeedFrame(u32),
    /// The compositor needs this tile resident: make room, insert it, step again.
    NeedTile(TileKey),
    /// The compositor needs this canvas's stored temporal records: [`Compositor::load_temporal`], step again.
    NeedTemporal(String),
    Done(FrameOutcome),
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenderError {
    /// `begin` while a frame is in progress, or `step` without one.
    Busy,
    NoFrame,
    /// The labels or a frame do not have the session's size.
    FrameSize,
    /// The host did not hand over a voting record [`RenderSession::wanted_votes`] asked for.
    MissingVote(i64),
    /// A voting record's bitsets are shorter than its box, or its box is empty.
    BadVote,
    /// A placement names a layer the region table does not hold.
    UnknownRegion(String),
    /// The canvas a placement resolved to has no stored metadata.
    MissingMeta(String),
    /// A pose graph lookup failed (a placement's or an attachment's node is missing).
    Graph(PoseGraphError),
    /// The compositor refused the placement: its rect leaves the addressable canvas.
    OutsideCanvas {
        x: f64,
        y: f64,
        region: String,
    },
    /// The compositor's temporal records for the canvas were already disposed.
    Disposed(String),
    /// Any other compositor failure.
    Compositor(CompositeError),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::Busy => f.write_str("A frame is already being rendered."),
            RenderError::NoFrame => f.write_str("No frame is being rendered."),
            RenderError::FrameSize => f.write_str("Frame does not match the run's size."),
            RenderError::MissingVote(i) => write!(f, "Voting record {i} was not provided."),
            RenderError::BadVote => f.write_str("CORE_BAD_ARGUMENT: truncated consistency vote bitset."),
            RenderError::UnknownRegion(id) => write!(f, "Region {id} is not part of this atlas."),
            RenderError::MissingMeta(_) => f.write_str("Canvas metadata is missing."),
            RenderError::Graph(e) => e.fmt(f),
            RenderError::OutsideCanvas { x, y, region } => write!(
                f,
                "Placement ({x}, {y}) puts region {region} outside the addressable canvas."
            ),
            RenderError::Disposed(canvas) => write!(
                f,
                "CORE_BAD_ARGUMENT: temporalIndex({canvas}) called after dispose() already drained and froze its state."
            ),
            RenderError::Compositor(e) => write!(f, "Compositor failed: {e:?}."),
        }
    }
}

impl std::error::Error for RenderError {}

impl From<PoseGraphError> for RenderError {
    fn from(e: PoseGraphError) -> Self {
        RenderError::Graph(e)
    }
}

/// What the session borrows for one step.
pub struct RenderIo<'a> {
    pub cache: &'a mut TileCache,
    pub compositor: &'a mut Compositor,
    pub graph: &'a PoseGraph,
    /// The atlas label plane, frame-sized.
    pub labels: &'a [u8],
    /// The host's clock, stamped on every tile this step writes.
    pub now: f64,
}

/// What the host knows about one frame when it composites it.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameInput {
    pub index: u32,
    /// The decoded frame's time (the observation row's `time`).
    pub time: f64,
    pub plan: FramePlan,
    /// Whether the previous / next decoded frame is in hand, and its stored plan when there is one.
    pub has_prev: bool,
    pub prev_plan: Option<FramePlan>,
    pub has_next: bool,
    pub next_plan: Option<FramePlan>,
}

/// Run-wide constants of a session.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderConfig {
    pub width: usize,
    pub height: usize,
    /// Integer analysis factor: analysis pixels × factor = native pixels.
    pub factor: i32,
    /// Per-channel decode noise the source declares; the mask's tolerance.
    pub noise: f64,
    /// The atlas's regions, in atlas order.
    pub regions: Vec<RenderRegion>,
    pub attachments: Vec<Attachment>,
}

/// A placement resolved to its final canvas and pose.
#[derive(Clone, Debug, PartialEq)]
struct Resolved {
    canvas: String,
    x: f64,
    y: f64,
}

/// One slot of the frame ring: which frame it holds and when that frame entered.
struct Slot {
    pixels: Vec<u8>,
    index: i64,
    used: u64,
}

/// Resident frames keyed by frame index. A new frame takes the slot filled longest ago that holds none of the frames
/// the frame in progress compares (see [`FrameRing::fill`]); reading a frame does not change that order.
struct FrameRing {
    slots: Vec<Slot>,
    tick: u64,
    bytes: usize,
}

impl FrameRing {
    fn new(bytes: usize) -> Self {
        Self {
            slots: Vec::with_capacity(RING_FRAMES),
            tick: 0,
            bytes,
        }
    }

    fn get(&self, index: i64) -> Option<usize> {
        self.slots.iter().position(|s| s.index == index)
    }

    /// The slot frame `index` goes into. While a frame is being composited, `keep` is the first and last frame it
    /// compares (its previous and next): a slot holding one of those is never reused, because a placement reads
    /// the slots it was given after loading the frames it still lacks. With three slots and three such frames,
    /// a frame that is not resident always leaves a slot outside `keep`.
    fn fill(&mut self, index: i64, keep: Option<(i64, i64)>) -> usize {
        if let Some(slot) = self.get(index) {
            return slot;
        }
        let slot = if self.slots.len() < RING_FRAMES {
            self.slots.push(Slot {
                pixels: vec![0; self.bytes],
                index,
                used: 0,
            });
            self.slots.len() - 1
        } else {
            let kept = |s: &Slot| keep.is_some_and(|(a, b)| (a..=b).contains(&s.index));
            let oldest = |free: bool| {
                (0..self.slots.len())
                    .filter(|&i| !free || !kept(&self.slots[i]))
                    .min_by_key(|&i| self.slots[i].used)
            };
            oldest(true).or_else(|| oldest(false)).unwrap()
        };
        self.tick += 1;
        let s = &mut self.slots[slot];
        s.index = index;
        s.used = self.tick;
        slot
    }
}

/// The last few frames' voting records, newest last; a missing record is kept as `None` like a present one.
#[derive(Default)]
struct VotingWindow {
    entries: VecDeque<(i64, Option<Arc<ConsistencyRecord>>)>,
}

impl VotingWindow {
    /// The indices of `gets`, in order, that the window will not hold when they are asked for (negative indices
    /// are never stored rows, so they are not wanted).
    fn wanted(&self, gets: &[i64]) -> Vec<i64> {
        let mut held: VecDeque<i64> = self.entries.iter().map(|(i, _)| *i).collect();
        let mut wanted = Vec::new();
        for &index in gets {
            if held.contains(&index) {
                continue;
            }
            if index >= 0 {
                wanted.push(index);
            }
            held.push_back(index);
            if held.len() > VOTING_WINDOW {
                held.pop_front();
            }
        }
        wanted
    }

    fn get(
        &mut self,
        index: i64,
        provided: &mut HashMap<i64, Option<ConsistencyRecord>>,
    ) -> Result<Option<Arc<ConsistencyRecord>>, RenderError> {
        if let Some((_, record)) = self.entries.iter().find(|(i, _)| *i == index) {
            return Ok(record.clone());
        }
        let record = if index < 0 {
            None
        } else {
            provided
                .remove(&index)
                .ok_or(RenderError::MissingVote(index))?
                .map(Arc::new)
        };
        self.entries.push_back((index, record.clone()));
        if self.entries.len() > VOTING_WINDOW {
            self.entries.pop_front();
        }
        Ok(record)
    }
}

/// A neighbour frame's placement for the same layer, resolved, and the ring slot its pixels went into.
struct NeighbourPlacement {
    resolved: Resolved,
    occlusions: Vec<Rect>,
    slot: Option<usize>,
}

/// Where the placement in progress is.
enum Stage {
    /// Not started: skip, resolve, validate.
    Start,
    /// Resolved; its canvas metadata is needed.
    Meta(Resolved),
    /// A fixed region whose plan-level shortcut did not apply: compare against the saved copy.
    Fixed(Resolved),
    /// Shortcuts decided.
    Decide(Resolved, bool),
    /// Painting: the current frame, then (moving regions) both neighbours and the mask, then the compositor.
    Paint(Paint),
}

struct Paint {
    p: Resolved,
    current: Option<usize>,
    /// For a moving region: the neighbours, resolved once the current frame is in (`None` until then).
    neighbours: Option<[Option<NeighbourPlacement>; 2]>,
    masked: bool,
    begun: bool,
}

struct FrameJob {
    input: FrameInput,
    votes: [Option<Arc<ConsistencyRecord>>; 3],
    placement: usize,
    stage: Stage,
    decisions: Vec<RenderDecision>,
    latest: Option<String>,
}

/// What the session knows about one fixed region's states over the run.
struct FixedState {
    history: FixedHistory,
    /// Frames that placed the region, and those of them that settled some block into a new state.
    frames: u32,
    settled: u32,
    /// Once the run is finished: the first frame without transients (as it was, for a dynamic region).
    first: Option<Vec<u32>>,
}

/// The finishing job: dynamic fixed regions, whose canvas takes their first frame back.
struct FinishJob {
    regions: Vec<usize>,
    at: usize,
    begun: bool,
    frame: u32,
    time: f64,
}

pub struct RenderSession {
    width: usize,
    height: usize,
    factor: i32,
    noise: f64,
    regions: Vec<RenderRegion>,
    region_index: HashMap<String, usize>,
    attachments: Attachments,
    ring: FrameRing,
    mask: Vec<u8>,
    fixed: HashMap<String, Vec<u8>>,
    states: HashMap<String, FixedState>,
    finish: Option<FinishJob>,
    last: Option<(u32, f64)>,
    previous: HashMap<String, Resolved>,
    votes: VotingWindow,
    metas: HashMap<String, CanvasMeta>,
    missing_meta: Option<String>,
    dirty: Vec<String>,
    dirty_set: HashSet<String>,
    counters: RenderCounters,
    events: Vec<Diagnostic>,
    job: Option<FrameJob>,
}

impl RenderSession {
    pub fn new(config: RenderConfig) -> Self {
        let mut region_index = HashMap::new();
        for (i, r) in config.regions.iter().enumerate() {
            region_index.insert(r.id.clone(), i);
        }
        let attachments: Attachments = config
            .attachments
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
        let pixels = config.width * config.height;
        Self {
            width: config.width,
            height: config.height,
            factor: config.factor,
            noise: config.noise,
            regions: config.regions,
            region_index,
            attachments,
            ring: FrameRing::new(pixels * 4),
            mask: vec![1; pixels],
            fixed: HashMap::new(),
            states: HashMap::new(),
            finish: None,
            last: None,
            previous: HashMap::new(),
            votes: VotingWindow::default(),
            metas: HashMap::new(),
            missing_meta: None,
            dirty: Vec::new(),
            dirty_set: HashSet::new(),
            counters: RenderCounters::default(),
            events: Vec::new(),
            job: None,
        }
    }

    /// Sizes the tile cache for this pass: the memory setting less what the pass itself holds (the ring's frames
    /// and the frame-sized planes around them, each fixed region's saved copy and history, 8 MB of headroom), then
    /// raised to what one frame paints. Returns the `MEMORY_BUDGET_RAISED` diagnostic (info) when it had to raise the limit:
    /// `from`, `to` and `mb` for the message, and a `{ budgetMB, tiles, raisedBy }` detail.
    pub fn configure_tiles(&self, cache: &mut TileCache, memory_mb: f64) -> Option<Diagnostic> {
        let fixed_bytes = self
            .regions
            .iter()
            .filter(|r| r.kind == RegionKind::Fixed)
            .fold(0.0, |n, r| {
                n + r.rect.width.ceil() * r.rect.height.ceil() * 4.0 + FixedHistory::bytes(r.rect)
            });
        let (w, h) = (self.width as f64, self.height as f64);
        cache.configure_budget(
            memory_mb,
            w * h * 5.0 + fixed_bytes + 8.0 * 1024.0 * 1024.0 + w * h * 4.0,
        );
        let areas: Vec<(f64, f64)> = self
            .regions
            .iter()
            .filter(|r| r.kind != RegionKind::Ignore)
            .map(|r| (r.rect.width, r.rect.height))
            .collect();
        let raised = cache.ensure_footprint(&areas);
        if raised == 0 {
            return None;
        }
        let to = cache.max_tiles();
        let size = cache.size() as f64;
        Some(
            Diagnostic::new("MEMORY_BUDGET_RAISED", Severity::Info)
                .param("from", (to - raised) as f64)
                .param("to", to as f64)
                .param(
                    "mb",
                    js_round(to as f64 * size * size * 4.3 / 1024.0 / 1024.0) as f64,
                )
                .detail(Value::Object(vec![
                    ("budgetMB", Value::Number(memory_mb)),
                    ("tiles", Value::Number(to as f64)),
                    ("raisedBy", Value::Number(raised as f64)),
                ])),
        )
    }

    pub fn counters(&self) -> RenderCounters {
        self.counters
    }

    /// The canvas's metadata as the pass holds it now, if it has been loaded.
    pub fn meta(&self, canvas: &str) -> Option<CanvasMeta> {
        self.metas.get(canvas).copied()
    }

    /// Diagnostics raised since the last call, in emission order: `NONFINITE_POSE` (error; a placement's resolved
    /// pose cannot be placed, it is recorded as skipped at (0, 0)), and the compositor's `INCOMPLETE_TEMPORAL_PATCH`
    /// and `TEMPORAL_OR_ALIGNMENT_CONFLICT` (warnings; `conflicts` the pixels detected before patching, every
    /// conflicting rect in `detail.regions`).
    pub fn take_events(&mut self) -> Vec<Diagnostic> {
        std::mem::take(&mut self.events)
    }

    /// Canvases whose metadata changed since the last call, in the order they first changed, with their current
    /// values.
    pub fn take_dirty_metas(&mut self) -> Vec<(String, CanvasMeta)> {
        self.dirty_set.clear();
        std::mem::take(&mut self.dirty)
            .into_iter()
            .map(|id| {
                let meta = self.metas[&id];
                (id, meta)
            })
            .collect()
    }

    /// The `consistency/<frame>` records the host should read for frame `index` (in this order) before
    /// [`RenderSession::begin`]: the frame's own, then its previous and next frame's when those are in hand,
    /// leaving out what the window still holds.
    pub fn wanted_votes(&self, index: u32, has_prev: bool, has_next: bool) -> Vec<i64> {
        self.votes.wanted(&vote_gets(index, has_prev, has_next))
    }

    /// Starts compositing one frame. `votes` are the records [`RenderSession::wanted_votes`] named, `None` where
    /// no row is stored.
    pub fn begin(
        &mut self,
        input: FrameInput,
        votes: Vec<(i64, Option<ConsistencyRecord>)>,
    ) -> Result<(), RenderError> {
        if self.job.is_some() || self.finish.is_some() {
            return Err(RenderError::Busy);
        }
        self.last = Some((input.index, input.time));
        let mut provided: HashMap<i64, Option<ConsistencyRecord>> = votes.into_iter().collect();
        let index = input.index as i64;
        let own = self.votes.get(index, &mut provided)?;
        let prev = if input.has_prev {
            self.votes.get(index - 1, &mut provided)?
        } else {
            None
        };
        let next = if input.has_next {
            self.votes.get(index + 1, &mut provided)?
        } else {
            None
        };
        self.job = Some(FrameJob {
            input,
            votes: [own, prev, next],
            placement: 0,
            stage: Stage::Start,
            decisions: Vec::new(),
            latest: None,
        });
        Ok(())
    }

    /// Abandons the frame in progress (the host failed or stopped between steps), and the compositor's placement
    /// with it. What the frame already changed (metadata, saved fixed-region pixels, last placements) stays, as it
    /// did when the pass failed mid-frame before.
    pub fn cancel(&mut self, compositor: &mut Compositor) {
        if self.job.take().is_some() {
            compositor.cancel();
        }
        self.missing_meta = None;
    }

    /// Hands over the metadata of the canvas [`RenderStep::NeedMeta`] asked for; `None` when no row is stored (the
    /// next step then fails).
    pub fn provide_meta(&mut self, canvas: &str, meta: Option<CanvasMeta>) {
        match meta {
            Some(meta) => {
                self.metas.insert(canvas.to_string(), meta);
            }
            None => self.missing_meta = Some(canvas.to_string()),
        }
    }

    /// The ring slot frame `index` goes into, for the host to write its RGBA after [`RenderStep::NeedFrame`]. The
    /// slot filled longest ago is reused, but never one holding the frame in progress or either of its neighbours.
    pub fn frame_slot(&mut self, index: u32) -> &mut [u8] {
        let keep = self.job.as_ref().map(|j| {
            let at = j.input.index as i64;
            (at - 1, at + 1)
        });
        let slot = self.ring.fill(index as i64, keep);
        &mut self.ring.slots[slot].pixels
    }

    /// Runs the frame until it needs something from the host or is done. On an error the frame is abandoned (and
    /// the compositor's placement cancelled); the session stays usable.
    pub fn step(&mut self, io: &mut RenderIo) -> Result<RenderStep, RenderError> {
        if self.finish.is_some() {
            let result = self.run_finish(io);
            if result.is_err() {
                self.finish = None;
                io.compositor.cancel();
            }
            return result;
        }
        let mut job = self.job.take().ok_or(RenderError::NoFrame)?;
        let result = if io.labels.len() != self.width * self.height {
            Err(RenderError::FrameSize)
        } else {
            self.run(&mut job, io)
        };
        match result {
            Ok(RenderStep::Done(_)) => {}
            Ok(_) => self.job = Some(job),
            Err(_) => {
                if matches!(job.stage, Stage::Paint(Paint { begun: true, .. })) {
                    io.compositor.cancel();
                }
                self.missing_meta = None;
            }
        }
        result
    }

    /// Ends the run's fixed regions after the last frame: each one's first epoch closes and its first frame without
    /// transients is worked out, and a region whose state kept changing (more than [`DYNAMIC_SHARE`] of its frames,
    /// and more than [`DYNAMIC_FRAMES`], settled into a new state) gets its first frame back on its canvas, as it
    /// was, instead of its last state. Returns whether there is anything to paint;
    /// when there is, step the session as for a frame until [`RenderStep::Done`] (its observation is empty and is
    /// not a ledger row). Call once, after the last frame.
    pub fn begin_finish(&mut self) -> Result<bool, RenderError> {
        if self.job.is_some() || self.finish.is_some() {
            return Err(RenderError::Busy);
        }
        let Some((last, time)) = self.last else {
            return Ok(false);
        };
        let limit = sum_limit(self.noise);
        let mut regions = Vec::new();
        for (at, region) in self.regions.iter().enumerate() {
            let Some(state) = self.states.get_mut(&region.id) else {
                continue;
            };
            if state.first.is_some() {
                continue;
            }
            state.history.close(last + 1);
            let dynamic = state.settled > DYNAMIC_FRAMES
                && state.settled as f64 > DYNAMIC_SHARE * state.frames as f64;
            // Content moving under a dynamic region also changes in small patches; none of them is a transient
            // over the bar, so its first frame is kept as it was.
            state.first = Some(if dynamic {
                state.history.frame0().to_vec()
            } else {
                state.history.first(limit)
            });
            if dynamic && self.previous.contains_key(&region.id) {
                regions.push(at);
            }
        }
        if regions.is_empty() {
            return Ok(false);
        }
        let frame = self.states[&self.regions[regions[0]].id]
            .history
            .first_frame()
            .unwrap_or(0);
        self.finish = Some(FinishJob {
            regions,
            at: 0,
            begun: false,
            frame,
            time,
        });
        Ok(true)
    }

    /// Paints every fixed region's first frame without transients into `rgba` (`width × height`, the reference frame
    /// `frame`), after [`RenderSession::begin_finish`]; returns whether any pixel changed. Regions whose first
    /// observation was another frame are left alone.
    pub fn patch_reference(
        &self,
        rgba: &mut [u8],
        width: usize,
        height: usize,
        frame: u32,
    ) -> bool {
        if width != self.width || height != self.height || rgba.len() != width * height * 4 {
            return false;
        }
        let mut changed = false;
        for region in &self.regions {
            let Some(state) = self.states.get(&region.id) else {
                continue;
            };
            if let (Some(first), Some(from)) = (&state.first, state.history.first_frame()) {
                if from == frame {
                    changed |= state.history.paint(first, rgba, width, height);
                }
            }
        }
        changed
    }

    fn run_finish(&mut self, io: &mut RenderIo) -> Result<RenderStep, RenderError> {
        loop {
            let job = self.finish.as_mut().unwrap();
            let Some(&at) = job.regions.get(job.at) else {
                let (frame, time) = (job.frame, job.time);
                self.finish = None;
                return Ok(RenderStep::Done(FrameOutcome {
                    observation: Observation {
                        frame,
                        time,
                        decisions: Vec::new(),
                    },
                    latest: None,
                }));
            };
            let (begun, frame_index, time) = (job.begun, job.frame, job.time);
            let region = &self.regions[at];
            let p = self.previous[&region.id].clone();
            let slot = self.ring.fill(-2, None);
            if !begun {
                let state = &self.states[&region.id];
                state.history.paint(
                    state.first.as_ref().unwrap(),
                    &mut self.ring.slots[slot].pixels,
                    self.width,
                    self.height,
                );
                self.mask.fill(1);
                io.compositor
                    .begin(
                        io.cache,
                        Placement {
                            canvas: p.canvas.clone(),
                            region: region.rect,
                            code: region.code,
                            owned_pixels: region.owned_pixels,
                            x: p.x,
                            y: p.y,
                            frame: frame_index,
                            time,
                            confidence: 1.0,
                            uncertain: false,
                            occlusions: Vec::new(),
                            fixed: true,
                        },
                        self.width,
                        self.height,
                    )
                    .map_err(RenderError::Compositor)?;
                self.finish.as_mut().unwrap().begun = true;
            }
            let frame = Frame {
                rgba: &self.ring.slots[slot].pixels,
                width: self.width,
                height: self.height,
                labels: io.labels,
                consistent: Some(&self.mask[..]),
            };
            let outcome = match io.compositor.step(io.cache, &frame, io.now) {
                Ok(CompositorStep::NeedTile(key)) => return Ok(RenderStep::NeedTile(key)),
                Ok(CompositorStep::NeedTemporal(canvas)) => {
                    return Ok(RenderStep::NeedTemporal(canvas))
                }
                Ok(CompositorStep::Done(outcome)) => outcome,
                Err(e) => return Err(RenderError::Compositor(e)),
            };
            // What the canvas held is replaced, not contradicted: the rewrite reports no conflict of its own.
            if let Some(meta) = self.metas.get_mut(&p.canvas) {
                meta.observed_pixels += outcome.stats.added as f64;
                meta.provisional_pixels += outcome.stats.provisional_pixels as f64;
            }
            self.mark_dirty(&p.canvas);
            let job = self.finish.as_mut().unwrap();
            job.begun = false;
            job.at += 1;
        }
    }

    fn resolve(
        &self,
        raw: &PlanPlacement,
        frame: f64,
        graph: &PoseGraph,
    ) -> Result<Resolved, RenderError> {
        let (cx, cy) = graph.correction(&raw.node, frame)?;
        let (sx, sy) = render_shift(&self.attachments, &raw.canvas_id, graph)?;
        let canvas = resolve_target(&self.attachments, &raw.canvas_id).to_string();
        Ok(Resolved {
            canvas,
            x: raw.x + cx + sx,
            y: raw.y + cy + sy,
        })
    }

    fn region(&self, layer: &str) -> Result<usize, RenderError> {
        self.region_index
            .get(layer)
            .copied()
            .ok_or_else(|| RenderError::UnknownRegion(layer.to_string()))
    }

    fn mark_dirty(&mut self, canvas: &str) {
        if self.dirty_set.insert(canvas.to_string()) {
            self.dirty.push(canvas.to_string());
        }
    }

    fn run(&mut self, job: &mut FrameJob, io: &mut RenderIo) -> Result<RenderStep, RenderError> {
        loop {
            let Some(raw) = job.input.plan.placements.get(job.placement) else {
                return Ok(RenderStep::Done(FrameOutcome {
                    observation: Observation {
                        frame: job.input.index,
                        time: job.input.time,
                        decisions: std::mem::take(&mut job.decisions),
                    },
                    latest: job.latest.take(),
                }));
            };
            let raw = raw.clone();
            let index = job.input.index;
            match std::mem::replace(&mut job.stage, Stage::Start) {
                Stage::Start => {
                    if raw.skipped() {
                        job.decisions
                            .push(decision(raw.canvas_id.clone(), raw, None));
                        job.placement += 1;
                        continue;
                    }
                    let p = self.resolve(&raw, index as f64, io.graph)?;
                    if !is_valid_pose(p.x, p.y) {
                        self.events.push(
                            Diagnostic::new("NONFINITE_POSE", Severity::Error)
                                .at(index, raw.time)
                                .canvas(&p.canvas),
                        );
                        let placement = PlanPlacement {
                            canvas_id: p.canvas.clone(),
                            x: 0.0,
                            y: 0.0,
                            ..raw
                        };
                        job.decisions.push(decision(p.canvas, placement, None));
                        job.placement += 1;
                        continue;
                    }
                    job.stage = Stage::Meta(p);
                }
                Stage::Meta(p) => {
                    if !self.metas.contains_key(&p.canvas) {
                        if self.missing_meta.take().as_deref() == Some(p.canvas.as_str()) {
                            return Err(RenderError::MissingMeta(p.canvas));
                        }
                        let canvas = p.canvas.clone();
                        job.stage = Stage::Meta(p);
                        return Ok(RenderStep::NeedMeta(canvas));
                    }
                    let region = &self.regions[self.region(&raw.layer)?];
                    let unchanged = job.input.plan.duplicate
                        && self.previous.get(&raw.layer).is_some_and(|last| *last == p);
                    job.stage = if region.kind == RegionKind::Fixed && !unchanged {
                        Stage::Fixed(p)
                    } else {
                        Stage::Decide(p, unchanged)
                    };
                }
                Stage::Fixed(p) => {
                    let Some(slot) = self.ring.get(index as i64) else {
                        job.stage = Stage::Fixed(p);
                        return Ok(RenderStep::NeedFrame(index));
                    };
                    let region = &self.regions[self.region(&raw.layer)?];
                    let (rw, rh) = (
                        region.rect.width.ceil() as usize,
                        region.rect.height.ceil() as usize,
                    );
                    let old = self.fixed.contains_key(&region.id);
                    let saved = self
                        .fixed
                        .entry(region.id.clone())
                        .or_insert_with(|| vec![0; rw * rh * 4]);
                    let changed = fixed_update(
                        saved,
                        &self.ring.slots[slot].pixels,
                        io.labels,
                        self.width,
                        self.height,
                        region.rect.x.floor() as i64,
                        region.rect.y.floor() as i64,
                        rw,
                        rh,
                        region.code,
                    );
                    if !old {
                        let region = &self.regions[self.region(&raw.layer)?];
                        self.states.insert(
                            region.id.clone(),
                            FixedState {
                                history: FixedHistory::new(region.rect),
                                frames: 0,
                                settled: 0,
                                first: None,
                            },
                        );
                    }
                    job.stage = Stage::Decide(p, old && !changed);
                }
                Stage::Decide(p, unchanged) => {
                    self.previous.insert(raw.layer.clone(), p.clone());
                    if let Some(state) = self.states.get_mut(&raw.layer) {
                        state.frames += 1;
                    }
                    if !unchanged {
                        job.stage = Stage::Paint(Paint {
                            p,
                            current: None,
                            neighbours: None,
                            masked: false,
                            begun: false,
                        });
                        continue;
                    }
                    let moving = self.regions[self.region(&raw.layer)?].kind == RegionKind::Moving;
                    self.counters.skipped_paints += 1;
                    if let Some(meta) = self.metas.get_mut(&p.canvas) {
                        meta.last_time = raw.time;
                    }
                    self.mark_dirty(&p.canvas);
                    if moving {
                        job.latest = Some(p.canvas.clone());
                    }
                    let placement = placed(&raw, &p);
                    let mut d = decision(p.canvas, placement, Some((0.0, 0.0, 0.0)));
                    d.reused_exact_observation = true;
                    job.decisions.push(d);
                    job.placement += 1;
                }
                Stage::Paint(mut paint) => {
                    let step = self.paint(job, &raw, &mut paint, io);
                    match step {
                        Ok(None) => {
                            job.placement += 1;
                        }
                        Ok(Some(need)) => {
                            job.stage = Stage::Paint(paint);
                            return Ok(need);
                        }
                        Err(e) => {
                            job.stage = Stage::Paint(paint);
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    /// One painted placement; `Some` is a need to hand to the host, `None` that the placement is finished.
    fn paint(
        &mut self,
        job: &mut FrameJob,
        raw: &PlanPlacement,
        paint: &mut Paint,
        io: &mut RenderIo,
    ) -> Result<Option<RenderStep>, RenderError> {
        let index = job.input.index;
        let region_at = self.region(&raw.layer)?;
        let current = match paint.current {
            Some(slot) => slot,
            None => {
                let Some(slot) = self.ring.get(index as i64) else {
                    return Ok(Some(RenderStep::NeedFrame(index)));
                };
                paint.current = Some(slot);
                slot
            }
        };
        let kind = self.regions[region_at].kind;
        let moving = kind == RegionKind::Moving;
        let fixed = kind == RegionKind::Fixed;
        if (moving || fixed) && !paint.masked {
            if paint.neighbours.is_none() {
                paint.neighbours = Some(self.neighbours(job, raw, io.graph)?);
            }
            let neighbours = paint.neighbours.as_mut().unwrap();
            for (side, n) in neighbours.iter_mut().enumerate() {
                let Some(n) = n else { continue };
                if n.slot.is_none() {
                    let at = if side == 0 { index - 1 } else { index + 1 };
                    match self.ring.get(at as i64) {
                        Some(slot) => n.slot = Some(slot),
                        None => return Ok(Some(RenderStep::NeedFrame(at))),
                    }
                }
            }
            // Loading the next frame left the previous frame's slot alone (see `FrameRing::fill`).
            debug_assert!(neighbours.iter().enumerate().all(|(side, n)| {
                n.as_ref().is_none_or(|n| {
                    self.ring.slots[n.slot.unwrap()].index == index as i64 + 2 * side as i64 - 1
                })
            }));
            let region = &self.regions[region_at];
            if fixed {
                // The same screen pixels of the neighbouring frames that placed the region on this canvas.
                let [prev, next] = [0, 1].map(|side| {
                    neighbours[side]
                        .as_ref()
                        .filter(|n| n.resolved.canvas == paint.p.canvas)
                        .map(|n| &self.ring.slots[n.slot.unwrap()].pixels[..])
                });
                fixed_mask(
                    &FixedMaskInput {
                        rgba: &self.ring.slots[current].pixels,
                        labels: io.labels,
                        width: self.width,
                        height: self.height,
                        region: region.rect,
                        code: region.code,
                        prev,
                        next,
                        noise: self.noise,
                    },
                    &mut self.mask,
                );
                if let Some(state) = self.states.get_mut(&region.id) {
                    state.history.update(
                        &self.ring.slots[current].pixels,
                        io.labels,
                        &self.mask,
                        self.width,
                        self.height,
                        region.code,
                        index,
                        sum_limit(self.noise),
                    );
                }
                paint.masked = true;
            }
        }
        if moving && !paint.masked {
            let neighbours = paint.neighbours.as_ref().unwrap();
            let region = &self.regions[region_at];
            let own = vote(job.votes[0].as_deref(), &region.id)?;
            let mut sides: [Option<Neighbour>; 2] = [None, None];
            for (side, n) in neighbours.iter().enumerate() {
                let Some(n) = n else { continue };
                if n.resolved.canvas != paint.p.canvas {
                    continue;
                }
                sides[side] = Some(Neighbour {
                    rgba: &self.ring.slots[n.slot.unwrap()].pixels,
                    pose_x: n.resolved.x,
                    pose_y: n.resolved.y,
                    occlusions: &n.occlusions,
                    vote: vote(job.votes[side + 1].as_deref(), &region.id)?,
                });
            }
            let [prev, next] = sides;
            consistency_mask(
                &MaskInput {
                    rgba: &self.ring.slots[current].pixels,
                    labels: io.labels,
                    width: self.width,
                    height: self.height,
                    region: region.rect,
                    code: region.code,
                    pose_x: paint.p.x,
                    pose_y: paint.p.y,
                    prev,
                    next,
                    vote: own,
                    factor: self.factor,
                    noise: self.noise,
                },
                &mut self.mask,
            );
            paint.masked = true;
        }
        let region = &self.regions[region_at];
        if !paint.begun {
            io.compositor
                .begin(
                    io.cache,
                    Placement {
                        canvas: paint.p.canvas.clone(),
                        region: region.rect,
                        code: region.code,
                        owned_pixels: region.owned_pixels,
                        x: paint.p.x,
                        y: paint.p.y,
                        frame: index,
                        time: raw.time,
                        confidence: raw.confidence,
                        uncertain: raw.uncertain,
                        occlusions: raw.occlusions.clone().unwrap_or_default(),
                        fixed,
                    },
                    self.width,
                    self.height,
                )
                .map_err(|e| match e {
                    CompositeError::OutsideCanvas => RenderError::OutsideCanvas {
                        x: paint.p.x,
                        y: paint.p.y,
                        region: region.id.clone(),
                    },
                    e => RenderError::Compositor(e),
                })?;
            paint.begun = true;
        }
        debug_assert_eq!(self.ring.slots[current].index, index as i64);
        let frame = Frame {
            rgba: &self.ring.slots[current].pixels,
            width: self.width,
            height: self.height,
            labels: io.labels,
            consistent: (moving || fixed).then_some(&self.mask[..]),
        };
        let outcome = match io.compositor.step(io.cache, &frame, io.now) {
            Ok(CompositorStep::NeedTile(key)) => return Ok(Some(RenderStep::NeedTile(key))),
            Ok(CompositorStep::NeedTemporal(canvas)) => {
                return Ok(Some(RenderStep::NeedTemporal(canvas)))
            }
            Ok(CompositorStep::Done(outcome)) => outcome,
            Err(CompositeError::Disposed) => {
                return Err(RenderError::Disposed(paint.p.canvas.clone()))
            }
            Err(e) => return Err(RenderError::Compositor(e)),
        };
        paint.begun = false;
        self.events
            .extend(outcome.diagnostics.into_iter().map(compositor_diagnostic));
        let s = outcome.stats;
        if fixed && s.settled_blocks > 0 {
            if let Some(state) = self.states.get_mut(&raw.layer) {
                state.settled += 1;
            }
        }
        let canvas = paint.p.canvas.clone();
        if let Some(meta) = self.metas.get_mut(&canvas) {
            meta.bounds = union(meta.bounds, s.bounds);
            meta.observed_pixels += s.added as f64;
            meta.uncertain_pixels += s.uncertain as f64;
            meta.conflict_pixels += s.conflicts as f64;
            meta.tile_count += s.tiles as f64;
            meta.provisional_pixels += s.provisional_pixels as f64;
            meta.last_time = raw.time;
        }
        self.counters.tiles += s.tiles as f64;
        self.counters.observed_pixels += s.added as f64;
        self.mark_dirty(&canvas);
        if moving {
            job.latest = Some(canvas.clone());
        }
        job.decisions.push(decision(
            canvas,
            placed(raw, &paint.p),
            Some((s.added as f64, s.conflicts as f64, s.uncertain as f64)),
        ));
        Ok(None)
    }

    /// The previous and next frames' placements of the same layer, resolved, when that frame is in hand and placed
    /// the layer at all; a neighbour whose resolved pose cannot be placed counts as absent.
    fn neighbours(
        &self,
        job: &FrameJob,
        raw: &PlanPlacement,
        graph: &PoseGraph,
    ) -> Result<[Option<NeighbourPlacement>; 2], RenderError> {
        let input = &job.input;
        fn find<'a>(
            has: bool,
            plan: &'a Option<FramePlan>,
            layer: &str,
        ) -> Option<&'a PlanPlacement> {
            if !has {
                return None;
            }
            plan.as_ref()?
                .placements
                .iter()
                .find(|pl| pl.layer == layer && !pl.skipped())
        }
        let prev = find(
            input.has_prev && input.index > 0,
            &input.prev_plan,
            &raw.layer,
        );
        let next = find(input.has_next, &input.next_plan, &raw.layer);
        let prev_resolved = match prev {
            Some(pl) => Some((self.resolve(pl, input.index as f64 - 1.0, graph)?, pl)),
            None => None,
        };
        let next_resolved = match next {
            Some(pl) => Some((self.resolve(pl, input.index as f64 + 1.0, graph)?, pl)),
            None => None,
        };
        let keep = |r: Option<(Resolved, &PlanPlacement)>| {
            r.filter(|(p, _)| is_valid_pose(p.x, p.y))
                .map(|(resolved, pl)| NeighbourPlacement {
                    resolved,
                    occlusions: pl.occlusions.clone().unwrap_or_default(),
                    slot: None,
                })
        };
        Ok([keep(prev_resolved), keep(next_resolved)])
    }
}

/// One of the compositor's findings as a structured diagnostic.
fn compositor_diagnostic(d: CompositorDiagnostic) -> Diagnostic {
    match d {
        CompositorDiagnostic::IncompletePatch {
            canvas,
            frame,
            time,
            region,
        } => Diagnostic::new("INCOMPLETE_TEMPORAL_PATCH", Severity::Warning)
            .at(frame, time)
            .canvas(&canvas)
            .region(region),
        CompositorDiagnostic::Conflict {
            canvas,
            frame,
            time,
            region,
            confidence,
            regions,
            conflicts,
        } => Diagnostic::new("TEMPORAL_OR_ALIGNMENT_CONFLICT", Severity::Warning)
            .at(frame, time)
            .param("conflicts", conflicts as f64)
            .canvas(&canvas)
            .region(region)
            .confidence(confidence)
            .detail(Value::Object(vec![(
                "regions",
                Value::List(regions.into_iter().map(Value::rect).collect()),
            )])),
    }
}

/// The voting records a frame asks the window for, in order.
fn vote_gets(index: u32, has_prev: bool, has_next: bool) -> Vec<i64> {
    let index = index as i64;
    let mut gets = vec![index];
    if has_prev {
        gets.push(index - 1);
    }
    if has_next {
        gets.push(index + 1);
    }
    gets
}

/// The region's verdict from a record, checked against its box.
fn vote<'a>(
    record: Option<&'a ConsistencyRecord>,
    region: &str,
) -> Result<Option<Vote<'a>>, RenderError> {
    let Some(v) = record.and_then(|r| r.get(region)) else {
        return Ok(None);
    };
    if v.w <= 0 || v.h <= 0 {
        return Err(RenderError::BadVote);
    }
    let bytes = (v.w as usize * v.h as usize).div_ceil(8);
    if v.bits.len() < bytes || v.clean.len() < bytes {
        return Err(RenderError::BadVote);
    }
    Ok(Some(Vote {
        x0: v.x0,
        y0: v.y0,
        w: v.w,
        h: v.h,
        bits: &v.bits[..bytes],
        clean: &v.clean[..bytes],
    }))
}

/// The plan's placement at its resolved pose and canvas.
fn placed(raw: &PlanPlacement, p: &Resolved) -> PlanPlacement {
    PlanPlacement {
        canvas_id: p.canvas.clone(),
        x: p.x,
        y: p.y,
        ..raw.clone()
    }
}

/// A ledger row; `None` pixels means a skipped placement.
fn decision(
    canvas_id: String,
    placement: PlanPlacement,
    pixels: Option<(f64, f64, f64)>,
) -> RenderDecision {
    let (added, conflicts, uncertain) = pixels.unwrap_or_default();
    RenderDecision {
        canvas_id,
        placement,
        added_pixels: added,
        conflict_pixels: conflicts,
        uncertain_pixels: uncertain,
        skipped: pixels.is_none(),
        reused_exact_observation: false,
    }
}

/// The smallest rect holding both; an empty `a` is replaced by `b`.
fn union(a: Rect, b: Rect) -> Rect {
    if a.width <= 0.0 || a.height <= 0.0 {
        return b;
    }
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    Rect {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
    }
}

#[cfg(test)]
mod fixed_tests;
#[cfg(test)]
mod tests;
