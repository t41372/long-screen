//! ABI surface of the engine's compositor (`long_screen::engine::compositor`, mirrored by
//! `src/core/wasm/compositor.ts`).

use crate::memory::{slice, slice_mut};
use crate::wire::{read_rects, Reader};
use crate::STATUS_BAD_ARGUMENT;

// --- The engine's compositor (`long_screen::engine::compositor`): one placement as a resumable job over the tile
// cache (`tiles.rs`), the per-canvas temporal indexes and the diagnostics it raises. Mirrored by
// `Compositor` in src/core/wasm/compositor.ts. ---

use crate::memory::HandleTable;
use crate::temporal::{
    read_blocks, write_blocks, write_record_header, TEMPORAL_RECORD_HEADER_BYTES,
};
use crate::tiles::{read_str, tiles};
use crate::wire::read_rect as rect_at;
use crate::STATUS_OK;
use long_screen::engine::compositor::{
    CompositeError, Compositor, CompositorDiagnostic, Frame, Placement, Step, TemporalFlush,
    TemporalPolicy,
};
use long_screen::kernels::geometry::Rect;
use long_screen::kernels::temporal::TemporalRecord;
use std::collections::HashSet;

/// Placement descriptor (`ls_compositor_begin`): u32 canvas ptr, u32 canvas len, rect (32 bytes) at 8, u32 code
/// at 40, f64 owned pixels at 48, f64 x at 56, f64 y at 64, u32 frame at 72, f64 time at 80, f64 confidence at
/// 88, u32 uncertain at 96, u32 occlusions ptr at 100, u32 occlusion count at 104.
pub const PLACEMENT_BYTES: usize = 112;
/// Frame descriptor (`ls_compositor_begin`/`_step`): u32 rgba, width, height, labels, consistent (0 = none).
pub const FRAME_BYTES: usize = 20;
/// `ls_compositor_step` output: for a needed tile i32 x, i32 y; when done f64 added, conflicts, uncertain,
/// tiles, provisional pixels, the placed rect (32 bytes) at 40, then u32 diagnostic bytes at 72
/// (`ls_compositor_diagnostics`).
pub const STEP_OUT_BYTES: usize = 80;
/// One serialised diagnostic: u32 kind (0 incomplete patch, 1 conflict), u32 frame, f64 time, rect (32) at 16,
/// f64 confidence at 48, f64 conflicts at 56, u32 region count at 64, padding; then the regions (32 bytes each).
pub const DIAGNOSTIC_BYTES: usize = 72;

pub const STATUS_FRAME_SIZE: i32 = -10;
pub const STATUS_OUTSIDE_CANVAS: i32 = -11;
pub const STATUS_BUSY: i32 = -12;
pub const STATUS_NO_PLACEMENT: i32 = -13;
pub const STATUS_BAD_TILE: i32 = -14;
pub const STATUS_DISPOSED: i32 = -15;

struct CompositorState {
    compositor: Compositor,
    diagnostics: Vec<u8>,
    flushed: Vec<TemporalFlush>,
}

static mut COMPOSITORS: HandleTable<CompositorState> = HandleTable::new();

fn compositor(handle: u32) -> Option<&'static mut CompositorState> {
    // SAFETY: only the main instance touches COMPOSITORS, through these exports.
    unsafe { (*std::ptr::addr_of_mut!(COMPOSITORS)).get(handle) }
}

/// The engine compositor behind a handle, for the render session to drive (`render.rs`).
pub(crate) fn engine_compositor(handle: u32) -> Option<&'static mut Compositor> {
    compositor(handle).map(|s| &mut s.compositor)
}

fn status(e: CompositeError) -> i32 {
    match e {
        CompositeError::FrameSize => STATUS_FRAME_SIZE,
        CompositeError::OutsideCanvas => STATUS_OUTSIDE_CANVAS,
        CompositeError::Busy => STATUS_BUSY,
        CompositeError::NoPlacement => STATUS_NO_PLACEMENT,
        CompositeError::BadTile => STATUS_BAD_TILE,
        CompositeError::Disposed => STATUS_DISPOSED,
        CompositeError::Unexpected => STATUS_BAD_ARGUMENT,
    }
}

/// `policy` 0 = stable, 1 = latest.
#[no_mangle]
pub extern "C" fn ls_compositor_new(policy: u32, atlas_width: u32, atlas_height: u32) -> i32 {
    let policy = if policy == 1 {
        TemporalPolicy::Latest
    } else {
        TemporalPolicy::Stable
    };
    // SAFETY: see `compositor`.
    unsafe {
        (*std::ptr::addr_of_mut!(COMPOSITORS)).insert(CompositorState {
            compositor: Compositor::new(policy, atlas_width as usize, atlas_height as usize),
            diagnostics: Vec::new(),
            flushed: Vec::new(),
        })
    }
}

#[no_mangle]
pub extern "C" fn ls_compositor_free(handle: u32) {
    // SAFETY: see `compositor`.
    unsafe { (*std::ptr::addr_of_mut!(COMPOSITORS)).free(handle) }
}

/// # Safety
/// `desc` points at an adapter-owned `FRAME_BYTES` descriptor whose planes stay alive for the call.
unsafe fn frame<'a>(desc: u32) -> Option<Frame<'a>> {
    let d = Reader(slice(desc, FRAME_BYTES)?);
    let (width, height) = (d.u32(4) as usize, d.u32(8) as usize);
    let n = width * height;
    let consistent = match d.u32(16) {
        0 => None,
        ptr => Some(slice(ptr, n)?),
    };
    Some(Frame {
        rgba: slice(d.u32(0), n * 4)?,
        width,
        height,
        labels: slice(d.u32(12), n)?,
        consistent,
    })
}

#[no_mangle]
pub extern "C" fn ls_compositor_begin(
    handle: u32,
    tiles_handle: u32,
    placement: u32,
    frame_desc: u32,
) -> i32 {
    let (Some(state), Some(t)) = (compositor(handle), tiles(tiles_handle)) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned descriptors, bounds checked.
    let (Some(p), Some(f)) = (unsafe { slice(placement, PLACEMENT_BYTES) }, unsafe {
        slice(frame_desc, FRAME_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = Reader(p);
    // SAFETY: adapter-owned bytes, bounds checked.
    let Some(canvas) = (unsafe { read_str(r.u32(0), r.u32(4)) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let occlusion_count = r.u32(104) as usize;
    let occlusions = if occlusion_count == 0 {
        Vec::new()
    } else {
        // SAFETY: adapter-owned rects, bounds checked.
        match unsafe { slice(r.u32(100), occlusion_count * 32) } {
            Some(b) => read_rects(b),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let f = Reader(f);
    let result = state.compositor.begin(
        &t.cache,
        Placement {
            canvas,
            region: rect_at(&p[8..40]),
            code: r.u32(40) as u8,
            owned_pixels: r.f64(48),
            x: r.f64(56),
            y: r.f64(64),
            frame: r.u32(72),
            time: r.f64(80),
            confidence: r.f64(88),
            uncertain: r.u32(96) != 0,
            occlusions,
            fixed: false,
        },
        f.u32(4) as usize,
        f.u32(8) as usize,
    );
    match result {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

#[no_mangle]
pub extern "C" fn ls_compositor_cancel(handle: u32) {
    if let Some(state) = compositor(handle) {
        state.compositor.cancel();
    }
}

fn put_f64(dst: &mut [u8], at: usize, v: f64) {
    dst[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
fn put_rect(dst: &mut [u8], at: usize, r: Rect) {
    for (i, v) in [r.x, r.y, r.width, r.height].into_iter().enumerate() {
        put_f64(dst, at + i * 8, v);
    }
}

fn serialise(diagnostics: &[CompositorDiagnostic]) -> Vec<u8> {
    let mut out = Vec::new();
    for d in diagnostics {
        let mut head = vec![0u8; DIAGNOSTIC_BYTES];
        let (kind, frame, time, region, confidence, conflicts, regions) = match d {
            CompositorDiagnostic::IncompletePatch {
                frame,
                time,
                region,
                ..
            } => (0u32, *frame, *time, *region, 0.0, 0.0, &[][..]),
            CompositorDiagnostic::Conflict {
                frame,
                time,
                region,
                confidence,
                regions,
                conflicts,
                ..
            } => (
                1,
                *frame,
                *time,
                *region,
                *confidence,
                *conflicts as f64,
                &regions[..],
            ),
        };
        head[0..4].copy_from_slice(&kind.to_le_bytes());
        head[4..8].copy_from_slice(&frame.to_le_bytes());
        put_f64(&mut head, 8, time);
        put_rect(&mut head, 16, region);
        put_f64(&mut head, 48, confidence);
        put_f64(&mut head, 56, conflicts);
        head[64..68].copy_from_slice(&(regions.len() as u32).to_le_bytes());
        out.extend_from_slice(&head);
        for r in regions {
            let mut b = [0u8; 32];
            put_rect(&mut b, 0, *r);
            out.extend_from_slice(&b);
        }
    }
    out
}

/// Runs the placement until it needs something. Returns 0 when done (stats in `out`, diagnostics through
/// `ls_compositor_diagnostics`), 1 when it needs the tile at `out`'s (x, y) on the placement's canvas, level 0,
/// 2 when it needs the canvas's temporal records (`ls_compositor_load_temporal`), or a negative status.
#[no_mangle]
pub extern "C" fn ls_compositor_step(
    handle: u32,
    tiles_handle: u32,
    frame_desc: u32,
    now: f64,
    out: u32,
) -> i32 {
    let (Some(state), Some(t)) = (compositor(handle), tiles(tiles_handle)) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned descriptor and planes, bounds checked.
    let (Some(f), Some(dst)) = (unsafe { frame(frame_desc) }, unsafe {
        slice_mut(out, STEP_OUT_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match state.compositor.step(&mut t.cache, &f, now) {
        Ok(Step::NeedTile(key)) => {
            dst[0..4].copy_from_slice(&key.x.to_le_bytes());
            dst[4..8].copy_from_slice(&key.y.to_le_bytes());
            1
        }
        Ok(Step::NeedTemporal(_)) => 2,
        Ok(Step::Done(outcome)) => {
            let s = outcome.stats;
            let values = [
                s.added as f64,
                s.conflicts as f64,
                s.uncertain as f64,
                s.tiles as f64,
                s.provisional_pixels as f64,
            ];
            for (i, v) in values.into_iter().enumerate() {
                put_f64(dst, i * 8, v);
            }
            put_rect(dst, 40, s.bounds);
            state.diagnostics = serialise(&outcome.diagnostics);
            dst[72..76].copy_from_slice(&(state.diagnostics.len() as u32).to_le_bytes());
            STATUS_OK
        }
        Err(e) => status(e),
    }
}

/// Copies the finished placement's serialised diagnostics (the byte count `ls_compositor_step` reported) to `out`.
#[no_mangle]
pub extern "C" fn ls_compositor_diagnostics(handle: u32, out: u32) -> i32 {
    let Some(state) = compositor(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, state.diagnostics.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(&state.diagnostics);
    STATUS_OK
}

/// Seeds `canvas`'s temporal index: `count` record headers (`TEMPORAL_RECORD_HEADER_BYTES` each, ascending id
/// order) at `headers`, their blocks concatenated at `blocks`.
#[no_mangle]
pub extern "C" fn ls_compositor_load_temporal(
    handle: u32,
    canvas: u32,
    canvas_len: u32,
    headers: u32,
    blocks: u32,
    count: u32,
) -> i32 {
    let Some(state) = compositor(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned bytes, bounds checked.
    let (Some(canvas), Some(h)) = (unsafe { read_str(canvas, canvas_len) }, unsafe {
        slice(headers, count as usize * TEMPORAL_RECORD_HEADER_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut records = Vec::with_capacity(count as usize);
    let mut at = blocks;
    for head in h.chunks_exact(TEMPORAL_RECORD_HEADER_BYTES) {
        let r = Reader(head);
        let block_count = r.u32(62);
        // SAFETY: adapter-owned buffer, bounds checked.
        let Some(list) = (unsafe { read_blocks(at, block_count) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        at += block_count * 8;
        records.push(TemporalRecord {
            id: String::from_utf8_lossy(&head[0..10]).into_owned(),
            rect: rect_at(&head[10..42]),
            keys: list.into_iter().collect::<HashSet<_>>(),
            chosen_frame: r.u32(42),
            chosen_time: r.f64(46),
            complete: r.u32(54) != 0,
            revisions: r.u32(58),
        });
    }
    match state.compositor.load_temporal(&canvas, records) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

/// Drains every canvas's changed temporal records; returns how many canvases (in first-loaded order) the
/// following `ls_compositor_flush_sizes`/`_take` calls can read.
#[no_mangle]
pub extern "C" fn ls_compositor_flush(handle: u32) -> i32 {
    let Some(state) = compositor(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    state.flushed = state.compositor.flush();
    state.flushed.len() as i32
}

/// `out` receives u32 canvas id bytes, u32 deleted count, u32 dirty count, u32 total dirty blocks.
#[no_mangle]
pub extern "C" fn ls_compositor_flush_sizes(handle: u32, canvas: u32, out: u32) -> i32 {
    let Some(state) = compositor(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(f) = state.flushed.get(canvas as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, 16) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let blocks: usize = f.dirty.iter().map(|(_, b)| b.len()).sum();
    let values = [f.canvas.len(), f.deleted.len(), f.dirty.len(), blocks];
    for (i, v) in values.into_iter().enumerate() {
        dst[i * 4..i * 4 + 4].copy_from_slice(&(v as u32).to_le_bytes());
    }
    STATUS_OK
}

/// Writes one flushed canvas: its id bytes, every deleted id (10 bytes each), the dirty record headers and their
/// blocks, sized by `ls_compositor_flush_sizes`.
#[no_mangle]
pub extern "C" fn ls_compositor_flush_take(
    handle: u32,
    canvas: u32,
    id_out: u32,
    deleted_out: u32,
    headers_out: u32,
    blocks_out: u32,
) -> i32 {
    let Some(state) = compositor(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(f) = state.flushed.get(canvas as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    let blocks: usize = f.dirty.iter().map(|(_, b)| b.len()).sum();
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(id_dst), Some(del_dst), Some(head_dst), Some(block_dst)) = (unsafe {
        (
            slice_mut(id_out, f.canvas.len()),
            slice_mut(deleted_out, f.deleted.len() * 10),
            slice_mut(headers_out, f.dirty.len() * TEMPORAL_RECORD_HEADER_BYTES),
            slice_mut(blocks_out, blocks * 8),
        )
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    id_dst.copy_from_slice(f.canvas.as_bytes());
    for (i, id) in f.deleted.iter().enumerate() {
        let b = id.as_bytes();
        del_dst[i * 10..i * 10 + 10.min(b.len())].copy_from_slice(&b[..10.min(b.len())]);
    }
    let mut boff = 0;
    for (i, (record, list)) in f.dirty.iter().enumerate() {
        write_record_header(
            &mut head_dst[i * TEMPORAL_RECORD_HEADER_BYTES..(i + 1) * TEMPORAL_RECORD_HEADER_BYTES],
            record,
            list.len() as u32,
        );
        write_blocks(&mut block_dst[boff..boff + list.len() * 8], list);
        boff += list.len() * 8;
    }
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_compositor_dispose(handle: u32) {
    if let Some(state) = compositor(handle) {
        state.compositor.dispose();
    }
}
