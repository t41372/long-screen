//! The render pass's session (`long_screen::engine::render::RenderSession`), one handle per render pass, mirrored by
//! `src/core/wasm/render.ts`. Inputs and results are `bytes.rs` records:
//!
//! - rect: f64 x, y, width, height
//! - placement (a plan row's): str layer, str canvasId, str node, f64 x, y, confidence, u8 uncertain, f64 time,
//!   u8 skip (0 absent, 1 false, 2 true), u8 has occlusions, [u32 count, rects]
//! - plan: u8 duplicate, u32 count, placements
//! - vote record: u32 regions, then per region str id, u32 x0, y0, w, h (as i32), u32 length + bits, u32 length +
//!   clean
//! - meta: rect bounds, f64 tileCount, observedPixels, uncertainPixels, conflictPixels, provisionalPixels, lastTime
//! - diagnostics: the engine's structured diagnostics in `diagnostic.rs`'s form
//!
//! A call that produces a result returns its byte length (or a negative status) and leaves it in the handle;
//! `ls_render_take` copies it into an adapter buffer of that length.

use crate::bytes::{take, Cursor, Out};
use crate::compositor::engine_compositor;
use crate::diagnostic::write_diagnostics;
use crate::memory::{slice, slice_mut, HandleTable};
use crate::pose_graph::graph;
use crate::tiles::tiles;
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen::engine::attachments::Attachment;
use long_screen::engine::render::{
    CanvasMeta, ConsistencyRecord, ConsistencyVote, FrameInput, FramePlan, PlanPlacement,
    RegionKind, RenderConfig, RenderIo, RenderRegion, RenderSession, RenderStep,
};
use long_screen::kernels::geometry::Rect;

struct Session {
    session: RenderSession,
    out: Vec<u8>,
}

static mut HANDLES: HandleTable<Session> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches HANDLES, through these exports; no pool helper reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

fn read_rect(c: &mut Cursor) -> Option<Rect> {
    Some(Rect {
        x: c.f64()?,
        y: c.f64()?,
        width: c.f64()?,
        height: c.f64()?,
    })
}

fn write_rect(out: &mut Out, r: Rect) {
    for v in [r.x, r.y, r.width, r.height] {
        out.f64(v);
    }
}

fn read_placement(c: &mut Cursor) -> Option<PlanPlacement> {
    Some(PlanPlacement {
        layer: c.str()?.to_string(),
        canvas_id: c.str()?.to_string(),
        node: c.str()?.to_string(),
        x: c.f64()?,
        y: c.f64()?,
        confidence: c.f64()?,
        uncertain: c.bool()?,
        time: c.f64()?,
        skip: match c.u8()? {
            0 => None,
            1 => Some(false),
            _ => Some(true),
        },
        occlusions: if c.bool()? {
            let n = c.u32()?;
            Some((0..n).map(|_| read_rect(c)).collect::<Option<_>>()?)
        } else {
            None
        },
    })
}

fn write_placement(out: &mut Out, p: &PlanPlacement) {
    out.str(&p.layer);
    out.str(&p.canvas_id);
    out.str(&p.node);
    out.f64(p.x);
    out.f64(p.y);
    out.f64(p.confidence);
    out.bool(p.uncertain);
    out.f64(p.time);
    out.u8(match p.skip {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    });
    out.bool(p.occlusions.is_some());
    if let Some(rects) = &p.occlusions {
        out.u32(rects.len() as u32);
        for r in rects {
            write_rect(out, *r);
        }
    }
}

fn read_plan(c: &mut Cursor) -> Option<FramePlan> {
    let duplicate = c.bool()?;
    let n = c.u32()?;
    Some(FramePlan {
        duplicate,
        placements: (0..n).map(|_| read_placement(c)).collect::<Option<_>>()?,
    })
}

fn read_optional_plan(c: &mut Cursor) -> Option<Option<FramePlan>> {
    Some(if c.bool()? { Some(read_plan(c)?) } else { None })
}

fn read_record(c: &mut Cursor) -> Option<ConsistencyRecord> {
    let n = c.u32()?;
    let mut record = ConsistencyRecord::with_capacity(n as usize);
    for _ in 0..n {
        let id = c.str()?.to_string();
        let (x0, y0, w, h) = (
            c.u32()? as i32,
            c.u32()? as i32,
            c.u32()? as i32,
            c.u32()? as i32,
        );
        let bits = c.u32()? as usize;
        let bits = c.bytes(bits)?.to_vec();
        let clean = c.u32()? as usize;
        let clean = c.bytes(clean)?.to_vec();
        record.insert(
            id,
            ConsistencyVote {
                x0,
                y0,
                w,
                h,
                bits,
                clean,
            },
        );
    }
    Some(record)
}

fn read_meta(c: &mut Cursor) -> Option<CanvasMeta> {
    Some(CanvasMeta {
        bounds: read_rect(c)?,
        tile_count: c.f64()?,
        observed_pixels: c.f64()?,
        uncertain_pixels: c.f64()?,
        conflict_pixels: c.f64()?,
        provisional_pixels: c.f64()?,
        last_time: c.f64()?,
    })
}

fn write_meta(out: &mut Out, m: &CanvasMeta) {
    write_rect(out, m.bounds);
    for v in [
        m.tile_count,
        m.observed_pixels,
        m.uncertain_pixels,
        m.conflict_pixels,
        m.provisional_pixels,
        m.last_time,
    ] {
        out.f64(v);
    }
}

/// Runs `f` on the session and the adapter's input record (`len` 0 for none); `f` fills a result and returns its
/// status. Returns the result's length (left for `ls_render_take`) or a negative status.
fn call(
    handle: u32,
    input: u32,
    len: u32,
    f: impl FnOnce(&mut RenderSession, &mut Cursor, &mut Out) -> Option<i32>,
) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let bytes = if len == 0 {
        &[][..]
    } else {
        // SAFETY: adapter-owned input, bounds-checked by `slice`.
        match unsafe { slice(input, len as usize) } {
            Some(b) => b,
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let mut out = Out::default();
    match f(&mut s.session, &mut Cursor::new(bytes), &mut out) {
        Some(STATUS_OK) => {
            s.out = out.0;
            s.out.len() as i32
        }
        Some(error) => error,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Input: u32 width, u32 height, u32 factor, f64 noise, u32 regions, then per region str id, u8 kind (0 moving,
/// 1 fixed, 2 ignore), rect, u8 code, f64 owned pixels; u32 attachments, then per attachment str id, str target,
/// f64 dx, dy, frame, confidence, str node. Returns a handle.
#[no_mangle]
pub extern "C" fn ls_render_new(input: u32, len: u32) -> i32 {
    // SAFETY: adapter-owned input, bounds checked.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let c = &mut Cursor::new(bytes);
    let read = |c: &mut Cursor| -> Option<RenderConfig> {
        let (width, height, factor, noise) = (c.u32()?, c.u32()?, c.u32()?, c.f64()?);
        let regions = (0..c.u32()?)
            .map(|_| {
                Some(RenderRegion {
                    id: c.str()?.to_string(),
                    kind: match c.u8()? {
                        0 => RegionKind::Moving,
                        1 => RegionKind::Fixed,
                        _ => RegionKind::Ignore,
                    },
                    rect: read_rect(c)?,
                    code: c.u8()?,
                    owned_pixels: c.f64()?,
                })
            })
            .collect::<Option<_>>()?;
        let attachments = (0..c.u32()?)
            .map(|_| {
                Some(Attachment {
                    id: c.str()?.to_string(),
                    target: c.str()?.to_string(),
                    dx: c.f64()?,
                    dy: c.f64()?,
                    frame: c.f64()? as u32,
                    confidence: c.f64()?,
                    node: c.str()?.to_string(),
                })
            })
            .collect::<Option<_>>()?;
        Some(RenderConfig {
            width: width as usize,
            height: height as usize,
            factor: factor as i32,
            noise,
            regions,
            attachments,
        })
    };
    let Some(config) = read(c) else {
        return STATUS_BAD_ARGUMENT;
    };
    if config.width == 0 || config.height == 0 || config.factor <= 0 {
        return STATUS_BAD_ARGUMENT;
    }
    handles().insert(Session {
        session: RenderSession::new(config),
        out: Vec::new(),
    })
}

#[no_mangle]
pub extern "C" fn ls_render_free(handle: u32) {
    handles().free(handle);
}

/// Result: the diagnostics (none, or `MEMORY_BUDGET_RAISED` when the limit had to be raised).
#[no_mangle]
pub extern "C" fn ls_render_configure_tiles(handle: u32, tiles_handle: u32, memory_mb: f64) -> i32 {
    let Some(t) = tiles(tiles_handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    call(handle, 0, 0, |s, _, out| {
        let raised = s.configure_tiles(&mut t.cache, memory_mb);
        write_diagnostics(out, raised.as_slice());
        Some(STATUS_OK)
    })
}

/// Result: u32 count, then the frame indices (f64) to read `consistency/<frame>` for, in order.
#[no_mangle]
pub extern "C" fn ls_render_wanted_votes(
    handle: u32,
    index: u32,
    has_prev: u32,
    has_next: u32,
) -> i32 {
    call(handle, 0, 0, |s, _, out| {
        let wanted = s.wanted_votes(index, has_prev != 0, has_next != 0);
        out.u32(wanted.len() as u32);
        for i in wanted {
            out.f64(i as f64);
        }
        Some(STATUS_OK)
    })
}

/// Input: u32 index, f64 time, plan, u8 has prev, u8 has prev plan + [plan], u8 has next, u8 has next plan +
/// [plan], u32 votes, then per vote f64 index, u8 present, [record]. Returns a status.
#[no_mangle]
pub extern "C" fn ls_render_begin(handle: u32, input: u32, len: u32) -> i32 {
    let status = call(handle, input, len, |s, c, _| {
        let frame = FrameInput {
            index: c.u32()?,
            time: c.f64()?,
            plan: read_plan(c)?,
            has_prev: c.bool()?,
            prev_plan: read_optional_plan(c)?,
            has_next: c.bool()?,
            next_plan: read_optional_plan(c)?,
        };
        let votes = (0..c.u32()?)
            .map(|_| {
                let index = c.f64()? as i64;
                Some((
                    index,
                    if c.bool()? {
                        Some(read_record(c)?)
                    } else {
                        None
                    },
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(match s.begin(frame, votes) {
            Ok(()) => STATUS_OK,
            Err(_) => STATUS_BAD_ARGUMENT,
        })
    });
    status.min(STATUS_OK)
}

/// Runs the frame until it needs something or is done. Result: the diagnostics, f64 skippedPaints, tiles,
/// observedPixels (cumulative), then u8 kind — 0 done: u32 frame, f64 time, u32 decisions, then per decision str
/// canvasId, placement, f64 added, conflicts, uncertain, u8 skipped, u8 reused; u8 has latest + [str]; 1 meta: str
/// canvas; 2 frame: u32 index; 3 tile: str canvas, i32 x, i32 y (as u32); 4 temporal: str canvas; 5 error: str
/// message (the frame is abandoned).
#[no_mangle]
pub extern "C" fn ls_render_step(
    handle: u32,
    compositor_handle: u32,
    tiles_handle: u32,
    graph_handle: u32,
    labels: u32,
    labels_len: u32,
    now: f64,
) -> i32 {
    let (Some(compositor), Some(t), Some(graph)) = (
        engine_compositor(compositor_handle),
        tiles(tiles_handle),
        graph(graph_handle),
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: the atlas's resident label plane, bounds checked.
    let Some(labels) = (unsafe { slice(labels, labels_len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    call(handle, 0, 0, |s, _, out| {
        let mut io = RenderIo {
            cache: &mut t.cache,
            compositor,
            graph,
            labels,
            now,
        };
        let step = s.step(&mut io);
        write_diagnostics(out, &s.take_events());
        let counters = s.counters();
        out.f64(counters.skipped_paints as f64);
        out.f64(counters.tiles);
        out.f64(counters.observed_pixels);
        match step {
            Ok(RenderStep::Done(outcome)) => {
                out.u8(0);
                let o = outcome.observation;
                out.u32(o.frame);
                out.f64(o.time);
                out.u32(o.decisions.len() as u32);
                for d in &o.decisions {
                    out.str(&d.canvas_id);
                    write_placement(out, &d.placement);
                    out.f64(d.added_pixels);
                    out.f64(d.conflict_pixels);
                    out.f64(d.uncertain_pixels);
                    out.bool(d.skipped);
                    out.bool(d.reused_exact_observation);
                }
                out.bool(outcome.latest.is_some());
                if let Some(latest) = &outcome.latest {
                    out.str(latest);
                }
            }
            Ok(RenderStep::NeedMeta(canvas)) => {
                out.u8(1);
                out.str(&canvas);
            }
            Ok(RenderStep::NeedFrame(index)) => {
                out.u8(2);
                out.u32(index);
            }
            Ok(RenderStep::NeedTile(key)) => {
                out.u8(3);
                out.str(&key.canvas);
                out.u32(key.x as u32);
                out.u32(key.y as u32);
            }
            Ok(RenderStep::NeedTemporal(canvas)) => {
                out.u8(4);
                out.str(&canvas);
            }
            Err(e) => {
                out.u8(5);
                out.str(&e.to_string());
            }
        }
        Some(STATUS_OK)
    })
}

/// Input: str canvas, u8 present, [meta]. Returns a status.
#[no_mangle]
pub extern "C" fn ls_render_provide_meta(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, _| {
        let canvas = c.str()?;
        let meta = if c.bool()? { Some(read_meta(c)?) } else { None };
        s.provide_meta(canvas, meta);
        Some(STATUS_OK)
    })
    .min(STATUS_OK)
}

/// Writes the address of frame `index`'s ring slot (width × height × 4 bytes, valid until the session is freed) to
/// the u32 at `out`, for the adapter to write the frame's RGBA into.
#[no_mangle]
pub extern "C" fn ls_render_frame_slot(handle: u32, index: u32, out: u32) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned 4-byte output.
    let Some(dst) = (unsafe { slice_mut(out, 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let ptr = s.session.frame_slot(index).as_mut_ptr() as usize as u32;
    dst.copy_from_slice(&ptr.to_le_bytes());
    STATUS_OK
}

/// Ends the run's fixed regions after the last frame (`RenderSession::begin_finish`): 1 when the session has a
/// finishing job to step like a frame, 0 when not, or a negative status.
#[no_mangle]
pub extern "C" fn ls_render_begin_finish(handle: u32) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    match s.session.begin_finish() {
        Ok(work) => work as i32,
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

/// Paints every fixed region's first frame without transients into the reference frame `frame` (`rgba` holds
/// width × height × 4 bytes, patched in place; `RenderSession::patch_reference`): 1 when a pixel changed, else 0.
#[no_mangle]
pub extern "C" fn ls_render_patch_reference(
    handle: u32,
    rgba: u32,
    width: u32,
    height: u32,
    frame: u32,
) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (w, h) = (width as usize, height as usize);
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(pixels) = (unsafe { slice_mut(rgba, w * h * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    s.session.patch_reference(pixels, w, h, frame) as i32
}

/// Abandons the frame in progress and the compositor's placement with it.
#[no_mangle]
pub extern "C" fn ls_render_cancel(handle: u32, compositor_handle: u32) {
    if let (Some(s), Some(compositor)) =
        (handles().get(handle), engine_compositor(compositor_handle))
    {
        s.session.cancel(compositor);
    }
}

/// Input: str canvas. Result: u8 present, [meta].
#[no_mangle]
pub extern "C" fn ls_render_meta(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, out| {
        match s.meta(c.str()?) {
            Some(m) => {
                out.bool(true);
                write_meta(out, &m);
            }
            None => out.bool(false),
        }
        Some(STATUS_OK)
    })
}

/// Result: u32 count, then per canvas str id and its meta, in first-changed order.
#[no_mangle]
pub extern "C" fn ls_render_dirty_metas(handle: u32) -> i32 {
    call(handle, 0, 0, |s, _, out| {
        let dirty = s.take_dirty_metas();
        out.u32(dirty.len() as u32);
        for (id, m) in &dirty {
            out.str(id);
            write_meta(out, m);
        }
        Some(STATUS_OK)
    })
}

#[no_mangle]
pub extern "C" fn ls_render_take(handle: u32, out: u32, len: u32) -> i32 {
    match handles().get(handle) {
        Some(s) => take(&mut s.out, out, len),
        None => STATUS_BAD_ARGUMENT,
    }
}
