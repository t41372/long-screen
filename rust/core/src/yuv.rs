//! Decoded-frame layouts (planar and semi-planar YUV) to RGBA, for browsers whose
//! `VideoFrame.copyTo` cannot convert to RGB itself (Safari, through at least 27). The arithmetic is libyuv's C
//! reference (`row_common.cc`: `YuvPixel`, x86 form) with its `YuvConstants`, which is what Chrome's own
//! `copyTo({ format: 'RGBA' })` runs on a software-decoded frame; chroma is point-sampled like libyuv's
//! `I4xxToARGBRow_C`. Rows are split across the pool; every output byte depends only on its own inputs.

use crate::pool::SyncPtr;

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
pub const MATRICES: [Coeffs; 4] = [
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
    let chunks = crate::pool::chunks_for(width * height, 128 * 1024);
    let dst = SyncPtr(out.as_mut_ptr());
    crate::pool::par_for(chunks, |c| {
        for y in crate::pool::split(height, chunks, c)..crate::pool::split(height, chunks, c + 1) {
            // SAFETY: output row `y` belongs to this chunk alone.
            let row =
                unsafe { std::slice::from_raw_parts_mut(dst.get().add(y * width * 4), width * 4) };
            convert_row(src, format, planes, width, y, coeffs, row);
        }
    });
}

fn convert_row(
    src: &[u8],
    format: Format,
    p: &[Plane],
    width: usize,
    y: usize,
    c: &Coeffs,
    row: &mut [u8],
) {
    let line = |i: usize, r: usize, len: usize| &src[p[i].offset + r * p[i].stride..][..len];
    let (cw, cy) = (width.div_ceil(2), y / 2);
    match format {
        Format::I420 | Format::I422 | Format::I444 => {
            let (chroma_row, chroma_w) = match format {
                Format::I444 => (y, width),
                Format::I422 => (y, cw),
                _ => (cy, cw),
            };
            let (ys, us, vs) = (
                line(0, y, width),
                line(1, chroma_row, chroma_w),
                line(2, chroma_row, chroma_w),
            );
            let shift = usize::from(format != Format::I444);
            for (x, px) in row.chunks_exact_mut(4).enumerate() {
                let [r, g, b] = yuv_pixel(ys[x], us[x >> shift], vs[x >> shift], c);
                px.copy_from_slice(&[r, g, b, 255]);
            }
        }
        Format::Nv12 => {
            let (ys, uv) = (line(0, y, width), line(1, cy, cw * 2));
            for (x, px) in row.chunks_exact_mut(4).enumerate() {
                let [r, g, b] = yuv_pixel(ys[x], uv[(x >> 1) * 2], uv[(x >> 1) * 2 + 1], c);
                px.copy_from_slice(&[r, g, b, 255]);
            }
        }
    }
}
