//! The reveal stage (docs/ARCHITECTURE.md §七 "揭示", §十 "揭示"): after the compositor has written every canvas, four
//! more frame-major passes over the recording replace what overlays burned in — a composer bar, a floating button, a
//! scrollbar thumb, a cursor, a fade veil — with the cleanest observation of the same page content, and give content
//! that really changed over time a single moment. The algorithm is `long_screen_core::reveal`; [`RevealSession`] is the
//! run around it: which layers and canvases take part, which decisions of the solve count, the memory check that skips
//! the stage, feeding the compositor's tiles in, the order of the passes, and copying the chosen 16×16 blocks into the
//! tiles.
//!
//! The host answers what each [`RevealSession::step`] asks for:
//!
//! - [`Step::NeedMemory`]: whether that many more bytes (plus whatever the host keeps free beside them) can be
//!   allocated, through [`RevealSession::memory`]. A refusal ends the stage with `REVEAL_SKIPPED`.
//! - [`Step::NeedObservations`]: every stored `observation/` row, in key order, through
//!   [`RevealSession::observation`].
//! - [`Step::NeedTile`]: a tile that is not resident (make room with [`TileCache::victim`], storing what is dirty
//!   before [`TileCache::evict`], then [`TileCache::insert`]).
//! - [`Step::Checkpoint`]: one compositor tile went into the reference; check for pause and stop.
//! - [`Step::Decode`]: decode the recording for one pass. For each decoded frame below the session's frame count, write
//!   its RGBA into [`RevealSession::frame_buffer`] when `wanted` marks it (the pass reads no other frame's pixels),
//!   call [`RevealSession::push_frame`], then step until [`Step::NextFrame`]. After the last frame, call
//!   [`RevealSession::end_pass`] and step until [`Step::PassDone`].
//! - [`Step::Provenance`]: store the canvas's `reveal/<canvas>` row.
//! - [`Step::Done`]: the stage is over; on [`Outcome::Revealed`] the host flushes the tiles and stores
//!   `reveal-summary`.
//!
//! Every tile the session reads or writes is taken from the cache in the order the stage has always used — the
//! compositor's tiles row by row per canvas, one tile per fallback block, one per group of block copies from a vote
//! frame in the order the copies came, one per deferred block — so the cache sees the same uses, evictions and
//! reloads. The session keeps the three decoded frames the passes compare (the vote frame, the one before it and
//! the frame being written) in its own buffers.

use crate::diagnostic::{Diagnostic, Severity, Value};
use crate::tiles::{Tile, TileCache, TileKey, QUALITY_BLOCK};
use long_screen_core::geometry::{js_round, Rect};
use long_screen_core::reveal::blocks::{BlockWrite, Deferred, Kind};
use long_screen_core::reveal::run::{admitted, canvas_bytes, layer_bytes, Decision, Reveal};
use long_screen_core::reveal::CanvasView;
use std::collections::HashMap;

pub use long_screen_core::reveal::run::Pass;

/// The four frame-major passes, in order.
pub const PASSES: [Pass; 4] = [Pass::Learn, Pass::Agree, Pass::Relearn, Pass::Write];
/// Decoded frames the session holds: the frame being written and the two before it.
pub const RING_FRAMES: usize = 3;
/// Quality a block taken from a clean, agreeing view is shown with (the viewer's low-quality line is 153).
pub const REVEALED_QUALITY: u8 = 204;

/// A moving layer: its id, its screen rectangle and its atlas code (0 when it owns the whole rectangle).
#[derive(Clone, Debug, PartialEq)]
pub struct RevealLayer {
    pub id: String,
    pub rect: Rect,
    pub code: u32,
}

/// A moving canvas the compositor wrote: its id and world bounds.
#[derive(Clone, Debug, PartialEq)]
pub struct RevealCanvas {
    pub id: String,
    pub bounds: Rect,
}

/// One decision of a stored `observation/` row: the canvas and layer it places, the solved pose, whether the
/// placement itself is a skip (`placement.skip`), whether the solve held the pose because the layer was blind
/// (`skipped`: too little texture to track, so the compositor painted nothing), and the placement's occlusions.
#[derive(Clone, Debug, PartialEq)]
pub struct ObservedDecision {
    pub canvas: String,
    pub layer: String,
    pub x: f64,
    pub y: f64,
    pub skip: bool,
    pub skipped: bool,
    pub occlusions: Vec<Rect>,
}

/// What a [`Step::NeedMemory`] is for: every canvas and layer with the decoded frames, or the write pass's per-pixel
/// fallback state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryStage {
    Canvases,
    Fallback,
}

impl MemoryStage {
    /// The `stage` the `REVEAL_SKIPPED` row's detail names.
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryStage::Canvases => "canvases",
            MemoryStage::Fallback => "fallback",
        }
    }
}

/// Where each 16-pixel block of a canvas takes its pixels from after the write pass: the frame a whole block was
/// copied from, `-2` for per-pixel values from several frames, `-1` where the compositor's pixels stand. Block
/// `(gx + i % bw, gy + i / bw)` in world block coordinates. The host stores it as `reveal/<canvas>`.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub canvas: String,
    pub gx: i64,
    pub gy: i64,
    pub bw: usize,
    pub bh: usize,
    pub source: Vec<i32>,
}

/// The counters of the `reveal-summary` row, in its field order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub objects: u32,
    pub components: u32,
    pub coherent_blocks: u32,
    pub component_blocks: u32,
    pub provisional_blocks: u32,
    pub fallback_blocks: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// No moving layer or no moving canvas: the stage does nothing.
    Nothing,
    /// `REVEAL_SKIPPED` (warning, parameter `need` in MB; detail `stage`, `needMB`, `coreMB`): the memory the stage
    /// needs could not be allocated, so the compositor's pixels stay as they are.
    Skipped(Diagnostic),
    Revealed(Summary),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Answer with [`RevealSession::memory`]: can `bytes` more be allocated?
    NeedMemory {
        bytes: f64,
        stage: MemoryStage,
    },
    /// Pass every stored `observation/` row to [`RevealSession::observation`], then step again.
    NeedObservations,
    /// The tile is not resident: make room, insert it, step again.
    NeedTile(TileKey),
    /// A compositor tile went into the reference; check for pause and stop, then step again.
    Checkpoint,
    /// Decode the recording for `pass`; `wanted[i]` marks the frames whose pixels it reads.
    Decode {
        pass: Pass,
        wanted: Vec<bool>,
    },
    /// The pushed frame is done: push the next one, or end the pass after the last.
    NextFrame,
    /// The pass is over (its timings end here); step again for the next one.
    PassDone(Pass),
    /// Store this canvas's provenance row, then step again.
    Provenance(Provenance),
    Done(Outcome),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevealError {
    /// A call out of turn: `memory` without a pending [`Step::NeedMemory`], `observation` before
    /// [`Step::NeedObservations`], a frame outside [`Step::Decode`], a step while a frame is owed, or a step after the
    /// session finished.
    Unexpected,
    /// Stepped again after [`Step::NeedTile`] without inserting the tile.
    NotProvided,
    /// A layer whose pixel span is empty or whose atlas code is above 255.
    BadLayer,
    /// A label plane that is not `width × height` bytes.
    BadLabels,
}

/// Integer pixel span of a float extent: pixel p is inside iff `start ≤ p < start + size`.
fn pixel_span(start: f64, size: f64) -> (i64, i64) {
    let a = start.ceil();
    (a as i64, ((start + size).ceil() - a).max(0.0) as i64)
}

/// Where a block's tile is and where the block sits inside it.
fn block_tile(gx: i64, gy: i64, size: usize) -> (i32, i32, usize, usize) {
    let (x0, y0, s) = (
        gx * QUALITY_BLOCK as i64,
        gy * QUALITY_BLOCK as i64,
        size as i64,
    );
    (
        x0.div_euclid(s) as i32,
        y0.div_euclid(s) as i32,
        x0.rem_euclid(s) as usize,
        y0.rem_euclid(s) as usize,
    )
}

/// Writes one world block of `tile` (16 rows of RGBA from `row`). With `masked`, pixels whose alpha is not 255 keep
/// the canvas. Kinds that settle a block clear its provisional bits and conflicts and raise its quality; per-pixel
/// fallback values keep the compositor's owner frame.
fn write_block<'a>(
    tile: &mut Tile,
    size: usize,
    (lx, ly): (usize, usize),
    frame: u32,
    kind: Kind,
    row: impl Fn(usize) -> &'a [u8],
    masked: bool,
) {
    let settled = matches!(kind, Kind::Coherent | Kind::Component | Kind::Edge);
    for r in 0..QUALITY_BLOCK {
        let src = row(r);
        let p = (ly + r) * size + lx;
        if !masked {
            // A whole row of an opaque frame: the alpha comes with it, and the row's 16 coverage/provisional bits are
            // two whole bytes (blocks start on a multiple of 16 pixels).
            tile.pixels[p * 4..(p + QUALITY_BLOCK) * 4].copy_from_slice(&src[..QUALITY_BLOCK * 4]);
            tile.coverage[p >> 3] = 0xff;
            tile.coverage[(p >> 3) + 1] = 0xff;
            if settled {
                tile.provisional[p >> 3] = 0;
                tile.provisional[(p >> 3) + 1] = 0;
            }
            continue;
        }
        for x in 0..QUALITY_BLOCK {
            if src[x * 4 + 3] != 255 {
                continue;
            }
            let q = p + x;
            tile.pixels[q * 4..q * 4 + 3].copy_from_slice(&src[x * 4..x * 4 + 3]);
            tile.pixels[q * 4 + 3] = 255;
            tile.coverage[q >> 3] |= 1 << (q & 7);
            if settled {
                tile.provisional[q >> 3] &= !(1 << (q & 7));
            }
        }
    }
    let b = (ly / QUALITY_BLOCK) * (size / QUALITY_BLOCK) + lx / QUALITY_BLOCK;
    // A whole block copied from one frame is owned by it; per-pixel fallback values keep the compositor's owner.
    if kind != Kind::Fallback {
        tile.owner[b] = frame.wrapping_add(1);
    }
    if settled {
        tile.conflicts[b] = 0;
        tile.quality[b] = tile.quality[b].max(REVEALED_QUALITY);
    }
}

enum Phase {
    Start,
    /// [`Step::NeedMemory`] was returned for `bytes`.
    AwaitMemory {
        stage: MemoryStage,
        bytes: f64,
    },
    /// The host refused the memory: the next step reports it.
    Refused(Diagnostic),
    /// The memory was granted: ask for the observations.
    Observe,
    /// [`Step::NeedObservations`] was returned.
    AwaitObservations,
    /// Feeding the compositor's tiles of `canvas` into its reference; the next tile is (`tx`, `ty`).
    Ingest {
        canvas: usize,
        ty: i64,
        tx: i64,
    },
    /// The pass `PASSES[pass]` is next.
    Begin {
        pass: usize,
        memory_checked: bool,
    },
    /// Supplying the compositor's pixels of the fallback blocks of `canvas` before the write pass.
    Fallbacks {
        canvas: usize,
        blocks: Vec<(i64, i64)>,
        at: usize,
    },
    /// The host is decoding for `PASSES[pass]`.
    Decoding {
        pass: usize,
    },
    /// The decode for `PASSES[pass]` ended; its last block copies are being applied.
    Ending {
        pass: usize,
    },
    /// Writing the deferred blocks of `canvas`, then its provenance.
    Finish {
        canvas: usize,
        deferred: Option<Vec<Deferred>>,
        at: usize,
    },
    Done,
}

/// Block copies from one vote frame, grouped by tile in the order the copies came.
struct Copies {
    /// The frame slot they copy from.
    source: usize,
    groups: Vec<(TileKey, Vec<BlockWrite>)>,
    at: usize,
}

/// One reveal run, driven by the host step by step (see the module documentation).
pub struct RevealSession {
    width: usize,
    height: usize,
    noise: f64,
    size: usize,
    frames: u32,
    layers: Vec<RevealLayer>,
    canvases: Vec<RevealCanvas>,
    layer_slot: HashMap<String, usize>,
    canvas_slot: HashMap<String, usize>,
    /// Created once the memory check passed.
    run: Option<Reveal>,
    /// Every stored observation: its frame and its decisions with whether each is blind.
    observed: Vec<(u32, Vec<(Decision, bool)>)>,
    /// The decisions the passes use, per frame below `frames`.
    plans: Vec<Vec<Decision>>,
    phase: Phase,
    /// The tile the last [`Step::NeedTile`] asked for.
    asked: Option<TileKey>,
    slots: Vec<Vec<u8>>,
    /// The slot [`RevealSession::frame_buffer`] handed out for the frame not pushed yet.
    staged: Option<usize>,
    /// The last pushed frame's slot (none when it was not converted) and the one before.
    last: Option<usize>,
    before: Option<usize>,
    pushed: bool,
    copies: Option<Copies>,
}

impl RevealSession {
    /// A reveal over `frames` decoded frames of `width × height` with the source's decode `noise`, for the moving
    /// `layers` and `canvases` (in the order the host lists them), on `tile_size`-pixel tiles.
    pub fn new(
        width: usize,
        height: usize,
        noise: f64,
        tile_size: usize,
        frames: u32,
        layers: Vec<RevealLayer>,
        canvases: Vec<RevealCanvas>,
    ) -> Result<RevealSession, RevealError> {
        for l in &layers {
            let (_, w) = pixel_span(l.rect.x, l.rect.width);
            let (_, h) = pixel_span(l.rect.y, l.rect.height);
            if w == 0 || h == 0 || l.code > 255 {
                return Err(RevealError::BadLayer);
            }
        }
        // Later ids win, as a map built from the list does.
        let layer_slot = layers
            .iter()
            .enumerate()
            .map(|(i, l)| (l.id.clone(), i))
            .collect();
        let canvas_slot = canvases
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.clone(), i))
            .collect();
        Ok(RevealSession {
            width,
            height,
            noise,
            size: tile_size,
            frames,
            layers,
            canvases,
            layer_slot,
            canvas_slot,
            run: None,
            observed: Vec::new(),
            plans: Vec::new(),
            phase: Phase::Start,
            asked: None,
            slots: Vec::new(),
            staged: None,
            last: None,
            before: None,
            pushed: false,
            copies: None,
        })
    }

    /// Core memory the stage needs before it starts: every canvas and layer, and the decoded frames it holds.
    pub fn estimate(&self) -> f64 {
        let canvases: f64 = self
            .canvases
            .iter()
            .map(|c| {
                let (_, w) = pixel_span(c.bounds.x, c.bounds.width);
                let (_, h) = pixel_span(c.bounds.y, c.bounds.height);
                canvas_bytes(w as usize, h as usize) as f64
            })
            .sum();
        let layers: f64 = self
            .layers
            .iter()
            .map(|l| {
                let (_, w) = pixel_span(l.rect.x, l.rect.width);
                let (_, h) = pixel_span(l.rect.y, l.rect.height);
                layer_bytes(w as usize, h as usize) as f64
            })
            .sum();
        canvases + layers + (RING_FRAMES * self.width * self.height * 4) as f64
    }

    /// The answer to [`Step::NeedMemory`]: whether the bytes fit, and the core's current size in bytes (reported in
    /// `REVEAL_SKIPPED` when they do not).
    pub fn memory(&mut self, fits: bool, core_bytes: f64) -> Result<(), RevealError> {
        let Phase::AwaitMemory { stage, bytes } = self.phase else {
            return Err(RevealError::Unexpected);
        };
        if !fits {
            let mb = js_round(bytes / 1048576.0) as f64;
            let diagnostic = Diagnostic::new("REVEAL_SKIPPED", Severity::Warning)
                .param("need", mb)
                .detail(Value::Object(vec![
                    ("stage", Value::Text(stage.as_str().to_string())),
                    ("needMB", Value::Number(mb)),
                    (
                        "coreMB",
                        Value::Number(js_round(core_bytes / 1048576.0) as f64),
                    ),
                ]));
            self.phase = Phase::Refused(diagnostic);
            return Ok(());
        }
        match stage {
            MemoryStage::Canvases => {
                let mut run = Reveal::new(self.width, self.height, self.noise);
                for l in &self.layers {
                    let (x, w) = pixel_span(l.rect.x, l.rect.width);
                    let (y, h) = pixel_span(l.rect.y, l.rect.height);
                    run.add_layer(x, y, w as usize, h as usize, l.code as u8);
                }
                for c in &self.canvases {
                    // Truncated, as the integer arguments the stage has always passed them as.
                    let b = c.bounds;
                    run.add_canvas(
                        b.x as i32 as i64,
                        b.y as i32 as i64,
                        b.width as u32 as usize,
                        b.height as u32 as usize,
                    );
                }
                self.run = Some(run);
                self.phase = Phase::Observe;
            }
            MemoryStage::Fallback => {
                self.phase = Phase::Begin {
                    pass: 3,
                    memory_checked: true,
                };
            }
        }
        Ok(())
    }

    /// One stored `observation/` row (frame and decisions), after [`Step::NeedObservations`]. Decisions on a canvas
    /// or layer the stage does not cover are left out, and so is a blind decision whose placement is not a skip.
    pub fn observation(
        &mut self,
        frame: u32,
        decisions: &[ObservedDecision],
    ) -> Result<(), RevealError> {
        if !matches!(self.phase, Phase::AwaitObservations) {
            return Err(RevealError::Unexpected);
        }
        let mut out = Vec::new();
        for d in decisions {
            let (Some(&canvas), Some(&layer)) = (
                self.canvas_slot.get(&d.canvas),
                self.layer_slot.get(&d.layer),
            ) else {
                continue;
            };
            if d.skipped && !d.skip {
                continue;
            }
            let occlusions = d
                .occlusions
                .iter()
                .map(|r| {
                    let (x, w) = pixel_span(r.x, r.width);
                    let (y, h) = pixel_span(r.y, r.height);
                    (x, y, w, h)
                })
                .collect();
            out.push((
                Decision {
                    layer,
                    canvas,
                    x: js_round(d.x) as i64,
                    y: js_round(d.y) as i64,
                    occlusions,
                },
                d.skipped,
            ));
        }
        self.observed.push((frame, out));
        Ok(())
    }

    /// The buffer the next decoded frame's RGBA (`width × height × 4` bytes) goes into, during [`Step::Decode`] and
    /// only for a frame `wanted` marks. Asking again before [`RevealSession::push_frame`] returns the same buffer.
    pub fn frame_buffer(&mut self) -> Result<&mut [u8], RevealError> {
        if !matches!(self.phase, Phase::Decoding { .. }) || self.copies.is_some() {
            return Err(RevealError::Unexpected);
        }
        let slot = match self.staged {
            Some(slot) => slot,
            None => {
                let held = |s: usize| self.last == Some(s) || self.before == Some(s);
                let slot = match (0..self.slots.len()).find(|&s| !held(s)) {
                    Some(slot) => slot,
                    None => {
                        self.slots.push(vec![0; self.width * self.height * 4]);
                        self.slots.len() - 1
                    }
                };
                self.staged = Some(slot);
                slot
            }
        };
        Ok(&mut self.slots[slot])
    }

    fn check_labels(&self, labels: Option<&[u8]>) -> Result<(), RevealError> {
        match labels {
            Some(l) if l.len() != self.width * self.height => Err(RevealError::BadLabels),
            _ => Ok(()),
        }
    }

    /// Frame `index` was decoded: the frame written into [`RevealSession::frame_buffer`] since the last push, or no
    /// pixels when it was not wanted. `labels` is the atlas label plane. Step until [`Step::NextFrame`] afterwards.
    pub fn push_frame(&mut self, index: u32, labels: Option<&[u8]>) -> Result<(), RevealError> {
        let Phase::Decoding { pass } = self.phase else {
            return Err(RevealError::Unexpected);
        };
        if self.copies.is_some() {
            return Err(RevealError::Unexpected);
        }
        self.check_labels(labels)?;
        let current = self.staged.take();
        let run = self.run.as_mut().unwrap();
        let slot = |s: Option<usize>| s.map(|s| &self.slots[s][..]);
        let decisions = self.plans.get(index as usize).map_or(&[][..], |p| &p[..]);
        run.frame(
            index,
            slot(current),
            slot(self.last),
            slot(self.before),
            labels,
            decisions,
        );
        if PASSES[pass] == Pass::Write {
            if let Some(source) = self.last {
                self.copies = Some(self.group(source));
            }
        }
        self.before = self.last;
        self.last = current;
        self.pushed = true;
        Ok(())
    }

    /// The decode for this pass is over: runs still open vote with the last frame. Step until [`Step::PassDone`].
    pub fn end_pass(&mut self, labels: Option<&[u8]>) -> Result<(), RevealError> {
        let Phase::Decoding { pass } = self.phase else {
            return Err(RevealError::Unexpected);
        };
        if self.copies.is_some() {
            return Err(RevealError::Unexpected);
        }
        self.check_labels(labels)?;
        self.staged = None;
        if self.pushed {
            let run = self.run.as_mut().unwrap();
            let slot = |s: Option<usize>| s.map(|s| &self.slots[s][..]);
            run.end(slot(self.last), slot(self.before), labels);
            if PASSES[pass] == Pass::Write {
                if let Some(source) = self.last {
                    self.copies = Some(self.group(source));
                }
            }
        }
        self.phase = Phase::Ending { pass };
        Ok(())
    }

    /// Drains the run's block copies, grouped by tile in the order they came.
    fn group(&mut self, source: usize) -> Copies {
        let writes = self.run.as_mut().unwrap().take_writes();
        let mut groups: Vec<(TileKey, Vec<BlockWrite>)> = Vec::new();
        let mut index: HashMap<TileKey, usize> = HashMap::new();
        for w in writes {
            let (tx, ty, _, _) = block_tile(w.gx, w.gy, self.size);
            let key = TileKey::new(&self.canvases[w.canvas as usize].id, 0, tx, ty);
            match index.get(&key) {
                Some(&g) => groups[g].1.push(w),
                None => {
                    index.insert(key.clone(), groups.len());
                    groups.push((key, vec![w]));
                }
            }
        }
        Copies {
            source,
            groups,
            at: 0,
        }
    }

    /// The tile `key`, touched as the most recently used one, or the step that asks the host for it.
    fn tile(
        &mut self,
        cache: &mut TileCache,
        key: TileKey,
    ) -> Result<Result<u32, Step>, RevealError> {
        if let Some(id) = cache.touch(&key) {
            self.asked = None;
            return Ok(Ok(id));
        }
        if self.asked.as_ref() == Some(&key) {
            return Err(RevealError::NotProvided);
        }
        self.asked = Some(key.clone());
        Ok(Err(Step::NeedTile(key)))
    }

    /// Applies the pending block copies; `Some(step)` when a tile must come in first.
    fn apply_copies(
        &mut self,
        cache: &mut TileCache,
        now: f64,
    ) -> Result<Option<Step>, RevealError> {
        while let Some(copies) = &self.copies {
            let Some((key, _)) = copies.groups.get(copies.at) else {
                self.copies = None;
                break;
            };
            let id = match self.tile(cache, key.clone())? {
                Ok(id) => id,
                Err(step) => return Ok(Some(step)),
            };
            let copies = self.copies.as_mut().unwrap();
            let (size, w) = (self.size, self.width);
            let source = &self.slots[copies.source];
            let tile = cache.get_mut(id).unwrap();
            for wr in &copies.groups[copies.at].1 {
                let (_, _, lx, ly) = block_tile(wr.gx, wr.gy, size);
                let (sx, sy) = (wr.sx as usize, wr.sy as usize);
                write_block(
                    tile,
                    size,
                    (lx, ly),
                    wr.frame,
                    wr.kind,
                    |row| {
                        let at = ((sy + row) * w + sx) * 4;
                        &source[at..at + QUALITY_BLOCK * 4]
                    },
                    false,
                );
            }
            cache.mark_dirty(id, now);
            copies.at += 1;
        }
        Ok(None)
    }

    /// Runs the stage until it needs something from the host. `now` is the host's clock, stamped on every tile this
    /// step writes.
    pub fn step(&mut self, cache: &mut TileCache, now: f64) -> Result<Step, RevealError> {
        loop {
            match &mut self.phase {
                Phase::Start => {
                    if self.layers.is_empty() || self.canvases.is_empty() {
                        self.phase = Phase::Done;
                        return Ok(Step::Done(Outcome::Nothing));
                    }
                    let bytes = self.estimate();
                    self.phase = Phase::AwaitMemory {
                        stage: MemoryStage::Canvases,
                        bytes,
                    };
                    return Ok(Step::NeedMemory {
                        bytes,
                        stage: MemoryStage::Canvases,
                    });
                }
                Phase::AwaitMemory { .. } | Phase::Done => return Err(RevealError::Unexpected),
                Phase::Refused(_) => {
                    let Phase::Refused(d) = std::mem::replace(&mut self.phase, Phase::Done) else {
                        unreachable!()
                    };
                    self.run = None;
                    return Ok(Step::Done(Outcome::Skipped(d)));
                }
                Phase::Observe => {
                    self.phase = Phase::AwaitObservations;
                    return Ok(Step::NeedObservations);
                }
                Phase::AwaitObservations => {
                    self.plan();
                    self.phase = self.ingest_from(0);
                }
                Phase::Ingest { canvas, ty, tx } => {
                    let (slot, mut x, mut y) = (*canvas, *tx, *ty);
                    let Some(c) = self.canvases.get(slot) else {
                        self.phase = Phase::Begin {
                            pass: 0,
                            memory_checked: false,
                        };
                        continue;
                    };
                    let (b, s) = (c.bounds, self.size as f64);
                    if x as f64 * s >= b.x + b.width {
                        y += 1;
                        x = (b.x / s).floor() as i64;
                    }
                    // Past the last row, or a canvas without width.
                    if y as f64 * s >= b.y + b.height || x as f64 * s >= b.x + b.width {
                        self.phase = self.ingest_from(slot + 1);
                        continue;
                    }
                    self.phase = Phase::Ingest {
                        canvas: slot,
                        ty: y,
                        tx: x,
                    };
                    let key = TileKey::new(&self.canvases[slot].id, 0, x as i32, y as i32);
                    let id = match self.tile(cache, key)? {
                        Ok(id) => id,
                        Err(step) => return Ok(step),
                    };
                    let tile = cache.get(id).unwrap();
                    let size = self.size;
                    self.run.as_mut().unwrap().ingest(
                        slot,
                        &CanvasView {
                            x: x * size as i64,
                            y: y * size as i64,
                            width: size,
                            height: size,
                            rgba: &tile.pixels,
                            coverage: &tile.coverage,
                        },
                    );
                    self.phase = Phase::Ingest {
                        canvas: slot,
                        ty: y,
                        tx: x + 1,
                    };
                    return Ok(Step::Checkpoint);
                }
                Phase::Begin {
                    pass,
                    memory_checked,
                } => {
                    let (pass, checked) = (*pass, *memory_checked);
                    let Some(&p) = PASSES.get(pass) else {
                        self.phase = Phase::Finish {
                            canvas: 0,
                            deferred: None,
                            at: 0,
                        };
                        continue;
                    };
                    let run = self.run.as_mut().unwrap();
                    if p == Pass::Write && !checked {
                        let bytes = run.fallback_bytes() as f64;
                        self.phase = Phase::AwaitMemory {
                            stage: MemoryStage::Fallback,
                            bytes,
                        };
                        return Ok(Step::NeedMemory {
                            bytes,
                            stage: MemoryStage::Fallback,
                        });
                    }
                    run.begin(p);
                    if p != Pass::Write {
                        return Ok(self.decode(pass));
                    }
                    self.phase = Phase::Fallbacks {
                        canvas: 0,
                        blocks: run.fallback_blocks(0),
                        at: 0,
                    };
                }
                Phase::Fallbacks { canvas, blocks, at } => {
                    let slot = *canvas;
                    let Some(&(gx, gy)) = blocks.get(*at) else {
                        if slot + 1 < self.canvases.len() {
                            let blocks = self.run.as_ref().unwrap().fallback_blocks(slot + 1);
                            self.phase = Phase::Fallbacks {
                                canvas: slot + 1,
                                blocks,
                                at: 0,
                            };
                            continue;
                        }
                        return Ok(self.decode(PASSES.len() - 1));
                    };
                    let (tx, ty, lx, ly) = block_tile(gx, gy, self.size);
                    let key = TileKey::new(&self.canvases[slot].id, 0, tx, ty);
                    let id = match self.tile(cache, key)? {
                        Ok(id) => id,
                        Err(step) => return Ok(step),
                    };
                    let tile = cache.get(id).unwrap();
                    let size = self.size;
                    let mut rgba = [0u8; QUALITY_BLOCK * QUALITY_BLOCK * 4];
                    for (row, out) in rgba.chunks_exact_mut(QUALITY_BLOCK * 4).enumerate() {
                        let p = (ly + row) * size + lx;
                        out.copy_from_slice(&tile.pixels[p * 4..(p + QUALITY_BLOCK) * 4]);
                        for x in 0..QUALITY_BLOCK {
                            let q = p + x;
                            if tile.coverage[q >> 3] & (1 << (q & 7)) == 0 {
                                out[x * 4 + 3] = 0;
                            }
                        }
                    }
                    self.run.as_mut().unwrap().set_main(slot, gx, gy, &rgba);
                    if let Phase::Fallbacks { at, .. } = &mut self.phase {
                        *at += 1;
                    }
                }
                Phase::Decoding { .. } => {
                    if let Some(step) = self.apply_copies(cache, now)? {
                        return Ok(step);
                    }
                    return Ok(Step::NextFrame);
                }
                Phase::Ending { pass } => {
                    let pass = *pass;
                    if let Some(step) = self.apply_copies(cache, now)? {
                        return Ok(step);
                    }
                    self.phase = Phase::Begin {
                        pass: pass + 1,
                        memory_checked: false,
                    };
                    return Ok(Step::PassDone(PASSES[pass]));
                }
                Phase::Finish {
                    canvas,
                    deferred,
                    at,
                } => {
                    let slot = *canvas;
                    if slot >= self.canvases.len() {
                        self.phase = Phase::Done;
                        return Ok(Step::Done(Outcome::Revealed(self.summary())));
                    }
                    let run = self.run.as_ref().unwrap();
                    let list = deferred.get_or_insert_with(|| run.finish(slot));
                    let Some(d) = list.get(*at) else {
                        let provenance = run.provenance(slot, list);
                        self.phase = Phase::Finish {
                            canvas: slot + 1,
                            deferred: None,
                            at: 0,
                        };
                        if let Some((gx, gy, bw, bh, source)) = provenance {
                            return Ok(Step::Provenance(Provenance {
                                canvas: self.canvases[slot].id.clone(),
                                gx,
                                gy,
                                bw,
                                bh,
                                source,
                            }));
                        }
                        continue;
                    };
                    let (tx, ty, lx, ly) = block_tile(d.gx, d.gy, self.size);
                    let key = TileKey::new(&self.canvases[slot].id, 0, tx, ty);
                    let id = match self.tile(cache, key)? {
                        Ok(id) => id,
                        Err(step) => return Ok(step),
                    };
                    let Phase::Finish {
                        deferred: Some(list),
                        at,
                        ..
                    } = &mut self.phase
                    else {
                        unreachable!()
                    };
                    let d = &list[*at];
                    write_block(
                        cache.get_mut(id).unwrap(),
                        self.size,
                        (lx, ly),
                        d.frame,
                        d.kind,
                        |row| &d.rgba[row * QUALITY_BLOCK * 4..(row + 1) * QUALITY_BLOCK * 4],
                        true,
                    );
                    cache.mark_dirty(id, now);
                    *at += 1;
                }
            }
        }
    }

    /// Ingesting from the first tile of canvas `canvas` on (the passes begin once every canvas is in).
    fn ingest_from(&self, canvas: usize) -> Phase {
        match self.canvases.get(canvas) {
            Some(c) => {
                let s = self.size as f64;
                Phase::Ingest {
                    canvas,
                    ty: (c.bounds.y / s).floor() as i64,
                    tx: (c.bounds.x / s).floor() as i64,
                }
            }
            None => Phase::Begin {
                pass: 0,
                memory_checked: false,
            },
        }
    }

    /// Starts the decode for `PASSES[pass]`, with no frame held from the pass before.
    fn decode(&mut self, pass: usize) -> Step {
        self.staged = None;
        self.last = None;
        self.before = None;
        self.pushed = false;
        self.phase = Phase::Decoding { pass };
        Step::Decode {
            pass: PASSES[pass],
            wanted: self.run.as_ref().unwrap().wanted(&self.plans),
        }
    }

    /// Which decisions count ([`admitted`]) and the plan of every frame below the session's frame count.
    fn plan(&mut self) {
        let rows: Vec<Vec<(Decision, bool)>> =
            self.observed.iter().map(|(_, ds)| ds.clone()).collect();
        let keep = admitted(&rows);
        let mut plans = vec![Vec::new(); self.frames as usize];
        for ((frame, ds), keep) in std::mem::take(&mut self.observed).into_iter().zip(keep) {
            if let Some(plan) = plans.get_mut(frame as usize) {
                *plan = ds
                    .into_iter()
                    .zip(keep)
                    .filter(|(_, k)| *k)
                    .map(|((d, _), _)| d)
                    .collect();
            }
        }
        self.plans = plans;
    }

    fn summary(&self) -> Summary {
        let s = self.run.as_ref().unwrap().summary();
        Summary {
            objects: s.objects as u32,
            components: s.components as u32,
            coherent_blocks: s.coherent as u32,
            component_blocks: s.component_blocks as u32,
            provisional_blocks: s.provisional as u32,
            fallback_blocks: s.fallback as u32,
        }
    }
}

#[cfg(test)]
#[path = "reveal_tests.rs"]
mod tests;
