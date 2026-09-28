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
    /// Exact weighted solution of a connected simple cycle with one anchor. A chain plus one
    /// root-to-last loop has this topology regardless of node/edge order. Reject other graphs and
    /// solutions outside Huber's quadratic region (6px), leaving the general solver untouched.
    pub fn solve_cycle(&mut self) -> bool {
        let n = self.nodes.len();
        if n < 3 || self.edges.len() != 2 * n || self.nodes.iter().filter(|v| v.pinned).count() != 1
        {
            return false;
        }
        if self.offsets.windows(2).any(|w| w[1] - w[0] != 2) {
            return false;
        }
        let root = self.nodes.iter().position(|v| v.pinned).unwrap();
        if !self.nodes[root].x.is_finite() || !self.nodes[root].y.is_finite() {
            return false;
        }
        let mut seen = vec![false; n];
        let mut path = Vec::with_capacity(n);
        let (mut current, mut previous) = (root, usize::MAX);
        let (mut dx, mut dy, mut resistance) = (0.0, 0.0, 0.0);
        for _ in 0..n {
            if seen[current] {
                return false;
            }
            seen[current] = true;
            let start = self.offsets[current] as usize;
            let candidates = &self.edges[start..start + 2];
            let Some((offset, edge)) = candidates
                .iter()
                .enumerate()
                .find(|(_, e)| e.other as usize != previous)
            else {
                return false;
            };
            if edge.other < 0
                || edge.other as usize >= n
                || edge.other as usize == current
                || !edge.dx.is_finite()
                || !edge.dy.is_finite()
                || !edge.weight.is_finite()
                || edge.weight <= 0.0
            {
                return false;
            }
            let next = edge.other as usize;
            let mirrors = &self.edges[self.offsets[next] as usize..self.offsets[next + 1] as usize];
            if mirrors
                .iter()
                .filter(|e| {
                    e.other == current as i32
                        && e.dx == -edge.dx
                        && e.dy == -edge.dy
                        && e.weight == edge.weight
                })
                .count()
                != 1
            {
                return false;
            }
            path.push((current, start + offset));
            dx += edge.dx;
            dy += edge.dy;
            resistance += 1.0 / edge.weight;
            previous = current;
            current = next;
        }
        if current != root || !dx.is_finite() || !dy.is_finite() || !resistance.is_finite() {
            return false;
        }
        let mut positions = Vec::with_capacity(n);
        let (mut x, mut y) = (self.nodes[root].x, self.nodes[root].y);
        for &(node, index) in &path {
            positions.push((node, x, y));
            let e = &self.edges[index];
            let (rx, ry) = (-dx / (e.weight * resistance), -dy / (e.weight * resistance));
            if !rx.is_finite() || !ry.is_finite() || js_hypot(rx, ry) > 6.0 {
                return false;
            }
            x += e.dx + rx;
            y += e.dy + ry;
            if !x.is_finite() || !y.is_finite() {
                return false;
            }
        }
        for (i, x, y) in positions {
            self.nodes[i].x = x;
            self.nodes[i].y = y;
        }
        true
    }

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
                Node {
                    x: 0.0,
                    y: 0.0,
                    pinned: true,
                },
                Node {
                    x: dx + 5.0,
                    y: dy + 5.0,
                    pinned: false,
                },
            ],
            offsets: vec![0, 1, 2],
            edges: vec![
                Edge {
                    other: 1,
                    dx,
                    dy,
                    weight: 1.0,
                },
                Edge {
                    other: 0,
                    dx: -dx,
                    dy: -dy,
                    weight: 1.0,
                },
            ],
        }
    }

    fn cycle(n: usize, closure: f64) -> Graph {
        let nodes = (0..n)
            .map(|i| Node {
                x: i as f64 * 10.0,
                y: 0.0,
                pinned: i == 0,
            })
            .collect();
        let mut offsets = vec![0];
        let mut edges = Vec::new();
        for i in 0..n {
            edges.push(Edge {
                other: ((i + 1) % n) as i32,
                dx: if i + 1 == n {
                    -(n as f64 - 1.0) * 10.0 + closure
                } else {
                    10.0
                },
                dy: 0.0,
                weight: 1.0,
            });
            edges.push(Edge {
                other: ((i + n - 1) % n) as i32,
                dx: if i == 0 {
                    (n as f64 - 1.0) * 10.0 - closure
                } else {
                    -10.0
                },
                dy: 0.0,
                weight: 1.0,
            });
            offsets.push(edges.len() as u32);
        }
        Graph {
            nodes,
            offsets,
            edges,
        }
    }

    #[test]
    fn cycle_solution_obeys_normal_equations() {
        let mut graph = cycle(40, 2.0);
        graph.edges[20].weight = 0.05;
        graph.edges[23].weight = 0.05;
        assert!(graph.solve_cycle());
        for i in 1..graph.nodes.len() {
            let mut gradient = (0.0, 0.0);
            for e in &graph.edges[graph.offsets[i] as usize..graph.offsets[i + 1] as usize] {
                gradient.0 +=
                    e.weight * (graph.nodes[i].x + e.dx - graph.nodes[e.other as usize].x);
                gradient.1 +=
                    e.weight * (graph.nodes[i].y + e.dy - graph.nodes[e.other as usize].y);
            }
            assert!(js_hypot(gradient.0, gradient.1) < 1e-10);
        }
        assert_eq!(graph.nodes[0].x, 0.0);
    }

    #[test]
    fn ineligible_cycles_are_left_unchanged() {
        for invalid in 0..6 {
            let mut graph = cycle(8, if invalid == 0 { 100.0 } else { 2.0 });
            match invalid {
                1 => graph.nodes[3].pinned = true,
                2 => graph.edges[0].weight = 0.0,
                3 => graph.edges[0].dx = f64::NAN,
                4 => graph.edges[0].other = -1,
                5 => graph.edges[0].weight = 2.0, // asymmetric mirror
                _ => {}
            }
            assert!(!graph.solve_cycle());
            for (i, node) in graph.nodes.iter().enumerate() {
                assert_eq!(node.x, i as f64 * 10.0);
            }
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
            nodes: vec![Node {
                x: 1.0,
                y: 1.0,
                pinned: false,
            }],
            offsets: vec![0, 1],
            edges: vec![Edge {
                other: -1,
                dx: 0.0,
                dy: 0.0,
                weight: 1.0,
            }],
        };
        let change = g.pass(false);
        assert_eq!(change, 0.0);
        assert_eq!(g.nodes[0].x, 1.0);
    }
}
