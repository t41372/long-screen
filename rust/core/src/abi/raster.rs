//! Pixel-format conversion and simple per-pixel raster kernels: grayscale, downscale, halving, fixed-region
//! change tracking, mean difference, and decoded-video-frame-to-RGBA conversion.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::Reader;
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::raster::{
    downscale_gray, downscaled_size, fixed_update, grayscale, halve_rgba, mean_difference,
};
use crate::yuv::{Format as FrameFormat, Plane, MATRICES};

#[no_mangle]
pub extern "C" fn ls_grayscale(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    let n = width as usize * height as usize;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, n * 4) }, unsafe { slice_mut(out, n) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    grayscale(src, dst);
    crate::abi::STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_downscale_gray(
    rgba: u32,
    width: u32,
    height: u32,
    factor: u32,
    out: u32,
) -> i32 {
    if width == 0 || height == 0 || factor == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (w, h, f) = (width as usize, height as usize, factor as usize);
    let (ow, oh) = downscaled_size(w, h, f);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, ow * oh)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    downscale_gray(src, w, h, f, dst);
    crate::abi::STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_halve_rgba(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (w, h) = (width as usize, height as usize);
    let (ow, oh) = ((w >> 1).max(1), (h >> 1).max(1));
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, ow * oh * 4)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    halve_rgba(src, w, h, dst);
    crate::abi::STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_mean_difference(a: u32, b: u32, len: u32) -> f64 {
    // SAFETY: adapter-owned buffers, bounds checked.
    match (unsafe { slice(a, len as usize) }, unsafe {
        slice(b, len as usize)
    }) {
        (Some(a), Some(b)) => mean_difference(a, b),
        _ => 255.0,
    }
}

/// Refreshes a fixed region's saved pixels (`rw × rh` RGBA from origin `(x0, y0)`) from `rgba`; returns 1 when a
/// region pixel changed, 0 when none did, or a negative status on a bad argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_fixed_update(
    saved: u32,
    rgba: u32,
    labels: u32,
    width: u32,
    height: u32,
    x0: i32,
    y0: i32,
    rw: u32,
    rh: u32,
    code: u32,
) -> i32 {
    let (w, h, rw, rh) = (width as usize, height as usize, rw as usize, rh as usize);
    // SAFETY: adapter-owned buffers, bounds checked; `saved` never aliases the frame or labels.
    let (Some(saved), Some(rgba), Some(labels)) = (
        unsafe { slice_mut(saved, rw * rh * 4) },
        unsafe { slice(rgba, w * h * 4) },
        unsafe { slice(labels, w * h) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    fixed_update(
        saved, rgba, labels, w, h, x0 as i64, y0 as i64, rw, rh, code as u8,
    ) as i32
}

/// Converts one decoded frame as laid out by `VideoFrame.copyTo` (`src`, `src_len` bytes; `planes` points at
/// four `(offset, stride)` u32 pairs, unused ones ignored) to `width × height` RGBA at `dst`. `format` and
/// `matrix` are the codes of `yuv::Format::from_code` and `yuv::MATRICES`. 0 on success, a negative status on a
/// bad argument or a plane outside `src`.
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
    let (Some(format), Some(coeffs)) = (
        FrameFormat::from_code(format),
        MATRICES.get(matrix as usize),
    ) else {
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
    crate::yuv::to_rgba(src, format, &layout, w, h, coeffs, out);
    0
}
