//! Native-frame raster kernels: luma, box-filter analysis downscale, preview halving.

use crate::pool::SyncPtr;

/// BT.601-style integer luma `(77r + 150g + 29b) >> 8`, identical to the analysis path.
#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8
}

pub fn grayscale(rgba: &[u8], out: &mut [u8]) {
    let n = out.len().min(rgba.len() / 4);
    let chunks = crate::pool::chunks_for(n, 256 * 1024);
    let dst = SyncPtr(out.as_mut_ptr());
    crate::pool::par_for(chunks, |c| {
        let (a, b) = (
            crate::pool::split(n, chunks, c),
            crate::pool::split(n, chunks, c + 1),
        );
        // SAFETY: pixels `a..b` belong to this chunk alone.
        let out = unsafe { std::slice::from_raw_parts_mut(dst.get().add(a), b - a) };
        let mut sums = [0u32; 64];
        let mut i = a;
        while i < b {
            let m = (b - i).min(64);
            weighted_luma(&rgba[i * 4..(i + m) * 4], &mut sums[..m]);
            for (o, s) in out[i - a..i - a + m].iter_mut().zip(&sums[..m]) {
                *o = (s >> 8) as u8;
            }
            i += m;
        }
    });
}

/// `77r + 150g + 29b` per pixel (the luma numerator before `>> 8`).
#[inline]
pub fn weighted_luma(rgba: &[u8], out: &mut [u32]) {
    let n = out.len();
    #[allow(unused_mut)]
    let mut i = 0;
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        // i16 lanes (r, g, b, a) · (77, 150, 29, 0), pairwise summed: (77r + 150g, 29b) per pixel, then added.
        let weights = i16x8(77, 150, 29, 0, 77, 150, 29, 0);
        while i + 4 <= n {
            // SAFETY: four pixels (16 bytes) at `i` are in bounds.
            let v = unsafe { v128_load(rgba.as_ptr().add(i * 4) as *const v128) };
            let lo = i32x4_dot_i16x8(u16x8_extend_low_u8x16(v), weights);
            let hi = i32x4_dot_i16x8(u16x8_extend_high_u8x16(v), weights);
            let sums = i32x4_add(
                i32x4_shuffle::<0, 2, 4, 6>(lo, hi),
                i32x4_shuffle::<1, 3, 5, 7>(lo, hi),
            );
            // SAFETY: `out[i..i + 4]` is in bounds; unaligned store.
            unsafe { v128_store(out.as_mut_ptr().add(i) as *mut v128, sums) };
            i += 4;
        }
    }
    for k in i..n {
        let p = &rgba[k * 4..k * 4 + 3];
        out[k] = p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29;
    }
}

/// Output dimensions of an integer-factor box downscale: partial edge cells are kept, never dropped.
#[inline]
pub fn downscaled_size(width: usize, height: usize, factor: usize) -> (usize, usize) {
    (
        width.div_ceil(factor).max(1),
        height.div_ceil(factor).max(1),
    )
}

/// Box-filtered luma at an integer factor. The mean is taken over the luma-weighted RGB sum, then `>> 8`,
/// exactly like the historical analysis path, so analysis features stay comparable across releases.
///
/// Rows are swept sequentially into one accumulator per output column (a factor-wide box), so the input is
/// read once, in order, instead of once per output cell with a stride.
pub fn downscale_gray(rgba: &[u8], width: usize, height: usize, factor: usize, out: &mut [u8]) {
    let (ow, oh) = downscaled_size(width, height, factor);
    debug_assert!(out.len() >= ow * oh);
    if factor == 1 {
        grayscale(&rgba[..width * height * 4], &mut out[..width * height]);
        return;
    }
    // Output rows are independent; each chunk sweeps its own input rows with its own accumulator and luma row,
    // allocated here because chunk bodies may not allocate.
    let chunks = crate::pool::chunks_for(oh * width * factor, 128 * 1024);
    let mut scratch = vec![0u64; chunks * ow];
    let mut sums = vec![0u32; chunks * width];
    let (acc_ptr, sum_ptr, dst) = (
        SyncPtr(scratch.as_mut_ptr()),
        SyncPtr(sums.as_mut_ptr()),
        SyncPtr(out.as_mut_ptr()),
    );
    crate::pool::par_for(chunks, |c| {
        // SAFETY: scratch slot `c` and output rows `y0..y1` belong to this chunk alone.
        let (acc, line) = unsafe {
            (
                std::slice::from_raw_parts_mut(acc_ptr.get().add(c * ow), ow),
                std::slice::from_raw_parts_mut(sum_ptr.get().add(c * width), width),
            )
        };
        let full = width / factor;
        for y in crate::pool::split(oh, chunks, c)..crate::pool::split(oh, chunks, c + 1) {
            let bh = factor.min(height - y * factor);
            acc.fill(0);
            for row in 0..bh {
                let start = (y * factor + row) * width * 4;
                weighted_luma(&rgba[start..start + width * 4], line);
                // Whole boxes first, then the partial one; integer sums, so grouping cannot change them.
                for (bx, cell) in line[..full * factor].chunks_exact(factor).enumerate() {
                    acc[bx] += cell.iter().sum::<u32>() as u64;
                }
                if full < ow {
                    acc[full] += line[full * factor..].iter().sum::<u32>() as u64;
                }
            }
            let out_row = unsafe { std::slice::from_raw_parts_mut(dst.get().add(y * ow), ow) };
            for (x, o) in out_row.iter_mut().enumerate() {
                let bw = factor.min(width - x * factor);
                *o = ((acc[x] / (bw * bh) as u64) >> 8) as u8;
            }
        }
    });
}

/// `Uint8ClampedArray` assignment: clamp to 0..=255 and round halves to even.
#[inline]
fn clamp_u8(value: f64) -> u8 {
    if value.is_nan() || value <= 0.0 {
        0
    } else if value >= 255.0 {
        255
    } else {
        value.round_ties_even() as u8
    }
}

/// 2:1 alpha-weighted preview reduction; unobserved (transparent) neighbours never darken observed pixels.
pub fn halve_rgba(rgba: &[u8], width: usize, height: usize, out: &mut [u8]) -> (usize, usize) {
    let ow = (width >> 1).max(1);
    let oh = (height >> 1).max(1);
    for y in 0..oh {
        for x in 0..ow {
            let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
            for j in 0..2 {
                for k in 0..2 {
                    let sx = (x * 2 + k).min(width - 1);
                    let sy = (y * 2 + j).min(height - 1);
                    let i = (sy * width + sx) * 4;
                    let w = rgba[i + 3] as u32;
                    r += rgba[i] as u32 * w;
                    g += rgba[i + 1] as u32 * w;
                    b += rgba[i + 2] as u32 * w;
                    a += w;
                }
            }
            let o = (y * ow + x) * 4;
            if a > 0 {
                out[o] = clamp_u8(r as f64 / a as f64);
                out[o + 1] = clamp_u8(g as f64 / a as f64);
                out[o + 2] = clamp_u8(b as f64 / a as f64);
                out[o + 3] = clamp_u8(a as f64 / 4.0);
            } else {
                out[o..o + 4].fill(0);
            }
        }
    }
    (ow, oh)
}

/// Mean absolute difference of two equal-size grey images (255 when sizes differ).
pub fn mean_difference(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 255.0;
    }
    let sum: u64 = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y) as u64).sum();
    sum as f64 / a.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_keeps_partial_cells() {
        let (w, h) = (5usize, 3usize);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i * 40) as u8, 0, 0, 255])
            .collect();
        let (ow, oh) = downscaled_size(w, h, 2);
        assert_eq!((ow, oh), (3, 2));
        let mut out = vec![0; ow * oh];
        downscale_gray(&rgba, w, h, 2, &mut out);
        // Last column is a single-pixel-wide box covering pixels 4 and 9 (red 160 and 104 after u8 wrap);
        // the last row (pixels 10..15) is a single-pixel-high box.
        let cell = |a: u64, b: u64| (((a * 77 + b * 77) / 2) >> 8) as u8;
        assert_eq!(out[2], cell(160, 104));
        assert_eq!(out[3], cell((10 * 40) % 256, (11 * 40) % 256));
        assert_eq!(out[5], ((((14 * 40) % 256) as u64 * 77) >> 8) as u8);
    }

    #[test]
    fn clamped_rounding_is_half_to_even() {
        assert_eq!(clamp_u8(0.5), 0);
        assert_eq!(clamp_u8(1.5), 2);
        assert_eq!(clamp_u8(2.5), 2);
        assert_eq!(clamp_u8(300.0), 255);
    }
}

/// Refreshes the saved pixels of a fixed (screen-anchored) region from `rgba` and reports whether any pixel the
/// region owns changed. `saved` is `rw × rh` RGBA laid out from the region's floored origin `(x0, y0)`; pixels
/// outside the frame or not labelled `code` are neither compared nor written. Rows are split across the pool.
#[allow(clippy::too_many_arguments)]
pub fn fixed_update(
    saved: &mut [u8],
    rgba: &[u8],
    labels: &[u8],
    width: usize,
    height: usize,
    x0: i64,
    y0: i64,
    rw: usize,
    rh: usize,
    code: u8,
) -> bool {
    let (w, h) = (width as i64, height as i64);
    let (lo, hi) = (x0.max(0), (x0 + rw as i64).min(w));
    if hi <= lo {
        return false;
    }
    let chunks = crate::pool::chunks_for(rh * rw, 64 * 1024);
    let mut changed = vec![false; chunks];
    let (dst, flags) = (SyncPtr(saved.as_mut_ptr()), SyncPtr(changed.as_mut_ptr()));
    crate::pool::par_for(chunks, |c| {
        let mut any = false;
        for y in crate::pool::split(rh, chunks, c)..crate::pool::split(rh, chunks, c + 1) {
            let ny = y0 + y as i64;
            if ny < 0 || ny >= h {
                continue;
            }
            // SAFETY: saved row `y` belongs to this chunk alone.
            let row = unsafe { std::slice::from_raw_parts_mut(dst.get().add(y * rw * 4), rw * 4) };
            let base = ny as usize * width;
            for nx in lo..hi {
                let i = base + nx as usize;
                if labels[i] != code {
                    continue;
                }
                let j = (nx - x0) as usize * 4;
                let src = &rgba[i * 4..i * 4 + 4];
                if row[j..j + 4] != *src {
                    row[j..j + 4].copy_from_slice(src);
                    any = true;
                }
            }
        }
        // SAFETY: one flag per chunk.
        unsafe { *flags.get().add(c) = any };
    });
    changed.iter().any(|&c| c)
}
