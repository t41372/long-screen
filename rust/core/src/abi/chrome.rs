//! Persistent-chrome detection: stationary boundaries and sticky occlusion bands.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::{read_rect, read_rects};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::chrome::{stationary_boundary, sticky_occlusions, Axis, Choose};

/// Persistent appearance edge in `rgba` (width×height) along `axis` (0 = x, 1 = y) between `from` and `to`,
/// sampling cross coordinates `cross_from..cross_to`; `choose` 0 = first, 1 = last. Returns the coordinate
/// (≥ 1), −1 when none, or −2 on a bad argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_stationary_boundary(
    rgba: u32,
    width: u32,
    height: u32,
    axis: u32,
    from: f64,
    to: f64,
    cross_from: f64,
    cross_to: f64,
    choose: u32,
) -> f64 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return -2.0;
    }
    // SAFETY: adapter-owned frame, bounds checked.
    let Some(rgba) = (unsafe { slice(rgba, w * h * 4) }) else {
        return -2.0;
    };
    let axis = if axis == 0 { Axis::X } else { Axis::Y };
    let choose = if choose == 0 {
        Choose::First
    } else {
        Choose::Last
    };
    stationary_boundary(rgba, w, h, axis, from, to, cross_from, cross_to, choose).unwrap_or(-1.0)
}

/// Sticky bands for one observation. `region` is one 32-byte rect (the region's crop or rect), `carry` holds
/// `carry_count` previous bands, `out` has room for `max(carry_count, 1)` rects. Returns the band count.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_sticky_occlusions(
    previous: u32,
    current: u32,
    width: u32,
    height: u32,
    region: u32,
    motion_x: f64,
    motion_y: f64,
    carry: u32,
    carry_count: u32,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let capacity = (carry_count as usize).max(1);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(previous), Some(current), Some(region), Some(carry), Some(dst)) = (
        unsafe { slice(previous, w * h * 4) },
        unsafe { slice(current, w * h * 4) },
        unsafe { slice(region, 32) },
        unsafe { slice(carry, carry_count as usize * 32) },
        unsafe { slice_mut(out, capacity * 32) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let bands = sticky_occlusions(
        previous,
        current,
        w,
        h,
        read_rect(region),
        motion_x,
        motion_y,
        &read_rects(carry),
    );
    for (b, d) in bands.iter().zip(dst.chunks_exact_mut(32)) {
        d[0..8].copy_from_slice(&b.x.to_le_bytes());
        d[8..16].copy_from_slice(&b.y.to_le_bytes());
        d[16..24].copy_from_slice(&b.width.to_le_bytes());
        d[24..32].copy_from_slice(&b.height.to_le_bytes());
    }
    bands.len() as i32
}
