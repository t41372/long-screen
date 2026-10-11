//! Simple per-pixel raster kernels: grayscale, downscale, halving, fixed-region change tracking, mean
//! difference. Decoded-video-frame-to-RGBA conversion lives in `abi/yuv.rs`.

use crate::memory::{slice, slice_mut};
use crate::STATUS_BAD_ARGUMENT;
use long_screen::kernels::raster::{
    downscale_gray, downscaled_size, grayscale, halve_rgba, mean_difference,
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
    crate::STATUS_OK
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
    crate::STATUS_OK
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
    crate::STATUS_OK
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
