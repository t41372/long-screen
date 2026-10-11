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
                for cx in cx_lo..cx_hi.max(cx_lo) {
                    let sx = cx * c - px;
                    let (lx, mx) = (cx - k, (sx - fx0) as usize);
                    if m0[mx] == 0 || m0[mx + 1] == 0 || m1[mx] == 0 || m1[mx + 1] == 0 {
                        continue;
                    }
                    let Some(rv) = reference.cell(cx, cy) else {
                        continue;
                    };
                    let i = sx as usize * 4;
                    let mut o = [0u32; 3];
                    for (k, v) in o.iter_mut().enumerate() {
                        *v = (f0[i + k] as u32
                            + f0[i + 4 + k] as u32
                            + f1[i + k] as u32
                            + f1[i + 4 + k] as u32
                            + 2)
                            / 4;
                    }
                    // SAFETY: world row `cy` maps to screen-cell row `ly` alone, and chunks own disjoint world rows.
                    let acc = unsafe { &mut *cells.get().add((ly * cw + lx) as usize) };
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
