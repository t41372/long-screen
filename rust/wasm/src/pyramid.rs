//! ABI surface for pyramid parent-tile assembly (mirrors `src/core/wasm/pyramid.ts`).

use crate::memory::{slice, slice_mut};
use crate::STATUS_BAD_ARGUMENT;
use long_screen::kernels::pyramid::assemble_parent;

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
    crate::STATUS_OK
}

// --- The engine's pyramid session (`long_screen::engine::pyramid::PyramidSession`), one handle per canvas being
// built by `TileStore.buildPyramid` (src/storage/tiles.ts, through src/core/wasm/pyramid.ts). ---
//
// `ls_pyramid_step` returns its result's length (error convention 6) and leaves it in the handle for
// `ls_pyramid_take`. The result is a `bytes.rs` record: u8 kind, then
//   0 need index: u32 level
//   1 need children: u32 level, i32 x, i32 y of the parent, then per child (quadrant order) u32 level, i32 x, i32 y
//   2 parent: u32 level, i32 x, i32 y, u8 has pixels, then size × size × 4 bytes when it has
//   3 level done: u32 level
//   4 done

use crate::bytes::Out;
use crate::memory::HandleTable;
use crate::tiles::read_str;
use crate::STATUS_OK;
use long_screen::engine::pyramid::{PyramidSession, Step};

struct Session {
    session: PyramidSession,
    size: usize,
    out: Vec<u8>,
}

static mut PYRAMIDS: HandleTable<Session> = HandleTable::new();

fn pyramids() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches PYRAMIDS, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(PYRAMIDS) }
}

/// A session for the canvas whose id is the UTF-8 bytes at `canvas`, with bounds `width × height`. Returns a handle.
#[no_mangle]
pub extern "C" fn ls_pyramid_new(
    canvas: u32,
    canvas_len: u32,
    width: f64,
    height: f64,
    size: u32,
) -> i32 {
    // SAFETY: adapter-owned bytes, bounds checked.
    let Some(canvas) = (unsafe { read_str(canvas, canvas_len) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match PyramidSession::new(&canvas, width, height, size as usize) {
        Ok(session) => pyramids().insert(Session {
            session,
            size: size as usize,
            out: Vec::new(),
        }),
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_pyramid_free(handle: u32) {
    pyramids().free(handle)
}

/// Queues the parent of index row `(x, y)`; writes the parent's i32 x, i32 y to `out` (8 bytes).
#[no_mangle]
pub extern "C" fn ls_pyramid_queue(handle: u32, x: i32, y: i32, out: u32) -> i32 {
    let Some(s) = pyramids().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok((px, py)) = s.session.queue(x, y) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&px.to_le_bytes());
    dst[4..8].copy_from_slice(&py.to_le_bytes());
    STATUS_OK
}

/// The four children's decoded pixels: `children` holds 4 u32 pointers, 0 for a child that is not stored; each
/// other pointer holds size × size × 4 bytes.
#[no_mangle]
pub extern "C" fn ls_pyramid_provide(handle: u32, children: u32) -> i32 {
    let Some(s) = pyramids().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(ptrs) = (unsafe { slice(children, 16) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = s.size * s.size * 4;
    let mut provided: [Option<Vec<u8>>; 4] = [None, None, None, None];
    for (i, slot) in provided.iter_mut().enumerate() {
        let ptr = u32::from_le_bytes(ptrs[i * 4..i * 4 + 4].try_into().unwrap());
        if ptr != 0 {
            // SAFETY: adapter-owned buffer, bounds checked.
            let Some(bytes) = (unsafe { slice(ptr, n) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            *slot = Some(bytes.to_vec());
        }
    }
    match s.session.provide(provided) {
        Ok(()) => STATUS_OK,
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

/// Runs the session to its next step; returns the result's length (see the module comment).
#[no_mangle]
pub extern "C" fn ls_pyramid_step(handle: u32) -> i32 {
    let Some(s) = pyramids().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut w = Out::default();
    match s.session.step() {
        Step::NeedIndex { level } => {
            w.u8(0);
            w.u32(level);
        }
        Step::NeedChildren {
            level,
            x,
            y,
            children,
        } => {
            w.u8(1);
            w.u32(level);
            w.u32(x as u32);
            w.u32(y as u32);
            for c in &children {
                w.u32(c.level);
                w.u32(c.x as u32);
                w.u32(c.y as u32);
            }
        }
        Step::Parent {
            level,
            x,
            y,
            pixels,
        } => {
            w.u8(2);
            w.u32(level);
            w.u32(x as u32);
            w.u32(y as u32);
            w.bool(pixels.is_some());
            if let Some(p) = pixels {
                w.bytes(&p);
            }
        }
        Step::LevelDone { level } => {
            w.u8(3);
            w.u32(level);
        }
        Step::Done => w.u8(4),
    }
    s.out = w.0;
    s.out.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_pyramid_take(handle: u32, out: u32, len: u32) -> i32 {
    let Some(s) = pyramids().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    crate::bytes::take(&mut s.out, out, len)
}
