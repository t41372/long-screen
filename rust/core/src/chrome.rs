//! Screen-fixed chrome evidence on native frames (`src/core/layers.ts::stationaryBoundary`,
//! `stickyOcclusions`): a persistent appearance edge within a stationary band, and the per-observation sticky
//! header band whose native texture agrees with zero motion and disagrees with the accepted page translation.
//! Thresholds, sampling steps and the "return the carried bands" fallbacks are the historical ones.

use crate::geometry::{js_ceil, js_floor, js_round, Rect};

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

/// Sticky-band evidence for one observation. `carry` are the previous observation's bands, retained while
/// every native pixel under them is unchanged. Returns the bands to exclude from the moving canvas.
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
    if crate::geometry::js_hypot(motion_x, motion_y) < 2.0 {
        return carry;
    }
    let r = region;
    let (dx, dy) = (js_round(motion_x) as i64, js_round(motion_y) as i64);
    let end = (h - 2).min(js_floor(r.y + (288.0f64).min(r.height * 0.23)) as i64);
    let start = 2i64.max(js_floor(r.y) as i64);
    let step = 1i64.max(js_floor(r.width / 700.0) as i64);
    let (mut last_fixed, mut strong_rows, mut matched) = (-1i64, 0u32, 0u32);
    let x_start = 2i64.max(js_ceil(r.x) as i64);
    let x_end = (w - 2) as f64;
    for y in start..end {
        if y + dy < 2 || y + dy >= h - 2 {
            continue;
        }
        let (mut n, mut zero, mut shifted) = (0u32, 0i64, 0i64);
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
            zero += (previous[i] as i64 - current[i] as i64).abs();
            shifted += (previous[j] as i64 - current[i] as i64).abs();
            n += 1;
            x += step;
        }
        let nf = n as f64;
        if n >= 8 && (zero as f64) / nf < 6.0 && (shifted as f64) / nf > 18.0 {
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
