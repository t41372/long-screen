//! Stage: candidate sticky blocks inside a moving region. A block of the screen that stands still while the page
//! scrolls under it for part of the recording (new_mac_3's table of contents, on screen in 31 % of the frames, fading
//! in and out) is no region of its own: freezing it for the whole recording cuts out the page content seen there
//! while it was away (the page title at the start of new_mac_3). The learner only names such blocks; the solve pass
//! decides frame by frame whether the page's motion explains the block (`chrome::sticky_occlusions`).

use super::bands::{STATIONARY_STRUCTURE_SHARE, STATIONARY_VOTE_RATIO, STATIONARY_VOTE_SHARE};
use super::{Kind, RegionOut};
use crate::kernels::geometry::{js_ceil, js_floor, Rect};

/// Side of the analysis cells the votes are pooled in.
const CELL: i64 = 8;
/// Share of a candidate's bounding box its standing-still cells must fill: a panel, not a scatter of glyphs.
const BLOCK_FILL: f64 = 0.6;
/// Cells a candidate must span each way.
const BLOCK_CELLS: i64 = 3;
/// Largest share of the region a candidate may cover; beyond it the region itself is mostly fixed and region
/// learning decides (`freeze_stationary_regions`).
const BLOCK_AREA_SHARE: f64 = 0.25;
/// Share of the region's height a candidate must span: a sticky side panel runs down much of the viewport (new_mac_3's
/// table of contents 62 %), while the buttons floating over a page that the reveal takes out are small (15 % and
/// under on the recordings).
const BLOCK_HEIGHT_SHARE: f64 = 1.0 / 3.0;
/// Native pixels from the region's top or bottom edge within which a block counts as touching it: a bar there (or its
/// soft edge) is the side bands' and the sticky header's to handle, not a block's.
const EDGE_MARGIN: f64 = 20.0;

/// Candidate sticky blocks of a moving region, in native pixels: 4-connected groups of `CELL`-pixel analysis cells
/// where standing still explains the sampled pixels `STATIONARY_VOTE_SHARE` per frame and `STATIONARY_VOTE_RATIO`
/// times as often as the page's motion, filling `BLOCK_FILL` of their box, at least `BLOCK_CELLS` cells each way and
/// with one row of dense standing-still structure (`STATIONARY_STRUCTURE_SHARE`, as the vote bands), no wider than
/// half the region, at least `BLOCK_HEIGHT_SHARE` of its height, under `BLOCK_AREA_SHARE` of it, and clear of its top
/// and bottom edges by `EDGE_MARGIN`. Fixed and ignored regions have none.
pub fn sticky_blocks(
    region: &RegionOut,
    votes: (&[f64], &[f64]),
    width: i64,
    height: i64,
    frames: f64,
    factor: f64,
) -> Vec<Rect> {
    if region.kind != Kind::Moving || frames <= 0.0 || width < 5 || height < 5 {
        return Vec::new();
    }
    let r = region.rect;
    let x0 = (js_ceil(r.x / factor) as i64).clamp(0, width);
    let y0 = (js_ceil(r.y / factor) as i64).clamp(0, height);
    let x1 = (js_floor((r.x + r.width) / factor) as i64).clamp(0, width);
    let y1 = (js_floor((r.y + r.height) / factor) as i64).clamp(0, height);
    let mask = region
        .mask
        .as_ref()
        .filter(|m| !region.solid && m.len() == region.mask_width * region.mask_height);
    let inside = |x: i64, y: i64| {
        mask.is_none_or(|m| {
            (x as usize) < region.mask_width
                && (y as usize) < region.mask_height
                && m[y as usize * region.mask_width + x as usize] != 0
        })
    };
    let (fixed, moving) = votes;
    // Whole cells only, on the grid from (0, 0); `Learner::add` samples rows 2..height-2, every 4th column from 2.
    let (cx0, cy0) = ((x0 + CELL - 1) / CELL, (y0 + CELL - 1) / CELL);
    let (cx1, cy1) = (x1 / CELL, y1 / CELL);
    if cx1 <= cx0 || cy1 <= cy0 {
        return Vec::new();
    }
    let (cw, ch) = ((cx1 - cx0) as usize, (cy1 - cy0) as usize);
    let mut marked = vec![false; cw * ch];
    let mut dense = vec![0.0f64; cw * ch];
    for cy in cy0..cy1 {
        for cx in cx0..cx1 {
            let (mut f, mut m, mut n, mut best, mut whole) = (0.0, 0.0, 0u32, 0.0f64, true);
            for y in (cy * CELL).max(2)..((cy + 1) * CELL).min(height - 2) {
                let (mut rf, mut rn) = (0.0, 0u32);
                let mut x = cx * CELL + (2 - cx * CELL).rem_euclid(4);
                while x < ((cx + 1) * CELL).min(width - 2) {
                    if !inside(x, y) {
                        whole = false;
                    }
                    let i = (y * width + x) as usize;
                    f += fixed[i];
                    m += moving[i];
                    rf += fixed[i];
                    n += 1;
                    rn += 1;
                    x += 4;
                }
                if rn > 0 {
                    best = best.max(rf / rn as f64 / frames);
                }
            }
            if !whole || n == 0 {
                continue;
            }
            let (f, m) = (f / n as f64 / frames, m / n as f64 / frames);
            let k = (cy - cy0) as usize * cw + (cx - cx0) as usize;
            marked[k] = f >= STATIONARY_VOTE_SHARE && f >= STATIONARY_VOTE_RATIO * m;
            dense[k] = best;
        }
    }
    let mut seen = vec![false; cw * ch];
    let mut out = Vec::new();
    for start in 0..cw * ch {
        if !marked[start] || seen[start] {
            continue;
        }
        let (mut stack, mut cells) = (vec![start], Vec::new());
        seen[start] = true;
        while let Some(k) = stack.pop() {
            cells.push(k);
            let (kx, ky) = (k % cw, k / cw);
            let mut visit = |q: usize| {
                if marked[q] && !seen[q] {
                    seen[q] = true;
                    stack.push(q);
                }
            };
            if kx > 0 {
                visit(k - 1);
            }
            if kx + 1 < cw {
                visit(k + 1);
            }
            if ky > 0 {
                visit(k - cw);
            }
            if ky + 1 < ch {
                visit(k + cw);
            }
        }
        let (bx0, bx1) = cells
            .iter()
            .fold((usize::MAX, 0), |(a, b), &k| (a.min(k % cw), b.max(k % cw)));
        let (by0, by1) = cells
            .iter()
            .fold((usize::MAX, 0), |(a, b), &k| (a.min(k / cw), b.max(k / cw)));
        let (bw, bh) = ((bx1 - bx0 + 1) as i64, (by1 - by0 + 1) as i64);
        let fill = cells.len() as f64 / (bw * bh) as f64;
        let structure = cells
            .iter()
            .any(|&k| dense[k] >= STATIONARY_STRUCTURE_SHARE);
        let top = (cy0 + by0 as i64) * CELL;
        let bottom = (cy0 + by1 as i64 + 1) * CELL;
        let clear =
            (top - y0) as f64 * factor > EDGE_MARGIN && (y1 - bottom) as f64 * factor > EDGE_MARGIN;
        if fill >= BLOCK_FILL
            && bw >= BLOCK_CELLS
            && bh >= BLOCK_CELLS
            && structure
            && clear
            && (bw * CELL * 2) as f64 <= (x1 - x0) as f64
            && (bh * CELL) as f64 >= BLOCK_HEIGHT_SHARE * (y1 - y0) as f64
            && (bw * bh) as f64 <= BLOCK_AREA_SHARE * (cw * ch) as f64
        {
            out.push(Rect {
                x: ((cx0 + bx0 as i64) * CELL) as f64 * factor,
                y: top as f64 * factor,
                width: (bw * CELL) as f64 * factor,
                height: (bh * CELL) as f64 * factor,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! Ways the candidate blocks can fail, written before the stage: a table of contents standing still in some of
    //! the frames is not named; a full-width bar, a bar at the region's top or bottom edge, or a small floating button
    //! is named (each has its own handling); a block that stands still too rarely, a block outside the region's mask,
    //! or a block in a fixed region is named.
    use super::*;

    const W: usize = 400;
    const H: usize = 400;
    const FRAMES: f64 = 50.0;

    fn region(kind: Kind, mask: Option<Vec<u8>>) -> RegionOut {
        RegionOut {
            id: "layer-0".into(),
            name: String::new(),
            kind,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: W as f64,
                height: H as f64,
            },
            cells: Some(vec![0]),
            mask,
            mask_width: W,
            mask_height: H,
            manual: false,
            unassigned: false,
            exclusions: Vec::new(),
            crop: None,
            solid: false,
            factor: 1,
            band_side: None,
            epochs: Vec::new(),
            sticky: Vec::new(),
        }
    }

    /// Votes of a scrolling page (standing still 0.01, following 0.3 per pixel and frame) with `block` standing still
    /// at `still` (one row of it at 0.25, its densest structure) and following at 0.005.
    fn votes(block: Option<(usize, usize, usize, usize)>, still: f64) -> (Vec<f64>, Vec<f64>) {
        let (mut fixed, mut moving) = (vec![0.0; W * H], vec![0.0; W * H]);
        for y in 0..H {
            for x in 0..W {
                let (f, m) = match block {
                    Some((x0, y0, x1, y1)) if (x0..x1).contains(&x) && (y0..y1).contains(&y) => {
                        (if y == y0 + 20 { 0.25 } else { still }, 0.005)
                    }
                    _ => (0.01, 0.3),
                };
                fixed[y * W + x] = f * FRAMES;
                moving[y * W + x] = m * FRAMES;
            }
        }
        (fixed, moving)
    }

    fn blocks(r: &RegionOut, v: &(Vec<f64>, Vec<f64>)) -> Vec<Rect> {
        sticky_blocks(r, (&v.0, &v.1), W as i64, H as i64, FRAMES, 1.0)
    }

    #[test]
    fn a_table_of_contents_standing_still_part_of_the_time_is_named() {
        let v = votes(Some((40, 80, 104, 304)), 0.1);
        assert_eq!(
            blocks(&region(Kind::Moving, None), &v),
            vec![Rect {
                x: 40.0,
                y: 80.0,
                width: 64.0,
                height: 224.0
            }]
        );
    }

    #[test]
    fn bars_and_buttons_are_not_blocks() {
        let r = region(Kind::Moving, None);
        // A full-width bar in the middle of the region.
        assert!(blocks(&r, &votes(Some((0, 100, 400, 140)), 0.1)).is_empty());
        // A narrow panel reaching the region's top edge, and one ending at its bottom edge.
        assert!(blocks(&r, &votes(Some((40, 0, 104, 224)), 0.1)).is_empty());
        assert!(blocks(&r, &votes(Some((40, 176, 104, 400)), 0.1)).is_empty());
        // A floating button.
        assert!(blocks(&r, &votes(Some((300, 300, 348, 348)), 0.1)).is_empty());
    }

    #[test]
    fn a_block_standing_still_too_rarely_or_outside_the_region_is_not_named() {
        assert!(blocks(
            &region(Kind::Moving, None),
            &votes(Some((40, 80, 104, 304)), 0.02)
        )
        .is_empty());
        let v = votes(Some((40, 80, 104, 304)), 0.1);
        assert!(blocks(&region(Kind::Fixed, None), &v).is_empty());
        // The region's mask leaves out the left 120 columns, block and all.
        let mask: Vec<u8> = (0..W * H).map(|i| (i % W >= 120) as u8).collect();
        assert!(blocks(&region(Kind::Moving, Some(mask)), &v).is_empty());
    }
}
