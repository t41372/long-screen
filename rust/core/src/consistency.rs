//! World-consistency mask for one moving-region placement (docs/ARCHITECTURE.md §七).
//!
//! Two kinds of evidence, deliberately asymmetric in strength:
//! - a multi-frame voting verdict (`Vote`) says *which* frame is wrong and gets the last word;
//! - the ±1-frame native comparison is a pairwise disagreement signal, so it condemns this frame only
//!   when evidence is symmetric: every comparable neighbour disagrees, or the lone disagreeing neighbour
//!   carries its own negative verdict.

use crate::geometry::{js_ceil, js_floor, js_round, Rect};
use crate::pool::SyncPtr;

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
    /// True when some cell `ax0..=ax1` of analysis row `ay` carries a negative verdict.
    #[inline]
    pub fn any_negative(&self, ax0: i32, ax1: i32, ay: i32) -> bool {
        (ax0..=ax1).any(|ax| self.verdict(ax, ay) < 0)
    }

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
    dx: i64,
    dy: i64,
    occlusions: &'a [Rect],
    vote: Option<&'n Vote<'a>>,
}

fn resolve<'n, 'a>(n: &'n Neighbour<'a>, cx: i32, cy: i32) -> Resolved<'n, 'a> {
    Resolved {
        rgba: n.rgba,
        dx: (cx - js_round(n.pose_x)) as i64,
        dy: (cy - js_round(n.pose_y)) as i64,
        occlusions: n.occlusions,
        vote: n.vote.as_ref(),
    }
}

/// Integer x-interval `[a, b)` of pixels `ix` with `ix >= x && ix < x + width`, for a real rect edge.
#[inline]
fn span(x: f64, width: f64) -> (i64, i64) {
    (x.ceil() as i64, (x + width).ceil() as i64)
}

/// Largest RGB channel-difference sum `s` with `s / 3 <= noise` (the historical float test, evaluated for every
/// possible sum so fractional noise rounds exactly as before); 0 when only identical pixels pass.
fn sum_limit(noise: f64) -> u32 {
    (0..=765u32)
        .take_while(|&s| s as f64 / 3.0 <= noise)
        .last()
        .unwrap_or(0)
}

/// Frame-wide constants shared by every row.
struct Ctx<'n, 'a> {
    input: &'n MaskInput<'a>,
    neighbours: [Option<Resolved<'n, 'a>>; 2],
    w: i64,
    h: i64,
    rx0: i64,
    rx1: i64,
    factor: i64,
    limit: u32,
}

/// One neighbour's view of the current row.
struct NeighbourRow<'r, 'n, 'a> {
    n: &'r Resolved<'n, 'a>,
    labels: &'a [u8],
    rgba: &'a [u8],
    /// Current-frame x in `lo..hi` maps to a neighbour pixel inside the frame.
    lo: i64,
    hi: i64,
    /// Analysis row of the neighbour pixel, for its vote lookup.
    ay: i32,
    /// Neighbour row coordinate, for the (rare) occlusion test.
    fy: f64,
    /// Some occlusion band intersects this neighbour row.
    occluded: bool,
}

impl NeighbourRow<'_, '_, '_> {
    #[inline]
    fn occludes(&self, sx: i64) -> bool {
        self.occluded
            && self.n.occlusions.iter().any(|o| {
                if !(self.fy >= o.y && self.fy < o.y + o.height) {
                    return false;
                }
                let (a, b) = span(o.x, o.width);
                sx >= a - self.n.dx && sx < b - self.n.dx
            })
    }
}

/// Writes one byte per native pixel into `out` (1 = consistent). Pixels outside the region stay 1 and are
/// never read by the compositor, which gates on region membership first. Rows are independent, so they are
/// split across the pool; each row is computed identically whichever thread runs it.
pub fn consistency_mask(input: &MaskInput<'_>, out: &mut [u8]) {
    let (w, h) = (input.width as i64, input.height as i64);
    let (cx, cy) = (js_round(input.pose_x), js_round(input.pose_y));
    let ctx = Ctx {
        input,
        neighbours: [
            input.prev.as_ref().map(|n| resolve(n, cx, cy)),
            input.next.as_ref().map(|n| resolve(n, cx, cy)),
        ],
        w,
        h,
        rx0: js_floor(input.region.x).clamp(0, w as i32) as i64,
        rx1: js_ceil(input.region.x + input.region.width).clamp(0, w as i32) as i64,
        factor: input.factor.max(1) as i64,
        limit: sum_limit(input.noise),
    };
    let ry0 = js_floor(input.region.y).clamp(0, h as i32) as usize;
    let ry1 = js_ceil(input.region.y + input.region.height).clamp(0, h as i32) as usize;
    let width = input.width;
    let out = &mut out[..input.width * input.height];
    // Rows outside the region are only filled; the pool splits the region rows.
    out[..ry0 * width].fill(1);
    out[ry1.max(ry0) * width..].fill(1);
    let rows = ry1.saturating_sub(ry0);
    let chunks = crate::pool::chunks_for(rows * width, 64 * 1024);
    let base = SyncPtr(out.as_mut_ptr());
    crate::pool::par_for(chunks, |c| {
        let (a, b) = (
            ry0 + crate::pool::split(rows, chunks, c),
            ry0 + crate::pool::split(rows, chunks, c + 1),
        );
        for sy in a..b {
            // SAFETY: chunks cover disjoint row ranges of `out`, which outlives the parallel call.
            let row = unsafe { std::slice::from_raw_parts_mut(base.get().add(sy * width), width) };
            row.fill(1);
            mask_row(&ctx, sy as i64, row);
        }
    });
}

fn mask_row(ctx: &Ctx<'_, '_>, sy: i64, out_row: &mut [u8]) {
    let input = ctx.input;
    let (w, h, factor) = (ctx.w, ctx.h, ctx.factor);
    let width = input.width;
    let labels = input.labels;
    let ay = sy.div_euclid(factor) as i32;
    let mut rows: [Option<NeighbourRow<'_, '_, '_>>; 2] = [None, None];
    let mut count = 0usize;
    for n in ctx.neighbours.iter().flatten() {
        let iy = sy + n.dy;
        if iy < 0 || iy >= h {
            continue;
        }
        let base = (iy * w) as usize;
        let fy = iy as f64;
        rows[count] = Some(NeighbourRow {
            n,
            labels: &labels[base..base + width],
            rgba: &n.rgba[base * 4..(base + width) * 4],
            lo: (-n.dx).max(ctx.rx0),
            hi: (w - n.dx).min(ctx.rx1),
            ay: iy.div_euclid(factor) as i32,
            fy,
            occluded: n
                .occlusions
                .iter()
                .any(|o| fy >= o.y && fy < o.y + o.height),
        });
        count += 1;
    }
    let rows = &rows;
    let row_vote = input
        .vote
        .as_ref()
        .filter(|v| ay >= v.y0 && ay < v.y0 + v.h);
    let base = (sy * w) as usize;
    let lab_row = &labels[base..base + width];
    let rgb_row = &input.rgba[base * 4..(base + width) * 4];
    let mut sx = ctx.rx0;
    // Fast path: blocks of four pixels where every present neighbour row applies unoccluded to the whole block
    // and no negative vote cell covers it. A block whose pixels all agree needs no write (the row is prefilled
    // with 1); any other block is re-evaluated pixel by pixel below, exactly as the scalar rule.
    let (fast_lo, fast_hi) = rows
        .iter()
        .flatten()
        .fold((ctx.rx0, ctx.rx1), |(lo, hi), r| {
            if r.occluded {
                (lo, lo)
            } else {
                (lo.max(r.lo), hi.min(r.hi))
            }
        });
    while sx < ctx.rx1 {
        if sx >= fast_lo && sx + 4 <= fast_hi {
            let votes_clear = row_vote.is_none_or(|v| {
                !v.any_negative(
                    sx.div_euclid(factor) as i32,
                    (sx + 3).div_euclid(factor) as i32,
                    ay,
                )
            });
            if votes_clear && block_agrees(ctx, rows, lab_row, rgb_row, sx as usize) {
                sx += 4;
                continue;
            }
            for x in sx..sx + 4 {
                mask_pixel(ctx, rows, row_vote, ay, lab_row, rgb_row, out_row, x);
            }
            sx += 4;
            continue;
        }
        mask_pixel(ctx, rows, row_vote, ay, lab_row, rgb_row, out_row, sx);
        sx += 1;
    }
}

/// True when none of the four pixels at `x` can be flagged by the neighbour rule: each is outside the region,
/// or every neighbour pixel is outside the region or within the noise sum of it. The caller has established
/// that all neighbour rows apply, unoccluded, across the block.
#[inline]
fn block_agrees(
    ctx: &Ctx<'_, '_>,
    rows: &[Option<NeighbourRow<'_, '_, '_>>; 2],
    lab_row: &[u8],
    rgb_row: &[u8],
    x: usize,
) -> bool {
    let code = ctx.input.code;
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let _ = code;
        // SAFETY: `x + 4 <= fast_hi <= width` for the current row and `lo..hi` keeps `x + dx` inside each
        // neighbour row, so every 16-byte pixel load and 4-byte label load is in bounds.
        unsafe {
            let codes = u32x4_splat(ctx.input.code as u32);
            let labels4 = |row: &[u8], at: usize| {
                let v = v128_load32_zero(row.as_ptr().add(at) as *const u32);
                u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v))
            };
            let inside = u32x4_eq(labels4(lab_row, x), codes);
            if !v128_any_true(inside) {
                return true;
            }
            let a = v128_load(rgb_row.as_ptr().add(x * 4) as *const v128);
            let limit = u32x4_splat(ctx.limit);
            let rgb = u32x4_splat(0x00ff_ffff);
            let mut bad = u32x4_splat(0);
            for r in rows.iter().flatten() {
                let ix = (x as i64 + r.n.dx) as usize;
                let b = v128_load(r.rgba.as_ptr().add(ix * 4) as *const v128);
                let d = v128_and(v128_or(u8x16_sub_sat(a, b), u8x16_sub_sat(b, a)), rgb);
                let sum = u32x4_extadd_pairwise_u16x8(u16x8_extadd_pairwise_u8x16(d));
                let differs = u32x4_gt(sum, limit);
                let counted = u32x4_eq(labels4(r.labels, ix), codes);
                bad = v128_or(bad, v128_and(differs, counted));
            }
            !v128_any_true(v128_and(bad, inside))
        }
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        (x..x + 4).all(|x| {
            lab_row[x] != code
                || rows.iter().flatten().all(|r| {
                    let ix = (x as i64 + r.n.dx) as usize;
                    if r.labels[ix] != code {
                        return true;
                    }
                    let (i, j) = (x * 4, ix * 4);
                    let sum = (rgb_row[i] as i32 - r.rgba[j] as i32).unsigned_abs()
                        + (rgb_row[i + 1] as i32 - r.rgba[j + 1] as i32).unsigned_abs()
                        + (rgb_row[i + 2] as i32 - r.rgba[j + 2] as i32).unsigned_abs();
                    sum <= ctx.limit
                })
        })
    }
}

/// The per-pixel rule (see the module docs), unchanged from the historical kernel.
#[allow(clippy::too_many_arguments)]
#[inline]
fn mask_pixel(
    ctx: &Ctx<'_, '_>,
    rows: &[Option<NeighbourRow<'_, '_, '_>>; 2],
    row_vote: Option<&Vote<'_>>,
    ay: i32,
    lab_row: &[u8],
    rgb_row: &[u8],
    out_row: &mut [u8],
    sx: i64,
) {
    let code = ctx.input.code;
    let factor = ctx.factor;
    let x = sx as usize;
    if lab_row[x] != code {
        return;
    }
    if row_vote.is_some_and(|v| v.verdict(sx.div_euclid(factor) as i32, ay) < 0) {
        out_row[x] = 0;
        return;
    }
    let k = x * 4;
    let (r, g, b) = (
        rgb_row[k] as i32,
        rgb_row[k + 1] as i32,
        rgb_row[k + 2] as i32,
    );
    let (mut checked, mut condemned, mut excused) = (0u32, false, 0u32);
    for row in rows.iter().flatten() {
        // Each placement is rasterised at its own rounded pose; the difference of rounded poses is what the
        // compositor actually uses, not the rounded difference.
        if sx < row.lo || sx >= row.hi {
            continue;
        }
        let ix = (sx + row.n.dx) as usize;
        if row.labels[ix] != code || row.occludes(sx) {
            continue;
        }
        checked += 1;
        let j = ix * 4;
        let (nr, ng, nb) = (
            row.rgba[j] as i32,
            row.rgba[j + 1] as i32,
            row.rgba[j + 2] as i32,
        );
        if r == nr && g == ng && b == nb {
            continue;
        }
        let diff = ((r - nr).abs() + (g - ng).abs() + (b - nb).abs()) as f64 / 3.0;
        if diff <= ctx.input.noise {
            continue;
        }
        if row
            .n
            .vote
            .is_some_and(|v| v.verdict((ix as i64).div_euclid(factor) as i32, row.ay) < 0)
        {
            excused += 1;
        } else {
            condemned = true;
            break;
        }
    }
    if condemned || (excused > 0 && checked >= 2) {
        out_row[x] = 0;
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
