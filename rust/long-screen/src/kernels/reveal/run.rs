//! One reveal run: the four frame-major passes over every moving layer and canvas, driven one decoded frame at
//! a time by the adapter.
//!
//! Statistics passes (1 and 3) compare every distinct pose against a reference: the compositor's canvas as cell
//! means (pass 1), then the consensus (pass 3). Selection passes (2 and 4) track overlays on every frame but
//! vote once per run of identical poses, with the run's last frame: a page at rest shows its settled state
//! (a scrollbar has faded, a hover has passed). A pixel inside an overlay's zone that was still changing between
//! the run's last two frames votes below clean.

use super::blocks::{
    self, BlockWrite, Consensus, Deferred, Grid, Output, CONSENSUS_BLOCK_BYTES, FALLBACK_BYTES,
    OUTPUT_BLOCK_BYTES,
};
use super::locate::{self, TierMap};
use super::model::{self, LayerModel};
use super::stats::Acc;
use super::stats::{CellMap, LayerStats};
use super::{tolerance, CanvasView, Footprint, Frame, BLOCK, CELL, TIER_FRINGE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    Learn,
    Agree,
    Relearn,
    Write,
}

/// One moving-layer placement of a frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub layer: usize,
    pub canvas: usize,
    pub x: i64,
    pub y: i64,
    pub occlusions: Vec<(i64, i64, i64, i64)>,
}

/// Which decisions the passes use, given every decoded frame's decisions in order, each with whether it is blind
/// (too little texture to track: the solve held the layer's pose and the compositor painted nothing from it). A
/// tracked decision always counts. A blind one counts only for a layer whose tracked decisions all sit at one pose,
/// and only at that pose, where the held pose is certainly right. In b, the floating-button corner is tracked only
/// while the cursor crosses it; without its blind frames, its one pose run ended with the last frame the cursor was
/// in, and that frame's vote burned the cursor into the print.
pub fn admitted(plans: &[Vec<(Decision, bool)>]) -> Vec<Vec<bool>> {
    #[derive(Clone, Copy, PartialEq)]
    enum Still {
        Unseen,
        At(usize, i64, i64),
        Moved,
    }
    let layers = plans
        .iter()
        .flatten()
        .map(|(d, _)| d.layer + 1)
        .max()
        .unwrap_or(0);
    let mut still = vec![Still::Unseen; layers];
    for (d, _) in plans.iter().flatten().filter(|(_, blind)| !blind) {
        let at = Still::At(d.canvas, d.x, d.y);
        let s = &mut still[d.layer];
        *s = if *s == Still::Unseen || *s == at {
            at
        } else {
            Still::Moved
        };
    }
    plans
        .iter()
        .map(|ds| {
            ds.iter()
                .map(|(d, blind)| !blind || still[d.layer] == Still::At(d.canvas, d.x, d.y))
                .collect()
        })
        .collect()
}

pub struct Layer {
    pub x: i64,
    pub y: i64,
    pub width: usize,
    pub height: usize,
    /// Atlas label code of the layer (0 = the whole rectangle is owned).
    pub code: u8,
    /// The layer's label mask over its rectangle, built from the first frame's label plane.
    labels: Option<Vec<u8>>,
    stats: Option<LayerStats>,
    pub model: Option<LayerModel>,
    zone: Vec<bool>,
    /// Pose of the last distinct observation (statistics passes).
    last: Option<(usize, i64, i64)>,
    /// The run the selection passes have not voted yet: its last frame, decision and length.
    pending: Option<(u32, Decision, u32)>,
}

impl Layer {
    /// The layer's label mask over its rectangle: pixels whose atlas label is `code` (all of them when `labels` is
    /// absent or `code` is 0). `labels` is the frame-sized label plane.
    fn label_mask(
        &self,
        labels: Option<&[u8]>,
        frame_width: usize,
        frame_height: usize,
    ) -> Vec<u8> {
        let mut m = vec![0u8; self.width * self.height];
        for ly in 0..self.height {
            let sy = self.y + ly as i64;
            if sy < 0 || sy >= frame_height as i64 {
                continue;
            }
            for lx in 0..self.width {
                let sx = self.x + lx as i64;
                if sx < 0 || sx >= frame_width as i64 {
                    continue;
                }
                m[ly * self.width + lx] = match labels {
                    Some(l) if self.code != 0 => {
                        (l[sy as usize * frame_width + sx as usize] == self.code) as u8
                    }
                    _ => 1,
                };
            }
        }
        m
    }
}

pub struct Canvas {
    pub x: i64,
    pub y: i64,
    pub width: usize,
    pub height: usize,
    pub main: CellMap,
    pub consensus: Option<Consensus>,
    pub output: Option<Output>,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Summary {
    pub objects: usize,
    pub components: usize,
    pub coherent: usize,
    pub component_blocks: usize,
    pub provisional: usize,
    pub fallback: usize,
}

pub struct Reveal {
    pub width: usize,
    pub height: usize,
    pub tau: i32,
    pub pass: Pass,
    pub layers: Vec<Layer>,
    pub canvases: Vec<Canvas>,
    /// Block copies the adapter owes the output since it last drained them.
    pub writes: Vec<BlockWrite>,
}

/// This frame's footprint mask of a decision's layer: the layer's label mask, copied only when the frame occludes
/// part of it.
fn layer_mask<'a>(l: &'a Layer, d: &Decision) -> std::borrow::Cow<'a, [u8]> {
    let base = l.labels.as_deref().unwrap_or(&[]);
    if d.occlusions.is_empty() {
        std::borrow::Cow::Borrowed(base)
    } else {
        std::borrow::Cow::Owned(Footprint::occlude(
            base,
            l.x,
            l.y,
            l.width,
            l.height,
            &d.occlusions,
        ))
    }
}

fn footprint<'a>(l: &Layer, mask: &'a [u8]) -> Footprint<'a> {
    Footprint {
        x: l.x,
        y: l.y,
        width: l.width,
        height: l.height,
        mask,
    }
}

/// Core memory the reveal holds for a canvas of `width × height`: its reference cells, the agree pass's consensus, and
/// the write pass's per-block output with a held view for every block. The write pass's per-pixel fallback state comes
/// on top ([`Reveal::fallback_bytes`], known once the agree pass has run). A world-aligned grid can reach one more cell
/// and block past each edge than the size alone gives.
pub fn canvas_bytes(width: usize, height: usize) -> usize {
    let cells = (width / CELL + 2) * (height / CELL + 2);
    let blocks = (width / BLOCK + 2) * (height / BLOCK + 2);
    cells * std::mem::size_of::<[u8; 4]>() + blocks * (CONSENSUS_BLOCK_BYTES + OUTPUT_BLOCK_BYTES)
}

/// Core memory the reveal holds for a layer of `width × height`: its label mask and cell statistics, with room for the
/// per-cell sums its model is built from.
pub fn layer_bytes(width: usize, height: usize) -> usize {
    let cells = width.div_ceil(CELL) * height.div_ceil(CELL);
    width * height + cells * (std::mem::size_of::<Acc>() + 8 * std::mem::size_of::<u64>())
}

impl Reveal {
    pub fn new(width: usize, height: usize, noise: f64) -> Self {
        Self {
            width,
            height,
            tau: tolerance(noise),
            pass: Pass::Learn,
            layers: Vec::new(),
            canvases: Vec::new(),
            writes: Vec::new(),
        }
    }

    pub fn add_layer(&mut self, x: i64, y: i64, width: usize, height: usize, code: u8) -> usize {
        self.layers.push(Layer {
            x,
            y,
            width,
            height,
            code,
            labels: None,
            stats: None,
            model: None,
            zone: Vec::new(),
            last: None,
            pending: None,
        });
        self.layers.len() - 1
    }

    pub fn add_canvas(&mut self, x: i64, y: i64, width: usize, height: usize) -> usize {
        self.canvases.push(Canvas {
            x,
            y,
            width,
            height,
            main: CellMap::covering(x, y, width, height),
            consensus: None,
            output: None,
        });
        self.canvases.len() - 1
    }

    /// What the write pass's per-pixel fallback state will take at most, once the agree pass has built every canvas's
    /// consensus.
    pub fn fallback_bytes(&self) -> usize {
        self.canvases
            .iter()
            .filter_map(|c| c.consensus.as_ref())
            .map(|c| c.unseen_blocks() * FALLBACK_BYTES)
            .sum()
    }

    /// Adds part of the compositor's canvas (a tile) to its cell-mean reference.
    pub fn ingest(&mut self, canvas: usize, view: &CanvasView<'_>) {
        self.canvases[canvas].main.ingest(view);
    }

    /// Starts a pass, building what it needs from the previous one.
    pub fn begin(&mut self, pass: Pass) {
        match pass {
            Pass::Learn | Pass::Relearn => {
                for l in &mut self.layers {
                    l.stats = Some(LayerStats::new(l.x, l.y, l.width, l.height));
                    l.last = None;
                }
            }
            Pass::Agree | Pass::Write => {
                for l in &mut self.layers {
                    if let Some(s) = l.stats.take() {
                        let m = model::build(&s, self.tau);
                        l.zone = m.overlay_zone();
                        l.model = Some(m);
                    }
                    l.pending = None;
                }
                for c in &mut self.canvases {
                    if pass == Pass::Agree {
                        c.consensus =
                            Some(Consensus::new(Grid::covering(c.x, c.y, c.width, c.height)));
                    } else if let Some(cons) = &c.consensus {
                        c.output = Some(Output::new(cons, blocks::components(cons)));
                    }
                }
            }
        }
        self.pass = pass;
        self.writes.clear();
    }

    /// Fallback blocks of `canvas` (world block coordinates) whose compositor pixels the adapter must supply with
    /// [`Reveal::set_main`] before the write pass's first frame.
    pub fn fallback_blocks(&self, canvas: usize) -> Vec<(i64, i64)> {
        let c = &self.canvases[canvas];
        let (Some(cons), Some(out)) = (&c.consensus, &c.output) else {
            return Vec::new();
        };
        out.fallback_blocks()
            .into_iter()
            .map(|b| {
                (
                    cons.grid.gx + (b % cons.grid.bw) as i64,
                    cons.grid.gy + (b / cons.grid.bw) as i64,
                )
            })
            .collect()
    }

    pub fn set_main(&mut self, canvas: usize, gx: i64, gy: i64, rgba: &[u8]) {
        let c = &mut self.canvases[canvas];
        let (Some(cons), Some(out)) = (&c.consensus, &mut c.output) else {
            return;
        };
        let (bx, by) = (gx - cons.grid.gx, gy - cons.grid.gy);
        if bx >= 0 && by >= 0 && (bx as usize) < cons.grid.bw && (by as usize) < cons.grid.bh {
            out.set_main(by as usize * cons.grid.bw + bx as usize, rgba);
        }
    }

    /// Which frames this pass reads pixels of, given every decoded frame's decisions in order (`plans[i]` belongs
    /// to frame `i`): in the statistics passes a frame that shows some layer at a pose it was not just shown at;
    /// in the selection passes the last frame of every run of identical poses, and the frame before it when the
    /// run is longer (the settle check compares the two). Mirrors [`Reveal::frame`], so a frame left out here is
    /// one it never reads.
    pub fn wanted(&self, plans: &[Vec<Decision>]) -> Vec<bool> {
        let n = plans.len();
        let mut want = vec![false; n];
        let key = |d: &Decision| (d.canvas, d.x, d.y);
        match self.pass {
            Pass::Learn | Pass::Relearn => {
                let mut last = vec![None; self.layers.len()];
                for (i, ds) in plans.iter().enumerate() {
                    for d in ds {
                        if last[d.layer] != Some(key(d)) {
                            last[d.layer] = Some(key(d));
                            want[i] = true;
                        }
                    }
                }
            }
            Pass::Agree | Pass::Write => {
                let mut run = vec![0u32; self.layers.len()];
                let mut prev: Vec<Option<(usize, i64, i64)>> = vec![None; self.layers.len()];
                for (i, ds) in plans.iter().enumerate() {
                    let mut seen = vec![None; self.layers.len()];
                    for d in ds {
                        seen[d.layer] = Some(key(d));
                    }
                    for (l, k) in seen.iter().enumerate() {
                        run[l] = match k {
                            Some(k) if prev[l] == Some(*k) => run[l] + 1,
                            Some(_) => 1,
                            None => 0,
                        };
                        let Some(k) = k else { continue };
                        let continues = plans
                            .get(i + 1)
                            .is_some_and(|next| next.iter().any(|d| d.layer == l && key(d) == *k));
                        if !continues {
                            want[i] = true;
                            if run[l] >= 2 {
                                want[i - 1] = true;
                            }
                        }
                    }
                    prev = seen;
                }
            }
        }
        want
    }

    /// Builds every layer's label mask from the first frame's label plane.
    fn ensure_labels(&mut self, labels: Option<&[u8]>) {
        let (w, h) = (self.width, self.height);
        for l in &mut self.layers {
            if l.labels.is_none() {
                l.labels = Some(l.label_mask(labels, w, h));
            }
        }
    }

    /// One decoded frame. `prev`/`prev2` are the two frames before it (absent at the start); `labels` is the
    /// atlas label plane.
    pub fn frame(
        &mut self,
        index: u32,
        current: Option<&[u8]>,
        prev: Option<&[u8]>,
        prev2: Option<&[u8]>,
        labels: Option<&[u8]>,
        decisions: &[Decision],
    ) {
        self.ensure_labels(labels);
        match self.pass {
            Pass::Learn | Pass::Relearn => {
                // A frame [`Reveal::wanted`] leaves out shows every layer where it was just shown.
                let Some(current) = current else { return };
                let cur = Frame {
                    rgba: current,
                    width: self.width,
                    height: self.height,
                };
                for d in decisions {
                    let key = (d.canvas, d.x, d.y);
                    if self.layers[d.layer].last == Some(key) {
                        continue;
                    }
                    self.layers[d.layer].last = Some(key);
                    // Split borrow: stats live on the layer, the reference on the canvas.
                    let mut stats = self.layers[d.layer].stats.take().unwrap();
                    let layer = &self.layers[d.layer];
                    let mask = layer_mask(layer, d);
                    let fp = footprint(layer, &mask);
                    let c = &self.canvases[d.canvas];
                    match (self.pass, &c.consensus) {
                        (Pass::Learn, _) => {
                            stats.accumulate_cells(&cur, &fp, &c.main, (d.x, d.y), self.tau);
                        }
                        (_, Some(cons)) => {
                            stats.accumulate_cells(&cur, &fp, cons, (d.x, d.y), self.tau);
                        }
                        _ => {}
                    }
                    drop(mask);
                    self.layers[d.layer].stats = Some(stats);
                }
            }
            Pass::Agree | Pass::Write => {
                // Overlays are located only in the frame a run votes with, when it ends.
                let mut fresh = Vec::with_capacity(decisions.len());
                for d in decisions {
                    let run = match &self.layers[d.layer].pending {
                        Some((pt, pd, len))
                            if *pt + 1 == index
                                && (pd.canvas, pd.x, pd.y) == (d.canvas, d.x, d.y) =>
                        {
                            len + 1
                        }
                        _ => 1,
                    };
                    fresh.push((d.clone(), run));
                }
                // Runs that ended with the previous frame vote with it.
                for l in 0..self.layers.len() {
                    let Some((pt, pd, _)) = &self.layers[l].pending else {
                        continue;
                    };
                    let continues = decisions.iter().any(|d| {
                        d.layer == l
                            && *pt + 1 == index
                            && (d.canvas, d.x, d.y) == (pd.canvas, pd.x, pd.y)
                    });
                    if continues {
                        continue;
                    }
                    let (pt, pd, len) = self.layers[l].pending.take().unwrap();
                    if let Some(p) = prev {
                        self.vote(pt, &pd, p, if len >= 2 { prev2 } else { None }, labels);
                    }
                }
                for (d, run) in fresh {
                    let l = d.layer;
                    self.layers[l].pending = Some((index, d, run));
                }
            }
        }
    }

    /// Ends a selection pass: the runs still open vote with the last frame (`last`, and `before` the frame ahead
    /// of it).
    pub fn end(&mut self, last: Option<&[u8]>, before: Option<&[u8]>, labels: Option<&[u8]>) {
        let (true, Some(last)) = (matches!(self.pass, Pass::Agree | Pass::Write), last) else {
            return;
        };
        for l in 0..self.layers.len() {
            if let Some((pt, pd, len)) = self.layers[l].pending.take() {
                self.vote(pt, &pd, last, if len >= 2 { before } else { None }, labels);
            }
        }
    }

    fn vote(
        &mut self,
        index: u32,
        d: &Decision,
        rgba: &[u8],
        before: Option<&[u8]>,
        labels: Option<&[u8]>,
    ) {
        let (w, h, tau) = (self.width, self.height, self.tau);
        let frame = Frame {
            rgba,
            width: w,
            height: h,
        };
        let Some(m) = self.layers[d.layer].model.as_mut() else {
            return;
        };
        let mut tiers = locate::tiers(&frame, m, tau);
        let layer = &self.layers[d.layer];
        let m = layer.model.as_ref().unwrap();
        if let Some(b) = before {
            let noise = (self.tau / 4).max(2);
            for cy in 0..m.ch {
                for cx in 0..m.cw {
                    let i = cy * m.cw + cx;
                    if !layer.zone[i] || tiers[i] <= TIER_FRINGE {
                        continue;
                    }
                    let (sx, sy) = (m.x + (cx * CELL) as i64, m.y + (cy * CELL) as i64);
                    'cell: for dy in 0..CELL as i64 {
                        for dx in 0..CELL as i64 {
                            let (x, y) = (sx + dx, sy + dy);
                            if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                                continue;
                            }
                            let j = (y as usize * w + x as usize) * 4;
                            if (0..3).any(|c| (rgba[j + c] as i32 - b[j + c] as i32).abs() > noise)
                            {
                                tiers[i] = TIER_FRINGE;
                                break 'cell;
                            }
                        }
                    }
                }
            }
        }
        let tm = TierMap {
            x: m.x,
            y: m.y,
            cw: m.cw,
            ch: m.ch,
            tier: &tiers,
        };
        let _ = labels;
        let layer = &self.layers[d.layer];
        let mask = layer_mask(layer, d);
        let fp = footprint(layer, &mask);
        let c = &mut self.canvases[d.canvas];
        match self.pass {
            Pass::Agree => {
                if let Some(cons) = c.consensus.as_mut() {
                    cons.observe(&frame, &fp, &tm, (d.x, d.y));
                }
            }
            Pass::Write => {
                if let (Some(cons), Some(out)) = (c.consensus.as_ref(), c.output.as_mut()) {
                    let start = self.writes.len();
                    out.emit(
                        cons,
                        &frame,
                        &fp,
                        &tm,
                        (d.x, d.y),
                        tau,
                        index,
                        &c.main,
                        &mut self.writes,
                    );
                    for w in &mut self.writes[start..] {
                        w.canvas = d.canvas as u32;
                    }
                }
            }
            _ => {}
        }
    }

    /// Drains the block copies owed since the last call. Each copies from the frame the vote used: the previous
    /// frame during [`Reveal::frame`], the last frame during [`Reveal::end`].
    pub fn take_writes(&mut self) -> Vec<BlockWrite> {
        std::mem::take(&mut self.writes)
    }

    /// The deferred blocks of a canvas, after the write pass.
    pub fn finish(&self, canvas: usize) -> Vec<Deferred> {
        let c = &self.canvases[canvas];
        match (&c.consensus, &c.output) {
            (Some(cons), Some(out)) => out.finish(cons, self.tau),
            _ => Vec::new(),
        }
    }

    /// The block grid of a canvas (origin and size in 16-pixel blocks) and where each block's pixels now come from
    /// ([`blocks::Output::sources`]), given what [`Reveal::finish`] returned for it.
    pub fn provenance(
        &self,
        canvas: usize,
        deferred: &[blocks::Deferred],
    ) -> Option<(i64, i64, usize, usize, Vec<i32>)> {
        let c = &self.canvases[canvas];
        let (cons, out) = (c.consensus.as_ref()?, c.output.as_ref()?);
        let g = cons.grid;
        Some((g.gx, g.gy, g.bw, g.bh, out.sources(cons, deferred)))
    }

    pub fn summary(&self) -> Summary {
        let mut s = Summary {
            objects: self
                .layers
                .iter()
                .filter_map(|l| l.model.as_ref())
                .map(|m| m.objects.len())
                .sum(),
            ..Default::default()
        };
        for c in &self.canvases {
            if let Some(out) = &c.output {
                s.components += out.components.len();
                for k in &out.kind {
                    match k {
                        blocks::Kind::Coherent | blocks::Kind::Edge => s.coherent += 1,
                        blocks::Kind::Component => s.component_blocks += 1,
                        blocks::Kind::Provisional => s.provisional += 1,
                        blocks::Kind::Fallback => s.fallback += 1,
                        blocks::Kind::None => {}
                    }
                }
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::{admitted, canvas_bytes, layer_bytes, Decision, Pass, Reveal};
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    // Bytes this thread holds, for checking memory estimates against what the code really allocates. Per thread, so
    // tests running alongside do not count; every allocation in this test binary goes through it.
    thread_local! {
        static LIVE: Cell<isize> = const { Cell::new(0) };
    }
    struct Counting;
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = LIVE.try_with(|l| l.set(l.get() + layout.size() as isize));
            System.alloc(layout)
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let _ = LIVE.try_with(|l| l.set(l.get() + layout.size() as isize));
            System.alloc_zeroed(layout)
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            let _ = LIVE.try_with(|l| l.set(l.get() - layout.size() as isize));
            System.dealloc(ptr, layout)
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 {
            let _ = LIVE.try_with(|l| l.set(l.get() + new as isize - layout.size() as isize));
            System.realloc(ptr, layout, new)
        }
    }
    #[global_allocator]
    static ALLOCATOR: Counting = Counting;
    fn live() -> isize {
        LIVE.with(|l| l.get())
    }

    // Failure cases for the memory estimates the adapter checks before a reveal (a run with dozens of fragment
    // canvases needed 3 GB here and aborted the threaded core at its 2 GB ceiling): an estimate below what a
    // canvas or layer really holds through the passes, at any size or grid phase; a fallback estimate below the
    // write pass's fallback state when no block was ever seen clean (the most there can be).
    #[test]
    fn the_estimates_cover_what_the_reveal_holds() {
        for (x, y, w, h) in [(0, 0, 320, 240), (-7, 13, 3001, 2002), (5, -3, 17, 4099)] {
            let before = live();
            let mut r = Reveal::new(w, h, 10.0);
            r.add_layer(0, 0, w, h, 0);
            r.add_canvas(x, y, w, h);
            r.begin(Pass::Learn);
            r.begin(Pass::Agree);
            r.begin(Pass::Relearn);
            let fallback = r.fallback_bytes();
            r.begin(Pass::Write);
            let held = (live() - before) as usize;
            let estimate = canvas_bytes(w, h) + layer_bytes(w, h) + fallback;
            assert!(
                held <= estimate,
                "{w}x{h}: holds {held} bytes, estimated {estimate}"
            );
            // Nothing was observed, so every block falls back.
            assert!(fallback > 0, "{w}x{h}");
            drop(r);
        }
        // Not so far above real use that an ordinary recording would be refused: the reveal measured 5.7 bytes per
        // canvas pixel over the 87 fragment canvases of a 3K recording, fallback state included.
        let per_pixel = canvas_bytes(3001, 2002) as f64 / (3001.0 * 2002.0);
        assert!(
            (4.0..7.0).contains(&per_pixel),
            "{per_pixel} bytes per canvas pixel"
        );
    }

    fn d(layer: usize, canvas: usize, x: i64, y: i64) -> Decision {
        Decision {
            layer,
            canvas,
            x,
            y,
            occlusions: Vec::new(),
        }
    }

    /// Frames of `(decision, blind)`; returns which decisions count, frame by frame.
    fn admit(plans: &[&[(Decision, bool)]]) -> Vec<Vec<bool>> {
        let plans: Vec<Vec<(Decision, bool)>> = plans.iter().map(|p| p.to_vec()).collect();
        admitted(&plans)
    }

    #[test]
    fn tracked_decisions_always_count() {
        let got = admit(&[
            &[(d(0, 0, 0, 0), false)],
            &[(d(0, 0, 0, 40), false)],
            &[(d(0, 0, 0, 80), false)],
        ]);
        assert_eq!(got, vec![vec![true], vec![true], vec![true]]);
    }

    #[test]
    fn blind_frames_of_a_still_layer_count_at_its_pose() {
        // b's floating-button corner: blind before and after the frames it is tracked in, all at one pose.
        let got = admit(&[
            &[(d(1, 0, 0, 0), true)],
            &[(d(1, 0, 0, 0), false)],
            &[(d(1, 0, 0, 0), false)],
            &[(d(1, 0, 0, 0), true)],
            &[(d(1, 0, 0, 0), true)],
        ]);
        assert_eq!(got, vec![vec![true]; 5]);
    }

    #[test]
    fn a_blind_frame_at_another_pose_does_not_count() {
        let got = admit(&[
            &[(d(0, 0, 5, 5), false)],
            &[(d(0, 0, 5, 6), true)],
            &[(d(0, 1, 5, 5), true)],
        ]);
        assert_eq!(got, vec![vec![true], vec![false], vec![false]]);
    }

    #[test]
    fn blind_frames_of_a_layer_that_moved_do_not_count() {
        // A textureless stretch of a scrolling layer: the held pose may be wrong.
        let got = admit(&[
            &[(d(0, 0, 0, 0), false)],
            &[(d(0, 0, 0, 30), false)],
            &[(d(0, 0, 0, 30), true)],
            &[(d(0, 0, 0, 30), true)],
        ]);
        assert_eq!(got, vec![vec![true], vec![true], vec![false], vec![false]]);
    }

    #[test]
    fn blind_frames_of_a_layer_never_tracked_do_not_count() {
        let got = admit(&[&[(d(0, 0, 0, 0), true)], &[(d(0, 0, 0, 0), true)]]);
        assert_eq!(got, vec![vec![false], vec![false]]);
    }

    #[test]
    fn each_layer_is_judged_on_its_own() {
        let got = admit(&[
            &[(d(0, 0, 0, 0), false), (d(1, 1, 0, 0), false)],
            &[(d(0, 0, 0, 50), false), (d(1, 1, 0, 0), true)],
            &[(d(0, 0, 0, 50), true), (d(1, 1, 0, 0), true)],
        ]);
        assert_eq!(
            got,
            vec![vec![true, true], vec![true, true], vec![false, true]]
        );
    }
}
