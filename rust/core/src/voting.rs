//! Displacement-spread consistency voting (docs/ARCHITECTURE.md §七): a bounded ring of recent
//! analysis-resolution frames, one region-local box-gray per moving region, compared against several
//! partners whose world displacement clears `dmin`. This is the stateful `solve()`-side half of the
//! world-consistency evidence; `consistency.rs` consumes the finalised verdicts during rendering.
//!
//! Every rule here — box geometry, interior mask, partner selection (nearest two, farthest, fewest-pairs
//! per band), the ±radius local search, saturating score/comparison counters, the 75 % ratio threshold and
//! the three-way verdict — is the measured behaviour of the historical adapter; see the invariants in
//! ARCHITECTURE.md §十 before changing any of them.

use crate::geometry::{js_ceil, js_floor, js_hypot, js_round};
use crate::region::Region;

pub const PARTNERS: usize = 6;
pub const VERDICT_MIN: u32 = 3;

/// Analysis-resolution box, in this region's own local coordinates, bounding the region rect with a 1-cell margin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box {
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
}

impl Box {
    pub fn of(rect: &crate::geometry::Rect, factor: i32) -> Box {
        let f = factor as f64;
        let x0 = js_floor(rect.x / f) - 1;
        let y0 = js_floor(rect.y / f) - 1;
        Box {
            x0,
            y0,
            w: js_ceil((rect.x + rect.width) / f) - x0 + 1,
            h: js_ceil((rect.y + rect.height) / f) - y0 + 1,
        }
    }
    #[inline]
    pub fn cells(&self) -> usize {
        (self.w.max(0) as usize) * (self.h.max(0) as usize)
    }
}

/// Per-run, per-moving-region constants.
pub struct RegionSlot {
    pub region: Region,
    pub box_: Box,
    pub dmin: f64,
    /// 1 where the cell and its eight blur taps are inside the region and the search window fits the box.
    pub interior: Vec<u8>,
}

/// One region's voting state in one ring frame.
pub struct Layer {
    pub canvas: u32,
    pub pose_x: f64,
    pub pose_y: f64,
    pub score: Vec<i8>,
    pub comparisons: Vec<u8>,
    pub pairs: u32,
    pub box_gray: Vec<u8>,
}

pub struct Frame {
    pub index: u32,
    pub bytes: usize,
    /// Indexed by region slot; `None` when the region had no evidence this frame.
    pub layers: Vec<Option<Layer>>,
}

/// Finalised verdict for one region of one frame; both bitsets are LSB-first over `box_.w × box_.h`.
pub struct Verdict {
    pub slot: usize,
    pub bits: Vec<u8>,
    pub clean: Vec<u8>,
}

pub struct Finalized {
    pub index: u32,
    pub verdicts: Vec<Verdict>,
    pub voted_layers: u32,
    pub thin_layers: u32,
}

pub struct Ring {
    pub factor: i32,
    pub tau: i32,
    pub radius: i32,
    pub native_width: f64,
    pub native_height: f64,
    pub analysis_width: usize,
    pub analysis_height: usize,
    pub budget_bytes: usize,
    pub slots: Vec<RegionSlot>,
    frames: Vec<Frame>,
    bytes: usize,
    /// Layers for the frame being built; committed by `push_frame`.
    building: Vec<Option<Layer>>,
}

/// Ratio rule, a measured deviation from a literal "≥2 comparisons, net score < 0" majority: partners are
/// spread across the displacement range, so one or two of ~6 land a clean pixel inside their OWN overlay
/// footprint by coincidence and a bare majority would flip it. Comparisons in {2,3} still require unanimity
/// (⌈0.75·2⌉ = 2, ⌈0.75·3⌉ = 3); ≥4 need a 75 % supermajority, which an overlay interior clears but a single
/// coincidental agreement no longer blocks.
#[inline]
fn threshold(comparisons: u32) -> i32 {
    comparisons as i32 - 2 * ((comparisons as f64 * 0.75).ceil() as i32)
}

impl Ring {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        factor: i32,
        noise: f64,
        native_width: usize,
        native_height: usize,
        analysis_width: usize,
        analysis_height: usize,
        budget_bytes: usize,
        regions: Vec<Region>,
    ) -> Ring {
        let factor = factor.max(1);
        // CONSISTENCY_PHASE headroom for box-filter phase applies only at f>1; a decoded recording keeps 26.
        let phase = if factor == 1 { 0 } else { 26 };
        let tau = phase.max(js_round(noise * 2.6));
        let radius = factor;
        let (nw, nh) = (native_width as f64, native_height as f64);
        let slots = regions
            .into_iter()
            .map(|region| {
                let box_ = Box::of(&region.rect, factor);
                let dmin = (0.25 * region.rect.width.min(region.rect.height)).max(64.0);
                let mut interior = vec![0u8; box_.cells()];
                for ly in 0..box_.h {
                    for lx in 0..box_.w {
                        if lx < radius
                            || ly < radius
                            || lx >= box_.w - radius
                            || ly >= box_.h - radius
                        {
                            continue;
                        }
                        let mut ok = true;
                        'taps: for oy in -1..=1 {
                            for ox in -1..=1 {
                                let x = ((box_.x0 + lx + ox) * factor) as f64;
                                let y = ((box_.y0 + ly + oy) * factor) as f64;
                                if !region.contains(x, y, nw, nh) {
                                    ok = false;
                                    break 'taps;
                                }
                            }
                        }
                        interior[(ly * box_.w + lx) as usize] = ok as u8;
                    }
                }
                RegionSlot {
                    region,
                    box_,
                    dmin,
                    interior,
                }
            })
            .collect::<Vec<_>>();
        let building = (0..slots.len()).map(|_| None).collect();
        Ring {
            factor,
            tau,
            radius,
            native_width: nw,
            native_height: nh,
            analysis_width,
            analysis_height,
            budget_bytes,
            slots,
            frames: Vec::new(),
            bytes: 0,
            building,
        }
    }

    pub fn resident_frames(&self) -> usize {
        self.frames.len()
    }

    /// Region-masked box-blurred luma in box-local coordinates (plain copy at factor 1).
    ///
    /// `downscale_gray`'s box grid is anchored to screen pixel (0,0), so at f>1 the same world pixel lands at a
    /// different sub-cell phase in two frames whenever their pose delta is not a multiple of the factor; on
    /// sharp edges that moves the averaged luma by tens of levels on bit-identical content. The 3×3 blur
    /// suppresses it. Out-of-region or off-frame taps are replaced by the CENTRE value (edge replication):
    /// a region-unaware blur leaked a neighbouring fixed region's colour into the boundary row, and simply
    /// dropping taps left a weaker average at the edge. At f=1 there is no phase term and the blur only
    /// costs boundary accuracy, so it is off.
    fn box_gray(&self, slot: &RegionSlot, gray: &[u8]) -> Vec<u8> {
        let b = slot.box_;
        let (gw, gh) = (self.analysis_width as i32, self.analysis_height as i32);
        let f = self.factor;
        let mut out = vec![0u8; b.cells()];
        for ly in 0..b.h {
            let ay = b.y0 + ly;
            for lx in 0..b.w {
                let ax = b.x0 + lx;
                if ax < 0 || ay < 0 || ax >= gw || ay >= gh {
                    continue;
                }
                let centre = gray[(ay * gw + ax) as usize] as u32;
                if f == 1 {
                    out[(ly * b.w + lx) as usize] = centre as u8;
                    continue;
                }
                let mut sum = 0u32;
                for oy in -1..=1 {
                    let ty = ay + oy;
                    for ox in -1..=1 {
                        let tx = ax + ox;
                        let inside = tx >= 0
                            && ty >= 0
                            && tx < gw
                            && ty < gh
                            && slot.region.contains(
                                (tx * f) as f64,
                                (ty * f) as f64,
                                self.native_width,
                                self.native_height,
                            );
                        sum += if inside {
                            gray[(ty * gw + tx) as usize] as u32
                        } else {
                            centre
                        };
                    }
                }
                // Math.round(sum / 9) for non-negative sum: floor(sum / 9 + 0.5) == (2·sum + 9) / 18.
                out[(ly * b.w + lx) as usize] = ((2 * sum + 9) / 18) as u8;
            }
        }
        out
    }

    /// Partner frame indices (positions in `frames`) for `slot` at `pose` on `canvas`: candidates clearing
    /// `dmin`, sorted by displacement; the NEAREST TWO and the FARTHEST always, the rest one per equal index
    /// band, choosing the candidate with the FEWEST pairs so far (ties: larger displacement).
    /// - Spread keeps the "partner's own overlay footprint" coincidences independent of each other.
    /// - The nearest two are what give a leading-edge cell (visible in no past frame) its comparisons at all.
    /// - Fairness stops the same anchor frames being re-picked, so frames whose clean counterparts lie in the
    ///   future still get judged; `thin_layers` is the watchdog for this.
    fn partners(&self, slot: usize, canvas: u32, pose_x: f64, pose_y: f64) -> Vec<usize> {
        let dmin = self.slots[slot].dmin;
        let mut candidates: Vec<(usize, f64, u32, u32)> = Vec::new();
        for (at, frame) in self.frames.iter().enumerate() {
            let Some(layer) = &frame.layers[slot] else {
                continue;
            };
            if layer.canvas != canvas {
                continue;
            }
            let d = js_hypot(pose_x - layer.pose_x, pose_y - layer.pose_y);
            if d >= dmin {
                candidates.push((at, d, layer.pairs, frame.index));
            }
        }
        if candidates.len() <= PARTNERS {
            return candidates.into_iter().map(|c| c.0).collect();
        }
        // Stable sort by displacement: equal distances keep ring (ascending frame) order like Array#sort.
        candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let n = candidates.len();
        let mut seen: Vec<u32> = Vec::with_capacity(PARTNERS);
        let mut out: Vec<usize> = Vec::with_capacity(PARTNERS);
        let take = |c: &(usize, f64, u32, u32), seen: &mut Vec<u32>, out: &mut Vec<usize>| {
            if !seen.contains(&c.3) {
                seen.push(c.3);
                out.push(c.0);
            }
        };
        take(&candidates[0], &mut seen, &mut out);
        take(&candidates[1], &mut seen, &mut out);
        take(&candidates[n - 1], &mut seen, &mut out);
        let bands = PARTNERS - out.len();
        let (lo, hi) = (2usize, n - 1);
        let mut band = 0usize;
        while band < bands && hi > lo {
            let from = lo + band * (hi - lo) / bands;
            let to = lo + (band + 1) * (hi - lo) / bands;
            let mut best: Option<&(usize, f64, u32, u32)> = None;
            for c in &candidates[from..to] {
                if seen.contains(&c.3) {
                    continue;
                }
                let better = match best {
                    None => true,
                    Some(b) => c.2 < b.2 || (c.2 == b.2 && c.1 > b.1),
                };
                if better {
                    best = Some(c);
                }
            }
            if let Some(b) = best {
                take(b, &mut seen, &mut out);
            }
            band += 1;
        }
        out
    }

    /// Compares `t` (the frame being placed) against ring partner `s`, scoring both. The ±radius local search
    /// exists because the pose delta is a native quantity divided by the integer factor, so it is essentially
    /// never a whole cell; rounding it lands off the true match on textured content often enough to swamp the
    /// signal. Candidates outside the region are not re-checked: they can only make agreement MORE likely.
    fn compare(&self, slot: usize, t: &mut Layer, s: &mut Layer) {
        let b = self.slots[slot].box_;
        let interior = &self.slots[slot].interior;
        let f = self.factor as f64;
        let dx = (t.pose_x - s.pose_x) / f;
        let dy = (t.pose_y - s.pose_y) / f;
        t.pairs += 1;
        s.pairs += 1;
        let (tau, radius) = (self.tau, self.radius);
        for ly in 0..b.h {
            for lx in 0..b.w {
                let i = (ly * b.w + lx) as usize;
                if interior[i] == 0 {
                    continue;
                }
                let sx = js_round(lx as f64 + dx);
                let sy = js_round(ly as f64 + dy);
                if sx < 0 || sy < 0 || sx >= b.w || sy >= b.h {
                    continue;
                }
                let si = (sy * b.w + sx) as usize;
                if interior[si] == 0 {
                    continue;
                }
                let value = t.box_gray[i] as i32;
                let mut best = 255i32;
                let mut oy = -radius;
                while oy <= radius && best > tau {
                    let py = sy + oy;
                    oy += 1;
                    if py < 0 || py >= b.h {
                        continue;
                    }
                    let row = (py * b.w) as usize;
                    let x_lo = (sx - radius).max(0);
                    let x_hi = (sx + radius).min(b.w - 1);
                    for px in x_lo..=x_hi {
                        let diff = (value - s.box_gray[row + px as usize] as i32).abs();
                        if diff < best {
                            best = diff;
                        }
                    }
                }
                let delta: i8 = if best <= tau { 1 } else { -1 };
                t.comparisons[i] = t.comparisons[i].saturating_add(1);
                t.score[i] = t.score[i].saturating_add(delta);
                s.comparisons[si] = s.comparisons[si].saturating_add(1);
                s.score[si] = s.score[si].saturating_add(delta);
            }
        }
    }

    /// Adds this frame's evidence for one region: builds its box gray, votes against ring partners and holds the
    /// layer until `push_frame`. `gray` is the whole analysis frame.
    pub fn observe(&mut self, slot: usize, canvas: u32, pose_x: f64, pose_y: f64, gray: &[u8]) {
        let cells = self.slots[slot].box_.cells();
        let mut layer = Layer {
            canvas,
            pose_x,
            pose_y,
            score: vec![0i8; cells],
            comparisons: vec![0u8; cells],
            pairs: 0,
            box_gray: self.box_gray(&self.slots[slot], gray),
        };
        for at in self.partners(slot, canvas, pose_x, pose_y) {
            // Take the partner out for the duration of the comparison so `self` stays borrowable.
            let mut partner = self.frames[at].layers[slot]
                .take()
                .expect("partner layer present");
            self.compare(slot, &mut layer, &mut partner);
            self.frames[at].layers[slot] = Some(partner);
        }
        self.building[slot] = Some(layer);
    }

    /// Commits the frame under construction (if any region observed) and finalises whatever the byte budget
    /// pushes out, oldest first.
    pub fn push_frame(&mut self, index: u32) -> Vec<Finalized> {
        let layers = std::mem::replace(
            &mut self.building,
            (0..self.slots.len()).map(|_| None).collect(),
        );
        if layers.iter().all(|l| l.is_none()) {
            return Vec::new();
        }
        let bytes = layers
            .iter()
            .flatten()
            .map(|l| l.box_gray.len() + l.score.len() + l.comparisons.len())
            .sum();
        self.frames.push(Frame {
            index,
            bytes,
            layers,
        });
        self.bytes += bytes;
        let mut out = Vec::new();
        while self.bytes > self.budget_bytes && self.frames.len() > 1 {
            let evicted = self.frames.remove(0);
            self.bytes -= evicted.bytes;
            out.push(self.finalize(evicted));
        }
        out
    }

    /// Finalises every resident frame, oldest first (end of the solve pass).
    pub fn drain(&mut self) -> Vec<Finalized> {
        let frames = std::mem::take(&mut self.frames);
        self.bytes = 0;
        frames.into_iter().map(|f| self.finalize(f)).collect()
    }

    fn finalize(&self, frame: Frame) -> Finalized {
        let mut verdicts = Vec::new();
        let (mut voted, mut thin) = (0u32, 0u32);
        for (slot, layer) in frame.layers.iter().enumerate() {
            let Some(layer) = layer else {
                continue;
            };
            voted += 1;
            if layer.pairs < VERDICT_MIN {
                thin += 1;
            }
            let bytes = layer.score.len().div_ceil(8);
            let mut bits = vec![0u8; bytes];
            let mut clean = vec![0u8; bytes];
            let mut any = false;
            for (i, (&score, &comparisons)) in
                layer.score.iter().zip(&layer.comparisons).enumerate()
            {
                let (score, comparisons) = (score as i32, comparisons as u32);
                if comparisons >= 2 && score <= threshold(comparisons) {
                    bits[i >> 3] |= 1 << (i & 7);
                    any = true;
                } else if comparisons >= VERDICT_MIN && score >= -threshold(comparisons) {
                    clean[i >> 3] |= 1 << (i & 7);
                    any = true;
                }
            }
            if any {
                verdicts.push(Verdict { slot, bits, clean });
            }
        }
        Finalized {
            index: frame.index,
            verdicts,
            voted_layers: voted,
            thin_layers: thin,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_threshold_matches_the_measured_rule() {
        assert_eq!(threshold(2), -2);
        assert_eq!(threshold(3), -3);
        assert_eq!(threshold(4), -2);
        assert_eq!(threshold(5), -3);
        assert_eq!(threshold(6), -4);
    }

    #[test]
    fn box_gray_rounding_matches_math_round() {
        for sum in 0u32..=(9 * 255) {
            let expected = ((sum as f64) / 9.0 + 0.5).floor() as u32;
            assert_eq!((2 * sum + 9) / 18, expected, "sum {sum}");
        }
    }
}
