//! A native host driving the pose graph through its public API, the way the page does: store every write in a
//! key-ordered map, stop a relaxation part-way, then rebuild a fresh graph from the store and check it answers the
//! same as the one that wrote it.

use long_screen::engine::pose_graph::{EdgeKind, PoseGraph, PoseRow, Write};
use std::collections::BTreeMap;

#[derive(Default)]
struct Store {
    rows: BTreeMap<String, PoseRow>,
    calls: usize,
}

impl Store {
    fn apply(&mut self, writes: Vec<Write>) {
        for write in writes {
            self.calls += 1;
            let rows = match write {
                Write::Put(row) => vec![row],
                Write::PutMany(rows) => rows,
            };
            for row in rows {
                self.rows.insert(row.key(), row);
            }
        }
    }

    /// A fresh graph from the stored rows: every `node/` row, then every `edge/` row, each in key order.
    fn hydrate(&self) -> PoseGraph {
        let mut graph = PoseGraph::new();
        for (key, row) in self.rows.range("node/".to_string()..) {
            if !key.starts_with("node/") {
                break;
            }
            if let PoseRow::Node(node) = row {
                graph.hydrate_node(node.clone());
            }
        }
        for (key, row) in self.rows.range("edge/".to_string()..) {
            if !key.starts_with("edge/") {
                break;
            }
            if let PoseRow::Edge { edge, .. } = row {
                graph.hydrate_edge(key, edge.clone());
            }
        }
        graph
    }
}

/// Two regions' chains on one canvas plus a cross-canvas fragment, closed by loops that disagree with odometry.
fn solve(store: &mut Store) -> PoseGraph {
    let mut graph = PoseGraph::new();
    let mut previous: Option<String> = None;
    for frame in 0..30u32 {
        let (node, writes) = graph
            .add(
                "canvas",
                frame,
                (frame as f64 * 12.0, (frame % 4) as f64),
                previous.as_deref(),
                if frame == 15 { 0.05 } else { 1.0 },
            )
            .unwrap();
        store.apply(writes);
        previous = Some(node.id);
    }
    let (fragment, writes) = graph.add("fragment", 40, (5.0, 900.0), None, 1.0).unwrap();
    store.apply(writes);
    store.apply(graph.unpin(&fragment.id).unwrap());
    let ids: Vec<String> = (0..30).map(|f| PoseGraph::node_id("canvas", f)).collect();
    store.apply(
        graph
            .connect(&ids[0], &ids[29], 400.0, 2.0, 5.0, EdgeKind::Loop)
            .unwrap(),
    );
    store.apply(
        graph
            .connect(&ids[3], &ids[20], 190.0, -1.0, 2.0, EdgeKind::Loop)
            .unwrap(),
    );
    store.apply(
        graph
            .connect(&ids[10], &fragment.id, -110.0, 880.0, 3.0, EdgeKind::Loop)
            .unwrap(),
    );
    graph
}

#[test]
fn a_stopped_relaxation_writes_nothing_and_a_rehydrated_graph_answers_the_same() {
    let mut store = Store::default();
    let mut graph = solve(&mut store);
    assert_eq!(graph.loops(), 3);

    // Stop after three steps: the host drops the optimizer, so neither the graph nor the store changes.
    let stored_before = store.rows.clone();
    let mut stopped = graph.begin_optimize().unwrap();
    for _ in 0..3 {
        assert!(!stopped.step(1));
    }
    drop(stopped);
    assert_eq!(store.rows, stored_before);

    // A fresh graph from the store holds the same graph, loop count included.
    let mut fresh = store.hydrate();
    assert_eq!(fresh.loops(), graph.loops());
    assert_eq!(fresh.len(), graph.len());

    // Relax the original to the end and store its writes, then rebuild from the store as the render pass does.
    let mut optimizer = graph.begin_optimize().unwrap();
    while !optimizer.step(4) {}
    let (outcome, writes) = graph.finish_optimize(optimizer);
    assert!(outcome.iterations > 1 && outcome.residual.is_finite());
    store.apply(writes);
    let render = store.hydrate();
    for frame in 0..30u32 {
        let id = PoseGraph::node_id("canvas", frame);
        for at in [frame as f64, frame as f64 + 0.5] {
            assert_eq!(
                render.correction(&id, at).unwrap(),
                graph.correction(&id, at).unwrap(),
                "{id} at {at}"
            );
        }
    }

    // Relaxing the pre-optimize rehydration lands on the same poses, though not bit for bit: hydration lists each
    // node's edges in key order rather than the order they were connected, and a sweep sums them in that order.
    let mut optimizer = fresh.begin_optimize().unwrap();
    while !optimizer.step(1) {}
    let (again, _) = fresh.finish_optimize(optimizer);
    assert!((again.residual - outcome.residual).abs() < 1e-9);
    for frame in 0..30u32 {
        let id = PoseGraph::node_id("canvas", frame);
        let (a, b) = (fresh.get(&id).unwrap(), graph.get(&id).unwrap());
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9, "{id}");
    }
}
