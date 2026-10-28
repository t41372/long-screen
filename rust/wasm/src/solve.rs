//! The solve pass's session (`long_screen::engine::solve::SolveSession`), one handle per `src/core/wasm/solve.ts`
//! instance. Inputs and results are `bytes.rs` records:
//!
//! - region (`ls_solve_new`): str id, str name, str kind, u8 moving, u8 unassigned, u8 code, u32 epochs and per
//!   epoch u32 first frame, u32 n + rects (its extra exclusions), u32 n + rects (its candidate sticky blocks), u8
//!   nested and, when set, the footprint rect, u8 open sides, str parent canvas, u32 n + per frame u8 present, f64 x, f64 y (the
//!   parent's pose); its shape is the matching `VOTING_REGION_BYTES` descriptor.
//! - feature: i32 x, i32 y, f64 score, 8 × u32 descriptor
//! - keyframe: str id, node, canvasId, layer, u32 frame, u32 n + features, u32 width, u32 height, blob gray,
//!   f64 x, y, scaleX, scaleY, u32 n + patches (f64 x, f64 y, u32 size, blob data)
//! - placement: str layer, canvasId, node, f64 x, y, confidence, u8 uncertain, f64 time, u8 skip, u32 n + rects
//! - poll: u8 0 + u32 n + str ids (keyframes wanted), or u8 1 + u32 n + placements, u8 joined, voting records
//! - voting record: u32 index, voted layers, thin layers, u32 n + (str region, i32 x0, y0, w, h, blob bits,
//!   blob clean)
//! - effects: u32 n, then per effect a u8 tag (0 canvas, 1 attachment, 2 keyframe, 3 graph write, 4 diagnostic in
//!   `diagnostic.rs`'s form, 5 nested container found, 6 nested container's moment, 7 nested container rejected) and its fields (see
//!   `write_effect`)
//!
//! A call that produces a result returns its byte length (or a negative status) and leaves it in the handle;
//! `ls_solve_take` copies it out. A failed step still leaves its effects for `ls_solve_effects`.

use crate::bytes::{Cursor, Out};
use crate::memory::{slice, slice_mut, HandleTable};
use crate::pose_graph::{status as graph_status, write_writes};
use crate::voting::read_voting_regions;
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen::engine::solve::{
    Begin, Effect, KeyPatch, Keyframe, Nest, Placement, Plane, Poll, ScanFields, SolveConfig,
    SolveError, SolveRegion, SolveSession, VotingRecord, VOTING_RING_BYTES,
};
use long_screen::kernels::features::{Feature, DESCRIPTOR_WORDS};
use long_screen::kernels::geometry::Rect;
use long_screen::kernels::regions::RegionEpoch;
use std::sync::Arc;

struct Session {
    solve: SolveSession,
    out: Vec<u8>,
}

static mut HANDLES: HandleTable<Session> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches HANDLES, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

fn status(error: SolveError) -> i32 {
    match error {
        SolveError::Graph(e) => graph_status(e),
        SolveError::BadInput(_) => STATUS_BAD_ARGUMENT,
    }
}

fn read_feature(c: &mut Cursor) -> Option<Feature> {
    let (x, y, score) = (c.i32()?, c.i32()?, c.f64()?);
    let mut descriptor = [0u32; DESCRIPTOR_WORDS];
    for d in &mut descriptor {
        *d = c.u32()?;
    }
    Some(Feature {
        x,
        y,
        score,
        descriptor,
    })
}

fn write_feature(out: &mut Out, f: &Feature) {
    out.i32(f.x);
    out.i32(f.y);
    out.f64(f.score);
    for &d in &f.descriptor {
        out.u32(d);
    }
}

fn read_keyframe(c: &mut Cursor) -> Option<Keyframe> {
    let (id, node, canvas_id, layer) = (c.str()?, c.str()?, c.str()?, c.str()?);
    let frame = c.u32()?;
    let features = (0..c.u32()?)
        .map(|_| read_feature(c))
        .collect::<Option<Vec<_>>>()?;
    let (width, height) = (c.u32()? as usize, c.u32()? as usize);
    let data = c.blob()?.to_vec();
    if data.len() != width * height {
        return None;
    }
    let (x, y, scale_x, scale_y) = (c.f64()?, c.f64()?, c.f64()?, c.f64()?);
    let patches = (0..c.u32()?)
        .map(|_| {
            let (x, y, size) = (c.f64()?, c.f64()?, c.u32()? as usize);
            let data = c.blob()?.to_vec();
            (data.len() == size * size).then_some(KeyPatch { x, y, size, data })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Keyframe {
        id: id.to_string(),
        node: node.to_string(),
        canvas_id: canvas_id.to_string(),
        layer: layer.to_string(),
        frame,
        features,
        gray: Arc::new(Plane {
            width,
            height,
            data,
        }),
        x,
        y,
        scale_x,
        scale_y,
        patches,
    })
}

fn write_keyframe(out: &mut Out, k: &Keyframe) {
    out.str(&k.id);
    out.str(&k.node);
    out.str(&k.canvas_id);
    out.str(&k.layer);
    out.u32(k.frame);
    out.u32(k.features.len() as u32);
    for f in &k.features {
        write_feature(out, f);
    }
    out.u32(k.gray.width as u32);
    out.u32(k.gray.height as u32);
    out.blob(&k.gray.data);
    out.f64(k.x);
    out.f64(k.y);
    out.f64(k.scale_x);
    out.f64(k.scale_y);
    out.u32(k.patches.len() as u32);
    for p in &k.patches {
        out.f64(p.x);
        out.f64(p.y);
        out.u32(p.size as u32);
        out.blob(&p.data);
    }
}

fn write_rect(out: &mut Out, r: &Rect) {
    out.f64(r.x);
    out.f64(r.y);
    out.f64(r.width);
    out.f64(r.height);
}

fn write_placements(out: &mut Out, placements: &[Placement]) {
    out.u32(placements.len() as u32);
    for p in placements {
        out.str(&p.layer);
        out.str(&p.canvas_id);
        out.str(&p.node);
        out.f64(p.x);
        out.f64(p.y);
        out.f64(p.confidence);
        out.bool(p.uncertain);
        out.f64(p.time);
        out.bool(p.skip);
        out.u32(p.occlusions.len() as u32);
        for r in &p.occlusions {
            write_rect(out, r);
        }
        out.bool(p.clip.is_some());
        if let Some(clip) = &p.clip {
            write_rect(out, clip);
        }
    }
}

fn write_voting(out: &mut Out, records: &[VotingRecord]) {
    out.u32(records.len() as u32);
    for r in records {
        out.u32(r.index);
        out.u32(r.voted_layers);
        out.u32(r.thin_layers);
        out.u32(r.verdicts.len() as u32);
        for v in &r.verdicts {
            out.str(&v.region);
            out.i32(v.x0);
            out.i32(v.y0);
            out.i32(v.w);
            out.i32(v.h);
            out.blob(&v.bits);
            out.blob(&v.clean);
        }
    }
}

fn write_poll(out: &mut Out, poll: &Poll) {
    match poll {
        Poll::NeedKeyframes(ids) => {
            out.u8(0);
            out.u32(ids.len() as u32);
            for id in ids {
                out.str(id);
            }
        }
        Poll::Done(done) => {
            out.u8(1);
            write_placements(out, &done.placements);
            out.bool(done.joined_ring);
            write_voting(out, &done.voting);
        }
    }
}

fn write_attachment(out: &mut Out, a: &long_screen::engine::attachments::Attachment) {
    out.str(&a.id);
    out.str(&a.target);
    out.f64(a.dx);
    out.f64(a.dy);
    out.u32(a.frame);
    out.f64(a.confidence);
    out.str(&a.node);
}

fn write_effect(out: &mut Out, effect: &Effect) {
    match effect {
        Effect::Canvas { meta, created } => {
            out.u8(0);
            out.bool(*created);
            out.str(&meta.id);
            out.str(&meta.layer);
            out.str(&meta.name);
            out.str(&meta.kind);
            out.u32(meta.fragment);
            out.f64(meta.first_time);
            out.f64(meta.last_time);
            out.bool(meta.attached_to.is_some());
            if let Some(target) = &meta.attached_to {
                out.str(target);
            }
        }
        Effect::Attachment(a) => {
            out.u8(1);
            write_attachment(out, a);
        }
        Effect::Keyframe(k) => {
            out.u8(2);
            write_keyframe(out, k);
        }
        Effect::Graph(w) => {
            out.u8(3);
            write_writes(out, std::slice::from_ref(w));
        }
        Effect::Diagnostic(d) => {
            out.u8(4);
            crate::diagnostic::write_diagnostic(out, d);
        }
        Effect::CanvasDropped(id) => {
            out.u8(8);
            out.str(id);
        }
        Effect::Nested(n) => {
            out.u8(5);
            out.str(&n.region);
            out.str(&n.canvas);
            write_rect(out, &n.footprint);
            out.u8(n.open);
        }
        Effect::NestedRejected { region } => {
            out.u8(7);
            out.str(region);
        }
        Effect::NestedMoment { region, frames } => {
            out.u8(6);
            out.str(region);
            out.u32(frames.len() as u32);
            for (frame, clip) in frames {
                out.u32(*frame);
                write_rect(out, clip);
            }
        }
    }
}

/// Leaves `out` in the session and returns its length.
fn finish(session: &mut Session, out: Out) -> i32 {
    session.out = out.0;
    session.out.len() as i32
}

fn poll_result(session: &mut Session, poll: Result<Poll, SolveError>) -> i32 {
    match poll {
        Ok(poll) => {
            let mut out = Out::default();
            write_poll(&mut out, &poll);
            finish(session, out)
        }
        Err(e) => status(e),
    }
}

/// # Safety
/// `labels` points at `len` readable bytes (the atlas label plane).
unsafe fn labels<'a>(ptr: u32, len: usize) -> Option<&'a [u8]> {
    slice(ptr, len)
}

/// Creates a session. `input`: u32 width, height, factor, i32 radius, f64 noise, u32 region count, then the
/// regions; `shapes` holds one `VOTING_REGION_BYTES` descriptor per region. Returns a handle or a negative status.
#[no_mangle]
pub extern "C" fn ls_solve_new(input: u32, len: u32, shapes: u32) -> i32 {
    // SAFETY: adapter-owned input, bounds-checked by `slice`.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut c = Cursor::new(bytes);
    let config = (|| {
        let (width, height, factor) = (c.u32()? as usize, c.u32()? as usize, c.u32()?);
        let (radius, noise, count) = (c.i32()?, c.f64()?, c.u32()?);
        // SAFETY: adapter-owned descriptors, bounds checked.
        let shapes = unsafe { read_voting_regions(shapes, count) }?;
        let mut regions = Vec::with_capacity(count as usize);
        for shape in shapes {
            let (id, name, kind) = (c.str()?, c.str()?, c.str()?);
            let (moving, unassigned, code) = (c.bool()?, c.bool()?, c.u8()?);
            let epochs = (0..c.u32()?)
                .map(|_| {
                    let from = c.u32()?;
                    let exclusions = (0..c.u32()?)
                        .map(|_| {
                            Some(Rect {
                                x: c.f64()?,
                                y: c.f64()?,
                                width: c.f64()?,
                                height: c.f64()?,
                            })
                        })
                        .collect::<Option<_>>()?;
                    Some(RegionEpoch { from, exclusions })
                })
                .collect::<Option<_>>()?;
            let mut sticky = Vec::new();
            for _ in 0..c.u32()? {
                let (x, y, width, height) = (c.f64()?, c.f64()?, c.f64()?, c.f64()?);
                sticky.push(Rect {
                    x,
                    y,
                    width,
                    height,
                });
            }
            let nest = if c.bool()? {
                let footprint = Rect {
                    x: c.f64()?,
                    y: c.f64()?,
                    width: c.f64()?,
                    height: c.f64()?,
                };
                let open = c.u8()?;
                let canvas = c.str()?.to_string();
                let parent_poses = (0..c.u32()?)
                    .map(|_| {
                        let present = c.bool()?;
                        let pose = (c.f64()?, c.f64()?);
                        Some(present.then_some(pose))
                    })
                    .collect::<Option<_>>()?;
                Some(Nest {
                    canvas,
                    footprint,
                    open,
                    parent_poses,
                })
            } else {
                None
            };
            regions.push(SolveRegion {
                id: id.to_string(),
                name: name.to_string(),
                kind: kind.to_string(),
                moving,
                unassigned,
                code,
                shape,
                epochs,
                sticky,
                nest,
            });
        }
        (width > 0 && height > 0).then_some(SolveConfig {
            width,
            height,
            factor,
            radius,
            noise,
            voting_budget: VOTING_RING_BYTES,
            regions,
        })
    })();
    match config {
        Some(config) => handles().insert(Session {
            solve: SolveSession::new(config),
            out: Vec::new(),
        }),
        None => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_solve_free(handle: u32) {
    handles().free(handle);
}

/// Copies the last result (`len` bytes, as that call returned) into `out`.
#[no_mangle]
pub extern "C" fn ls_solve_take(handle: u32, out: u32, len: u32) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if session.out.len() != len as usize {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned output of the length it was told.
    let Some(dst) = (unsafe { slice_mut(out, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(&session.out);
    session.out = Vec::new();
    STATUS_OK
}

/// Starts a frame. Result: u8 0 + placements (a duplicate frame's replayed plan), or u8 1 + u8 gray wanted.
#[no_mangle]
pub extern "C" fn ls_solve_begin(
    handle: u32,
    index: u32,
    time: f64,
    duplicate: u32,
    zoom: f64,
    difference: f64,
) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let scan = ScanFields {
        duplicate: duplicate != 0,
        zoom,
        difference,
    };
    match session.solve.begin_frame(index, time, scan) {
        Ok(begin) => {
            let mut out = Out::default();
            match begin {
                Begin::Duplicate(placements) => {
                    out.u8(0);
                    write_placements(&mut out, &placements);
                }
                Begin::NeedFrame { gray } => {
                    out.u8(1);
                    out.bool(gray);
                }
            }
            finish(session, out)
        }
        Err(e) => status(e),
    }
}

/// Where the frame `ls_solve_begin` asked for is written (`width × height × 4` bytes); 0 for a bad handle.
#[no_mangle]
pub extern "C" fn ls_solve_frame(handle: u32) -> u32 {
    handles()
        .get(handle)
        .map_or(0, |s| s.solve.frame_mut().as_ptr() as u32)
}

/// Solves the written frame. `gray` (0 = none) holds `gray_len` analysis bytes; `features` (0 = none) holds
/// `feature_count` features as i16 x/y pairs, then f32 scores, then 8 u32 descriptors each; `labels` is the atlas
/// label plane. Result: the poll.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_solve_run(
    handle: u32,
    gray: u32,
    gray_len: u32,
    features: u32,
    feature_count: u32,
    labels_ptr: u32,
) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let plane = session.solve.width() * session.solve.height();
    // SAFETY: adapter-owned buffers, bounds checked.
    let Some(labels) = (unsafe { labels(labels_ptr, plane) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let gray = if gray == 0 {
        None
    } else {
        // SAFETY: as above.
        match unsafe { slice(gray, gray_len as usize) } {
            Some(bytes) => Some(bytes.to_vec()),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let features = if features == 0 {
        None
    } else {
        let n = feature_count as usize;
        // SAFETY: as above: n × (4 + 4 + 32) bytes.
        let Some(bytes) = (unsafe { slice(features, n * (4 + 4 + DESCRIPTOR_WORDS * 4)) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        let (xy, rest) = bytes.split_at(n * 4);
        let (scores, descriptors) = rest.split_at(n * 4);
        Some(
            (0..n)
                .map(|i| {
                    let mut descriptor = [0u32; DESCRIPTOR_WORDS];
                    for (k, d) in descriptor.iter_mut().enumerate() {
                        let at = (i * DESCRIPTOR_WORDS + k) * 4;
                        *d = u32::from_le_bytes(descriptors[at..at + 4].try_into().unwrap());
                    }
                    Feature {
                        x: i16::from_le_bytes(xy[i * 4..i * 4 + 2].try_into().unwrap()) as i32,
                        y: i16::from_le_bytes(xy[i * 4 + 2..i * 4 + 4].try_into().unwrap()) as i32,
                        score: f32::from_le_bytes(scores[i * 4..i * 4 + 4].try_into().unwrap())
                            as f64,
                        descriptor,
                    }
                })
                .collect(),
        )
    };
    let poll = session.solve.run_frame(gray, features, labels);
    poll_result(session, poll)
}

/// Hands in the keyframe rows the last poll asked for: u32 n, then per row u8 present + keyframe. Result: the
/// next poll.
#[no_mangle]
pub extern "C" fn ls_solve_provide(handle: u32, input: u32, len: u32, labels_ptr: u32) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let plane = session.solve.width() * session.solve.height();
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(bytes), Some(labels)) = (unsafe { slice(input, len as usize) }, unsafe {
        labels(labels_ptr, plane)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut c = Cursor::new(bytes);
    let rows = (|| {
        (0..c.u32()?)
            .map(|_| {
                if c.bool()? {
                    read_keyframe(&mut c).map(Some)
                } else {
                    Some(None)
                }
            })
            .collect::<Option<Vec<_>>>()
    })();
    let Some(rows) = rows else {
        return STATUS_BAD_ARGUMENT;
    };
    let poll = session.solve.provide_keyframes(rows, labels);
    poll_result(session, poll)
}

/// The effects produced since the last call. Result: the effects.
#[no_mangle]
pub extern "C" fn ls_solve_effects(handle: u32) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let effects = session.solve.take_effects();
    let mut out = Out::default();
    out.u32(effects.len() as u32);
    for e in &effects {
        write_effect(&mut out, e);
    }
    finish(session, out)
}

/// Finalises every frame still in the voting ring. Result: the voting records.
#[no_mangle]
pub extern "C" fn ls_solve_drain(handle: u32) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let records = session.solve.drain_voting();
    let mut out = Out::default();
    write_voting(&mut out, &records);
    finish(session, out)
}

/// How many frames the session's nested containers need (`SolveSession::nested_until`); -1 for a session without
/// them or a bad handle.
#[no_mangle]
pub extern "C" fn ls_solve_nested_until(handle: u32) -> i32 {
    handles()
        .get(handle)
        .and_then(|s| s.solve.nested_until())
        .map_or(-1, |n| n as i32)
}

/// How many nested containers the session would report now (`SolveSession::nested_candidates`); 0 for a bad handle.
#[no_mangle]
pub extern "C" fn ls_solve_nested_candidates(handle: u32) -> u32 {
    handles()
        .get(handle)
        .map_or(0, |s| s.solve.nested_candidates() as u32)
}

/// Moves the session's pose graph into a pose-graph handle (`ls_pose_graph_*`); returns that handle.
#[no_mangle]
pub extern "C" fn ls_solve_take_graph(handle: u32) -> i32 {
    match handles().get(handle) {
        Some(session) => crate::pose_graph::adopt(session.solve.take_graph()),
        None => STATUS_BAD_ARGUMENT,
    }
}
