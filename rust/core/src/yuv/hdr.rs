//! HDR frames (PQ or HLG transfer, BT.2020 primaries) to SDR sRGB RGBA, for screen recordings that phones and Macs
//! with HDR displays write even when every pixel on screen was SDR. Browsers hand these frames back with the coded
//! signal untouched (WebKit's planes and canvas, WebGL with colour conversion off) or tone-mapped for display
//! (Chrome's canvas and `copyTo`), neither of which is the screen's pixels; this undoes the transfer from the coded
//! values. The mapping takes SDR white as the signal's reference white and clips what lies above it: 100 nits for PQ
//! (where Apple's screen recordings put it, measured on an iPhone and a Mac recording), 75 % signal for HLG
//! (ITU-R BT.2408). The coded R'G'B' goes through the transfer's EOTF to linear light, BT.2020 → BT.709 primaries,
//! and the sRGB curve.
//!
//! Two entry points: 8-bit planes as `VideoFrame.copyTo` writes them (`planes_to_rgba`, chroma point-sampled like
//! the SDR path), and R'G'B' already converted from YUV by the browser (`rgb_to_rgba`, 8-bit RGBA or 10-bit
//! RGB10A2). Both count the pixels brighter than `ABOVE_WHITE`, which a caller uses to tell a recording whose SDR
//! white sits higher than assumed (and so clips) from one with the odd highlight.

use super::{Format, Plane};
use crate::pool::SyncPtr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

/// The transfer of the coded signal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transfer {
    Pq,
    Hlg,
}

/// The YUV matrix of a frame's planes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Matrix {
    Bt709,
    Bt601,
    Bt2020,
}

/// How `rgb_to_rgba` receives R'G'B': four bytes per pixel, either RGBA8 or little-endian RGB10A2 (red in the low
/// ten bits, as WebGPU's `rgb10a2unorm` reads back).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Packing {
    Rgba8,
    Rgb10a2,
}

/// Linear light, relative to SDR white, above which a pixel counts as brighter than white: 150 nits under PQ.
pub const ABOVE_WHITE: f32 = 1.5;

/// Converts 8-bit planes coding an HDR signal to `width × height` sRGB RGBA in `out`; returns how many pixels lie
/// above `ABOVE_WHITE`. Same plane contract as `super::to_rgba`.
#[allow(clippy::too_many_arguments)]
pub fn planes_to_rgba(
    src: &[u8],
    format: Format,
    planes: &[Plane],
    width: usize,
    height: usize,
    matrix: Matrix,
    full: bool,
    transfer: Transfer,
    out: &mut [u8],
) -> usize {
    let (kr, kb) = match matrix {
        Matrix::Bt709 => (0.2126f32, 0.0722f32),
        Matrix::Bt601 => (0.299, 0.114),
        Matrix::Bt2020 => (0.2627, 0.0593),
    };
    let kg = 1.0 - kr - kb;
    // Y'CbCr bytes to coded R'G'B': (scale, offset) of luma and chroma for the range, then the matrix's terms.
    let (ys, yo, cs) = if full {
        (1.0 / 255.0, 0.0, 1.0 / 255.0)
    } else {
        (1.0 / 219.0, 16.0, 1.0 / 224.0)
    };
    let (rv, bu) = (2.0 * (1.0 - kr) * cs, 2.0 * (1.0 - kb) * cs);
    let (gu, gv) = (
        2.0 * kb * (1.0 - kb) / kg * cs,
        2.0 * kr * (1.0 - kr) / kg * cs,
    );
    let luma: [f32; 256] = std::array::from_fn(|y| (y as f32 - yo) * ys);
    let (eotf, oetf) = (eotf_table(transfer), srgb_table());
    // Neutral pixels (chroma exactly 128: R' = G' = B' = luma) are most of a screen recording, and depend on luma
    // alone, so they are converted once per value here by the same `pixel` and looked up below.
    let grey: [([u8; 4], bool); 256] = std::array::from_fn(|y| pixel([luma[y]; 3], eotf, oetf));
    let (shift, chroma_rows) = match format {
        Format::I444 => (0, 1),
        Format::I422 => (1, 1),
        Format::I420 | Format::Nv12 => (1, 2),
    };
    rows(width, height, out, |y, row| {
        let line =
            |i: usize, r: usize, len: usize| &src[planes[i].offset + r * planes[i].stride..][..len];
        let cw = if shift == 0 { width } else { width.div_ceil(2) };
        let cy = y / chroma_rows;
        let ls = line(0, y, width);
        let (us, vs, interleaved) = if format == Format::Nv12 {
            (line(1, cy, cw * 2), &[][..], true)
        } else {
            (line(1, cy, cw), line(2, cy, cw), false)
        };
        let mut above = 0;
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let c = x >> shift;
            let (u, v) = if interleaved {
                (us[c * 2], us[c * 2 + 1])
            } else {
                (us[c], vs[c])
            };
            let (p, bright) = if u == 128 && v == 128 {
                grey[ls[x] as usize]
            } else {
                let (yy, u, v) = (luma[ls[x] as usize], u as f32 - 128.0, v as f32 - 128.0);
                pixel([yy + rv * v, yy - gu * u - gv * v, yy + bu * u], eotf, oetf)
            };
            px.copy_from_slice(&p);
            above += bright as usize;
        }
        above
    })
}

/// Converts R'G'B' (the HDR signal after the YUV matrix, BT.2020 primaries) packed as `packing` to sRGB RGBA in
/// place; returns how many pixels lie above `ABOVE_WHITE`. `pixels` holds `width * height * 4` bytes.
pub fn rgb_to_rgba(
    pixels: &mut [u8],
    packing: Packing,
    width: usize,
    height: usize,
    transfer: Transfer,
) -> usize {
    let (eotf, oetf) = (eotf_table(transfer), srgb_table());
    // Neutral pixels (R' = G' = B') by code, converted once by the same `pixel` (see `planes_to_rgba`).
    let top = match packing {
        Packing::Rgba8 => 255,
        Packing::Rgb10a2 => 1023,
    };
    let grey: Vec<([u8; 4], bool)> = (0..=top)
        .map(|c| pixel([c as f32 / top as f32; 3], eotf, oetf))
        .collect();
    rows(width, height, pixels, |_, row| {
        let mut above = 0;
        for px in row.chunks_exact_mut(4) {
            let s = [px[0], px[1], px[2], px[3]];
            let codes = match packing {
                Packing::Rgba8 => [s[0], s[1], s[2]].map(u32::from),
                Packing::Rgb10a2 => {
                    let w = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
                    [w, w >> 10, w >> 20].map(|v| v & 1023)
                }
            };
            let (p, bright) = if codes[0] == codes[1] && codes[1] == codes[2] {
                grey[codes[0] as usize]
            } else {
                pixel(codes.map(|v| v as f32 / top as f32), eotf, oetf)
            };
            px.copy_from_slice(&p);
            above += bright as usize;
        }
        above
    })
}

/// Entries of the EOTF table over the coded value 0..=1 (read with linear interpolation: the nearest entry alone is a
/// few output levels off near black once the primaries matrix subtracts two bright channels), and of the sRGB table
/// over linear light 0..=1 (nearest entry, within a fifth of an output level of the exact curve).
const EOTF_SIZE: usize = 4096;
const SRGB_SIZE: usize = 16384;

/// BT.2020 → BT.709 primaries, linear light (ITU-R BT.2087's inverse).
const BT2020_TO_709: [[f32; 3]; 3] = [
    [1.660_491, -0.587_641, -0.072_850],
    [-0.124_550, 1.132_9, -0.008_349],
    [-0.018_151, -0.100_579, 1.118_73],
];

/// The transfer's EOTF sampled at `EOTF_SIZE` coded values, as linear light relative to SDR white.
fn eotf_table(transfer: Transfer) -> &'static [f32] {
    static PQ: OnceLock<Vec<f32>> = OnceLock::new();
    static HLG: OnceLock<Vec<f32>> = OnceLock::new();
    let (cell, f): (_, fn(f64) -> f64) = match transfer {
        Transfer::Pq => (&PQ, |e| pq_eotf(e) / PQ_WHITE),
        Transfer::Hlg => (&HLG, |e| hlg_inverse_oetf(e) / hlg_inverse_oetf(0.75)),
    };
    cell.get_or_init(|| {
        (0..EOTF_SIZE)
            .map(|i| f(i as f64 / (EOTF_SIZE - 1) as f64) as f32)
            .collect()
    })
}

/// The sRGB curve sampled at `SRGB_SIZE` linear values, as output bytes.
fn srgb_table() -> &'static [u8] {
    static SRGB: OnceLock<Vec<u8>> = OnceLock::new();
    SRGB.get_or_init(|| {
        (0..SRGB_SIZE)
            .map(|i| {
                let l = i as f64 / (SRGB_SIZE - 1) as f64;
                let v = if l <= 0.003_130_8 {
                    12.92 * l
                } else {
                    1.055 * l.powf(1.0 / 2.4) - 0.055
                };
                (v * 255.0).round() as u8
            })
            .collect()
    })
}

/// SDR white under PQ, in nits.
const PQ_WHITE: f64 = 100.0;

/// SMPTE ST 2084: coded value → nits.
fn pq_eotf(e: f64) -> f64 {
    let (m1, m2, c1, c2, c3) = (
        0.159_301_757_812_5,
        78.843_75,
        0.835_937_5,
        18.851_562_5,
        18.687_5,
    );
    let p = e.clamp(0.0, 1.0).powf(1.0 / m2);
    10000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1)
}

/// ARIB STD-B67 / BT.2100 HLG inverse OETF: coded value → scene light 0..=1.
fn hlg_inverse_oetf(e: f64) -> f64 {
    let (a, b) = (0.178_832_77f64, 1.0 - 4.0 * 0.178_832_77);
    let c = 0.5 - a * (4.0 * a).ln();
    let e = e.clamp(0.0, 1.0);
    if e <= 0.5 {
        e * e / 3.0
    } else {
        (((e - c) / a).exp() + b) / 12.0
    }
}

/// One pixel: coded R'G'B' → sRGB RGBA, and whether it lies above `ABOVE_WHITE`.
#[inline]
fn pixel(rgb: [f32; 3], eotf: &[f32], srgb: &[u8]) -> ([u8; 4], bool) {
    let lin = rgb.map(|v| {
        let at = v.clamp(0.0, 1.0) * (EOTF_SIZE - 1) as f32;
        let i = (at as usize).min(EOTF_SIZE - 2);
        eotf[i] + (at - i as f32) * (eotf[i + 1] - eotf[i])
    });
    let out = BT2020_TO_709.map(|m| {
        let l = m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2];
        srgb[(l.clamp(0.0, 1.0) * (SRGB_SIZE - 1) as f32 + 0.5) as usize]
    });
    (
        [out[0], out[1], out[2], 255],
        lin[0].max(lin[1]).max(lin[2]) > ABOVE_WHITE,
    )
}

/// Runs `row(y, out_row)` for every output row across the pool; returns the sum of what the rows return.
fn rows<F: Fn(usize, &mut [u8]) -> usize + Sync>(
    width: usize,
    height: usize,
    out: &mut [u8],
    row: F,
) -> usize {
    let chunks = crate::pool::chunks_for(width * height, 64 * 1024);
    let dst = SyncPtr(out.as_mut_ptr());
    let above = AtomicUsize::new(0);
    crate::pool::par_for(chunks, |c| {
        let mut count = 0;
        for y in crate::pool::split(height, chunks, c)..crate::pool::split(height, chunks, c + 1) {
            // SAFETY: output row `y` belongs to this chunk alone.
            let line =
                unsafe { std::slice::from_raw_parts_mut(dst.get().add(y * width * 4), width * 4) };
            count += row(y, line);
        }
        above.fetch_add(count, Ordering::Relaxed);
    });
    above.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure cases: SDR white not landing on 255 or black not on 0; a grey that does not come back as itself
    // (wrong curve, wrong white); a BT.709 colour carried in the BT.2020 container coming back as another colour
    // (missing or transposed primaries matrix); highlights above white wrapping instead of clipping, or not being
    // counted, or white itself being counted; limited and full range disagreeing; a plane layout read wrong (I420,
    // I422, I444, NV12, strides wider than the row, odd sizes, frames split across pool threads); HLG's reference
    // white not at 75 %; the planes and RGB entry points disagreeing on the same pixel; RGB10A2's channel order.
    // The expected bytes come from the formulas evaluated in f64 here, never from the module's tables.

    const KR_KB: [(f64, f64); 3] = [(0.2126, 0.0722), (0.299, 0.114), (0.2627, 0.0593)];
    const M709_TO_2020: [[f64; 3]; 3] = [
        [0.627_404, 0.329_282, 0.043_314],
        [0.069_097, 0.919_540, 0.011_361],
        [0.016_392, 0.088_013, 0.895_595],
    ];

    fn pq_oetf(nits: f64) -> f64 {
        let (m1, m2, c1, c2, c3) = (
            0.159_301_757_812_5,
            78.843_75,
            0.835_937_5,
            18.851_562_5,
            18.687_5,
        );
        let p = (nits.max(0.0) / 10000.0).powf(m1);
        ((c1 + c2 * p) / (1.0 + c3 * p)).powf(m2)
    }
    fn pq_eotf(e: f64) -> f64 {
        let (m1, m2, c1, c2, c3) = (
            0.159_301_757_812_5,
            78.843_75,
            0.835_937_5,
            18.851_562_5,
            18.687_5,
        );
        let p = e.clamp(0.0, 1.0).powf(1.0 / m2);
        10000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1)
    }
    const HLG_A: f64 = 0.178_832_77;
    const HLG_B: f64 = 1.0 - 4.0 * HLG_A;
    fn hlg_c() -> f64 {
        0.5 - HLG_A * (4.0 * HLG_A).ln()
    }
    fn hlg_oetf(e: f64) -> f64 {
        if e <= 1.0 / 12.0 {
            (3.0 * e).sqrt()
        } else {
            HLG_A * (12.0 * e - HLG_B).ln() + hlg_c()
        }
    }
    fn hlg_inverse(v: f64) -> f64 {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.5 {
            v * v / 3.0
        } else {
            (((v - hlg_c()) / HLG_A).exp() + HLG_B) / 12.0
        }
    }
    /// Scene light of HLG's reference white (75 % signal).
    fn hlg_white() -> f64 {
        hlg_inverse(0.75)
    }
    fn srgb_eotf(v: f64) -> f64 {
        if v <= 0.040_45 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    }
    fn srgb_oetf(l: f64) -> f64 {
        let l = l.clamp(0.0, 1.0);
        if l <= 0.003_130_8 {
            12.92 * l
        } else {
            1.055 * l.powf(1.0 / 2.4) - 0.055
        }
    }
    /// The coded value of linear light `l` (1.0 = SDR white).
    fn encode(l: f64, t: Transfer) -> f64 {
        match t {
            Transfer::Pq => pq_oetf(l * 100.0),
            Transfer::Hlg => hlg_oetf(l * hlg_white()),
        }
    }
    fn decode(e: f64, t: Transfer) -> f64 {
        match t {
            Transfer::Pq => pq_eotf(e) / 100.0,
            Transfer::Hlg => hlg_inverse(e) / hlg_white(),
        }
    }
    fn invert(m: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
        let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        let c = |r: usize, k: usize| {
            let (r0, r1) = ((r + 1) % 3, (r + 2) % 3);
            let (k0, k1) = ((k + 1) % 3, (k + 2) % 3);
            m[r0][k0] * m[r1][k1] - m[r0][k1] * m[r1][k0]
        };
        std::array::from_fn(|i| std::array::from_fn(|j| c(j, i) / det))
    }
    fn mul(m: [[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
    }
    /// The sRGB bytes the coded R'G'B' `rgb` should become.
    fn expected(rgb: [f64; 3], t: Transfer) -> [u8; 3] {
        let lin = rgb.map(|e| decode(e, t));
        mul(invert(M709_TO_2020), lin).map(|l| (srgb_oetf(l) * 255.0).round() as u8)
    }
    /// The coded R'G'B' of an sRGB colour.
    fn coded(srgb: [u8; 3], t: Transfer) -> [f64; 3] {
        let lin = srgb.map(|v| srgb_eotf(v as f64 / 255.0));
        mul(M709_TO_2020, lin).map(|l| encode(l, t))
    }
    /// Y'CbCr bytes of coded R'G'B'.
    fn ycbcr(rgb: [f64; 3], m: Matrix, full: bool) -> [u8; 3] {
        let (kr, kb) = KR_KB[m as usize];
        let y = kr * rgb[0] + (1.0 - kr - kb) * rgb[1] + kb * rgb[2];
        let (cb, cr) = (
            (rgb[2] - y) / (2.0 * (1.0 - kb)),
            (rgb[0] - y) / (2.0 * (1.0 - kr)),
        );
        let q = |v: f64| v.round().clamp(0.0, 255.0) as u8;
        if full {
            [q(y * 255.0), q(128.0 + cb * 255.0), q(128.0 + cr * 255.0)]
        } else {
            [
                q(16.0 + y * 219.0),
                q(128.0 + cb * 224.0),
                q(128.0 + cr * 224.0),
            ]
        }
    }
    /// The coded R'G'B' that Y'CbCr bytes stand for.
    fn rgb_of(yuv: [u8; 3], m: Matrix, full: bool) -> [f64; 3] {
        let (kr, kb) = KR_KB[m as usize];
        let (y, cb, cr) = if full {
            (
                yuv[0] as f64 / 255.0,
                (yuv[1] as f64 - 128.0) / 255.0,
                (yuv[2] as f64 - 128.0) / 255.0,
            )
        } else {
            (
                (yuv[0] as f64 - 16.0) / 219.0,
                (yuv[1] as f64 - 128.0) / 224.0,
                (yuv[2] as f64 - 128.0) / 224.0,
            )
        };
        let r = y + 2.0 * (1.0 - kr) * cr;
        let b = y + 2.0 * (1.0 - kb) * cb;
        let g = (y - kr * r - kb * b) / (1.0 - kr - kb);
        [r, g, b].map(|v| v.clamp(0.0, 1.0))
    }

    fn rgb8(pixels: &[[f64; 3]]) -> Vec<u8> {
        pixels
            .iter()
            .flat_map(|p| {
                [p[0], p[1], p[2], 1.0].map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
            })
            .collect()
    }
    fn rgb10(pixels: &[[f64; 3]]) -> Vec<u8> {
        pixels
            .iter()
            .flat_map(|p| {
                let q = p.map(|v| (v.clamp(0.0, 1.0) * 1023.0).round() as u32);
                (q[0] | q[1] << 10 | q[2] << 20 | 3 << 30).to_le_bytes()
            })
            .collect()
    }
    fn convert_rgb(src: &[u8], packing: Packing, t: Transfer) -> (Vec<u8>, usize) {
        let mut out = src.to_vec();
        let above = rgb_to_rgba(&mut out, packing, src.len() / 4, 1, t);
        (out, above)
    }
    fn near(actual: &[u8], expected: [u8; 3], tolerance: i32, what: &str) {
        for c in 0..3 {
            assert!(
                (actual[c] as i32 - expected[c] as i32).abs() <= tolerance,
                "{what}: got {:?}, expected {expected:?}",
                &actual[..4]
            );
        }
        assert_eq!(actual[3], 255, "{what}: alpha");
    }

    #[test]
    fn sdr_white_is_255_and_black_is_0() {
        for t in [Transfer::Pq, Transfer::Hlg] {
            let white = [encode(1.0, t); 3];
            for packing in [Packing::Rgba8, Packing::Rgb10a2] {
                let src = if packing == Packing::Rgba8 {
                    rgb8(&[white, [0.0; 3]])
                } else {
                    rgb10(&[white, [0.0; 3]])
                };
                let (out, above) = convert_rgb(&src, packing, t);
                // 8-bit PQ puts white between two codes (129.6); either neighbour is within two levels of 255.
                near(
                    &out[..4],
                    [255; 3],
                    if packing == Packing::Rgba8 { 2 } else { 0 },
                    &format!("{t:?} {packing:?} white"),
                );
                near(&out[4..], [0; 3], 0, &format!("{t:?} {packing:?} black"));
                assert_eq!(
                    above, 0,
                    "{t:?} {packing:?}: white and black are not above white"
                );
            }
        }
    }

    #[test]
    fn grey_levels_come_back_as_themselves() {
        for t in [Transfer::Pq, Transfer::Hlg] {
            let greys: Vec<[f64; 3]> = (0..=255u8).map(|v| coded([v; 3], t)).collect();
            let (out, _) = convert_rgb(&rgb10(&greys), Packing::Rgb10a2, t);
            for v in 0..=255u8 {
                near(
                    &out[v as usize * 4..],
                    [v; 3],
                    1,
                    &format!("{t:?} grey {v} (10-bit)"),
                );
            }
            // From 8-bit codes, each code must become what that exact code stands for.
            let codes: Vec<[f64; 3]> = (0..=255u8).map(|c| [c as f64 / 255.0; 3]).collect();
            let (out, _) = convert_rgb(&rgb8(&codes), Packing::Rgba8, t);
            for (c, rgb) in codes.iter().enumerate() {
                near(
                    &out[c * 4..],
                    expected(*rgb, t),
                    1,
                    &format!("{t:?} code {c} (8-bit)"),
                );
            }
        }
    }

    #[test]
    fn bt709_colours_in_the_bt2020_container_come_back() {
        let colours = [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [0, 255, 255],
            [255, 0, 255],
            [255, 255, 0],
            [229, 115, 115],
            [30, 144, 255],
            [12, 160, 50],
        ];
        for t in [Transfer::Pq, Transfer::Hlg] {
            let coded: Vec<[f64; 3]> = colours.iter().map(|&c| coded(c, t)).collect();
            let (out, _) = convert_rgb(&rgb10(&coded), Packing::Rgb10a2, t);
            for (i, &c) in colours.iter().enumerate() {
                // Exactly what the 10-bit input stands for; and the colour itself, up to what quantising its coded
                // values to 10 bits moves a channel near black (steep sRGB toe, amplified by the primaries matrix).
                let quantised = coded[i].map(|v| (v * 1023.0).round() / 1023.0);
                near(
                    &out[i * 4..],
                    expected(quantised, t),
                    1,
                    &format!("{t:?} {c:?} exact"),
                );
                near(&out[i * 4..], c, 16, &format!("{t:?} {c:?} round trip"));
            }
        }
    }

    #[test]
    fn highlights_clip_to_white_and_are_counted() {
        for t in [Transfer::Pq, Transfer::Hlg] {
            let levels = [1.0, 1.4, 1.6, 3.0, 10.0];
            let pixels: Vec<[f64; 3]> = levels.iter().map(|&l| [encode(l, t); 3]).collect();
            let (out, above) = convert_rgb(&rgb10(&pixels), Packing::Rgb10a2, t);
            for i in 0..levels.len() {
                near(&out[i * 4..], [255; 3], 0, &format!("{t:?} {}", levels[i]));
            }
            // HLG's signal tops out at about 3.8 × its reference white, so 10 is coded as the 3.8 ceiling: still above.
            assert_eq!(above, 3, "{t:?}: 1.6, 3 and 10 are above {ABOVE_WHITE}");
        }
    }

    #[test]
    fn rgb10a2_reads_red_from_the_low_bits() {
        let t = Transfer::Pq;
        let red = coded([255, 0, 0], t);
        let (out, _) = convert_rgb(&rgb10(&[red]), Packing::Rgb10a2, t);
        near(&out, [255, 0, 0], 2, "red");
    }

    /// Planes of `format` for a `w × h` frame of `pixels` (row-major Y'CbCr per pixel; chroma taken from the
    /// top-left pixel of each chroma sample's block, which is what point sampling reads back), with `pad` spare
    /// bytes per row.
    fn planes_of(
        format: Format,
        w: usize,
        h: usize,
        yuv: &[[u8; 3]],
        pad: usize,
    ) -> (Vec<u8>, Vec<Plane>) {
        let (sx, sy) = match format {
            Format::I444 => (1, 1),
            Format::I422 => (2, 1),
            Format::I420 | Format::Nv12 => (2, 2),
        };
        let mut layout = Vec::new();
        let mut len = 0;
        for (row_bytes, rows) in format.planes(w, h) {
            layout.push(Plane {
                offset: len,
                stride: row_bytes + pad,
            });
            len += (row_bytes + pad) * rows;
        }
        let mut src = vec![7u8; len];
        for y in 0..h {
            for x in 0..w {
                src[layout[0].offset + y * layout[0].stride + x] = yuv[y * w + x][0];
            }
        }
        for cy in 0..h.div_ceil(sy) {
            for cx in 0..w.div_ceil(sx) {
                let p = yuv[cy * sy * w + cx * sx];
                if format == Format::Nv12 {
                    let at = layout[1].offset + cy * layout[1].stride + cx * 2;
                    src[at] = p[1];
                    src[at + 1] = p[2];
                } else {
                    src[layout[1].offset + cy * layout[1].stride + cx] = p[1];
                    src[layout[2].offset + cy * layout[2].stride + cx] = p[2];
                }
            }
        }
        (src, layout)
    }

    #[test]
    fn every_layout_matrix_and_range_matches_the_formulas() {
        let mut seed = 0x2545_f491u32;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for format in [Format::I420, Format::I422, Format::I444, Format::Nv12] {
            for (w, h) in [(1, 1), (3, 2), (7, 5), (33, 9), (640, 120)] {
                for t in [Transfer::Pq, Transfer::Hlg] {
                    for (mi, m) in [Matrix::Bt709, Matrix::Bt601, Matrix::Bt2020]
                        .into_iter()
                        .enumerate()
                    {
                        for full in [false, true] {
                            // Chroma is constant over each sample's block, so point sampling has one right answer.
                            let colours: Vec<[u8; 3]> = (0..w * h)
                                .map(|_| [next() as u8, next() as u8, next() as u8])
                                .collect();
                            let mut yuv: Vec<[u8; 3]> = colours
                                .iter()
                                .map(|&c| ycbcr(coded(c, t), m, full))
                                .collect();
                            let (sx, sy) = match format {
                                Format::I444 => (1, 1),
                                Format::I422 => (2, 1),
                                _ => (2, 2),
                            };
                            for y in 0..h {
                                for x in 0..w {
                                    let anchor = yuv[(y / sy * sy) * w + x / sx * sx];
                                    yuv[y * w + x][1] = anchor[1];
                                    yuv[y * w + x][2] = anchor[2];
                                }
                            }
                            let (src, layout) = planes_of(format, w, h, &yuv, 3);
                            let mut out = vec![0u8; w * h * 4];
                            planes_to_rgba(&src, format, &layout, w, h, m, full, t, &mut out);
                            for (i, p) in yuv.iter().enumerate() {
                                near(
                                    &out[i * 4..],
                                    expected(rgb_of(*p, m, full), t),
                                    1,
                                    &format!("{w}x{h} matrix {mi} full {full} {t:?} pixel {i}"),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // Neutral pixels (chroma exactly 128, or R' = G' = B') take a table lookup instead of the arithmetic, which most
    // of a screen recording is: every luma value or code in both ranges and transfers must still come out as the
    // formulas say, and a neighbour one chroma step away (the arithmetic) must not be mistaken for neutral.
    #[test]
    fn neutral_pixels_match_the_formulas_whichever_path_converts_them() {
        for t in [Transfer::Pq, Transfer::Hlg] {
            for full in [false, true] {
                let yuv: Vec<[u8; 3]> = (0..=255u8)
                    .flat_map(|y| [[y, 128, 128], [y, 129, 128], [y, 128, 127]])
                    .collect();
                let (src, layout) = planes_of(Format::I444, yuv.len(), 1, &yuv, 0);
                let mut out = vec![0u8; yuv.len() * 4];
                planes_to_rgba(
                    &src,
                    Format::I444,
                    &layout,
                    yuv.len(),
                    1,
                    Matrix::Bt2020,
                    full,
                    t,
                    &mut out,
                );
                for (i, p) in yuv.iter().enumerate() {
                    near(
                        &out[i * 4..],
                        expected(rgb_of(*p, Matrix::Bt2020, full), t),
                        1,
                        &format!("{t:?} full {full} {p:?}"),
                    );
                }
            }
            for packing in [Packing::Rgba8, Packing::Rgb10a2] {
                let top = if packing == Packing::Rgba8 {
                    255.0
                } else {
                    1023.0
                };
                let codes: Vec<[f64; 3]> = (0..=top as u32)
                    .flat_map(|c| {
                        let v = c as f64 / top;
                        [[v; 3], [v, v, (v + 1.0 / top).min(1.0)]]
                    })
                    .collect();
                let src = if packing == Packing::Rgba8 {
                    rgb8(&codes)
                } else {
                    rgb10(&codes)
                };
                let (out, _) = convert_rgb(&src, packing, t);
                for (i, c) in codes.iter().enumerate() {
                    near(
                        &out[i * 4..],
                        expected(*c, t),
                        1,
                        &format!("{t:?} {packing:?} {c:?}"),
                    );
                }
            }
        }
    }

    #[test]
    fn limited_and_full_range_planes_give_the_same_picture() {
        let t = Transfer::Pq;
        // Greys: chroma sits exactly on 128 in both ranges, so the two pictures differ only by luma quantisation, which
        // for 8-bit PQ is coarse: one limited-range step is about 4 % luminance, three output levels at mid grey.
        let colours: Vec<[u8; 3]> = (0..=255u8).step_by(5).map(|v| [v, v, v]).collect();
        let picture = |full: bool| {
            let yuv: Vec<[u8; 3]> = colours
                .iter()
                .map(|&c| ycbcr(coded(c, t), Matrix::Bt2020, full))
                .collect();
            let (src, layout) = planes_of(Format::I444, yuv.len(), 1, &yuv, 0);
            let mut out = vec![0u8; yuv.len() * 4];
            planes_to_rgba(
                &src,
                Format::I444,
                &layout,
                yuv.len(),
                1,
                Matrix::Bt2020,
                full,
                t,
                &mut out,
            );
            out
        };
        let (limited, full) = (picture(false), picture(true));
        for i in 0..colours.len() {
            near(
                &limited[i * 4..],
                [full[i * 4], full[i * 4 + 1], full[i * 4 + 2]],
                4,
                &format!("grey {:?}", colours[i]),
            );
            near(
                &full[i * 4..],
                colours[i],
                2,
                &format!("full-range round trip {:?}", colours[i]),
            );
        }
    }

    #[test]
    fn planes_and_rgb_entry_points_both_match_the_formulas_on_one_picture() {
        let t = Transfer::Pq;
        let yuv: Vec<[u8; 3]> = (0..=255u8)
            .step_by(3)
            .map(|v| [v, 255 - v, v / 2 + 64])
            .collect();
        let (src, layout) = planes_of(Format::I444, yuv.len(), 1, &yuv, 0);
        let mut from_planes = vec![0u8; yuv.len() * 4];
        planes_to_rgba(
            &src,
            Format::I444,
            &layout,
            yuv.len(),
            1,
            Matrix::Bt2020,
            true,
            t,
            &mut from_planes,
        );
        let rgb: Vec<[f64; 3]> = yuv
            .iter()
            .map(|&p| rgb_of(p, Matrix::Bt2020, true))
            .collect();
        let (from_rgb, _) = convert_rgb(&rgb10(&rgb), Packing::Rgb10a2, t);
        for (i, coded) in rgb.iter().enumerate() {
            let quantised = coded.map(|v| (v * 1023.0).round() / 1023.0);
            near(
                &from_planes[i * 4..],
                expected(*coded, t),
                1,
                &format!("planes {:?}", yuv[i]),
            );
            near(
                &from_rgb[i * 4..],
                expected(quantised, t),
                1,
                &format!("rgb {:?}", yuv[i]),
            );
        }
    }

    #[test]
    fn a_frame_split_across_threads_counts_every_pixel_above_white_once() {
        let (w, h) = (1024, 300);
        let bright = [encode(4.0, Transfer::Pq); 3];
        let pixels: Vec<[f64; 3]> = (0..w * h)
            .map(|i| if i % 7 == 0 { bright } else { [0.4; 3] })
            .collect();
        let mut out = rgb10(&pixels);
        let above = rgb_to_rgba(&mut out, Packing::Rgb10a2, w, h, Transfer::Pq);
        assert_eq!(above, (0..w * h).filter(|i| i % 7 == 0).count());
        assert!(out
            .chunks_exact(4)
            .enumerate()
            .all(|(i, p)| p[0] == if i % 7 == 0 { 255 } else { out[4] }));
    }
}
