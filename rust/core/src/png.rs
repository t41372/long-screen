//! PNG scanline reconstruction (unfilter) and filtering, used by the streaming single-PNG export path
//! (`src/codec/png.ts::encodePNG`/`decodePNG`'s legacy row helpers). The tile codec itself
//! (`abi/png.rs::ls_png_encode`/`ls_png_decode`) uses the `png` crate end to end instead.

#[inline]
fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i32 + b as i32 - c as i32;
    let pa = (p - a as i32).abs();
    let pb = (p - b as i32).abs();
    let pc = (p - c as i32).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// Reconstructs 8-bit non-interlaced scanlines into RGBA. `channels` is 1, 2, 3 or 4.
/// Returns `Err(filter)` on an invalid filter byte; the caller reports it as a corrupt tile.
pub fn unfilter_to_rgba(
    raw: &[u8],
    width: usize,
    height: usize,
    channels: usize,
    out: &mut [u8],
) -> Result<(), u8> {
    let stride = width * channels;
    let mut line = vec![0u8; stride];
    let mut previous = vec![0u8; stride];
    for y in 0..height {
        let row = &raw[y * (stride + 1)..(y + 1) * (stride + 1)];
        let (filter, src) = (row[0], &row[1..]);
        match filter {
            0 => line.copy_from_slice(src),
            1 => {
                line[..channels].copy_from_slice(&src[..channels]);
                for i in channels..stride {
                    line[i] = src[i].wrapping_add(line[i - channels]);
                }
            }
            2 => {
                for i in 0..stride {
                    line[i] = src[i].wrapping_add(previous[i]);
                }
            }
            3 => {
                for i in 0..stride {
                    let left = if i >= channels {
                        line[i - channels] as u16
                    } else {
                        0
                    };
                    line[i] = src[i].wrapping_add(((left + previous[i] as u16) >> 1) as u8);
                }
            }
            4 => {
                for i in 0..stride {
                    let left = if i >= channels { line[i - channels] } else { 0 };
                    let upper_left = if i >= channels {
                        previous[i - channels]
                    } else {
                        0
                    };
                    line[i] = src[i].wrapping_add(paeth(left, previous[i], upper_left));
                }
            }
            other => return Err(other),
        }
        let dst = &mut out[y * width * 4..(y + 1) * width * 4];
        expand_to_rgba(&line, channels, dst);
        std::mem::swap(&mut line, &mut previous);
    }
    Ok(())
}

/// Expands a channels-per-pixel buffer (1 grey, 2 grey+alpha, 3 RGB, 4 RGBA) to RGBA. `raw` holds
/// `pixel_count * channels` bytes; `out` receives `pixel_count * 4`. Shared by `unfilter_to_rgba`'s per-row
/// tail above and `abi::png::ls_png_decode` (whose scanlines the `png` crate has already unfiltered, so it
/// only needs the channel expansion, not the predictor).
pub fn expand_to_rgba(raw: &[u8], channels: usize, out: &mut [u8]) {
    match channels {
        4 => out.copy_from_slice(raw),
        3 => {
            for (px, s) in out.chunks_exact_mut(4).zip(raw.chunks_exact(3)) {
                px[..3].copy_from_slice(s);
                px[3] = 255;
            }
        }
        2 => {
            for (px, s) in out.chunks_exact_mut(4).zip(raw.chunks_exact(2)) {
                px[0] = s[0];
                px[1] = s[0];
                px[2] = s[0];
                px[3] = s[1];
            }
        }
        _ => {
            for (px, &s) in out.chunks_exact_mut(4).zip(raw.iter()) {
                px[0] = s;
                px[1] = s;
                px[2] = s;
                px[3] = 255;
            }
        }
    }
}

/// Applies the Sub filter (type 1) to RGBA rows: `out` receives `height` rows of `1 + width*4` bytes.
pub fn filter_sub_rgba(rgba: &[u8], width: usize, height: usize, out: &mut [u8]) {
    let stride = width * 4;
    for y in 0..height {
        let src = &rgba[y * stride..(y + 1) * stride];
        let dst = &mut out[y * (stride + 1)..(y + 1) * (stride + 1)];
        dst[0] = 1;
        dst[1..5].copy_from_slice(&src[..4]);
        for i in 4..stride {
            dst[i + 1] = src[i].wrapping_sub(src[i - 4]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_filter_round_trips() {
        let (w, h) = (3usize, 2usize);
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| (i * 37 % 256) as u8).collect();
        let mut filtered = vec![0u8; h * (w * 4 + 1)];
        filter_sub_rgba(&rgba, w, h, &mut filtered);
        let mut out = vec![0u8; w * h * 4];
        unfilter_to_rgba(&filtered, w, h, 4, &mut out).unwrap();
        assert_eq!(out, rgba);
    }

    #[test]
    fn invalid_filter_is_reported() {
        let raw = [9u8, 0, 0, 0, 0];
        let mut out = vec![0u8; 4];
        assert_eq!(unfilter_to_rgba(&raw, 1, 1, 4, &mut out), Err(9));
    }
}
