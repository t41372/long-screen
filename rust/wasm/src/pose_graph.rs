//! The solve and render passes' pose graph (`long_screen_engine::pose_graph::PoseGraph`), one handle per
//! `src/core/pose-graph.ts` instance. Inputs and results are `bytes.rs` records:
//!
//! - node: str id, str canvasId, u32 frame, f64 x, y, originalX, originalY, u8 pinned, u8 has next, [str next]
//! - edge: str other, f64 dx, dy, weight, u8 kind (0 odometry, 1 loop)
//! - writes: u32 count, then per write u8 (0 put, 1 putMany), u32 rows, then per row u8 0 + node, or u8 1 + str
//!   owner id + edge
//!
//! A call that produces a result returns its byte length (or a negative status) and leaves it in the handle;
//! `ls_pose_graph_take` copies it into an adapter buffer of that length.

use crate::bytes::{Cursor, Out};
use crate::memory::{slice, slice_mut, HandleTable};
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen_engine::pose_graph::{
    EdgeKind, Optimizer, PoseEdge, PoseGraph, PoseGraphError, PoseNode, PoseRow, Write,
};

/// `add` was given a previous node the graph does not hold.
pub const STATUS_MISSING_PREVIOUS: i32 = -2;
/// `connect` or `unpin` named a node the graph does not hold.
pub const STATUS_MISSING_NODE: i32 = -3;
/// `correction` named a node the graph does not hold.
pub const STATUS_MISSING_POSE: i32 = -4;

struct Session {
    graph: PoseGraph,
    optimizer: Option<Optimizer>,
    out: Vec<u8>,
}

static mut HANDLES: HandleTable<Session> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches HANDLES, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

pub(crate) fn status(error: PoseGraphError) -> i32 {
    match error {
        PoseGraphError::MissingPrevious => STATUS_MISSING_PREVIOUS,
        PoseGraphError::MissingNode => STATUS_MISSING_NODE,
        PoseGraphError::MissingPose => STATUS_MISSING_POSE,
    }
}

pub(crate) fn read_node(c: &mut Cursor) -> Option<PoseNode> {
    Some(PoseNode {
        id: c.str()?.to_string(),
        canvas_id: c.str()?.to_string(),
        frame: c.u32()?,
        x: c.f64()?,
        y: c.f64()?,
        original_x: c.f64()?,
        original_y: c.f64()?,
        pinned: c.bool()?,
        next: if c.bool()? {
            Some(c.str()?.to_string())
        } else {
            None
        },
    })
}

fn kind(byte: u8) -> Option<EdgeKind> {
    match byte {
        0 => Some(EdgeKind::Odometry),
        1 => Some(EdgeKind::Loop),
        _ => None,
    }
}

fn read_edge(c: &mut Cursor) -> Option<PoseEdge> {
    Some(PoseEdge {
        other: c.str()?.to_string(),
        dx: c.f64()?,
        dy: c.f64()?,
        weight: c.f64()?,
        kind: kind(c.u8()?)?,
    })
}

fn write_node(out: &mut Out, n: &PoseNode) {
    out.str(&n.id);
    out.str(&n.canvas_id);
    out.u32(n.frame);
    out.f64(n.x);
    out.f64(n.y);
    out.f64(n.original_x);
    out.f64(n.original_y);
    out.bool(n.pinned);
    out.bool(n.next.is_some());
    if let Some(next) = &n.next {
        out.str(next);
    }
}

fn write_row(out: &mut Out, row: &PoseRow) {
    match row {
        PoseRow::Node(n) => {
            out.u8(0);
            write_node(out, n);
        }
        PoseRow::Edge { from, edge } => {
            out.u8(1);
            out.str(from);
            out.str(&edge.other);
            out.f64(edge.dx);
            out.f64(edge.dy);
            out.f64(edge.weight);
            out.u8((edge.kind == EdgeKind::Loop) as u8);
        }
    }
}

pub(crate) fn write_writes(out: &mut Out, writes: &[Write]) {
    out.u32(writes.len() as u32);
    for w in writes {
        let rows = match w {
            Write::Put(row) => {
                out.u8(0);
                std::slice::from_ref(row)
            }
            Write::PutMany(rows) => {
                out.u8(1);
                rows.as_slice()
            }
        };
        out.u32(rows.len() as u32);
        for row in rows {
            write_row(out, row);
        }
    }
}

/// Runs `f` on the session and the adapter's input record; `f` fills a result and returns its status. Returns the
/// result's length (left in the session for `ls_pose_graph_take`) or a negative status.
fn call(
    handle: u32,
    input: u32,
    len: u32,
    f: impl FnOnce(&mut Session, &mut Cursor, &mut Out) -> Option<i32>,
) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned input, bounds-checked by `slice`.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut out = Out::default();
    match f(session, &mut Cursor::new(bytes), &mut out) {
        Some(STATUS_OK) => {
            session.out = out.0;
            session.out.len() as i32
        }
        Some(error) => error,
        None => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_pose_graph_new() -> i32 {
    handles().insert(Session {
        graph: PoseGraph::new(),
        optimizer: None,
        out: Vec::new(),
    })
}

/// A handle for a graph built elsewhere (the solve session hands its graph over when the pass ends).
pub(crate) fn adopt(graph: PoseGraph) -> i32 {
    handles().insert(Session {
        graph,
        optimizer: None,
        out: Vec::new(),
    })
}

#[no_mangle]
pub extern "C" fn ls_pose_graph_free(handle: u32) {
    handles().free(handle);
}

/// Copies the last result (`len` bytes, as that call returned) into `out`.
#[no_mangle]
pub extern "C" fn ls_pose_graph_take(handle: u32, out: u32, len: u32) -> i32 {
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

/// Takes back stored rows: u32 count, then per row u8 0 + node, or u8 1 + str key + edge.
#[no_mangle]
pub extern "C" fn ls_pose_graph_hydrate(handle: u32, input: u32, len: u32) -> i32 {
    let status = call(handle, input, len, |s, c, _| {
        for _ in 0..c.u32()? {
            match c.u8()? {
                0 => s.graph.hydrate_node(read_node(c)?),
                1 => {
                    let key = c.str()?;
                    let edge = read_edge(c)?;
                    s.graph.hydrate_edge(key, edge);
                }
                _ => return None,
            }
        }
        Some(STATUS_OK)
    });
    status.min(STATUS_OK)
}

/// Input: str canvasId, u32 frame, f64 x, f64 y, f64 weight, u8 has previous, [str previous id].
/// Result: the new node, then the writes.
#[no_mangle]
pub extern "C" fn ls_pose_graph_add(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, out| {
        let canvas = c.str()?;
        let frame = c.u32()?;
        let (x, y, weight) = (c.f64()?, c.f64()?, c.f64()?);
        let previous = if c.bool()? { Some(c.str()?) } else { None };
        Some(match s.graph.add(canvas, frame, (x, y), previous, weight) {
            Ok((node, writes)) => {
                write_node(out, &node);
                write_writes(out, &writes);
                STATUS_OK
            }
            Err(e) => status(e),
        })
    })
}

/// Input: str a, str b, f64 dx, dy, weight, u8 kind. Result: the writes.
#[no_mangle]
pub extern "C" fn ls_pose_graph_connect(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, out| {
        let (a, b) = (c.str()?, c.str()?);
        let (dx, dy, weight) = (c.f64()?, c.f64()?, c.f64()?);
        let kind = kind(c.u8()?)?;
        Some(match s.graph.connect(a, b, dx, dy, weight, kind) {
            Ok(writes) => {
                write_writes(out, &writes);
                STATUS_OK
            }
            Err(e) => status(e),
        })
    })
}

/// Input: str id. Result: the writes.
#[no_mangle]
pub extern "C" fn ls_pose_graph_unpin(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, out| {
        Some(match s.graph.unpin(c.str()?) {
            Ok(writes) => {
                write_writes(out, &writes);
                STATUS_OK
            }
            Err(e) => status(e),
        })
    })
}

/// Input: str id. Result: the node, or nothing (length 0) when the graph does not hold it.
#[no_mangle]
pub extern "C" fn ls_pose_graph_get(handle: u32, input: u32, len: u32) -> i32 {
    call(handle, input, len, |s, c, out| {
        if let Some(node) = s.graph.get(c.str()?) {
            write_node(out, node);
        }
        Some(STATUS_OK)
    })
}

/// Input: str id. Writes f64 x, f64 y to `out` (16 bytes); returns a status.
#[no_mangle]
pub extern "C" fn ls_pose_graph_correction(
    handle: u32,
    input: u32,
    len: u32,
    frame: f64,
    out: u32,
) -> i32 {
    let mut correction = (0.0, 0.0);
    let status = call(handle, input, len, |s, c, _| {
        Some(match s.graph.correction(c.str()?, frame) {
            Ok(xy) => {
                correction = xy;
                STATUS_OK
            }
            Err(e) => status(e),
        })
    });
    if status < 0 {
        return status;
    }
    // SAFETY: adapter-owned 16-byte output.
    let Some(dst) = (unsafe { slice_mut(out, 16) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..8].copy_from_slice(&correction.0.to_le_bytes());
    dst[8..16].copy_from_slice(&correction.1.to_le_bytes());
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_pose_graph_loops(handle: u32) -> i32 {
    match handles().get(handle) {
        Some(s) => s.graph.loops() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Starts a relaxation. Returns 1 when one started, 0 when the graph holds no loop edge (nothing to relax).
#[no_mangle]
pub extern "C" fn ls_pose_graph_optimize_begin(handle: u32) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    s.optimizer = s.graph.begin_optimize();
    s.optimizer.is_some() as i32
}

/// Runs up to `sweeps` sweeps of the running relaxation. Returns 1 when it is done, 0 when more steps remain.
#[no_mangle]
pub extern "C" fn ls_pose_graph_optimize_step(handle: u32, sweeps: u32) -> i32 {
    match handles().get(handle).and_then(|s| s.optimizer.as_mut()) {
        Some(optimizer) => optimizer.step(sweeps) as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Writes a finished relaxation back. Result: f64 residual, u32 iterations, then the writes.
#[no_mangle]
pub extern "C" fn ls_pose_graph_optimize_finish(handle: u32) -> i32 {
    let Some(s) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(optimizer) = s.optimizer.take_if(|o| o.is_done()) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (outcome, writes) = s.graph.finish_optimize(optimizer);
    let mut out = Out::default();
    out.f64(outcome.residual);
    out.u32(outcome.iterations);
    write_writes(&mut out, &writes);
    s.out = out.0;
    s.out.len() as i32
}

/// Drops a running relaxation without writing anything back (a stop between steps).
#[no_mangle]
pub extern "C" fn ls_pose_graph_optimize_cancel(handle: u32) {
    if let Some(s) = handles().get(handle) {
        s.optimizer = None;
    }
}
