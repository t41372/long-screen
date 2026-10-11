//! Compositing one placed region into the tile cache: the per-tile paint, temporal-conflict resolution against the
//! per-canvas temporal index, and the diagnostics both raise (docs/ARCHITECTURE.md §七, §十 "合成与瞬态像素").
//!
//! One placement is a resumable job. [`Compositor::begin`] plans it; each [`Compositor::step`] runs until it needs
//! something the host must fetch — a tile that is not resident ([`Step::NeedTile`]: make room with
//! [`TileCache::victim`] and [`TileCache::evict`], then [`TileCache::insert`] it) or a canvas's stored temporal records
//! ([`Step::NeedTemporal`]: [`Compositor::load_temporal`]) — and returns [`Step::Done`] with the placement's
//! statistics and diagnostics once it has finished. The observed frame is passed to every step, never kept.
//!
//! Temporal records changed since the last flush come out of [`Compositor::flush`], per canvas in the order the
//! canvases were first loaded: the ids to delete, then the rows to write.

use crate::engine::tiles::{Tile, TileCache, TileKey, QUALITY_BLOCK};
use crate::kernels::compositor::{composite_tile, Observation, TileBuffers};
use crate::kernels::geometry::{js_round, Rect};
use crate::kernels::temporal::{
    components, mask_complete, overwrite_tile, DirtyRow, OverwriteTile, TemporalIndex,
    TemporalRecord,
};

/// Blocks within ±2^25 of the origin are addressable: a placed rect must stay inside `CANVAS_PIXEL_BOUND` native
/// pixels on either side (src/pipeline/solve/track.ts derives its pose bound from the same figure).
pub const CANVAS_PIXEL_BOUND: f64 = (1u64 << 25) as f64 * QUALITY_BLOCK as f64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemporalPolicy {
    /// Keep the first complete moment of a conflicting area.
    Stable,
    /// Replace it with every later complete moment.
    Latest,
}

/// One placement of a region on a canvas.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub canvas: String,
    /// The region's rect on screen.
    pub region: Rect,
    /// The region's code in the atlas label plane.
    pub code: u8,
    /// Pixels the atlas assigns to the region; equal to the rect's area for a rectangular region.
    pub owned_pixels: f64,
    /// The region's pose on the canvas (rounded to the raster pose here).
    pub x: f64,
    pub y: f64,
    pub frame: u32,
    pub time: f64,
    pub confidence: f64,
    pub uncertain: bool,
    pub occlusions: Vec<Rect>,
}

/// The observed frame, its atlas label plane and its world-consistency mask (1 = consistent; `None` treats every
/// pixel as consistent). All three are frame-sized.
#[derive(Clone, Copy, Debug)]
pub struct Frame<'a> {
    pub rgba: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub labels: &'a [u8],
    pub consistent: Option<&'a [u8]>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompositeStats {
    pub added: u64,
    /// Conflicting pixels: those detected per tile plus every pixel a resolved patch rewrote.
    pub conflicts: u64,
    pub uncertain: u64,
    /// Tiles this placement painted first.
    pub tiles: u64,
    /// The placed rect in canvas coordinates.
    pub bounds: Rect,
    /// Net change in provisional pixels (set minus healed); can be negative.
    pub provisional_pixels: i64,
}

impl Default for CompositeStats {
    fn default() -> Self {
        Self {
            added: 0,
            conflicts: 0,
            uncertain: 0,
            tiles: 0,
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            provisional_pixels: 0,
        }
    }
}

/// What a placement reports; the host formats the text from the catalogue.
#[derive(Clone, Debug, PartialEq)]
pub enum CompositorDiagnostic {
    /// `INCOMPLETE_TEMPORAL_PATCH` (warning): a conflicting area has no complete consistent moment yet.
    IncompletePatch {
        canvas: String,
        frame: u32,
        time: f64,
        region: Rect,
    },
    /// `TEMPORAL_OR_ALIGNMENT_CONFLICT` (warning), one per placement with conflicts: `region` is the largest
    /// conflicting component, `regions` all of them, `conflicts` the pixels detected before patching.
    Conflict {
        canvas: String,
        frame: u32,
        time: f64,
        region: Rect,
        confidence: f64,
        regions: Vec<Rect>,
        conflicts: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub stats: CompositeStats,
    /// In emission order: every incomplete patch, then the conflict summary.
    pub diagnostics: Vec<CompositorDiagnostic>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// The tile is not resident: make room, insert it, step again.
    NeedTile(TileKey),
    /// The canvas's stored temporal records are needed: load them, step again.
    NeedTemporal(String),
    Done(Outcome),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompositeError {
    /// The frame does not have the atlas's size.
    FrameSize,
    /// The placed rect leaves the addressable canvas.
    OutsideCanvas,
    /// `step` without a placement in progress, or `begin` while one is.
    NoPlacement,
    Busy,
    /// A tile's planes do not have the cache's tile size.
    BadTile,
    /// The canvas's temporal records were already disposed.
    Disposed,
    /// `load_temporal` for a canvas the placement did not ask for.
    Unexpected,
}

/// Temporal state of one canvas, in first-loaded order. `stash` holds what `dispose` drained for the next flush.
struct CanvasTemporal {
    canvas: String,
    index: Option<TemporalIndex>,
    stash: Option<(Vec<String>, Vec<DirtyRow>)>,
}

/// Rows a flush writes for one canvas: deletions first, then the changed records with their blocks in persisted
/// order.
#[derive(Debug, PartialEq)]
pub struct TemporalFlush {
    pub canvas: String,
    pub deleted: Vec<String>,
    pub dirty: Vec<DirtyRow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Tiles(usize),
    Component(usize),
    Patch(usize, usize),
    Finish(usize),
    Done,
}

struct Component {
    bounds: Rect,
    blocks: Vec<(i32, i32)>,
}

/// One tile of a resolved patch: its tile coordinates and the absolute blocks to write on it.
type PatchTile = ((i32, i32), Vec<(i64, i64)>);

/// One placement in progress.
struct Job {
    p: Placement,
    ox: i64,
    oy: i64,
    world: Rect,
    rectangular: bool,
    order: Vec<(i32, i32)>,
    stats: CompositeStats,
    conflict_blocks: Vec<(i32, i32)>,
    components: Vec<Component>,
    /// Tile groups of the patch being written, in first-block order, and whether to report it incomplete.
    patch: Vec<PatchTile>,
    incomplete: Option<Rect>,
    patched: CompositeStats,
    diagnostics: Vec<CompositorDiagnostic>,
    phase: Phase,
}

pub struct Compositor {
    policy: TemporalPolicy,
    atlas_width: usize,
    atlas_height: usize,
    /// Fresh temporal-record ids, shared by every canvas and never reset.
    sequence: u64,
    canvases: Vec<CanvasTemporal>,
    job: Option<Job>,
}

impl Compositor {
    pub fn new(policy: TemporalPolicy, atlas_width: usize, atlas_height: usize) -> Self {
        Self {
            policy,
            atlas_width,
            atlas_height,
            sequence: 0,
            canvases: Vec::new(),
            job: None,
        }
    }

    /// Plans one placement: its world rect and tile order (resident tiles first, so cold loads only evict the
    /// oldest residents). Tiles stay untouched until the first [`Compositor::step`].
    pub fn begin(
        &mut self,
        cache: &TileCache,
        p: Placement,
        frame_width: usize,
        frame_height: usize,
    ) -> Result<(), CompositeError> {
        if self.job.is_some() {
            return Err(CompositeError::Busy);
        }
        if frame_width != self.atlas_width || frame_height != self.atlas_height {
            return Err(CompositeError::FrameSize);
        }
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(CompositeError::OutsideCanvas);
        }
        let (ox, oy) = (js_round(p.x) as i64, js_round(p.y) as i64);
        let world = Rect {
            x: p.region.x + ox as f64,
            y: p.region.y + oy as f64,
            width: p.region.width,
            height: p.region.height,
        };
        let bound = CANVAS_PIXEL_BOUND;
        if !world.x.is_finite()
            || !world.y.is_finite()
            || world.x.abs() >= bound
            || world.y.abs() >= bound
            || (world.x + world.width).abs() >= bound
            || (world.y + world.height).abs() >= bound
        {
            return Err(CompositeError::OutsideCanvas);
        }
        let r = p.region;
        let rectangular = [r.x, r.y, r.width, r.height]
            .iter()
            .all(|v| v.fract() == 0.0)
            && p.owned_pixels == r.width * r.height;
        let size = cache.size() as f64;
        let (x0, x1) = (
            (world.x / size).floor() as i32,
            ((world.x + world.width - 1.0) / size).floor() as i32,
        );
        let (y0, y1) = (
            (world.y / size).floor() as i32,
            ((world.y + world.height - 1.0) / size).floor() as i32,
        );
        let mut resident = Vec::new();
        let mut cold = Vec::new();
        for ty in y0..=y1 {
            for tx in x0..=x1 {
                if cache.is_resident(&TileKey::new(&p.canvas, 0, tx, ty)) {
                    resident.push((tx, ty));
                } else {
                    cold.push((tx, ty));
                }
            }
        }
        resident.extend(cold);
        self.job = Some(Job {
            ox,
            oy,
            world,
            rectangular,
            order: resident,
            stats: CompositeStats {
                bounds: world,
                ..CompositeStats::default()
            },
            conflict_blocks: Vec::new(),
            components: Vec::new(),
            patch: Vec::new(),
            incomplete: None,
            patched: CompositeStats::default(),
            diagnostics: Vec::new(),
            phase: Phase::Tiles(0),
            p,
        });
        Ok(())
    }

    /// Abandons the placement in progress (the host stopped or failed between steps).
    pub fn cancel(&mut self) {
        self.job = None;
    }

    /// Runs the placement until it needs a tile or temporal records, or is done. `now` is the host's clock, stamped
    /// on every tile this step writes.
    pub fn step(
        &mut self,
        cache: &mut TileCache,
        frame: &Frame,
        now: f64,
    ) -> Result<Step, CompositeError> {
        let mut job = self.job.take().ok_or(CompositeError::NoPlacement)?;
        let result = self.run(&mut job, cache, frame, now);
        match result {
            Ok(Step::Done(_)) | Err(_) => {}
            Ok(_) => self.job = Some(job),
        }
        result
    }

    fn run(
        &mut self,
        job: &mut Job,
        cache: &mut TileCache,
        frame: &Frame,
        now: f64,
    ) -> Result<Step, CompositeError> {
        if frame.width != self.atlas_width || frame.height != self.atlas_height {
            return Err(CompositeError::FrameSize);
        }
        let size = cache.size() as i32;
        let per_tile = size / QUALITY_BLOCK as i32;
        loop {
            match job.phase {
                Phase::Tiles(i) if i < job.order.len() => {
                    let (tx, ty) = job.order[i];
                    let key = TileKey::new(&job.p.canvas, 0, tx, ty);
                    let Some(id) = cache.touch(&key) else {
                        return Ok(Step::NeedTile(key));
                    };
                    let tile = cache.get_mut(id).unwrap();
                    let was_new = !tile.existed && tile.coverage.iter().all(|&b| b == 0);
                    let obs = Observation {
                        rgba: frame.rgba,
                        width: frame.width,
                        height: frame.height,
                        labels: (!job.rectangular).then_some((frame.labels, job.p.code)),
                        occlusions: &job.p.occlusions,
                        consistent: frame.consistent,
                        confidence: job.p.confidence,
                        uncertain: job.p.uncertain,
                        frame: job.p.frame,
                    };
                    let stats = {
                        let mut buffers = tile_buffers(tile, cache_size(size))?;
                        composite_tile(
                            &mut buffers,
                            &obs,
                            job.world,
                            job.ox,
                            job.oy,
                            tx as i64,
                            ty as i64,
                        )
                    };
                    job.stats.added += stats.added as u64;
                    job.stats.conflicts += stats.conflicts as u64;
                    job.stats.uncertain += stats.uncertain as u64;
                    job.stats.provisional_pixels += stats.provisional_delta as i64;
                    for (bx, by) in stats.conflict_blocks {
                        job.conflict_blocks
                            .push((tx * per_tile + bx as i32, ty * per_tile + by as i32));
                    }
                    if stats.changed {
                        cache.mark_dirty(id, now);
                        if was_new {
                            job.stats.tiles += 1;
                        }
                    }
                    job.phase = Phase::Tiles(i + 1);
                }
                Phase::Tiles(_) => {
                    if job.conflict_blocks.is_empty() {
                        job.phase = Phase::Done;
                        continue;
                    }
                    // Seed order is tile-then-local-block raster order, whatever order the tiles were painted in
                    // (resident first): component order must not depend on the cache.
                    let mut cells = std::mem::take(&mut job.conflict_blocks);
                    cells.sort_by_key(|&(bx, by)| {
                        let (tx, ty) = (bx.div_euclid(per_tile), by.div_euclid(per_tile));
                        (ty, tx, by - ty * per_tile, bx - tx * per_tile)
                    });
                    cells.dedup();
                    job.components = components(&cells, QUALITY_BLOCK as i32)
                        .into_iter()
                        .map(|c| Component {
                            bounds: Rect {
                                x: c.x0 as f64,
                                y: c.y0 as f64,
                                width: c.width as f64,
                                height: c.height as f64,
                            },
                            blocks: c.blocks,
                        })
                        .collect();
                    job.phase = Phase::Component(0);
                }
                Phase::Component(c) if c < job.components.len() => {
                    let canvas = &job.p.canvas;
                    let Some(entry) = self.canvases.iter_mut().find(|e| &e.canvas == canvas) else {
                        return Ok(Step::NeedTemporal(canvas.clone()));
                    };
                    let index = entry.index.as_mut().ok_or(CompositeError::Disposed)?;
                    let comp = &job.components[c];
                    let (count, next) = index.decide(
                        comp.bounds,
                        &comp.blocks,
                        job.p.frame,
                        job.p.time,
                        job.world,
                        self.policy == TemporalPolicy::Latest,
                        self.sequence,
                    );
                    self.sequence = next;
                    let write_blocks = index.pending_write_blocks().to_vec();
                    let mask_ok = count > 0
                        && mask_complete(
                            &write_blocks,
                            frame.labels,
                            self.atlas_width as i64,
                            self.atlas_height as i64,
                            job.p.code,
                            &job.p.occlusions,
                            frame.consistent,
                            job.ox,
                            job.oy,
                        );
                    let commit = index.commit(mask_ok).unwrap();
                    job.patch.clear();
                    if commit.chosen {
                        for &(bx, by) in &write_blocks {
                            let b = QUALITY_BLOCK as i32;
                            let t = ((bx * b).div_euclid(size), (by * b).div_euclid(size));
                            match job.patch.iter_mut().find(|(k, _)| *k == t) {
                                Some((_, v)) => v.push((bx as i64, by as i64)),
                                None => job.patch.push((t, vec![(bx as i64, by as i64)])),
                            }
                        }
                    }
                    job.incomplete = commit.emit_incomplete.then_some(commit.rect);
                    job.phase = Phase::Patch(c, 0);
                }
                Phase::Component(_) => {
                    let mut regions: Vec<Rect> = job.components.iter().map(|c| c.bounds).collect();
                    let region = regions
                        .iter()
                        .copied()
                        .reduce(|a, b| {
                            if b.width * b.height > a.width * a.height {
                                b
                            } else {
                                a
                            }
                        })
                        .unwrap();
                    job.diagnostics.push(CompositorDiagnostic::Conflict {
                        canvas: job.p.canvas.clone(),
                        frame: job.p.frame,
                        time: job.p.time,
                        region,
                        confidence: job.p.confidence,
                        regions: std::mem::take(&mut regions),
                        conflicts: job.stats.conflicts,
                    });
                    job.stats.added += job.patched.added;
                    job.stats.tiles += job.patched.tiles;
                    job.stats.conflicts += job.patched.conflicts;
                    job.stats.provisional_pixels += job.patched.provisional_pixels;
                    job.phase = Phase::Done;
                }
                Phase::Patch(c, g) if g < job.patch.len() => {
                    let ((tx, ty), ref blocks) = job.patch[g];
                    let key = TileKey::new(&job.p.canvas, 0, tx, ty);
                    let Some(id) = cache.touch(&key) else {
                        return Ok(Step::NeedTile(key));
                    };
                    let tile = cache.get_mut(id).unwrap();
                    check_tile(tile, cache_size(size))?;
                    let stats = overwrite_tile(
                        &mut OverwriteTile {
                            size: size as usize,
                            pixels: &mut tile.pixels,
                            coverage: &mut tile.coverage,
                            provisional: &mut tile.provisional,
                            quality: &mut tile.quality,
                            conflicts: &mut tile.conflicts,
                            owner: &mut tile.owner,
                            frozen: &mut tile.frozen,
                        },
                        frame.rgba,
                        frame.width as i64,
                        blocks,
                        job.ox,
                        job.oy,
                        tx as i64,
                        ty as i64,
                        job.p.frame,
                        job.p.confidence,
                        self.policy == TemporalPolicy::Stable,
                    );
                    job.patched.added += stats.added as u64;
                    job.patched.conflicts += stats.conflict_pixels as u64;
                    job.patched.provisional_pixels += stats.provisional_delta as i64;
                    if stats.changed {
                        cache.mark_dirty(id, now);
                    }
                    job.phase = Phase::Patch(c, g + 1);
                }
                Phase::Patch(c, _) => job.phase = Phase::Finish(c),
                Phase::Finish(c) => {
                    if let Some(region) = job.incomplete.take() {
                        job.diagnostics.push(CompositorDiagnostic::IncompletePatch {
                            canvas: job.p.canvas.clone(),
                            frame: job.p.frame,
                            time: job.p.time,
                            region,
                        });
                    }
                    job.phase = Phase::Component(c + 1);
                }
                Phase::Done => {
                    return Ok(Step::Done(Outcome {
                        stats: job.stats,
                        diagnostics: std::mem::take(&mut job.diagnostics),
                    }));
                }
            }
        }
    }

    /// Seeds `canvas`'s temporal index from its stored records (ascending id order) the first time a placement
    /// asks for it; afterwards the index is authoritative.
    pub fn load_temporal(
        &mut self,
        canvas: &str,
        records: Vec<TemporalRecord>,
    ) -> Result<(), CompositeError> {
        if self.canvases.iter().any(|e| e.canvas == canvas) {
            return Err(if self.disposed(canvas) {
                CompositeError::Disposed
            } else {
                CompositeError::Unexpected
            });
        }
        let mut index = TemporalIndex::new();
        for record in records {
            index.load(record);
        }
        self.canvases.push(CanvasTemporal {
            canvas: canvas.to_string(),
            index: Some(index),
            stash: None,
        });
        Ok(())
    }

    fn disposed(&self, canvas: &str) -> bool {
        self.canvases
            .iter()
            .any(|e| e.canvas == canvas && e.index.is_none())
    }

    /// Temporal records changed since the last flush, per canvas in first-loaded order.
    pub fn flush(&mut self) -> Vec<TemporalFlush> {
        self.canvases
            .iter_mut()
            .map(|e| {
                let (deleted, dirty) = match e.index.as_mut() {
                    Some(index) => index.flush_take(),
                    None => e.stash.take().unwrap_or_default(),
                };
                TemporalFlush {
                    canvas: e.canvas.clone(),
                    deleted,
                    dirty,
                }
            })
            .collect()
    }

    /// Releases every canvas's index, keeping what the next [`Compositor::flush`] still owes storage. A placement
    /// on a disposed canvas fails with [`CompositeError::Disposed`].
    pub fn dispose(&mut self) {
        for e in &mut self.canvases {
            if let Some(mut index) = e.index.take() {
                e.stash = Some(index.flush_take());
            }
        }
    }
}

/// `size` as the tile side in pixels.
fn cache_size(size: i32) -> usize {
    size as usize
}

fn check_tile(tile: &Tile, size: usize) -> Result<(), CompositeError> {
    let n = size * size;
    let blocks = (size / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
    let ok = tile.pixels.len() == n * 4
        && tile.coverage.len() == n.div_ceil(8)
        && tile.provisional.len() == n.div_ceil(8)
        && [
            tile.quality.len(),
            tile.conflicts.len(),
            tile.owner.len(),
            tile.score.len(),
            tile.frozen.len(),
        ]
        .iter()
        .all(|&l| l == blocks);
    if ok {
        Ok(())
    } else {
        Err(CompositeError::BadTile)
    }
}

fn tile_buffers(tile: &mut Tile, size: usize) -> Result<TileBuffers<'_>, CompositeError> {
    check_tile(tile, size)?;
    Ok(TileBuffers {
        size,
        pixels: &mut tile.pixels,
        coverage: &mut tile.coverage,
        provisional: &mut tile.provisional,
        quality: &mut tile.quality,
        conflicts: &mut tile.conflicts,
        owner: &mut tile.owner,
        score: &mut tile.score,
        frozen: &tile.frozen,
    })
}
