//! Block-level selection on the world-aligned 16×16 grid (the compositor's quality blocks). What stays resident
//! per canvas is a few hundred bytes per block, so a canvas of any size fits without paging; pixels are only
//! ever copied from one decoded frame into the output.
//!
//! [`Consensus`] (pass 2): every whole-block view votes with its signature (the block's 8×8 grid of 2×2 cell
//! means) in a tolerant Boyer–Moore majority within the best tier seen. One clean sighting beats any number of
//! covered ones, a passing cursor is outvoted, and a tie goes to the later view (content that loads or fades
//! settles in its final state). The signatures are also the reference of the second statistics pass.
//!
//! [`Output`] (pass 4): a block takes the first frame that saw it wholly clean, away from the layer's edge, and
//! agreeing with the consensus (the most central such view when every one was near the edge);
//! a dynamic component (blocks whose clean views structurally disagree) takes, once some frame covers nearly all
//! of it, the latest such frame; a block with no clean agreeing view keeps the compositor's pixels unless a view
//! of a better tier contradicts them.

use super::locate::TierMap;
use super::stats::CellRef;
use super::{Footprint, Frame, BLOCK, CELL, TIER_CLEAN, TIER_VEIL};

/// Cells per block side and per block.
pub const SIDE: usize = BLOCK / CELL;
pub const CELLS: usize = SIDE * SIDE;
// `view` reads each cell as two pixels from each of two rows.
const _: () = assert!(CELL == 2);
const PIXELS: usize = BLOCK * BLOCK;

#[derive(Clone, Copy)]
pub struct BlockVote {
    /// Best tier seen whole (-1 = never).
    pub tier: i8,
    pub clean_views: u16,
    pub changed_views: u16,
}

/// The world-aligned block grid covering one canvas.
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    /// World block index of the grid's first block.
    pub gx: i64,
    pub gy: i64,
    pub bw: usize,
    pub bh: usize,
}

impl Grid {
    /// Blocks covering the world rectangle (x, y, width, height).
    pub fn covering(x: i64, y: i64, width: usize, height: usize) -> Self {
        let b = BLOCK as i64;
        let (gx, gy) = (x.div_euclid(b), y.div_euclid(b));
        let (gx1, gy1) = (
            (x + width as i64 + b - 1).div_euclid(b),
            (y + height as i64 + b - 1).div_euclid(b),
        );
        Self {
            gx,
            gy,
            bw: (gx1 - gx).max(0) as usize,
            bh: (gy1 - gy).max(0) as usize,
        }
    }

    /// World origin of block `b`.
    #[inline]
    pub fn origin(&self, b: usize) -> (i64, i64) {
        (
            (self.gx + (b % self.bw) as i64) * BLOCK as i64,
            (self.gy + (b / self.bw) as i64) * BLOCK as i64,
        )
    }

    /// Blocks whose whole area may lie in a footprint at `pose`: (bx0, by0, bx1, by1), half-open.
    fn span(&self, footprint: &Footprint<'_>, pose: (i64, i64)) -> (usize, usize, usize, usize) {
        let b = BLOCK as i64;
        let (x0, y0) = (footprint.x + pose.0, footprint.y + pose.1);
        let (x1, y1) = (x0 + footprint.width as i64, y0 + footprint.height as i64);
        let clamp = |v: i64, n: usize| v.clamp(0, n as i64) as usize;
        (
            clamp((x0 + b - 1).div_euclid(b) - self.gx, self.bw),
            clamp((y0 + b - 1).div_euclid(b) - self.gy, self.bh),
            clamp(x1.div_euclid(b) - self.gx, self.bw),
            clamp(y1.div_euclid(b) - self.gy, self.bh),
        )
    }
}

/// Signature of the block at world (wx0, wy0) as seen in `frame` at `pose`, and its tier (worst cell). `None` when
/// any pixel of the block is outside the footprint. The footprint mask and the tier map share the layer rectangle's
/// origin, so both are read by row with one index each.
fn view(
    frame: &Frame<'_>,
    footprint: &Footprint<'_>,
    tiers: &TierMap<'_>,
    pose: (i64, i64),
    wx0: i64,
    wy0: i64,
    out: &mut [[u8; 3]; CELLS],
) -> Option<u8> {
    let (sx0, sy0) = (wx0 - pose.0, wy0 - pose.1);
    let (lx0, ly0) = (sx0 - footprint.x, sy0 - footprint.y);
    let b = BLOCK as i64;
    if sx0 < 0 || sy0 < 0 || sx0 + b > frame.width as i64 || sy0 + b > frame.height as i64 {
        return None;
    }
    if lx0 < 0 || ly0 < 0 || lx0 + b > footprint.width as i64 || ly0 + b > footprint.height as i64 {
        return None;
    }
    debug_assert_eq!((tiers.x, tiers.y), (footprint.x, footprint.y));
    let (w, fw) = (frame.width, footprint.width);
    let (lx0, ly0, sx0, sy0) = (lx0 as usize, ly0 as usize, sx0 as usize, sy0 as usize);
    if (0..BLOCK).any(|yy| footprint.mask[(ly0 + yy) * fw + lx0..][..BLOCK].contains(&0)) {
        return None;
    }
    // Each 2×2 cell straight from its two rows: the same sums and rounding as accumulating pixel by pixel.
    let q = (CELL * CELL) as u32;
    for (cy, cells) in out.chunks_exact_mut(SIDE).enumerate() {
        let top = &frame.rgba[((sy0 + cy * CELL) * w + sx0) * 4..][..BLOCK * 4];
        let bottom = &frame.rgba[((sy0 + cy * CELL + 1) * w + sx0) * 4..][..BLOCK * 4];
        for ((cell, t), b) in cells
            .iter_mut()
            .zip(top.chunks_exact(8))
            .zip(bottom.chunks_exact(8))
        {
            let mean = |c: usize| {
                ((t[c] as u32 + t[c + 4] as u32 + b[c] as u32 + b[c + 4] as u32 + q / 2) / q) as u8
            };
            *cell = [mean(0), mean(1), mean(2)];
        }
    }
    // The block's pixels fall in these tier cells (one more per axis when the block starts mid-cell).
    let mut worst = TIER_CLEAN;
    for ty in ly0 / CELL..=(ly0 + BLOCK - 1) / CELL {
        let row = &tiers.tier[ty * tiers.cw..(ty + 1) * tiers.cw];
        for &t in &row[lx0 / CELL..=(lx0 + BLOCK - 1) / CELL] {
            worst = worst.min(t);
        }
    }
    Some(worst)
}

/// A cell whose luma is this far off is an outlier: a transient (a cursor tip), not codec noise. Luma is decoded at
/// full resolution, so chroma subsampling, which shifts the colour of a sharp edge with the pose's parity, never
/// makes an outlier.
const OUTLIER: i32 = 48;

#[inline]
fn cell_luma(c: [u8; 3]) -> i32 {
    super::luma(c[0], c[1], c[2]) as i32
}

/// (mean |Δ| per channel, |mean signed Δ| per channel, cells whose luma is off by more than [`OUTLIER`]).
fn compare(a: &[[u8; 3]], b: &[[u8; 3]]) -> (u32, u32, u32) {
    let (mut sum, mut bias, mut off) = (0u32, 0i32, 0u32);
    for (p, q) in a.iter().zip(b) {
        for c in 0..3 {
            let d = p[c] as i32 - q[c] as i32;
            sum += d.unsigned_abs();
            bias += d;
        }
        off += ((cell_luma(*p) - cell_luma(*q)).abs() > OUTLIER) as u32;
    }
    let n = (a.len() * 3) as u32;
    (sum / n, bias.unsigned_abs() / n, off)
}

/// Two views agree when they differ by no more than codec noise on average, without a systematic shift (a
/// dimming, a highlight), and in at most a couple of cells (codec ringing at a sharp edge).
#[inline]
fn agrees(d: (u32, u32, u32), tau: i32) -> bool {
    d.0 <= (tau as u32 / 4).max(2) && d.1 <= 2 && d.2 <= 2
}

/// Agreement with no outlying cell at all: a view that may still carry a cursor tip in a couple of cells only
/// ever agrees loosely.
#[inline]
fn agrees_strictly(d: (u32, u32, u32), tau: i32) -> bool {
    agrees(d, tau) && d.2 == 0
}

/// A whole clean view counts as a structural change (dynamic content) beyond this mean or shift.
const CHANGED: u32 = 8;
const SHIFTED: u32 = 3;

/// Per canvas: consensus signatures and vote state. Each cell keeps its own majority, so a transient that touches
/// only a few cells of an otherwise agreeing view (a cursor tip) is outvoted there.
pub struct Consensus {
    pub grid: Grid,
    pub sig: Vec<[u8; 3]>,
    count: Vec<i16>,
    pub vote: Vec<BlockVote>,
}

impl Consensus {
    pub fn new(grid: Grid) -> Self {
        let n = grid.bw * grid.bh;
        Self {
            grid,
            sig: vec![[0; 3]; n * CELLS],
            count: vec![0; n * CELLS],
            vote: vec![
                BlockVote {
                    tier: -1,
                    clean_views: 0,
                    changed_views: 0
                };
                n
            ],
        }
    }

    /// One vote (a distinct pose, its last frame).
    pub fn observe(
        &mut self,
        frame: &Frame<'_>,
        footprint: &Footprint<'_>,
        tiers: &TierMap<'_>,
        pose: (i64, i64),
    ) {
        let (bx0, by0, bx1, by1) = self.grid.span(footprint, pose);
        if bx1 <= bx0 || by1 <= by0 {
            return;
        }
        let rows = by1 - by0;
        let chunks = crate::kernels::pool::chunks_for(rows * (bx1 - bx0), 64);
        let grid = self.grid;
        let (sig_p, count_p, vote_p) = (
            crate::kernels::pool::SyncPtr(self.sig.as_mut_ptr()),
            crate::kernels::pool::SyncPtr(self.count.as_mut_ptr()),
            crate::kernels::pool::SyncPtr(self.vote.as_mut_ptr()),
        );
        crate::kernels::pool::par_for(chunks, |k| {
            let mut sig = [[0u8; 3]; CELLS];
            for by in by0 + crate::kernels::pool::split(rows, chunks, k)
                ..by0 + crate::kernels::pool::split(rows, chunks, k + 1)
            {
                for bx in bx0..bx1 {
                    let b = by * grid.bw + bx;
                    let (wx0, wy0) = grid.origin(b);
                    let Some(tier) = view(frame, footprint, tiers, pose, wx0, wy0, &mut sig) else {
                        continue;
                    };
                    // SAFETY: chunk `k` owns block rows by0+split(k)..by0+split(k+1); each block's state is its own.
                    let (cand, count, v) = unsafe {
                        (
                            std::slice::from_raw_parts_mut(sig_p.get().add(b * CELLS), CELLS),
                            std::slice::from_raw_parts_mut(count_p.get().add(b * CELLS), CELLS),
                            &mut *vote_p.get().add(b),
                        )
                    };
                    vote(cand, count, v, &sig, tier);
                }
            }
        });
    }
}

/// One whole-block view's vote.
fn vote(
    cand: &mut [[u8; 3]],
    count: &mut [i16],
    v: &mut BlockVote,
    sig: &[[u8; 3]; CELLS],
    tier: u8,
) {
    if tier == TIER_CLEAN {
        if v.tier == TIER_CLEAN as i8 {
            let d = compare(sig, cand);
            if d.0 > CHANGED || d.1 > SHIFTED {
                v.changed_views = v.changed_views.saturating_add(1);
            }
        }
        v.clean_views = v.clean_views.saturating_add(1);
    }
    let t = tier as i8;
    if t > v.tier {
        cand.copy_from_slice(sig);
        count.fill(1);
        v.tier = t;
    } else if t == v.tier {
        // Majority per cell at the outlier threshold: codec-phase variants never flip a cell, so the signature stays
        // one coherent view except where a transient was outvoted. A tie goes to the later view.
        for k in 0..CELLS {
            if (cell_luma(sig[k]) - cell_luma(cand[k])).abs() <= OUTLIER {
                count[k] = count[k].saturating_add(1);
            } else if count[k] <= 1 {
                cand[k] = sig[k];
                count[k] = 1;
            } else {
                count[k] -= 1;
            }
        }
    }
}

impl CellRef for Consensus {
    #[inline]
    fn cell(&self, cx: i64, cy: i64) -> Option<[u8; 3]> {
        let (wx, wy) = (cx * CELL as i64, cy * CELL as i64);
        let (bx, by) = (
            wx.div_euclid(BLOCK as i64) - self.grid.gx,
            wy.div_euclid(BLOCK as i64) - self.grid.gy,
        );
        if bx < 0 || by < 0 || bx >= self.grid.bw as i64 || by >= self.grid.bh as i64 {
            return None;
        }
        let b = by as usize * self.grid.bw + bx as usize;
        if self.vote[b].tier < 0 {
            return None;
        }
        let (ix, iy) = (
            (wx.rem_euclid(BLOCK as i64) as usize) / CELL,
            (wy.rem_euclid(BLOCK as i64) as usize) / CELL,
        );
        Some(self.sig[b * CELLS + iy * SIDE + ix])
    }
    fn cells(&self) -> (i64, i64, i64, i64) {
        let s = SIDE as i64;
        (
            self.grid.gx * s,
            self.grid.gy * s,
            (self.grid.gx + self.grid.bw as i64) * s,
            (self.grid.gy + self.grid.bh as i64) * s,
        )
    }
}

/// A connected set of dynamic blocks (plus one block of margin) that must come from one frame.
pub struct Component {
    pub bx: usize,
    pub by: usize,
    pub bw: usize,
    pub bh: usize,
    pub mask: Vec<bool>,
    /// Blocks that really change (the rest is the static margin, which a frame must show as the consensus does).
    pub dynamic: Vec<bool>,
    /// Best cover so far: (covers nearly all, untainted, latest frame), or (0, 0, whole blocks covered).
    pub best: Option<(usize, usize, usize)>,
}

/// Blocks whose clean views structurally disagree often enough are dynamic.
pub fn components(c: &Consensus) -> Vec<Component> {
    let (bw, bh) = (c.grid.bw, c.grid.bh);
    let dynamic: Vec<bool> = c
        .vote
        .iter()
        .map(|v| v.changed_views >= 2 && v.changed_views as u32 * 4 >= v.clean_views as u32)
        .collect();
    let mut grown = vec![false; bw * bh];
    for y in 0..bh {
        for x in 0..bw {
            if dynamic[y * bw + x] {
                for yy in y.saturating_sub(1)..=(y + 1).min(bh - 1) {
                    for xx in x.saturating_sub(1)..=(x + 1).min(bw - 1) {
                        grown[yy * bw + xx] = true;
                    }
                }
            }
        }
    }
    let mut label = vec![0usize; bw * bh];
    let mut out = Vec::new();
    for s in 0..bw * bh {
        if !grown[s] || label[s] != 0 {
            continue;
        }
        let id = out.len() + 1;
        let mut stack = vec![s];
        label[s] = id;
        let mut members = Vec::new();
        while let Some(i) = stack.pop() {
            members.push(i);
            let (x, y) = (i % bw, i / bw);
            for yy in y.saturating_sub(1)..=(y + 1).min(bh - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(bw - 1) {
                    let j = yy * bw + xx;
                    if grown[j] && label[j] == 0 {
                        label[j] = id;
                        stack.push(j);
                    }
                }
            }
        }
        let x0 = members.iter().map(|&i| i % bw).min().unwrap();
        let x1 = members.iter().map(|&i| i % bw).max().unwrap();
        let y0 = members.iter().map(|&i| i / bw).min().unwrap();
        let y1 = members.iter().map(|&i| i / bw).max().unwrap();
        let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
        let mut mask = vec![false; cw * ch];
        let mut changing = vec![false; cw * ch];
        for &i in &members {
            let k = (i / bw - y0) * cw + (i % bw - x0);
            mask[k] = true;
            changing[k] = dynamic[i];
        }
        out.push(Component {
            bx: x0,
            by: y0,
            bw: cw,
            bh: ch,
            mask,
            dynamic: changing,
            best: None,
        });
    }
    out
}

/// How a block's output was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// Not decided: the compositor's pixels stand.
    None = 0,
    /// A whole clean view agreeing strictly with the consensus, at least [`CENTRAL`] pixels inside the layer.
    Coherent = 1,
    /// One frame for a dynamic component.
    Component = 2,
    /// Best-tier whole view held aside; written by [`Output::finish`] unless the compositor's block is as good.
    Provisional = 3,
    /// Never seen whole: per-pixel best-tier majority, written by [`Output::finish`] where a better tier
    /// contradicts the compositor's pixel.
    Fallback = 4,
    /// The best clean, agreeing view short of [`Kind::Coherent`] (near the layer's edge, or agreeing only
    /// loosely), held aside until a better one arrives or the pass ends.
    Edge = 5,
}

/// Distance from the layer's edge (pixels) from which a clean agreeing view is final. Views nearer the edge are
/// slightly degraded (rounded corners, container shadows, the codec at a fast-moving edge).
pub const CENTRAL: i64 = 48;

/// Copy of one block from a vote frame into the output: world block (gx, gy) from screen (sx, sy).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockWrite {
    /// Canvas slot (set by the run driver).
    pub canvas: u32,
    pub gx: i64,
    pub gy: i64,
    pub sx: i64,
    pub sy: i64,
    pub frame: u32,
    pub kind: Kind,
}

/// A block written at the end: RGBA with alpha 0 on pixels that keep the compositor's value.
/// [`Output::sources`]: the compositor's pixels stand.
pub const UNTOUCHED: i32 = -1;
/// [`Output::sources`]: per-pixel values that may come from several frames.
pub const MIXED: i32 = -2;

pub struct Deferred {
    pub gx: i64,
    pub gy: i64,
    pub frame: u32,
    pub kind: Kind,
    pub rgba: Box<[u8; PIXELS * 4]>,
}

struct Fallback {
    cand: [[u8; 3]; PIXELS],
    count: [i16; PIXELS],
    tier: [i8; PIXELS],
    /// The compositor's pixels (alpha 0 = uncovered) and the best tier of an observation showing them.
    main: [[u8; 4]; PIXELS],
    main_tier: [i8; PIXELS],
}

/// A whole-block view's verdict, decided in parallel and applied in block order.
#[derive(Clone, Copy, Default)]
struct Act {
    seen: bool,
    tier: u8,
    strict: bool,
    loose: bool,
    inset: i16,
    /// The view shows what the compositor already holds.
    main: bool,
}

/// One partly visible view of a fallback block, per pixel: best tier, tolerant majority within it (a tie to the
/// later view, whose value is written: the most settled one), and the best tier of any observation showing the
/// compositor's own pixel.
fn fallback_view(
    fb: &mut Fallback,
    frame: &Frame<'_>,
    footprint: &Footprint<'_>,
    tiers: &TierMap<'_>,
    pose: (i64, i64),
    origin: (i64, i64),
    tau: i32,
) {
    let (w, near) = (frame.width, (tau / 2).max(2));
    for j in 0..PIXELS {
        let (sx, sy) = (
            origin.0 + (j % BLOCK) as i64 - pose.0,
            origin.1 + (j / BLOCK) as i64 - pose.1,
        );
        if sx < 0
            || sy < 0
            || sx >= w as i64
            || sy >= frame.height as i64
            || !footprint.contains(sx, sy)
        {
            continue;
        }
        let fi = (sy as usize * w + sx as usize) * 4;
        let obs = [frame.rgba[fi], frame.rgba[fi + 1], frame.rgba[fi + 2]];
        let t = tiers.at(sx, sy) as i8;
        let m = fb.main[j];
        if m[3] == 255 && (0..3).all(|k| (obs[k] as i32 - m[k] as i32).abs() <= near) {
            fb.main_tier[j] = fb.main_tier[j].max(t);
        }
        if t > fb.tier[j] {
            fb.cand[j] = obs;
            fb.count[j] = 1;
            fb.tier[j] = t;
        } else if t == fb.tier[j] {
            if (0..3).all(|k| (obs[k] as i32 - fb.cand[j][k] as i32).abs() <= tau) {
                fb.cand[j] = obs;
                fb.count[j] = fb.count[j].saturating_add(1);
            } else if fb.count[j] <= 1 {
                fb.cand[j] = obs;
                fb.count[j] = 1;
            } else {
                fb.count[j] -= 1;
            }
        }
    }
}

/// Pass-4 state per canvas.
pub struct Output {
    acts: Vec<Act>,
    pub kind: Vec<Kind>,
    pub frame: Vec<i32>,
    component: Vec<i32>,
    provisional: Vec<i8>,
    /// Rank of the held view: (tier, strictly agreeing, loosely agreeing, inset up to [`CENTRAL`]).
    rank: Vec<(i8, bool, bool, i16)>,
    held: Vec<Option<Box<[u8; PIXELS * 3]>>>,
    main_tier: Vec<i8>,
    fallback: Vec<Option<Box<Fallback>>>,
    pub components: Vec<Component>,
}

/// Bytes a consensus holds per block (signatures and counts of its cells, and its vote).
pub const CONSENSUS_BLOCK_BYTES: usize = CELLS
    * (std::mem::size_of::<[u8; 3]>() + std::mem::size_of::<i16>())
    + std::mem::size_of::<BlockVote>();
/// Bytes an output holds per block, counting a held view for every block (the most the write pass can hold); its
/// per-pixel fallback state is [`FALLBACK_BYTES`] per block that needs it.
pub const OUTPUT_BLOCK_BYTES: usize = std::mem::size_of::<Act>()
    + std::mem::size_of::<Kind>()
    + 2 * std::mem::size_of::<i32>()
    + std::mem::size_of::<i8>()
    + std::mem::size_of::<(i8, bool, bool, i16)>()
    + std::mem::size_of::<Option<Box<[u8; PIXELS * 3]>>>()
    + PIXELS * 3
    + std::mem::size_of::<i8>()
    + std::mem::size_of::<Option<Box<Fallback>>>();
/// Bytes of one block's per-pixel fallback state.
pub const FALLBACK_BYTES: usize = std::mem::size_of::<Fallback>();

impl Consensus {
    /// Blocks no clean view covered whole: an upper bound on the blocks [`Output::new`] gives fallback state (it also
    /// spares those inside a component).
    pub fn unseen_blocks(&self) -> usize {
        self.vote.iter().filter(|v| v.clean_views == 0).count()
    }
}

impl Output {
    /// Blocks never seen whole and clean in pass 2 get per-pixel fallback state; their compositor pixels must be
    /// supplied with [`Output::set_main`] before the first [`Output::emit`].
    pub fn new(c: &Consensus, components: Vec<Component>) -> Self {
        let n = c.grid.bw * c.grid.bh;
        let mut component = vec![-1; n];
        for (k, comp) in components.iter().enumerate() {
            for yy in 0..comp.bh {
                for xx in 0..comp.bw {
                    if comp.mask[yy * comp.bw + xx] {
                        component[(comp.by + yy) * c.grid.bw + comp.bx + xx] = k as i32;
                    }
                }
            }
        }
        let fallback = c
            .vote
            .iter()
            .zip(&component)
            .map(|(v, &k)| {
                (v.clean_views == 0 && k < 0).then(|| {
                    Box::new(Fallback {
                        cand: [[0; 3]; PIXELS],
                        count: [0; PIXELS],
                        tier: [-1; PIXELS],
                        main: [[0; 4]; PIXELS],
                        main_tier: [-1; PIXELS],
                    })
                })
            })
            .collect();
        Self {
            acts: vec![Act::default(); n],
            kind: vec![Kind::None; n],
            frame: vec![-1; n],
            component,
            provisional: vec![-1; n],
            rank: vec![(-1, false, false, -1); n],
            held: (0..n).map(|_| None).collect(),
            main_tier: vec![-1; n],
            fallback,
            components,
        }
    }

    /// Blocks that need the compositor's pixels (fallback blocks), as indices into the grid.
    pub fn fallback_blocks(&self) -> Vec<usize> {
        self.fallback
            .iter()
            .enumerate()
            .filter(|(_, f)| f.is_some())
            .map(|(b, _)| b)
            .collect()
    }

    /// The compositor's RGBA for fallback block `b` (alpha 255 = covered).
    pub fn set_main(&mut self, b: usize, rgba: &[u8]) {
        if let Some(fb) = self.fallback.get_mut(b).and_then(|f| f.as_mut()) {
            for (j, px) in rgba.chunks_exact(4).take(PIXELS).enumerate() {
                fb.main[j] = [px[0], px[1], px[2], px[3]];
            }
        }
    }

    /// One vote of pass 4. Blocks to copy from this frame are appended to `writes`; `main` is the compositor's
    /// output as cell means.
    #[allow(clippy::too_many_arguments)]
    pub fn emit(
        &mut self,
        c: &Consensus,
        frame: &Frame<'_>,
        footprint: &Footprint<'_>,
        tiers: &TierMap<'_>,
        pose: (i64, i64),
        tau: i32,
        frame_index: u32,
        main: &(dyn CellRef + Sync),
        writes: &mut Vec<BlockWrite>,
    ) {
        let grid = c.grid;
        let mut sig = [[0u8; 3]; CELLS];
        let block_write = |b: usize, kind: Kind| {
            let (wx0, wy0) = grid.origin(b);
            BlockWrite {
                canvas: 0,
                gx: grid.gx + (b % grid.bw) as i64,
                gy: grid.gy + (b / grid.bw) as i64,
                sx: wx0 - pose.0,
                sy: wy0 - pose.1,
                frame: frame_index,
                kind,
            }
        };
        // Dynamic components: once a frame covers nearly all of one, the latest such frame wins; before that the
        // widest partial cover. Blocks a cover misses keep the best earlier cover.
        for comp in self.components.iter_mut() {
            let mut covered = Vec::new();
            // A frame showing a small blob that is not there in the consensus in the component's static margin
            // carries a transient (a cursor passing over the widget's edge): it is the component's moment only
            // when no other frame covers the component.
            let mut tainted = false;
            for yy in 0..comp.bh {
                for xx in 0..comp.bw {
                    let k = yy * comp.bw + xx;
                    if !comp.mask[k] {
                        continue;
                    }
                    let b = (comp.by + yy) * grid.bw + comp.bx + xx;
                    let (wx0, wy0) = grid.origin(b);
                    if let Some(t) = view(frame, footprint, tiers, pose, wx0, wy0, &mut sig) {
                        if t >= TIER_VEIL {
                            if !comp.dynamic[k] {
                                let off = compare(&sig, &c.sig[b * CELLS..(b + 1) * CELLS]).2;
                                tainted |= (1..=CELLS as u32 * 3 / 8).contains(&off);
                            }
                            covered.push(b);
                        }
                    }
                }
            }
            if covered.is_empty() {
                continue;
            }
            let blocks = comp.mask.iter().filter(|&&m| m).count();
            let eligible = covered.len() * 10 >= blocks * 9;
            // Among frames that cover nearly all of it, an untainted one beats a tainted one, then the latest.
            let score = if eligible {
                (1, !tainted as usize, frame_index as usize)
            } else {
                (0, 0, covered.len())
            };
            if comp.best.is_some_and(|best| best > score) {
                continue;
            }
            comp.best = Some(score);
            for b in covered {
                self.kind[b] = Kind::Component;
                self.frame[b] = frame_index as i32;
                writes.push(block_write(b, Kind::Component));
            }
        }
        let (bx0, by0, bx1, by1) = grid.span(footprint, pose);
        let w = frame.width;
        // Fallback blocks can be partly in view, so they are visited over the footprint's whole block range.
        let (fx0, fy0, fx1, fy1) = {
            let b = BLOCK as i64;
            let (x0, y0) = (footprint.x + pose.0, footprint.y + pose.1);
            let (x1, y1) = (x0 + footprint.width as i64, y0 + footprint.height as i64);
            let clamp = |v: i64, n: usize| v.clamp(0, n as i64) as usize;
            (
                clamp(x0.div_euclid(b) - grid.gx, grid.bw),
                clamp(y0.div_euclid(b) - grid.gy, grid.bh),
                clamp((x1 + b - 1).div_euclid(b) - grid.gx, grid.bw),
                clamp((y1 + b - 1).div_euclid(b) - grid.gy, grid.bh),
            )
        };
        // The fallback slots hold boxes (not `Copy`), so their base travels as an address.
        let (kind_p, fallback_base) = (
            crate::kernels::pool::SyncPtr(self.kind.as_mut_ptr()),
            self.fallback.as_mut_ptr() as usize,
        );
        if fy1 > fy0 && fx1 > fx0 {
            let rows = fy1 - fy0;
            let chunks = crate::kernels::pool::chunks_for(rows * (fx1 - fx0), 64);
            crate::kernels::pool::par_for(chunks, |k| {
                for by in fy0 + crate::kernels::pool::split(rows, chunks, k)
                    ..fy0 + crate::kernels::pool::split(rows, chunks, k + 1)
                {
                    for bx in fx0..fx1 {
                        let b = by * grid.bw + bx;
                        // SAFETY: chunk `k` owns these block rows; each block's fallback state is its own.
                        let (slot, kind) = unsafe {
                            (
                                &mut *(fallback_base as *mut Option<Box<Fallback>>).add(b),
                                &mut *kind_p.get().add(b),
                            )
                        };
                        let Some(fb) = slot.as_mut() else { continue };
                        *kind = Kind::Fallback;
                        fallback_view(fb, frame, footprint, tiers, pose, grid.origin(b), tau);
                    }
                }
            });
        }
        if by1 <= by0 || bx1 <= bx0 {
            return;
        }
        // Decide every whole block in parallel (no allocation in the pool), then apply the decisions in block order.
        let rows = by1 - by0;
        let chunks = crate::kernels::pool::chunks_for(rows * (bx1 - bx0), 64);
        let acts = crate::kernels::pool::SyncPtr(self.acts.as_mut_ptr());
        let (component, fallback, kind) = (&self.component, &self.fallback, &self.kind);
        crate::kernels::pool::par_for(chunks, |k| {
            let mut sig = [[0u8; 3]; CELLS];
            for by in by0 + crate::kernels::pool::split(rows, chunks, k)
                ..by0 + crate::kernels::pool::split(rows, chunks, k + 1)
            {
                for bx in bx0..bx1 {
                    let b = by * grid.bw + bx;
                    // SAFETY: chunk `k` owns these block rows' decision slots.
                    let act = unsafe { &mut *acts.get().add(b) };
                    *act = Act::default();
                    if component[b] >= 0 || fallback[b].is_some() || kind[b] == Kind::Coherent {
                        continue;
                    }
                    let (wx0, wy0) = grid.origin(b);
                    let Some(tier) = view(frame, footprint, tiers, pose, wx0, wy0, &mut sig) else {
                        continue;
                    };
                    let d = compare(&sig, &c.sig[b * CELLS..(b + 1) * CELLS]);
                    let (sx0, sy0) = (wx0 - pose.0, wy0 - pose.1);
                    let inset = (sx0 - footprint.x)
                        .min(sy0 - footprint.y)
                        .min(footprint.x + footprint.width as i64 - sx0 - BLOCK as i64)
                        .min(footprint.y + footprint.height as i64 - sy0 - BLOCK as i64);
                    // Does this view show what the compositor already holds?
                    let (cx0, cy0) = (wx0.div_euclid(CELL as i64), wy0.div_euclid(CELL as i64));
                    let mut msig = [[0u8; 3]; CELLS];
                    let known = (0..CELLS).all(|k| {
                        match main.cell(cx0 + (k % SIDE) as i64, cy0 + (k / SIDE) as i64) {
                            Some(v) => {
                                msig[k] = v;
                                true
                            }
                            None => false,
                        }
                    });
                    *act = Act {
                        seen: true,
                        tier,
                        strict: agrees_strictly(d, tau),
                        loose: agrees(d, tau),
                        inset: inset.min(CENTRAL) as i16,
                        main: known && agrees(compare(&sig, &msig), tau),
                    };
                }
            }
        });
        for by in by0..by1 {
            for bx in bx0..bx1 {
                let b = by * grid.bw + bx;
                let a = self.acts[b];
                if !a.seen {
                    continue;
                }
                if a.tier == TIER_CLEAN && a.strict && a.inset >= CENTRAL as i16 {
                    self.kind[b] = Kind::Coherent;
                    self.frame[b] = frame_index as i32;
                    self.held[b] = None;
                    writes.push(block_write(b, Kind::Coherent));
                    continue;
                }
                if a.main {
                    self.main_tier[b] = self.main_tier[b].max(a.tier as i8);
                }
                // Hold the best view so far; a later view wins a tie (the more settled state).
                let rank = (
                    a.tier as i8,
                    a.tier == TIER_CLEAN && a.strict,
                    a.tier == TIER_CLEAN && a.loose,
                    a.inset,
                );
                if rank >= self.rank[b] {
                    let held = self.held[b].get_or_insert_with(|| Box::new([0u8; PIXELS * 3]));
                    let (wx0, wy0) = grid.origin(b);
                    for j in 0..PIXELS {
                        let (sx, sy) = (
                            wx0 + (j % BLOCK) as i64 - pose.0,
                            wy0 + (j / BLOCK) as i64 - pose.1,
                        );
                        let fi = (sy as usize * w + sx as usize) * 4;
                        held[j * 3..j * 3 + 3].copy_from_slice(&frame.rgba[fi..fi + 3]);
                    }
                    self.rank[b] = rank;
                    self.kind[b] = if rank.2 {
                        Kind::Edge
                    } else {
                        Kind::Provisional
                    };
                    self.provisional[b] = a.tier as i8;
                    self.frame[b] = frame_index as i32;
                }
            }
        }
    }

    /// Where each block's pixels now come from, given the blocks [`Output::finish`] returned: the frame a whole
    /// block was copied from, [`MIXED`] for per-pixel fallback values, [`UNTOUCHED`] where the compositor's pixels
    /// stand.
    pub fn sources(&self, c: &Consensus, deferred: &[Deferred]) -> Vec<i32> {
        let grid = c.grid;
        let mut out: Vec<i32> = self
            .kind
            .iter()
            .zip(&self.frame)
            .map(|(k, &f)| match k {
                Kind::Coherent | Kind::Component => f,
                _ => UNTOUCHED,
            })
            .collect();
        for d in deferred {
            let b = (d.gy - grid.gy) as usize * grid.bw + (d.gx - grid.gx) as usize;
            out[b] = if d.kind == Kind::Fallback {
                MIXED
            } else {
                d.frame as i32
            };
        }
        out
    }

    /// The deferred blocks: a provisional view unless a view agreeing with the compositor's block was at least as
    /// clean, and fallback pixels where a better-tier observation contradicts the compositor's pixel.
    pub fn finish(&self, c: &Consensus, tau: i32) -> Vec<Deferred> {
        let grid = c.grid;
        let near = (tau / 2).max(2);
        let mut out = Vec::new();
        for b in 0..grid.bw * grid.bh {
            let (gx, gy) = (
                grid.gx + (b % grid.bw) as i64,
                grid.gy + (b / grid.bw) as i64,
            );
            match self.kind[b] {
                Kind::Edge => {
                    let Some(h) = &self.held[b] else { continue };
                    // Agreeing with a consensus only one clean view built is no evidence: near a layer edge in a
                    // fast scroll a block is seen whole once, and that view may carry an unmodelled overlay (a
                    // scrollbar thumb). It then replaces the compositor's block only when it is cleaner.
                    if c.vote[b].clean_views < 2 && self.main_tier[b] >= self.provisional[b] {
                        continue;
                    }
                    let mut rgba = Box::new([0u8; PIXELS * 4]);
                    for j in 0..PIXELS {
                        rgba[j * 4..j * 4 + 3].copy_from_slice(&h[j * 3..j * 3 + 3]);
                        rgba[j * 4 + 3] = 255;
                    }
                    out.push(Deferred {
                        gx,
                        gy,
                        frame: self.frame[b] as u32,
                        kind: Kind::Edge,
                        rgba,
                    });
                }
                Kind::Provisional => {
                    let Some(h) = &self.held[b] else { continue };
                    if self.main_tier[b] >= self.provisional[b] {
                        continue;
                    }
                    let mut rgba = Box::new([0u8; PIXELS * 4]);
                    for j in 0..PIXELS {
                        rgba[j * 4..j * 4 + 3].copy_from_slice(&h[j * 3..j * 3 + 3]);
                        rgba[j * 4 + 3] = 255;
                    }
                    out.push(Deferred {
                        gx,
                        gy,
                        frame: self.frame[b] as u32,
                        kind: Kind::Provisional,
                        rgba,
                    });
                }
                Kind::Fallback => {
                    let Some(fb) = &self.fallback[b] else {
                        continue;
                    };
                    let mut rgba = Box::new([0u8; PIXELS * 4]);
                    let mut any = false;
                    // The block is only touched when a better-tier observation contradicts the compositor somewhere
                    // in it; then pixels that say the same take the majority's settled value too, so the rewrite
                    // stays consistent, while the compositor's pixel stands wherever an observation at least as
                    // clean shows it and the majority says otherwise.
                    let same = |j: usize| {
                        let m = fb.main[j];
                        m[3] == 255
                            && (0..3).all(|k| (fb.cand[j][k] as i32 - m[k] as i32).abs() <= near)
                    };
                    if !(0..PIXELS)
                        .any(|j| fb.tier[j] >= 0 && fb.tier[j] > fb.main_tier[j] && !same(j))
                    {
                        continue;
                    }
                    for j in 0..PIXELS {
                        if fb.tier[j] < 0 || (fb.main_tier[j] >= fb.tier[j] && !same(j)) {
                            continue;
                        }
                        rgba[j * 4..j * 4 + 3].copy_from_slice(&fb.cand[j]);
                        rgba[j * 4 + 3] = 255;
                        any = true;
                    }
                    if any {
                        out.push(Deferred {
                            gx,
                            gy,
                            frame: 0,
                            kind: Kind::Fallback,
                            rgba,
                        });
                    }
                }
                _ => {}
            }
        }
        out
    }
}
