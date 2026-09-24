//! Presentation canvas synthesis (`src/core/framing.ts`): layout/coordinate mapping, background-extension
//! statistics, and the two per-tile passes `buildFramedCanvas` drives (chrome/content copy, then source-tile
//! evidence fold). Tile-cache traversal, the O(perimeter) candidate pre-check and KV writes stay in TS.

use crate::geometry::{js_ceil, js_floor, Rect};
use crate::region::Region;

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

/// Most frequent value; ties keep the first value to reach the winning count (matches `Map` insertion order
/// under JS's single-pass "first strictly greater count wins" scan). Empty input yields 0.
fn mode(values: &[u32]) -> u32 {
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
    best
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
/// `max(1, floor(pane.dim / 128))` columns/rows across the pane.
pub fn backgrounds(
    rgba: &[u8],
    image_width: usize,
    image_height: usize,
    pane: Rect,
) -> (Vec<u32>, Vec<u32>) {
    let xs = (1usize).max((pane.width / 128.0).floor() as usize);
    let ys = (1usize).max((pane.height / 128.0).floor() as usize);
    let mut rows = vec![0u32; image_height];
    let mut columns = vec![0u32; image_width];
    let mut samples = Vec::new();
    for y in 0..image_height {
        samples.clear();
        let mut x = pane.x as i64;
        while (x as f64) < pane.x + pane.width {
            samples.push(px32(rgba, y * image_width + x as usize));
            x += xs as i64;
        }
        rows[y] = mode(&samples);
    }
    for x in 0..image_width {
        samples.clear();
        let mut y = pane.y as i64;
        while (y as f64) < pane.y + pane.height {
            samples.push(px32(rgba, y as usize * image_width + x));
            y += ys as i64;
        }
        columns[x] = mode(&samples);
    }
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
    bg_rows: &[u32],
    bg_columns: &[u32],
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
/// `undefined` and writes as 0.
#[inline]
fn bg_row(rows: &[u32], y: f64) -> u32 {
    if y < 0.0 {
        0
    } else {
        rows.get(y as usize).copied().unwrap_or(0)
    }
}
#[inline]
fn bg_column(columns: &[u32], x: f64) -> u32 {
    if x < 0.0 {
        0
    } else {
        columns.get(x as usize).copied().unwrap_or(0)
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

    #[test]
    fn mode_breaks_ties_by_first_arrival() {
        // [3, 1, 1, 3]: 1 reaches count 2 at index 2 (strictly beating 3's count of 1 so far); 3 only ties that
        // count at index 3, so 1 keeps the lead — matches the frozen TS `mode()`'s single-pass "strictly greater" scan.
        assert_eq!(mode(&[3, 1, 1, 3]), 1);
        assert_eq!(mode(&[]), 0);
    }
}
