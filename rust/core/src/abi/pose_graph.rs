//! Pose-graph relaxation (`src/core/pose-graph.ts::PoseGraph.optimize`), backed by `crate::pose_graph`. One
//! stateful handle per `optimize()` call: `ls_pose_graph_new` copies the node/edge arrays the adapter built from
//! its `Map` iteration order into a Rust-owned `Graph`, `ls_pose_graph_pass` runs one Gauss-Seidel sweep (so the
//! adapter can `await` its stop-checkpoint between sweeps — see pose-graph.ts's `optimize()`), and
//! `ls_pose_graph_residual`/`ls_pose_graph_read` drain the final state before `ls_pose_graph_free`.
//!
//! All five node/edge arrays are plain little-endian buffers, no packed descriptor: `xs`/`ys` (f64 × node_count),
//! `pinned` (u8 × node_count, 0/1), `offsets` (u32 × (node_count + 1), CSR row starts into the edge arrays) and
//! `other`/`dx`/`dy`/`weight` (i32/f64/f64/f64 × edge_count, `other` a node index or −1 for "not found").

use crate::abi::memory::{slice, slice_mut, HandleTable};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::pose_graph::{Edge, Graph, Node};

static mut HANDLES: HandleTable<Graph> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Graph> {
    // SAFETY: only the main instance touches HANDLES, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

/// Bytes read from adapter memory are little-endian on every target this project builds for; a byte reinterpret
/// avoids a per-element copy loop. `ls_alloc`'s 8-byte alignment guarantees every pointer the adapter hands us is
/// `f64`-aligned (and therefore `i32`/`u32`-aligned too).
fn as_f64_slice(bytes: &[u8]) -> &[f64] {
    // SAFETY: `bytes` is 8-byte aligned and was bounds-checked by `slice()`; reinterpreting it as `f64` reads the
    // same little-endian bytes `f64::from_le_bytes` would, and does not outlive `bytes`.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const f64, bytes.len() / 8) }
}
fn as_u32_slice(bytes: &[u8]) -> &[u32] {
    // SAFETY: as `as_f64_slice`, 4-byte aligned.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u32, bytes.len() / 4) }
}
fn as_i32_slice(bytes: &[u8]) -> &[i32] {
    // SAFETY: as `as_f64_slice`, 4-byte aligned.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const i32, bytes.len() / 4) }
}

/// Builds a graph from the adapter's node/edge arrays (layout in the module doc comment) and returns a handle
/// (> 0) or a negative status. Copies everything into the handle's own `Vec`s; retains no adapter pointer.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_pose_graph_new(
    xs: u32,
    ys: u32,
    pinned: u32,
    node_count: u32,
    offsets: u32,
    other: u32,
    dx: u32,
    dy: u32,
    weight: u32,
    edge_count: u32,
) -> i32 {
    let n = node_count as usize;
    let m = edge_count as usize;
    // SAFETY: every buffer is adapter-owned and bounds-checked by `slice` below before use.
    let built = (|| unsafe {
        let xs = as_f64_slice(slice(xs, n * 8)?);
        let ys = as_f64_slice(slice(ys, n * 8)?);
        let pinned = slice(pinned, n)?;
        let offsets = as_u32_slice(slice(offsets, (n + 1) * 4)?);
        let other = as_i32_slice(slice(other, m * 4)?);
        let dx = as_f64_slice(slice(dx, m * 8)?);
        let dy = as_f64_slice(slice(dy, m * 8)?);
        let weight = as_f64_slice(slice(weight, m * 8)?);
        // `offsets` must be non-decreasing and terminate exactly at `m` (CSR row starts into the edge arrays),
        // and every `other` index must be either the "not found" sentinel or an in-range node index — `pass`/
        // `residual` index `self.nodes[e.other as usize]` and `self.edges[start..end]` with no further bounds
        // check, so a malformed descriptor must be rejected here rather than let those index/slice.
        if offsets[n] as usize != m || offsets.windows(2).any(|w| w[1] < w[0]) {
            return None;
        }
        if other.iter().any(|&o| o >= n as i32) {
            return None;
        }
        let nodes = (0..n)
            .map(|i| Node {
                x: xs[i],
                y: ys[i],
                pinned: pinned[i] != 0,
            })
            .collect();
        let edges = (0..m)
            .map(|i| Edge {
                other: other[i],
                dx: dx[i],
                dy: dy[i],
                weight: weight[i],
            })
            .collect();
        Some(Graph {
            nodes,
            offsets: offsets.to_vec(),
            edges,
        })
    })();
    match built {
        Some(graph) => handles().insert(graph),
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Attempts the exact simple-cycle solution. Returns 1 when solved, 0 when the general solver is needed.
#[no_mangle]
pub extern "C" fn ls_pose_graph_solve_cycle(handle: u32) -> i32 {
    match handles().get(handle) {
        Some(graph) => graph.solve_cycle() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// One Gauss-Seidel sweep (`crate::pose_graph::Graph::pass`); returns the largest single-node displacement, or a
/// negative sentinel (`f64::MIN`, never a real displacement) on a bad handle.
#[no_mangle]
pub extern "C" fn ls_pose_graph_pass(handle: u32, reverse: u32) -> f64 {
    match handles().get(handle) {
        Some(graph) => graph.pass(reverse != 0),
        None => f64::MIN,
    }
}

/// Largest edge residual over the current positions (`crate::pose_graph::Graph::residual`); `f64::MIN` on a bad
/// handle.
#[no_mangle]
pub extern "C" fn ls_pose_graph_residual(handle: u32) -> f64 {
    match handles().get(handle) {
        Some(graph) => graph.residual(),
        None => f64::MIN,
    }
}

/// Writes the current `x`/`y` of every node (`node_count` × f64 each) to `xs_out`/`ys_out`.
#[no_mangle]
pub extern "C" fn ls_pose_graph_read(handle: u32, xs_out: u32, ys_out: u32) -> i32 {
    let Some(graph) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = graph.nodes.len();
    // SAFETY: adapter-owned output, sized from the node count it already knows (it built this same handle).
    let (Some(xs), Some(ys)) = (
        (unsafe { slice_mut(xs_out, n * 8) }),
        (unsafe { slice_mut(ys_out, n * 8) }),
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (i, node) in graph.nodes.iter().enumerate() {
        xs[i * 8..i * 8 + 8].copy_from_slice(&node.x.to_le_bytes());
        ys[i * 8..i * 8 + 8].copy_from_slice(&node.y.to_le_bytes());
    }
    crate::abi::STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_pose_graph_free(handle: u32) {
    handles().free(handle);
}
