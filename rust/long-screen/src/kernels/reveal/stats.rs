//! Per-layer screen statistics: how each 2×2 screen cell's observation compares with the canvas content at
//! the same world position, accumulated over every distinct pose.
//!
//! A cell over page content agrees with the canvas whatever scrolls beneath it. A cell under an opaque overlay
//! keeps disagreeing with a stable colour of its own; a cell under a translucent veil passes an attenuated copy
//! of the page (observed luma ≈ a·page + b with a < 1). The luma moments give that regression slope; the sums
//! over disagreeing observations give the overlay's appearance (its template).

use super::{luma, CanvasView, Footprint, Frame, CELL};

/// World-aligned 2×2 cell means of a canvas: the reference the statistics compare against.
pub trait CellRef {
    /// Mean colour of world cell (cx, cy) (world pixels 2cx..2cx+1, 2cy..2cy+1), if the whole cell is known.
    fn cell(&self, cx: i64, cy: i64) -> Option<[u8; 3]>;
    /// World cell rectangle that may hold known cells: (cx0, cy0, cx1, cy1), half-open.
    fn cells(&self) -> (i64, i64, i64, i64);
}

/// A [`CellRef`] built once from canvas pixels.
pub struct CellMap {
    pub cx0: i64,
    pub cy0: i64,
    pub cw: usize,
    pub ch: usize,
    /// RGB + known flag per cell.
    pub rgbk: Vec<[u8; 4]>,
}

impl CellMap {
    /// An empty map over the world cells covering the rectangle (x, y, width, height).
    pub fn covering(x: i64, y: i64, width: usize, height: usize) -> Self {
        let c = CELL as i64;
        let (cx0, cy0) = (x.div_euclid(c), y.div_euclid(c));
        let (cx1, cy1) = (
            (x + width as i64 + c - 1).div_euclid(c),
            (y + height as i64 + c - 1).div_euclid(c),
        );
        let (cw, ch) = ((cx1 - cx0).max(0) as usize, (cy1 - cy0).max(0) as usize);
        Self {
            cx0,
            cy0,
            cw,
            ch,
            rgbk: vec![[0u8; 4]; cw * ch],
        }
    }

    /// Fills the cells lying wholly inside `view` whose four pixels are covered. Tiles are world-aligned on even
    /// coordinates, so a canvas fed tile by tile fills every wholly covered cell exactly once.
    pub fn ingest(&mut self, view: &CanvasView<'_>) {
        let c = CELL as i64;
        let x0 = ((view.x + c - 1).div_euclid(c)).max(self.cx0);
        let y0 = ((view.y + c - 1).div_euclid(c)).max(self.cy0);
        let x1 = ((view.x + view.width as i64).div_euclid(c)).min(self.cx0 + self.cw as i64);
        let y1 = ((view.y + view.height as i64).div_euclid(c)).min(self.cy0 + self.ch as i64);
        for cy in y0..y1 {
            for cx in x0..x1 {
                let (wx, wy) = (cx * c, cy * c);
                let mut s = [0u32; 3];
                let mut ok = true;
                'px: for dy in 0..c {
                    for dx in 0..c {
                        match view.covered(wx + dx, wy + dy) {
                            Some(i) => {
                                for (k, v) in s.iter_mut().enumerate() {
                                    *v += view.rgba[i * 4 + k] as u32;
                                }
                            }
                            None => {
                                ok = false;
                                break 'px;
                            }
                        }
                    }
                }
                if ok {
                    let q = (CELL * CELL) as u32;
                    self.rgbk[(cy - self.cy0) as usize * self.cw + (cx - self.cx0) as usize] = [
                        ((s[0] + q / 2) / q) as u8,
                        ((s[1] + q / 2) / q) as u8,
                        ((s[2] + q / 2) / q) as u8,
                        1,
                    ];
                }
            }
        }
    }

    pub fn from_canvas(view: &CanvasView<'_>) -> Self {
        let mut m = Self::covering(view.x, view.y, view.width, view.height);
        m.ingest(view);
        m
    }
}

impl CellRef for CellMap {
    #[inline]
    fn cell(&self, cx: i64, cy: i64) -> Option<[u8; 3]> {
        let (x, y) = (cx - self.cx0, cy - self.cy0);
        if x < 0 || y < 0 || x >= self.cw as i64 || y >= self.ch as i64 {
            return None;
        }
        let v = self.rgbk[y as usize * self.cw + x as usize];
        (v[3] != 0).then_some([v[0], v[1], v[2]])
    }
    fn cells(&self) -> (i64, i64, i64, i64) {
        (
            self.cx0,
            self.cy0,
            self.cx0 + self.cw as i64,
            self.cy0 + self.ch as i64,
        )
    }
}

/// Accumulators of one screen cell.
#[derive(Clone, Copy, Default)]
pub struct Acc {
    /// Comparisons and disagreements.
    pub n: u16,
    pub bad: u16,
    /// Luma moments of (reference r, observation o): Σr, Σo, Σr², Σro, Σo².
    pub sr: u32,
    pub so: u32,
    pub srr: u32,
    pub sro: u32,
    pub soo: u32,
    /// Over disagreeing observations only: Σ RGB and Σ luma, Σ luma² (the overlay's appearance and spread).
    pub br: u32,
    pub bg: u32,
    pub bb: u32,
    pub bl: u32,
    pub bll: u32,
}

impl Acc {
    #[inline]
    fn add(&mut self, o: [u32; 3], r: [u32; 3], tau: i32) {
        if self.n == u16::MAX {
            return;
        }
        let lo = luma(o[0] as u8, o[1] as u8, o[2] as u8);
        let lr = luma(r[0] as u8, r[1] as u8, r[2] as u8);
        let d = (o[0] as i32 - r[0] as i32)
            .abs()
            .max((o[1] as i32 - r[1] as i32).abs())
            .max((o[2] as i32 - r[2] as i32).abs());
        self.n += 1;
        self.sr += lr;
        self.so += lo;
        self.srr += lr * lr;
        self.sro += lr * lo;
        self.soo += lo * lo;
        if d > tau {
            self.bad += 1;
            self.br += o[0];
            self.bg += o[1];
            self.bb += o[2];
            self.bl += lo;
            self.bll += lo * lo;
        }
    }
}

#[derive(Clone)]
pub struct LayerStats {
    /// Screen origin of the layer rectangle (native pixels) and its size in cells.
    pub x: i64,
    pub y: i64,
    pub cw: usize,
    pub ch: usize,
    pub cells: Vec<Acc>,
}

impl LayerStats {
    pub fn new(x: i64, y: i64, width: usize, height: usize) -> Self {
        let (cw, ch) = (width.div_ceil(CELL), height.div_ceil(CELL));
        Self {
            x,
            y,
            cw,
            ch,
            cells: vec![Acc::default(); cw * ch],
        }
    }

    /// One field of every cell, widened.
    pub fn field(&self, f: impl Fn(&Acc) -> u32) -> Vec<u32> {
        self.cells.iter().map(f).collect()
    }

    /// Adds one observation against world-aligned reference cells: every world cell whose four screen pixels
    /// (world − pose) are in the footprint and whose reference is known. The observation is binned on the same
    /// world-aligned grid, so an odd pose never compares across a sub-cell phase; it is credited to the screen
    /// cell holding the world cell's top-left pixel (one world cell per screen cell, so rows of world cells
    /// write disjoint rows of screen cells and run in parallel).
    pub fn accumulate_cells<R: CellRef + Sync + ?Sized>(
        &mut self,
        frame: &Frame<'_>,
        footprint: &Footprint<'_>,
        reference: &R,
        pose: (i64, i64),
        tau: i32,
    ) -> usize {
        let (px, py) = pose;
        let c = CELL as i64;
        let (rx0, ry0, rx1, ry1) = reference.cells();
        let wx0 = (footprint.x + px).div_euclid(c).max(rx0);
        let wy0 = (footprint.y + py).div_euclid(c).max(ry0);
        let wx1 = (footprint.x + footprint.width as i64 + px + c - 1)
            .div_euclid(c)
            .min(rx1);
        let wy1 = (footprint.y + footprint.height as i64 + py + c - 1)
            .div_euclid(c)
            .min(ry1);
        if wx1 <= wx0 || wy1 <= wy0 {
            return 0;
        }
        let rows = (wy1 - wy0) as usize;
        let chunks = crate::kernels::pool::chunks_for(rows * (wx1 - wx0) as usize, 8192);
        let mut counts = vec![0usize; chunks];
        let cells = crate::kernels::pool::SyncPtr(self.cells.as_mut_ptr());
        let counted = crate::kernels::pool::SyncPtr(counts.as_mut_ptr());
        let (lx0, ly0, cw, ch) = (self.x, self.y, self.cw as i64, self.ch as i64);
        let (w, h) = (frame.width as i64, frame.height as i64);
        let (fx0, fy0, fw, fh) = (
            footprint.x,
            footprint.y,
            footprint.width as i64,
            footprint.height as i64,
        );
        crate::kernels::pool::par_for(chunks, |k| {
            let (a, b) = (
                crate::kernels::pool::split(rows, chunks, k),
                crate::kernels::pool::split(rows, chunks, k + 1),
            );
            let mut compared = 0usize;
            for r in a..b {
                let cy = wy0 + r as i64;
                let sy = cy * c - py;
                let (ly, my) = ((sy - ly0).div_euclid(c), sy - fy0);
                if sy < 0 || sy + c > h || ly < 0 || ly >= ch || my < 0 || my + c > fh {
                    continue;
                }
                let (m0, m1) = (
                    &footprint.mask[(my * fw) as usize..((my + 1) * fw) as usize],
                    &footprint.mask[((my + 1) * fw) as usize..((my + 2) * fw) as usize],
                );
                let (f0, f1) = (
                    &frame.rgba[(sy * w * 4) as usize..((sy + 1) * w * 4) as usize],
                    &frame.rgba[((sy + 1) * w * 4) as usize..((sy + 2) * w * 4) as usize],
                );
                // The cells of this row inside the frame, the layer's cell grid and the footprint rectangle, found
                // once: sx = 2cx - px, lx = cx - k (the layer cell holding sx), mx = sx - fx0.
                let k = (px + lx0 + 1).div_euclid(c);
                let lo = [wx0, (px + 1).div_euclid(c), k, (fx0 + px + 1).div_euclid(c)];
                let hi = [
                    wx1,
                    (w - c + px).div_euclid(c) + 1,
                    cw + k,
                    (fx0 + fw - c + px).div_euclid(c) + 1,
                ];
                let (cx_lo, cx_hi) = (lo.into_iter().max().unwrap(), hi.into_iter().min().unwrap());
                if cx_hi <= cx_lo {
                    continue;
                }
                // The run of cells walked in step: two mask bytes and two RGBA pixels of each of the cell's two rows,
                // and the accumulator of the layer cell it is credited to (sx = 2cx - px, mx = sx - fx0, lx = cx - k).
                let n = (cx_hi - cx_lo) as usize;
                let sx0 = cx_lo * c - px;
                let (mx0, i0) = ((sx0 - fx0) as usize, sx0 as usize * 4);
                // SAFETY: world row `cy` maps to screen-cell row `ly` alone, chunks own disjoint world rows, and
                // `cx_lo - k .. cx_hi - k` lies inside the layer's `cw` cells.
                let accs = unsafe {
                    std::slice::from_raw_parts_mut(
                        cells.get().add((ly * cw + cx_lo - k) as usize),
                        n,
                    )
                };
                let masks = m0[mx0..mx0 + 2 * n]
                    .chunks_exact(2)
                    .zip(m1[mx0..mx0 + 2 * n].chunks_exact(2));
                let pixels = f0[i0..i0 + 8 * n]
                    .chunks_exact(8)
                    .zip(f1[i0..i0 + 8 * n].chunks_exact(8));
                for (cx, (((a, b), (p, q)), acc)) in
                    (cx_lo..cx_hi).zip(masks.zip(pixels).zip(accs.iter_mut()))
                {
                    if a[0] == 0 || a[1] == 0 || b[0] == 0 || b[1] == 0 {
                        continue;
                    }
                    let Some(rv) = reference.cell(cx, cy) else {
                        continue;
                    };
                    let o: [u32; 3] = std::array::from_fn(|k| {
                        (p[k] as u32 + p[4 + k] as u32 + q[k] as u32 + q[4 + k] as u32 + 2) / 4
                    });
                    acc.add(o, [rv[0] as u32, rv[1] as u32, rv[2] as u32], tau);
                    compared += 1;
                }
            }
            // SAFETY: each chunk writes its own slot.
            unsafe { *counted.get().add(k) = compared };
        });
        counts.iter().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::reveal::{CanvasView, Footprint, Frame};

    // Failure cases of walking a row of cells over slices: an off-by-one at either end of the run (the frame edge, the
    // footprint edge, the layer's last cell, an odd pose putting the cell's second column outside), a mask byte read
    // from the wrong column or row, a cell credited to the wrong accumulator, a cell the reference does not know
    // compared anyway, or the count of compared cells differing from the cells actually added.

    /// A small deterministic generator (the tests need varied layouts, not statistical quality).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
        fn below(&mut self, n: u32) -> u32 {
            self.next() % n
        }
    }

    /// Every world cell checked one by one against the definition in `accumulate_cells`'s documentation.
    fn naive<R: CellRef + Sync>(
        stats: &mut LayerStats,
        frame: &Frame<'_>,
        fp: &Footprint<'_>,
        reference: &R,
        pose: (i64, i64),
        tau: i32,
    ) -> usize {
        let (px, py) = pose;
        let c = CELL as i64;
        let (rx0, ry0, rx1, ry1) = reference.cells();
        let mut compared = 0;
        for cy in ry0..ry1 {
            for cx in rx0..rx1 {
                let (sx, sy) = (cx * c - px, cy * c - py);
                let inside = |x: i64, y: i64| {
                    x >= 0
                        && y >= 0
                        && x < frame.width as i64
                        && y < frame.height as i64
                        && x >= fp.x
                        && y >= fp.y
                        && x < fp.x + fp.width as i64
                        && y < fp.y + fp.height as i64
                        && fp.mask[((y - fp.y) * fp.width as i64 + (x - fp.x)) as usize] != 0
                };
                if !(inside(sx, sy)
                    && inside(sx + 1, sy)
                    && inside(sx, sy + 1)
                    && inside(sx + 1, sy + 1))
                {
                    continue;
                }
                let (lx, ly) = ((sx - stats.x).div_euclid(c), (sy - stats.y).div_euclid(c));
                if lx < 0 || ly < 0 || lx >= stats.cw as i64 || ly >= stats.ch as i64 {
                    continue;
                }
                let Some(rv) = reference.cell(cx, cy) else {
                    continue;
                };
                let px_at = |x: i64, y: i64, k: usize| {
                    frame.rgba[(y as usize * frame.width + x as usize) * 4 + k] as u32
                };
                let o: [u32; 3] = std::array::from_fn(|k| {
                    (px_at(sx, sy, k)
                        + px_at(sx + 1, sy, k)
                        + px_at(sx, sy + 1, k)
                        + px_at(sx + 1, sy + 1, k)
                        + 2)
                        / 4
                });
                stats.cells[(ly * stats.cw as i64 + lx) as usize].add(
                    o,
                    [rv[0] as u32, rv[1] as u32, rv[2] as u32],
                    tau,
                );
                compared += 1;
            }
        }
        compared
    }

    #[test]
    fn a_row_of_cells_walked_in_step_is_every_cell_checked_one_by_one() {
        let mut rng = Lcg(7);
        let key = |c: &Acc| {
            (
                c.n, c.bad, c.sr, c.so, c.srr, c.sro, c.soo, c.br, c.bg, c.bb, c.bl, c.bll,
            )
        };
        for case in 0..300 {
            let (w, h) = (8 + rng.below(30) as usize, 6 + rng.below(24) as usize);
            let rgba: Vec<u8> = (0..w * h * 4).map(|_| rng.below(256) as u8).collect();
            // The reference canvas: random pixels, about one pixel in eight not covered.
            let (vx, vy) = (rng.below(9) as i64 - 4, rng.below(9) as i64 - 4);
            let (vw, vh) = (w + rng.below(6) as usize, h + rng.below(6) as usize);
            let canvas: Vec<u8> = (0..vw * vh * 4).map(|_| rng.below(256) as u8).collect();
            let mut coverage = vec![0u8; (vw * vh).div_ceil(8)];
            for i in 0..vw * vh {
                if rng.below(8) != 0 {
                    coverage[i >> 3] |= 1 << (i & 7);
                }
            }
            let reference = CellMap::from_canvas(&CanvasView {
                x: vx,
                y: vy,
                width: vw,
                height: vh,
                rgba: &canvas,
                coverage: &coverage,
            });
            // A layer and a footprint that each may be offset from the frame and cut by its edges.
            let (lx, ly) = (rng.below(5) as i64 - 2, rng.below(5) as i64 - 2);
            let (fx, fy) = (rng.below(5) as i64 - 2, rng.below(5) as i64 - 2);
            let (fw, fh) = (w - rng.below(4) as usize, h - rng.below(4) as usize);
            let mask: Vec<u8> = (0..fw * fh).map(|_| u8::from(rng.below(6) != 0)).collect();
            let fp = Footprint {
                x: fx,
                y: fy,
                width: fw,
                height: fh,
                mask: &mask,
            };
            let frame = Frame {
                rgba: &rgba,
                width: w,
                height: h,
            };
            let pose = (rng.below(11) as i64 - 5, rng.below(11) as i64 - 5);
            let tau = rng.below(40) as i32;
            let mut walked =
                LayerStats::new(lx, ly, w - rng.below(3) as usize, h - rng.below(3) as usize);
            let mut checked = walked.clone();
            let n_walked = walked.accumulate_cells(&frame, &fp, &reference, pose, tau);
            let n_checked = naive(&mut checked, &frame, &fp, &reference, pose, tau);
            assert_eq!(n_walked, n_checked, "case {case}: compared cells");
            assert!(
                walked
                    .cells
                    .iter()
                    .map(key)
                    .eq(checked.cells.iter().map(key)),
                "case {case}: accumulators differ"
            );
        }
    }
}
