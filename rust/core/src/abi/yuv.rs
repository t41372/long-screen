//! Decoded-video-frame-to-RGBA conversion (mirrors `src/core/wasm/yuv.ts`).

use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::Reader;
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::yuv::{Format as FrameFormat, Plane, MATRICES};

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
