//! ABI surface for pyramid parent-tile assembly (mirrors `src/core/wasm/pyramid.ts`).

use crate::abi::memory::{slice, slice_mut};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::pyramid::assemble_parent;

/// Assembles one `size × size` parent tile from up to four `size × size` RGBA children. `present` is a bitmask,
/// bit `i` set means `child[i]` points at a valid buffer (quadrant `i`: `dx = i & 1`, `dy = i >> 1`); a clear bit
/// leaves that quadrant zeroed and its pointer is ignored (may be 0). `size` must be a positive even number.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_assemble_pyramid_parent(
    c0: u32,
    c1: u32,
    c2: u32,
    c3: u32,
    present: u32,
    size: u32,
    out: u32,
) -> i32 {
    if size == 0 || !size.is_multiple_of(2) {
        return STATUS_BAD_ARGUMENT;
    }
    let size = size as usize;
    let ptrs = [c0, c1, c2, c3];
    let mut children: [Option<&[u8]>; 4] = [None; 4];
    for i in 0..4 {
        if present & (1 << i) != 0 {
            // SAFETY: adapter-owned buffer, bounds checked.
            let Some(s) = (unsafe { slice(ptrs[i], size * size * 4) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            children[i] = Some(s);
        }
    }
    // SAFETY: adapter-owned buffer, bounds checked; never aliases a child (TS scratch layout keeps them apart).
    let Some(out) = (unsafe { slice_mut(out, size * size * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    assemble_parent(children, size, out);
    crate::abi::STATUS_OK
}
