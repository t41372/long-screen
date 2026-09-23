//! Native-frame raster kernels: luma, box-filter analysis downscale, preview halving.

/// BT.601-style integer luma `(77r + 150g + 29b) >> 8`, identical to the analysis path.
#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8
}

pub fn grayscale(rgba: &[u8], out: &mut [u8]) {
    for (px, o) in rgba.chunks_exact(4).zip(out.iter_mut()) {
        *o = luma(px[0], px[1], px[2]);
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
    let mut acc = vec![0u64; ow];
    for y in 0..oh {
        let bh = factor.min(height - y * factor);
        acc.fill(0);
        for row in 0..bh {
            let start = (y * factor + row) * width * 4;
            let line = &rgba[start..start + width * 4];
            // Whole boxes first (a fixed-trip-count inner loop the compiler can unroll), then the partial one.
            let full = width / factor;
            for (bx, cell) in line[..full * factor * 4]
                .chunks_exact(factor * 4)
                .enumerate()
            {
                let mut sum = 0u32;
                for px in cell.chunks_exact(4) {
                    sum += px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29;
                }
                acc[bx] += sum as u64;
            }
            if full < ow {
                let mut sum = 0u32;
                for px in line[full * factor * 4..].chunks_exact(4) {
                    sum += px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29;
                }
                acc[full] += sum as u64;
            }
        }
        let out_row = &mut out[y * ow..y * ow + ow];
        for (x, o) in out_row.iter_mut().enumerate() {
            let bw = factor.min(width - x * factor);
            *o = ((acc[x] / (bw * bh) as u64) >> 8) as u8;
        }
    }
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
