//! Block-level selection on the world-aligned 16×16 grid (the compositor's quality blocks). What stays resident
//! per canvas is a few hundred bytes per block, so a canvas of any size fits without paging; pixels are only
//! ever copied from one decoded frame into the output.
//!
//! [`Consensus`] (pass 2): every whole-block view votes with its signature (the block's 8×8 grid of 2×2 cell
//! means) in a tolerant Boyer–Moore majority within the best tier seen. One clean sighting beats any number of
//! covered ones, a passing cursor is outvoted, and a tie goes to the later view (content that loads or fades
//! settles in its final state). The signatures are also the reference of the second statistics pass.
//!
//! [`Output`] (pass 4): a block takes a clean, central view whose agreement is supported by local reference
//! structure or a corroborated weak change. Near-edge views are held until a better observation arrives;
//! a changing object takes a complete, corroborated moment where possible. Context is assigned after finding
//! changing objects, so nearby independent objects do not become an unobservable giant component; a block with no clean agreeing view keeps the compositor's pixels unless a view
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

/// Agreement without absolute outliers or unsupported structure in an observed reference neighbourhood.
/// A weak transient on a smooth page must not become permanent just because it fits the absolute noise ceiling.
#[inline]
fn agrees_strictly(
    d: (u32, u32, u32),
    tau: i32,
    observed: &BlockSignature,
    reference: &impl CellRef,
    world: (i64, i64),
) -> bool {
    if !agrees(d, tau) || d.2 != 0 {
        return false;
    }
    // A small residual may be sampling phase at a genuine edge, but it cannot create
    // structure on a smooth page. Retain the existing absolute outlier bound and use
    // twice the mean-agreement noise floor where the reference has less contrast.
    let noise = (tau / 4).max(2);
    let quiet_limit = 2 * noise;
    if quiet_limit >= OUTLIER {
        return true;
    }
    let (cx, cy) = (
        world.0.div_euclid(CELL as i64),
        world.1.div_euclid(CELL as i64),
    );
    for (k, sample) in observed.iter().enumerate() {
        let (x, y) = (cx + (k % SIDE) as i64, cy + (k / SIDE) as i64);
        let Some(value) = reference.cell(x, y) else {
            return false;
        };
        let value = cell_luma(value);
        let residual = (cell_luma(*sample) - value).abs();
        if residual <= quiet_limit {
            continue;
        }
        let mut contrast = 0;
        // Read the world reference across block boundaries. An unknown neighbour
        // cannot prove flatness, so it leaves the existing absolute bound in force.
        'neighbours: for yy in y - 1..=y + 1 {
            for xx in x - 1..=x + 1 {
                let Some(neighbour) = reference.cell(xx, yy) else {
                    contrast = OUTLIER;
                    break 'neighbours;
                };
                contrast = contrast.max((cell_luma(neighbour) - value).abs());
            }
        }
        if residual > quiet_limit.max(contrast + noise) {
            return false;
        }
    }
    true
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
    /// Raw changes that also admit a small rigid phase interpretation.
    phase_explained: Vec<u16>,
    /// Upper bounds on observed viewport extents. Fitting does not prove co-visibility;
    /// exceeding either bound proves that a whole-object moment is impossible.
    viewport: (usize, usize),
}

impl Consensus {
    pub fn new(grid: Grid) -> Self {
        let n = grid.bw * grid.bh;
        Self {
            grid,
            sig: vec![[0; 3]; n * CELLS],
            count: vec![0; n * CELLS],
            phase_explained: vec![0; n],
            viewport: (0, 0),
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
        let width = ((footprint.x + footprint.width as i64).min(frame.width as i64)
            - footprint.x.max(0))
        .max(0) as usize;
        let height = ((footprint.y + footprint.height as i64).min(frame.height as i64)
            - footprint.y.max(0))
        .max(0) as usize;
        self.viewport.0 = self.viewport.0.max(width);
        self.viewport.1 = self.viewport.1.max(height);
        let (bx0, by0, bx1, by1) = self.grid.span(footprint, pose);
        if bx1 <= bx0 || by1 <= by0 {
            return;
        }
        let rows = by1 - by0;
        let chunks = crate::kernels::pool::chunks_for(rows * (bx1 - bx0), 64);
        let grid = self.grid;
        let (sig_p, count_p, vote_p, phase_p) = (
            crate::kernels::pool::SyncPtr(self.sig.as_mut_ptr()),
            crate::kernels::pool::SyncPtr(self.count.as_mut_ptr()),
            crate::kernels::pool::SyncPtr(self.vote.as_mut_ptr()),
            crate::kernels::pool::SyncPtr(self.phase_explained.as_mut_ptr()),
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
                    if vote(cand, count, v, &sig, tier) {
                        // SAFETY: this chunk owns the same block's phase counter as its vote.
                        let explained = unsafe { &mut *phase_p.get().add(b) };
                        *explained = explained.saturating_add(1);
                    }
                }
            }
        });
    }
}

/// A sub-block rigid shift can be registration phase, not a changing object. Test one
/// signature-cell displacement without changing source pixels or the world placement.
/// The overlap must itself contain displacement evidence: cropping off a new edge mark
/// and comparing two flat interiors does not demonstrate phase agreement.
fn small_phase_agrees(a: &[[u8; 3]; CELLS], b: &[[u8; 3]]) -> bool {
    for dy in -1isize..=1 {
        for dx in -1isize..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let x0 = (-dx).max(0) as usize;
            let y0 = (-dy).max(0) as usize;
            let x1 = (SIDE as isize - dx).min(SIDE as isize) as usize;
            let y1 = (SIDE as isize - dy).min(SIDE as isize) as usize;
            let n = ((x1 - x0) * (y1 - y0) * 3) as u32;
            let mut sum = 0u32;
            let mut bias = 0i32;
            let mut unshifted = 0u32;
            'rows: for y in y0..y1 {
                for x in x0..x1 {
                    let p = a[y * SIDE + x];
                    let q = b[((y as isize + dy) as usize) * SIDE + (x as isize + dx) as usize];
                    for k in 0..3 {
                        let d = p[k] as i32 - q[k] as i32;
                        sum += d.unsigned_abs();
                        bias += d;
                        unshifted += (p[k] as i32 - b[y * SIDE + x][k] as i32).unsigned_abs();
                    }
                    if sum > CHANGED * n {
                        break 'rows;
                    }
                }
            }
            if sum <= CHANGED * n && bias.unsigned_abs() <= SHIFTED * n && unshifted > CHANGED * n {
                return true;
            }
        }
    }
    false
}

/// One whole-block view's vote.
fn vote(
    cand: &mut [[u8; 3]],
    count: &mut [i16],
    v: &mut BlockVote,
    sig: &[[u8; 3]; CELLS],
    tier: u8,
) -> bool {
    let mut phase_explained = false;
    if tier == TIER_CLEAN {
        if v.tier == TIER_CLEAN as i8 {
            let d = compare(sig, cand);
            if d.0 > CHANGED || d.1 > SHIFTED {
                phase_explained = small_phase_agrees(sig, cand);
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
    phase_explained
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

mod moments;

type BlockSignature = [[u8; 3]; CELLS];

/// Evidence order for a component's moment. Context must agree before a predicted cleanliness tier can win.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct MomentRank {
    complete: bool,
    untainted: bool,
    tier: u8,
    corroborated: bool,
    interior: bool,
    /// Frame index for a complete moment; covered block count for an incomplete one.
    preference: usize,
}

/// A connected changing object with exclusively owned, observed context. Context rings never merge objects.
pub struct Component {
    pub bx: usize,
    pub by: usize,
    pub bw: usize,
    pub bh: usize,
    pub mask: Vec<bool>,
    /// Blocks with change evidence in this hypothesis; the static margin validates the selected moment.
    pub dynamic: Vec<bool>,
    /// Best complete moment, or the widest partial observation when none is complete.
    pub best: Option<MomentRank>,
    /// Dynamic block signatures of the last complete observation, in mask traversal order.
    last_complete: Vec<BlockSignature>,
}

/// Small local shifts are ambiguous: they can be registration phase or a genuinely
/// moving widget. Preserve raw object coherence whenever its extent can fit a viewport.
/// Only an intrinsically unobservable group needs the phase-partition fallback.
pub fn components(c: &Consensus) -> Vec<Component> {
    let changing =
        |v: &BlockVote, changed: u16| changed >= 2 && changed as u32 * 4 >= v.clean_views as u32;
    let raw: Vec<bool> = c
        .vote
        .iter()
        .map(|v| changing(v, v.changed_views))
        .collect();
    let groups = partition_components(c, &raw, None);
    if c.viewport.0 == 0 || c.viewport.1 == 0 {
        return groups;
    }
    let structural: Vec<bool> = c
        .vote
        .iter()
        .zip(&c.phase_explained)
        .map(|(v, &phase)| changing(v, v.changed_views.saturating_sub(phase)))
        .collect();
    if raw == structural {
        return groups;
    }
    let mut owners = vec![-1i32; raw.len()];
    let mut split = vec![false; groups.len()];
    for (id, group) in groups.iter().enumerate() {
        let (mut left, mut top, mut right, mut bottom) = (group.bw, group.bh, 0, 0);
        let mut ambiguous = false;
        for y in 0..group.bh {
            for x in 0..group.bw {
                let k = y * group.bw + x;
                if group.mask[k] {
                    let b = (group.by + y) * c.grid.bw + group.bx + x;
                    owners[b] = id as i32;
                    if group.dynamic[k] {
                        left = left.min(x);
                        top = top.min(y);
                        right = right.max(x + 1);
                        bottom = bottom.max(y + 1);
                        ambiguous |= !structural[b];
                    }
                }
            }
        }
        // Context is support, not object extent. Even the outer changing blocks
        // leave their exact changed-pixel positions uncertain by BLOCK-1 on each edge.
        // Split only when the minimum possible changing span still exceeds a viewport.
        let edge_uncertainty = 2 * (BLOCK - 1);
        let min_width = ((right - left) * BLOCK).saturating_sub(edge_uncertainty);
        let min_height = ((bottom - top) * BLOCK).saturating_sub(edge_uncertainty);
        split[id] = ambiguous && (min_width > c.viewport.0 || min_height > c.viewport.1);
    }
    if !split.iter().any(|&v| v) {
        return groups;
    }
    let fallback: Vec<bool> = structural
        .iter()
        .zip(&owners)
        .map(|(&dynamic, &owner)| dynamic && owner >= 0 && split[owner as usize])
        .collect();
    let mut result: Vec<Component> = groups
        .into_iter()
        .enumerate()
        .filter_map(|(id, group)| (!split[id]).then_some(group))
        .collect();
    result.extend(partition_components(c, &fallback, Some(&owners)));
    result
}

/// Core-first components with unique context; a fallback cannot steal another raw group's margin.
fn partition_components(
    c: &Consensus,
    dynamic: &[bool],
    parents: Option<&[i32]>,
) -> Vec<Component> {
    let (bw, bh) = (c.grid.bw, c.grid.bh);
    let mut labels = vec![0usize; bw * bh];
    let mut count = 0;
    for start in 0..labels.len() {
        if !dynamic[start] || labels[start] != 0 {
            continue;
        }
        count += 1;
        labels[start] = count;
        let mut stack = vec![start];
        while let Some(i) = stack.pop() {
            let (x, y) = (i % bw, i / bw);
            for yy in y.saturating_sub(1)..=(y + 1).min(bh - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(bw - 1) {
                    let j = yy * bw + xx;
                    if dynamic[j] && labels[j] == 0 {
                        labels[j] = count;
                        stack.push(j);
                    }
                }
            }
        }
    }
    // Context validates an object; touching context rings do not make independent objects one time-varying state.
    // Give each observed context block one owner so two moments cannot overwrite the same static boundary.
    // A weak first-pass tier is still an observation: relearning may discover a cleaner view of it.
    let mut owners = labels.clone();
    for (i, &id) in labels.iter().enumerate() {
        if id == 0 {
            continue;
        }
        let (x, y) = (i % bw, i / bw);
        for yy in y.saturating_sub(1)..=(y + 1).min(bh - 1) {
            for xx in x.saturating_sub(1)..=(x + 1).min(bw - 1) {
                let j = yy * bw + xx;
                if labels[j] == 0
                    && c.vote[j].tier >= 0
                    && (owners[j] == 0 || id < owners[j])
                    && parents.is_none_or(|parents| parents[i] == parents[j])
                {
                    owners[j] = id;
                }
            }
        }
    }
    let mut members = vec![Vec::new(); count];
    for (i, &id) in owners.iter().enumerate() {
        if id > 0 {
            members[id - 1].push(i);
        }
    }
    members
        .into_iter()
        .map(|members| {
            let x0 = members.iter().map(|&i| i % bw).min().unwrap();
            let x1 = members.iter().map(|&i| i % bw).max().unwrap();
            let y0 = members.iter().map(|&i| i / bw).min().unwrap();
            let y1 = members.iter().map(|&i| i / bw).max().unwrap();
            let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
            let mut mask = vec![false; cw * ch];
            let mut changing = vec![false; cw * ch];
            for i in members {
                let k = (i / bw - y0) * cw + i % bw - x0;
                mask[k] = true;
                changing[k] = dynamic[i];
            }
            Component {
                bx: x0,
                by: y0,
                bw: cw,
                bh: ch,
                mask,
                dynamic: changing,
                best: None,
                last_complete: Vec::new(),
            }
        })
        .collect()
}

/// How a block's output was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// Not decided: the compositor's pixels stand.
    None = 0,
    /// A central clean view supported by the consensus, with weak new structure corroborated by another clean observation.
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
    /// A prior whole, clean, locally flat observation; never an averaged output colour.
    flat_witness: Option<[u8; 3]>,
    cand: [[u8; 3]; PIXELS],
    count: [i16; PIXELS],
    tier: [i8; PIXELS],
    /// The compositor's pixels (alpha 0 = uncovered) and the best tier of an observation showing them.
    main: [[u8; 4]; PIXELS],
    main_tier: [i8; PIXELS],
}

#[derive(Clone, Copy, Default)]
enum WitnessAction {
    #[default]
    Keep,
    Store,
    Clear,
}

/// A whole-block view's verdict, decided in parallel and applied in block order.
#[derive(Clone, Copy, Default)]
struct Act {
    corroborated_flat: bool,
    witness: WitnessAction,
    seen: bool,
    tier: u8,
    /// Spatial agreement, including a plausible sampling phase.
    strict: bool,
    /// Quiet reference agreement or corroboration by another actual observation.
    settled: bool,
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

fn whole_block_is_clean(tiers: &TierMap<'_>, sx: i64, sy: i64) -> bool {
    let (x0, y0) = (
        (sx - tiers.x).div_euclid(CELL as i64),
        (sy - tiers.y).div_euclid(CELL as i64),
    );
    let (x1, y1) = (
        (sx + BLOCK as i64 - 1 - tiers.x).div_euclid(CELL as i64),
        (sy + BLOCK as i64 - 1 - tiers.y).div_euclid(CELL as i64),
    );
    if x0 < 0 || y0 < 0 || x1 >= tiers.cw as i64 || y1 >= tiers.ch as i64 {
        return false;
    }
    (y0..=y1).all(|y| {
        tiers.tier[y as usize * tiers.cw + x0 as usize..=y as usize * tiers.cw + x1 as usize]
            .iter()
            .all(|&t| t == TIER_CLEAN)
    })
}

/// A flat block alone may be a shifted fine line. Require its surrounding block ring to be flat and observed too.
fn flat_neighborhood_sample(
    frame: &Frame<'_>,
    footprint: &Footprint<'_>,
    sx: i64,
    sy: i64,
    tolerance: i32,
) -> Option<[u8; 3]> {
    let radius = BLOCK as i64;
    let (left, top, right, bottom) = (sx - radius, sy - radius, sx + 2 * radius, sy + 2 * radius);
    if left < 0 || top < 0 || right > frame.width as i64 || bottom > frame.height as i64 {
        return None;
    }
    let mut low = [255u8; 3];
    let mut high = [0u8; 3];
    for y in top..bottom {
        for x in left..right {
            if !footprint.contains(x, y) {
                return None;
            }
            let p = (y as usize * frame.width + x as usize) * 4;
            for c in 0..3 {
                low[c] = low[c].min(frame.rgba[p + c]);
                high[c] = high[c].max(frame.rgba[p + c]);
                if high[c] as i32 - low[c] as i32 > tolerance {
                    return None;
                }
            }
        }
    }
    let p = (sy as usize * frame.width + sx as usize) * 4;
    Some([frame.rgba[p], frame.rgba[p + 1], frame.rgba[p + 2]])
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
    /// Last unsupported weak change in a clean, central pose vote. Components use their own history.
    weak_witness: Vec<Option<Box<BlockSignature>>>,
    main_tier: Vec<i8>,
    fallback: Vec<Option<Box<Fallback>>>,
    pub components: Vec<Component>,
}

/// Bytes a consensus holds per block (signatures and counts of its cells, and its vote).
pub const CONSENSUS_BLOCK_BYTES: usize = CELLS
    * (std::mem::size_of::<[u8; 3]>() + std::mem::size_of::<i16>())
    + std::mem::size_of::<BlockVote>()
    + std::mem::size_of::<u16>();
/// Bytes an output holds per block, counting a held view for every block (the most the write pass can hold); its
/// per-pixel fallback state is [`FALLBACK_BYTES`] per block that needs it.
pub const OUTPUT_BLOCK_BYTES: usize = std::mem::size_of::<Act>()
    + std::mem::size_of::<Kind>()
    + 2 * std::mem::size_of::<i32>()
    + std::mem::size_of::<i8>()
    + std::mem::size_of::<(i8, bool, bool, i16)>()
    + std::mem::size_of::<Option<Box<[u8; PIXELS * 3]>>>()
    + PIXELS * 3
    + std::mem::size_of::<Option<Box<BlockSignature>>>()
    // Component history and static weak-change witnesses own disjoint block sets.
    + CELLS * std::mem::size_of::<[u8; 3]>()
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
                        flat_witness: None,
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
            weak_witness: (0..n).map(|_| None).collect(),
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

    /// One distinct-pose vote. `still_previous` is the immediately preceding frame only when the pose did not
    /// change. It can confirm a final settled state that contributes just one vote. Writes always copy native pixels;
    /// `main` is the compositor's reference as cell means.
    #[allow(clippy::too_many_arguments)]
    pub fn emit(
        &mut self,
        c: &Consensus,
        frame: &Frame<'_>,
        still_previous: Option<&Frame<'_>>,
        footprint: &Footprint<'_>,
        tiers: &TierMap<'_>,
        pose: (i64, i64),
        tau: i32,
        frame_index: u32,
        main: &(dyn CellRef + Sync),
        writes: &mut Vec<BlockWrite>,
    ) {
        self.coobserve(
            c,
            &moments::View {
                frame,
                previous: still_previous,
                footprint,
                tiers,
                pose,
                tau,
                index: frame_index,
            },
        );
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
        // A complete moment outranks every partial cover. Within complete observations, use context, cleanliness,
        // temporal corroboration and visibility before recency. Without a complete view the widest partial cover
        // remains a best effort; it does not establish a complete epoch.
        for comp in self.components.iter_mut() {
            let (x, y) = grid.origin(comp.by * grid.bw + comp.bx);
            if x + (comp.bw * BLOCK) as i64 <= footprint.x + pose.0
                || y + (comp.bh * BLOCK) as i64 <= footprint.y + pose.1
                || x >= footprint.x + pose.0 + footprint.width as i64
                || y >= footprint.y + pose.1 + footprint.height as i64
            {
                continue;
            }
            let mut covered = Vec::new();
            let may_complete = x >= footprint.x + pose.0
                && y >= footprint.y + pose.1
                && x + (comp.bw * BLOCK) as i64 <= footprint.x + pose.0 + footprint.width as i64
                && y + (comp.bh * BLOCK) as i64 <= footprint.y + pose.1 + footprint.height as i64
                && x >= pose.0
                && y >= pose.1
                && x + (comp.bw * BLOCK) as i64 <= pose.0 + frame.width as i64
                && y + (comp.bh * BLOCK) as i64 <= pose.1 + frame.height as i64;
            let mut moment = Vec::with_capacity(if may_complete {
                comp.dynamic.iter().filter(|&&v| v).count()
            } else {
                0
            });
            let mut dynamic_index = 0;
            let mut compared = 0usize;
            let mut stable = true;
            let mut tier = TIER_CLEAN;
            let mut inset = i64::MAX;
            // A frame showing something in the component's static blocks that is not there in the consensus
            // carries a transient (a cursor passing over the widget's edge, or a status bubble over whole blocks):
            // it is the component's moment only when no other frame covers the component.
            let mut tainted = false;
            for yy in 0..comp.bh {
                for xx in 0..comp.bw {
                    let k = yy * comp.bw + xx;
                    if !comp.mask[k] {
                        continue;
                    }
                    let b = (comp.by + yy) * grid.bw + comp.bx + xx;
                    let (wx0, wy0) = grid.origin(b);
                    let previous_index = dynamic_index;
                    if comp.dynamic[k] {
                        dynamic_index += 1;
                    }
                    if let Some(t) = view(frame, footprint, tiers, pose, wx0, wy0, &mut sig) {
                        if t >= TIER_VEIL {
                            tier = tier.min(t);
                            // A cleaner relearned observation is not contradicted by a weaker first-pass reference.
                            if !comp.dynamic[k] && t as i8 <= c.vote[b].tier {
                                let off = compare(&sig, &c.sig[b * CELLS..(b + 1) * CELLS]).2;
                                tainted |= off > 0;
                            }
                            if comp.dynamic[k] && may_complete {
                                let mut prior = [[0u8; 3]; CELLS];
                                let reference = if let Some(before) = still_previous {
                                    view(before, footprint, tiers, pose, wx0, wy0, &mut prior)
                                        .map(|_| &prior)
                                } else {
                                    comp.last_complete.get(previous_index)
                                };
                                if let Some(reference) = reference {
                                    let difference = compare(&sig, reference);
                                    compared += 1;
                                    stable &=
                                        difference.0 <= tau as u32 && difference.1 <= tau as u32;
                                }
                                moment.push(sig);
                            }
                            let (sx, sy) = (wx0 - pose.0, wy0 - pose.1);
                            inset = inset
                                .min(sx - footprint.x)
                                .min(sy - footprint.y)
                                .min(footprint.x + footprint.width as i64 - sx - BLOCK as i64)
                                .min(footprint.y + footprint.height as i64 - sy - BLOCK as i64);
                            covered.push(b);
                        }
                    }
                }
            }
            if covered.is_empty() {
                continue;
            }
            let blocks = comp.mask.iter().filter(|&&m| m).count();
            let eligible = covered.len() == blocks;
            let confirmed = eligible && compared == moment.len() && compared > 0 && stable;
            if eligible {
                comp.last_complete = moment;
            }
            // Registration phase can perturb a correct sample, so corroboration uses the source-noise tolerance.
            // A stationary run's previous frame confirms its final state without turning duplicate poses into votes.
            let score = if eligible {
                MomentRank {
                    complete: true,
                    untainted: !tainted,
                    tier,
                    corroborated: confirmed,
                    interior: confirmed && inset >= CENTRAL,
                    preference: frame_index as usize,
                }
            } else {
                MomentRank {
                    complete: false,
                    untainted: false,
                    tier: 0,
                    corroborated: false,
                    interior: false,
                    preference: covered.len(),
                }
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
        let (component, kind, witnesses) = (&self.component, &self.kind, &self.weak_witness);
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
                    if component[b] >= 0 || kind[b] == Kind::Coherent {
                        continue;
                    }
                    let (wx0, wy0) = grid.origin(b);
                    // SAFETY: each pool chunk owns these block rows, as in fallback_view above.
                    let fb = unsafe { &mut *(fallback_base as *mut Option<Box<Fallback>>).add(b) };
                    if fb.is_some()
                        && (c.vote[b].tier >= TIER_CLEAN as i8
                            || !whole_block_is_clean(tiers, wx0 - pose.0, wy0 - pose.1))
                    {
                        continue;
                    }
                    let Some(tier) = view(frame, footprint, tiers, pose, wx0, wy0, &mut sig) else {
                        continue;
                    };
                    let d = compare(&sig, &c.sig[b * CELLS..(b + 1) * CELLS]);
                    let (sx0, sy0) = (wx0 - pose.0, wy0 - pose.1);
                    let inset = (sx0 - footprint.x)
                        .min(sy0 - footprint.y)
                        .min(footprint.x + footprint.width as i64 - sx0 - BLOCK as i64)
                        .min(footprint.y + footprint.height as i64 - sy0 - BLOCK as i64);
                    if let Some(fb) = fb.as_mut() {
                        if tier == TIER_CLEAN && inset >= CENTRAL {
                            let tolerance = (tau / 4).max(1);
                            if let Some(sample) =
                                flat_neighborhood_sample(frame, footprint, sx0, sy0, tolerance)
                            {
                                let consistent = |prior: [u8; 3]| {
                                    (0..3).all(|c| {
                                        (sample[c] as i32 - prior[c] as i32).abs() <= tolerance
                                    })
                                };
                                let prior = still_previous.and_then(|f| {
                                    flat_neighborhood_sample(f, footprint, sx0, sy0, tolerance)
                                });
                                act.seen = true;
                                act.corroborated_flat =
                                    prior.or(fb.flat_witness).is_some_and(consistent);
                                fb.flat_witness = Some(sample);
                            }
                        }
                        continue;
                    }
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
                    let mut strict = agrees_strictly(d, tau, &sig, c, (wx0, wy0));
                    let quiet_limit = 2 * (tau / 4).max(2);
                    // Spatial phase support keeps a view eligible, but does not
                    // prove that a weak transient beside a real edge is permanent.
                    let mut settled = strict
                        && sig
                            .iter()
                            .zip(&c.sig[b * CELLS..(b + 1) * CELLS])
                            .all(|(a, b)| (cell_luma(*a) - cell_luma(*b)).abs() <= quiet_limit);
                    let mut witness = WitnessAction::Keep;
                    if tier == TIER_CLEAN {
                        witness = WitnessAction::Clear;
                        if !settled && inset >= CENTRAL && agrees(d, tau) && d.2 == 0 {
                            // The early reference may precede genuinely loaded, low-contrast content.
                            // Two clean views must agree with each other more closely than merely both
                            // resembling that reference; a moving weak mark cannot corroborate itself.
                            let quiet_limit = 2 * (tau / 4).max(2);
                            let mut previous_signature = [[0u8; 3]; CELLS];
                            // A still run's actual predecessor can confirm newly settled content without
                            // adding a duplicate-pose vote. It also prevents an old witness from confirming
                            // an isolated pulse that contradicts the immediately preceding image.
                            let previous = if let Some(before) = still_previous {
                                view(
                                    before,
                                    footprint,
                                    tiers,
                                    pose,
                                    wx0,
                                    wy0,
                                    &mut previous_signature,
                                )
                                .map(|_| &previous_signature)
                            } else {
                                witnesses[b].as_deref()
                            };
                            settled = previous.is_some_and(|previous| {
                                agrees(compare(&sig, previous), tau)
                                    && sig.iter().zip(previous).all(|(a, b)| {
                                        (cell_luma(*a) - cell_luma(*b)).abs() <= quiet_limit
                                    })
                            });
                            strict |= settled;
                            if !settled {
                                witness = WitnessAction::Store;
                            }
                        }
                    }
                    *act = Act {
                        corroborated_flat: false,
                        witness,
                        seen: true,
                        tier,
                        strict,
                        settled,
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
                match a.witness {
                    WitnessAction::Keep => {}
                    WitnessAction::Clear => self.weak_witness[b] = None,
                    WitnessAction::Store => {
                        // Only rare, whole clean views need a witness. Re-read their small signature here
                        // so allocation and release remain outside the parallel decision workers.
                        let (wx, wy) = grid.origin(b);
                        if view(frame, footprint, tiers, pose, wx, wy, &mut sig).is_some() {
                            if let Some(previous) = &mut self.weak_witness[b] {
                                **previous = sig;
                            } else {
                                self.weak_witness[b] = Some(Box::new(sig));
                            }
                        }
                    }
                }
                if self.fallback[b].is_some() {
                    if a.corroborated_flat {
                        self.kind[b] = Kind::Coherent;
                        self.frame[b] = frame_index as i32;
                        self.fallback[b] = None;
                        writes.push(block_write(b, Kind::Coherent));
                    }
                    continue;
                }
                if a.tier == TIER_CLEAN && a.settled && a.inset >= CENTRAL as i16 {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::reveal::stats::CellMap;
    use crate::kernels::reveal::CanvasView;

    fn solid_frame(width: usize, height: usize, value: u8) -> Vec<u8> {
        let mut rgba = vec![value; width * height * 4];
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        rgba
    }

    const W: usize = 64;
    const H: usize = 64;

    /// A white page with a dark rule in every block, a block at (16..32, 16..32) that shows a different picture in
    /// every frame (content that really changes), and in `transient` frames a dark bubble over the whole block at
    /// (0..16, 0..16).
    fn frame(k: usize, transient: bool) -> Vec<u8> {
        let mut rgba = vec![255u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let v = if (16..32).contains(&x) && (16..32).contains(&y) {
                    ((k * 60 + x * 3) % 256) as u8
                } else if transient && x < 16 && y < 16 {
                    40
                } else if y % 16 == 7 && x % 16 < 10 {
                    30
                } else {
                    250
                };
                rgba[(y * W + x) * 4..(y * W + x) * 4 + 3].fill(v);
            }
        }
        rgba
    }

    /// Which frame each block of the component took, over `frames` voting in order (all whole, clean, at pose 0).
    fn moments(frames: &[Vec<u8>]) -> Vec<i32> {
        let mask = vec![1u8; W * H];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width: W,
            height: H,
            mask: &mask,
        };
        let clean = vec![TIER_CLEAN; (W / CELL) * (H / CELL)];
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: W / CELL,
            ch: H / CELL,
            tier: &clean,
        };
        let mut c = Consensus::new(Grid::covering(0, 0, W, H));
        for f in frames {
            let f = Frame {
                rgba: f,
                width: W,
                height: H,
            };
            c.observe(&f, &footprint, &tiers, (0, 0));
        }
        let comps = components(&c);
        assert_eq!(comps.len(), 1, "one dynamic component");
        let mut out = Output::new(&c, comps);
        let coverage = vec![255u8; W * H / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: W,
            height: H,
            rgba: &frames[0],
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        for (i, f) in frames.iter().enumerate() {
            let f = Frame {
                rgba: f,
                width: W,
                height: H,
            };
            out.emit(
                &c,
                &f,
                None,
                &footprint,
                &tiers,
                (0, 0),
                24,
                i as u32,
                &main,
                &mut writes,
            );
        }
        out.frame.clone()
    }

    // A dynamic component takes one moment, the latest frame that covers it. Chrome's link-status bubble, shown
    // in 1 of 8 clean views of a sticky table of contents (owner_1.53.20), covered whole blocks of the component's
    // static margin in that latest frame, and the taint test only caught small blobs, so the bubble was copied in
    // over the page the compositor had. A frame whose static blocks disagree with what every other view shows is
    // not the component's moment while another frame covers it.
    #[test]
    fn a_dynamic_component_does_not_take_a_moment_with_a_whole_block_transient() {
        let frames: Vec<Vec<u8>> = (0..8).map(|k| frame(k, k == 7)).collect();
        let m = moments(&frames);
        assert_eq!(m[0], 6, "the bubble's block");
        assert_eq!(m[4 + 1], 6, "the dynamic block");
    }

    // Content that changes (loading, expanding) settles in its final state: without a transient the component
    // still takes the latest frame (0-1's thumbnails, §十 揭示).
    #[test]
    fn a_dynamic_component_takes_its_latest_moment() {
        let frames: Vec<Vec<u8>> = (0..8).map(|k| frame(k, false)).collect();
        let m = moments(&frames);
        assert_eq!(m[4 + 1], 7);
        assert_eq!(m[0], 7);
    }
    #[test]
    fn small_rigid_phase_is_distinct_from_structural_change() {
        let pattern = |dx: usize| -> BlockSignature {
            std::array::from_fn(|k| {
                let x = k % SIDE + dx;
                let y = k / SIDE;
                [20 + ((x * 19 + y * 31) % 11) as u8 * 17; 3]
            })
        };
        let mut cand = pattern(0);
        let mut count = [1; CELLS];
        let mut v = BlockVote {
            tier: TIER_CLEAN as i8,
            clean_views: 1,
            changed_views: 0,
        };
        let mut explained = 0;
        for dx in [1, 0, 1, 0, 1, 0] {
            explained += vote(&mut cand, &mut count, &mut v, &pattern(dx), TIER_CLEAN) as u16;
        }
        assert_eq!(v.changed_views - explained, 0);
        let replacement = [[220; 3]; CELLS];
        vote(&mut cand, &mut count, &mut v, &replacement, TIER_CLEAN);
        assert_eq!(
            v.changed_views - explained,
            1,
            "a real replacement is not phase noise"
        );
    }

    #[test]
    fn a_new_edge_mark_cannot_hide_in_the_uncompared_phase_strip() {
        for side in 0..4 {
            let mut cand = [[80; 3]; CELLS];
            let mut count = [1; CELLS];
            let mut v = BlockVote {
                tier: TIER_CLEAN as i8,
                clean_views: 1,
                changed_views: 0,
            };
            let mut observed = cand;
            for k in 0..SIDE {
                let cell = match side {
                    0 => k * SIDE,
                    1 => k * SIDE + SIDE - 1,
                    2 => k,
                    _ => (SIDE - 1) * SIDE + k,
                };
                observed[cell] = [230; 3];
            }
            assert!(!vote(&mut cand, &mut count, &mut v, &observed, TIER_CLEAN));
            assert_eq!(
                v.changed_views, 1,
                "a uniform overlap cannot establish a displacement or dismiss new edge content"
            );
        }
    }

    #[test]
    fn phase_evidence_requires_a_small_rigid_displacement() {
        let pattern = |dx: i32, dy: i32| -> BlockSignature {
            std::array::from_fn(|k| {
                let x = (k % SIDE) as i32 + 8 + dx;
                let y = (k / SIDE) as i32 + 8 + dy;
                let seed =
                    (x as u32).wrapping_mul(0x9e3779b9) ^ (y as u32).wrapping_mul(0x85ebca6b);
                let value = (seed ^ (seed >> 13)).wrapping_mul(0xc2b2ae35);
                [(value >> 24) as u8; 3]
            })
        };
        let reference = pattern(0, 0);
        for dy in -1..=1 {
            for dx in -1..=1 {
                if dx != 0 || dy != 0 {
                    assert!(small_phase_agrees(&pattern(dx, dy), &reference));
                }
            }
        }
        assert!(!small_phase_agrees(&pattern(3, 0), &reference));
        let mut changed = pattern(1, 0);
        changed[3 * SIDE..5 * SIDE].fill([255; 3]);
        assert!(
            !small_phase_agrees(&changed, &reference),
            "phase cannot explain a changed interior"
        );
    }

    // A real widget moves only two pixels. Separate initial viewports see different
    // epochs, so the consensus and compositor can contain a seam inside it. Local
    // phase explanations must not discard the later whole-widget observation.
    fn phase_ambiguous_widget(clipped_context: bool) {
        const WORLD: usize = 416;
        const SIZE: usize = 192;
        let world = |shift: usize| {
            let mut pixels = solid_frame(WORLD, SIZE, 240);
            for y in 64..128 {
                for x in 144 + shift..240 + shift {
                    let value = if (x - 144 - shift) % 8 < 4 { 80 } else { 180 };
                    pixels[(y * WORLD + x) * 4..(y * WORLD + x) * 4 + 3].fill(value);
                }
            }
            pixels
        };
        let epochs = [world(0), world(2), world(4)];
        let poses: Vec<(usize, usize)> = (0..8)
            .map(|x| (x, 0))
            .chain((0..8).map(|x| (if clipped_context { 176 + x } else { 192 + x }, 1)))
            .chain((0..3).map(|i| {
                if clipped_context {
                    (64 + i, 2)
                } else {
                    (96 + i, 1)
                }
            }))
            .collect();
        let frames: Vec<Vec<u8>> = poses
            .iter()
            .map(|&(x, epoch)| {
                let mut frame = vec![0; SIZE * SIZE * 4];
                for y in 0..SIZE {
                    frame[y * SIZE * 4..(y + 1) * SIZE * 4].copy_from_slice(
                        &epochs[epoch][(y * WORLD + x) * 4..(y * WORLD + x + SIZE) * 4],
                    );
                }
                frame
            })
            .collect();
        let mask = vec![1; SIZE * SIZE];
        let clean = vec![TIER_CLEAN; SIZE * SIZE / 4];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: SIZE,
            height: SIZE,
            mask: &mask,
        };
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: SIZE / 2,
            ch: SIZE / 2,
            tier: &clean,
        };
        let mut c = Consensus::new(Grid::covering(0, 0, WORLD, SIZE));
        for (i, &(x, _)) in poses.iter().enumerate() {
            c.observe(
                &Frame {
                    rgba: &frames[i],
                    width: SIZE,
                    height: SIZE,
                },
                &fp,
                &tm,
                (x as i64, 0),
            );
        }
        let mut result = epochs[0].clone();
        for y in 0..SIZE {
            result[(y * WORLD + 192) * 4..(y + 1) * WORLD * 4]
                .copy_from_slice(&epochs[1][(y * WORLD + 192) * 4..(y + 1) * WORLD * 4]);
        }
        let initial = result.clone();
        let coverage = vec![255; WORLD * SIZE / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: WORLD,
            height: SIZE,
            rgba: &initial,
            coverage: &coverage,
        });
        let mut out = Output::new(&c, components(&c));
        for b in out.fallback_blocks() {
            let (x, y) = c.grid.origin(b);
            let mut block = vec![0; PIXELS * 4];
            for row in 0..BLOCK {
                let from = ((y as usize + row) * WORLD + x as usize) * 4;
                block[row * BLOCK * 4..(row + 1) * BLOCK * 4]
                    .copy_from_slice(&initial[from..from + BLOCK * 4]);
            }
            out.set_main(b, &block);
        }
        for (i, &(x, _)) in poses.iter().enumerate() {
            let mut writes = Vec::new();
            out.emit(
                &c,
                &Frame {
                    rgba: &frames[i],
                    width: SIZE,
                    height: SIZE,
                },
                None,
                &fp,
                &tm,
                (x as i64, 0),
                24,
                i as u32,
                &main,
                &mut writes,
            );
            for w in writes {
                for row in 0..BLOCK {
                    let from = ((w.sy as usize + row) * SIZE + w.sx as usize) * 4;
                    let to = ((w.gy as usize * BLOCK + row) * WORLD + w.gx as usize * BLOCK) * 4;
                    result[to..to + BLOCK * 4].copy_from_slice(&frames[i][from..from + BLOCK * 4]);
                }
            }
        }
        for block in out.finish(&c, 24) {
            for row in 0..BLOCK {
                let to =
                    ((block.gy as usize * BLOCK + row) * WORLD + block.gx as usize * BLOCK) * 4;
                result[to..to + BLOCK * 4]
                    .copy_from_slice(&block.rgba[row * BLOCK * 4..(row + 1) * BLOCK * 4]);
            }
        }
        let mut wrong = 0;
        for y in 64..128 {
            for x in 144..242 {
                let p = (y * WORLD + x) * 4;
                wrong += (result[p..p + 3] != epochs[if clipped_context { 2 } else { 1 }][p..p + 3])
                    as usize;
            }
        }
        assert_eq!(
            wrong, 0,
            "a complete observed widget must not retain the seam between partial epochs"
        );
    }

    #[test]
    fn a_complete_widget_moment_repairs_phase_ambiguous_partial_references() {
        phase_ambiguous_widget(false);
    }
    #[test]
    fn a_widget_can_stay_coherent_when_only_its_static_margin_is_clipped() {
        phase_ambiguous_widget(true);
    }

    #[test]
    fn phase_partition_is_a_fallback_for_groups_larger_than_the_observed_viewport() {
        let mut c = Consensus::new(Grid::covering(0, 0, 320, 128));
        c.viewport = (192, 128);
        c.sig.fill([80; 3]);
        for v in &mut c.vote {
            v.tier = TIER_CLEAN as i8;
            v.clean_views = 8;
        }
        for x in 1..19 {
            let b = 3 * c.grid.bw + x;
            c.vote[b].changed_views = 8;
            if x != 4 && x != 14 {
                c.phase_explained[b] = 8;
            }
        }
        let pieces = components(&c);
        assert_eq!(
            pieces.len(),
            2,
            "the phase bridge cannot force two observable objects into an impossible whole"
        );
        assert!(pieces
            .iter()
            .all(|p| p.bw * BLOCK <= 192 && p.bh * BLOCK <= 128));
        // The same evidence in a larger viewport admits a coherent whole-object
        // interpretation. Unknown dimensions likewise provide no reason to split it.
        c.viewport = (320, 128);
        assert_eq!(components(&c).len(), 1);
        c.viewport = (0, 0);
        assert_eq!(components(&c).len(), 1);
    }

    #[test]
    fn static_context_outside_a_viewport_does_not_make_a_fitting_object_unobservable() {
        let mut c = Consensus::new(Grid::covering(0, 0, 224, 128));
        c.viewport = (192, 128);
        c.sig.fill([80; 3]);
        for v in &mut c.vote {
            v.tier = TIER_CLEAN as i8;
            v.clean_views = 8;
        }
        for x in 1..13 {
            let b = 3 * c.grid.bw + x;
            c.vote[b].changed_views = 8;
            if x != 4 && x != 10 {
                c.phase_explained[b] = 8;
            }
        }
        let groups = components(&c);
        assert_eq!(
            groups.len(),
            1,
            "the changing core fits; its wider static margin is support, not object extent"
        );
        c.viewport = (176, 128);
        assert_eq!(
            components(&c).len(),
            1,
            "block quantization cannot prove the object exceeds this viewport"
        );
        c.viewport = (128, 128);
        assert_eq!(
            components(&c).len(),
            2,
            "a smaller viewport makes the changing extent provably unobservable"
        );
    }

    #[test]
    fn a_partial_later_view_does_not_split_a_complete_component_moment() {
        // Twenty changing blocks have a complete old state. A later state loses just one
        // block to an overlay. It must not replace nineteen blocks of the old moment.
        let (width, height) = (80, 64);
        let mut c = Consensus::new(Grid::covering(0, 0, width, height));
        for v in &mut c.vote {
            v.tier = TIER_CLEAN as i8;
            v.clean_views = 4;
            v.changed_views = 4;
        }
        let mut out = Output::new(&c, components(&c));
        assert_eq!(out.components.len(), 1);
        let mask = vec![1; width * height];
        let fp = Footprint {
            x: 0,
            y: 0,
            width,
            height,
            mask: &mask,
        };
        let old = solid_frame(width, height, 80);
        let new = solid_frame(width, height, 180);
        let cov = vec![255; width * height / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width,
            height,
            rgba: &old,
            coverage: &cov,
        });
        let mut tiers = vec![TIER_CLEAN; width * height / 4];
        let mut writes = Vec::new();
        for (i, rgba) in [&old, &new].into_iter().enumerate() {
            if i == 1 {
                for y in 0..8 {
                    tiers[y * (width / 2)..y * (width / 2) + 8].fill(0);
                }
            }
            let tm = TierMap {
                x: 0,
                y: 0,
                cw: width / 2,
                ch: height / 2,
                tier: &tiers,
            };
            out.emit(
                &c,
                &Frame {
                    rgba,
                    width,
                    height,
                },
                None,
                &fp,
                &tm,
                (0, 0),
                24,
                i as u32,
                &main,
                &mut writes,
            );
        }
        assert!(
            out.frame.iter().all(|&f| f == 0),
            "a component must retain one complete moment: {:?}",
            out.frame
        );
    }
    #[test]
    fn a_clean_component_view_outranks_a_more_central_veiled_view() {
        let size = 192;
        let c = Consensus::new(Grid::covering(0, 0, size, size));
        let part = Component {
            bx: 5,
            by: 5,
            bw: 1,
            bh: 1,
            mask: vec![true],
            dynamic: vec![true],
            best: None,
            last_complete: Vec::new(),
        };
        let mut out = Output::new(&c, vec![part]);
        let pixels = solid_frame(size, size, 80);
        let mask = vec![1; size * size];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: size,
            height: size,
            mask: &mask,
        };
        let clear = vec![TIER_CLEAN; size * size / 4];
        let veil = vec![TIER_VEIL; size * size / 4];
        let veiled = TierMap {
            x: 0,
            y: 0,
            cw: size / 2,
            ch: size / 2,
            tier: &veil,
        };
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: size / 2,
            ch: size / 2,
            tier: &clear,
        };
        let coverage = vec![255; size * size / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: size,
            height: size,
            rgba: &pixels,
            coverage: &coverage,
        });
        let frame = Frame {
            rgba: &pixels,
            width: size,
            height: size,
        };
        let mut writes = Vec::new();
        out.emit(
            &c,
            &frame,
            None,
            &fp,
            &veiled,
            (0, 0),
            24,
            0,
            &main,
            &mut writes,
        );
        out.emit(
            &c,
            &frame,
            None,
            &fp,
            &tm,
            (0, 72),
            24,
            1,
            &main,
            &mut writes,
        );
        let b = 5 * c.grid.bw + 5;
        assert_eq!(
            out.frame[b], 1,
            "a known clean view outranks a more central veil"
        );
        out.emit(
            &c,
            &frame,
            None,
            &fp,
            &tm,
            (0, 0),
            24,
            2,
            &main,
            &mut writes,
        );
        assert_eq!(
            out.frame[b], 2,
            "genuine later content in the interior must still update"
        );
    }
    #[test]
    fn component_moments_reject_a_single_pulse_but_accept_a_confirmed_update() {
        let size = 128;
        let c = Consensus::new(Grid::covering(0, 0, size, size));
        let part = Component {
            bx: 3,
            by: 3,
            bw: 1,
            bh: 1,
            mask: vec![true],
            dynamic: vec![true],
            best: None,
            last_complete: Vec::new(),
        };
        let mut out = Output::new(&c, vec![part]);
        let mask = vec![1; size * size];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: size,
            height: size,
            mask: &mask,
        };
        let clean = vec![TIER_CLEAN; size * size / 4];
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: size / 2,
            ch: size / 2,
            tier: &clean,
        };
        let initial = solid_frame(size, size, 80);
        let coverage = vec![255; size * size / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: size,
            height: size,
            rgba: &initial,
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        for (i, v) in [80, 80, 200, 80, 80, 200, 200].into_iter().enumerate() {
            let rgba = solid_frame(size, size, v);
            let f = Frame {
                rgba: &rgba,
                width: size,
                height: size,
            };
            out.emit(
                &c,
                &f,
                None,
                &fp,
                &tm,
                (0, 0),
                24,
                i as u32,
                &main,
                &mut writes,
            );
            assert_eq!(
                out.frame[3 * c.grid.bw + 3],
                [0, 1, 1, 1, 4, 4, 6][i],
                "moment {i}: an uncorroborated pulse is not a new content version"
            );
        }
        let final_pixels = solid_frame(size, size, 120);
        let final_frame = Frame {
            rgba: &final_pixels,
            width: size,
            height: size,
        };
        out.emit(
            &c,
            &final_frame,
            Some(&final_frame),
            &fp,
            &tm,
            (0, 0),
            24,
            7,
            &main,
            &mut writes,
        );
        assert_eq!(out.frame[3*c.grid.bw+3],7,"the final stable state of a still run is corroborated without counting duplicate poses as votes");
    }
    #[test]
    fn equally_corroborated_moments_prefer_visibility_but_an_unconfirmed_interior_pulse_does_not() {
        let size = 192;
        let c = Consensus::new(Grid::covering(0, 0, size, size));
        let part = Component {
            bx: 5,
            by: 5,
            bw: 1,
            bh: 1,
            mask: vec![true],
            dynamic: vec![true],
            best: None,
            last_complete: Vec::new(),
        };
        let mut out = Output::new(&c, vec![part]);
        let mask = vec![1; size * size];
        let clean = vec![TIER_CLEAN; size * size / 4];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: size,
            height: size,
            mask: &mask,
        };
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: size / 2,
            ch: size / 2,
            tier: &clean,
        };
        let pixels = solid_frame(size, size, 80);
        let coverage = vec![255; size * size / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: size,
            height: size,
            rgba: &pixels,
            coverage: &coverage,
        });
        let frame = Frame {
            rgba: &pixels,
            width: size,
            height: size,
        };
        let mut writes = Vec::new();
        out.emit(
            &c,
            &frame,
            Some(&frame),
            &fp,
            &tm,
            (0, 0),
            24,
            0,
            &main,
            &mut writes,
        );
        let faded = solid_frame(size, size, 30);
        let edge = Frame {
            rgba: &faded,
            width: size,
            height: size,
        };
        out.emit(
            &c,
            &edge,
            Some(&edge),
            &fp,
            &tm,
            (0, 72),
            24,
            1,
            &main,
            &mut writes,
        );
        let b = 5 * c.grid.bw + 5;
        assert_eq!(
            out.frame[b], 0,
            "a stable border fade is still a worse view than a stable interior one"
        );
        let pulse = solid_frame(size, size, 200);
        let changed = Frame {
            rgba: &pulse,
            width: size,
            height: size,
        };
        out.emit(
            &c,
            &changed,
            None,
            &fp,
            &tm,
            (0, 0),
            24,
            2,
            &main,
            &mut writes,
        );
        assert_eq!(
            out.frame[b], 0,
            "position cannot make an uncorroborated pulse win"
        );
        out.emit(
            &c,
            &changed,
            Some(&changed),
            &fp,
            &tm,
            (0, 0),
            24,
            3,
            &main,
            &mut writes,
        );
        assert_eq!(
            out.frame[b], 3,
            "a corroborated newer interior state still replaces the old one"
        );
    }
    #[test]
    fn two_clean_flat_observations_can_replace_a_veiled_consensus_but_nearby_structure_cannot() {
        let size = 128;
        for nearby_line in [false, true] {
            let mut c = Consensus::new(Grid::covering(0, 0, size, size));
            c.sig.fill([140; 3]);
            for v in &mut c.vote {
                v.tier = TIER_VEIL as i8;
            }
            let mut out = Output::new(&c, components(&c));
            let target = 3 * c.grid.bw + 3;
            let mask = vec![1; size * size];
            let clean = vec![TIER_CLEAN; size * size / 4];
            let fp = Footprint {
                x: 0,
                y: 0,
                width: size,
                height: size,
                mask: &mask,
            };
            let tm = TierMap {
                x: 0,
                y: 0,
                cw: size / 2,
                ch: size / 2,
                tier: &clean,
            };
            let main_pixels = solid_frame(size, size, 140);
            let coverage = vec![255; size * size / 8];
            let main = CellMap::from_canvas(&CanvasView {
                x: 0,
                y: 0,
                width: size,
                height: size,
                rgba: &main_pixels,
                coverage: &coverage,
            });
            let mut writes = Vec::new();
            for (i, value) in [200, 80, 80].into_iter().enumerate() {
                let mut rgba = solid_frame(size, size, value);
                if nearby_line {
                    for y in 32..80 {
                        rgba[(y * size + 66) * 4..(y * size + 66) * 4 + 3].fill(0);
                    }
                }
                let f = Frame {
                    rgba: &rgba,
                    width: size,
                    height: size,
                };
                out.emit(
                    &c,
                    &f,
                    None,
                    &fp,
                    &tm,
                    (0, 0),
                    24,
                    i as u32,
                    &main,
                    &mut writes,
                );
                if i < 2 {
                    assert!(
                        !writes.iter().any(|w| w.gx == 3 && w.gy == 3),
                        "one observation cannot overturn a consensus"
                    );
                }
            }
            assert_eq!(writes.iter().any(|w|w.gx==3&&w.gy==3&&w.frame==2),!nearby_line,"a nearby line may have moved across the block boundary; do not treat it as a flat background");
            if !nearby_line {
                assert_eq!(out.kind[target], Kind::Coherent);
            }
        }
    }
    #[test]
    fn context_rings_do_not_merge_independent_changing_objects_or_claim_unseen_blocks() {
        let mut c = Consensus::new(Grid::covering(0, 0, 128, 64));
        for v in &mut c.vote {
            v.tier = TIER_CLEAN as i8;
            v.clean_views = 4;
        }
        for i in [10, 12] {
            c.vote[i].changed_views = 4;
        }
        let parts = components(&c);
        assert_eq!(
            parts.len(),
            2,
            "an unchanged separator is context, not evidence of one changing object"
        );
        let mut ownership = vec![0u8; c.vote.len()];
        for part in &parts {
            for y in 0..part.bh {
                for x in 0..part.bw {
                    if part.mask[y * part.bw + x] {
                        ownership[(part.by + y) * c.grid.bw + part.bx + x] += 1;
                    }
                }
            }
        }
        assert!(
            ownership.iter().all(|&n| n <= 1),
            "shared context must not be overwritten by two moments"
        );
        c.vote[11].changed_views = 4;
        assert_eq!(
            components(&c).len(),
            1,
            "truly touching dynamic blocks still form one object"
        );
        let mut c = Consensus::new(Grid::covering(0, 0, 64, 64));
        c.vote[0] = BlockVote {
            tier: TIER_CLEAN as i8,
            clean_views: 4,
            changed_views: 4,
        };
        let parts = components(&c);
        assert_eq!(
            parts[0].mask.iter().filter(|&&v| v).count(),
            1,
            "never observed context cannot make a complete moment impossible"
        );
    }

    #[test]
    fn directly_contradicted_context_outranks_a_heuristic_clean_label() {
        let mask = vec![1; W * H];
        let coverage = vec![255; W * H / 8];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: W,
            height: H,
            mask: &mask,
        };
        let clean = vec![TIER_CLEAN; W * H / 4];
        let veil = vec![TIER_VEIL; W * H / 4];
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: W / 2,
            ch: H / 2,
            tier: &clean,
        };
        let vt = TierMap {
            x: 0,
            y: 0,
            cw: W / 2,
            ch: H / 2,
            tier: &veil,
        };
        let old = frame(0, false);
        let bad = frame(1, true);
        let old = Frame {
            rgba: &old,
            width: W,
            height: H,
        };
        let bad = Frame {
            rgba: &bad,
            width: W,
            height: H,
        };
        let mut c = Consensus::new(Grid::covering(0, 0, W, H));
        c.observe(&old, &fp, &tm, (0, 0));
        let part = Component {
            bx: 0,
            by: 0,
            bw: 3,
            bh: 3,
            mask: vec![true; 9],
            dynamic: (0..9).map(|i| i == 4).collect(),
            best: None,
            last_complete: Vec::new(),
        };
        let mut out = Output::new(&c, vec![part]);
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: W,
            height: H,
            rgba: old.rgba,
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        out.emit(
            &c,
            &old,
            Some(&old),
            &fp,
            &vt,
            (0, 0),
            24,
            0,
            &main,
            &mut writes,
        );
        out.emit(
            &c,
            &bad,
            Some(&bad),
            &fp,
            &tm,
            (0, 0),
            24,
            1,
            &main,
            &mut writes,
        );
        assert_eq!(
            out.frame[5], 0,
            "a visible transient in unchanged context cannot be excused by a clean-tier prediction"
        );
    }
    #[test]
    fn observed_low_tier_context_remains_available_for_relearning() {
        let mut c = Consensus::new(Grid::covering(0, 0, 64, 64));
        for v in &mut c.vote {
            v.tier = 0;
        }
        c.vote[5] = BlockVote {
            tier: TIER_CLEAN as i8,
            clean_views: 4,
            changed_views: 4,
        };
        let parts = components(&c);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].mask.iter().filter(|&&v|v).count(),9,"observed context can become clean in the second model; only unseen context is unavailable");
    }

    #[test]
    fn lower_tier_context_cannot_veto_a_cleaner_complete_observation() {
        let mask = vec![1; W * H];
        let coverage = vec![255; W * H / 8];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: W,
            height: H,
            mask: &mask,
        };
        let clean = vec![TIER_CLEAN; W * H / 4];
        let veil = vec![TIER_VEIL; W * H / 4];
        let opaque = vec![0; W * H / 4];
        let tm = TierMap {
            x: 0,
            y: 0,
            cw: W / 2,
            ch: H / 2,
            tier: &clean,
        };
        let vt = TierMap {
            x: 0,
            y: 0,
            cw: W / 2,
            ch: H / 2,
            tier: &veil,
        };
        let ot = TierMap {
            x: 0,
            y: 0,
            cw: W / 2,
            ch: H / 2,
            tier: &opaque,
        };
        let old_pixels = frame(0, true);
        let clean_pixels = frame(1, false);
        let old = Frame {
            rgba: &old_pixels,
            width: W,
            height: H,
        };
        let later = Frame {
            rgba: &clean_pixels,
            width: W,
            height: H,
        };
        let mut c = Consensus::new(Grid::covering(0, 0, W, H));
        c.observe(&old, &fp, &ot, (0, 0));
        let part = Component {
            bx: 0,
            by: 0,
            bw: 3,
            bh: 3,
            mask: vec![true; 9],
            dynamic: (0..9).map(|i| i == 4).collect(),
            best: None,
            last_complete: Vec::new(),
        };
        let mut out = Output::new(&c, vec![part]);
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: W,
            height: H,
            rgba: old.rgba,
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        out.emit(
            &c,
            &old,
            Some(&old),
            &fp,
            &vt,
            (0, 0),
            24,
            0,
            &main,
            &mut writes,
        );
        out.emit(
            &c,
            &later,
            Some(&later),
            &fp,
            &tm,
            (0, 0),
            24,
            1,
            &main,
            &mut writes,
        );
        assert_eq!(
            out.frame[5], 1,
            "an opaque first-pass reference cannot label a genuinely cleaner boundary transient"
        );
    }
    struct LocalReference(fn(i64, i64) -> [u8; 3]);
    impl CellRef for LocalReference {
        fn cell(&self, x: i64, y: i64) -> Option<[u8; 3]> {
            Some((self.0)(x, y))
        }
        fn cells(&self) -> (i64, i64, i64, i64) {
            (-1000, -1000, 1000, 1000)
        }
    }
    fn signature(reference: &impl CellRef) -> BlockSignature {
        std::array::from_fn(|k| {
            reference
                .cell((k % SIDE) as i64, (k / SIDE) as i64)
                .unwrap()
        })
    }
    #[test]
    fn strict_agreement_rejects_structure_absent_from_a_smooth_reference() {
        let reference = LocalReference(|_, _| [230; 3]);
        let expected = signature(&reference);
        let mut observed = expected;
        observed[3 * SIDE + 3] = [190; 3];
        let difference = compare(&observed, &expected);
        assert!(agrees(difference, 24));
        assert_eq!(
            difference.2, 0,
            "the legacy 48-level outlier threshold misses this mark"
        );
        assert!(
            !agrees_strictly(difference, 24, &observed, &reference, (0, 0)),
            "an isolated low-contrast mark is not codec phase on a flat page"
        );
    }
    #[test]
    fn strict_agreement_keeps_phase_changes_at_real_edges_including_block_boundaries() {
        for edge in [0, 4] {
            let reference = LocalReference(if edge == 0 {
                |x, y| [if x < 0 && y < 4 { 140 } else { 80 }; 3]
            } else {
                |x, y| [if x >= 4 && y < 4 { 140 } else { 80 }; 3]
            });
            let expected = signature(&reference);
            let mut observed = expected;
            // A one-native-pixel phase shift mixes the two sides in four 2x2 cells.
            let column = if edge == 0 { 0 } else { 3 };
            for y in 0..4 {
                observed[y * SIDE + column] = [110; 3];
            }
            let difference = compare(&observed, &expected);
            assert!(
                agrees_strictly(difference, 24, &observed, &reference, (0, 0)),
                "real contrast across a block boundary must remain available as phase evidence"
            );
        }
    }
    #[test]
    fn a_small_transient_cannot_freeze_an_otherwise_static_block() {
        let (width, height) = (160, 160);
        let mut clean = solid_frame(width, height, 230);
        for y in 0..height {
            for x in 0..width {
                let value = if (x / 8 + y / 8) % 2 == 0 { 230 } else { 248 };
                clean[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(value);
            }
        }
        let mut transient = clean.clone();
        for y in 66..68 {
            for x in 66..68 {
                transient[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(190);
            }
        }
        let mask = vec![1; width * height];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width,
            height,
            mask: &mask,
        };
        let tier = vec![TIER_CLEAN; width * height / (CELL * CELL)];
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: width / CELL,
            ch: height / CELL,
            tier: &tier,
        };
        let clean_frame = Frame {
            rgba: &clean,
            width,
            height,
        };
        let mut consensus = Consensus::new(Grid::covering(0, 0, width, height));
        // The checker period is 16 pixels; these are distinct, consistent world views.
        for x in [0, 16, 32] {
            consensus.observe(&clean_frame, &footprint, &tiers, (x, 0));
        }
        let mut output = Output::new(&consensus, components(&consensus));
        let coverage = vec![255; width * height / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width,
            height,
            rgba: &clean,
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        output.emit(
            &consensus,
            &Frame {
                rgba: &transient,
                width,
                height,
            },
            None,
            &footprint,
            &tiers,
            (0, 0),
            24,
            0,
            &main,
            &mut writes,
        );
        output.emit(
            &consensus,
            &clean_frame,
            None,
            &footprint,
            &tiers,
            (16, 0),
            24,
            1,
            &main,
            &mut writes,
        );
        let block = 4 * consensus.grid.bw + 4;
        assert_eq!(
            output.frame[block], 1,
            "the later clean view must replace the small transient"
        );
        assert_eq!(output.kind[block], Kind::Coherent);
    }
    #[test]
    fn local_contrast_allows_decode_noise_on_top_of_a_phase_shift() {
        let reference = LocalReference(|x, y| [if x < 0 && y < 4 { 120 } else { 100 }; 3]);
        let expected = signature(&reference);
        let mut observed = expected;
        for y in 0..4 {
            observed[y * SIDE] = [124; 3];
        }
        let difference = compare(&observed, &expected);
        assert!(agrees_strictly(difference,24,&observed,&reference,(0,0)),"a real 20-level edge plus four levels of decode noise is still a valid phase observation");
    }
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum WeakUpdate {
        Persistent,
        Moving,
        SettledStill,
        LastFramePulse,
    }

    fn weak_update_source(mode: WeakUpdate) -> (i32, Kind) {
        let persistent = mode != WeakUpdate::Moving;
        let views = if mode == WeakUpdate::SettledStill {
            2
        } else {
            3
        };
        let (width, height) = (160, 160);
        let old = solid_frame(width, height, 230);
        let mut first = old.clone();
        let mut second = old.clone();
        for y in 66..68 {
            for x in 66..68 {
                first[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(190);
            }
        }
        let second_x = if persistent { 50 } else { 54 };
        for y in 66..68 {
            for x in second_x..second_x + 2 {
                second[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(190);
            }
        }
        let mask = vec![1; width * height];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width,
            height,
            mask: &mask,
        };
        let tier = vec![TIER_CLEAN; width * height / (CELL * CELL)];
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: width / CELL,
            ch: height / CELL,
            tier: &tier,
        };
        let frames = [
            Frame {
                rgba: &old,
                width,
                height,
            },
            Frame {
                rgba: &first,
                width,
                height,
            },
            Frame {
                rgba: &second,
                width,
                height,
            },
        ];
        let poses = [(-80, 0), (0, 0), (16, 0)];
        let mut consensus = Consensus::new(Grid::covering(-80, 0, 256, height));
        for (frame, pose) in frames.iter().zip(poses).take(views) {
            consensus.observe(frame, &footprint, &tiers, pose);
        }
        let mut output = Output::new(&consensus, components(&consensus));
        let main_pixels = solid_frame(256, height, 230);
        let coverage = vec![255; 256 * height / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: -80,
            y: 0,
            width: 256,
            height,
            rgba: &main_pixels,
            coverage: &coverage,
        });
        let mut writes = Vec::new();
        for (index, (frame, pose)) in frames.iter().zip(poses).take(views).enumerate() {
            let before = match (mode, index) {
                (WeakUpdate::SettledStill, 1) => Some(&frames[1]),
                (WeakUpdate::LastFramePulse, 2) => Some(&frames[0]),
                _ => None,
            };
            output.emit(
                &consensus,
                frame,
                before,
                &footprint,
                &tiers,
                pose,
                24,
                index as u32,
                &main,
                &mut writes,
            );
        }
        let block = 4 * consensus.grid.bw + (4 - consensus.grid.gx) as usize;
        (output.frame[block], output.kind[block])
    }
    #[test]
    fn persistent_weak_content_can_replace_an_earlier_edge_view() {
        let (source, kind) = weak_update_source(WeakUpdate::Persistent);
        assert!(
            source == 1 || source == 2,
            "a newly loaded weak mark must not be lost merely because the early reference is blank"
        );
        assert_eq!(kind, Kind::Coherent);
    }
    #[test]
    fn different_weak_marks_do_not_corroborate_each_other() {
        let (source, kind) = weak_update_source(WeakUpdate::Moving);
        assert_eq!(
            source, 0,
            "two moving marks that merely both resemble the reference are not corroboration"
        );
        assert_ne!(kind, Kind::Coherent);
    }
    #[test]
    fn weak_content_can_settle_at_the_end_of_one_pose() {
        let (source, kind) = weak_update_source(WeakUpdate::SettledStill);
        assert_eq!(
            source, 1,
            "the actual previous still frame can corroborate freshly loaded content"
        );
        assert_eq!(kind, Kind::Coherent);
    }
    #[test]
    fn an_old_witness_cannot_confirm_a_new_pulse_at_the_end_of_a_still_run() {
        let (source, kind) = weak_update_source(WeakUpdate::LastFramePulse);
        assert_eq!(
            source, 0,
            "a contradictory immediate predecessor overrides the older witness"
        );
        assert_ne!(kind, Kind::Coherent);
    }
    // A weak transient can resemble sampling phase beside a real edge. Spatial
    // plausibility alone must not permanently lock it; genuine repeated phase
    // remains admissible after a second independent observation.
    #[test]
    fn phase_compatible_edges_need_temporal_evidence_before_becoming_permanent() {
        let size = 128;
        let edge = |at: usize| {
            let mut rgba = solid_frame(size, size, 190);
            for y in 0..size {
                for x in at..size {
                    rgba[(y * size + x) * 4..(y * size + x) * 4 + 3].fill(210);
                }
            }
            rgba
        };
        let base = edge(66);
        let coverage = vec![255; size * size / 8];
        let main = CellMap::from_canvas(&CanvasView {
            x: 0,
            y: 0,
            width: size,
            height: size,
            rgba: &base,
            coverage: &coverage,
        });
        let mask = vec![1; size * size];
        let clean = vec![TIER_CLEAN; size * size / 4];
        let fp = Footprint {
            x: 0,
            y: 0,
            width: size,
            height: size,
            mask: &mask,
        };
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: size / 2,
            ch: size / 2,
            tier: &clean,
        };
        let reference = Frame {
            rgba: &base,
            width: size,
            height: size,
        };
        for persistent in [false, true] {
            let mut consensus = Consensus::new(Grid::covering(0, 0, size, size));
            for _ in 0..4 {
                consensus.observe(&reference, &fp, &tiers, (0, 0));
            }
            let target = 4 * consensus.grid.bw + 4;
            let mut output = Output::new(&consensus, components(&consensus));
            let mut first = if persistent { edge(64) } else { base.clone() };
            if !persistent {
                for y in 66..78 {
                    for x in 64..66 {
                        first[(y * size + x) * 4..(y * size + x) * 4 + 3].fill(210);
                    }
                }
            }
            output.emit(
                &consensus,
                &Frame {
                    rgba: &first,
                    width: size,
                    height: size,
                },
                None,
                &fp,
                &tiers,
                (0, 0),
                24,
                0,
                &main,
                &mut Vec::new(),
            );
            assert_ne!(
                output.kind[target],
                Kind::Coherent,
                "a phase-sized protrusion is not yet independently confirmed"
            );
            if persistent {
                assert!(output.finish(&consensus,24).iter().any(|part|part.gx==4 && part.gy==4 && part.frame==0),
                    "a lone valid phase view stays available; deferring a lock must not discard its pixels");
            }
            let second = edge(if persistent { 63 } else { 65 });
            output.emit(
                &consensus,
                &Frame {
                    rgba: &second,
                    width: size,
                    height: size,
                },
                None,
                &fp,
                &tiers,
                (1, 0),
                24,
                1,
                &main,
                &mut Vec::new(),
            );
            assert_eq!(
                output.kind[target],
                Kind::Coherent,
                "a clean reference match or a corroborated phase is accepted"
            );
            assert_eq!(output.frame[target], 1);
        }
    }
}
