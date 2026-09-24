//! Stage: band detection (stationary top/bottom/left/right edges) + texture test, and the strongest-cut index
//! used to split analysis cells at a persistent global divider.

use super::{stat_at, Rgba};
use crate::chrome::{stationary_boundary, Axis, Choose};
use crate::geometry::{js_ceil, js_floor, js_round};

// ---------------------------------------------------------------------------------------------------------------
// Stage: band detection (stationary top/bottom/left/right edges) + texture test.
// ---------------------------------------------------------------------------------------------------------------
pub struct Bands {
    pub top: i64,
    pub bottom: i64,
    pub left: i64,
    pub right: i64,
    pub exact_left: Option<f64>,
    pub exact_right: Option<f64>,
}

/// Mean of the middle rows of the reference frame, sampled every 3rd row, per analysis column (`middleMean` in
/// the TS oracle); only built when a native reference frame is available.
fn middle_mean(width: i64, top: i64, bottom: i64, factor: f64, reference: &Rgba) -> Vec<f64> {
    let mut out = vec![0.0; width.max(0) as usize];
    for x in 0..width {
        let (mut sum, mut count): (f64, f64) = (0.0, 0.0);
        let mut y = top + 2;
        while y < bottom - 2 {
            let iy = js_floor(y as f64 * factor)
                .min(reference.height as i32 - 1)
                .max(0) as usize;
            let ix = js_floor(x as f64 * factor)
                .min(reference.width as i32 - 1)
                .max(0) as usize;
            let i = (iy * reference.width + ix) * 4;
            sum += (reference.data[i] as f64
                + reference.data[i + 1] as f64
                + reference.data[i + 2] as f64)
                / 3.0;
            count += 1.0;
            y += 3;
        }
        out[x as usize] = sum / count.max(1.0);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn textured(
    from: i64,
    to: i64,
    informative_frames: f64,
    reference: Option<&Rgba>,
    middle_mean: &[f64],
    col_mean: &[f64],
    top: i64,
    bottom: i64,
    factor: f64,
) -> bool {
    if to - from < 6 || informative_frames == 0.0 {
        return false;
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for x in from..to {
        let mean = if reference.is_some() {
            middle_mean[x as usize]
        } else {
            col_mean[x as usize] / informative_frames
        };
        lo = lo.min(mean);
        hi = hi.max(mean);
    }
    if reference.is_none() {
        return hi - lo > 6.0;
    }
    let img = reference.unwrap();
    let (sx, sy) = (factor, factor);
    let (mut structure, mut samples) = (0u32, 0u32);
    let mut y = top + 3;
    while y < bottom - 3 {
        let mut x = from + 1;
        while x < to - 1 {
            let nx = js_floor(x as f64 * sx) as i64;
            let ny = js_floor(y as f64 * sy) as i64;
            let step = js_round(sy).max(1) as i64;
            let i = (ny * img.width as i64 + nx) * 4;
            let a = i - step * img.width as i64 * 4;
            let b = i + step * img.width as i64 * 4;
            if a >= 0 && (b as usize) < img.data.len() {
                if (img.data[a as usize] as i32 - img.data[b as usize] as i32).abs() > 12 {
                    structure += 1;
                }
                samples += 1;
            }
            x += 2;
        }
        y += 2;
    }
    structure >= 8 && structure as f64 / (samples.max(1) as f64) > 0.003
}

#[allow(clippy::too_many_arguments)]
pub fn detect_bands(
    width: i64,
    height: i64,
    informative_frames: f64,
    row_change: &[f64],
    col_change: &[f64],
    col_mean: &[f64],
    reference: Option<&Rgba>,
    native_width: f64,
    native_height: f64,
    factor: f64,
) -> Bands {
    let (mut top, mut bottom) = (0i64, height);
    if informative_frames >= 2.0 {
        while (top as f64) < height as f64 * 0.45
            && stat_at(row_change, top) / informative_frames < 0.9
        {
            top += 1;
        }
        while bottom as f64 > height as f64 * 0.55
            && stat_at(row_change, bottom - 1) / informative_frames < 0.9
        {
            bottom -= 1;
        }
        if top < 6 || top as f64 >= height as f64 * 0.45 {
            top = 0;
        }
        if height - bottom < 6 || bottom as f64 <= height as f64 * 0.55 {
            bottom = height;
        }
    }
    let mm = if let Some(img) = reference {
        middle_mean(width, top, bottom, factor, img)
    } else {
        Vec::new()
    };
    let (mut left, mut right) = (0i64, width);
    let (mut exact_left, mut exact_right) = (None, None);
    if informative_frames >= 2.0 {
        while (left as f64) < width as f64 * 0.45
            && stat_at(col_change, left) / informative_frames < 0.7
        {
            left += 1;
        }
        while right as f64 > width as f64 * 0.55
            && stat_at(col_change, right - 1) / informative_frames < 0.7
        {
            right -= 1;
        }
        if let Some(img) = reference {
            let scale = factor;
            let cross_from = native_height.min((top as f64 * factor).ceil());
            let cross_to = native_height.min((bottom as f64 * factor).floor());
            exact_left = if left > 0 && (left as f64) < width as f64 * 0.45 {
                stationary_boundary(
                    img.data,
                    img.width,
                    img.height,
                    Axis::X,
                    0.0,
                    (left as f64 * scale).ceil(),
                    cross_from,
                    cross_to,
                    Choose::Last,
                )
            } else {
                None
            };
            exact_right = if right < width && (right as f64) > width as f64 * 0.55 {
                stationary_boundary(
                    img.data,
                    img.width,
                    img.height,
                    Axis::X,
                    (right as f64 * scale).floor(),
                    native_width,
                    cross_from,
                    cross_to,
                    Choose::First,
                )
            } else {
                None
            };
            if let Some(v) = exact_left {
                left = js_floor(v / scale) as i64;
            }
            if let Some(v) = exact_right {
                right = js_ceil(v / scale) as i64;
            }
        }
        if left < 6
            || (left as f64) >= width as f64 * 0.45
            || !textured(
                0,
                left,
                informative_frames,
                reference,
                &mm,
                col_mean,
                top,
                bottom,
                factor,
            )
        {
            left = 0;
            exact_left = None;
        }
        if width - right < 6
            || (right as f64) <= width as f64 * 0.55
            || !textured(
                right,
                width,
                informative_frames,
                reference,
                &mm,
                col_mean,
                top,
                bottom,
                factor,
            )
        {
            right = width;
            exact_right = None;
        }
    }
    Bands {
        top,
        bottom,
        left,
        right,
        exact_left,
        exact_right,
    }
}

/// Column/row index of the strongest binary split (`strongestCut`): the index maximising a two-sided coverage
/// gain, accepted only with ≥ 4 informative frames and > 12% of them agreeing.
pub fn strongest_cut(g: &[f64], informative_frames: f64) -> i64 {
    let mut best = 0i64;
    let hi = g.len() as i64 - 2;
    let mut k = 2i64;
    while k < hi {
        if g[k as usize] > g[best as usize] {
            best = k;
        }
        k += 1;
    }
    if informative_frames >= 4.0
        && g.get(best as usize).copied().unwrap_or(0.0) / informative_frames > 0.12
    {
        best
    } else {
        0
    }
}
