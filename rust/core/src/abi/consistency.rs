//! World-consistency masking: compares a region against its neighbours' and the voting ring's opinion of the
//! same pixels.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::{read_rects, Reader};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::consistency::{consistency_mask, MaskInput, Neighbour, Vote};
use crate::geometry::Rect;

/// Vote descriptor: 4 × i32 (x0, y0, w, h) followed by three u32 pointers (bits, clean, optional screen) and padding.
/// # Safety
/// `ptr` is zero (no vote) or points at 32 readable bytes whose bit pointers cover `ceil(w*h/8)` bytes.
unsafe fn read_vote<'a>(ptr: u32) -> Result<Option<Vote<'a>>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    let d = slice(ptr, 32).ok_or(STATUS_BAD_ARGUMENT)?;
    let r = Reader(d);
    let (x0, y0, w, h) = (r.i32(0), r.i32(4), r.i32(8), r.i32(12));
    if w <= 0 || h <= 0 {
        return Err(STATUS_BAD_ARGUMENT);
    }
    let bytes = ((w as usize) * (h as usize)).div_ceil(8);
    let bits = slice(r.u32(16), bytes).ok_or(STATUS_BAD_ARGUMENT)?;
    let clean = slice(r.u32(20), bytes).ok_or(STATUS_BAD_ARGUMENT)?;
    Ok(Some(Vote {
        x0,
        y0,
        w,
        h,
        bits,
        clean,
        screen: if r.u32(24) == 0 {
            &[]
        } else {
            slice(r.u32(24), bytes).ok_or(STATUS_BAD_ARGUMENT)?
        },
    }))
}

/// Decoded neighbour descriptor; owns its occlusion rects so the kernel can borrow them.
struct NeighbourData<'a> {
    rgba: &'a [u8],
    pose_x: f64,
    pose_y: f64,
    occlusions: Vec<Rect>,
    vote: Option<Vote<'a>>,
}

impl NeighbourData<'_> {
    fn borrow(&self) -> Neighbour<'_> {
        Neighbour {
            rgba: self.rgba,
            pose_x: self.pose_x,
            pose_y: self.pose_y,
            occlusions: &self.occlusions,
            vote: self.vote.as_ref().map(|v| Vote {
                x0: v.x0,
                y0: v.y0,
                w: v.w,
                h: v.h,
                bits: v.bits,
                clean: v.clean,
                screen: v.screen,
            }),
        }
    }
}

/// Neighbour descriptor (48 bytes): u32 rgba, f64 pose_x, f64 pose_y, u32 occlusions ptr, u32 occlusion count,
/// u32 vote descriptor ptr, 12 bytes padding. Absent neighbours pass a zero pointer.
/// # Safety
/// Pointer validity is checked; `pixels` is the frame pixel count the rgba pointer must cover.
unsafe fn read_neighbour<'a>(ptr: u32, pixels: usize) -> Result<Option<NeighbourData<'a>>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    let d = slice(ptr, 48).ok_or(STATUS_BAD_ARGUMENT)?;
    let r = Reader(d);
    let rgba = slice(r.u32(0), pixels * 4).ok_or(STATUS_BAD_ARGUMENT)?;
    let count = r.u32(28) as usize;
    let occlusion_bytes = if count == 0 {
        &[][..]
    } else {
        slice(r.u32(24), count * 32).ok_or(STATUS_BAD_ARGUMENT)?
    };
    Ok(Some(NeighbourData {
        rgba,
        pose_x: r.f64(8),
        pose_y: r.f64(16),
        occlusions: read_rects(occlusion_bytes),
        vote: read_vote(r.u32(32))?,
    }))
}

/// World-consistency mask. `region` points at one 32-byte rect; `prev`/`next` at neighbour descriptors
/// (or zero); `vote` at a vote descriptor (or zero). `out` receives width×height bytes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_consistency_mask(
    rgba: u32,
    labels: u32,
    width: u32,
    height: u32,
    region: u32,
    code: u32,
    pose_x: f64,
    pose_y: f64,
    prev: u32,
    next: u32,
    vote: u32,
    factor: u32,
    noise: f64,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    let pixels = w * h;
    if pixels == 0 || factor == 0 || w > i32::MAX as usize / 4 || h > i32::MAX as usize / 4 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(rgba), Some(labels), Some(region_bytes), Some(out)) = (
        unsafe { slice(rgba, pixels * 4) },
        unsafe { slice(labels, pixels) },
        unsafe { slice(region, 32) },
        unsafe { slice_mut(out, pixels) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let region = read_rects(region_bytes)[0];
    // SAFETY: descriptors validated field by field.
    let (prev, next, vote) = match unsafe {
        (
            read_neighbour(prev, pixels),
            read_neighbour(next, pixels),
            read_vote(vote),
        )
    } {
        (Ok(p), Ok(n), Ok(v)) => (p, n, v),
        _ => return STATUS_BAD_ARGUMENT,
    };
    let input = MaskInput {
        rgba,
        labels,
        width: w,
        height: h,
        region,
        code: code as u8,
        pose_x,
        pose_y,
        prev: prev.as_ref().map(NeighbourData::borrow),
        next: next.as_ref().map(NeighbourData::borrow),
        vote,
        factor: factor as i32,
        noise,
    };
    consistency_mask(&input, out);
    crate::abi::STATUS_OK
}
