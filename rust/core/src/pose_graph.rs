//! Pose-graph relaxation (`src/core/pose-graph.ts::PoseGraph.optimize`/residual computation). A Gauss-Seidel-style
//! relaxation over a graph handed in as plain arrays: node positions/pinned flags plus a CSR adjacency list the
//! TS side builds from its `Map` iteration order — this module never sees string ids, only indices, so node
//! identity/ordering questions stay where the KV layout lives (pose-graph.ts). Alternating forward/reverse
//! node-visitation order matches `optimize()`'s odd/even iteration parity (`iterations % 2 === 1`).

use crate::geometry::js_hypot;

pub struct Node {
    pub x: f64,
    pub y: f64,
    pub pinned: bool,
}

/// One directed edge `node -> other`, `other` already resolved to a node index by the caller. `other < 0` is a
/// defensive sentinel for "target node not found" (mirrors `this.nodes.get(edge.other)` returning `undefined` in
/// pose-graph.ts's `optimize()`/`residual` loops): the edge is skipped without stopping the edge loop, exactly as
/// `if (!other) continue;` does there. In practice every edge's `other` always resolves — nodes are never removed
/// once hydrated — but the sentinel keeps the two sides' control flow identical rather than assuming it.
pub struct Edge {
    pub other: i32,
    pub dx: f64,
    pub dy: f64,
    pub weight: f64,
}

pub struct Graph {
    pub nodes: Vec<Node>,
    /// CSR: `offsets[i]..offsets[i + 1]` indexes into `edges` for node `i`. `offsets.len() == nodes.len() + 1`.
    pub offsets: Vec<u32>,
    pub edges: Vec<Edge>,
}

impl Graph {
    /// One Gauss-Seidel sweep over every unpinned node with edges, mutating positions in place exactly as
    /// `optimize()`'s per-node loop does: a neighbour update earlier in this same sweep is visible to a later one
    /// in it (via `self.nodes`, not a snapshot). Returns the largest single-node displacement (`maxChange`).
    pub fn pass(&mut self, reverse: bool) -> f64 {
        let n = self.nodes.len();
        let mut max_change = 0.0f64;
        for k in 0..n {
            let i = if reverse { n - 1 - k } else { k };
            if self.nodes[i].pinned {
                continue;
            }
            let start = self.offsets[i] as usize;
            let end = self.offsets[i + 1] as usize;
            if start == end {
                continue;
            }
            let (mut x, mut y, mut total) = (0.0f64, 0.0f64, 0.0f64);
            {
                let node = &self.nodes[i];
                for e in &self.edges[start..end] {
                    if e.other < 0 {
                        continue;
                    }
                    let other = &self.nodes[e.other as usize];
                    let residual = js_hypot(other.x - node.x - e.dx, other.y - node.y - e.dy);
                    let weight = e.weight * (1.0f64).min(6.0 / (1e-6f64).max(residual));
                    x += (other.x - e.dx) * weight;
                    y += (other.y - e.dy) * weight;
                    total += weight;
                }
            }
            if total == 0.0 {
                continue;
            }
            let (px, py) = (x / total, y / total);
            let node = &mut self.nodes[i];
            let change = js_hypot(node.x - px, node.y - py);
            if change > max_change {
                max_change = change;
            }
            node.x = px;
            node.y = py;
        }
        max_change
    }

    /// Largest edge residual over the current positions — same node/edge visitation order as `optimize()`'s
    /// trailing residual loop (ascending node index, then edge order within each node).
    pub fn residual(&self) -> f64 {
        let mut residual = 0.0f64;
        for i in 0..self.nodes.len() {
            let start = self.offsets[i] as usize;
            let end = self.offsets[i + 1] as usize;
            let node = &self.nodes[i];
            for e in &self.edges[start..end] {
                if e.other < 0 {
                    continue;
                }
                let other = &self.nodes[e.other as usize];
                let r = js_hypot(other.x - node.x - e.dx, other.y - node.y - e.dy);
                if r > residual {
                    residual = r;
                }
            }
        }
        residual
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_node_chain(dx: f64, dy: f64) -> Graph {
        // node 0 pinned at origin, node 1 free, one odometry edge 0->1 (dx,dy) and its mirror 1->0.
        Graph {
            nodes: vec![
                Node { x: 0.0, y: 0.0, pinned: true },
                Node { x: dx + 5.0, y: dy + 5.0, pinned: false },
            ],
            offsets: vec![0, 1, 2],
            edges: vec![
                Edge { other: 1, dx, dy, weight: 1.0 },
                Edge { other: 0, dx: -dx, dy: -dy, weight: 1.0 },
            ],
        }
    }

    #[test]
    fn relaxes_a_free_node_toward_its_pinned_neighbour() {
        let mut g = two_node_chain(10.0, -4.0);
        let change = g.pass(false);
        assert!(change > 0.0);
        assert!((g.nodes[1].x - 10.0).abs() < 1e-9);
        assert!((g.nodes[1].y - -4.0).abs() < 1e-9);
        assert_eq!(g.residual(), 0.0);
    }

    #[test]
    fn missing_other_is_skipped_not_fatal() {
        let mut g = Graph {
            nodes: vec![Node { x: 1.0, y: 1.0, pinned: false }],
            offsets: vec![0, 1],
            edges: vec![Edge { other: -1, dx: 0.0, dy: 0.0, weight: 1.0 }],
        };
        let change = g.pass(false);
        assert_eq!(change, 0.0);
        assert_eq!(g.nodes[0].x, 1.0);
    }
}
