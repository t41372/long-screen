//! The engine's reveal session (`long_screen_engine::reveal::RevealSession`, mirrored by `src/core/wasm/reveal.ts`):
//! overlay-aware block selection after the compositor, driven by `src/pipeline/reveal.ts` over the tile cache
//! (`tiles.rs`).
//!
//! `ls_reveal_new` takes a `bytes.rs` record: u32 width, u32 height, f64 noise, u32 tile size, u32 frames; u32 layer
//! count, each str id, rect (4 × f64), u32 atlas code; u32 canvas count, each str id, bounds (4 × f64). It returns a
//! handle (error convention 4); a layer with an empty pixel span or a code above 255 is a bad argument.
//!
//! `ls_reveal_observation` takes one stored `observation/` row: u32 frame, u32 decision count, each str canvas,
//! str layer, f64 x, f64 y, u8 skip, u8 skipped, u32 occlusion count, each rect (4 × f64).
//!
//! `ls_reveal_step` returns its result's length (error convention 6; −2 when a tile asked for was not inserted) and
//! leaves it in the handle for `ls_reveal_take`. The result is a `bytes.rs` record: u8 kind, then
//!   0 need memory: f64 bytes, u8 stage (0 canvases, 1 fallback)
//!   1 need observations; 2 need tile: str canvas, u32 level, i32 x, i32 y; 3 checkpoint
//!   4 decode: u8 pass (0 learn, 1 agree, 2 relearn, 3 write), u32 frame count, one u8 (0/1) per frame
//!   5 next frame; 6 pass done: u8 pass
//!   7 provenance: str canvas, i32 gx, i32 gy, u32 bw, u32 bh, then bw × bh i32
//!   8 done, nothing to reveal; 9 done, skipped: one diagnostic (`diagnostic.rs`)
//!   10 done, revealed: six u32 counters (objects, components, coherent, component, provisional and fallback blocks)

use crate::bytes::{Cursor, Out};
use crate::diagnostic::write_diagnostic;
use crate::memory::{slice, HandleTable};
use crate::tiles::tiles;
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen_core::geometry::Rect;
use long_screen_engine::reveal::{
    MemoryStage, ObservedDecision, Outcome, Pass, RevealCanvas, RevealError, RevealLayer,
    RevealSession, Step,
};

/// `ls_reveal_step` was called after `NeedTile` without the tile being inserted.
pub const STATUS_NOT_PROVIDED: i32 = -2;

struct Session {
    session: RevealSession,
    out: Vec<u8>,
}

static mut REVEALS: HandleTable<Session> = HandleTable::new();

fn reveals() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches REVEALS, and only through these exported entry points — no pool helper
    // thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(REVEALS) }
}

fn status(error: RevealError) -> i32 {
    match error {
        RevealError::NotProvided => STATUS_NOT_PROVIDED,
        RevealError::Unexpected | RevealError::BadLayer | RevealError::BadLabels => {
            STATUS_BAD_ARGUMENT
        }
    }
}

fn read_rect(c: &mut Cursor) -> Option<Rect> {
    Some(Rect {
        x: c.f64()?,
        y: c.f64()?,
        width: c.f64()?,
        height: c.f64()?,
    })
}

fn pass_code(pass: Pass) -> u8 {
    match pass {
        Pass::Learn => 0,
        Pass::Agree => 1,
        Pass::Relearn => 2,
        Pass::Write => 3,
    }
}

/// The atlas label plane at `ptr` (0 = none), `len` bytes.
fn labels(ptr: u32, len: usize) -> Option<Option<&'static [u8]>> {
    if ptr == 0 {
        return Some(None);
    }
    // SAFETY: an adapter-owned resident plane, bounds checked.
    unsafe { slice(ptr, len) }.map(Some)
}

#[no_mangle]
pub extern "C" fn ls_reveal_new(input: u32, len: u32) -> i32 {
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut c = Cursor::new(bytes);
    let parsed = (|| {
        let (width, height) = (c.u32()? as usize, c.u32()? as usize);
        let noise = c.f64()?;
        let (size, frames) = (c.u32()? as usize, c.u32()?);
        let mut layers = Vec::new();
        for _ in 0..c.u32()? {
            let id = c.str()?.to_string();
            let rect = read_rect(&mut c)?;
            layers.push(RevealLayer {
                id,
                rect,
                code: c.u32()?,
            });
        }
        let mut canvases = Vec::new();
        for _ in 0..c.u32()? {
            let id = c.str()?.to_string();
            canvases.push(RevealCanvas {
                id,
                bounds: read_rect(&mut c)?,
            });
        }
        Some((width, height, noise, size, frames, layers, canvases))
    })();
    let Some((width, height, noise, size, frames, layers, canvases)) = parsed else {
        return STATUS_BAD_ARGUMENT;
    };
    if width == 0 || height == 0 || !noise.is_finite() || noise < 0.0 || size == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    match RevealSession::new(width, height, noise, size, frames, layers, canvases) {
        Ok(session) => reveals().insert(Session {
            session,
            out: Vec::new(),
        }),
        Err(e) => status(e),
    }
}

#[no_mangle]
pub extern "C" fn ls_reveal_free(handle: u32) {
    reveals().free(handle);
}

/// The answer to a memory step: `fits` 1 or 0, and the core's size in bytes.
#[no_mangle]
pub extern "C" fn ls_reveal_memory(handle: u32, fits: u32, core_bytes: f64) -> i32 {
    let Some(s) = reveals().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    match s.session.memory(fits != 0, core_bytes) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

/// One stored observation row (see the module documentation).
#[no_mangle]
pub extern "C" fn ls_reveal_observation(handle: u32, input: u32, len: u32) -> i32 {
    let Some(s) = reveals().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut c = Cursor::new(bytes);
    let parsed = (|| {
        let frame = c.u32()?;
        let mut decisions = Vec::new();
        for _ in 0..c.u32()? {
            let canvas = c.str()?.to_string();
            let layer = c.str()?.to_string();
            let (x, y) = (c.f64()?, c.f64()?);
            let (skip, skipped) = (c.bool()?, c.bool()?);
            let mut occlusions = Vec::new();
            for _ in 0..c.u32()? {
                occlusions.push(read_rect(&mut c)?);
            }
            decisions.push(ObservedDecision {
                canvas,
                layer,
                x,
                y,
                skip,
                skipped,
                occlusions,
            });
        }
        Some((frame, decisions))
    })();
    let Some((frame, decisions)) = parsed else {
        return STATUS_BAD_ARGUMENT;
    };
    match s.session.observation(frame, &decisions) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

/// Pointer to the `width × height × 4`-byte buffer the next wanted frame's RGBA goes into (0 out of turn or on a bad
/// handle). It stays valid until the session is freed; memory growth does not move it.
#[no_mangle]
pub extern "C" fn ls_reveal_frame(handle: u32) -> u32 {
    match reveals().get(handle).map(|s| s.session.frame_buffer()) {
        Some(Ok(buffer)) => buffer.as_mut_ptr() as u32,
        _ => 0,
    }
}

/// Frame `index` was decoded (its pixels in the frame buffer when it was wanted); `labels` is the atlas label plane
/// of `label_len` bytes (0 = none).
#[no_mangle]
pub extern "C" fn ls_reveal_push(handle: u32, index: u32, labels_ptr: u32, label_len: u32) -> i32 {
    let Some(s) = reveals().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(labels) = labels(labels_ptr, label_len as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    match s.session.push_frame(index, labels) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

/// The decode for the pass is over.
#[no_mangle]
pub extern "C" fn ls_reveal_end(handle: u32, labels_ptr: u32, label_len: u32) -> i32 {
    let Some(s) = reveals().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(labels) = labels(labels_ptr, label_len as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    match s.session.end_pass(labels) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

#[no_mangle]
pub extern "C" fn ls_reveal_step(handle: u32, tiles_handle: u32, now: f64) -> i32 {
    let (Some(s), Some(t)) = (reveals().get(handle), tiles(tiles_handle)) else {
        return STATUS_BAD_ARGUMENT;
    };
    let step = match s.session.step(&mut t.cache, now) {
        Ok(step) => step,
        Err(e) => return status(e),
    };
    let mut w = Out::default();
    match step {
        Step::NeedMemory { bytes, stage } => {
            w.u8(0);
            w.f64(bytes);
            w.u8(match stage {
                MemoryStage::Canvases => 0,
                MemoryStage::Fallback => 1,
            });
        }
        Step::NeedObservations => w.u8(1),
        Step::NeedTile(key) => {
            w.u8(2);
            w.str(&key.canvas);
            w.u32(key.level);
            w.i32(key.x);
            w.i32(key.y);
        }
        Step::Checkpoint => w.u8(3),
        Step::Decode { pass, wanted } => {
            w.u8(4);
            w.u8(pass_code(pass));
            w.u32(wanted.len() as u32);
            for want in wanted {
                w.bool(want);
            }
        }
        Step::NextFrame => w.u8(5),
        Step::PassDone(pass) => {
            w.u8(6);
            w.u8(pass_code(pass));
        }
        Step::Provenance(p) => {
            w.u8(7);
            w.str(&p.canvas);
            w.i32(p.gx as i32);
            w.i32(p.gy as i32);
            w.u32(p.bw as u32);
            w.u32(p.bh as u32);
            for v in p.source {
                w.i32(v);
            }
        }
        Step::Done(Outcome::Nothing) => w.u8(8),
        Step::Done(Outcome::Skipped(d)) => {
            w.u8(9);
            write_diagnostic(&mut w, &d);
        }
        Step::Done(Outcome::Revealed(summary)) => {
            w.u8(10);
            for v in [
                summary.objects,
                summary.components,
                summary.coherent_blocks,
                summary.component_blocks,
                summary.provisional_blocks,
                summary.fallback_blocks,
            ] {
                w.u32(v);
            }
        }
    }
    s.out = w.0;
    s.out.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_reveal_take(handle: u32, out: u32, len: u32) -> i32 {
    let Some(s) = reveals().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    crate::bytes::take(&mut s.out, out, len)
}
