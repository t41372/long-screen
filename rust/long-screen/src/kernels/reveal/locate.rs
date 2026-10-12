//! Per-frame overlay localisation and the resulting cleanliness tier of every screen cell.
//!
//! An opaque object is looked for where it was last seen, then nearby, then along each axis over the whole
//! layer: composers bounce with overscroll, sticky bars slide, scrollbar thumbs travel the whole track. A
//! placement counts when the stable template cells agree in value AND the luma pattern correlates (normalised),
//! so a flat window never matches a template with structure. An object not found anywhere leaves its home cells
//! at the veil tier rather than clean: it may be fading, and a fading overlay matches neither itself nor the page.

use super::model::{Kind, LayerModel, Object, Track};
use super::{luma, Frame, CELL, TIER_CLEAN, TIER_FRINGE, TIER_OPAQUE, TIER_VEIL};

/// Where a layer's cell tiers sit on screen.
pub struct TierMap<'a> {
    pub x: i64,
    pub y: i64,
    pub cw: usize,
    pub ch: usize,
    pub tier: &'a [u8],
}

impl TierMap<'_> {
    /// Tier of screen pixel (sx, sy); clean outside the layer rectangle (the footprint excludes those anyway).
    #[inline]
    pub fn at(&self, sx: i64, sy: i64) -> u8 {
        let (cx, cy) = (
            (sx - self.x).div_euclid(CELL as i64),
            (sy - self.y).div_euclid(CELL as i64),
        );
        if cx < 0 || cy < 0 || cx >= self.cw as i64 || cy >= self.ch as i64 {
            return TIER_CLEAN;
        }
        self.tier[cy as usize * self.cw + cx as usize]
    }
}

/// Mean RGB of every cell of the layer rectangle in one frame, and its luma.
pub struct Cells {
    pub cw: usize,
    pub ch: usize,
    pub rgb: Vec<[u8; 3]>,
    pub luma: Vec<u8>,
}

impl Cells {
    pub fn bin(frame: &Frame<'_>, model: &LayerModel) -> Cells {
        let (cw, ch) = (model.cw, model.ch);
        let mut rgb = vec![[0u8; 3]; cw * ch];
        let mut lum = vec![0u8; cw * ch];
        let (w, h) = (frame.width as i64, frame.height as i64);
        let rows = crate::kernels::pool::SyncPtr(rgb.as_mut_ptr());
        let lumas = crate::kernels::pool::SyncPtr(lum.as_mut_ptr());
        let chunks = crate::kernels::pool::chunks_for(cw * ch, 16384);
        crate::kernels::pool::par_for(chunks, |k| {
            let (a, b) = (
                crate::kernels::pool::split(ch, chunks, k),
                crate::kernels::pool::split(ch, chunks, k + 1),
            );
            for cy in a..b {
                // SAFETY: chunk `k` owns cell rows a..b.
                let out = unsafe { std::slice::from_raw_parts_mut(rows.get().add(cy * cw), cw) };
                let out_luma =
                    unsafe { std::slice::from_raw_parts_mut(lumas.get().add(cy * cw), cw) };
                let sy = model.y + (cy * CELL) as i64;
                let full_rows = sy >= 0 && sy + CELL as i64 <= h;
                for (cx, cell) in out.iter_mut().enumerate() {
                    let sx = model.x + (cx * CELL) as i64;
                    if full_rows && sx >= 0 && sx + CELL as i64 <= w {
                        let i0 = (sy as usize * w as usize + sx as usize) * 4;
                        let i1 = i0 + w as usize * 4;
                        let p = &frame.rgba;
                        *cell = [
                            ((p[i0] as u32
                                + p[i0 + 4] as u32
                                + p[i1] as u32
                                + p[i1 + 4] as u32
                                + 2)
                                / 4) as u8,
                            ((p[i0 + 1] as u32
                                + p[i0 + 5] as u32
                                + p[i1 + 1] as u32
                                + p[i1 + 5] as u32
                                + 2)
                                / 4) as u8,
                            ((p[i0 + 2] as u32
                                + p[i0 + 6] as u32
                                + p[i1 + 2] as u32
                                + p[i1 + 6] as u32
                                + 2)
                                / 4) as u8,
                        ];
                        continue;
                    }
                    let mut s = [0u32; 3];
                    let mut n = 0u32;
                    for dy in 0..CELL as i64 {
                        for dx in 0..CELL as i64 {
                            let (x, y) = (sx + dx, sy + dy);
                            if x < 0 || y < 0 || x >= w || y >= h {
                                continue;
                            }
                            let i = (y as usize * w as usize + x as usize) * 4;
                            s[0] += frame.rgba[i] as u32;
                            s[1] += frame.rgba[i + 1] as u32;
                            s[2] += frame.rgba[i + 2] as u32;
                            n += 1;
                        }
                    }
                    if n > 0 {
                        *cell = [
                            ((s[0] + n / 2) / n) as u8,
                            ((s[1] + n / 2) / n) as u8,
                            ((s[2] + n / 2) / n) as u8,
                        ];
                    }
                }
                for (l, c) in out_luma.iter_mut().zip(out.iter()) {
                    *l = luma(c[0], c[1], c[2]) as u8;
                }
            }
        });
        Cells {
            cw,
            ch,
            rgb,
            luma: lum,
        }
    }
}

/// The template side of `score` for one cell subset of an object: per-cell luma and its sums, which do not depend on
/// where the object is tried.
struct Template<'a> {
    idx: &'a [u32],
    luma: Vec<f64>,
    st: f64,
    stt: f64,
}

impl<'a> Template<'a> {
    fn new(o: &Object, idx: &'a [u32]) -> Self {
        let (mut st, mut stt) = (0f64, 0f64);
        let luma: Vec<f64> = idx
            .iter()
            .map(|&j| {
                let t = o.tpl[j as usize];
                let lt = luma(t[0], t[1], t[2]) as f64;
                st += lt;
                stt += lt * lt;
                lt
            })
            .collect();
        Template { idx, luma, st, stt }
    }
}

/// Agreement of `o` placed at offset (dy, dx) cells: min(value agreement, luma correlation) over the template's cells.
fn score(cells: &Cells, o: &Object, tpl: &Template<'_>, dy: i32, dx: i32, tau: i32) -> f64 {
    let (y0, x0) = (o.by as i64 + dy as i64, o.bx as i64 + dx as i64);
    if y0 < 0
        || x0 < 0
        || y0 + o.bh as i64 > cells.ch as i64
        || x0 + o.bw as i64 > cells.cw as i64
        || tpl.idx.is_empty()
    {
        return 0.0;
    }
    let (st, stt) = (tpl.st, tpl.stt);
    let (mut agree, mut sw, mut sww, mut stw) = (0usize, 0f64, 0f64, 0f64);
    for (&j, &lt) in tpl.idx.iter().zip(&tpl.luma) {
        let j = j as usize;
        let (xx, yy) = (j % o.bw, j / o.bw);
        let at = (y0 as usize + yy) * cells.cw + x0 as usize + xx;
        let (c, t) = (cells.rgb[at], o.tpl[j]);
        if (0..3).all(|k| (c[k] as i32 - t[k] as i32).abs() <= tau) {
            agree += 1;
        }
        let lw = cells.luma[at] as f64;
        sw += lw;
        sww += lw * lw;
        stw += lt * lw;
    }
    let n = tpl.idx.len() as f64;
    let value = agree as f64 / n;
    let vt = stt - st * st / n;
    let vw = sww - sw * sw / n;
    if vt < 1e-6 * n {
        // A flat template: value agreement is all there is (only ever used at its home offset, see `find`).
        return value;
    }
    if vw < n {
        return 0.0;
    }
    let ncc = (stw - st * sw / n) / (vt * vw).sqrt();
    value.min(ncc.max(0.0))
}

/// Best placement of `o` in this frame: (score, dy, dx).
fn find(cells: &Cells, o: &Object, tau: i32) -> (f64, i32, i32) {
    let (ly, lx) = o.last;
    let stable = Template::new(o, &o.stable);
    let mut best = (score(cells, o, &stable, ly, lx, tau), ly, lx);
    if !o.textured || best.0 >= 0.97 {
        return best;
    }
    let coarse = Template::new(o, &o.coarse);
    for d in -8..=8i32 {
        for (dy, dx) in [(ly + d, lx), (ly, lx + d)] {
            let s = score(cells, o, &coarse, dy, dx, tau);
            if s > best.0 + 0.005 {
                best = (s, dy, dx);
            }
        }
    }
    if best.0 < 0.97 {
        let mut cands = vec![best];
        let (ymin, ymax) = (-(o.by as i32), (cells.ch - o.by - o.bh) as i32);
        let (xmin, xmax) = (-(o.bx as i32), (cells.cw - o.bx - o.bw) as i32);
        // Every offset along both axes (a thumb travels its whole track): independent scores, so in parallel.
        let offsets: Vec<(i32, i32)> = (ymin..=ymax)
            .map(|dy| (dy, 0))
            .chain((xmin..=xmax).map(|dx| (0, dx)))
            .collect();
        let mut scores = vec![0f64; offsets.len()];
        let out = crate::kernels::pool::SyncPtr(scores.as_mut_ptr());
        let chunks =
            crate::kernels::pool::chunks_for(offsets.len() * coarse.idx.len().max(1), 16384);
        crate::kernels::pool::par_for(chunks, |k| {
            let (a, b) = (
                crate::kernels::pool::split(offsets.len(), chunks, k),
                crate::kernels::pool::split(offsets.len(), chunks, k + 1),
            );
            for (i, &(dy, dx)) in offsets.iter().enumerate().take(b).skip(a) {
                // SAFETY: chunk `k` owns offsets a..b.
                unsafe { *out.get().add(i) = score(cells, o, &coarse, dy, dx, tau) };
            }
        });
        cands.extend(
            scores
                .iter()
                .zip(&offsets)
                .map(|(&s, &(dy, dx))| (s, dy, dx)),
        );
        cands.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        best = (0.0, ly, lx);
        for &(_, dy0, dx0) in cands.iter().take(2) {
            for d in -1..=1 {
                let (dy, dx) = if dx0 == 0 {
                    (dy0 + d, dx0)
                } else {
                    (dy0, dx0 + d)
                };
                let s = score(cells, o, &stable, dy, dx, tau);
                if s > best.0 + 0.005 {
                    best = (s, dy, dx);
                }
            }
        }
    } else {
        best.0 = score(cells, o, &stable, best.1, best.2, tau);
    }
    best
}

/// Whether a vertical strip's key colour `c` is, in this frame, the colour of the page beside its track: more than
/// half of the cells just left and right of its zone show it. Keying it would then find the page, not the strip. A
/// real thumb differs from the page beside it however long it is.
fn page_coloured(cells: &Cells, o: &Object, c: [u8; 3], tau: i32) -> bool {
    if o.track() != Track::Vertical {
        return false;
    }
    let (x0, x1, y0, y1) = o.zone(cells.cw, cells.ch);
    let (mut total, mut same) = (0usize, 0usize);
    for cx in [x0.checked_sub(1), (x1 < cells.cw).then_some(x1)]
        .into_iter()
        .flatten()
    {
        for cy in y0..y1 {
            let v = cells.rgb[cy * cells.cw + cx];
            total += 1;
            same += (0..3).all(|k| (v[k] as i32 - c[k] as i32).abs() <= tau) as usize;
        }
    }
    same * 2 > total
}

/// Places every object of the layer in this frame and returns the tier of each cell.
pub fn tiers(frame: &Frame<'_>, model: &mut LayerModel, tau: i32) -> Vec<u8> {
    let (cw, ch) = (model.cw, model.ch);
    let mut tier = vec![TIER_CLEAN; cw * ch];
    if model.objects.is_empty() {
        return tier;
    }
    let cells = Cells::bin(frame, model);
    let mark = |tier: &mut [u8], o: &Object, dy: i32, dx: i32, t: u8| {
        for yy in 0..o.bh {
            let cy = o.by as i64 + yy as i64 + dy as i64;
            if cy < 0 || cy >= ch as i64 {
                continue;
            }
            for xx in 0..o.bw {
                let cx = o.bx as i64 + xx as i64 + dx as i64;
                if cx < 0 || cx >= cw as i64 || !o.mask[yy * o.bw + xx] {
                    continue;
                }
                let i = cy as usize * cw + cx as usize;
                tier[i] = tier[i].min(t);
            }
        }
    };
    let mut found = Vec::new();
    // Rectangles (x0, y0, x1, y1) holding every opaque cell, for the fringe below.
    let mut boxes: Vec<(usize, usize, usize, usize)> = Vec::new();
    for k in 0..model.objects.len() {
        let o = &model.objects[k];
        match o.kind {
            Kind::Veil => mark(&mut tier, o, 0, 0, TIER_VEIL),
            Kind::Opaque => {
                let (s, dy, dx) = if o.stable.is_empty() {
                    (0.0, 0, 0)
                } else {
                    find(&cells, o, tau)
                };
                let placed = s >= 0.8;
                if placed {
                    mark(&mut tier, o, dy, dx, TIER_OPAQUE);
                    found.push((k, (dy, dx)));
                    let clamp = |v: i64, n: usize| v.clamp(0, n as i64) as usize;
                    let (x0, y0) = (o.bx as i64 + dx as i64, o.by as i64 + dy as i64);
                    boxes.push((
                        clamp(x0, cw),
                        clamp(y0, ch),
                        clamp(x0 + o.bw as i64, cw),
                        clamp(y0 + o.bh as i64, ch),
                    ));
                }
                let mut keyed = 0;
                // A fixed strip beside the page can be learned as a flat object of the page's own colour (the page's
                // margin, seen where the rendered canvas still carried a burned-in scroll indicator). Keyed along
                // its column, it made every clean page cell there opaque, and the indicator, ranked fringe beside
                // them, won the per-pixel fallback from a minority of frames (test_7, test_8). Such a key finds the
                // page, not the strip. A page-coloured band across the layer is left keyed: there it is a toolbar
                // or composer background that really covers the page (a, e).
                if let Some(c) = o.flat.filter(|&c| !page_coloured(&cells, o, c, tau)) {
                    // A uniformly coloured object may have a template smeared over its whole travel (a scrollbar
                    // thumb), so a placement can miss part of it: every cell of its zone that shows its colour is
                    // the object in this frame. An elongated object's zone runs along its long axis to the layer
                    // edge (the track); a compact one keeps its own box.
                    let (x0, x1, y0, y1) = o.zone(cw, ch);
                    let (mut kx0, mut ky0, mut kx1, mut ky1) = (cw, ch, 0, 0);
                    for cy in y0..y1 {
                        for cx in x0..x1 {
                            let v = cells.rgb[cy * cw + cx];
                            if (0..3).all(|k| (v[k] as i32 - c[k] as i32).abs() <= tau) {
                                tier[cy * cw + cx] = TIER_OPAQUE;
                                keyed += 1;
                                (kx0, ky0) = (kx0.min(cx), ky0.min(cy));
                                (kx1, ky1) = (kx1.max(cx + 1), ky1.max(cy + 1));
                            }
                        }
                    }
                    if keyed > 0 {
                        boxes.push((kx0, ky0, kx1, ky1));
                    }
                }
                // Colour alone locates a featureless thumb, but only part of a textured object. If that
                // object's template is missing, its unmatched label or toolbar cells are not clean page.
                if !placed && (keyed == 0 || o.textured) {
                    mark(&mut tier, o, 0, 0, TIER_VEIL);
                }
            }
        }
    }
    for (k, at) in found {
        model.objects[k].last = at;
    }
    // Fringe: two cells (four native pixels) around opaque placements; anti-aliasing and soft shadows. A separable
    // Chebyshev dilation, rows first, then columns, run only around the rectangles that hold opaque cells: every
    // opaque cell lies in one, and a dilation of a union is the union of the dilations.
    let reach = 2;
    let mut near = Vec::new();
    for (x0, y0, x1, y1) in boxes {
        let (x0, y0) = (x0.saturating_sub(reach), y0.saturating_sub(reach));
        let (x1, y1) = ((x1 + reach).min(cw), (y1 + reach).min(ch));
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (bw, bh) = (x1 - x0, y1 - y0);
        near.clear();
        near.resize(bw * bh, false);
        for y in 0..bh {
            let row = &tier[(y0 + y) * cw + x0..(y0 + y) * cw + x1];
            let out = &mut near[y * bw..(y + 1) * bw];
            let mut last: Option<usize> = None;
            for x in 0..bw {
                if row[x] == TIER_OPAQUE {
                    last = Some(x);
                }
                out[x] = last.is_some_and(|l| x - l <= reach);
            }
            let mut next: Option<usize> = None;
            for x in (0..bw).rev() {
                if row[x] == TIER_OPAQUE {
                    next = Some(x);
                }
                out[x] |= next.is_some_and(|n| n - x <= reach);
            }
        }
        for x in 0..bw {
            let mut last: Option<usize> = None;
            for y in 0..bh {
                if near[y * bw + x] {
                    last = Some(y);
                }
                let below = (y + 1..(y + reach + 1).min(bh)).any(|yy| near[yy * bw + x]);
                if last.is_some_and(|l| y - l <= reach) || below {
                    let i = (y0 + y) * cw + x0 + x;
                    if tier[i] != TIER_OPAQUE {
                        tier[i] = tier[i].min(TIER_FRINGE);
                    }
                }
            }
        }
    }
    tier
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 80;
    const H: usize = 240;
    const PAGE: u8 = 255;
    const THUMB: u8 = 128;

    /// A flat, featureless object learned in cells (bx..bx+bw, by..by+bh).
    fn flat(colour: u8, bx: usize, by: usize, bw: usize, bh: usize) -> Object {
        Object {
            kind: Kind::Opaque,
            bx,
            by,
            bw,
            bh,
            mask: vec![true; bw * bh],
            tpl: vec![[colour; 3]; bw * bh],
            stable: (0..(bw * bh) as u32).collect(),
            coarse: (0..(bw * bh) as u32).collect(),
            textured: false,
            last: (0, 0),
            flat: Some([colour; 3]),
        }
    }

    fn layer(objects: Vec<Object>) -> LayerModel {
        LayerModel {
            x: 0,
            y: 0,
            cw: W / CELL,
            ch: H / CELL,
            objects,
        }
    }

    /// A flat object learned in the layer's right-hand column, cells (36..39, by..by+bh): tall and thin, so its zone
    /// runs the whole column.
    fn strip(colour: u8, by: usize, bh: usize) -> Object {
        flat(colour, 36, by, 3, bh)
    }

    /// A white page with a line of dark text every 12 rows, and grey paint over native rows `thumb` of the strip's
    /// column (x 72..78).
    fn page(thumb: std::ops::Range<usize>) -> Vec<u8> {
        let mut rgba = vec![255u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let v = if (72..78).contains(&x) && thumb.contains(&y) {
                    THUMB
                } else if y % 12 < 2 && (8..60).contains(&x) {
                    20
                } else {
                    PAGE
                };
                rgba[(y * W + x) * 4..(y * W + x) * 4 + 3].fill(v);
            }
        }
        rgba
    }

    fn tier_of(model: &mut LayerModel, rgba: &[u8]) -> Vec<u8> {
        tiers(
            &Frame {
                rgba,
                width: W,
                height: H,
            },
            model,
            24,
        )
    }

    // A fixed white strip beside the page is learned as an opaque flat object whose colour is the page's own. Keyed
    // along its whole column, it made every clean page cell there opaque, and the real scroll indicator travelling
    // the same column, ranked fringe beside them, won the per-pixel fallback from a minority of frames (test_7,
    // test_8). Cells along the track that look like the page beside it are page.
    #[test]
    fn a_page_coloured_strip_does_not_key_the_page_along_its_column() {
        let mut model = layer(vec![strip(PAGE, 80, 40)]);
        let tier = tier_of(&mut model, &page(0..0));
        let cw = W / CELL;
        for cy in 0..78 {
            for cx in 36..39 {
                assert_ne!(
                    tier[cy * cw + cx],
                    TIER_OPAQUE,
                    "page cell ({cx}, {cy}) keyed as the strip"
                );
            }
        }
    }

    // A page-coloured band across the layer keeps its key: there it is a toolbar or composer background that really
    // covers the page (in a, a dark band above the Dock; in e, a dark strip along the layer's bottom), and releasing
    // it let blocks from the wrong moment in.
    #[test]
    fn a_page_coloured_band_across_the_layer_keeps_its_key() {
        let mut model = layer(vec![flat(PAGE, 4, 100, 30, 6)]);
        let tier = tier_of(&mut model, &page(0..0));
        let cw = W / CELL;
        for cy in 99..107 {
            for cx in 36..40 {
                assert_eq!(tier[cy * cw + cx], TIER_OPAQUE, "band cell ({cx}, {cy})");
            }
        }
    }

    // A scrollbar thumb's learned mask is smeared over its travel; it is found along its whole track by colour,
    // wherever it is in this frame, beside a page-coloured strip or not.
    #[test]
    fn a_thumb_is_keyed_anywhere_along_its_track() {
        let mut model = layer(vec![strip(PAGE, 80, 40), strip(THUMB, 80, 40)]);
        let tier = tier_of(&mut model, &page(20..60));
        let cw = W / CELL;
        for cy in 10..30 {
            for cx in 36..39 {
                assert_eq!(tier[cy * cw + cx], TIER_OPAQUE, "thumb cell ({cx}, {cy})");
            }
        }
    }

    // On a short page the thumb fills most of its track; it is still the thumb, because the page beside the track
    // does not share its colour.
    #[test]
    fn a_thumb_longer_than_half_its_track_is_still_keyed() {
        let mut model = layer(vec![strip(PAGE, 80, 40), strip(THUMB, 0, 40)]);
        let tier = tier_of(&mut model, &page(40..220));
        let cw = W / CELL;
        for cy in 20..110 {
            for cx in 36..39 {
                assert_eq!(tier[cy * cw + cx], TIER_OPAQUE, "thumb cell ({cx}, {cy})");
            }
        }
    }
}
