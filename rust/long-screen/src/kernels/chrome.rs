//! Screen-fixed chrome evidence on native frames (`src/core/layers.ts::stationaryBoundary`,
//! `stickyOcclusions`): a persistent appearance edge within a stationary band, and the per-observation sticky
//! header band whose native texture agrees with zero motion and disagrees with the accepted page translation.
//! Thresholds, sampling steps and the "return the carried bands" fallbacks are the historical ones.

use crate::kernels::geometry::{js_ceil, js_floor, js_round, Rect};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Choose {
    First,
    Last,
}

/// Strong persistent appearance boundary within a stationary run: the first/last coordinate `v` in
/// `[max(1, from), min(limit, to + 1))` whose row (or column) differs from its predecessor over more than
/// 68 % of sampled cross positions with mean difference > 3. `None` when the image offers no boundary.
#[allow(clippy::too_many_arguments)]
pub fn stationary_boundary(
    rgba: &[u8],
    width: usize,
    height: usize,
    axis: Axis,
    from: f64,
    to: f64,
    cross_from: f64,
    cross_to: f64,
    choose: Choose,
) -> Option<f64> {
    let (w, h) = (width as i64, height as i64);
    let limit = if axis == Axis::X { w } else { h };
    let cross_limit = if axis == Axis::X { h } else { w };
    // Math.floor((crossTo - crossFrom) / 160) on the real span, then at least 1.
    let step = (((cross_to - cross_from) / 160.0).floor() as i64).max(1);
    let mut found = None;
    // `for (let v = Math.max(1, from); v < Math.min(limit, to + 1); v++)`: a fractional `from` keeps its
    // fraction in the loop variable, and `Math.max(1, from)` is 1 or `from` itself.
    let mut v = if from > 1.0 { from } else { 1.0 };
    let v_end = (limit as f64).min(to + 1.0);
    let c_start = (cross_from + 2.0).max(0.0);
    let c_end = (cross_limit as f64).min(cross_to - 2.0);
    while v < v_end {
        let (mut strong, mut count, mut sum) = (0u32, 0u32, 0.0f64);
        // JS indexed `data[(py * width + px) * 4]` with real-valued loop variables: an integral product reads
        // that byte (a half-row offset when width is even), a fractional one reads `undefined`, whose NaN
        // poisons the row's sum so it can never qualify. Both outcomes are reproduced exactly.
        let mut poisoned = false;
        let mut c = c_start;
        while c < c_end {
            let (px, py) = if axis == Axis::X { (v, c) } else { (c, v) };
            let idx = (py * w as f64 + px) * 4.0;
            if idx.fract() != 0.0 {
                poisoned = true;
                break;
            }
            let i = idx as usize;
            let j = if axis == Axis::X {
                i - 4
            } else {
                i - (w as usize) * 4
            };
            let d = ((rgba[i] as i32 - rgba[j] as i32).abs()
                + (rgba[i + 1] as i32 - rgba[j + 1] as i32).abs()
                + (rgba[i + 2] as i32 - rgba[j + 2] as i32).abs()) as f64
                / 3.0;
            if d > 3.0 {
                strong += 1;
            }
            sum += d;
            count += 1;
            c += step as f64;
        }
        if !poisoned && count > 0 && strong as f64 / count as f64 > 0.68 && sum / count as f64 > 3.0
        {
            // `found = v` keeps the real-valued loop variable; callers only ever pass integers.
            found = Some(v);
            if choose == Choose::First {
                break;
            }
        }
        v += 1.0;
    }
    found
}

/// How far a textured sample and its left and right neighbours, the pixels whose difference made it a sample, are
/// from the previous frame `offset` bytes away (red channel, summed over the three). Standing still means the edge
/// itself stays put: the sample pixel alone is often the flat side of a glyph edge, white on a white page, and the
/// previous frame's white anywhere else matched it exactly. Scrolling back up a page of cards (the factor-4 cards
/// scenario, frames 29 and 34), the region's top rows show text where the previous frame showed blank card, their
/// page partners lie above the region, and these white samples alone made them stand still: the band ran down to
/// the next card border and covered 776 pixels of text no other frame showed.
fn texture_difference(previous: &[u8], current: &[u8], i: usize, offset: i64) -> i64 {
    [i - 4, i, i + 4]
        .iter()
        .map(|&p| (previous[(p as i64 + offset) as usize] as i64 - current[p] as i64).abs())
        .sum()
}

/// Sticky-band evidence for one observation. `carry` are the previous observation's bands, retained while
/// every native pixel under them is unchanged. Returns the bands to exclude from the moving canvas.
///
/// A row is band evidence when its textured samples disagree with the accepted page translation and agree with the
/// previous frame at a small vertical shift of their own: zero (a header pinned to the screen), or any `k` with
/// `|k| <= min(16, |dy| / 4)` and `|dy - k| >= 8`. A header that collapses or expands at its own speed while the page
/// scrolls far faster (new_ip_8: 2–12 px against 60–135 px a frame) is still screen chrome for that observation; the
/// window stays a quarter of the page's step so content moving at a large share of the page's speed is not, and
/// at least 8 px from the page's own step so a slow scroll cannot match the page itself. A row whose page partner
/// (`y + dy`) falls outside the region takes no shift of its own: its page comparison reads screen chrome.
#[allow(clippy::too_many_arguments)]
pub fn sticky_occlusions(
    previous: &[u8],
    current: &[u8],
    width: usize,
    height: usize,
    region: Rect,
    motion_x: f64,
    motion_y: f64,
    carry_in: &[Rect],
) -> Vec<Rect> {
    let (w, h) = (width as i64, height as i64);
    // A clock/cursor elsewhere may change a paused frame. Retain an already-proven sticky band only while
    // ALL its native RGBA pixels are unchanged; do not drop the mask just because the page stops scrolling.
    let carry: Vec<Rect> = carry_in
        .iter()
        .copied()
        .filter(|o| {
            if o.x < 0.0 || o.y < 0.0 || o.x + o.width > w as f64 || o.y + o.height > h as f64 {
                return false;
            }
            let y_end = o.y + o.height;
            let mut y = o.y.ceil();
            while y < y_end {
                let start = ((y as i64 * w) as f64 + (o.x).ceil()) as usize * 4;
                let end = ((y as i64 * w) as f64 + (o.x + o.width).ceil()) as usize * 4;
                if previous[start..end] != current[start..end] {
                    return false;
                }
                y += 1.0;
            }
            true
        })
        .collect();
    if crate::kernels::geometry::js_hypot(motion_x, motion_y) < 2.0 {
        return carry;
    }
    let r = region;
    let (dx, dy) = (js_round(motion_x) as i64, js_round(motion_y) as i64);
    let end = (h - 2).min(js_floor(r.y + (288.0f64).min(r.height * 0.23)) as i64);
    let start = 2i64.max(js_floor(r.y) as i64);
    let step = 1i64.max(js_floor(r.width / 700.0) as i64);
    let (mut last_fixed, mut strong_rows, mut matched) = (-1i64, 0u32, 0u32);
    let mut below_page = false;
    let x_start = 2i64.max(js_ceil(r.x) as i64);
    let x_end = (w - 2) as f64;
    let window = (dy.abs() / 4).min(16);
    let mut samples: Vec<usize> = Vec::new();
    for y in start..end {
        if y + dy < 2 || y + dy >= h - 2 {
            continue;
        }
        let (mut zero, mut shifted) = (0i64, 0i64);
        samples.clear();
        let mut x = x_start;
        // `x < Math.min(w - 2, r.x + r.width)` compares against a real bound.
        while (x as f64) < x_end.min(r.x + r.width) {
            if x + dx < 2 || x + dx >= w - 2 {
                x += step;
                continue;
            }
            let i = ((y * w + x) * 4) as usize;
            if (current[i - 4] as i32 - current[i + 4] as i32).abs() < 24 {
                x += step;
                continue;
            }
            let j = (((y + dy) * w + x + dx) * 4) as usize;
            zero += texture_difference(previous, current, i, 0);
            shifted += (previous[j] as i64 - current[i] as i64).abs();
            samples.push(i);
            x += step;
        }
        let n = samples.len() as u32;
        let nf = n as f64;
        if n < 8 {
            continue;
        }
        let page = (shifted as f64) / nf <= 18.0;
        // Agreement with the previous frame at zero shift, or at a small shift of the band's own. A shift of its own
        // needs the page's own position of this row inside the region: above it (scrolling back at the region's top
        // edge) the page-shift comparison reads fixed chrome, which never matches, and says nothing about the page.
        let mut still = (zero as f64) / (3.0 * nf) < 6.0;
        let page_inside = (y + dy) as f64 >= r.y && ((y + dy) as f64) < r.y + r.height;
        let mut k = if page_inside { -window } else { window + 1 };
        while !still && k <= window {
            if k != 0 && (dy - k).abs() >= 8 && y + k >= 2 && y + k < h - 2 {
                let offset = k * w * 4;
                let sum: i64 = samples
                    .iter()
                    .map(|&i| texture_difference(previous, current, i, offset))
                    .sum();
                still = (sum as f64) / (3.0 * nf) < 6.0;
            }
            k += 1;
        }
        #[cfg(test)]
        if y < 100 {
            eprintln!(
                "DBGR y={y} n={n} page={page} still={still} zero={} shifted={}",
                zero as f64 / nf,
                shifted as f64 / nf
            );
        }
        if page {
            // A row the page's motion explains and no standing still does is page content. A row both explain says
            // nothing either way, nor does one whose page partner lies outside the region (it reads fixed chrome).
            below_page |= !still && page_inside;
            continue;
        }
        if still {
            // A sticky band runs down from the region's top: rows that stand still below page content are something
            // else, and the band drawn from the top down to them would cover that page content (new_mac_4: a pointer
            // resting in a blank gap under scrolling text, beside a column ruler, made a 151 px band). Such a frame
            // has no band of its own.
            if below_page {
                return carry;
            }
            last_fixed = y;
            strong_rows += 1;
            matched += n;
        }
    }
    if strong_rows < 4 || matched < 64 || last_fixed < 0 {
        return carry;
    }
    let edge = stationary_boundary(
        current,
        width,
        height,
        Axis::Y,
        (last_fixed + 1) as f64,
        (end.min(last_fixed + 80)) as f64,
        r.x,
        r.x + r.width,
        Choose::First,
    );
    match edge {
        Some(edge) if edge - start as f64 <= r.height * 0.23 => vec![Rect {
            x: r.x,
            y: r.y,
            width: r.width,
            height: edge - r.y + 1.0,
        }],
        _ => carry,
    }
}

/// Visible structure of a masked area on a native frame: how many sampled points sit on an edge, across rows
/// (`vertical`) and across columns (`horizontal`), and on how many distinct sampled rows and columns such a point
/// lies. Sampling follows the bands' texture test: every 2nd analysis row and column, the native pixel at
/// `floor(x·factor)`, its red channel against the pixels `round(factor)` away, an edge where they differ by more
/// than 12. A point is sampled only where the analysis pixels on both sides of it are in the mask as well, so
/// structure next to the area does not count for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Structure {
    pub vertical: u32,
    pub horizontal: u32,
    pub rows: u32,
    pub cols: u32,
}

#[allow(clippy::too_many_arguments)]
pub fn visible_structure(
    rgba: &[u8],
    width: usize,
    height: usize,
    mask: &[u8],
    mask_width: usize,
    mask_height: usize,
    factor: f64,
) -> Structure {
    let (w, h) = (width as i64, height as i64);
    let (mw, mh) = (mask_width as i64, mask_height as i64);
    let step = (js_round(factor) as i64).max(1);
    let inside =
        |x: i64, y: i64| x >= 0 && y >= 0 && x < mw && y < mh && mask[(y * mw + x) as usize] != 0;
    let red = |x: i64, y: i64| rgba[((y * w + x) * 4) as usize] as i32;
    let mut out = Structure::default();
    let mut cols = vec![false; mask_width];
    let mut y = 1i64;
    while y < mh - 1 {
        let ny = js_floor(y as f64 * factor) as i64;
        let mut row_hit = false;
        let mut x = 1i64;
        while x < mw - 1 {
            if inside(x, y) {
                let nx = js_floor(x as f64 * factor) as i64;
                let mut hit = false;
                if inside(x, y - 1)
                    && inside(x, y + 1)
                    && ny - step >= 0
                    && ny + step < h
                    && nx < w
                    && (red(nx, ny - step) - red(nx, ny + step)).abs() > 12
                {
                    out.vertical += 1;
                    hit = true;
                }
                if inside(x - 1, y)
                    && inside(x + 1, y)
                    && nx - step >= 0
                    && nx + step < w
                    && ny < h
                    && (red(nx - step, ny) - red(nx + step, ny)).abs() > 12
                {
                    out.horizontal += 1;
                    hit = true;
                }
                if hit {
                    row_hit = true;
                    cols[x as usize] = true;
                }
            }
            x += 2;
        }
        if row_hit {
            out.rows += 1;
        }
        y += 2;
    }
    out.cols = cols.iter().filter(|&&c| c).count() as u32;
    out
}

#[cfg(test)]
mod tests {
    //! Ways the sticky-band test can fail, written before widening it to bands that move at their own small speed
    //! (new_ip_8: the page scrolls 60–135 px a frame while the header slides 2–12 px):
    //! - a band that holds still is no longer found (the historical case);
    //! - a band sliding 2, 5 or 12 px a frame over a fast page is still missed;
    //! - page content, moving at the page's speed, is taken for a band, including vertically periodic content that
    //!   matches itself at a small shift;
    //! - a band moving at a large share of the page's speed (a parallax hero at half speed) is taken for sticky, or a
    //!   slow scroll lets the shift window reach the page's own displacement;
    //! - a shift window reaching above the frame's top reads out of bounds;
    //! - a band sliding down while the page scrolls back (the header expanding again) is missed.
    //! - rows that stand still below rows that follow the page (a resting pointer in a blank gap under scrolling text)
    //!   are taken for a band running down from the region's top.
    use super::*;

    const W: usize = 400;
    const H: usize = 600;
    const BAND: i64 = 64;

    /// Textured value with vertical and horizontal structure at every pixel, like anti-aliased glyphs or a photo.
    fn noise(x: i64, y: i64, seed: u32) -> u8 {
        let mut v =
            (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed;
        v ^= v >> 15;
        v = v.wrapping_mul(0x2c1b_3c6d);
        v ^= v >> 12;
        (v & 0xff) as u8
    }

    fn put(frame: &mut [u8], x: usize, y: usize, v: u8) {
        let i = (y * W + x) * 4;
        frame[i..i + 4].copy_from_slice(&[v, v.wrapping_mul(3), 255 - v, 255]);
    }

    /// A frame of the page at `page` (world row of screen row 0) under a 64-row band whose top is at screen row
    /// `band_top` (rows above 0 clipped); the band's last row is a uniform rule. `page_row` maps a world row to the
    /// texture row, so a periodic page can be drawn.
    fn frame(page: i64, band_top: Option<i64>, page_row: &dyn Fn(i64) -> i64) -> Vec<u8> {
        let mut out = vec![0u8; W * H * 4];
        for y in 0..H as i64 {
            for x in 0..W as i64 {
                let v = match band_top {
                    Some(top) if y >= top && y < top + BAND => {
                        if y - top == BAND - 1 {
                            30
                        } else {
                            noise(x, y - top, 7)
                        }
                    }
                    _ => noise(x, page_row(y + page), 1),
                };
                put(&mut out, x as usize, y as usize, v);
            }
        }
        out
    }

    fn region() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: W as f64,
            height: H as f64,
        }
    }

    fn plain(y: i64) -> i64 {
        y
    }

    fn bands(previous: &[u8], current: &[u8], dy: f64) -> Vec<Rect> {
        sticky_occlusions(previous, current, W, H, region(), 0.0, dy, &[])
    }

    fn band_bottom(found: &[Rect]) -> Option<f64> {
        found.first().map(|b| b.y + b.height)
    }

    #[test]
    fn a_still_band_over_a_scrolling_page_is_found() {
        let previous = frame(0, Some(0), &plain);
        let current = frame(40, Some(0), &plain);
        assert_eq!(band_bottom(&bands(&previous, &current, 40.0)), Some(64.0));
    }

    #[test]
    fn a_band_sliding_at_its_own_small_speed_is_found() {
        for (k, dy) in [(2, 60.0), (5, 60.0), (12, 60.0), (3, 135.0)] {
            let previous = frame(0, Some(0), &plain);
            let current = frame(dy as i64, Some(-k), &plain);
            assert_eq!(
                band_bottom(&bands(&previous, &current, dy)),
                Some((BAND - k) as f64),
                "band sliding {k} px over a page moving {dy} px"
            );
        }
    }

    #[test]
    fn a_band_sliding_down_while_the_page_scrolls_back_is_found() {
        // The header expands again: it moves 6 px down while the page moves 40 px back. The band starts below a
        // 20-row status strip, so the shift window reaches rows above the band but stays inside the frame.
        let previous = frame(-40, Some(20), &plain);
        let current = frame(-80, Some(26), &plain);
        let region = Rect {
            x: 0.0,
            y: 20.0,
            width: W as f64,
            height: H as f64 - 20.0,
        };
        let found = sticky_occlusions(&previous, &current, W, H, region, 0.0, -40.0, &[]);
        assert_eq!(band_bottom(&found), Some(26.0 + BAND as f64));
    }

    #[test]
    fn page_content_is_never_a_band() {
        let previous = frame(0, None, &plain);
        let current = frame(40, None, &plain);
        assert!(bands(&previous, &current, 40.0).is_empty());
        // Vertically periodic content (period 6, page step 40 not a multiple of it) matches itself at a small shift
        // (k = 4 or −2), but it also matches the page's own displacement, so it is still page content.
        let periodic = |y: i64| y.rem_euclid(6);
        let previous = frame(0, None, &periodic);
        let current = frame(40, None, &periodic);
        assert!(bands(&previous, &current, 40.0).is_empty());
    }

    #[test]
    fn rows_whose_page_partner_is_chrome_above_the_region_take_no_shift() {
        // Scrolling back under a 40-row status strip (outside the region): the page partner of the region's first
        // rows is the strip, so their page comparison fails for any content. Content that repeats every 9 rows there
        // (card borders, list rules) matches itself at k = −9 and would make a band of page content.
        let periodic = |y: i64| y.rem_euclid(9);
        let strip = |f: &mut Vec<u8>| {
            for y in 0..40 {
                for x in 0..W {
                    put(f, x, y, 30);
                }
            }
        };
        let mut previous = frame(0, None, &periodic);
        let mut current = frame(-37, None, &periodic);
        strip(&mut previous);
        strip(&mut current);
        let region = Rect {
            x: 0.0,
            y: 40.0,
            width: W as f64,
            height: H as f64 - 40.0,
        };
        assert!(sticky_occlusions(&previous, &current, W, H, region, 0.0, -37.0, &[]).is_empty());
    }

    #[test]
    fn content_at_a_large_share_of_the_page_speed_is_not_a_band() {
        // A parallax hero at half the page's speed: its shift (20) is beyond the window (|dy| / 4 = 10).
        let previous = frame(0, Some(0), &plain);
        let current = frame(40, Some(-20), &plain);
        assert!(bands(&previous, &current, 40.0).is_empty());
        // Just past the window: 11 px over a 40 px step.
        let current = frame(40, Some(-11), &plain);
        assert!(bands(&previous, &current, 40.0).is_empty());
    }

    #[test]
    fn content_slower_than_a_quarter_of_the_page_is_a_band() {
        // The known cost of the window: content in the top 23 % moving at a fifth of the page's speed (a slow parallax
        // hero) is excluded from this observation like a sticky header.
        let previous = frame(0, Some(0), &plain);
        let current = frame(40, Some(-8), &plain);
        assert_eq!(
            band_bottom(&bands(&previous, &current, 40.0)),
            Some((BAND - 8) as f64)
        );
    }

    #[test]
    fn a_slow_scroll_keeps_the_shift_away_from_the_page() {
        // Page step 10: the window is ±2 and |10 − k| ≥ 8 leaves k ∈ {−2..2}; a band moving 2 px is found.
        let previous = frame(0, Some(0), &plain);
        let current = frame(10, Some(-2), &plain);
        assert_eq!(
            band_bottom(&bands(&previous, &current, 10.0)),
            Some((BAND - 2) as f64)
        );
        // Page step 9: |9 − 2| < 8, so a 2 px move is too close to the page's own to count; zero shift only.
        let current = frame(9, Some(-2), &plain);
        assert!(bands(&previous, &current, 9.0).is_empty());
        // Page step 8: the window is ±2 but only k ≤ 0 keep |8 − k| ≥ 8; a band moving up 2 px is not found.
        let current = frame(8, Some(-2), &plain);
        assert!(bands(&previous, &current, 8.0).is_empty());
    }

    /// A code editor (new_mac_4): text scrolling at the region's top, and lower down, where the page shows a blank gap
    /// in both frames, a pointer resting on screen and a column ruler running the whole height. `page` is the world
    /// row of screen row 0.
    fn editor(page: i64) -> Vec<u8> {
        let mut out = vec![0u8; W * H * 4];
        for y in 0..H as i64 {
            for x in 0..W as i64 {
                let world = y + page;
                let v = if x == 200 || x == 201 || (300..306).contains(&x) && (70..90).contains(&y)
                {
                    250
                } else if (60..120).contains(&world) {
                    20
                } else {
                    noise(x, world, 1)
                };
                put(&mut out, x as usize, y as usize, v);
            }
        }
        out
    }

    #[test]
    fn a_resting_pointer_below_scrolling_text_is_not_a_band() {
        // The pointer's rows, inside the blank gap, agree at zero shift and not at the page's step; the text rows
        // above them follow the page. A sticky band runs down from the region's top, so the band is not there; taking
        // it hid the rows the pointer had covered while they scrolled up past it, and its burn-in stayed.
        let found = bands(&editor(0), &editor(14), 14.0);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn the_shift_window_never_reads_above_the_frame() {
        // Rows from 2 with the window reaching k = −10 (page step 40): a band at the very top moving down 3 px against
        // the page's direction has rows 2.. whose shifted partner is above row 0; those shifts are skipped, not read.
        let previous = frame(0, Some(0), &plain);
        let current = frame(40, Some(3), &plain);
        assert_eq!(
            band_bottom(&bands(&previous, &current, 40.0)),
            Some((BAND + 3) as f64)
        );
    }

    #[test]
    fn white_beside_new_text_is_not_a_row_standing_still() {
        // Scrolling back up a white page (the factor-4 cards scenario, frames 29 and 34): text comes in at the region's
        // top where the previous frame showed blank white, and those rows' page partners lie above the region, so only
        // standing still can explain them. A textured sample is a pixel whose left and right neighbours differ; beside
        // a 1-px stroke it is the white on either side of it, and the previous frame's white at the same place matched
        // it exactly. The rows read as standing still, the band ran down to the next rule and covered text no other
        // frame showed: 776 pixels missing from the print.
        let (top, step) = (80i64, -67i64);
        // World rows `c..`: 50 rows of strokes, a rule, then 130 blank rows, then textured page.
        let world = |x: i64, wy: i64| -> u8 {
            match wy {
                0..=49 if x % 20 == 7 => 40,
                0..=49 => 255,
                50 => 60,
                51..=180 => 255,
                _ => noise(x, wy, 3),
            }
        };
        let shot = |pose: i64| -> Vec<u8> {
            let mut out = vec![0u8; W * H * 4];
            for y in 0..H as i64 {
                for x in 0..W as i64 {
                    let v = if y < top {
                        noise(x, y, 9)
                    } else {
                        world(x, y - top + pose)
                    };
                    put(&mut out, x as usize, y as usize, v);
                }
            }
            out
        };
        // The current frame shows world row 0 at the region's top; the previous one was 67 rows further down.
        let (previous, current) = (shot(-step), shot(0));
        let region = Rect {
            x: 0.0,
            y: top as f64,
            width: W as f64,
            height: (H as i64 - top) as f64,
        };
        let found = sticky_occlusions(&previous, &current, W, H, region, 0.0, step as f64, &[]);
        assert!(found.is_empty(), "{found:?}");
    }
}

#[cfg(test)]
mod structure_tests {
    use super::*;

    /// A grey `w × h` RGBA frame at factor 1 with `paint(x, y)` as its level.
    fn frame(w: usize, h: usize, paint: impl Fn(usize, usize) -> u8) -> Vec<u8> {
        let mut out = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let v = paint(x, y);
                out[(y * w + x) * 4..(y * w + x) * 4 + 3].fill(v);
            }
        }
        out
    }

    #[test]
    fn a_blank_area_has_no_structure() {
        let img = frame(40, 40, |_, _| 0);
        let s = visible_structure(&img, 40, 40, &[1; 1600], 40, 40, 1.0);
        assert_eq!(s, Structure::default());
    }

    #[test]
    fn a_single_horizontal_line_sits_on_at_most_two_sampled_rows() {
        // pub_2's empty chat margin: black but for the line where it meets the bar above.
        let img = frame(40, 40, |_, y| if y == 10 { 80 } else { 0 });
        let s = visible_structure(&img, 40, 40, &[1; 1600], 40, 40, 1.0);
        assert!(s.rows <= 2 && s.cols >= 15 && s.horizontal == 0, "{s:?}");
    }

    #[test]
    fn a_single_vertical_line_sits_on_at_most_two_sampled_columns() {
        let img = frame(40, 40, |x, _| if x == 10 { 80 } else { 0 });
        let s = visible_structure(&img, 40, 40, &[1; 1600], 40, 40, 1.0);
        assert!(s.cols <= 2 && s.rows >= 15 && s.vertical == 0, "{s:?}");
    }

    #[test]
    fn icons_spread_over_the_area_have_structure_on_many_rows_and_columns() {
        let img = frame(
            40,
            40,
            |x, y| if x % 10 < 4 && y % 10 < 4 { 200 } else { 0 },
        );
        let s = visible_structure(&img, 40, 40, &[1; 1600], 40, 40, 1.0);
        assert!(
            s.rows >= 3 && s.cols >= 3 && s.vertical > 0 && s.horizontal > 0,
            "{s:?}"
        );
    }

    #[test]
    fn structure_outside_the_mask_does_not_count() {
        // Texture everywhere, but the mask is a blank 20 × 20 square in the middle that the texture never enters;
        // the texture abuts the square on all sides.
        let img = frame(40, 40, |x, y| {
            if (10..30).contains(&x) && (10..30).contains(&y) {
                0
            } else {
                ((x * 37 + y * 91) % 256) as u8
            }
        });
        let mut mask = vec![0u8; 1600];
        for y in 10..30 {
            mask[y * 40 + 10..y * 40 + 30].fill(1);
        }
        let s = visible_structure(&img, 40, 40, &mask, 40, 40, 1.0);
        assert_eq!(s, Structure::default());
    }

    #[test]
    fn native_points_are_read_at_the_factor() {
        // Factor 5: the analysis grid is 8 × 8 over a 40 × 40 native frame; 5 px icons every 15 native px.
        let img = frame(40, 40, |x, y| {
            if (x / 5) % 3 == 0 && (y / 5) % 3 == 0 {
                200
            } else {
                0
            }
        });
        let s = visible_structure(&img, 40, 40, &[1; 64], 8, 8, 5.0);
        assert!(s.rows >= 3 && s.cols >= 3, "{s:?}");
    }
}
