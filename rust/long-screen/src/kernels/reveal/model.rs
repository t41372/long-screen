//! Overlay objects of one layer, learned from its [`LayerStats`].
//!
//! Classification runs on 3×3-cell pooled sums so a cell is judged by its neighbourhood (overlays are coherent
//! regions; single cells over rarely-textured page are noisy). A cell is opaque when it disagrees with the page
//! in most comparisons or when the page-to-observation slope is confidently ≈ 0; it is a veil when the slope is
//! confidently below 1. Connected opaque cells (closed, then grown by one cell to take their anti-aliased edge)
//! form objects that are tracked per frame; connected veil cells form objects that are not tracked (a veil has
//! no stable appearance of its own) and only ever lower the tier of what is seen through them.

use super::stats::LayerStats;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Opaque,
    Veil,
}

#[derive(Clone, Debug)]
pub struct Object {
    pub kind: Kind,
    /// Bounding box in cells, relative to the layer's cell grid.
    pub bx: usize,
    pub by: usize,
    pub bw: usize,
    pub bh: usize,
    /// Cells of the object inside its box.
    pub mask: Vec<bool>,
    /// Template: mean appearance of each cell when it disagreed with the page.
    pub tpl: Vec<[u8; 3]>,
    /// Cells whose appearance is stable (low spread when present); matching uses only these.
    pub stable: Vec<u32>,
    /// A thinned subset of `stable` for coarse searches.
    pub coarse: Vec<u32>,
    /// Enough stable edges for a shifted match to be meaningful (a flat template would match any flat area).
    pub textured: bool,
    /// Offset (cells) where the object was last found.
    pub last: (i32, i32),
    /// A uniformly coloured object (a scrollbar thumb, a flat bar): its colour. Its learned mask is smeared over
    /// everywhere it travelled, so it is found per frame by colour inside its zone instead of by template.
    pub flat: Option<[u8; 3]>,
}

impl Object {
    pub fn area(&self) -> usize {
        self.mask.iter().filter(|&&m| m).count()
    }

    /// The axis an elongated object may travel along (a scrollbar thumb's track), if any.
    pub fn track(&self) -> Track {
        if self.bh >= 3 * self.bw {
            Track::Vertical
        } else if self.bw >= 3 * self.bh {
            Track::Horizontal
        } else {
            Track::None
        }
    }

    /// Cells where this object may appear in a frame: its box, run along the long axis to the layer edge when
    /// it is elongated (a scrollbar thumb travels its whole track). `(x0, x1, y0, y1)`, half-open, in cells.
    pub fn zone(&self, cw: usize, ch: usize) -> (usize, usize, usize, usize) {
        let (bx0, bx1) = (self.bx.saturating_sub(1), (self.bx + self.bw + 1).min(cw));
        let (by0, by1) = (self.by.saturating_sub(1), (self.by + self.bh + 1).min(ch));
        match self.track() {
            Track::Vertical => (bx0, bx1, 0, ch),
            Track::Horizontal => (0, cw, by0, by1),
            Track::None => (bx0, bx1, by0, by1),
        }
    }
}

/// See [`Object::track`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Track {
    None,
    Vertical,
    Horizontal,
}

impl LayerModel {
    /// Cells inside any opaque object's zone: the only place an overlay can fade or move, so the only place a
    /// still-changing pixel at the end of a static run is suspect (elsewhere it is page content still loading).
    pub fn overlay_zone(&self) -> Vec<bool> {
        let mut z = vec![false; self.cw * self.ch];
        for o in self.objects.iter().filter(|o| o.kind == Kind::Opaque) {
            let (x0, x1, y0, y1) = o.zone(self.cw, self.ch);
            for y in y0..y1 {
                for x in x0..x1 {
                    z[y * self.cw + x] = true;
                }
            }
        }
        z
    }
}

#[derive(Clone, Debug)]
pub struct LayerModel {
    pub x: i64,
    pub y: i64,
    pub cw: usize,
    pub ch: usize,
    pub objects: Vec<Object>,
}

/// Minimum comparisons for a cell to be classified at all.
const ENOUGH: u16 = 8;
const POOL: usize = 1; // radius in cells: 3×3

fn pooled(v: &[u32], cw: usize, ch: usize) -> Vec<u64> {
    // Separable box sum with radius POOL, zero outside.
    let mut rows = vec![0u64; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let (a, b) = (x.saturating_sub(POOL), (x + POOL).min(cw - 1));
            rows[y * cw + x] = (a..=b).map(|i| v[y * cw + i] as u64).sum();
        }
    }
    let mut out = vec![0u64; cw * ch];
    for y in 0..ch {
        let (a, b) = (y.saturating_sub(POOL), (y + POOL).min(ch - 1));
        for x in 0..cw {
            out[y * cw + x] = (a..=b).map(|j| rows[j * cw + x]).sum();
        }
    }
    out
}

fn dilate(m: &[bool], cw: usize, ch: usize) -> Vec<bool> {
    let mut out = vec![false; m.len()];
    for y in 0..ch {
        for x in 0..cw {
            if !m[y * cw + x] {
                continue;
            }
            for yy in y.saturating_sub(1)..=(y + 1).min(ch - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(cw - 1) {
                    out[yy * cw + xx] = true;
                }
            }
        }
    }
    out
}

fn erode(m: &[bool], cw: usize, ch: usize) -> Vec<bool> {
    let inv: Vec<bool> = m.iter().map(|&b| !b).collect();
    dilate(&inv, cw, ch).iter().map(|&b| !b).collect()
}

/// 8-connected components; returns (label per cell, 0 = none) and component count.
fn components(m: &[bool], cw: usize, ch: usize) -> (Vec<u32>, u32) {
    let mut label = vec![0u32; m.len()];
    let mut next = 0;
    let mut stack = Vec::new();
    for start in 0..m.len() {
        if !m[start] || label[start] != 0 {
            continue;
        }
        next += 1;
        label[start] = next;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % cw, i / cw);
            for yy in y.saturating_sub(1)..=(y + 1).min(ch - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(cw - 1) {
                    let j = yy * cw + xx;
                    if m[j] && label[j] == 0 {
                        label[j] = next;
                        stack.push(j);
                    }
                }
            }
        }
    }
    (label, next)
}

/// Builds the layer's overlay objects. `tau` is the per-channel disagreement threshold.
pub fn build(stats: &LayerStats, tau: i32) -> LayerModel {
    let (cw, ch) = (stats.cw, stats.ch);
    let len = cw * ch;
    let n = pooled(&stats.field(|a| a.n as u32), cw, ch);
    let bad = pooled(&stats.field(|a| a.bad as u32), cw, ch);
    let sr = pooled(&stats.field(|a| a.sr), cw, ch);
    let so = pooled(&stats.field(|a| a.so), cw, ch);
    let srr = pooled(&stats.field(|a| a.srr), cw, ch);
    let sro = pooled(&stats.field(|a| a.sro), cw, ch);
    let soo = pooled(&stats.field(|a| a.soo), cw, ch);
    let mut opaque = vec![false; len];
    let mut veil = vec![false; len];
    for i in 0..len {
        if stats.cells[i].n < ENOUGH {
            continue;
        }
        let nn = n[i].max(1) as f64;
        let frac = bad[i] as f64 / nn;
        let (mr, mo) = (sr[i] as f64 / nn, so[i] as f64 / nn);
        let vr = srr[i] as f64 / nn - mr * mr;
        let cov = sro[i] as f64 / nn - mr * mo;
        let vo = soo[i] as f64 / nn - mo * mo;
        // Upper confidence bound of the page→observation slope; no page texture means no slope evidence.
        let hi = if vr > 1.0 {
            let slope = cov / vr;
            let resid = (vo - cov * cov / vr).max(0.0);
            let se = ((resid + 4.0) / (nn * vr)).sqrt();
            slope + 2.0 * se
        } else {
            f64::INFINITY
        };
        if frac > 0.3 || hi < 0.15 {
            opaque[i] = true;
        } else if hi < 0.85 {
            veil[i] = true;
        }
    }
    let enough: Vec<bool> = stats.cells.iter().map(|a| a.n >= ENOUGH).collect();
    let core: Vec<bool> = erode(&dilate(&opaque, cw, ch), cw, ch)
        .iter()
        .zip(&enough)
        .map(|(&a, &b)| a && b)
        .collect();
    let grown: Vec<bool> = dilate(&core, cw, ch)
        .iter()
        .zip(&enough)
        .map(|(&a, &b)| a && b)
        .collect();
    let veil: Vec<bool> = erode(&dilate(&veil, cw, ch), cw, ch)
        .iter()
        .zip(&enough)
        .zip(&grown)
        .map(|((&a, &b), &g)| a && b && !g)
        .collect();
    let mut objects = Vec::new();
    for (kind, mask) in [(Kind::Opaque, &grown), (Kind::Veil, &veil)] {
        let (label, count) = components(mask, cw, ch);
        let mut boxes = vec![(usize::MAX, usize::MAX, 0usize, 0usize, 0usize); count as usize];
        for (i, &l) in label.iter().enumerate() {
            if l == 0 {
                continue;
            }
            let b = &mut boxes[l as usize - 1];
            let (x, y) = (i % cw, i / cw);
            b.0 = b.0.min(x);
            b.1 = b.1.min(y);
            b.2 = b.2.max(x);
            b.3 = b.3.max(y);
            b.4 += 1;
        }
        for (k, &(x0, y0, x1, y1, area)) in boxes.iter().enumerate() {
            // Three cells (12 native pixels) is below any overlay worth tracking and mostly codec speckle.
            if area < 3 {
                continue;
            }
            let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
            let mut m = vec![false; bw * bh];
            let mut tpl = vec![[0u8; 3]; bw * bh];
            let mut stable = Vec::new();
            for yy in 0..bh {
                for xx in 0..bw {
                    let i = (y0 + yy) * cw + x0 + xx;
                    if label[i] != k as u32 + 1 {
                        continue;
                    }
                    let j = yy * bw + xx;
                    m[j] = true;
                    let a = stats.cells[i];
                    let nb = a.bad as u32;
                    if nb == 0 {
                        continue;
                    }
                    tpl[j] = [
                        ((a.br + nb / 2) / nb) as u8,
                        ((a.bg + nb / 2) / nb) as u8,
                        ((a.bb + nb / 2) / nb) as u8,
                    ];
                    let ml = a.bl as f64 / nb as f64;
                    let spread = (a.bll as f64 / nb as f64 - ml * ml).max(0.0).sqrt();
                    // Present often enough to know its look, and the look is consistent.
                    if kind == Kind::Opaque && core[i] && nb >= 4 && spread <= tau as f64 / 2.0 {
                        stable.push(j as u32);
                    }
                }
            }
            let edges = stable
                .iter()
                .filter(|&&j| {
                    let j = j as usize;
                    let (xx, yy) = (j % bw, j / bw);
                    let l = |a: usize| {
                        let t = tpl[a];
                        super::luma(t[0], t[1], t[2]) as i32
                    };
                    let c = l(j);
                    (xx > 0 && (c - l(j - 1)).abs() > 16) || (yy > 0 && (c - l(j - bw)).abs() > 16)
                })
                .count();
            let step = (stable.len() / 2000).max(1);
            let coarse = stable.iter().step_by(step).copied().collect();
            // Dominant uniform colour: most stable cells within tolerance of their median colour.
            let flat = (stable.len() >= 4)
                .then(|| {
                    let mut ls: Vec<(u32, [u8; 3])> = stable
                        .iter()
                        .map(|&j| {
                            let t = tpl[j as usize];
                            (super::luma(t[0], t[1], t[2]), t)
                        })
                        .collect();
                    ls.sort_by_key(|p| p.0);
                    let med = ls[ls.len() / 2].1;
                    let near = ls
                        .iter()
                        .filter(|(_, t)| (0..3).all(|k| (t[k] as i32 - med[k] as i32).abs() <= tau))
                        .count();
                    (near * 10 >= ls.len() * 6).then_some(med)
                })
                .flatten();
            objects.push(Object {
                kind,
                bx: x0,
                by: y0,
                bw,
                bh,
                mask: m,
                tpl,
                textured: edges >= 10,
                stable,
                coarse,
                last: (0, 0),
                flat,
            });
        }
    }
    LayerModel {
        x: stats.x,
        y: stats.y,
        cw,
        ch,
        objects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::reveal::locate::tiers;
    use crate::kernels::reveal::stats::CellRef;
    use crate::kernels::reveal::{Footprint, Frame, TIER_CLEAN};

    struct Page(u8);
    impl CellRef for Page {
        fn cell(&self, _: i64, _: i64) -> Option<[u8; 3]> {
            Some([self.0; 3])
        }
        fn cells(&self) -> (i64, i64, i64, i64) {
            (0, 0, 48, 32)
        }
    }

    fn button(page: u8, ink: u8) -> Vec<u8> {
        let mut rgba = vec![255; 96 * 64 * 4];
        for y in 0..64 {
            for x in 0..96 {
                let v = if (16..80).contains(&x) && (16..48).contains(&y) {
                    if (32..64).contains(&x) && (24..40).contains(&y) {
                        ink
                    } else {
                        240
                    }
                } else {
                    page
                };
                let i = (y * 96 + x) * 4;
                rgba[i..i + 3].fill(v);
            }
        }
        rgba
    }

    // A button has a mostly uniform background but also its own visible label. If that label changes, the
    // old template no longer locates it; matching only its background must not certify the new label as page.
    #[test]
    fn a_changed_label_on_an_opaque_button_is_not_clean_page_content() {
        let mut stats = LayerStats::new(0, 0, 96, 64);
        let mask = vec![1; 96 * 64];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width: 96,
            height: 64,
            mask: &mask,
        };
        for background in (0..=240).step_by(16) {
            let rgba = button(background, 0);
            stats.accumulate_cells(
                &Frame {
                    rgba: &rgba,
                    width: 96,
                    height: 64,
                },
                &footprint,
                &Page(background),
                (0, 0),
                24,
            );
        }
        let mut model = build(&stats, 24);
        let rgba = button(128, 80);
        let tier = tiers(
            &Frame {
                rgba: &rgba,
                width: 96,
                height: 64,
            },
            &mut model,
            24,
        );
        for y in 10..22 {
            for x in 10..38 {
                assert!(
                    tier[y * 48 + x] < TIER_CLEAN,
                    "button cell ({x}, {y}) treated as page"
                );
            }
        }
        assert_eq!(tier[0], TIER_CLEAN);
    }
}
