//! Simple per-pixel raster kernels: grayscale, downscale, halving, fixed-region change tracking, mean
//! difference. Decoded-video-frame-to-RGBA conversion lives in `abi/yuv.rs`.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::raster::{
    downscale_gray, downscaled_size, fixed_update, grayscale, halve_rgba, mean_difference,
};

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
