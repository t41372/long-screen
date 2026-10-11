//! The framed presentation canvas of one reconstructed canvas (docs/ARCHITECTURE.md §十 "呈现画布"): the reference
//! frame's native chrome around the reconstructed content, with flat background bands where the content is taller or
//! wider than the pane it was seen through. No toolbar is translated into world coordinates, no sidebar icon is
//! stretched or repeated, and background extensions never count as observed evidence.
//!
//! [`FramingSession`] builds one framed canvas as a resumable job over the tile cache. Its cost is
//! O(perimeter tiles plus observed source tiles), never O(bounding-box area / tile²): before touching an output tile it plans, with grid
//! arithmetic only, the tiles that can be non-empty — those that reach outside the content rect (chrome and
//! background bands, kept so the frame stays continuous) and those under at least one observed source tile — and
//! refuses a plan of more than `max_tiles` tiles before any tile work starts.
//!
//! The host answers what each [`FramingSession::step`] asks for: the reference frame ([`Step::NeedReference`]), the
//! source canvas's level-0 tile index ([`Step::NeedIndex`], asked only once the perimeter alone fits the limit), and
//! tiles that are not resident ([`Step::NeedTile`]: make room with [`TileCache::victim`], storing what is dirty
//! before [`TileCache::evict`], then [`TileCache::insert`]). [`Step::Next`] starts each output tile and is where the host checks for pause and stop;
//! [`Step::Save`] hands back an output tile that received pixels, for the host to store now. Per output tile the
//! session takes the output tile first, then the source tiles under it, row by row, each touched in the cache or
//! asked for, so the cache sees the same sequence of uses as it always has.

use crate::engine::diagnostic::{Diagnostic, Severity};
use crate::engine::tiles::{count_covered, Tile, TileCache, TileKey};
use crate::kernels::framing::{
    backgrounds, fold_evidence, frame_layout, paint_tile, Layout, OutputTile, SourceTile,
};
use crate::kernels::geometry::Rect;
use crate::kernels::region::Region;
use std::collections::HashSet;

/// Planned output tiles a framed canvas may have before it is skipped.
pub const DEFAULT_MAX_TILES: usize = 20000;

/// What the session needs to know about the canvas it frames.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceCanvas {
    pub id: String,
    pub bounds: Rect,
    pub tile_count: u64,
    /// Attached to another canvas (a fragment shown inside it): not framed on its own.
    pub attached: bool,
}

/// The reference frame the chrome is copied from, decoded by the host.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub frame: u32,
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// A framed canvas the session built: its id and size, where the content sits, and the counters it recomputed from
/// the pixels it copied.
#[derive(Clone, Debug, PartialEq)]
pub struct FramedCanvas {
    /// `<source id>-framed`.
    pub id: String,
    pub width: f64,
    pub height: f64,
    /// The pane of the reference frame the content was seen through.
    pub source_region: Rect,
    pub reference_frame: u32,
    /// Where the source canvas's origin lands on the framed canvas.
    pub offset_x: f64,
    pub offset_y: f64,
    /// Output tiles that received pixels (and were saved).
    pub tile_count: u64,
    pub observed_pixels: u64,
    pub provisional_pixels: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Nothing to frame: no reference frame, an empty or attached canvas, or a pane that is the whole frame.
    Unframed,
    /// `PRESENTATION_TOO_SPARSE` (warning, parameter `maxTiles`): the plan exceeded the tile limit; no tile was
    /// touched.
    Skipped(Diagnostic),
    Framed(FramedCanvas),
}

/// An output tile to store now.
#[derive(Clone, Debug, PartialEq)]
pub enum SaveTile {
    /// Still resident in the cache, by id (the host stores it and reports [`TileCache::saved`]).
    Resident(u32),
    /// The cache evicted it while its source tiles were being brought in; the session kept its planes, and the host
    /// stores this copy.
    Detached(Box<Tile>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Read the reference frame and pass it to [`FramingSession::reference`], then step again.
    NeedReference,
    /// Pass every stored level-0 tile-index row of the source canvas to [`FramingSession::index`], then step again.
    NeedIndex,
    /// The next output tile starts; check for pause and stop, then step again.
    Next,
    /// The tile is not resident: make room, insert it, step again.
    NeedTile(TileKey),
    /// Store this output tile now, then step again.
    Save(SaveTile),
    Done(Outcome),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FramingError {
    /// `reference` or `index` out of turn, or a step after the session finished.
    Unexpected,
    /// The reference frame's pixels do not hold `width × height` RGBA pixels.
    BadReference,
    /// Stepped again after [`Step::NeedTile`] without inserting the tile.
    NotProvided,
}

/// Where one tile of the plan is in its work.
struct Work {
    bounds: Rect,
    output: Option<u32>,
    output_copy: Option<Tile>,
    /// The existing source tiles under this output tile, in the order they are taken.
    sources: Vec<(i32, i32)>,
    /// The source tiles taken so far: cache id and, once the cache could have evicted it, a copy.
    held: Vec<(i32, i32, u32, Option<Tile>)>,
    pending: Option<TileKey>,
}

enum Phase {
    Start,
    /// [`Step::NeedReference`] was returned.
    AwaitReference,
    /// The reference frame is in: plan the perimeter.
    Plan,
    /// [`Step::NeedIndex`] was returned.
    AwaitIndex,
    Tiles,
    /// No reference frame: the next step reports [`Outcome::Unframed`].
    Unframed,
    Done,
}

/// An output tile's planes while they are out of the cache, so its source tiles can be read from the cache.
#[derive(Default)]
struct Planes {
    pixels: Vec<u8>,
    coverage: Vec<u8>,
    provisional: Vec<u8>,
    quality: Vec<u8>,
    conflicts: Vec<u8>,
    owner: Vec<u32>,
    score: Vec<f32>,
    frozen: Vec<u8>,
}

impl Planes {
    fn swap(&mut self, t: &mut Tile) {
        std::mem::swap(&mut self.pixels, &mut t.pixels);
        std::mem::swap(&mut self.coverage, &mut t.coverage);
        std::mem::swap(&mut self.provisional, &mut t.provisional);
        std::mem::swap(&mut self.quality, &mut t.quality);
        std::mem::swap(&mut self.conflicts, &mut t.conflicts);
        std::mem::swap(&mut self.owner, &mut t.owner);
        std::mem::swap(&mut self.score, &mut t.score);
        std::mem::swap(&mut self.frozen, &mut t.frozen);
    }

    fn output(&mut self, size: usize) -> OutputTile<'_> {
        OutputTile {
            size,
            pixels: &mut self.pixels,
            coverage: &mut self.coverage,
            provisional: &mut self.provisional,
            quality: &mut self.quality,
            score: &mut self.score,
            owner: &mut self.owner,
            conflicts: &mut self.conflicts,
            frozen: &mut self.frozen,
        }
    }
}

/// One framed canvas in progress.
pub struct FramingSession {
    source: SourceCanvas,
    pane: Rect,
    ignore: Vec<Region>,
    size: usize,
    max_tiles: usize,
    phase: Phase,
    reference: Option<Reference>,
    layout: Option<Layout>,
    existing: Vec<(i32, i32)>,
    existing_set: HashSet<(i32, i32)>,
    candidates: Vec<(i64, i64)>,
    candidate_set: HashSet<(i64, i64)>,
    backgrounds: (Vec<u32>, Vec<u32>),
    next: usize,
    work: Option<Work>,
    framed: Option<FramedCanvas>,
}

/// Intersection of the pane with its crop, or of an output tile with the content.
pub fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    Rect {
        x,
        y,
        width: 0f64.max((a.x + a.width).min(b.x + b.width) - x),
        height: 0f64.max((a.y + a.height).min(b.y + b.height) - y),
    }
}

fn output_of(t: &mut Tile, size: usize) -> OutputTile<'_> {
    OutputTile {
        size,
        pixels: &mut t.pixels,
        coverage: &mut t.coverage,
        provisional: &mut t.provisional,
        quality: &mut t.quality,
        score: &mut t.score,
        owner: &mut t.owner,
        conflicts: &mut t.conflicts,
        frozen: &mut t.frozen,
    }
}

fn source_of(t: &Tile, sx: i32, sy: i32) -> SourceTile<'_> {
    SourceTile {
        sx: sx as i64,
        sy: sy as i64,
        pixels: &t.pixels,
        coverage: &t.coverage,
        provisional: &t.provisional,
        quality: &t.quality,
        score: &t.score,
        owner: &t.owner,
        conflicts: &t.conflicts,
        frozen: &t.frozen,
    }
}

fn any_opaque(pixels: &[u8]) -> bool {
    pixels.chunks_exact(4).any(|p| p[3] != 0)
}

impl FramingSession {
    /// A session framing `source`, seen through `pane` of the reference frame (the region rectangle intersected with its crop), with
    /// `ignore` regions left out of the chrome, over the cache's `size`-pixel tiles.
    pub fn new(
        source: SourceCanvas,
        pane: Rect,
        ignore: Vec<Region>,
        size: usize,
        max_tiles: usize,
    ) -> Self {
        Self {
            source,
            pane,
            ignore,
            size,
            max_tiles,
            phase: Phase::Start,
            reference: None,
            layout: None,
            existing: Vec::new(),
            existing_set: HashSet::new(),
            candidates: Vec::new(),
            candidate_set: HashSet::new(),
            backgrounds: (Vec::new(), Vec::new()),
            next: 0,
            work: None,
            framed: None,
        }
    }

    /// The id of the framed canvas this session builds.
    pub fn framed_id(&self) -> String {
        format!("{}-framed", self.source.id)
    }

    /// The reference frame, or `None` when none is stored.
    pub fn reference(&mut self, reference: Option<Reference>) -> Result<(), FramingError> {
        if !matches!(self.phase, Phase::AwaitReference) {
            return Err(FramingError::Unexpected);
        }
        if let Some(r) = &reference {
            if r.width == 0 || r.height == 0 || r.rgba.len() != r.width * r.height * 4 {
                return Err(FramingError::BadReference);
            }
        }
        self.phase = if reference.is_some() {
            Phase::Plan
        } else {
            Phase::Unframed
        };
        self.reference = reference;
        Ok(())
    }

    /// One stored level-0 tile-index row of the source canvas, in the order the store holds them.
    pub fn index(&mut self, x: i32, y: i32, observed: u64) -> Result<(), FramingError> {
        if !matches!(self.phase, Phase::AwaitIndex) {
            return Err(FramingError::Unexpected);
        }
        if observed > 0 && self.existing_set.insert((x, y)) {
            self.existing.push((x, y));
        }
        Ok(())
    }

    /// Adds one planned tile; `false` once the plan would exceed the limit.
    fn add_candidate(&mut self, tx: i64, ty: i64, cols: i64, rows: i64) -> bool {
        if tx < 0 || tx >= cols || ty < 0 || ty >= rows || self.candidate_set.contains(&(tx, ty)) {
            return true;
        }
        if self.candidates.len() >= self.max_tiles {
            return false;
        }
        self.candidate_set.insert((tx, ty));
        self.candidates.push((tx, ty));
        true
    }

    fn add_range(&mut self, x0: i64, x1: i64, y0: i64, y1: i64, cols: i64, rows: i64) -> bool {
        for ty in y0.max(0)..y1.min(rows) {
            for tx in x0.max(0)..x1.min(cols) {
                if !self.add_candidate(tx, ty, cols, rows) {
                    return false;
                }
            }
        }
        true
    }

    fn grid(&self) -> (i64, i64) {
        let layout = self.layout.as_ref().unwrap();
        let size = self.size as f64;
        (
            (layout.width / size).ceil() as i64,
            (layout.height / size).ceil() as i64,
        )
    }

    fn skipped(&mut self) -> Step {
        self.phase = Phase::Done;
        Step::Done(Outcome::Skipped(
            Diagnostic::new("PRESENTATION_TOO_SPARSE", Severity::Warning)
                .param("maxTiles", self.max_tiles as f64),
        ))
    }

    /// Plans the perimeter: every tile not wholly inside the content rect. The complement of the tiles fully inside
    /// is a ring of chrome and background tiles; a content rect whose edges cut through a tile puts that tile here.
    fn plan_perimeter(&mut self) -> bool {
        let layout = *self.layout.as_ref().unwrap();
        let (cols, rows) = self.grid();
        let size = self.size as f64;
        let content = layout.content;
        let bounded = |n: f64, upper: i64| (n as i64).clamp(0, upper.max(0));
        let inner_x0 = bounded((content.x / size).ceil(), cols);
        let inner_x1 = bounded(((content.x + content.width) / size).floor(), cols);
        let inner_y0 = bounded((content.y / size).ceil(), rows);
        let inner_y1 = bounded(((content.y + content.height) / size).floor(), rows);
        self.add_range(0, cols, 0, inner_y0, cols, rows)
            && self.add_range(0, cols, inner_y1, rows, cols, rows)
            && self.add_range(0, inner_x0, inner_y0, inner_y1, cols, rows)
            && self.add_range(inner_x1, cols, inner_y0, inner_y1, cols, rows)
    }

    /// Plans the tiles under observed source tiles. Each source tile maps to at most four output tiles: both grids
    /// share the tile size.
    fn plan_sources(&mut self) -> bool {
        let layout = *self.layout.as_ref().unwrap();
        let (cols, rows) = self.grid();
        let size = self.size as f64;
        let content = layout.content;
        let bounds = self.source.bounds;
        for i in 0..self.existing.len() {
            let (sx, sy) = self.existing[i];
            let mapped = Rect {
                x: content.x + sx as f64 * size - bounds.x,
                y: content.y + sy as f64 * size - bounds.y,
                width: size,
                height: size,
            };
            let overlap = intersect(mapped, content);
            if overlap.width > 0.0 && overlap.height > 0.0 {
                let x0 = (overlap.x / size).floor() as i64;
                let x1 = ((overlap.x + overlap.width) / size).ceil() as i64;
                let y0 = (overlap.y / size).floor() as i64;
                let y1 = ((overlap.y + overlap.height) / size).ceil() as i64;
                if !self.add_range(x0, x1, y0, y1, cols, rows) {
                    return false;
                }
            }
        }
        true
    }

    fn tile_bounds(&self, tx: i64, ty: i64) -> Rect {
        let layout = self.layout.as_ref().unwrap();
        let size = self.size as f64;
        let (x, y) = (tx as f64 * size, ty as f64 * size);
        Rect {
            x,
            y,
            width: size.min(layout.width - x),
            height: size.min(layout.height - y),
        }
    }

    /// The existing source tiles under output tile `bounds`, row by row.
    fn sources_under(&self, bounds: Rect) -> Vec<(i32, i32)> {
        let layout = self.layout.as_ref().unwrap();
        let overlap = intersect(bounds, layout.content);
        let mut out = Vec::new();
        if overlap.width > 0.0 && overlap.height > 0.0 {
            let size = self.size as f64;
            let wx = (self.source.bounds.x + overlap.x - layout.content.x).floor();
            let wy = (self.source.bounds.y + overlap.y - layout.content.y).floor();
            let (sy0, sy1) = (
                (wy / size).floor() as i64,
                ((wy + overlap.height - 1.0) / size).floor() as i64,
            );
            let (sx0, sx1) = (
                (wx / size).floor() as i64,
                ((wx + overlap.width - 1.0) / size).floor() as i64,
            );
            for sy in sy0..=sy1 {
                for sx in sx0..=sx1 {
                    let key = (sx as i32, sy as i32);
                    if self.existing_set.contains(&key) {
                        out.push(key);
                    }
                }
            }
        }
        out
    }

    /// Takes `key` for the current output tile: touched when resident, `None` (the host must bring it in) when not.
    /// Before the host brings a tile in, every tile taken so far is copied, since making room may evict it.
    fn take(&mut self, cache: &mut TileCache, key: TileKey) -> Result<Option<u32>, FramingError> {
        let work = self.work.as_mut().unwrap();
        if let Some(pending) = work.pending.take() {
            if pending != key {
                return Err(FramingError::NotProvided);
            }
            // Inserted by the host just now: already the most recently used tile.
            return cache.id_of(&key).map(Some).ok_or(FramingError::NotProvided);
        }
        if let Some(id) = cache.touch(&key) {
            return Ok(Some(id));
        }
        if let Some(id) = work.output {
            if work.output_copy.is_none() {
                work.output_copy = cache.get(id).cloned();
            }
        }
        for (_, _, id, copy) in work.held.iter_mut() {
            if copy.is_none() {
                *copy = cache.get(*id).cloned();
            }
        }
        work.pending = Some(key);
        Ok(None)
    }

    pub fn step(&mut self, cache: &mut TileCache, now: f64) -> Result<Step, FramingError> {
        match self.phase {
            Phase::Start => {
                if self.source.tile_count == 0 || self.source.attached {
                    self.phase = Phase::Done;
                    return Ok(Step::Done(Outcome::Unframed));
                }
                self.phase = Phase::AwaitReference;
                Ok(Step::NeedReference)
            }
            Phase::Unframed => {
                self.phase = Phase::Done;
                Ok(Step::Done(Outcome::Unframed))
            }
            Phase::Plan => {
                let reference = self.reference.as_ref().unwrap();
                let (w, h) = (reference.width as f64, reference.height as f64);
                let pane = self.pane;
                if pane.x == 0.0 && pane.y == 0.0 && pane.width == w && pane.height == h {
                    self.phase = Phase::Done;
                    return Ok(Step::Done(Outcome::Unframed));
                }
                self.layout = Some(frame_layout(
                    w,
                    h,
                    pane,
                    self.source.bounds.width,
                    self.source.bounds.height,
                ));
                if !self.plan_perimeter() {
                    return Ok(self.skipped());
                }
                self.phase = Phase::AwaitIndex;
                Ok(Step::NeedIndex)
            }
            Phase::AwaitIndex => {
                if !self.plan_sources() {
                    return Ok(self.skipped());
                }
                let layout = *self.layout.as_ref().unwrap();
                let r = self.reference.as_ref().unwrap();
                self.backgrounds = backgrounds(&r.rgba, r.width, r.height, layout.pane);
                self.framed = Some(FramedCanvas {
                    id: self.framed_id(),
                    width: layout.width,
                    height: layout.height,
                    source_region: layout.pane,
                    reference_frame: r.frame,
                    offset_x: layout.content.x - self.source.bounds.x,
                    offset_y: layout.content.y - self.source.bounds.y,
                    tile_count: 0,
                    observed_pixels: 0,
                    provisional_pixels: 0,
                });
                self.phase = Phase::Tiles;
                Ok(self.next_tile())
            }
            Phase::Tiles => self.tiles(cache, now),
            Phase::AwaitReference | Phase::Done => Err(FramingError::Unexpected),
        }
    }

    /// Starts the next planned output tile, or finishes.
    fn next_tile(&mut self) -> Step {
        let Some(&(tx, ty)) = self.candidates.get(self.next) else {
            self.phase = Phase::Done;
            self.work = None;
            return Step::Done(Outcome::Framed(self.framed.take().unwrap()));
        };
        self.next += 1;
        let bounds = self.tile_bounds(tx, ty);
        self.work = Some(Work {
            bounds,
            output: None,
            output_copy: None,
            sources: self.sources_under(bounds),
            held: Vec::new(),
            pending: None,
        });
        Step::Next
    }

    fn tiles(&mut self, cache: &mut TileCache, now: f64) -> Result<Step, FramingError> {
        if self.work.is_none() {
            return Ok(self.next_tile());
        }
        let size = self.size;
        if self.work.as_ref().unwrap().output.is_none() {
            let (tx, ty) = self.candidates[self.next - 1];
            let key = TileKey::new(&self.framed_id(), 0, tx as i32, ty as i32);
            let Some(id) = self.take(cache, key.clone())? else {
                return Ok(Step::NeedTile(key));
            };
            let work = self.work.as_mut().unwrap();
            work.output = Some(id);
            let (layout, r) = (
                self.layout.as_ref().unwrap(),
                self.reference.as_ref().unwrap(),
            );
            paint_tile(
                &mut output_of(cache.get_mut(id).unwrap(), size),
                layout,
                work.bounds,
                &r.rgba,
                r.width,
                r.height,
                &self.backgrounds.0,
                &self.backgrounds.1,
                &self.ignore,
            );
        }
        loop {
            let work = self.work.as_ref().unwrap();
            let Some(&(sx, sy)) = work.sources.get(work.held.len()) else {
                break;
            };
            let key = TileKey::new(&self.source.id, 0, sx, sy);
            let Some(id) = self.take(cache, key.clone())? else {
                return Ok(Step::NeedTile(key));
            };
            self.work.as_mut().unwrap().held.push((sx, sy, id, None));
        }
        self.finish_tile(cache, now)
    }

    /// Folds the source tiles into the output tile and, when it received any pixel, counts it and asks the host to
    /// store it.
    fn finish_tile(&mut self, cache: &mut TileCache, now: f64) -> Result<Step, FramingError> {
        let size = self.size;
        let layout = *self.layout.as_ref().unwrap();
        let (bx, by) = (self.source.bounds.x, self.source.bounds.y);
        let mut work = self.work.take().unwrap();
        let output = work.output.unwrap();
        // Evicted while its source tiles came in: carry on with the copy taken before that.
        let mut detached = match cache.get(output) {
            Some(_) => None,
            None => Some(work.output_copy.take().ok_or(FramingError::NotProvided)?),
        };
        if !work.held.is_empty() {
            let mut planes = Planes::default();
            if detached.is_none() {
                // The output tile's planes leave the cache while the source tiles are read from it.
                planes.swap(cache.get_mut(output).unwrap());
            }
            {
                let mut sources = Vec::with_capacity(work.held.len());
                for (sx, sy, id, copy) in &work.held {
                    let t = match cache.get(*id) {
                        Some(t) => t,
                        None => copy.as_ref().ok_or(FramingError::NotProvided)?,
                    };
                    sources.push(source_of(t, *sx, *sy));
                }
                let mut out = match detached.as_mut() {
                    Some(t) => output_of(t, size),
                    None => planes.output(size),
                };
                fold_evidence(&mut out, &layout, bx, by, work.bounds, &sources);
            }
            if detached.is_none() {
                planes.swap(cache.get_mut(output).unwrap());
            }
        }
        let tile = match detached.as_mut() {
            Some(t) => t,
            None => cache.get_mut(output).unwrap(),
        };
        if !any_opaque(&tile.pixels) {
            return Ok(self.next_tile());
        }
        tile.dirty = true;
        tile.touched = Some(now);
        let framed = self.framed.as_mut().unwrap();
        framed.tile_count += 1;
        framed.observed_pixels += count_covered(&tile.coverage);
        framed.provisional_pixels += count_covered(&tile.provisional);
        Ok(Step::Save(match detached {
            Some(t) => SaveTile::Detached(Box::new(t)),
            None => SaveTile::Resident(output),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::tiles::StoredTile;
    use std::collections::HashMap;

    const S: usize = 16;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// 40 × 30, every pixel opaque (or, with `alpha` 0, fully transparent) and distinct by position.
    fn reference(alpha: u8) -> Reference {
        let (width, height) = (40, 30);
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[(x * 5) as u8, (y * 5) as u8, 77, alpha]);
            }
        }
        Reference {
            frame: 3,
            width,
            height,
            rgba,
        }
    }

    /// A 60 × 50 canvas seen through pane (4, 4, 24, 20): a 76 × 60 framed canvas, 5 × 4 tiles of 16, of which the
    /// 14 around the edge are chrome and background and the 6 inside are content only.
    fn source() -> SourceCanvas {
        SourceCanvas {
            id: "src".into(),
            bounds: rect(0.0, 0.0, 60.0, 50.0),
            tile_count: 12,
            attached: false,
        }
    }

    fn session(source: SourceCanvas, pane: Rect, max_tiles: usize) -> FramingSession {
        FramingSession::new(source, pane, Vec::new(), S, max_tiles)
    }

    const PANE: Rect = Rect {
        x: 4.0,
        y: 4.0,
        width: 24.0,
        height: 20.0,
    };

    /// Every source tile of the 60 × 50 canvas, in the order a store iterates their `x_y` keys.
    fn index() -> Vec<(i32, i32, u64)> {
        let mut rows: Vec<(String, i32, i32)> = (0..4)
            .flat_map(|x| (0..4).map(move |y| (format!("{x}_{y}"), x, y)))
            .collect();
        rows.sort();
        rows.into_iter().map(|(_, x, y)| (x, y, 256)).collect()
    }

    #[derive(Default)]
    struct Host {
        store: HashMap<TileKey, StoredTile>,
        needs: Vec<TileKey>,
        saves: Vec<TileKey>,
        detached: usize,
        nexts: usize,
        reference_asked: bool,
        index_asked: bool,
    }

    impl Host {
        fn with_sources() -> Host {
            let mut host = Host::default();
            for (x, y, _) in index() {
                let n = S * S;
                let mut pixels = vec![0u8; n * 4];
                for p in pixels.chunks_exact_mut(4) {
                    p.copy_from_slice(&[x as u8 * 40, y as u8 * 40, 200, 255]);
                }
                let mut provisional = vec![0u8; n / 8];
                provisional[0] = 1;
                host.store.insert(
                    TileKey::new("src", 0, x, y),
                    StoredTile {
                        pixels,
                        coverage: Some(vec![255; n / 8]),
                        provisional: Some(provisional),
                        quality: Some(vec![(x * 10 + y) as u8; 1]),
                        conflicts: Some(vec![(x == 1) as u8; 1]),
                        owner: Some(vec![(y + 1) as u32; 1]),
                        score: Some(vec![x as f32; 1]),
                        frozen: Some(vec![(y == 2) as u8; 1]),
                    },
                );
            }
            host
        }

        fn keep(&mut self, t: Tile) {
            self.store.insert(
                t.key.clone(),
                StoredTile {
                    pixels: t.pixels,
                    coverage: Some(t.coverage),
                    provisional: Some(t.provisional),
                    quality: Some(t.quality),
                    conflicts: Some(t.conflicts),
                    owner: Some(t.owner),
                    score: Some(t.score),
                    frozen: Some(t.frozen),
                },
            );
        }

        fn run(
            &mut self,
            s: &mut FramingSession,
            cache: &mut TileCache,
            reference: Option<Reference>,
            index: &[(i32, i32, u64)],
        ) -> Outcome {
            loop {
                match s.step(cache, 1.0).unwrap() {
                    Step::NeedReference => {
                        self.reference_asked = true;
                        s.reference(reference.clone()).unwrap();
                    }
                    Step::NeedIndex => {
                        self.index_asked = true;
                        for &(x, y, observed) in index {
                            s.index(x, y, observed).unwrap();
                        }
                    }
                    Step::Next => self.nexts += 1,
                    Step::NeedTile(key) => {
                        self.needs.push(key.clone());
                        while let Some(id) = cache.victim() {
                            let t = cache.evict(id).unwrap();
                            if t.dirty {
                                self.keep(t);
                            }
                        }
                        let stored = self.store.get(&key).cloned();
                        cache.insert(key, stored).unwrap();
                    }
                    Step::Save(SaveTile::Resident(id)) => {
                        let t = cache.get(id).unwrap().clone();
                        assert!(t.dirty);
                        self.saves.push(t.key.clone());
                        self.keep(t);
                        cache.encoded();
                        cache.saved(id);
                    }
                    Step::Save(SaveTile::Detached(t)) => {
                        assert!(t.dirty);
                        self.detached += 1;
                        self.saves.push(t.key.clone());
                        self.keep(*t);
                        cache.encoded();
                    }
                    Step::Done(outcome) => return outcome,
                }
            }
        }
    }

    fn framed(x: i32, y: i32) -> TileKey {
        TileKey::new("src-framed", 0, x, y)
    }

    fn src(x: i32, y: i32) -> TileKey {
        TileKey::new("src", 0, x, y)
    }

    #[test]
    fn an_empty_or_attached_canvas_is_not_framed_and_reads_nothing() {
        for canvas in [
            SourceCanvas {
                tile_count: 0,
                ..source()
            },
            SourceCanvas {
                attached: true,
                ..source()
            },
        ] {
            let mut cache = TileCache::new(S, 128.0).unwrap();
            let mut host = Host::default();
            let outcome = host.run(
                &mut session(canvas, PANE, DEFAULT_MAX_TILES),
                &mut cache,
                Some(reference(255)),
                &index(),
            );
            assert_eq!(outcome, Outcome::Unframed);
            assert!(!host.reference_asked && !host.index_asked && host.needs.is_empty());
        }
    }

    #[test]
    fn without_a_reference_frame_nothing_is_framed() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::default();
        let outcome = host.run(
            &mut session(source(), PANE, DEFAULT_MAX_TILES),
            &mut cache,
            None,
            &index(),
        );
        assert_eq!(outcome, Outcome::Unframed);
        assert!(host.reference_asked && !host.index_asked && host.needs.is_empty());
    }

    #[test]
    fn a_pane_that_is_the_whole_frame_is_not_framed() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::default();
        let outcome = host.run(
            &mut session(source(), rect(0.0, 0.0, 40.0, 30.0), DEFAULT_MAX_TILES),
            &mut cache,
            Some(reference(255)),
            &index(),
        );
        assert_eq!(outcome, Outcome::Unframed);
        assert!(!host.index_asked && host.needs.is_empty());
    }

    #[test]
    fn a_perimeter_over_the_limit_is_skipped_before_the_index_is_read() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::with_sources();
        let outcome = host.run(
            &mut session(source(), PANE, 13),
            &mut cache,
            Some(reference(255)),
            &index(),
        );
        let Outcome::Skipped(d) = outcome else {
            panic!("expected a skip, got {outcome:?}");
        };
        assert_eq!(d.code, "PRESENTATION_TOO_SPARSE");
        assert_eq!(d.severity, Severity::Warning);
        assert_eq!(d.params, vec![("maxTiles", 13.0)]);
        assert!(!host.index_asked && host.needs.is_empty() && cache.is_empty());
    }

    #[test]
    fn source_tiles_over_the_limit_skip_the_canvas_before_any_tile_is_touched() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::with_sources();
        // The 14 perimeter tiles fit; the 6 content tiles under the source tiles do not.
        let outcome = host.run(
            &mut session(source(), PANE, 14),
            &mut cache,
            Some(reference(255)),
            &index(),
        );
        assert!(matches!(outcome, Outcome::Skipped(_)), "{outcome:?}");
        assert!(host.index_asked && host.needs.is_empty() && host.nexts == 0 && cache.is_empty());
    }

    #[test]
    fn tiles_are_planned_perimeter_first_then_under_each_observed_source_tile_in_index_order() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::with_sources();
        host.run(
            &mut session(source(), PANE, DEFAULT_MAX_TILES),
            &mut cache,
            Some(reference(255)),
            &index(),
        );
        let outputs: Vec<TileKey> = host
            .needs
            .iter()
            .filter(|k| k.canvas == "src-framed")
            .cloned()
            .collect();
        let expected: Vec<TileKey> = [
            // Top row, bottom row, left column, right column.
            (0, 0),
            (1, 0),
            (2, 0),
            (3, 0),
            (4, 0),
            (0, 3),
            (1, 3),
            (2, 3),
            (3, 3),
            (4, 3),
            (0, 1),
            (0, 2),
            (4, 1),
            (4, 2),
            // Under source tiles 0_0, 0_1, 1_0, 1_1, 2_0, 2_1 (each adds the content tiles not yet planned).
            (1, 1),
            (1, 2),
            (2, 1),
            (2, 2),
            (3, 1),
            (3, 2),
        ]
        .iter()
        .map(|&(x, y)| framed(x, y))
        .collect();
        assert_eq!(outputs, expected);
        assert_eq!(host.nexts, 20);
    }

    #[test]
    fn unobserved_source_tiles_plan_nothing() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::with_sources();
        let unobserved: Vec<(i32, i32, u64)> =
            index().into_iter().map(|(x, y, _)| (x, y, 0)).collect();
        let outcome = host.run(
            &mut session(source(), PANE, DEFAULT_MAX_TILES),
            &mut cache,
            Some(reference(255)),
            &unobserved,
        );
        assert_eq!(host.nexts, 14);
        assert!(host.needs.iter().all(|k| k.canvas == "src-framed"));
        let Outcome::Framed(f) = outcome else {
            panic!("expected a framed canvas");
        };
        assert_eq!(f.observed_pixels, host_coverage(&host));
    }

    fn host_coverage(host: &Host) -> u64 {
        host.saves
            .iter()
            .map(|k| count_covered(host.store[k].coverage.as_ref().unwrap()))
            .sum()
    }

    #[test]
    fn each_output_tile_takes_itself_then_its_source_tiles_row_by_row() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::with_sources();
        host.run(
            &mut session(source(), PANE, DEFAULT_MAX_TILES),
            &mut cache,
            Some(reference(255)),
            &index(),
        );
        // (0,0) covers source 0_0; (1,0) covers 0_0 (resident by then) and 1_0; (2,0) covers 1_0 and 2_0.
        assert_eq!(
            host.needs[..6],
            [
                framed(0, 0),
                src(0, 0),
                framed(1, 0),
                src(1, 0),
                framed(2, 0),
                src(2, 0)
            ]
        );
    }

    #[test]
    fn a_cache_of_two_tiles_frames_exactly_what_a_large_one_does() {
        let run = |max: u64| {
            let mut cache = TileCache::new(S, 128.0).unwrap();
            cache.set_max_tiles(max);
            let mut host = Host::with_sources();
            let outcome = host.run(
                &mut session(source(), PANE, DEFAULT_MAX_TILES),
                &mut cache,
                Some(reference(255)),
                &index(),
            );
            (outcome, host)
        };
        let (large, large_host) = run(1000);
        let (small, small_host) = run(2);
        assert_eq!(large, small);
        assert_eq!(large_host.detached, 0);
        assert!(
            small_host.detached > 0,
            "the small cache never evicted an output tile"
        );
        assert_eq!(large_host.saves, small_host.saves);
        for key in &large_host.saves {
            assert_eq!(large_host.store[key], small_host.store[key], "{key:?}");
        }
        let Outcome::Framed(f) = large else {
            panic!("expected a framed canvas");
        };
        assert_eq!(f.id, "src-framed");
        assert_eq!((f.width, f.height), (76.0, 60.0));
        assert_eq!(f.source_region, PANE);
        assert_eq!((f.offset_x, f.offset_y, f.reference_frame), (4.0, 4.0, 3));
        assert_eq!(f.tile_count, 20);
        assert_eq!(f.observed_pixels, host_coverage(&large_host));
        // One provisional bit per source tile, at its first pixel: all 16 land inside the 60 × 50 canvas.
        assert_eq!(f.provisional_pixels, 16);
    }

    #[test]
    fn an_output_tile_that_stays_transparent_is_not_saved() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut host = Host::default();
        let outcome = host.run(
            &mut session(source(), PANE, DEFAULT_MAX_TILES),
            &mut cache,
            Some(reference(0)),
            &[],
        );
        let Outcome::Framed(f) = outcome else {
            panic!("expected a framed canvas");
        };
        assert_eq!((f.tile_count, f.observed_pixels), (0, 0));
        assert_eq!(host.nexts, 14);
        assert!(host.saves.is_empty());
        assert!(cache.dirty(None).is_empty());
    }

    #[test]
    fn calls_out_of_turn_and_a_tile_not_brought_in_are_refused() {
        let mut cache = TileCache::new(S, 128.0).unwrap();
        let mut s = session(source(), PANE, DEFAULT_MAX_TILES);
        assert_eq!(s.reference(None), Err(FramingError::Unexpected));
        assert_eq!(s.index(0, 0, 1), Err(FramingError::Unexpected));
        assert_eq!(s.step(&mut cache, 0.0), Ok(Step::NeedReference));
        assert_eq!(s.step(&mut cache, 0.0), Err(FramingError::Unexpected));
        let mut bad = reference(255);
        bad.rgba.pop();
        assert_eq!(s.reference(Some(bad)), Err(FramingError::BadReference));
        s.reference(Some(reference(255))).unwrap();
        assert_eq!(s.step(&mut cache, 0.0), Ok(Step::NeedIndex));
        assert_eq!(s.step(&mut cache, 0.0), Ok(Step::Next));
        assert_eq!(s.step(&mut cache, 0.0), Ok(Step::NeedTile(framed(0, 0))));
        assert_eq!(s.step(&mut cache, 0.0), Err(FramingError::NotProvided));
    }
}
