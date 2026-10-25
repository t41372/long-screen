//! Presentation canvas synthesis (`src/core/framing.ts`): layout/coordinate mapping, background-extension
//! statistics, and the two per-tile passes `buildFramedCanvas` drives (chrome/content copy, then source-tile
//! evidence fold). Tile-cache traversal, the O(perimeter) candidate pre-check and KV writes stay in TS.

use crate::kernels::geometry::{js_ceil, js_floor, Rect};
use crate::kernels::region::Region;

/// Presentation layout: native chrome (`pane`) plus a decorative background-extension band wrapped around the
/// live content rect (`content`), matching `frameLayout`.
#[derive(Clone, Copy)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub pane: Rect,
    pub content: Rect,
    pub dx: f64,
    pub dy: f64,
    pub seam_x: f64,
}

pub fn frame_layout(
    source_width: f64,
    source_height: f64,
    pane: Rect,
    bounds_width: f64,
    bounds_height: f64,
) -> Layout {
    let content = Rect {
        x: pane.x,
        y: pane.y,
        width: pane.width.max(js_ceil(bounds_width) as f64),
        height: pane.height.max(js_ceil(bounds_height) as f64),
    };
    Layout {
        width: source_width + content.width - pane.width,
        height: source_height + content.height - pane.height,
        pane,
        content,
        dx: content.width - pane.width,
        dy: content.height - pane.height,
        seam_x: (pane.x + pane.width / 2.0).floor(),
    }
}

/// Native source coordinate for a context pixel: `None` is a decorative extension, `Some(None)` is
/// reconstructed content, `Some(Some((x, y)))` is a native-chrome pixel copied from the reference frame.
pub enum Coordinate {
    Content,
    Extension,
    Source(f64, f64),
}

pub fn frame_coordinate(layout: &Layout, x: f64, y: f64) -> Coordinate {
    let (p, c, dx, dy, seam_x) = (
        layout.pane,
        layout.content,
        layout.dx,
        layout.dy,
        layout.seam_x,
    );
    if x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height {
        return Coordinate::Content;
    }
    if y < p.y || y >= c.y + c.height {
        let sy = if y < p.y { y } else { y - dy };
        if x >= seam_x && x < seam_x + dx {
            return Coordinate::Extension;
        }
        return Coordinate::Source(if x < seam_x { x } else { x - dx }, sy);
    }
    if y >= p.y + p.height {
        return Coordinate::Extension;
    }
    Coordinate::Source(if x < p.x { x } else { x - dx }, y)
}

/// Most frequent value and how many times it occurs; ties keep the first value to reach the winning count (matches
/// `Map` insertion order under JS's single-pass "first strictly greater count wins" scan). Empty input yields (0, 0).
fn mode(values: &[u32]) -> (u32, u32) {
    let mut counts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut best = values.first().copied().unwrap_or(0);
    let mut count = 0u32;
    for &v in values {
        let n = counts.entry(v).or_insert(0);
        *n += 1;
        if *n > count {
            count = *n;
            best = v;
        }
    }
    (best, count)
}

/// The modal colour of one reference row or column across the pane, how many of the pane's samples are exactly it,
/// how many lie within `BACKGROUND_TOLERANCE` of it, and the colour its extension paints (`fill`, 0 for none).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Background {
    pub colour: u32,
    pub exact: u32,
    pub near: u32,
    pub samples: u32,
    pub fill: u32,
}

/// Largest per-channel difference from the mode that still counts as the same background colour: codec noise moves
/// a flat bar's pixels a few levels, while an icon or the wallpaper behind a Dock differs from its neighbours by far
/// more.
pub const BACKGROUND_TOLERANCE: u8 = 8;

/// A row or column has a background colour to extend when its mode holds at least this share (numerator,
/// denominator) of the samples exactly: drawn UI repeats its colours exactly, so a bar keeps its extension even where
/// buttons or a long URL cover most of the row (the lowest measured on the 32 recordings: 24.6 % in pub_4's address
/// bar), while no colour repeats on more than 16.7 % of a row of photos (new_ip_6) or 10.8 % of a row of Dock icons
/// over the wallpaper (own_a, own_d).
pub const EXACT_SUPPORT: (u32, u32) = (1, 5);

/// ... or when more than this share of the samples lies within `BACKGROUND_TOLERANCE` of the mode: a flat bar whose
/// pixels the codec left a few levels apart (own_a's dark menu bar: 12-20 % exact, 77-99 % within 8 levels; the lowest
/// such row or column measured is 56 %, in map's frosted sidebar). A row of Dock icons reaches exactly half at most.
pub const NEAR_SUPPORT: (u32, u32) = (1, 2);

impl Background {
    /// The colour the row extends with on its own: the mode when the row has one background colour (`EXACT_SUPPORT`,
    /// `NEAR_SUPPORT`), else transparent. Without one, the "mode" is whichever icon pixel happened to repeat, a
    /// different one on every row, and extending it paints stripes that were never on screen (§十 呈现画布).
    pub fn extension(&self) -> u32 {
        let (en, ed) = EXACT_SUPPORT;
        let samples = self.samples as u64;
        let flat = self.exact as u64 * ed as u64 >= samples * en as u64
            || majority(self.near, self.samples);
        if self.samples > 0 && flat {
            self.colour
        } else {
            0
        }
    }
}

/// `count` is more than `NEAR_SUPPORT` of `samples`.
#[inline]
fn majority(count: u32, samples: u32) -> bool {
    let (nn, nd) = NEAR_SUPPORT;
    count as u64 * nd as u64 > samples as u64 * nn as u64
}

/// One band of chrome rows (or columns) beside the pane, in order: a row without a background colour of its own
/// continues the colour of an extended neighbour when more than half of its own samples lie within
/// `BACKGROUND_TOLERANCE` of that colour. A frosted panel changes smoothly from column to column, and the mode of such
/// a column can be a minority colour that happens to repeat exactly (150 columns of map's sidebar: an exact mode on
/// 7-9 % of the samples, 15-17 levels from the colour most of them share with the column beside them), while a row of
/// Dock icons matches neither neighbour. Swept forwards, then backwards over the rows still without a colour, so a run
/// between two extended rows takes the first one's.
fn continue_band(
    list: &mut [Background],
    band: std::ops::Range<usize>,
    mut samples_of: impl FnMut(usize, &mut Vec<u32>),
) {
    let mut buffer = Vec::new();
    let mut agrees = |i: usize, colour: u32, buffer: &mut Vec<u32>| {
        buffer.clear();
        samples_of(i, buffer);
        let n = buffer.iter().filter(|&&v| near(v, colour)).count() as u32;
        majority(n, buffer.len() as u32)
    };
    for i in band.start + 1..band.end {
        let colour = list[i - 1].fill;
        if list[i].fill == 0 && colour != 0 && agrees(i, colour, &mut buffer) {
            list[i].fill = colour;
        }
    }
    for i in (band.start..band.end.saturating_sub(1)).rev() {
        let colour = list[i + 1].fill;
        if list[i].fill == 0 && colour != 0 && agrees(i, colour, &mut buffer) {
            list[i].fill = colour;
        }
    }
}

/// Whether two packed pixels differ by at most `BACKGROUND_TOLERANCE` in every channel.
#[inline]
fn near(a: u32, b: u32) -> bool {
    a.to_le_bytes()
        .iter()
        .zip(b.to_le_bytes())
        .all(|(&p, q)| p.abs_diff(q) <= BACKGROUND_TOLERANCE)
}

/// Packs one RGBA pixel the way a `Uint32Array` view over the same little-endian bytes would.
#[inline]
fn px32(rgba: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([
        rgba[i * 4],
        rgba[i * 4 + 1],
        rgba[i * 4 + 2],
        rgba[i * 4 + 3],
    ])
}

/// One sampled row/column per background axis, matching `backgrounds()`: the modal pixel sampled every
/// `max(1, floor(pane.dim / 128))` columns/rows across the pane, with its support and the colour its extension paints.
pub fn backgrounds(
    rgba: &[u8],
    image_width: usize,
    image_height: usize,
    pane: Rect,
) -> (Vec<Background>, Vec<Background>) {
    let xs = (1usize).max((pane.width / 128.0).floor() as usize);
    let ys = (1usize).max((pane.height / 128.0).floor() as usize);
    let row_samples = |y: usize, out: &mut Vec<u32>| {
        let mut x = pane.x as i64;
        while (x as f64) < pane.x + pane.width {
            out.push(px32(rgba, y * image_width + x as usize));
            x += xs as i64;
        }
    };
    let column_samples = |x: usize, out: &mut Vec<u32>| {
        let mut y = pane.y as i64;
        while (y as f64) < pane.y + pane.height {
            out.push(px32(rgba, y as usize * image_width + x));
            y += ys as i64;
        }
    };
    let of = |samples: &[u32]| {
        let (colour, exact) = mode(samples);
        let mut b = Background {
            colour,
            exact,
            near: samples.iter().filter(|&&v| near(v, colour)).count() as u32,
            samples: samples.len() as u32,
            fill: 0,
        };
        b.fill = b.extension();
        b
    };
    let mut rows = Vec::with_capacity(image_height);
    let mut columns = Vec::with_capacity(image_width);
    let mut samples = Vec::new();
    for y in 0..image_height {
        samples.clear();
        row_samples(y, &mut samples);
        rows.push(of(&samples));
    }
    for x in 0..image_width {
        samples.clear();
        column_samples(x, &mut samples);
        columns.push(of(&samples));
    }
    // The chrome bands the extension reads: the rows above and below the pane, the columns left and right of it.
    let clamp = |v: f64, n: usize| (v.max(0.0) as usize).min(n);
    let (top, bottom) = (
        clamp(pane.y, image_height),
        clamp(pane.y + pane.height, image_height),
    );
    let (left, right) = (
        clamp(pane.x, image_width),
        clamp(pane.x + pane.width, image_width),
    );
    continue_band(&mut rows, 0..top, row_samples);
    continue_band(&mut rows, bottom..image_height, row_samples);
    continue_band(&mut columns, 0..left, column_samples);
    continue_band(&mut columns, right..image_width, column_samples);
    (rows, columns)
}

/// Output tile buffers `buildFramedCanvas` mutates. `frozen` is written by the evidence fold, not read.
pub struct OutputTile<'a> {
    pub size: usize,
    pub pixels: &'a mut [u8],
    pub coverage: &'a mut [u8],
    pub provisional: &'a mut [u8],
    pub quality: &'a mut [u8],
    pub score: &'a mut [f32],
    pub owner: &'a mut [u32],
    pub conflicts: &'a mut [u8],
    pub frozen: &'a mut [u8],
}

/// One resident source tile the evidence fold reads from.
pub struct SourceTile<'a> {
    pub sx: i64,
    pub sy: i64,
    pub pixels: &'a [u8],
    pub coverage: &'a [u8],
    pub provisional: &'a [u8],
    pub quality: &'a [u8],
    pub score: &'a [f32],
    pub owner: &'a [u32],
    pub conflicts: &'a [u8],
    pub frozen: &'a [u8],
}

#[inline]
fn bit(bits: &[u8], p: usize) -> bool {
    bits[p >> 3] & (1 << (p & 7)) != 0
}
#[inline]
fn set_bit(bits: &mut [u8], p: usize) {
    bits[p >> 3] |= 1 << (p & 7);
}

fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    Rect {
        x,
        y,
        width: 0f64.max((a.x + a.width).min(b.x + b.width) - x),
        height: 0f64.max((a.y + a.height).min(b.y + b.height) - y),
    }
}

/// Chrome/content synthesis (`buildFramedCanvas`'s pass 1) for one output tile: every pixel of `bounds`
/// (already clipped to the framed canvas) either copies a native reference pixel, paints a background band,
/// or is left untouched (reconstructed-content interior, filled later by `fold_evidence`).
#[allow(clippy::too_many_arguments)]
pub fn paint_tile(
    out: &mut OutputTile<'_>,
    layout: &Layout,
    bounds: Rect,
    source: &[u8],
    source_width: usize,
    source_height: usize,
    bg_rows: &[Background],
    bg_columns: &[Background],
    ignore: &[Region],
) {
    let size = out.size;
    let bw = bounds.width as i64;
    let bh = bounds.height as i64;
    for y in 0..bh {
        for x in 0..bw {
            let (ox, oy) = (bounds.x + x as f64, bounds.y + y as f64);
            let at = (y as usize) * size + x as usize;
            match frame_coordinate(layout, ox, oy) {
                Coordinate::Content => continue,
                Coordinate::Source(sx, sy) => {
                    if ignore
                        .iter()
                        .any(|r| r.contains(sx, sy, source_width as f64, source_height as f64))
                    {
                        continue;
                    }
                    let src = sy as usize * source_width + sx as usize;
                    out.pixels[at * 4..at * 4 + 4].copy_from_slice(&source[src * 4..src * 4 + 4]);
                    if out.pixels[at * 4 + 3] != 0 {
                        set_bit(out.coverage, at);
                    }
                }
                Coordinate::Extension => {
                    let v = if oy < layout.pane.y || oy >= layout.content.y + layout.content.height
                    {
                        bg_row(
                            bg_rows,
                            if oy < layout.pane.y {
                                oy
                            } else {
                                oy - layout.dy
                            },
                        )
                    } else {
                        bg_column(
                            bg_columns,
                            if ox < layout.pane.x {
                                ox
                            } else {
                                ox - layout.dx
                            },
                        )
                    };
                    out.pixels[at * 4..at * 4 + 4].copy_from_slice(&v.to_le_bytes());
                }
            }
        }
    }
}

/// `bg.rows[oy]`/`bg.columns[ox]` with JS's out-of-bounds-index-is-`undefined` semantics: `dx > pane.x` (a
/// small chrome pane inside a much larger background extension) makes `ox - dx` negative, which JS reads as
/// `undefined` and writes as 0. A row or column without a background colour to extend is 0 too.
#[inline]
fn bg_row(rows: &[Background], y: f64) -> u32 {
    if y < 0.0 {
        0
    } else {
        rows.get(y as usize).map_or(0, |b| b.fill)
    }
}
#[inline]
fn bg_column(columns: &[Background], x: f64) -> u32 {
    if x < 0.0 {
        0
    } else {
        columns.get(x as usize).map_or(0, |b| b.fill)
    }
}

struct BlockAgg {
    quality: u8,
    score: f32,
    score_set: bool,
    owner_single: Option<u32>,
    owner_conflict: bool,
    conflicts: bool,
    frozen: bool,
}

/// Evidence fold (`buildFramedCanvas`'s pass 2) for one output tile against up to four overlapping source
/// tiles: copies covered source pixels into the tile (healing provisional bits, carrying coverage), then
/// folds each touched 16×16 block's quality/score/owner/conflicts/frozen into the destination block.
#[allow(clippy::too_many_arguments)]
pub fn fold_evidence(
    out: &mut OutputTile<'_>,
    layout: &Layout,
    source_bounds_x: f64,
    source_bounds_y: f64,
    bounds: Rect,
    sources: &[SourceTile<'_>],
) {
    const QUALITY_BLOCK: i64 = 16;
    let size = out.size as i64;
    let overlap = intersect(bounds, layout.content);
    if overlap.width <= 0.0 || overlap.height <= 0.0 {
        return;
    }
    let wx = js_floor(source_bounds_x + overlap.x - layout.content.x) as i64;
    let wy = js_floor(source_bounds_y + overlap.y - layout.content.y) as i64;
    let mut evidence: std::collections::HashMap<i64, BlockAgg> = std::collections::HashMap::new();
    let blocks_per_row = size / QUALITY_BLOCK;
    for t in sources {
        let part = intersect(
            Rect {
                x: wx as f64,
                y: wy as f64,
                width: overlap.width,
                height: overlap.height,
            },
            Rect {
                x: (t.sx * size) as f64,
                y: (t.sy * size) as f64,
                width: size as f64,
                height: size as f64,
            },
        );
        if part.width <= 0.0 || part.height <= 0.0 {
            continue;
        }
        let (py, ph, px, pw) = (
            part.y as i64,
            part.height as i64,
            part.x as i64,
            part.width as i64,
        );
        for y in py..py + ph {
            let dy = (overlap.y - bounds.y) as i64 + y - wy;
            let dx = (overlap.x - bounds.x) as i64 + px - wx;
            let from = (y - t.sy * size) * size + px - t.sx * size;
            for x in 0..pw {
                let source_pixel = (from + x) as usize;
                let destination_pixel = (dy * size + dx + x) as usize;
                out.pixels[destination_pixel * 4..destination_pixel * 4 + 4]
                    .copy_from_slice(&t.pixels[source_pixel * 4..source_pixel * 4 + 4]);
                if bit(t.coverage, source_pixel) {
                    set_bit(out.coverage, destination_pixel);
                    let sbx = (source_pixel as i64 % size) / QUALITY_BLOCK;
                    let sby = (source_pixel as i64 / size) / QUALITY_BLOCK;
                    let source_block = sby * blocks_per_row + sbx;
                    let dbx = (destination_pixel as i64 % size) / QUALITY_BLOCK;
                    let dby = (destination_pixel as i64 / size) / QUALITY_BLOCK;
                    let destination_block = dby * blocks_per_row + dbx;
                    let agg = evidence.entry(destination_block).or_insert(BlockAgg {
                        quality: 255,
                        score: 0.0,
                        score_set: false,
                        owner_single: None,
                        owner_conflict: false,
                        conflicts: false,
                        frozen: false,
                    });
                    agg.quality = agg.quality.min(t.quality[source_block as usize]);
                    let sscore = t.score[source_block as usize];
                    agg.score = if agg.score_set {
                        agg.score.min(sscore)
                    } else {
                        sscore
                    };
                    agg.score_set = true;
                    let sowner = t.owner[source_block as usize];
                    match agg.owner_single {
                        None if !agg.owner_conflict => agg.owner_single = Some(sowner),
                        Some(existing) if existing != sowner => {
                            agg.owner_conflict = true;
                            agg.owner_single = None;
                        }
                        _ => {}
                    }
                    agg.conflicts |= t.conflicts[source_block as usize] != 0;
                    agg.frozen |= t.frozen[source_block as usize] != 0;
                }
                if bit(t.provisional, source_pixel) {
                    set_bit(out.provisional, destination_pixel);
                }
            }
        }
    }
    for (q, agg) in evidence {
        out.quality[q as usize] = agg.quality;
        out.score[q as usize] = if agg.score_set { agg.score } else { 0.0 };
        out.conflicts[q as usize] = agg.conflicts as u8;
        out.frozen[q as usize] = agg.frozen as u8;
        // A single distinct non-zero owner across every contributing source block, else unowned (0) — the same
        // rule as `owners.size === 1 && !owners.has(0) ? [...owners][0] : 0` (a lone owner of 0 maps to 0 either way).
        out.owner[q as usize] = match agg.owner_single {
            Some(o) if o != 0 && !agg.owner_conflict => o,
            _ => 0,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn layout_matches_the_frozen_ts_geometry() {
        let layout = frame_layout(12.0, 10.0, rect(2.0, 2.0, 8.0, 6.0), 14.0, 12.0);
        assert_eq!((layout.width, layout.height), (18.0, 16.0));
    }

    #[test]
    fn coordinate_classifies_content_extension_and_source() {
        let layout = frame_layout(12.0, 10.0, rect(2.0, 2.0, 8.0, 6.0), 14.0, 12.0);
        assert!(matches!(
            frame_coordinate(&layout, 5.0, 5.0),
            Coordinate::Content
        ));
        match frame_coordinate(&layout, 0.0, 0.0) {
            Coordinate::Source(x, y) => assert_eq!((x, y), (0.0, 0.0)),
            _ => panic!("expected source"),
        }
    }

    /// A 24×20 reference whose pane is the 16×16 square at (4, 2): rows 0–1 above it and 18–19 below it are chrome,
    /// columns 0–3 and 20–23 beside it are chrome. Row 0 is a flat bar with one glyph pixel, row 1 a bar with text
    /// on exactly half its samples, row 18 a band of distinct pixels (icons over wallpaper), row 19 flat; column 1 is
    /// distinct down the pane, the other side columns flat.
    fn chrome_reference() -> (Vec<u8>, usize, usize, Rect) {
        let (w, h) = (24usize, 20usize);
        let pane = rect(4.0, 2.0, 16.0, 16.0);
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let p = match (y, x) {
                    (0, 9) => [0, 0, 0, 255],
                    (0, _) => [240, 240, 240, 255],
                    (1, _) if x % 2 == 0 => [30, 30, 30, 255],
                    (1, _) => [200, 210, 220, 255],
                    (18, _) => [(x * 12) as u8, (x * 7) as u8, 99, 255],
                    (19, _) => [10, 20, 30, 255],
                    (_, 1) => [(y * 12) as u8, 5, 5, 255],
                    _ => [60, 70, 80, 255],
                };
                rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&p);
            }
        }
        (rgba, w, h, pane)
    }

    fn paint_whole(
        rgba: &[u8],
        w: usize,
        h: usize,
        pane: Rect,
        bounds_w: f64,
        bounds_h: f64,
    ) -> (Layout, Vec<u8>, usize) {
        let layout = frame_layout(w as f64, h as f64, pane, bounds_w, bounds_h);
        let size = 64usize;
        let mut pixels = vec![0u8; size * size * 4];
        let (mut coverage, mut provisional) =
            (vec![0u8; size * size / 8], vec![0u8; size * size / 8]);
        let blocks = (size / 16) * (size / 16);
        let (mut quality, mut score, mut owner) =
            (vec![0u8; blocks], vec![0f32; blocks], vec![0u32; blocks]);
        let (mut conflicts, mut frozen) = (vec![0u8; blocks], vec![0u8; blocks]);
        let mut out = OutputTile {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            score: &mut score,
            owner: &mut owner,
            conflicts: &mut conflicts,
            frozen: &mut frozen,
        };
        let (bg_rows, bg_columns) = backgrounds(rgba, w, h, pane);
        paint_tile(
            &mut out,
            &layout,
            rect(0.0, 0.0, layout.width, layout.height),
            rgba,
            w,
            h,
            &bg_rows,
            &bg_columns,
            &[],
        );
        (layout, pixels, size)
    }

    fn at(pixels: &[u8], size: usize, x: f64, y: f64) -> [u8; 4] {
        let i = (y as usize * size + x as usize) * 4;
        pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn extension_rows_without_one_background_colour_stay_transparent() {
        // Content 10 px wider than the pane: the chrome rows get a 10-px band at the seam (x 12..22).
        let (rgba, w, h, pane) = chrome_reference();
        let (layout, pixels, size) = paint_whole(&rgba, w, h, pane, 26.0, 16.0);
        assert_eq!((layout.dx, layout.dy, layout.seam_x), (10.0, 0.0, 12.0));
        for x in 12..22 {
            let x = x as f64;
            // A bar with a glyph on it, and a bar whose text covers exactly half the samples, still extend.
            assert_eq!(
                at(&pixels, size, x, 0.0),
                [240, 240, 240, 255],
                "row 0 at {x}"
            );
            assert_eq!(at(&pixels, size, x, 1.0), [30, 30, 30, 255], "row 1 at {x}");
            // Every sample of row 18 is a different colour: no background to extend, so nothing is painted.
            assert_eq!(at(&pixels, size, x, 18.0), [0, 0, 0, 0], "row 18 at {x}");
            assert_eq!(
                at(&pixels, size, x, 19.0),
                [10, 20, 30, 255],
                "row 19 at {x}"
            );
        }
        // The native chrome on either side of the band is copied as before.
        assert_eq!(at(&pixels, size, 11.0, 18.0), [132, 77, 99, 255]);
        assert_eq!(at(&pixels, size, 22.0, 18.0), [144, 84, 99, 255]);
    }

    #[test]
    fn extension_columns_without_one_background_colour_stay_transparent() {
        // Content 3 px taller than the pane: the side columns extend down rows 18..21 beside it.
        let (rgba, w, h, pane) = chrome_reference();
        let (layout, pixels, size) = paint_whole(&rgba, w, h, pane, 16.0, 19.0);
        assert_eq!((layout.dx, layout.dy), (0.0, 3.0));
        for y in 18..21 {
            let y = y as f64;
            assert_eq!(
                at(&pixels, size, 0.0, y),
                [60, 70, 80, 255],
                "column 0 at {y}"
            );
            assert_eq!(at(&pixels, size, 1.0, y), [0, 0, 0, 0], "column 1 at {y}");
            assert_eq!(
                at(&pixels, size, 2.0, y),
                [60, 70, 80, 255],
                "column 2 at {y}"
            );
            assert_eq!(
                at(&pixels, size, 21.0, y),
                [60, 70, 80, 255],
                "column 21 at {y}"
            );
        }
        // Below the extension the bottom chrome is copied from the reference's last rows.
        assert_eq!(at(&pixels, size, 1.0, 22.0), [10, 20, 30, 255]);
    }

    /// `chrome_reference` with codec noise: row 0 and column 0 are flat bars whose pixels wander ±3 levels (no exact
    /// value holds more than 3 of the 16 samples), row 19 and column 2 step 9 levels from sample to sample.
    fn noisy_reference() -> (Vec<u8>, usize, usize, Rect) {
        let (mut rgba, w, h, pane) = chrome_reference();
        let mut set = |x: usize, y: usize, v: u8| {
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[v, v, v, 255])
        };
        for x in 0..w {
            set(x, 0, (40 + x % 7 - 3) as u8);
            set(x, 19, (100 + 9 * (x % 7)) as u8);
        }
        for y in 2..18 {
            set(0, y, (60 + y % 7 - 3) as u8);
            set(2, y, (100 + 9 * (y % 7)) as u8);
        }
        (rgba, w, h, pane)
    }

    #[test]
    fn a_flat_bar_with_codec_noise_extends_and_a_gradient_does_not() {
        let (rgba, w, h, pane) = noisy_reference();
        let (_, pixels, size) = paint_whole(&rgba, w, h, pane, 26.0, 16.0);
        for x in 12..22 {
            let x = x as f64;
            // The mode (41, the first value to reach 3 samples) is painted: every sample is within a few levels of it.
            assert_eq!(at(&pixels, size, x, 0.0), [41, 41, 41, 255], "row 0 at {x}");
            assert_eq!(at(&pixels, size, x, 19.0), [0, 0, 0, 0], "row 19 at {x}");
        }
        let (_, pixels, size) = paint_whole(&rgba, w, h, pane, 16.0, 19.0);
        for y in 18..21 {
            let y = y as f64;
            assert_eq!(
                at(&pixels, size, 0.0, y),
                [59, 59, 59, 255],
                "column 0 at {y}"
            );
            assert_eq!(at(&pixels, size, 2.0, y), [0, 0, 0, 0], "column 2 at {y}");
        }
    }

    /// One sample of a row or column that continues the flat `base` next to it (a frosted panel whose exact mode is
    /// a minority colour): ten of the sixteen samples sit within 3 levels of `base`, three are one other colour (the
    /// exact mode, first to three) and three are far apart.
    fn continuing(k: usize, base: [u8; 3]) -> [u8; 4] {
        match k % 5 {
            _ if [0, 5, 10].contains(&k) => [90, 90, 90, 255],
            _ if [1, 6, 11].contains(&k) => [200, (k * 20) as u8, 0, 255],
            m => [(base[0] as usize + m - 2) as u8, base[1], base[2], 255],
        }
    }

    #[test]
    fn a_row_without_a_colour_of_its_own_continues_an_extended_neighbour_its_samples_match() {
        let (mut rgba, w, h, pane) = chrome_reference();
        let mut set = |x: usize, y: usize, p: [u8; 4]| {
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&p)
        };
        for x in 0..w {
            set(x, 0, [240, 240, 240, 255]);
            // Row 1 continues row 0 above it, row 18 continues row 19 below it.
            set(x, 1, continuing(x.wrapping_sub(4), [240, 240, 240]));
            set(x, 18, continuing(x.wrapping_sub(4), [10, 20, 30]));
        }
        for y in 2..18 {
            set(1, y, continuing(y - 2, [60, 70, 80]));
        }
        let (_, pixels, size) = paint_whole(&rgba, w, h, pane, 26.0, 16.0);
        for x in 12..22 {
            let x = x as f64;
            assert_eq!(
                at(&pixels, size, x, 1.0),
                [240, 240, 240, 255],
                "row 1 at {x}"
            );
            assert_eq!(
                at(&pixels, size, x, 18.0),
                [10, 20, 30, 255],
                "row 18 at {x}"
            );
        }
        let (_, pixels, size) = paint_whole(&rgba, w, h, pane, 16.0, 19.0);
        for y in 18..21 {
            let y = y as f64;
            assert_eq!(
                at(&pixels, size, 1.0, y),
                [60, 70, 80, 255],
                "column 1 at {y}"
            );
        }
        // The rows of distinct pixels beside a flat row stay transparent (extension_rows_without_…): no stripes.
        let (rgba, w, h, pane) = chrome_reference();
        let (_, pixels, size) = paint_whole(&rgba, w, h, pane, 26.0, 16.0);
        assert_eq!(at(&pixels, size, 15.0, 18.0), [0, 0, 0, 0]);
    }

    #[test]
    fn a_background_needs_a_fifth_exact_or_a_majority_near() {
        let bg = |exact, near| Background {
            colour: 7,
            exact,
            near,
            samples: 20,
            fill: 0,
        };
        assert_eq!(bg(4, 4).extension(), 7);
        assert_eq!(bg(3, 10).extension(), 0);
        assert_eq!(bg(3, 11).extension(), 7);
        assert_eq!(bg(0, 0).extension(), 0);
        let empty = Background {
            colour: 7,
            exact: 0,
            near: 0,
            samples: 0,
            fill: 0,
        };
        assert_eq!(empty.extension(), 0);
    }

    #[test]
    fn mode_breaks_ties_by_first_arrival() {
        // [3, 1, 1, 3]: 1 reaches count 2 at index 2 (strictly beating 3's count of 1 so far); 3 only ties that
        // count at index 3, so 1 keeps the lead — matches the frozen TS `mode()`'s single-pass "strictly greater" scan.
        assert_eq!(mode(&[3, 1, 1, 3]), (1, 2));
        assert_eq!(mode(&[]), (0, 0));
    }
}
