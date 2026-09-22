//! World-consistency mask for one moving-region placement (docs/ARCHITECTURE.md §七).
//!
//! Two kinds of evidence, deliberately asymmetric in strength:
//! - a multi-frame voting verdict (`Vote`) says *which* frame is wrong and gets the last word;
//! - the ±1-frame native comparison is a pairwise disagreement signal, so it condemns this frame only
//!   when evidence is symmetric: every comparable neighbour disagrees, or the lone disagreeing neighbour
//!   carries its own negative verdict.

use crate::geometry::{js_ceil, js_floor, js_round, Rect};

/// Packed analysis-resolution voting verdicts in region-local box coordinates.
pub struct Vote<'a> {
    pub x0: i32,
    pub y0: i32,
    pub w: i32,
    pub h: i32,
    /// Bit set: inconsistent.
    pub bits: &'a [u8],
    /// Bit set: confidently consistent (only consulted when `bits` is clear).
    pub clean: &'a [u8],
}

impl Vote<'_> {
    /// −1 inconsistent, +1 confidently consistent, 0 no verdict; `(ax, ay)` are analysis cells.
    #[inline]
    pub fn verdict(&self, ax: i32, ay: i32) -> i32 {
        let lx = ax - self.x0;
        let ly = ay - self.y0;
        if lx < 0 || ly < 0 || lx >= self.w || ly >= self.h {
            return 0;
        }
        let i = (ly * self.w + lx) as usize;
        let bit = 1u8 << (i & 7);
        if self.bits.get(i >> 3).is_some_and(|b| b & bit != 0) {
            -1
        } else if self.clean.get(i >> 3).is_some_and(|b| b & bit != 0) {
            1
        } else {
            0
        }
    }
}

pub struct Neighbour<'a> {
    pub rgba: &'a [u8],
    pub pose_x: f64,
    pub pose_y: f64,
    pub occlusions: &'a [Rect],
    pub vote: Option<Vote<'a>>,
}

pub struct MaskInput<'a> {
    pub rgba: &'a [u8],
    pub labels: &'a [u8],
    pub width: usize,
    pub height: usize,
    pub region: Rect,
    pub code: u8,
    pub pose_x: f64,
    pub pose_y: f64,
    pub prev: Option<Neighbour<'a>>,
    pub next: Option<Neighbour<'a>>,
    pub vote: Option<Vote<'a>>,
    pub factor: i32,
    pub noise: f64,
}

struct Resolved<'n, 'a> {
    rgba: &'a [u8],
    dx: i32,
    dy: i32,
    occlusions: &'a [Rect],
    vote: Option<&'n Vote<'a>>,
}

fn resolve<'n, 'a>(n: &'n Neighbour<'a>, cx: i32, cy: i32) -> Resolved<'n, 'a> {
    Resolved {
        rgba: n.rgba,
        dx: cx - js_round(n.pose_x),
        dy: cy - js_round(n.pose_y),
        occlusions: n.occlusions,
        vote: n.vote.as_ref(),
    }
}

/// Writes one byte per native pixel into `out` (1 = consistent). Pixels outside the region stay 1 and are
/// never read by the compositor, which gates on region membership first.
pub fn consistency_mask(input: &MaskInput<'_>, out: &mut [u8]) {
    let (w, h) = (input.width as i32, input.height as i32);
    out[..input.width * input.height].fill(1);
    let rx0 = js_floor(input.region.x).clamp(0, w);
    let ry0 = js_floor(input.region.y).clamp(0, h);
    let rx1 = js_ceil(input.region.x + input.region.width).clamp(0, w);
    let ry1 = js_ceil(input.region.y + input.region.height).clamp(0, h);
    let (cx, cy) = (js_round(input.pose_x), js_round(input.pose_y));
    let factor = input.factor.max(1);
    let neighbours: Vec<Resolved<'_, '_>> = input
        .prev
        .iter()
        .chain(input.next.iter())
        .map(|n| resolve(n, cx, cy))
        .collect();
    let labels = input.labels;
    for sy in ry0..ry1 {
        let ay = sy.div_euclid(factor);
        for sx in rx0..rx1 {
            let src = (sy * w + sx) as usize;
            if labels[src] != input.code {
                continue;
            }
            let ax = sx.div_euclid(factor);
            if input.vote.as_ref().is_some_and(|v| v.verdict(ax, ay) < 0) {
                out[src] = 0;
                continue;
            }
            let k = src * 4;
            let (r, g, b) = (
                input.rgba[k] as i32,
                input.rgba[k + 1] as i32,
                input.rgba[k + 2] as i32,
            );
            let (mut checked, mut condemned, mut excused) = (0u32, false, 0u32);
            for n in &neighbours {
                // Each placement is rasterised at its own rounded pose; the difference of rounded poses is
                // what the compositor actually uses, not the rounded difference.
                let ix = sx + n.dx;
                let iy = sy + n.dy;
                if ix < 0 || iy < 0 || ix >= w || iy >= h {
                    continue;
                }
                let ni = (iy * w + ix) as usize;
                if labels[ni] != input.code
                    || n.occlusions
                        .iter()
                        .any(|o| o.contains(ix as f64, iy as f64))
                {
                    continue;
                }
                checked += 1;
                let j = ni * 4;
                let (nr, ng, nb) = (n.rgba[j] as i32, n.rgba[j + 1] as i32, n.rgba[j + 2] as i32);
                if r == nr && g == ng && b == nb {
                    continue;
                }
                let diff = ((r - nr).abs() + (g - ng).abs() + (b - nb).abs()) as f64 / 3.0;
                if diff <= input.noise {
                    continue;
                }
                if n.vote
                    .is_some_and(|v| v.verdict(ix.div_euclid(factor), iy.div_euclid(factor)) < 0)
                {
                    excused += 1;
                } else {
                    condemned = true;
                    break;
                }
            }
            if condemned || (excused > 0 && checked >= 2) {
                out[src] = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: usize, h: usize, value: u8) -> Vec<u8> {
        (0..w * h)
            .flat_map(|_| [value, value, value, 255])
            .collect()
    }

    #[test]
    fn lone_disagreeing_neighbour_condemns_unless_excused_by_its_verdict() {
        let (w, h) = (4usize, 4usize);
        let current = frame(w, h, 10);
        let other = frame(w, h, 200);
        let labels = vec![1u8; w * h];
        let region = Rect {
            x: 0.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
        };
        let mut out = vec![0u8; w * h];
        let base = |vote| MaskInput {
            rgba: &current,
            labels: &labels,
            width: w,
            height: h,
            region,
            code: 1,
            pose_x: 0.0,
            pose_y: 0.0,
            prev: Some(Neighbour {
                rgba: &other,
                pose_x: 0.0,
                pose_y: 0.0,
                occlusions: &[],
                vote,
            }),
            next: None,
            vote: None,
            factor: 1,
            noise: 10.0,
        };
        consistency_mask(&base(None), &mut out);
        assert!(out.iter().all(|&v| v == 0));
        let bits = vec![0xffu8; 2];
        let clean = vec![0u8; 2];
        let excused = base(Some(Vote {
            x0: 0,
            y0: 0,
            w: 4,
            h: 4,
            bits: &bits,
            clean: &clean,
        }));
        consistency_mask(&excused, &mut out);
        assert!(out.iter().all(|&v| v == 1));
    }
}
