//! Which parts of a moving region stay on screen while the region moves: a map's status bar, search bar, chips,
//! watermark and buttons float over it, and a sticky header or side panel can sit inside a scrolling page. Their
//! pixels match at zero offset on every frame, so the odometry's zero-offset hypothesis, the keyframe patches and
//! relocalization all lock onto them and pull the pose back. Registration leaves these cells out; the output region
//! and its ownership do not change.
//!
//! The evidence is the layer learner's stationary-versus-motion test (`kernels::layers::Learner::add`), taken on the
//! steps the solve pass itself measured: at a sampled analysis pixel standing still explains the frame better than
//! the measured step by more than [`MARGIN`] levels, or the reverse. A cell stayed in a frame when such pixels
//! outnumber the ones that followed the step, and followed when the reverse holds.

use crate::kernels::geometry::js_hypot;

/// Side of a cell, in analysis pixels.
pub const CELL: usize = 8;
/// Analysis pixels a cell samples per axis (every second one).
const SAMPLE: usize = 2;
/// Grey levels by which one explanation must beat the other for the pixel to vote, as in `Learner::add`.
const MARGIN: i32 = 6;
/// A step shorter than this many analysis pixels does not separate staying from following on soft texture.
pub const MIN_STEP: f64 = 2.0;
/// Pixels of one kind a cell needs in a frame for its verdict that frame.
const MIN_VOTES: u32 = 2;
/// Frames in which a cell must have stayed while the region moved before registration leaves it out.
const STAYED_FRAMES: u16 = 6;
/// It must also have stayed this many times as often as it followed the region.
const STAYED_RATIO: u16 = 4;
/// A region more than this share of whose voting cells stayed is not a page with something floating over it: the
/// measured steps belong to something inside it (a nested pane), and nothing is left out.
const MAX_SHARE: f64 = 0.5;

/// Per-cell evidence over one moving region's analysis rectangle.
pub struct ScreenFixed {
    x0: i64,
    y0: i64,
    cols: usize,
    rows: usize,
    stayed: Vec<u16>,
    followed: Vec<u16>,
    /// The cells registration leaves out (one cell of margin included); empty while none qualifies.
    excluded: Vec<bool>,
    any: bool,
}

impl ScreenFixed {
    /// Cells over the analysis rectangle `[x0, x0 + width) × [y0, y0 + height)`.
    pub fn new(x0: i64, y0: i64, width: usize, height: usize) -> ScreenFixed {
        let (cols, rows) = (width.div_ceil(CELL).max(1), height.div_ceil(CELL).max(1));
        ScreenFixed {
            x0,
            y0,
            cols,
            rows,
            stayed: vec![0; cols * rows],
            followed: vec![0; cols * rows],
            excluded: Vec::new(),
            any: false,
        }
    }

    /// Whether any cell is left out.
    pub fn any(&self) -> bool {
        self.any
    }

    /// Whether registration leaves out analysis pixel (`x`, `y`).
    pub fn excludes(&self, x: f64, y: f64) -> bool {
        if !self.any {
            return false;
        }
        let (cx, cy) = (
            (x.floor() as i64 - self.x0).div_euclid(CELL as i64),
            (y.floor() as i64 - self.y0).div_euclid(CELL as i64),
        );
        cx >= 0
            && cy >= 0
            && (cx as usize) < self.cols
            && (cy as usize) < self.rows
            && self.excluded[cy as usize * self.cols + cx as usize]
    }

    /// Adds one measured step. `previous`/`current` are `width`-wide analysis grays, `step` the region's step in
    /// analysis pixels (content at (x, y) now was at (x + step.0, y + step.1) before), `inside` the region's
    /// membership of an analysis pixel. Returns whether the set of left-out cells changed.
    pub fn observe(
        &mut self,
        previous: &[u8],
        current: &[u8],
        width: usize,
        height: usize,
        step: (f64, f64),
        inside: impl Fn(i64, i64) -> bool,
    ) -> bool {
        if js_hypot(step.0, step.1) < MIN_STEP {
            return false;
        }
        let (w, h) = (width as i64, height as i64);
        // A step that leaves no overlap (or is not a number) shows nothing about what stayed.
        if !(step.0.abs() < w as f64 && step.1.abs() < h as f64) {
            return false;
        }
        let (dx, dy) = (step.0.round() as i64, step.1.round() as i64);
        for cy in 0..self.rows {
            for cx in 0..self.cols {
                let (mut fixed, mut moving) = (0u32, 0u32);
                let (bx, by) = (self.x0 + (cx * CELL) as i64, self.y0 + (cy * CELL) as i64);
                for y in (by..by + CELL as i64).step_by(SAMPLE) {
                    for x in (bx..bx + CELL as i64).step_by(SAMPLE) {
                        let (sx, sy) = (x + dx, y + dy);
                        if x < 0
                            || y < 0
                            || x >= w
                            || y >= h
                            || sx < 0
                            || sy < 0
                            || sx >= w
                            || sy >= h
                            || !inside(x, y)
                        {
                            continue;
                        }
                        let c = current[(y * w + x) as usize] as i32;
                        let still = (previous[(y * w + x) as usize] as i32 - c).abs();
                        let followed = (previous[(sy * w + sx) as usize] as i32 - c).abs();
                        if still + MARGIN < followed {
                            fixed += 1;
                        } else if followed + MARGIN < still {
                            moving += 1;
                        }
                    }
                }
                let i = cy * self.cols + cx;
                if fixed >= MIN_VOTES && fixed > moving {
                    self.stayed[i] = self.stayed[i].saturating_add(1);
                } else if moving >= MIN_VOTES && moving > fixed {
                    self.followed[i] = self.followed[i].saturating_add(1);
                }
            }
        }
        self.settle()
    }

    fn settle(&mut self) -> bool {
        let qualifies = |i: usize| {
            self.stayed[i] >= STAYED_FRAMES
                && self.stayed[i] >= STAYED_RATIO.saturating_mul(self.followed[i])
        };
        let (mut core, mut voting) = (0usize, 0usize);
        for i in 0..self.stayed.len() {
            if self.stayed[i] > 0 || self.followed[i] > 0 {
                voting += 1;
            }
            if qualifies(i) {
                core += 1;
            }
        }
        let mut excluded = Vec::new();
        if core > 0 && (core as f64) <= MAX_SHARE * voting as f64 {
            excluded = vec![false; self.stayed.len()];
            for cy in 0..self.rows {
                for cx in 0..self.cols {
                    if !qualifies(cy * self.cols + cx) {
                        continue;
                    }
                    for ny in cy.saturating_sub(1)..(cy + 2).min(self.rows) {
                        for nx in cx.saturating_sub(1)..(cx + 2).min(self.cols) {
                            excluded[ny * self.cols + nx] = true;
                        }
                    }
                }
            }
        }
        let any = !excluded.is_empty();
        let changed = excluded != self.excluded;
        self.excluded = excluded;
        self.any = any;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 96;
    const H: usize = 96;

    /// Hashed texture of world pixel (x, y).
    fn texture(x: i64, y: i64) -> u8 {
        let v = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) as u64;
        (v.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
    }

    /// A page scrolled by `offset` rows, with rows `[0, bar)` a textured bar that stays on screen and rows
    /// `[bar, flat)` a flat bar that stays.
    fn frame(offset: i64, bar: usize, flat: usize) -> Vec<u8> {
        let mut out = vec![0u8; W * H];
        for y in 0..H {
            for x in 0..W {
                out[y * W + x] = if y < bar {
                    texture(x as i64 + 5000, y as i64)
                } else if y < flat {
                    200
                } else {
                    texture(x as i64, y as i64 + offset)
                };
            }
        }
        out
    }

    fn run(frames: usize, step: i64, bar: usize, flat: usize) -> ScreenFixed {
        let mut s = ScreenFixed::new(0, 0, W, H);
        for k in 0..frames as i64 {
            let (a, b) = (frame(k * step, bar, flat), frame((k + 1) * step, bar, flat));
            // Content now at y was at y + step before.
            s.observe(&a, &b, W, H, (0.0, step as f64), |_, _| true);
        }
        s
    }

    // Failure case: a textured bar that stays while the page scrolls under it is registered with the page.
    #[test]
    fn a_textured_bar_that_stays_is_left_out_and_the_page_is_not() {
        let s = run(STAYED_FRAMES as usize, 5, 16, 16);
        assert!(s.any());
        assert!(s.excludes(40.0, 4.0));
        assert!(s.excludes(40.0, 15.0));
        // One cell of margin below the bar, nothing further down.
        assert!(s.excludes(40.0, 20.0));
        assert!(!s.excludes(40.0, 30.0));
        assert!(!s.excludes(40.0, 90.0));
    }

    // Failure case: one frame's coincidence leaves a cell out.
    #[test]
    fn a_bar_is_left_out_only_after_enough_frames() {
        let s = run(STAYED_FRAMES as usize - 1, 5, 16, 16);
        assert!(!s.any());
        assert!(!s.excludes(40.0, 4.0));
    }

    // Failure case: a step within analysis jitter casts votes.
    #[test]
    fn a_short_step_casts_no_votes() {
        let s = run(3 * STAYED_FRAMES as usize, 1, 16, 16);
        assert!(!s.any());
    }

    // Failure case: flat chrome (or blank page) counts as staying; it holds no texture to pull a match. Only its
    // edge against the page does, and that edge is left out.
    #[test]
    fn a_flat_bar_is_left_out_only_at_its_edge() {
        let s = run(3 * STAYED_FRAMES as usize, 5, 0, 48);
        assert!(!s.excludes(40.0, 8.0));
        assert!(!s.excludes(40.0, 24.0));
        assert!(s.excludes(40.0, 44.0));
        assert!(!s.excludes(40.0, 70.0));
    }

    // Failure case: when most of the region stays, the steps belong to something inside it, which must not be
    // registered alone.
    #[test]
    fn a_region_that_mostly_stays_leaves_nothing_out() {
        let s = run(3 * STAYED_FRAMES as usize, 5, 64, 64);
        assert!(!s.any());
        assert!(!s.excludes(40.0, 4.0));
    }

    // Failure case: a cell that follows the page about as often as it stays (a header that scrolls away, then
    // sticks) is left out.
    #[test]
    fn a_cell_that_also_follows_the_page_is_kept() {
        let mut s = ScreenFixed::new(0, 0, W, H);
        for k in 0..STAYED_FRAMES as i64 {
            let (a, b) = (frame(k * 5, 16, 16), frame((k + 1) * 5, 16, 16));
            s.observe(&a, &b, W, H, (0.0, 5.0), |_, _| true);
        }
        assert!(s.excludes(40.0, 4.0));
        // Now the whole frame follows the page for two frames: the bar's cells followed twice.
        for k in 0..2i64 {
            let a: Vec<u8> = (0..W * H)
                .map(|i| texture((i % W) as i64, (i / W) as i64 + k * 5))
                .collect();
            let b: Vec<u8> = (0..W * H)
                .map(|i| texture((i % W) as i64, (i / W) as i64 + (k + 1) * 5))
                .collect();
            s.observe(&a, &b, W, H, (0.0, 5.0), |_, _| true);
        }
        assert!(!s.excludes(40.0, 4.0));
    }

    // Failure case: a step past the frame (an out-of-range pose) overflows the shifted index.
    #[test]
    fn a_step_without_overlap_casts_no_votes() {
        let mut s = ScreenFixed::new(0, 0, W, H);
        let (a, b) = (frame(0, 16, 16), frame(5, 16, 16));
        for step in [(0.0, 1e300), (f64::NAN, 0.0), (W as f64, 0.0)] {
            assert!(!s.observe(&a, &b, W, H, step, |_, _| true));
        }
        assert!(!s.any());
    }

    // Failure case: pixels outside the region vote for it.
    #[test]
    fn pixels_outside_the_region_cast_no_votes() {
        let mut s = ScreenFixed::new(0, 0, W, H);
        for k in 0..3 * STAYED_FRAMES as i64 {
            let (a, b) = (frame(k * 5, 16, 16), frame((k + 1) * 5, 16, 16));
            s.observe(&a, &b, W, H, (0.0, 5.0), |_, y| y >= 16);
        }
        assert!(!s.any());
    }
}
