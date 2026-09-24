//! Photometric motion evidence on analysis and native images: hypothesis generation from matches,
//! patch errors, audits and integer refinement. Every threshold is the historical one; tie-breaking
//! (first minimum, distance to the guess) is preserved so reconstructions stay reproducible.

use crate::geometry::{js_ceil, js_round, Rect, Rng};

/// Fixed motion-field cell size (analysis pixels per side). Shared with `abi::ls_layout` selector 9 so the TS
/// binding's layout assertion actually guards it instead of duplicating a bare literal.
pub const MOTION_CELL: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Motion {
    pub x: f64,
    pub y: f64,
    pub support: u32,
    pub unique: u32,
    pub confidence: f64,
    pub error: f64,
    pub ambiguous: bool,
}

#[derive(Clone, Copy)]
pub struct Gray<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [u8],
}

/// Matched point pairs `(a.x, a.y, b.x, b.y, unique)` in analysis pixels.
#[derive(Clone, Copy, Debug)]
pub struct MatchPoints {
    pub ax: f64,
    pub ay: f64,
    pub bx: f64,
    pub by: f64,
    pub unique: bool,
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = values.len() >> 1;
    if values.len() & 1 == 1 {
        values[m]
    } else {
        (values[m - 1] + values[m]) / 2.0
    }
}

#[inline]
fn hypot(x: f64, y: f64) -> f64 {
    x.hypot(y)
}

/// Candidate translations (current → previous) from binned match displacements, strongest first.
pub fn translation_hypotheses(matches: &[MatchPoints], max: usize) -> Vec<Motion> {
    // Bins keyed by round(d/3); insertion order is preserved, then sorted by size (stable), like the JS Map.
    let mut bins: Vec<((i32, i32), Vec<usize>)> = Vec::new();
    for (i, m) in matches.iter().enumerate() {
        let key = (js_round((m.ax - m.bx) / 3.0), js_round((m.ay - m.by) / 3.0));
        match bins.iter_mut().find(|(k, _)| *k == key) {
            Some((_, b)) => b.push(i),
            None => bins.push((key, vec![i])),
        }
    }
    bins.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    bins.truncate(32);
    let mut out: Vec<Motion> = Vec::new();
    for (_, seed) in &bins {
        let mut xs: Vec<f64> = seed
            .iter()
            .map(|&i| matches[i].ax - matches[i].bx)
            .collect();
        let mut ys: Vec<f64> = seed
            .iter()
            .map(|&i| matches[i].ay - matches[i].by)
            .collect();
        let (x, y) = (median(&mut xs), median(&mut ys));
        let support: Vec<&MatchPoints> = matches
            .iter()
            .filter(|m| hypot(m.ax - m.bx - x, m.ay - m.by - y) <= 2.5)
            .collect();
        if support.len() < 3 {
            continue;
        }
        let mut sx: Vec<f64> = support.iter().map(|m| m.ax - m.bx).collect();
        let mut sy: Vec<f64> = support.iter().map(|m| m.ay - m.by).collect();
        let (x, y) = (median(&mut sx), median(&mut sy));
        if out.iter().any(|p| hypot(p.x - x, p.y - y) < 3.0) {
            continue;
        }
        let unique = support.iter().filter(|m| m.unique).count();
        let mut cells: Vec<(i32, i32)> = support
            .iter()
            .map(|m| ((m.bx as i32) >> 5, (m.by as i32) >> 5))
            .collect();
        cells.sort_unstable();
        cells.dedup();
        let spread = cells.len() as f64;
        let n = support.len() as f64;
        let confidence = ((1.0 - (-n / 9.0).exp())
            * (0.48 + 0.52 * unique as f64 / n)
            * (spread / 4.0).min(1.0))
        .clamp(0.0, 0.99);
        out.push(Motion {
            x,
            y,
            support: support.len() as u32,
            unique: unique as u32,
            confidence,
            error: 0.0,
            ambiguous: (unique as f64) < (6.0f64).min(n * 0.2),
        });
    }
    out.sort_by(|a, b| (b.support + b.unique).cmp(&(a.support + a.unique)));
    out.truncate(max);
    out
}

pub struct PatchError {
    pub error: f64,
    pub texture: f64,
    pub n: u32,
}

/// Clipped robust error of `b` against `a` shifted by (dx, dy), sampled every `step` pixels inside `r`.
pub fn patch_error(a: Gray<'_>, b: Gray<'_>, dx: f64, dy: f64, r: Rect, step: usize) -> PatchError {
    let (w, h, aw, ah) = (
        b.width as f64,
        b.height as f64,
        a.width as f64,
        a.height as f64,
    );
    let x0 = 1f64.max(r.x.ceil()).max((-dx + 1.0).ceil());
    let x1 = (w - 1.0).min(r.x + r.width).min(aw - dx - 1.0);
    let y0 = 1f64.max(r.y.ceil()).max((-dy + 1.0).ceil());
    let y1 = (h - 1.0).min(r.y + r.height).min(ah - dy - 1.0);
    let (dx, dy) = (js_round(dx), js_round(dy));
    let (mut total, mut texture, mut n) = (0f64, 0f64, 0u32);
    let (bw, aw) = (b.width as i64, a.width as i64);
    let mut y = y0;
    while y < y1 {
        let mut x = x0;
        while x < x1 {
            let i = (y as i64 * bw + x as i64) as usize;
            let j = ((y as i64 + dy as i64) * aw + x as i64 + dx as i64) as usize;
            let bd = b.data;
            let gradient = (bd[i + 1] as i32 - bd[i - 1] as i32).abs()
                + (bd[i + b.width] as i32 - bd[i - b.width] as i32).abs();
            let weight = if gradient > 12 { 2.0 } else { 1.0 };
            total += (70.0f64).min((a.data[j] as i32 - bd[i] as i32).abs() as f64) * weight;
            texture += gradient as f64;
            n += if gradient > 12 { 2 } else { 1 };
            x += step as f64;
        }
        y += step as f64;
    }
    PatchError {
        error: if n > 8 {
            total / n as f64
        } else {
            f64::INFINITY
        },
        texture: if n > 0 { texture / n as f64 } else { 0.0 },
        n,
    }
}

/// Retained-75% mean of 48px block errors: ordinary page content must agree, not a single logo.
pub fn verify_translation(a: Gray<'_>, b: Gray<'_>, dx: f64, dy: f64, roi: Option<Rect>) -> f64 {
    let r = roi.unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width: b.width as f64,
        height: b.height as f64,
    });
    let mut errors: Vec<f64> = Vec::new();
    let mut y = r.y;
    while y < r.y + r.height {
        let mut x = r.x;
        while x < r.x + r.width {
            let block = Rect {
                x,
                y,
                width: (48.0f64).min(r.x + r.width - x),
                height: (48.0f64).min(r.y + r.height - y),
            };
            let p = patch_error(a, b, dx, dy, block, 4);
            if p.n > 12 && p.texture > 3.0 {
                errors.push(p.error);
            }
            x += 48.0;
        }
        y += 48.0;
    }
    if errors.len() < 2 {
        return f64::INFINITY;
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep = 2usize.max(js_ceil(errors.len() as f64 * 0.75) as usize);
    errors.iter().take(keep).sum::<f64>() / keep as f64
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Audit {
    pub error: f64,
    pub mismatch: f64,
    pub overlap: f64,
    pub samples: u32,
    pub blocks: u32,
    pub agreeing: u32,
    pub agreement: f64,
    pub agreeing_error: f64,
}

/// Held-out photometric evidence on textured pixels with both observations clamped to the pane.
pub fn audit_translation(
    a: Gray<'_>,
    b: Gray<'_>,
    dx: f64,
    dy: f64,
    roi: Option<Rect>,
    tolerant: bool,
) -> Audit {
    let r = roi.unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width: b.width as f64,
        height: b.height as f64,
    });
    let (dx, dy) = (js_round(dx) as f64, js_round(dy) as f64);
    // Both gradients need a one-pixel margin in their own image: x+dx ≥ 1 and y+dy ≥ 1 in `a`, x,y ≥ 2 in `b`.
    // (The historical TS sampled x+dx = 0 / y+dy = 0 and read past the buffer, turning tolerant audits into NaN.)
    let x0 = 2f64.max(r.x.ceil()).max((r.x - dx).ceil()).max(1.0 - dx);
    let y0 = 2f64.max(r.y.ceil()).max((r.y - dy).ceil()).max(1.0 - dy);
    let x1 = (b.width as f64 - 2.0)
        .min(a.width as f64 - dx - 2.0)
        .min(r.x + r.width)
        .min(r.x + r.width - dx);
    let y1 = (b.height as f64 - 2.0)
        .min(a.height as f64 - dy - 2.0)
        .min(r.y + r.height)
        .min(r.y + r.height - dy);
    let overlap = (x1 - x0).max(0.0) * (y1 - y0).max(0.0) / (r.width * r.height).max(1.0);
    const B: f64 = 32.0;
    let bw = 1usize.max(js_ceil((x1 - x0) / B).max(0) as usize);
    let bh = 1usize.max(js_ceil((y1 - y0) / B).max(0) as usize);
    let mut block_error = vec![0f64; bw * bh];
    let mut block_bad = vec![0f64; bw * bh];
    let mut block_n = vec![0f64; bw * bh];
    let (mut error, mut bad, mut n) = (0f64, 0u32, 0u32);
    let (bwid, awid) = (b.width as i64, a.width as i64);
    let (dxi, dyi) = (dx as i64, dy as i64);
    let mut y = y0;
    while y < y1 {
        let mut x = x0;
        while x < x1 {
            let i = (y as i64 * bwid + x as i64) as usize;
            let j = ((y as i64 + dyi) * awid + x as i64 + dxi) as usize;
            let (ad, bd) = (a.data, b.data);
            let gb = (bd[i + 1] as i32 - bd[i - 1] as i32).abs()
                + (bd[i + b.width] as i32 - bd[i - b.width] as i32).abs();
            let ga = (ad[j + 1] as i32 - ad[j - 1] as i32).abs()
                + (ad[j + a.width] as i32 - ad[j - a.width] as i32).abs();
            if ga.max(gb) < 20 {
                x += 2.0;
                continue;
            }
            let mut difference = (ad[j] as i32 - bd[i] as i32).abs();
            if tolerant {
                difference = difference
                    .min((ad[j + 1] as i32 - bd[i] as i32).abs())
                    .min((ad[j - 1] as i32 - bd[i] as i32).abs())
                    .min((ad[j + a.width] as i32 - bd[i] as i32).abs())
                    .min((ad[j - a.width] as i32 - bd[i] as i32).abs());
            }
            let clipped = difference.min(70) as f64;
            let q = (((y - y0) / B).floor() as usize) * bw + ((x - x0) / B).floor() as usize;
            error += clipped;
            block_error[q] += clipped;
            block_n[q] += 1.0;
            if difference > 18 {
                bad += 1;
                block_bad[q] += 1.0;
            }
            n += 1;
            x += 2.0;
        }
        y += 2.0;
    }
    let (mut blocks, mut agreeing, mut agreeing_error) = (0u32, 0u32, 0f64);
    for q in 0..block_n.len() {
        if block_n[q] < 12.0 {
            continue;
        }
        blocks += 1;
        if block_error[q] / block_n[q] < 10.0 && block_bad[q] / block_n[q] < 0.2 {
            agreeing += 1;
            agreeing_error += block_error[q] / block_n[q];
        }
    }
    Audit {
        error: if n >= 24 {
            error / n as f64
        } else {
            f64::INFINITY
        },
        mismatch: if n > 0 { bad as f64 / n as f64 } else { 1.0 },
        overlap,
        samples: n,
        blocks,
        agreeing,
        agreement: if blocks > 0 {
            agreeing as f64 / blocks as f64
        } else {
            0.0
        },
        agreeing_error: if agreeing > 0 {
            agreeing_error / agreeing as f64
        } else {
            f64::INFINITY
        },
    }
}

/// Integer refinement of `p` within `radius` by patch error; ties resolve toward the original guess.
pub fn refine_translation(
    a: Gray<'_>,
    b: Gray<'_>,
    p: Point,
    roi: Option<Rect>,
    radius: i32,
) -> (i32, i32) {
    let r = roi.unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width: b.width as f64,
        height: b.height as f64,
    });
    let (px, py) = (js_round(p.x), js_round(p.y));
    let (mut best, mut error) = ((px, py), f64::INFINITY);
    for dy in py - radius..=py + radius {
        for dx in px - radius..=px + radius {
            let e = patch_error(a, b, dx as f64, dy as f64, r, 7).error;
            let closer = hypot(dx as f64 - p.x, dy as f64 - p.y)
                < hypot(best.0 as f64 - p.x, best.1 as f64 - p.y);
            if e < error - 1e-4 || ((e - error).abs() < 1e-4 && closer) {
                error = e;
                best = (dx, dy);
            }
        }
    }
    best
}

/// RANSAC similarity probe over unique matches; a change detector, never a licence to rescale pixels.
pub fn detect_scale(matches: &[MatchPoints]) -> f64 {
    let m: Vec<&MatchPoints> = matches.iter().filter(|m| m.unique).collect();
    if m.len() < 8 {
        return 1.0;
    }
    let mut rng = Rng::new(7641);
    let (mut best, mut best_scale) = (0usize, 1.0);
    for _ in 0..96 {
        let p = m[(rng.next_f64() * m.len() as f64).floor() as usize];
        let q = m[(rng.next_f64() * m.len() as f64).floor() as usize];
        let (bx, by, ax, ay) = (q.bx - p.bx, q.by - p.by, q.ax - p.ax, q.ay - p.ay);
        let den = bx * bx + by * by;
        if den < 1000.0 {
            continue;
        }
        let u = (ax * bx + ay * by) / den;
        let v = (ay * bx - ax * by) / den;
        let s = hypot(u, v);
        if !(0.55..=1.8).contains(&s) {
            continue;
        }
        let tx = p.ax - u * p.bx + v * p.by;
        let ty = p.ay - v * p.bx - u * p.by;
        let n = m
            .iter()
            .filter(|r| {
                hypot(
                    u * r.bx - v * r.by + tx - r.ax,
                    v * r.bx + u * r.by + ty - r.ay,
                ) < 2.5
            })
            .count();
        if n > best {
            best = n;
            best_scale = s;
        }
    }
    if best as f64 >= (8.0f64).max(m.len() as f64 * 0.5) {
        best_scale
    } else {
        1.0
    }
}

pub struct MotionField {
    pub motions: Vec<Motion>,
    pub labels: Vec<u8>,
    pub confidence: Vec<u8>,
    pub dynamic: Vec<u8>,
    pub cols: usize,
    pub rows: usize,
    pub cell: usize,
    pub difference: f64,
    pub feature_count: u32,
    pub unknown: bool,
    pub zoom: f64,
}

/// Per-cell motion labelling of `b` against `a` from pre-computed matches (current `b` → previous `a`).
pub fn estimate_motion(
    a: Gray<'_>,
    b: Gray<'_>,
    matches: &[MatchPoints],
    feature_count: u32,
) -> MotionField {
    let cols = b.width.div_ceil(MOTION_CELL);
    let rows = b.height.div_ceil(MOTION_CELL);
    let n = cols * rows;
    let difference = crate::raster::mean_difference(a.data, b.data);
    if difference < 0.12 {
        return MotionField {
            motions: vec![Motion {
                x: 0.0,
                y: 0.0,
                support: 0,
                unique: 0,
                confidence: 0.98,
                error: difference,
                ambiguous: false,
            }],
            labels: vec![0; n],
            confidence: vec![245; n],
            dynamic: vec![0; n],
            cols,
            rows,
            cell: MOTION_CELL,
            difference,
            feature_count: 0,
            unknown: false,
            zoom: 1.0,
        };
    }
    let mut motions = translation_hypotheses(matches, 6);
    if !motions.iter().any(|m| hypot(m.x, m.y) < 1.0) {
        motions.push(Motion {
            x: 0.0,
            y: 0.0,
            support: 0,
            unique: 0,
            confidence: 0.5,
            error: 0.0,
            ambiguous: false,
        });
    }
    if motions.is_empty() {
        motions.push(Motion {
            x: 0.0,
            y: 0.0,
            support: 0,
            unique: 0,
            confidence: 0.0,
            error: 255.0,
            ambiguous: true,
        });
    }
    for m in motions.iter_mut() {
        let inliers: Vec<&MatchPoints> = matches
            .iter()
            .filter(|p| hypot(p.ax - p.bx - m.x, p.ay - p.by - m.y) < 3.0)
            .take(45)
            .collect();
        let (mut best, mut bx, mut by) = (f64::INFINITY, m.x, m.y);
        let (mx, my) = (js_round(m.x), js_round(m.y));
        for y in my - 1..=my + 1 {
            for x in mx - 1..=mx + 1 {
                let (mut sum, mut k) = (0f64, 0u32);
                for p in &inliers {
                    let e = patch_error(
                        a,
                        b,
                        x as f64,
                        y as f64,
                        Rect {
                            x: p.bx - 7.0,
                            y: p.by - 7.0,
                            width: 15.0,
                            height: 15.0,
                        },
                        3,
                    )
                    .error;
                    if e.is_finite() {
                        sum += e;
                        k += 1;
                    }
                }
                if k > 0 && sum / (k as f64) < best {
                    best = sum / k as f64;
                    bx = x as f64;
                    by = y as f64;
                }
            }
        }
        m.x = bx;
        m.y = by;
        m.error = if best.is_finite() {
            best
        } else {
            verify_translation(a, b, m.x, m.y, None)
        };
        if m.support > 0 {
            m.confidence *= (-(m.error.min(80.0)) / 35.0).exp();
        }
    }
    motions.sort_by(|a, b| (b.support + b.unique).cmp(&(a.support + a.unique)));
    let dominant = motions
        .iter()
        .position(|m| hypot(m.x, m.y) > 1.0 && m.support >= 4)
        .unwrap_or(0);
    let mut labels = vec![0u8; n];
    let mut confidence = vec![0u8; n];
    let mut dynamic = vec![0u8; n];
    let mut informative = vec![0u8; n];
    for cy in 0..rows {
        for cx in 0..cols {
            let idx = cy * cols + cx;
            let r = Rect {
                x: (cx * MOTION_CELL) as f64,
                y: (cy * MOTION_CELL) as f64,
                width: MOTION_CELL.min(b.width - cx * MOTION_CELL) as f64,
                height: MOTION_CELL.min(b.height - cy * MOTION_CELL) as f64,
            };
            let (mut best, mut second, mut choice, mut texture, mut dominant_error) =
                (f64::INFINITY, f64::INFINITY, dominant, 0f64, f64::INFINITY);
            for (k, m) in motions.iter().enumerate() {
                let p = patch_error(a, b, m.x, m.y, r, 3);
                texture = texture.max(p.texture);
                if k == dominant {
                    dominant_error = p.error;
                }
                if p.error < best {
                    second = best;
                    best = p.error;
                    choice = k;
                } else if p.error < second {
                    second = p.error;
                }
            }
            if texture < 3.0
                || !best.is_finite()
                || second - best < 0.6
                || (!dominant_error.is_finite() && choice != dominant)
            {
                labels[idx] = dominant as u8;
                confidence[idx] = 65;
            } else {
                labels[idx] = choice as u8;
                confidence[idx] = js_round(
                    255.0 * (-best / 24.0).exp() * ((second - best) / 8.0).clamp(0.25, 1.0),
                ) as u8;
                informative[idx] = (confidence[idx] > 100) as u8;
                if best > 22.0 {
                    dynamic[idx] = 1;
                    labels[idx] = dominant as u8;
                    confidence[idx] = 45;
                }
            }
        }
    }
    for _ in 0..3 {
        let mut next = labels.clone();
        for y in 0..rows as i64 {
            for x in 0..cols as i64 {
                let i = (y * cols as i64 + x) as usize;
                if informative[i] != 0 {
                    continue;
                }
                let mut votes = vec![0f64; motions.len()];
                for dy in -2i64..=2 {
                    for dx in -2i64..=2 {
                        let (xx, yy) = (x + dx, y + dy);
                        if xx < 0 || yy < 0 || xx >= cols as i64 || yy >= rows as i64 {
                            continue;
                        }
                        let j = (yy * cols as i64 + xx) as usize;
                        votes[labels[j] as usize] +=
                            confidence[j] as f64 / (1 + dx * dx + dy * dy) as f64;
                    }
                }
                let mut k = dominant;
                for (j, v) in votes.iter().enumerate() {
                    if *v > votes[k] {
                        k = j;
                    }
                }
                next[i] = k as u8;
            }
        }
        labels = next;
    }
    let strongest =
        motions.iter().fold(
            &motions[0],
            |m, n| if n.confidence > m.confidence { n } else { m },
        );
    let unknown = strongest.support < 4 && difference > 5.0;
    MotionField {
        motions,
        labels,
        confidence,
        dynamic,
        cols,
        rows,
        cell: MOTION_CELL,
        difference,
        feature_count,
        unknown,
        zoom: detect_scale(matches),
    }
}

pub struct NativeRefinement {
    pub x: i32,
    pub y: i32,
    pub error: f64,
    pub samples: u32,
    pub runner_up: f64,
}

/// Picks the native-refinement sample points for `b` inside `region`: a `step`×`step` cell grid, keeping one
/// point per cell rather than sampling only the pixel at the cell's corner (its lattice node). A node-only
/// sampler finds an edge with probability proportional to local edge density, so a sparse page (few edges
/// anywhere) starves the sample (`< 12` points → `Infinity`, the true step read as "static") and a
/// screen-fixed line that happens to align with a lattice row or column dominates it (every node on that row
/// is an edge, nothing else is) — see docs/ARCHITECTURE.md §五/§十. Depends only on `b`, `region`, `mask` and
/// `guide`, not on any hypothesis, so a caller evaluating several candidate displacements can select once and
/// reuse the points for all of them.
///
/// Without a `guide`: a full-resolution scan keeps, per cell, the pixel with the strongest native luma
/// gradient (ties broken by row-major order) — the exact per-cell argmax.
///
/// With `guide = Some((g, f))` — `g` is `b`'s own analysis-scale gray at integer downscale factor `f`
/// (`raster::downscale_gray`; analysis pixel `(ax, ay)` covers the native block `[ax·f, ax·f+f) ×
/// [ay·f, ay·f+f)`, edge blocks partial): coarse-to-fine instead of full-resolution. Per cell, first pick the
/// analysis pixel (among those whose native block intersects the cell, skipping the analysis image's own
/// 1px border and any pixel whose block centre fails `mask`) with the strongest analysis-scale gradient, then
/// the native pixel with the strongest native gradient inside that one analysis pixel's block ∩ cell ∩ window
/// ∩ mask — luma computed only for that handful of pixels and their four neighbours, not a full luma plane.
/// `f = 1` makes `g` `b`'s own native luma one-for-one (`downscale_gray`'s `factor == 1` branch), every block
/// a single pixel, and this reduce exactly to the unguided per-cell argmax — this is a property relied on
/// elsewhere (the `f = 1` odometry parity cases), not merely incidental.
pub fn select_native_points(
    b: &[u8],
    width: usize,
    height: usize,
    region: Rect,
    mask: Option<(&[u8], u8)>,
    guide: Option<(Gray<'_>, usize)>,
) -> Vec<i64> {
    let (w, h) = (width as i64, height as i64);
    let step = 3i64.max(((region.width * region.height / 1600.0).sqrt()).floor() as i64);
    let inside =
        |x: i64, y: i64| mask.is_none_or(|(labels, code)| labels[(y * w + x) as usize] == code);
    // Same window as the lattice: y from max(2, ceil(region.y)) while y < min(h-2, region.y+region.height).
    let y_limit = ((h - 2) as f64).min(region.y + region.height);
    let x_limit = ((w - 2) as f64).min(region.x + region.width);
    let x_start = 2i64.max(region.x.ceil() as i64);
    let y_start = 2i64.max(region.y.ceil() as i64);
    if (x_start as f64) >= x_limit || (y_start as f64) >= y_limit {
        return Vec::new();
    }
    if let Some((g, f)) = guide {
        return select_native_points_guided(
            b,
            w,
            h,
            x_start,
            y_start,
            x_limit,
            y_limit,
            step,
            &inside,
            g,
            f.max(1) as i64,
        );
    }
    // The gradient stencil needs one pixel of margin on every side of the scanned window. Every pixel in that
    // padded box is visited (a full-resolution scan, one sample per pixel rather than one every `step`
    // pixels), so its luma is computed exactly once here and reused as up to four neighbours' gradient input
    // below — recomputing it per neighbour access (as a read-only `luma(i)` closure would) would redo the
    // same multiply-add four times over for every pixel in the window.
    let (bx0, by0) = ((x_start - 1).max(0), (y_start - 1).max(0));
    let (bx1, by1) = (
        (js_ceil(x_limit) as i64 + 1).min(w),
        (js_ceil(y_limit) as i64 + 1).min(h),
    );
    let (bw, bh) = ((bx1 - bx0).max(0) as usize, (by1 - by0).max(0) as usize);
    // `u8`, not `i32`: luma is 0..=255, and a quarter the memory traffic matters at 6-7 Mpx per moving region.
    let mut luma_plane = vec![0u8; bw * bh];
    for row in 0..bh {
        let src = (((by0 + row as i64) * w + bx0) * 4) as usize;
        let dst = row * bw;
        for col in 0..bw {
            let i = src + col * 4;
            luma_plane[dst + col] =
                ((b[i] as u32 * 77 + b[i + 1] as u32 * 150 + b[i + 2] as u32 * 29) >> 8) as u8;
        }
    }
    let mut points: Vec<i64> = Vec::new();
    let mut cy = y_start;
    while (cy as f64) < y_limit {
        let mut cx = x_start;
        while (cx as f64) < x_limit {
            // Strongest-gradient pixel in this cell; strict `>` keeps the row-major-first pixel on a tie.
            let mut best: Option<(i32, i64)> = None;
            let mut dy = 0i64;
            while dy < step {
                let y = cy + dy;
                if (y as f64) >= y_limit {
                    break;
                }
                // Row bases computed once per row, not once per pixel's four neighbour lookups.
                let (row_mid, row_up, row_down) = (
                    (y - by0) as usize * bw,
                    (y - 1 - by0) as usize * bw,
                    (y + 1 - by0) as usize * bw,
                );
                let mut dx = 0i64;
                while dx < step {
                    let x = cx + dx;
                    if (x as f64) >= x_limit {
                        break;
                    }
                    if inside(x, y) {
                        let col = (x - bx0) as usize;
                        let grad = (luma_plane[row_mid + col - 1] as i32
                            - luma_plane[row_mid + col + 1] as i32)
                            .abs()
                            + (luma_plane[row_up + col] as i32 - luma_plane[row_down + col] as i32)
                                .abs();
                        if best.is_none_or(|(bg, _)| grad > bg) {
                            best = Some((grad, y * w + x));
                        }
                    }
                    dx += 1;
                }
                dy += 1;
            }
            if let Some((grad, p)) = best {
                if grad > 12 {
                    points.push(p);
                }
            }
            cx += step;
        }
        cy += step;
    }
    points
}

/// Coarse-to-fine cell scan for [`select_native_points`]'s `guide` branch: per cell, the strongest-gradient
/// analysis pixel first, then the strongest-gradient native pixel inside just that one analysis pixel's
/// native block. Never materialises a native luma plane — only ever reads the handful of native pixels (and
/// their four neighbours) that a chosen analysis pixel's block can contain.
#[allow(clippy::too_many_arguments)]
fn select_native_points_guided(
    b: &[u8],
    w: i64,
    h: i64,
    x_start: i64,
    y_start: i64,
    x_limit: f64,
    y_limit: f64,
    step: i64,
    inside: &impl Fn(i64, i64) -> bool,
    g: Gray<'_>,
    f: i64,
) -> Vec<i64> {
    let (gw, gh) = (g.width as i64, g.height as i64);
    // Native luma at one point only, from `b`'s own RGBA — never a precomputed plane (stage 2 only ever
    // touches one analysis pixel's native block per cell, a handful of pixels, not the whole window).
    let native_luma = |x: i64, y: i64| -> i32 {
        let i = ((y * w + x) * 4) as usize;
        ((b[i] as u32 * 77 + b[i + 1] as u32 * 150 + b[i + 2] as u32 * 29) >> 8) as i32
    };
    // The largest integer native coordinate that still satisfies the window's strict `< x_limit`/`< y_limit`
    // bound (an analysis pixel whose block starts beyond this can never contribute a stage-2 point, so stage
    // 1 must not consider it — otherwise a boundary cell could pick an out-of-window analysis pixel over an
    // in-window one with a lower but real gradient, and silently contribute nothing where the unguided scan
    // would have found a point. `f = 1`'s exact reduction to the unguided argmax depends on this).
    let (window_x_hi, window_y_hi) = (
        (js_ceil(x_limit) as i64 - 1).min(w - 1),
        (js_ceil(y_limit) as i64 - 1).min(h - 1),
    );
    let mut points: Vec<i64> = Vec::new();
    let mut cy = y_start;
    while (cy as f64) < y_limit {
        let mut cx = x_start;
        while (cx as f64) < x_limit {
            let (cell_x_hi, cell_y_hi) = (
                (cx + step - 1).min(window_x_hi),
                (cy + step - 1).min(window_y_hi),
            );
            // Stage 1: the strongest-gradient analysis pixel among those whose native block intersects the
            // cell. Strict `>` keeps the row-major-first pixel on a tie.
            let mut chosen: Option<(i64, i64)> = None;
            let mut best_analysis_grad = i32::MIN;
            let mut ay = (cy / f).max(1);
            while ay <= (cell_y_hi / f).min(gh - 2) {
                let mut ax = (cx / f).max(1);
                while ax <= (cell_x_hi / f).min(gw - 2) {
                    let (nx0, ny0) = (ax * f, ay * f);
                    let (nx1, ny1) = ((nx0 + f).min(w), (ny0 + f).min(h));
                    let (cx_mid, cy_mid) = (nx0 + (nx1 - nx0) / 2, ny0 + (ny1 - ny0) / 2);
                    if inside(cx_mid, cy_mid) {
                        let gi = (ay * gw + ax) as usize;
                        let grad = (g.data[gi - 1] as i32 - g.data[gi + 1] as i32).abs()
                            + (g.data[gi - gw as usize] as i32 - g.data[gi + gw as usize] as i32)
                                .abs();
                        if grad > best_analysis_grad {
                            best_analysis_grad = grad;
                            chosen = Some((ax, ay));
                        }
                    }
                    ax += 1;
                }
                ay += 1;
            }
            // Stage 2: the strongest-gradient native pixel inside that one analysis pixel's block ∩ cell ∩
            // window ∩ mask. Kept iff its native gradient clears the same threshold the unguided scan uses.
            if let Some((ax, ay)) = chosen {
                let (nx0, ny0) = (ax * f, ay * f);
                let (nx1, ny1) = ((nx0 + f).min(w), (ny0 + f).min(h));
                let mut best: Option<(i32, i64)> = None;
                let mut y = ny0.max(cy).max(y_start);
                let y_hi = ny1.min(cy + step).min(h);
                while y < y_hi && (y as f64) < y_limit {
                    let mut x = nx0.max(cx).max(x_start);
                    let x_hi = nx1.min(cx + step).min(w);
                    while x < x_hi && (x as f64) < x_limit {
                        if inside(x, y) {
                            let grad = (native_luma(x - 1, y) - native_luma(x + 1, y)).abs()
                                + (native_luma(x, y - 1) - native_luma(x, y + 1)).abs();
                            if best.is_none_or(|(bg, _)| grad > bg) {
                                best = Some((grad, y * w + x));
                            }
                        }
                        x += 1;
                    }
                    y += 1;
                }
                if let Some((grad, p)) = best {
                    if grad > 12 {
                        points.push(p);
                    }
                }
            }
            cx += step;
        }
        cy += step;
    }
    points
}

/// Native-pixel refinement of `b` against `a` at integer offsets, given points already chosen by
/// [`select_native_points`] for this `b`/`region`/`mask`. Split out of `refine_native` so a caller with
/// several hypotheses over the same region (`track::odometry`) selects the points once and reuses them.
#[allow(clippy::too_many_arguments)]
pub fn refine_native_at(
    a: &[u8],
    b: &[u8],
    width: usize,
    height: usize,
    guess: Point,
    mask: Option<(&[u8], u8)>,
    radius: i32,
    points: &[i64],
) -> NativeRefinement {
    let (w, h) = (width as i64, height as i64);
    let (gx, gy) = (js_round(guess.x), js_round(guess.y));
    let inside =
        |x: i64, y: i64| mask.is_none_or(|(labels, code)| labels[(y * w + x) as usize] == code);
    if points.len() < 12 {
        return NativeRefinement {
            x: gx,
            y: gy,
            error: f64::INFINITY,
            samples: points.len() as u32,
            runner_up: f64::INFINITY,
        };
    }
    let mut samples = 0u32;
    let mut cost = |dx: i64, dy: i64| -> f64 {
        let (mut error, mut n) = (0f64, 0u32);
        for &p in points {
            let (x, y) = (p % w, p / w);
            let (xx, yy) = (x + dx, y + dy);
            if xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1 || !inside(xx, yy) {
                continue;
            }
            let i = (p * 4) as usize;
            let j = ((yy * w + xx) * 4) as usize;
            let d = (a[j] as i32 - b[i] as i32).abs()
                + (a[j + 1] as i32 - b[i + 1] as i32).abs()
                + (a[j + 2] as i32 - b[i + 2] as i32).abs();
            error += (90.0f64).min(d as f64 / 3.0);
            n += 1;
        }
        samples = samples.max(n);
        if n >= 12 {
            error / n as f64
        } else {
            f64::INFINITY
        }
    };
    let (mut best, mut px, mut py) = (f64::INFINITY, gx, gy);
    let mut costs: Vec<(i32, i32, f64)> = Vec::new();
    for y in gy - radius..=gy + radius {
        for x in gx - radius..=gx + radius {
            let e = cost(x as i64, y as i64);
            costs.push((x, y, e));
            let closer = hypot(x as f64 - guess.x, y as f64 - guess.y)
                < hypot(px as f64 - guess.x, py as f64 - guess.y);
            if e < best - 1e-6 || ((e - best).abs() < 1e-6 && closer) {
                best = e;
                px = x;
                py = y;
            }
        }
    }
    let runner_up = costs
        .iter()
        .filter(|c| (c.0 - px).abs().max((c.1 - py).abs()) > 2)
        .map(|c| c.2)
        .fold(f64::INFINITY, f64::min);
    NativeRefinement {
        x: px,
        y: py,
        error: best,
        samples,
        runner_up,
    }
}

/// Native-pixel refinement on textured luma edges of `b` inside `region`, matching against `a` at
/// integer offsets. `labels`/`code` (region atlas membership) restrict both frames when given. Composes
/// [`select_native_points`] and [`refine_native_at`]; a caller evaluating several candidates over the same
/// `b`/`region`/`mask` should call those directly to select once and reuse the points (see `track::odometry`).
#[allow(clippy::too_many_arguments)]
pub fn refine_native(
    a: &[u8],
    b: &[u8],
    width: usize,
    height: usize,
    guess: Point,
    region: Rect,
    mask: Option<(&[u8], u8)>,
    radius: i32,
) -> NativeRefinement {
    let points = select_native_points(b, width, height, region, mask, None);
    refine_native_at(a, b, width, height, guess, mask, radius, &points)
}

/// Keyframe patch (region-local origin, `size`×`size` native luma).
pub struct Patch<'a> {
    pub x: i32,
    pub y: i32,
    pub size: usize,
    pub data: &'a [u8],
}

/// Aligns keyframe patches in the current native luma frame at integer offsets around `guess` (current → keyframe).
pub fn refine_patches(
    patches: &[Patch<'_>],
    native: Gray<'_>,
    region: Rect,
    guess: Point,
    radius: i32,
) -> NativeRefinement {
    let (rx, ry, rw, rh) = (
        js_round(region.x),
        js_round(region.y),
        js_round(region.width),
        js_round(region.height),
    );
    let w = native.width as i64;
    let (gx, gy) = (js_round(guess.x), js_round(guess.y));
    let region_inside = rx >= 0
        && ry >= 0
        && rw >= 0
        && rh >= 0
        && (rx + rw) as usize <= native.width
        && (ry + rh) as usize <= native.height;
    if patches.is_empty() || !region_inside {
        return NativeRefinement {
            x: gx,
            y: gy,
            error: f64::INFINITY,
            samples: 0,
            runner_up: f64::INFINITY,
        };
    }
    let mut samples = 0u32;
    let mut cost = |dx: i32, dy: i32| -> f64 {
        let (mut error, mut n) = (0f64, 0u32);
        for p in patches {
            let (cx, cy) = (p.x - dx, p.y - dy);
            if cx < 0 || cy < 0 || cx + p.size as i32 > rw || cy + p.size as i32 > rh {
                continue;
            }
            let mut py = 0usize;
            while py < p.size {
                let row_a = ((ry + cy) as i64 + py as i64) * w + (rx + cx) as i64;
                let row_p = py * p.size;
                let mut px = 0usize;
                while px < p.size {
                    error += (90.0f64).min(
                        (native.data[(row_a + px as i64) as usize] as i32
                            - p.data[row_p + px] as i32)
                            .abs() as f64,
                    );
                    n += 1;
                    px += 2;
                }
                py += 2;
            }
        }
        samples = samples.max(n);
        if n >= 64 {
            error / n as f64
        } else {
            f64::INFINITY
        }
    };
    let (mut best, mut bx, mut by) = (f64::INFINITY, gx, gy);
    let mut costs: Vec<(i32, i32, f64)> = Vec::new();
    for y in gy - radius..=gy + radius {
        for x in gx - radius..=gx + radius {
            let e = cost(x, y);
            costs.push((x, y, e));
            let closer = hypot(x as f64 - guess.x, y as f64 - guess.y)
                < hypot(bx as f64 - guess.x, by as f64 - guess.y);
            if e < best - 1e-6 || ((e - best).abs() < 1e-6 && closer) {
                best = e;
                bx = x;
                by = y;
            }
        }
    }
    let runner_up = costs
        .iter()
        .filter(|c| (c.0 - bx).abs().max((c.1 - by).abs()) > 2)
        .map(|c| c.2)
        .fold(f64::INFINITY, f64::min);
    NativeRefinement {
        x: bx,
        y: by,
        error: best,
        samples,
        runner_up,
    }
}

/// One `extractPatches` output patch: region-local native pixels plus its `size × size` luma data.
pub struct ExtractedPatch {
    pub x: f64,
    pub y: f64,
    pub size: usize,
    pub data: Vec<u8>,
}

/// Native-resolution texture samples around `features` (analysis-resolution points, scaled by `factor`),
/// non-overlapping, clamped to `region`, first `count` accepted in feature order. `native` is the FULL native
/// luma plane (`native_width × native_height`); a caller-supplied `region` that would read outside it is
/// rejected (empty result) instead of indexing past the plane — the historical TS never validated this because a
/// JS typed-array read past the end just returns `undefined`, but a Rust slice index would panic.
#[allow(clippy::too_many_arguments)]
pub fn extract_patches(
    native: &[u8],
    native_width: usize,
    native_height: usize,
    region: Rect,
    features: &[(f64, f64)],
    factor: f64,
    count: usize,
    size: usize,
) -> Vec<ExtractedPatch> {
    let mut out: Vec<ExtractedPatch> = Vec::new();
    let (rx, ry, rw, rh) = (
        js_round(region.x),
        js_round(region.y),
        js_round(region.width),
        js_round(region.height),
    );
    if (rw as f64) < size as f64 + 2.0 || (rh as f64) < size as f64 + 2.0 {
        return out;
    }
    if rx < 0 || ry < 0 || (rx + rw) as usize > native_width || (ry + rh) as usize > native_height {
        return out;
    }
    let mut taken: Vec<(f64, f64)> = Vec::new();
    for &(fx, fy) in features {
        if out.len() >= count {
            break;
        }
        let x = (js_round(fx * factor) as f64 - size as f64 / 2.0)
            .clamp(0.0, (rw - size as i32) as f64);
        let y = (js_round(fy * factor) as f64 - size as f64 / 2.0)
            .clamp(0.0, (rh - size as i32) as f64);
        if taken
            .iter()
            .any(|&(tx, ty)| (tx - x).abs() < size as f64 && (ty - y).abs() < size as f64)
        {
            continue;
        }
        taken.push((x, y));
        let mut data = vec![0u8; size * size];
        for row in 0..size {
            let src = ((ry + y as i32 + row as i32) as i64 * native_width as i64
                + (rx + x as i32) as i64) as usize;
            data[row * size..row * size + size].copy_from_slice(&native[src..src + size]);
        }
        out.push(ExtractedPatch { x, y, size, data });
    }
    out
}

/// When translation fails, asks explicitly whether `previous` (resampled at each candidate scale) explains
/// `current` — fuses `resampleGray` + `extractFeatures(320)` + `matchFeatures` + `translationHypotheses(4)` +
/// the support/audit gates into one call per candidate scale, exactly the historical TS loop's order. First
/// strict minimum by `agreeingError` in scale order (matches the TS `!best || audit.agreeingError < best.error`).
pub fn probe_scale(
    previous: Gray<'_>,
    current: Gray<'_>,
    current_features: &[crate::features::Feature],
    roi: Option<Rect>,
    scales: &[f64],
) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    for &scale in scales {
        let (sw, sh, sdata) = resample_gray(previous, scale);
        let scaled_features = crate::features::extract_features(&sdata, sw, sh, 320, None);
        let matches = crate::features::match_features(&scaled_features, current_features, true);
        let match_points: Vec<MatchPoints> = matches
            .iter()
            .map(|m| MatchPoints {
                ax: scaled_features[m.a as usize].x as f64,
                ay: scaled_features[m.a as usize].y as f64,
                bx: current_features[m.b as usize].x as f64,
                by: current_features[m.b as usize].y as f64,
                unique: m.unique,
            })
            .collect();
        let scaled_gray = Gray {
            width: sw,
            height: sh,
            data: &sdata,
        };
        for m in translation_hypotheses(&match_points, 4) {
            if m.support < 8 {
                continue;
            }
            let audit = audit_translation(scaled_gray, current, m.x, m.y, roi, true);
            if audit.samples < 200
                || !audit.error.is_finite()
                || audit.agreement < 0.5
                || audit.agreeing_error > 10.0
            {
                continue;
            }
            if best.is_none_or(|(_, e)| audit.agreeing_error < e) {
                best = Some((scale, audit.agreeing_error));
            }
        }
    }
    best
}

/// Bilinear resample of an analysis image (probe only; output pixels are never resampled).
pub fn resample_gray(g: Gray<'_>, scale: f64) -> (usize, usize, Vec<u8>) {
    let width = 2usize.max(js_round(g.width as f64 * scale) as usize);
    let height = 2usize.max(js_round(g.height as f64 * scale) as usize);
    let mut data = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            let sx = (g.width as f64 - 1.001).min(x as f64 / scale).max(0.0);
            let sy = (g.height as f64 - 1.001).min(y as f64 / scale).max(0.0);
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = (sx - x0, sy - y0);
            let (x0, y0) = (x0 as usize, y0 as usize);
            // A one-pixel-wide or -high source has no right/bottom neighbour; sample the edge pixel instead of
            // reading past the row (the historical TS read `undefined`, i.e. 0, there).
            let (x1, y1) = ((x0 + 1).min(g.width - 1), (y0 + 1).min(g.height - 1));
            let d = g.data;
            let at = |xx: usize, yy: usize| d[yy * g.width + xx] as f64;
            let value = (at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx) * (1.0 - fy)
                + (at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx) * fy;
            // Uint8Array assignment truncates toward zero after ToInt32 wrap; values here are within 0..=255.
            data[y * width + x] = value as u8;
        }
    }
    (width, height, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{extract_features, match_features};

    fn texture(width: usize, height: usize, seed: u32) -> Vec<u8> {
        let mut rng = Rng::new(seed | 1);
        let mut data = vec![0u8; width * height];
        for y in 0..height {
            for x in 0..width {
                let block = ((x >> 5) * 7 + (y >> 5) * 13) & 3;
                let base = match block {
                    0 => 30,
                    1 => 120,
                    2 => 200,
                    _ => ((x + y) & 255) as i32,
                };
                data[y * width + x] =
                    (base + (rng.next_f64() * 24.0).floor() as i32 - 12).clamp(0, 255) as u8;
            }
        }
        data
    }

    fn crop(world: &[u8], ww: usize, x: usize, y: usize, w: usize, h: usize) -> Vec<u8> {
        let mut out = vec![0u8; w * h];
        for row in 0..h {
            out[row * w..(row + 1) * w]
                .copy_from_slice(&world[(y + row) * ww + x..(y + row) * ww + x + w]);
        }
        out
    }

    #[test]
    fn whole_motion_pipeline_runs_on_textured_shifts() {
        for (w, h, dx, dy) in [
            (320usize, 240usize, 17i64, 23i64),
            (640, 360, -41, 8),
            (200, 320, 0, 0),
            (256, 256, 3, -37),
        ] {
            let world = texture(w + 200, h + 200, (w * 31 + h) as u32);
            let a = crop(&world, w + 200, 100, 100, w, h);
            let b = crop(
                &world,
                w + 200,
                (100 + dx) as usize,
                (100 + dy) as usize,
                w,
                h,
            );
            let fa = extract_features(&a, w, h, 480, None);
            let fb = extract_features(&b, w, h, 480, None);
            let matches: Vec<MatchPoints> = match_features(&fa, &fb, true)
                .iter()
                .map(|m| MatchPoints {
                    ax: fa[m.a as usize].x as f64,
                    ay: fa[m.a as usize].y as f64,
                    bx: fb[m.b as usize].x as f64,
                    by: fb[m.b as usize].y as f64,
                    unique: m.unique,
                })
                .collect();
            let ga = Gray {
                width: w,
                height: h,
                data: &a,
            };
            let gb = Gray {
                width: w,
                height: h,
                data: &b,
            };
            let hyp = translation_hypotheses(&matches, 6);
            assert!(!hyp.is_empty() || matches.len() < 3);
            let _ = detect_scale(&matches);
            for roi in [
                None,
                Some(Rect {
                    x: 10.5,
                    y: 7.0,
                    width: w as f64 / 2.0,
                    height: h as f64 / 2.0,
                }),
            ] {
                for (tx, ty) in [
                    (dx as f64, dy as f64),
                    (dx as f64 + 1.0, dy as f64 - 2.0),
                    (0.0, 0.0),
                ] {
                    let _ = verify_translation(ga, gb, tx, ty, roi);
                    let _ = audit_translation(ga, gb, tx, ty, roi, true);
                    let _ = refine_translation(
                        ga,
                        gb,
                        Point {
                            x: tx + 0.4,
                            y: ty - 0.4,
                        },
                        roi,
                        2,
                    );
                }
            }
            let field = estimate_motion(ga, gb, &matches, fb.len() as u32);
            assert_eq!(field.labels.len(), field.cols * field.rows);
            let rgba = |g: &[u8]| -> Vec<u8> {
                g.iter()
                    .flat_map(|&v| [v, ((v as u32 * 3) & 255) as u8, 255 - v, 255])
                    .collect()
            };
            let (ra, rb) = (rgba(&a), rgba(&b));
            let region = Rect {
                x: 4.5,
                y: 3.0,
                width: (w - 20) as f64,
                height: (h - 9) as f64,
            };
            for guess in [
                Point {
                    x: dx as f64 + 0.3,
                    y: dy as f64 - 0.6,
                },
                Point { x: 0.0, y: 40.0 },
            ] {
                let _ = refine_native(&ra, &rb, w, h, guess, region, None, 3);
            }
            let _ = resample_gray(ga, 2.0);
            let _ = resample_gray(ga, 0.5);
            let features: Vec<(f64, f64)> = fb.iter().map(|f| (f.x as f64, f.y as f64)).collect();
            let patches = extract_patches(&b, w, h, region, &features, 1.0, 24, 32);
            assert!(patches.len() <= 24);
            for p in &patches {
                assert_eq!(p.data.len(), 32 * 32);
                assert!(p.x >= 0.0 && p.y >= 0.0);
            }
            let _ = refine_patches(
                &patches
                    .iter()
                    .map(|p| Patch {
                        x: p.x as i32,
                        y: p.y as i32,
                        size: p.size,
                        data: &p.data,
                    })
                    .collect::<Vec<_>>(),
                Gray {
                    width: w,
                    height: h,
                    data: &b,
                },
                region,
                Point {
                    x: -(dx as f64),
                    y: -(dy as f64),
                },
                3,
            );
            // A degenerate region (too small for one patch) yields nothing, not a panic.
            assert!(extract_patches(
                &b,
                w,
                h,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                },
                &features,
                1.0,
                24,
                32
            )
            .is_empty());
            let probe = probe_scale(ga, gb, &fb, None, &[1.0, 1.1, 0.9]);
            if let Some((scale, error)) = probe {
                assert!(scale > 0.0 && error.is_finite());
            }
        }
    }

    fn gray_to_rgba(g: &[u8]) -> Vec<u8> {
        g.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }

    /// A node-only sampler finds an edge only when the node pixel itself happens to sit on one; a sparse page
    /// (edges everywhere except exactly at the sampled nodes) then yields `< 12` points and `Infinity`, and
    /// the true step is read as "static" (measured on e.mov: 9-11 of ~1600 nodes kept). Every value-bearing
    /// pixel placed here sits fully inside its cell (never a node's own row/column or one of its four
    /// gradient-stencil neighbours — see `select_native_points`'s doc comment), so a node-only sampler finds
    /// zero edges here while the per-cell sampler finds one per cell and recovers the true shift.
    #[test]
    fn native_refinement_recovers_a_sparse_shift_the_lattice_would_miss() {
        let (w, h) = (280usize, 280usize);
        let (dx, dy) = (4i64, -3i64);
        let (v0, v_lo, v_mid, v_hi) = (100u8, 20u8, 150u8, 220u8);
        let region = Rect {
            x: 6.0,
            y: 6.0,
            width: 270.0,
            height: 270.0,
        };
        // Area picked so `step` is large enough (6px) for a cell to hold a gradient stencil entirely off every
        // node's own row/column — otherwise the value-bearing pixel doubles as some other node's stencil
        // neighbour and would corrupt that node's own (deliberately flat) gradient.
        let step = 3i64.max(((region.width * region.height / 1600.0).sqrt()).floor() as i64);
        assert!(
            step >= 6,
            "test assumes a wide enough cell, got step={step}"
        );
        let x_start = 2i64.max(region.x.ceil() as i64);
        let y_start = 2i64.max(region.y.ceil() as i64);
        let mut a = vec![v0; w * h];
        let mut b = vec![v0; w * h];
        let mut cy = y_start;
        while (cy as f64) < region.y + region.height {
            let mut cx = x_start;
            while (cx as f64) < region.x + region.width {
                // A value-bearing pixel 3px inside the cell, flanked by its own low/high companions so it
                // registers a strong gradient without ever touching a node's own stencil.
                let (px, py) = (cx + 3, cy + 3);
                b[(py * w as i64 + px - 1) as usize] = v_lo;
                b[(py * w as i64 + px) as usize] = v_mid;
                b[(py * w as i64 + px + 1) as usize] = v_hi;
                let (qx, qy) = (px + dx, py + dy);
                a[(qy * w as i64 + qx - 1) as usize] = v_lo;
                a[(qy * w as i64 + qx) as usize] = v_mid;
                a[(qy * w as i64 + qx + 1) as usize] = v_hi;
                cx += step;
            }
            cy += step;
        }
        let (ra, rb) = (gray_to_rgba(&a), gray_to_rgba(&b));
        let points = select_native_points(&rb, w, h, region, None, None);
        assert!(
            points.len() >= 12,
            "expected many per-cell points, got {}",
            points.len()
        );
        let r = refine_native_at(
            &ra,
            &rb,
            w,
            h,
            Point {
                x: dx as f64,
                y: dy as f64,
            },
            None,
            3,
            &points,
        );
        assert_eq!((r.x, r.y), (dx as i32, dy as i32));
        assert!(r.error < 1.0, "expected a near-zero error, got {}", r.error);
    }

    /// The same sparse fixture as above, but through the coarse-to-fine `guide` branch at `f = 6` (this
    /// fixture's own `step` is 6, so one analysis pixel's block is the whole cell's width): the guide's stage
    /// 1 still finds the one cell containing the value-bearing pixel (every other analysis pixel in the cell
    /// sits over flat background, gradient 0) and stage 2 recovers the exact native pixel inside its block, so
    /// the true shift comes back with the same near-zero error as the unguided per-cell scan.
    #[test]
    fn native_refinement_recovers_a_sparse_shift_via_the_guide() {
        let (w, h) = (280usize, 280usize);
        let (dx, dy) = (4i64, -3i64);
        let (v0, v_lo, v_mid, v_hi) = (100u8, 20u8, 150u8, 220u8);
        let region = Rect {
            x: 6.0,
            y: 6.0,
            width: 270.0,
            height: 270.0,
        };
        let step = 3i64.max(((region.width * region.height / 1600.0).sqrt()).floor() as i64);
        assert!(
            step >= 6,
            "test assumes a wide enough cell, got step={step}"
        );
        let factor = 6usize;
        let x_start = 2i64.max(region.x.ceil() as i64);
        let y_start = 2i64.max(region.y.ceil() as i64);
        let mut a = vec![v0; w * h];
        let mut b = vec![v0; w * h];
        let mut cy = y_start;
        while (cy as f64) < region.y + region.height {
            let mut cx = x_start;
            while (cx as f64) < region.x + region.width {
                let (px, py) = (cx + 3, cy + 3);
                b[(py * w as i64 + px - 1) as usize] = v_lo;
                b[(py * w as i64 + px) as usize] = v_mid;
                b[(py * w as i64 + px + 1) as usize] = v_hi;
                let (qx, qy) = (px + dx, py + dy);
                a[(qy * w as i64 + qx - 1) as usize] = v_lo;
                a[(qy * w as i64 + qx) as usize] = v_mid;
                a[(qy * w as i64 + qx + 1) as usize] = v_hi;
                cx += step;
            }
            cy += step;
        }
        let (ra, rb) = (gray_to_rgba(&a), gray_to_rgba(&b));
        let (gw, gh) = crate::raster::downscaled_size(w, h, factor);
        let mut guide_data = vec![0u8; gw * gh];
        crate::raster::downscale_gray(&rb, w, h, factor, &mut guide_data);
        let guide = Gray {
            width: gw,
            height: gh,
            data: &guide_data,
        };
        let points = select_native_points(&rb, w, h, region, None, Some((guide, factor)));
        assert!(
            points.len() >= 12,
            "expected many per-cell points, got {}",
            points.len()
        );
        let r = refine_native_at(
            &ra,
            &rb,
            w,
            h,
            Point {
                x: dx as f64,
                y: dy as f64,
            },
            None,
            3,
            &points,
        );
        assert_eq!((r.x, r.y), (dx as i32, dy as i32));
        assert!(r.error < 1.0, "expected a near-zero error, got {}", r.error);
    }

    /// `f = 1` makes the guide `b`'s own native luma one-for-one (`downscale_gray`'s `factor == 1` branch,
    /// bit-identical to `grayscale`), every analysis pixel's block a single native pixel, and the guided
    /// two-stage cell scan must then choose the exact same point, in the exact same order, as the unguided
    /// full-resolution scan — production `track::odometry` relies on this at `f = 1` (its own parity tests
    /// only cover `f = 1`, exercising `core().refineNative` with no guide at all; if the guided branch ever
    /// diverged from the unguided one at `f = 1`, this would be the only thing to catch it).
    #[test]
    fn native_refinement_guide_at_factor_one_matches_the_unguided_scan() {
        let (w, h) = (200usize, 200usize);
        let world = texture(w + 200, h + 200, (w * 13 + h) as u32);
        let b = crop(&world, w + 200, 100, 100, w, h);
        let rb = gray_to_rgba(&b);
        let region = Rect {
            x: 4.0,
            y: 4.0,
            width: (w - 20) as f64,
            height: (h - 20) as f64,
        };
        let unguided = select_native_points(&rb, w, h, region, None, None);
        let (gw, gh) = crate::raster::downscaled_size(w, h, 1);
        let mut guide_data = vec![0u8; gw * gh];
        crate::raster::downscale_gray(&rb, w, h, 1, &mut guide_data);
        let guide = Gray {
            width: gw,
            height: gh,
            data: &guide_data,
        };
        let guided = select_native_points(&rb, w, h, region, None, Some((guide, 1)));
        assert_eq!(unguided, guided);
        assert!(
            unguided.len() >= 12,
            "fixture should be dense enough to compare meaningfully"
        );
    }

    /// A screen-fixed line that happens to sit on a lattice row is sampled at every node on that row, so it
    /// can dominate the lattice's error mean even though the rest of the page (moving content, off that row)
    /// agrees perfectly at the true shift (measured on d.mov/e.mov: the vertical/horizontal overlay scrollbar
    /// sitting on a lattice column/row rejects the true shift or loses to a period alias). A lattice sampler
    /// takes every one of its points from that single row; a per-cell sampler takes one point from the line's
    /// own row of cells and one from every other cell, so the moving content it agrees with outweighs it.
    #[test]
    fn native_refinement_recovers_a_shift_past_a_screen_fixed_line_on_a_lattice_row() {
        let (w, h) = (280usize, 280usize);
        let (dx, dy) = (5i64, -4i64);
        let (v0, v_lo, v_mid, v_hi, v_bar) = (100u8, 20u8, 150u8, 220u8, 250u8);
        let region = Rect {
            x: 6.0,
            y: 6.0,
            width: 270.0,
            height: 270.0,
        };
        // Area picked so `step` is large enough (6px) for a cell to hold a gradient stencil entirely off every
        // node's own row/column — otherwise the "content" pixel doubles as some other node's stencil neighbour.
        let step = 3i64.max(((region.width * region.height / 1600.0).sqrt()).floor() as i64);
        assert!(
            step >= 6,
            "test assumes a wide enough cell, got step={step}"
        );
        let x_start = 2i64.max(region.x.ceil() as i64);
        let y_start = 2i64.max(region.y.ceil() as i64);
        // A fixed footer overlay (e.g. a horizontal scrollbar) below row `line_y`, an ordinary lattice row: its
        // top edge is a strong, screen-fixed y-gradient every node on `line_y` sees. Content above moves by
        // (dx, dy); the footer does not, exactly like an overlay drawn after the page is composited.
        let line_y = y_start + 12 * step;
        let mut a = vec![v0; w * h];
        let mut b = vec![v0; w * h];
        let mut cy = y_start;
        while cy < line_y {
            let mut cx = x_start;
            while (cx as f64) < region.x + region.width {
                // A value-bearing pixel 3px inside the cell (offsets 1..step-1, never a node's own row/column
                // or one of its four gradient-stencil neighbours), flanked by its own low/high companions —
                // fully interior to the cell, so it never contaminates any node's own gradient either.
                let (px, py) = (cx + 3, cy + 3);
                b[(py * w as i64 + px - 1) as usize] = v_lo;
                b[(py * w as i64 + px) as usize] = v_mid;
                b[(py * w as i64 + px + 1) as usize] = v_hi;
                let (qx, qy) = (px + dx, py + dy);
                a[(qy * w as i64 + qx - 1) as usize] = v_lo;
                a[(qy * w as i64 + qx) as usize] = v_mid;
                a[(qy * w as i64 + qx + 1) as usize] = v_hi;
                cx += step;
            }
            cy += step;
        }
        // The footer: same absolute rows and value in both frames, never shifted by (dx, dy).
        for y in line_y as usize..h {
            for x in 0..w {
                let i = y * w + x;
                a[i] = v_bar;
                b[i] = v_bar;
            }
        }
        let (ra, rb) = (gray_to_rgba(&a), gray_to_rgba(&b));
        let points = select_native_points(&rb, w, h, region, None, None);
        let r = refine_native_at(
            &ra,
            &rb,
            w,
            h,
            Point {
                x: dx as f64,
                y: dy as f64,
            },
            None,
            3,
            &points,
        );
        assert_eq!((r.x, r.y), (dx as i32, dy as i32));
        assert!(
            r.error < 14.0,
            "expected the true shift to clear the odometry gate, got {}",
            r.error
        );
    }
}
