//! Decoded-frame layouts (planar and semi-planar YUV) to RGBA, for browsers whose
//! `VideoFrame.copyTo` cannot convert to RGB itself (Safari, through at least 27). The arithmetic is libyuv's C
//! reference (`row_common.cc`: `YuvPixel`, x86 form) with its `YuvConstants`, which is what Chrome's own
//! `copyTo({ format: 'RGBA' })` runs on a software-decoded frame; chroma is point-sampled like libyuv's
//! `I4xxToARGBRow_C`. Rows are split across the pool; every output byte depends only on its own inputs. Planes
//! coding an HDR signal (PQ or HLG) go through `hdr` instead, which also undoes the transfer.

use crate::kernels::pool::SyncPtr;

pub mod hdr;

/// libyuv `YuvConstants`: Y gain/bias and the chroma contributions (6-bit fixed point).
#[derive(Clone, Copy)]
pub struct Coeffs {
    yg: u32,
    yb: i32,
    ub: i32,
    ug: i32,
    vg: i32,
    vr: i32,
}

/// Indexed by the ABI's matrix code. libyuv caps UB at 128 in its limited-range tables (the int8 SIMD limit)
/// unless built with LIBYUV_UNLIMITED_*; the capped values are the ones browsers ship. No BT.2020 entry: browsers
/// also convert its wider gamut to sRGB, which a matrix alone cannot, so such frames are left to the canvas.
pub static MATRICES: [Coeffs; 4] = [
    // H709: BT.709 limited range
    Coeffs {
        yg: 18997,
        yb: -1160,
        ub: 128,
        ug: 14,
        vg: 34,
        vr: 115,
    },
    // F709: BT.709 full range
    Coeffs {
        yg: 16320,
        yb: 32,
        ub: 119,
        ug: 12,
        vg: 30,
        vr: 101,
    },
    // I601: BT.601 limited range
    Coeffs {
        yg: 18997,
        yb: -1160,
        ub: 128,
        ug: 25,
        vg: 52,
        vr: 102,
    },
    // JPEG: BT.601 full range
    Coeffs {
        yg: 16320,
        yb: 32,
        ub: 113,
        ug: 22,
        vg: 46,
        vr: 90,
    },
];

/// What a frame's planes code, from the ABI's colour code `transfer × 8 + matrix × 2 + full` (transfer 0 SDR, 1 PQ,
/// 2 HLG; matrix 0 BT.709, 1 BT.601, 2 BT.2020). The SDR codes 0–3 index `MATRICES`; SDR BT.2020 has no code.
#[derive(Clone, Copy)]
pub enum Signal {
    Sdr(&'static Coeffs),
    Hdr {
        matrix: hdr::Matrix,
        full: bool,
        transfer: hdr::Transfer,
    },
}

impl Signal {
    pub fn from_code(code: u32) -> Option<Signal> {
        let (full, matrix) = (code & 1 == 1, (code >> 1) & 3);
        let transfer = match code >> 3 {
            0 => return MATRICES.get(code as usize).map(Signal::Sdr),
            1 => hdr::Transfer::Pq,
            2 => hdr::Transfer::Hlg,
            _ => return None,
        };
        let matrix = match matrix {
            0 => hdr::Matrix::Bt709,
            1 => hdr::Matrix::Bt601,
            2 => hdr::Matrix::Bt2020,
            _ => return None,
        };
        Some(Signal::Hdr {
            matrix,
            full,
            transfer,
        })
    }
}

/// `to_rgba` or `hdr::planes_to_rgba`, as `signal` says; returns the HDR conversion's count of pixels above white
/// (0 for SDR).
#[allow(clippy::too_many_arguments)]
pub fn convert(
    src: &[u8],
    format: Format,
    planes: &[Plane],
    width: usize,
    height: usize,
    signal: Signal,
    out: &mut [u8],
) -> usize {
    match signal {
        Signal::Sdr(coeffs) => {
            to_rgba(src, format, planes, width, height, coeffs, out);
            0
        }
        Signal::Hdr {
            matrix,
            full,
            transfer,
        } => hdr::planes_to_rgba(
            src, format, planes, width, height, matrix, full, transfer, out,
        ),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Format {
    I420,
    I422,
    I444,
    Nv12,
}

impl Format {
    pub fn from_code(code: u32) -> Option<Format> {
        Some(match code {
            0 => Format::I420,
            1 => Format::I422,
            2 => Format::I444,
            3 => Format::Nv12,
            _ => return None,
        })
    }

    /// Per plane: (bytes per row, rows) for a `width × height` frame, as `VideoFrame.copyTo` lays them out.
    pub fn planes(self, width: usize, height: usize) -> Vec<(usize, usize)> {
        let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
        match self {
            Format::I420 => vec![(width, height), (cw, ch), (cw, ch)],
            Format::I422 => vec![(width, height), (cw, height), (cw, height)],
            Format::I444 => vec![(width, height); 3],
            Format::Nv12 => vec![(width, height), (cw * 2, ch)],
        }
    }
}

#[inline]
fn clamp(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

/// libyuv `YuvPixel`: `[r, g, b]`.
#[inline]
pub fn yuv_pixel(y: u8, u: u8, v: u8, c: &Coeffs) -> [u8; 3] {
    let y1 = ((y as u32 * 0x0101).wrapping_mul(c.yg) >> 16) as i32 + c.yb;
    let (ui, vi) = (u as i32 - 128, v as i32 - 128);
    [
        clamp((y1 + vi * c.vr) >> 6),
        clamp((y1 - (ui * c.ug + vi * c.vg)) >> 6),
        clamp((y1 + ui * c.ub) >> 6),
    ]
}

/// One plane of the source: byte offset of row 0 and bytes between rows.
#[derive(Clone, Copy)]
pub struct Plane {
    pub offset: usize,
    pub stride: usize,
}

/// Converts `src` (planes as described by `format` and `planes`) to tightly packed `width × height` RGBA in
/// `out`. The caller has checked that every plane lies inside `src` and `out` holds `width * height * 4` bytes.
pub fn to_rgba(
    src: &[u8],
    format: Format,
    planes: &[Plane],
    width: usize,
    height: usize,
    coeffs: &Coeffs,
    out: &mut [u8],
) {
    let chunks = crate::kernels::pool::chunks_for(width * height, 128 * 1024);
    let dst = SyncPtr(out.as_mut_ptr());
    let luma = luma_table(coeffs);
    crate::kernels::pool::par_for(chunks, |c| {
        for y in crate::kernels::pool::split(height, chunks, c)
            ..crate::kernels::pool::split(height, chunks, c + 1)
        {
            // SAFETY: output row `y` belongs to this chunk alone.
            let row =
                unsafe { std::slice::from_raw_parts_mut(dst.get().add(y * width * 4), width * 4) };
            convert_row(src, format, planes, width, y, coeffs, &luma, row);
        }
    });
}

/// `yuv_pixel`'s luma term for every Y value, so a pixel looks it up instead of multiplying.
fn luma_table(c: &Coeffs) -> [i32; 256] {
    std::array::from_fn(|y| ((y as u32 * 0x0101).wrapping_mul(c.yg) >> 16) as i32 + c.yb)
}

/// `yuv_pixel`'s chroma terms for one (U, V) sample, shared by the pixels it covers: (R, G, B).
#[inline]
fn chroma(u: u8, v: u8, c: &Coeffs) -> (i32, i32, i32) {
    let (ui, vi) = (u as i32 - 128, v as i32 - 128);
    (vi * c.vr, ui * c.ug + vi * c.vg, ui * c.ub)
}

/// `yuv_pixel` from its luma and chroma terms, as RGBA.
#[inline]
fn rgba(y1: i32, (r, g, b): (i32, i32, i32)) -> [u8; 4] {
    [
        clamp((y1 + r) >> 6),
        clamp((y1 - g) >> 6),
        clamp((y1 + b) >> 6),
        255,
    ]
}

/// One output row. Pixels sharing a chroma sample are converted together (one chroma computation per sample);
/// the arithmetic is `yuv_pixel`'s, so the bytes are the same.
#[allow(clippy::too_many_arguments)]
fn convert_row(
    src: &[u8],
    format: Format,
    p: &[Plane],
    width: usize,
    y: usize,
    c: &Coeffs,
    luma: &[i32; 256],
    row: &mut [u8],
) {
    let line = |i: usize, r: usize, len: usize| &src[p[i].offset + r * p[i].stride..][..len];
    let (cw, cy) = (width.div_ceil(2), y / 2);
    let ys = line(0, y, width);
    // Every pixel of `pair` (up to two RGBA pixels) from the luma values `yy` and one chroma sample.
    let put = |pair: &mut [u8], yy: &[u8], u: u8, v: u8| {
        let terms = chroma(u, v, c);
        for (px, &yv) in pair.chunks_exact_mut(4).zip(yy) {
            px.copy_from_slice(&rgba(luma[yv as usize], terms));
        }
    };
    match format {
        Format::I444 => {
            let (us, vs) = (line(1, y, width), line(2, y, width));
            for (((px, &yv), &u), &v) in row.chunks_exact_mut(4).zip(ys).zip(us).zip(vs) {
                px.copy_from_slice(&rgba(luma[yv as usize], chroma(u, v, c)));
            }
        }
        Format::I420 | Format::I422 => {
            let chroma_row = if format == Format::I422 { y } else { cy };
            let (us, vs) = (line(1, chroma_row, cw), line(2, chroma_row, cw));
            let done = simd::planar(ys, us, vs, c, row);
            let (row, ys, us, vs) = (
                &mut row[done * 4..],
                &ys[done..],
                &us[done / 2..],
                &vs[done / 2..],
            );
            for (((pair, yy), &u), &v) in row.chunks_mut(8).zip(ys.chunks(2)).zip(us).zip(vs) {
                put(pair, yy, u, v);
            }
        }
        Format::Nv12 => {
            let uv = line(1, cy, cw * 2);
            let done = simd::nv12(ys, uv, c, row);
            let (row, ys, uv) = (&mut row[done * 4..], &ys[done..], &uv[done..]);
            for ((pair, yy), uv) in row.chunks_mut(8).zip(ys.chunks(2)).zip(uv.chunks_exact(2)) {
                put(pair, yy, uv[0], uv[1]);
            }
        }
    }
}

/// Eight pixels at a time with WebAssembly SIMD for the 2:1 horizontally subsampled layouts: the same integer
/// arithmetic as `yuv_pixel` in 32-bit lanes (the luma product stays below 2^32, shifts are arithmetic like `>>`
/// on `i32`, and min/max clamp like `clamp`), so the bytes are the same. Each function converts the longest
/// prefix of whole groups of eight and returns its length in pixels; the caller converts the rest.
#[cfg(target_feature = "simd128")]
mod simd {
    use super::Coeffs;
    use std::arch::wasm32::*;

    struct Lanes {
        k: v128,
        yb: v128,
        vr: v128,
        ug: v128,
        vg: v128,
        ub: v128,
    }

    impl Lanes {
        fn new(c: &Coeffs) -> Self {
            Lanes {
                // (y * 0x0101) * yg == y * (0x0101 * yg), at most 255 * 257 * 18997 < 2^32.
                k: u32x4_splat(0x0101 * c.yg),
                yb: i32x4_splat(c.yb),
                vr: i32x4_splat(c.vr),
                ug: i32x4_splat(c.ug),
                vg: i32x4_splat(c.vg),
                ub: i32x4_splat(c.ub),
            }
        }
    }

    /// Four RGBA pixels from four Y values (u32 lanes) and their chroma terms (i32 lanes).
    #[inline]
    fn four(y: v128, r: v128, g: v128, b: v128, l: &Lanes) -> v128 {
        let y1 = i32x4_add(u32x4_shr(i32x4_mul(y, l.k), 16), l.yb);
        let byte =
            |t: v128| i32x4_min(i32x4_max(i32x4_shr(t, 6), i32x4_splat(0)), i32x4_splat(255));
        let (r, g, b) = (
            byte(i32x4_add(y1, r)),
            byte(i32x4_sub(y1, g)),
            byte(i32x4_add(y1, b)),
        );
        v128_or(
            v128_or(r, i32x4_shl(g, 8)),
            v128_or(i32x4_shl(b, 16), u32x4_splat(0xff00_0000)),
        )
    }

    /// Eight pixels from eight Y values at `ys` and four chroma samples `(u - 128, v - 128)`, written to `out`.
    ///
    /// # Safety
    /// `ys` must have 8 readable bytes and `out` 32 writable ones.
    #[inline]
    unsafe fn eight(ys: *const u8, ui: v128, vi: v128, l: &Lanes, out: *mut u8) {
        let y16 = u16x8_extend_low_u8x16(v128_load64_zero(ys as *const u64));
        let (lo, hi) = (u32x4_extend_low_u16x8(y16), u32x4_extend_high_u16x8(y16));
        let r = i32x4_mul(vi, l.vr);
        let g = i32x4_add(i32x4_mul(ui, l.ug), i32x4_mul(vi, l.vg));
        let b = i32x4_mul(ui, l.ub);
        let first = |t: v128| i32x4_shuffle::<0, 0, 1, 1>(t, t);
        let second = |t: v128| i32x4_shuffle::<2, 2, 3, 3>(t, t);
        v128_store(out as *mut v128, four(lo, first(r), first(g), first(b), l));
        v128_store(
            out.add(16) as *mut v128,
            four(hi, second(r), second(g), second(b), l),
        );
    }

    /// Four bytes at `p` as i32 lanes minus 128.
    #[inline]
    unsafe fn centred4(p: *const u8) -> v128 {
        let w = u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(p as *const u32)));
        i32x4_sub(w, i32x4_splat(128))
    }

    pub fn planar(ys: &[u8], us: &[u8], vs: &[u8], c: &Coeffs, row: &mut [u8]) -> usize {
        let (l, groups) = (
            Lanes::new(c),
            (ys.len() / 8).min(us.len() / 4).min(vs.len() / 4),
        );
        for k in 0..groups {
            // SAFETY: group k reads ys[8k..8k + 8], us/vs[4k..4k + 4] and writes row[32k..32k + 32], all in bounds by
            // `groups` (row holds 4 bytes per Y value).
            unsafe {
                let (ui, vi) = (
                    centred4(us.as_ptr().add(4 * k)),
                    centred4(vs.as_ptr().add(4 * k)),
                );
                eight(
                    ys.as_ptr().add(8 * k),
                    ui,
                    vi,
                    &l,
                    row.as_mut_ptr().add(32 * k),
                );
            }
        }
        groups * 8
    }

    pub fn nv12(ys: &[u8], uv: &[u8], c: &Coeffs, row: &mut [u8]) -> usize {
        let (l, groups) = (Lanes::new(c), (ys.len() / 8).min(uv.len() / 8));
        for k in 0..groups {
            // SAFETY: group k reads ys[8k..8k + 8], uv[8k..8k + 8] and writes row[32k..32k + 32], all in bounds by
            // `groups`.
            unsafe {
                let w =
                    u16x8_extend_low_u8x16(v128_load64_zero(uv.as_ptr().add(8 * k) as *const u64));
                let (lo, hi) = (u32x4_extend_low_u16x8(w), u32x4_extend_high_u16x8(w));
                let ui = i32x4_sub(i32x4_shuffle::<0, 2, 4, 6>(lo, hi), i32x4_splat(128));
                let vi = i32x4_sub(i32x4_shuffle::<1, 3, 5, 7>(lo, hi), i32x4_splat(128));
                eight(
                    ys.as_ptr().add(8 * k),
                    ui,
                    vi,
                    &l,
                    row.as_mut_ptr().add(32 * k),
                );
            }
        }
        groups * 8
    }
}

/// Without SIMD every pixel goes through the scalar loop.
#[cfg(not(target_feature = "simd128"))]
mod simd {
    use super::Coeffs;

    pub fn planar(_: &[u8], _: &[u8], _: &[u8], _: &Coeffs, _: &mut [u8]) -> usize {
        0
    }

    pub fn nv12(_: &[u8], _: &[u8], _: &Coeffs, _: &mut [u8]) -> usize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure cases for any faster row conversion: a different pixel anywhere against `yuv_pixel` applied
    // pixel by pixel; the last column of an odd width (its own chroma sample); I444 (no subsampling); NV12's
    // interleaved U/V; I422's full-height chroma; rows with a stride wider than the row; and values that clamp
    // at 0 and 255 under every matrix.
    fn reference(
        src: &[u8],
        format: Format,
        planes: &[Plane],
        w: usize,
        h: usize,
        c: &Coeffs,
    ) -> Vec<u8> {
        let mut out = vec![0u8; w * h * 4];
        let (cw, shift) = (w.div_ceil(2), usize::from(format != Format::I444));
        for y in 0..h {
            for x in 0..w {
                let cy = match format {
                    Format::I420 | Format::Nv12 => y / 2,
                    _ => y,
                };
                let at = |i: usize, r: usize, col: usize| {
                    src[planes[i].offset + r * planes[i].stride + col]
                };
                let (u, v) = match format {
                    Format::Nv12 => (at(1, cy, (x >> 1) * 2), at(1, cy, (x >> 1) * 2 + 1)),
                    _ => (at(1, cy, x >> shift), at(2, cy, x >> shift)),
                };
                let [r, g, b] = yuv_pixel(at(0, y, x), u, v, c);
                out[(y * w + x) * 4..][..4].copy_from_slice(&[r, g, b, 255]);
            }
        }
        let _ = cw;
        out
    }

    #[test]
    fn colour_codes_keep_the_sdr_matrices_and_name_every_hdr_signal() {
        for code in 0..4 {
            assert!(
                matches!(Signal::from_code(code), Some(Signal::Sdr(c)) if std::ptr::eq(c, &MATRICES[code as usize]))
            );
        }
        // SDR BT.2020, a fourth matrix, a fourth transfer: no code.
        for code in [4, 5, 6, 7, 14, 15, 22, 23, 24, 31] {
            assert!(Signal::from_code(code).is_none(), "{code}");
        }
        let hdr = |code| match Signal::from_code(code) {
            Some(Signal::Hdr {
                matrix,
                full,
                transfer,
            }) => (matrix, full, transfer),
            _ => panic!("{code}"),
        };
        use hdr::{Matrix, Transfer};
        assert_eq!(hdr(8), (Matrix::Bt709, false, Transfer::Pq));
        assert_eq!(hdr(13), (Matrix::Bt2020, true, Transfer::Pq));
        assert_eq!(hdr(19), (Matrix::Bt601, true, Transfer::Hlg));
        assert_eq!(hdr(20), (Matrix::Bt2020, false, Transfer::Hlg));
    }

    #[test]
    fn rows_match_the_per_pixel_reference_for_every_layout_and_matrix() {
        let mut seed = 0x9e37_79b9u32;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for format in [Format::I420, Format::I422, Format::I444, Format::Nv12] {
            for (w, h) in [(1, 1), (2, 2), (7, 5), (33, 9), (64, 3)] {
                // Planes with 3 bytes of padding per row, so a stride bug shows.
                let mut planes = Vec::new();
                let mut len = 0;
                for (row_bytes, rows) in format.planes(w, h) {
                    planes.push(Plane {
                        offset: len,
                        stride: row_bytes + 3,
                    });
                    len += (row_bytes + 3) * rows;
                }
                for fill in 0..3 {
                    let src: Vec<u8> = (0..len)
                        .map(|_| match fill {
                            0 => next() as u8,
                            1 => [0u8, 255][(next() & 1) as usize],
                            _ => [16u8, 235, 240, 0, 255][(next() % 5) as usize],
                        })
                        .collect();
                    for c in &MATRICES {
                        let mut out = vec![0u8; w * h * 4];
                        to_rgba(&src, format, &planes, w, h, c, &mut out);
                        assert!(
                            out == reference(&src, format, &planes, w, h, c),
                            "{w}x{h} fill {fill}"
                        );
                    }
                }
            }
        }
    }
}
