//! A native host driving the solve session through its public API, the way the page does: decode frames (windows
//! onto a synthetic page, scrolled down and back up), hand each one over, load the keyframe rows a revisit search
//! asks for from its own store, store every row the session hands back, drain the voting ring, then relax the pose
//! graph a sweep at a time and store the relaxed nodes.

use long_screen::engine::pose_graph::{PoseRow, Write};
use long_screen::engine::solve::{
    Begin, Effect, Keyframe, Poll, ScanFields, SolveConfig, SolveRegion, SolveSession,
    VOTING_RING_BYTES,
};
use long_screen::kernels::geometry::Rect;
use long_screen::kernels::region::Region;
use std::collections::BTreeMap;

const W: usize = 160;
const H: usize = 120;
const PAGE: usize = 900;

fn page() -> Vec<u8> {
    let mut seed = 0x9e37_79b9u32;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut luma: Vec<u8> = (0..W * PAGE).map(|_| 100 + (next() % 24) as u8).collect();
    for _ in 0..1600 {
        let (w, h) = (4 + next() as usize % 22, 3 + next() as usize % 14);
        let (x, y) = (next() as usize % (W - w), next() as usize % (PAGE - h));
        let v = (next() % 256) as u8;
        for row in y..y + h {
            luma[row * W + x..row * W + x + w].fill(v);
        }
    }
    luma.iter().flat_map(|&v| [v, v, v, 255]).collect()
}

/// What the host stored, by key, plus the diagnostic codes in order.
#[derive(Default)]
struct Store {
    rows: BTreeMap<String, String>,
    keyframes: BTreeMap<String, Keyframe>,
    diagnostics: Vec<&'static str>,
}

impl Store {
    fn graph(&mut self, write: Write) {
        let rows = match write {
            Write::Put(row) => vec![row],
            Write::PutMany(rows) => rows,
        };
        for row in rows {
            let value = match &row {
                PoseRow::Node(n) => format!("{},{}", n.x, n.y),
                PoseRow::Edge { edge, .. } => format!("{},{}", edge.dx, edge.dy),
            };
            self.rows.insert(row.key(), value);
        }
    }

    fn apply(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Canvas { meta, .. } => {
                    self.rows.insert(format!("canvas/{}", meta.id), meta.name);
                }
                Effect::Attachment(a) => {
                    self.rows.insert(format!("attach/{}", a.id), a.target);
                }
                Effect::Keyframe(k) => {
                    self.keyframes.insert(k.id.clone(), (*k).clone());
                }
                Effect::Graph(write) => self.graph(write),
                Effect::Diagnostic(d) => self.diagnostics.push(d.code),
            }
        }
    }
}

#[test]
fn a_native_host_solves_a_scroll_and_its_return_and_relaxes_the_graph() {
    let page = page();
    let mut session = SolveSession::new(SolveConfig {
        width: W,
        height: H,
        factor: 2,
        radius: 3,
        noise: 0.0,
        voting_budget: VOTING_RING_BYTES,
        regions: vec![SolveRegion {
            id: "body".into(),
            name: "页面".into(),
            moving: true,
            kind: "moving".into(),
            unassigned: false,
            code: 1,
            shape: Region {
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: W as f64,
                    height: H as f64,
                },
                exclusions: Vec::new(),
                crop: None,
                solid: false,
                mask: None,
            },
        }],
    });
    let labels = vec![1u8; W * H];
    let mut store = Store::default();
    let offsets: Vec<usize> = (0..30)
        .map(|i| i * 15)
        .chain((0..30).rev().map(|i| i * 15))
        .collect();
    let mut voting = 0;
    for (index, &offset) in offsets.iter().enumerate() {
        let scan = ScanFields {
            duplicate: false,
            zoom: 1.0,
            difference: 0.5,
        };
        let Begin::NeedFrame { gray } = session
            .begin_frame(index as u32, index as f64 / 30.0, scan)
            .unwrap()
        else {
            panic!("no duplicate frames here");
        };
        assert!(gray, "a frame that is not a duplicate wants its gray");
        session
            .frame_mut()
            .copy_from_slice(&page[offset * W * 4..(offset + H) * W * 4]);
        let mut poll = session.run_frame(None, None, &labels).unwrap();
        loop {
            store.apply(session.take_effects());
            match poll {
                Poll::Done(done) => {
                    let p = &done.placements[0];
                    assert_eq!(
                        (p.canvas_id.as_str(), p.y),
                        ("body-part-0", offset as f64),
                        "frame {index}"
                    );
                    voting += done.voting.len();
                    store.rows.insert(
                        format!("plan/{index:0>10}"),
                        format!("{}@{}", p.canvas_id, p.y),
                    );
                    break;
                }
                Poll::NeedKeyframes(ids) => {
                    let rows = ids
                        .iter()
                        .map(|id| store.keyframes.get(id).cloned())
                        .collect();
                    poll = session.provide_keyframes(rows, &labels).unwrap();
                }
            }
        }
    }
    voting += session.drain_voting().len();
    assert_eq!(
        voting,
        offsets.len(),
        "every frame is finalised by the ring once"
    );
    assert!(
        store.diagnostics.contains(&"LOOP_CLOSURE"),
        "{:?}",
        store.diagnostics
    );
    assert_eq!(
        store
            .rows
            .keys()
            .filter(|k| k.starts_with("canvas/"))
            .count(),
        1
    );

    let mut graph = session.take_graph();
    assert!(graph.loops() > 0);
    let mut optimizer = graph.begin_optimize().expect("a loop edge to relax");
    while !optimizer.step(1) {}
    let (outcome, writes) = graph.finish_optimize(optimizer);
    assert!(outcome.residual.is_finite() && outcome.iterations > 0);
    for w in writes {
        store.graph(w);
    }
    assert!(store
        .rows
        .keys()
        .any(|k| k.starts_with("node/body-part-0/")));
}
