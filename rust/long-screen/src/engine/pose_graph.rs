//! The solve pass's pose graph as a state object: keyframe nodes, odometry and loop edges, the loop-closure error
//! spread along a chain, the resumable relaxation, and the render pass's per-frame correction.
//!
//! The graph lives in memory, as it did in the TypeScript `PoseGraph` it replaces: every node and its adjacency.
//! It does no I/O. A host that keeps the graph in storage feeds the stored rows back with [`PoseGraph::hydrate_node`]
//! and [`PoseGraph::hydrate_edge`] (all `node/` rows, then all `edge/` rows, in key order), and stores every
//! [`Write`] a call returns, in order: one `put` or one `putMany` each, exactly the calls the page made before.
//! Persisted node rows carry no adjacency; edges are rows of their own (`edge/<a>/<b>/<kind>`), one per direction.
//!
//! Node order is insertion order (hydration first, then [`PoseGraph::add`]); a node added again under an id it
//! already has keeps its place. Relaxation visits nodes in that order, so it is part of the result.
//!
//! [`PoseGraph::begin_optimize`] returns an [`Optimizer`] that runs a few Gauss-Seidel sweeps per
//! [`Optimizer::step`] and does not touch the graph until [`PoseGraph::finish_optimize`] writes the relaxed
//! positions back. A host that stops between steps drops the optimizer: nothing changes and nothing is written.

use crate::kernels::pose_graph::{Edge as SolverEdge, Graph, Node as SolverNode};
use std::collections::HashMap;
use std::fmt;

/// Nodes per `putMany` when a loop closure or a relaxation moves many nodes at once.
pub const FLUSH_CHUNK: usize = 256;
/// Relaxation stops after this many sweeps even when nodes still move.
pub const MAX_SWEEPS: u32 = 200;
/// Relaxation has converged once no node moves farther than this in one sweep.
pub const CONVERGED_CHANGE: f64 = 0.04;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeKind {
    Odometry,
    Loop,
}

impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeKind::Odometry => "odometry",
            EdgeKind::Loop => "loop",
        }
    }
}

/// One direction of an edge, as stored under `edge/<a>/<other>/<kind>`: the measured offset from `a` to `other`.
#[derive(Clone, Debug, PartialEq)]
pub struct PoseEdge {
    pub other: String,
    pub dx: f64,
    pub dy: f64,
    pub weight: f64,
    pub kind: EdgeKind,
}

/// One keyframe's pose, as stored under `node/<id>` (whose value also carries an always-empty `edges` list).
/// `original_*` is the odometry pose it was added at, `x`/`y` its current corrected pose, and `next` the node
/// added after it on the same odometry chain.
#[derive(Clone, Debug, PartialEq)]
pub struct PoseNode {
    pub id: String,
    pub canvas_id: String,
    pub frame: u32,
    pub x: f64,
    pub y: f64,
    pub original_x: f64,
    pub original_y: f64,
    pub pinned: bool,
    pub next: Option<String>,
}

/// A row to store.
#[derive(Clone, Debug, PartialEq)]
pub enum PoseRow {
    /// Stored under `node/<id>`.
    Node(PoseNode),
    /// Stored under `edge/<from>/<edge.other>/<edge.kind>`.
    Edge { from: String, edge: PoseEdge },
}

impl PoseRow {
    pub fn key(&self) -> String {
        match self {
            PoseRow::Node(node) => format!("node/{}", node.id),
            PoseRow::Edge { from, edge } => {
                format!("edge/{from}/{}/{}", edge.other, edge.kind.as_str())
            }
        }
    }
}

/// One storage call: a single `put`, or one `putMany` of a batch.
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    Put(PoseRow),
    PutMany(Vec<PoseRow>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoseGraphError {
    /// `add` was given a previous node the graph does not hold.
    MissingPrevious,
    /// `connect` or `unpin` named a node the graph does not hold.
    MissingNode,
    /// `correction` named a node the graph does not hold.
    MissingPose,
}

impl fmt::Display for PoseGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            PoseGraphError::MissingPrevious => "Pose graph references a missing previous node.",
            PoseGraphError::MissingNode => "Pose graph references a missing node.",
            PoseGraphError::MissingPose => "Missing pose for frame rendering.",
        })
    }
}

impl std::error::Error for PoseGraphError {}

/// What a finished relaxation reports (`graph-summary` stores it next to the loop count).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OptimizeOutcome {
    pub residual: f64,
    pub iterations: u32,
}

/// `Math.max(lo, Math.min(hi, n))`, NaN included.
fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    let low = if n.is_nan() || hi.is_nan() {
        f64::NAN
    } else {
        n.min(hi)
    };
    if low.is_nan() || lo.is_nan() {
        f64::NAN
    } else {
        low.max(lo)
    }
}

/// `String(n).padStart(10, '0')`.
fn pad(n: u32) -> String {
    format!("{n:0>10}")
}

/// Splits `node` writes into `putMany` batches of [`FLUSH_CHUNK`]; none for an empty list.
fn flush(rows: Vec<PoseNode>) -> Vec<Write> {
    let mut writes = Vec::new();
    let mut rows = rows.into_iter().map(PoseRow::Node).peekable();
    while rows.peek().is_some() {
        writes.push(Write::PutMany(rows.by_ref().take(FLUSH_CHUNK).collect()));
    }
    writes
}

#[derive(Default)]
pub struct PoseGraph {
    nodes: Vec<PoseNode>,
    index: HashMap<String, usize>,
    /// Keyed by node id, edges in the order they were hydrated or connected. May hold ids no node row exists for
    /// (an edge row whose node row was never written); those edges are kept and only ever looked up by id.
    adjacency: HashMap<String, Vec<PoseEdge>>,
    loops: u32,
}

impl PoseGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Loop edges the graph holds, each counted once.
    pub fn loops(&self) -> u32 {
        self.loops
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The node id for a canvas and frame: `<canvasId>/<frame padded to 10 digits>`.
    pub fn node_id(canvas_id: &str, frame: u32) -> String {
        format!("{canvas_id}/{}", pad(frame))
    }

    pub fn get(&self, id: &str) -> Option<&PoseNode> {
        self.index.get(id).map(|&i| &self.nodes[i])
    }

    fn set(&mut self, node: PoseNode) {
        match self.index.get(&node.id) {
            Some(&i) => self.nodes[i] = node,
            None => {
                self.index.insert(node.id.clone(), self.nodes.len());
                self.nodes.push(node);
            }
        }
    }

    /// Takes back one stored `node/` row.
    pub fn hydrate_node(&mut self, node: PoseNode) {
        self.set(node);
    }

    /// Takes back one stored `edge/` row under its full key; the owning node's id is what the key holds between
    /// `edge/` and `/<other>/<kind>`.
    pub fn hydrate_edge(&mut self, key: &str, edge: PoseEdge) {
        let suffix = edge.other.len() + edge.kind.as_str().len() + 2;
        let from = key
            .get("edge/".len()..key.len().saturating_sub(suffix))
            .unwrap_or("")
            .to_string();
        if edge.kind == EdgeKind::Loop && from < edge.other {
            self.loops += 1;
        }
        self.adjacency.entry(from).or_default().push(edge);
    }

    /// Adds the node for `canvas_id` at `frame`, observed at odometry pose `(x, y)`. With a `previous` node on the
    /// same chain it starts from the correction that node has received so far, links to it with an odometry edge of
    /// `weight` (a step measured on a thin overlap pulls less) and becomes its `next`; without one it is pinned.
    pub fn add(
        &mut self,
        canvas_id: &str,
        frame: u32,
        (x, y): (f64, f64),
        previous: Option<&str>,
        weight: f64,
    ) -> Result<(PoseNode, Vec<Write>), PoseGraphError> {
        let prev = match previous {
            Some(id) => Some(self.get(id).ok_or(PoseGraphError::MissingPrevious)?.clone()),
            None => None,
        };
        let id = Self::node_id(canvas_id, frame);
        let node = PoseNode {
            id: id.clone(),
            canvas_id: canvas_id.to_string(),
            frame,
            x: x + prev.as_ref().map_or(0.0, |p| p.x - p.original_x),
            y: y + prev.as_ref().map_or(0.0, |p| p.y - p.original_y),
            original_x: x,
            original_y: y,
            pinned: prev.is_none(),
            next: None,
        };
        self.set(node.clone());
        let mut writes = vec![Write::Put(PoseRow::Node(node.clone()))];
        if let Some(mut prev) = prev {
            writes.extend(self.connect(
                &prev.id,
                &id,
                x - prev.original_x,
                y - prev.original_y,
                weight,
                EdgeKind::Odometry,
            )?);
            if prev.id == id {
                // The previous node was just replaced under its own id: the page stored the replaced node with
                // its `next` set, and kept the new one in the graph unlinked.
                prev.next = Some(id);
            } else {
                let i = self.index[&prev.id];
                self.nodes[i].next = Some(id);
                prev = self.nodes[i].clone();
            }
            writes.push(Write::Put(PoseRow::Node(prev)));
        }
        Ok((node, writes))
    }

    /// Links `a` to `b` by the offset `(dx, dy)` measured from `a`, once per pair and kind. A loop edge forward
    /// along `a`'s own odometry chain also spreads the closure error over the nodes after `a`, in proportion to
    /// their frame, so relaxation starts near the answer.
    pub fn connect(
        &mut self,
        a_id: &str,
        b_id: &str,
        dx: f64,
        dy: f64,
        weight: f64,
        kind: EdgeKind,
    ) -> Result<Vec<Write>, PoseGraphError> {
        let (Some(&ai), Some(&bi)) = (self.index.get(a_id), self.index.get(b_id)) else {
            return Err(PoseGraphError::MissingNode);
        };
        if a_id == b_id {
            return Ok(Vec::new());
        }
        if self
            .adjacency
            .get(a_id)
            .is_some_and(|list| list.iter().any(|e| e.other == b_id && e.kind == kind))
        {
            return Ok(Vec::new());
        }
        let a_edge = PoseEdge {
            other: b_id.to_string(),
            dx,
            dy,
            weight,
            kind,
        };
        let b_edge = PoseEdge {
            other: a_id.to_string(),
            dx: -dx,
            dy: -dy,
            weight,
            kind,
        };
        self.adjacency
            .entry(a_id.to_string())
            .or_default()
            .push(a_edge.clone());
        self.adjacency
            .entry(b_id.to_string())
            .or_default()
            .push(b_edge.clone());
        let mut writes = vec![Write::PutMany(vec![
            PoseRow::Edge {
                from: a_id.to_string(),
                edge: a_edge,
            },
            PoseRow::Edge {
                from: b_id.to_string(),
                edge: b_edge,
            },
        ])];
        if kind == EdgeKind::Loop {
            self.loops += 1;
            let (a, b) = (&self.nodes[ai], &self.nodes[bi]);
            if a.canvas_id == b.canvas_id && b.frame > a.frame {
                // Walk the actual chain (`next` pointers), not every node on the canvas: relocalization can leave
                // several disjoint chains on one canvas, and only the one the loop edge closes may move.
                let mut chain = Vec::new();
                let mut cur = a.next.clone();
                while let Some(id) = cur {
                    let Some(&i) = self.index.get(&id) else {
                        break;
                    };
                    chain.push(i);
                    cur = self.nodes[i].next.clone();
                }
                if chain.contains(&bi) {
                    let (ax, ay, a_frame) = (a.x, a.y, a.frame as f64);
                    let (cx, cy) = (ax + dx - b.x, ay + dy - b.y);
                    let span = b.frame as f64 - a_frame;
                    let mut touched = Vec::new();
                    for i in chain {
                        let n = &mut self.nodes[i];
                        if n.pinned {
                            continue;
                        }
                        let t = clamp((n.frame as f64 - a_frame) / span, 0.0, 1.0);
                        n.x += cx * t;
                        n.y += cy * t;
                        touched.push(n.clone());
                    }
                    writes.extend(flush(touched));
                }
            }
        }
        Ok(writes)
    }

    /// Lets a node move under relaxation (a relocalized or attached node starts pinned until its loop edge is
    /// wired) and stores it.
    pub fn unpin(&mut self, id: &str) -> Result<Vec<Write>, PoseGraphError> {
        let &i = self.index.get(id).ok_or(PoseGraphError::MissingNode)?;
        self.nodes[i].pinned = false;
        Ok(vec![Write::Put(PoseRow::Node(self.nodes[i].clone()))])
    }

    /// How far relaxation moved the pose at `frame` on the chain through node `id`: that node's correction,
    /// blended towards its `next` node's by how far `frame` lies between them.
    pub fn correction(&self, id: &str, frame: f64) -> Result<(f64, f64), PoseGraphError> {
        let a = self.get(id).ok_or(PoseGraphError::MissingPose)?;
        let (mut x, mut y) = (a.x - a.original_x, a.y - a.original_y);
        if let Some(b) = a.next.as_deref().and_then(|next| self.get(next)) {
            if b.frame > a.frame {
                let t = clamp(
                    (frame - a.frame as f64) / (b.frame as f64 - a.frame as f64),
                    0.0,
                    1.0,
                );
                x = x * (1.0 - t) + (b.x - b.original_x) * t;
                y = y * (1.0 - t) + (b.y - b.original_y) * t;
            }
        }
        Ok((x, y))
    }

    /// Starts relaxing the graph, or returns `None` when it holds no loop edge (nothing to relax: the outcome is
    /// zero residual after zero iterations, and nothing is written).
    pub fn begin_optimize(&self) -> Option<Optimizer> {
        if self.loops == 0 {
            return None;
        }
        let mut offsets = Vec::with_capacity(self.nodes.len() + 1);
        let mut edges = Vec::new();
        let nodes = self
            .nodes
            .iter()
            .map(|n| {
                offsets.push(edges.len() as u32);
                for e in self.adjacency.get(&n.id).map_or(&[][..], Vec::as_slice) {
                    edges.push(SolverEdge {
                        other: self.index.get(&e.other).map_or(-1, |&i| i as i32),
                        dx: e.dx,
                        dy: e.dy,
                        weight: e.weight,
                    });
                }
                SolverNode {
                    x: n.x,
                    y: n.y,
                    pinned: n.pinned,
                }
            })
            .collect();
        offsets.push(edges.len() as u32);
        Some(Optimizer {
            graph: Graph {
                nodes,
                offsets,
                edges,
            },
            tried_cycle: false,
            iterations: 0,
            done: false,
        })
    }

    /// Writes a finished relaxation back: every unpinned node with at least one edge takes its relaxed position
    /// and is stored, in node order, [`FLUSH_CHUNK`] per `putMany`.
    pub fn finish_optimize(&mut self, optimizer: Optimizer) -> (OptimizeOutcome, Vec<Write>) {
        let residual = optimizer.graph.residual();
        let mut moved = Vec::new();
        for (node, relaxed) in self.nodes.iter_mut().zip(&optimizer.graph.nodes) {
            if !node.pinned && self.adjacency.get(&node.id).is_some_and(|l| !l.is_empty()) {
                node.x = relaxed.x;
                node.y = relaxed.y;
                moved.push(node.clone());
            }
        }
        (
            OptimizeOutcome {
                residual,
                iterations: optimizer.iterations,
            },
            flush(moved),
        )
    }
}

/// A relaxation in progress, over a copy of the graph taken by [`PoseGraph::begin_optimize`].
pub struct Optimizer {
    graph: Graph,
    tried_cycle: bool,
    iterations: u32,
    done: bool,
}

impl Optimizer {
    /// Runs up to `sweeps` Gauss-Seidel sweeps (at least one). The first step first tries the exact solution of a
    /// single anchored cycle, which counts as one iteration and finishes at once. Returns whether relaxation is
    /// done: converged, solved exactly, or out of sweeps.
    pub fn step(&mut self, sweeps: u32) -> bool {
        if self.done {
            return true;
        }
        if !self.tried_cycle {
            self.tried_cycle = true;
            if self.graph.solve_cycle() {
                self.iterations = 1;
                self.done = true;
                return true;
            }
        }
        for _ in 0..sweeps.max(1) {
            if self.iterations >= MAX_SWEEPS {
                self.done = true;
                break;
            }
            let change = self.graph.pass(self.iterations % 2 == 1);
            self.iterations += 1;
            if change < CONVERGED_CHANGE || self.iterations >= MAX_SWEEPS {
                self.done = true;
                break;
            }
        }
        self.done
    }

    pub fn iterations(&self) -> u32 {
        self.iterations
    }

    pub fn is_done(&self) -> bool {
        self.done
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes_written(writes: &[Write]) -> Vec<&PoseNode> {
        writes
            .iter()
            .flat_map(|w| match w {
                Write::Put(r) => std::slice::from_ref(r),
                Write::PutMany(rs) => rs.as_slice(),
            })
            .filter_map(|r| match r {
                PoseRow::Node(n) => Some(n),
                PoseRow::Edge { .. } => None,
            })
            .collect()
    }

    fn node(
        id: &str,
        canvas: &str,
        frame: u32,
        x: f64,
        pinned: bool,
        next: Option<&str>,
    ) -> PoseNode {
        PoseNode {
            id: id.into(),
            canvas_id: canvas.into(),
            frame,
            x,
            y: 0.0,
            original_x: x,
            original_y: 0.0,
            pinned,
            next: next.map(Into::into),
        }
    }

    fn run(graph: &mut PoseGraph, sweeps: u32) -> (OptimizeOutcome, Vec<Write>) {
        let Some(mut opt) = graph.begin_optimize() else {
            return (
                OptimizeOutcome {
                    residual: 0.0,
                    iterations: 0,
                },
                Vec::new(),
            );
        };
        while !opt.step(sweeps) {}
        graph.finish_optimize(opt)
    }

    #[test]
    fn add_rejects_a_previous_node_it_does_not_hold() {
        let mut g = PoseGraph::new();
        assert_eq!(
            g.add("c", 1, (1.0, 1.0), Some("ghost"), 1.0).unwrap_err(),
            PoseGraphError::MissingPrevious
        );
        assert!(g.is_empty(), "a rejected add leaves no node behind");
    }

    #[test]
    fn connect_and_unpin_reject_unknown_nodes_and_correction_an_unknown_pose() {
        let mut g = PoseGraph::new();
        g.add("c", 0, (0.0, 0.0), None, 1.0).unwrap();
        let a = PoseGraph::node_id("c", 0);
        assert_eq!(
            g.connect(&a, "ghost", 1.0, 0.0, 1.0, EdgeKind::Loop),
            Err(PoseGraphError::MissingNode)
        );
        assert_eq!(g.unpin("ghost"), Err(PoseGraphError::MissingNode));
        assert_eq!(g.correction("", 3.0), Err(PoseGraphError::MissingPose));
        assert_eq!(g.loops(), 0);
        assert_eq!(
            PoseGraphError::MissingPrevious.to_string(),
            "Pose graph references a missing previous node."
        );
    }

    #[test]
    fn add_writes_the_node_then_the_edge_pair_then_the_linked_previous_node() {
        let mut g = PoseGraph::new();
        let (first, w0) = g.add("c", 0, (10.0, 5.0), None, 1.0).unwrap();
        assert!(first.pinned && first.id == "c/0000000000");
        assert_eq!(w0, vec![Write::Put(PoseRow::Node(first.clone()))]);
        let (second, w1) = g.add("c", 1, (30.0, 5.0), Some(&first.id), 0.25).unwrap();
        assert!(!second.pinned);
        assert_eq!(w1.len(), 3);
        assert_eq!(w1[0], Write::Put(PoseRow::Node(second.clone())));
        let Write::PutMany(edges) = &w1[1] else {
            panic!("edge pair is one putMany")
        };
        assert_eq!(
            edges.iter().map(PoseRow::key).collect::<Vec<_>>(),
            [
                "edge/c/0000000000/c/0000000001/odometry",
                "edge/c/0000000001/c/0000000000/odometry"
            ]
        );
        let Write::Put(PoseRow::Node(linked)) = &w1[2] else {
            panic!("previous node is one put")
        };
        assert_eq!(linked.next.as_deref(), Some(second.id.as_str()));
        assert_eq!(
            g.get(&first.id).unwrap().next.as_deref(),
            Some("c/0000000001")
        );
    }

    #[test]
    fn a_duplicate_edge_and_a_self_edge_write_nothing() {
        let mut g = PoseGraph::new();
        let (a, _) = g.add("c", 0, (0.0, 0.0), None, 1.0).unwrap();
        let (b, _) = g.add("d", 0, (0.0, 0.0), None, 1.0).unwrap();
        assert_eq!(
            g.connect(&a.id, &b.id, 1.0, 0.0, 1.0, EdgeKind::Loop)
                .unwrap()
                .len(),
            1
        );
        assert!(g
            .connect(&a.id, &b.id, 9.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap()
            .is_empty());
        assert!(g
            .connect(&a.id, &a.id, 9.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap()
            .is_empty());
        assert_eq!(g.loops(), 1);
    }

    #[test]
    fn a_cross_canvas_loop_carrying_offset_plus_shift_converges_to_zero_residual() {
        let mut g = PoseGraph::new();
        let (anchor, _) = g.add("F", 0, (60.0, 0.0), None, 1.0).unwrap();
        let (node, _) = g.add("T", 1, (1085.0, 0.0), None, 1.0).unwrap();
        g.unpin(&node.id).unwrap();
        g.connect(&anchor.id, &node.id, 1025.0, 0.0, 5.0, EdgeKind::Loop)
            .unwrap();
        let mut prev = node.id.clone();
        for i in 0..3u32 {
            let (n, _) = g
                .add(
                    "T",
                    2 + i,
                    (1085.0 + (i + 1) as f64 * 20.0, 0.0),
                    Some(&prev),
                    1.0,
                )
                .unwrap();
            prev = n.id;
        }
        let (outcome, _) = run(&mut g, 1);
        assert!(outcome.residual < 1e-6, "residual {}", outcome.residual);
    }

    #[test]
    fn loop_distribution_writes_stay_linear_in_nodes_plus_loops() {
        let mut g = PoseGraph::new();
        let mut ids: Vec<String> = Vec::new();
        for i in 0..=120u32 {
            let (n, _) = g
                .add(
                    "star",
                    i,
                    (i as f64 * 10.0, 0.0),
                    ids.last().map(String::as_str),
                    1.0,
                )
                .unwrap();
            ids.push(n.id);
        }
        let mut calls = 0;
        for i in 1..=100 {
            calls += g
                .connect(&ids[0], &ids[i], i as f64 * 10.0, 0.0, 1.0, EdgeKind::Loop)
                .unwrap()
                .len();
        }
        assert!(calls < 400, "{calls} storage calls for 100 loop closures");
    }

    #[test]
    fn a_loop_closure_leaves_a_disjoint_chain_on_the_same_canvas_alone() {
        let mut g = PoseGraph::new();
        let mut prev: Option<String> = None;
        let mut a = Vec::new();
        for i in 0..4u32 {
            let (n, _) = g
                .add("C", i, (i as f64 * 10.0, 0.0), prev.as_deref(), 1.0)
                .unwrap();
            prev = Some(n.id.clone());
            a.push(n.id);
        }
        prev = None;
        let mut b = Vec::new();
        for i in 0..3u32 {
            let (n, _) = g
                .add(
                    "C",
                    100 + i,
                    (500.0 + i as f64 * 10.0, 0.0),
                    prev.as_deref(),
                    1.0,
                )
                .unwrap();
            prev = Some(n.id.clone());
            b.push(n.id);
        }
        g.connect(&a[0], &a[3], 50.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap();
        for (id, x) in b.iter().zip([500.0, 510.0, 520.0]) {
            assert_eq!(g.get(id).unwrap().x, x);
        }
        assert!((g.get(&a[3]).unwrap().x - 50.0).abs() < 1e-9);
    }

    #[test]
    fn a_broken_next_chain_treats_an_unreachable_revisit_as_isolated() {
        let mut g = PoseGraph::new();
        g.hydrate_node(node("a", "c", 0, 0.0, true, Some("ghost")));
        g.hydrate_node(node("b", "c", 5, 50.0, false, None));
        let writes = g.connect("a", "b", 40.0, 0.0, 1.0, EdgeKind::Loop).unwrap();
        assert_eq!(writes.len(), 1, "only the edge pair");
        assert_eq!(g.get("b").unwrap().x, 50.0);
        assert_eq!(g.loops(), 1);
    }

    #[test]
    fn a_loop_correction_skips_a_pinned_node_inside_the_chain() {
        let mut g = PoseGraph::new();
        g.hydrate_node(node("a0", "c", 0, 0.0, true, Some("a1")));
        g.hydrate_node(node("a1", "c", 1, 10.0, false, Some("a2")));
        g.hydrate_node(node("a2", "c", 2, 20.0, true, Some("a3")));
        g.hydrate_node(node("a3", "c", 3, 30.0, false, None));
        let writes = g
            .connect("a0", "a3", 50.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap();
        assert_eq!(g.get("a2").unwrap().x, 20.0);
        assert!(g.get("a1").unwrap().x.abs() > 1e-9);
        assert!((g.get("a3").unwrap().x - 50.0).abs() < 1e-9);
        let written: Vec<_> = nodes_written(&writes)
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(written, ["a1", "a3"]);
    }

    #[test]
    fn relaxation_skips_a_node_without_edges_and_an_edge_to_a_missing_node() {
        let mut g = PoseGraph::new();
        g.hydrate_node(node("a", "c", 0, 0.0, false, None));
        g.hydrate_node(node("lonely", "d", 0, 3.0, false, None));
        g.hydrate_edge(
            "edge/a/ghost/loop",
            PoseEdge {
                other: "ghost".into(),
                dx: 5.0,
                dy: 0.0,
                weight: 1.0,
                kind: EdgeKind::Loop,
            },
        );
        assert_eq!(g.loops(), 1);
        let (outcome, writes) = run(&mut g, 1);
        assert!(outcome.residual.is_finite());
        let written: Vec<_> = nodes_written(&writes)
            .iter()
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(written, ["a"], "the edgeless node is never written back");
        assert_eq!(g.get("lonely").unwrap().x, 3.0);
    }

    #[test]
    fn hydration_counts_each_loop_once_and_recovers_the_owner_from_the_key() {
        let mut g = PoseGraph::new();
        g.hydrate_node(node("c/1", "c", 1, 0.0, true, None));
        g.hydrate_node(node("c/2", "c", 2, 0.0, false, None));
        for (key, other, dx) in [
            ("edge/c/1/c/2/loop", "c/2", 3.0),
            ("edge/c/2/c/1/loop", "c/1", -3.0),
        ] {
            g.hydrate_edge(
                key,
                PoseEdge {
                    other: other.into(),
                    dx,
                    dy: 0.0,
                    weight: 1.0,
                    kind: EdgeKind::Loop,
                },
            );
        }
        assert_eq!(g.loops(), 1);
        assert!(g
            .connect("c/1", "c/2", 7.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn no_loops_means_no_relaxation_and_no_writes() {
        let mut g = PoseGraph::new();
        let (a, _) = g.add("c", 0, (0.0, 0.0), None, 1.0).unwrap();
        g.add("c", 1, (10.0, 0.0), Some(&a.id), 1.0).unwrap();
        assert!(g.begin_optimize().is_none());
    }

    /// A chain plus a loop that disagrees by far more than the exact cycle solver accepts, so relaxation runs sweeps.
    fn contested() -> PoseGraph {
        let mut g = PoseGraph::new();
        let mut ids: Vec<String> = Vec::new();
        for i in 0..12u32 {
            let (n, _) = g
                .add(
                    "c",
                    i,
                    (i as f64 * 10.0, (i % 3) as f64),
                    ids.last().map(String::as_str),
                    1.0,
                )
                .unwrap();
            ids.push(n.id);
        }
        g.connect(&ids[0], &ids[11], 400.0, 0.0, 1.0, EdgeKind::Loop)
            .unwrap();
        g.connect(&ids[2], &ids[9], 30.0, 9.0, 2.0, EdgeKind::Loop)
            .unwrap();
        g
    }

    #[test]
    fn an_optimizer_dropped_between_steps_changes_nothing() {
        let g = contested();
        let before: Vec<PoseNode> = g.nodes.clone();
        let mut opt = g.begin_optimize().unwrap();
        assert!(!opt.step(1), "this graph needs more than one sweep");
        drop(opt);
        assert_eq!(g.nodes, before);
    }

    #[test]
    fn the_outcome_does_not_depend_on_how_many_sweeps_each_step_runs() {
        let (one, w_one) = run(&mut contested(), 1);
        let (many, w_many) = run(&mut contested(), 7);
        let (all, w_all) = run(&mut contested(), MAX_SWEEPS);
        assert!(one.iterations > 1);
        assert_eq!(one, many);
        assert_eq!(one, all);
        assert_eq!(w_one, w_many);
        assert_eq!(w_one, w_all);
    }

    #[test]
    fn iterations_count_sweeps_and_stop_at_the_cap() {
        let mut opt = contested().begin_optimize().unwrap();
        let mut steps = 0;
        while !opt.step(1) {
            steps += 1;
            assert_eq!(opt.iterations(), steps);
        }
        assert!(opt.iterations() <= MAX_SWEEPS);
        assert!(opt.step(1), "a finished optimizer stays finished");
    }

    #[test]
    fn correction_blends_towards_the_next_node_by_frame() {
        let mut g = PoseGraph::new();
        g.hydrate_node(PoseNode {
            x: 4.0,
            ..node("a", "c", 10, 0.0, false, Some("b"))
        });
        g.hydrate_node(PoseNode {
            x: 108.0,
            ..node("b", "c", 20, 100.0, false, None)
        });
        assert_eq!(g.correction("a", 10.0).unwrap(), (4.0, 0.0));
        assert_eq!(g.correction("a", 15.0).unwrap(), (6.0, 0.0));
        assert_eq!(g.correction("a", 40.0).unwrap(), (8.0, 0.0));
        assert_eq!(g.correction("b", 15.0).unwrap(), (8.0, 0.0));
    }

    #[test]
    fn re_adding_an_id_keeps_its_place_in_node_order() {
        let mut g = PoseGraph::new();
        g.add("c", 0, (0.0, 0.0), None, 1.0).unwrap();
        g.add("d", 0, (0.0, 0.0), None, 1.0).unwrap();
        g.add("c", 0, (5.0, 0.0), None, 1.0).unwrap();
        let order: Vec<_> = g.nodes.iter().map(|n| (n.id.as_str(), n.x)).collect();
        assert_eq!(order, [("c/0000000000", 5.0), ("d/0000000000", 0.0)]);
    }
}
