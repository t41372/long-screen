//! PNG scanline (un)filtering for the RGBA export path.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::png::{filter_sub_rgba, unfilter_to_rgba};

/// PNG scanline reconstruction to RGBA. Returns 0, STATUS_BAD_ARGUMENT, or STATUS_BAD_FILTER − filter byte.
#[no_mangle]
pub extern "C" fn ls_png_unfilter(
    raw: u32,
    width: u32,
    height: u32,
    channels: u32,
    out: u32,
) -> i32 {
    let (w, h, c) = (width as usize, height as usize, channels as usize);
    if w == 0 || h == 0 || !(1..=4).contains(&c) {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(raw, (w * c + 1) * h) }, unsafe {
        slice_mut(out, w * h * 4)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    // A bad filter byte is reported as -(256 + byte) so the adapter can name the offending value.
    match unfilter_to_rgba(src, w, h, c, dst) {
        Ok(()) => crate::abi::STATUS_OK,
        Err(filter) => crate::abi::STATUS_BAD_FILTER - filter as i32,
    }
}

/// Sub-filters RGBA rows for PNG encoding; `out` receives `height × (width×4 + 1)` bytes.
#[no_mangle]
pub extern "C" fn ls_png_filter_sub(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, (w * 4 + 1) * h)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    filter_sub_rgba(src, w, h, dst);
    crate::abi::STATUS_OK
}
