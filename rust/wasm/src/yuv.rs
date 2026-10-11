//! Decoded-video-frame-to-RGBA conversion (mirrors `src/core/wasm/yuv.ts`).

use crate::memory::{slice, slice_mut};
use crate::wire::Reader;
use crate::STATUS_BAD_ARGUMENT;
use long_screen::kernels::yuv::hdr::{self, Packing, Transfer};
use long_screen::kernels::yuv::{Format as FrameFormat, Plane, Signal};

/// Converts one decoded frame as laid out by `VideoFrame.copyTo` (`src`, `src_len` bytes; `planes` points at
/// four `(offset, stride)` u32 pairs, unused ones ignored) to `width × height` RGBA at `dst`. `format` and
/// `matrix` are the codes of `yuv::Format::from_code` and `yuv::Signal::from_code`. On success the number of
/// pixels above white (`yuv::hdr::ABOVE_WHITE`; always 0 for SDR), a negative status on a bad argument or a plane
/// outside `src`.
#[no_mangle]
pub extern "C" fn ls_frame_to_rgba(
    src: u32,
    src_len: u32,
    format: u32,
    width: u32,
    height: u32,
    planes: u32,
    matrix: u32,
    dst: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    let (Some(format), Some(signal)) = (FrameFormat::from_code(format), Signal::from_code(matrix))
    else {
        return STATUS_BAD_ARGUMENT;
    };
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked; `dst` never aliases the source or the plane table.
    let (Some(src), Some(table), Some(out)) = (
        unsafe { slice(src, src_len as usize) },
        unsafe { slice(planes, 32) },
        unsafe { slice_mut(dst, w * h * 4) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let table = Reader(table);
    let word = |i: usize| table.u32(i * 4) as usize;
    let mut layout = [Plane {
        offset: 0,
        stride: 0,
    }; 4];
    for (i, (row_bytes, rows)) in format.planes(w, h).into_iter().enumerate() {
        let plane = Plane {
            offset: word(i * 2),
            stride: word(i * 2 + 1),
        };
        let end = plane
            .stride
            .checked_mul(rows - 1)
            .and_then(|v| v.checked_add(plane.offset + row_bytes));
        if plane.stride < row_bytes || end.is_none_or(|end| end > src.len()) {
            return STATUS_BAD_ARGUMENT;
        }
        layout[i] = plane;
    }
    long_screen::kernels::yuv::convert(src, format, &layout, w, h, signal, out)
        .min(i32::MAX as usize) as i32
}

/// Converts `width × height` R'G'B' at `pixels` (4 bytes per pixel, `packing` 0 RGBA8 or 1 RGB10A2; an HDR signal
/// with BT.2020 primaries, `transfer` 1 PQ or 2 HLG as in `yuv::Signal`) to sRGB RGBA in place. On success the number
/// of pixels above white, a negative status on a bad argument.
#[no_mangle]
pub extern "C" fn ls_hdr_rgb_to_rgba(
    pixels: u32,
    packing: u32,
    width: u32,
    height: u32,
    transfer: u32,
) -> i32 {
    let len = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    let packing = match packing {
        0 => Packing::Rgba8,
        1 => Packing::Rgb10a2,
        _ => return STATUS_BAD_ARGUMENT,
    };
    let transfer = match transfer {
        1 => Transfer::Pq,
        2 => Transfer::Hlg,
        _ => return STATUS_BAD_ARGUMENT,
    };
    if len == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: an adapter-owned buffer, bounds checked.
    let Some(buf) = (unsafe { slice_mut(pixels, len) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    hdr::rgb_to_rgba(buf, packing, width as usize, height as usize, transfer).min(i32::MAX as usize)
        as i32
}
