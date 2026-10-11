//! The render session's failure cases and orderings, each written as the way the pass could go wrong.

use super::*;
use crate::engine::compositor::TemporalPolicy;
use crate::engine::diagnostic::Value;
use crate::engine::pose_graph::PoseNode;
use crate::engine::tiles::StoredTile;

const W: usize = 32;
const H: usize = 16;
const TILE: usize = 16;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn region(id: &str, kind: RegionKind, r: Rect, code: u8) -> RenderRegion {
    RenderRegion {
        id: id.into(),
        kind,
        rect: r,
        code,
        owned_pixels: r.width * r.height,
    }
}

fn graph(nodes: &[(&str, &str, f64)]) -> PoseGraph {
    let mut g = PoseGraph::new();
    for &(id, canvas, moved) in nodes {
        g.hydrate_node(PoseNode {
            id: id.into(),
            canvas_id: canvas.into(),
            frame: 0,
            x: moved,
            y: 0.0,
            original_x: 0.0,
            original_y: 0.0,
            pinned: false,
            next: None,
        });
    }
    g
}

fn place(layer: &str, canvas: &str, node: &str, x: f64) -> PlanPlacement {
    PlanPlacement {
        layer: layer.into(),
        canvas_id: canvas.into(),
        node: node.into(),
        x,
        y: 0.0,
        confidence: 0.75,
        uncertain: false,
        time: 0.5,
        skip: None,
        occlusions: None,
    }
}

fn plan(placements: Vec<PlanPlacement>) -> FramePlan {
    FramePlan {
        placements,
        duplicate: false,
    }
}

fn input(index: u32, plan: FramePlan) -> FrameInput {
    FrameInput {
        index,
        time: index as f64 / 30.0,
        plan,
        has_prev: false,
        prev_plan: None,
        has_next: false,
        next_plan: None,
    }
}

fn meta() -> CanvasMeta {
    CanvasMeta {
        bounds: rect(0.0, 0.0, 0.0, 0.0),
        tile_count: 0.0,
        observed_pixels: 0.0,
        uncertain_pixels: 0.0,
        conflict_pixels: 0.0,
        provisional_pixels: 0.0,
        last_time: 0.0,
    }
}

fn session(regions: Vec<RenderRegion>, attachments: Vec<Attachment>) -> RenderSession {
    RenderSession::new(RenderConfig {
        width: W,
        height: H,
        factor: 1,
        noise: 0.0,
        regions,
        attachments,
    })
}

fn solid(v: u8) -> Vec<u8> {
    [v, v, v, 255]
        .iter()
        .copied()
        .cycle()
        .take(W * H * 4)
        .collect()
}

/// A synchronous host: answers every need from memory and records the order of what was asked.
struct Host {
    cache: TileCache,
    compositor: Compositor,
    graph: PoseGraph,
    labels: Vec<u8>,
    frames: HashMap<u32, Vec<u8>>,
    metas: HashMap<String, CanvasMeta>,
    tiles: HashMap<TileKey, StoredTile>,
    asked: Vec<String>,
}

impl Host {
    fn new(graph: PoseGraph, labels: Vec<u8>) -> Self {
        Self {
            cache: TileCache::new(TILE, 128.0).unwrap(),
            compositor: Compositor::new(TemporalPolicy::Stable, W, H),
            graph,
            labels,
            frames: HashMap::new(),
            metas: HashMap::new(),
            tiles: HashMap::new(),
            asked: Vec::new(),
        }
    }

    fn frame(
        &mut self,
        s: &mut RenderSession,
        input: FrameInput,
    ) -> Result<FrameOutcome, RenderError> {
        let wanted = s.wanted_votes(input.index, input.has_prev, input.has_next);
        s.begin(input, wanted.into_iter().map(|i| (i, None)).collect())?;
        loop {
            let mut io = RenderIo {
                cache: &mut self.cache,
                compositor: &mut self.compositor,
                graph: &self.graph,
                labels: &self.labels,
                now: 1.0,
            };
            match s.step(&mut io)? {
                RenderStep::NeedMeta(c) => {
                    self.asked.push(format!("meta {c}"));
                    s.provide_meta(&c, self.metas.get(&c).copied());
                }
                RenderStep::NeedFrame(i) => {
                    self.asked.push(format!("frame {i}"));
                    s.frame_slot(i).copy_from_slice(&self.frames[&i]);
                }
                RenderStep::NeedTile(key) => {
                    while let Some(id) = self.cache.victim() {
                        let t = self.cache.evict(id).unwrap();
                        self.tiles.insert(
                            t.key.clone(),
                            StoredTile {
                                pixels: t.pixels,
                                coverage: Some(t.coverage),
                                provisional: Some(t.provisional),
                                quality: Some(t.quality),
                                conflicts: Some(t.conflicts),
                                owner: Some(t.owner),
                                score: Some(t.score),
                                frozen: Some(t.frozen),
                            },
                        );
                    }
                    let stored = self.tiles.get(&key).cloned();
                    self.cache.insert(key, stored).unwrap();
                }
                RenderStep::NeedTemporal(c) => {
                    self.compositor.load_temporal(&c, Vec::new()).unwrap()
                }
                RenderStep::Done(outcome) => return Ok(outcome),
            }
        }
    }
}

fn moving_only() -> Vec<RenderRegion> {
    vec![region(
        "m",
        RegionKind::Moving,
        rect(0.0, 0.0, W as f64, H as f64),
        1,
    )]
}

#[test]
fn stepping_without_a_frame_is_refused() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[]), vec![1; W * H]);
    let mut io = RenderIo {
        cache: &mut host.cache,
        compositor: &mut host.compositor,
        graph: &host.graph,
        labels: &host.labels,
        now: 0.0,
    };
    assert_eq!(s.step(&mut io), Err(RenderError::NoFrame));
}

#[test]
fn a_second_frame_before_the_first_finishes_is_refused() {
    let mut s = session(moving_only(), Vec::new());
    s.begin(input(0, plan(vec![])), vec![(0, None)]).unwrap();
    assert_eq!(
        s.begin(input(1, plan(vec![])), vec![(1, None)]),
        Err(RenderError::Busy)
    );
}

#[test]
fn a_voting_record_the_window_asked_for_must_be_provided() {
    let mut s = session(moving_only(), Vec::new());
    assert_eq!(s.wanted_votes(3, true, true), vec![3, 2, 4]);
    let frame = FrameInput {
        has_prev: true,
        has_next: true,
        ..input(3, plan(vec![]))
    };
    assert_eq!(
        s.begin(frame, vec![(3, None)]),
        Err(RenderError::MissingVote(2))
    );
}

#[test]
fn labels_of_another_size_are_refused() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H - 1]);
    host.metas.insert("c".into(), meta());
    assert_eq!(
        host.frame(&mut s, input(0, plan(vec![place("m", "c", "n", 0.0)]))),
        Err(RenderError::FrameSize)
    );
}

#[test]
fn a_canvas_without_stored_metadata_fails_the_frame_and_is_asked_for_again() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    let frame = input(0, plan(vec![place("m", "c", "n", 0.0)]));
    assert_eq!(
        host.frame(&mut s, frame.clone()),
        Err(RenderError::MissingMeta("c".into()))
    );
    assert_eq!(
        RenderError::MissingMeta("c".into()).to_string(),
        "Canvas metadata is missing."
    );
    // The session is usable again, and the missing row is not remembered as missing.
    host.metas.insert("c".into(), meta());
    host.frames.insert(0, solid(10));
    let done = host.frame(&mut s, frame).unwrap();
    assert_eq!(host.asked, vec!["meta c", "meta c", "frame 0"]);
    assert_eq!(done.observation.decisions[0].added_pixels, (W * H) as f64);
}

#[test]
fn a_placement_whose_node_is_missing_fails_like_the_graph_does() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[]), vec![1; W * H]);
    let err = host
        .frame(&mut s, input(0, plan(vec![place("m", "c", "", 0.0)])))
        .unwrap_err();
    assert_eq!(err, RenderError::Graph(PoseGraphError::MissingPose));
    assert_eq!(err.to_string(), "Missing pose for frame rendering.");
}

#[test]
fn a_placement_on_an_unknown_layer_is_refused() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    assert_eq!(
        host.frame(&mut s, input(0, plan(vec![place("x", "c", "n", 0.0)]))),
        Err(RenderError::UnknownRegion("x".into()))
    );
}

#[test]
fn an_unplaceable_pose_is_reported_and_recorded_skipped_at_the_origin() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    let done = host
        .frame(&mut s, input(4, plan(vec![place("m", "c", "n", 1e300)])))
        .unwrap();
    assert!(host.asked.is_empty(), "nothing is loaded for it");
    let d = &done.observation.decisions[0];
    assert!(d.skipped && !d.reused_exact_observation);
    assert_eq!((d.placement.x, d.placement.y), (0.0, 0.0));
    assert_eq!(
        s.take_events(),
        vec![Diagnostic::new("NONFINITE_POSE", Severity::Error)
            .at(4, 0.5)
            .canvas("c")]
    );
    assert_eq!(done.latest, None);
}

#[test]
fn a_skipped_placement_keeps_its_stored_row_and_its_own_canvas() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[]), vec![1; W * H]);
    let raw = PlanPlacement {
        skip: Some(true),
        ..place("m", "fragment", "missing", 3.0)
    };
    let done = host
        .frame(&mut s, input(0, plan(vec![raw.clone()])))
        .unwrap();
    let d = &done.observation.decisions[0];
    assert_eq!(d.placement, raw);
    assert_eq!(d.canvas_id, "fragment");
    assert!(d.skipped);
}

#[test]
fn a_duplicate_frame_at_the_same_pose_reuses_the_last_paint_without_decoding_it() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    host.frames.insert(0, solid(10));
    host.frame(&mut s, input(0, plan(vec![place("m", "c", "n", 0.0)])))
        .unwrap();
    let mut dup = plan(vec![PlanPlacement {
        time: 0.75,
        ..place("m", "c", "n", 0.0)
    }]);
    dup.duplicate = true;
    host.asked.clear();
    let done = host.frame(&mut s, input(1, dup)).unwrap();
    assert!(host.asked.is_empty(), "frame 1 never entered the ring");
    assert!(done.observation.decisions[0].reused_exact_observation);
    assert_eq!(done.latest.as_deref(), Some("c"));
    assert_eq!(s.counters().skipped_paints, 1);
    assert_eq!(s.meta("c").unwrap().last_time, 0.75);
}

#[test]
fn a_fixed_region_repaints_only_when_its_own_pixels_change() {
    let regions = vec![region(
        "f",
        RegionKind::Fixed,
        rect(0.0, 0.0, W as f64, H as f64),
        1,
    )];
    let mut s = session(regions, Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    for (i, v) in [(0, 10), (1, 10), (2, 20)] {
        host.frames.insert(i, solid(v));
    }
    let reused: Vec<bool> = (0..3)
        .map(|i| {
            host.frame(&mut s, input(i, plan(vec![place("f", "c", "n", 0.0)])))
                .unwrap()
                .observation
                .decisions[0]
                .reused_exact_observation
        })
        .collect();
    assert_eq!(
        reused,
        vec![false, true, false],
        "the first paint has nothing to compare with"
    );
    assert_eq!(s.counters().skipped_paints, 1);
}

#[test]
fn a_moving_region_loads_the_current_then_the_previous_then_the_next_frame() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    for i in 0..3 {
        host.frames.insert(i, solid(10));
    }
    let p = || plan(vec![place("m", "c", "n", 0.0)]);
    let frame = FrameInput {
        has_prev: true,
        prev_plan: Some(p()),
        has_next: true,
        next_plan: Some(p()),
        ..input(1, p())
    };
    host.frame(&mut s, frame).unwrap();
    assert_eq!(host.asked, vec!["meta c", "frame 1", "frame 0", "frame 2"]);
}

#[test]
fn a_neighbour_on_another_canvas_is_loaded_but_not_compared() {
    // The neighbours show other content: compared, every pixel would be provisional.
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(
        graph(&[("n", "c", 0.0), ("o", "other", 0.0)]),
        vec![1; W * H],
    );
    host.metas.insert("c".into(), meta());
    host.frames.insert(0, solid(200));
    host.frames.insert(1, solid(10));
    host.frames.insert(2, solid(200));
    let other = || plan(vec![place("m", "other", "o", 0.0)]);
    let frame = FrameInput {
        has_prev: true,
        prev_plan: Some(other()),
        has_next: true,
        next_plan: Some(other()),
        ..input(1, plan(vec![place("m", "c", "n", 0.0)]))
    };
    host.frame(&mut s, frame).unwrap();
    assert_eq!(host.asked, vec!["meta c", "frame 1", "frame 0", "frame 2"]);
    assert_eq!(s.meta("c").unwrap().provisional_pixels, 0.0);
}

#[test]
fn a_disagreeing_neighbour_on_the_same_canvas_marks_pixels_provisional() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    host.frames.insert(0, solid(200));
    host.frames.insert(1, solid(10));
    let frame = FrameInput {
        has_prev: true,
        prev_plan: Some(plan(vec![place("m", "c", "n", 0.0)])),
        ..input(1, plan(vec![place("m", "c", "n", 0.0)]))
    };
    host.frame(&mut s, frame).unwrap();
    assert_eq!(s.meta("c").unwrap().provisional_pixels, (W * H) as f64);
}

#[test]
fn the_ring_reuses_the_slot_filled_longest_ago_even_if_a_placement_still_holds_it() {
    let mut ring = FrameRing::new(4);
    // Frame 5 entered before frame 4 (a current frame uploaded before its previous one).
    let five = ring.fill(5);
    let four = ring.fill(4);
    let six = ring.fill(6);
    assert_eq!(ring.fill(5), five, "a held frame is not re-entered");
    let seven = ring.fill(7);
    assert_eq!(seven, five, "frame 5 entered first, so its slot goes first");
    assert_ne!(seven, four);
    assert_ne!(seven, six);
    assert_eq!(ring.get(5), None);
}

#[test]
fn the_voting_window_reads_each_record_once_over_consecutive_frames() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[]), vec![1; W * H]);
    let mut reads = Vec::new();
    for i in 0..4u32 {
        let wanted = s.wanted_votes(i, i > 0, i < 3);
        reads.extend(wanted.iter().copied());
        let frame = FrameInput {
            has_prev: i > 0,
            has_next: i < 3,
            ..input(i, plan(vec![]))
        };
        s.begin(frame, wanted.into_iter().map(|i| (i, None)).collect())
            .unwrap();
        let mut io = RenderIo {
            cache: &mut host.cache,
            compositor: &mut host.compositor,
            graph: &host.graph,
            labels: &host.labels,
            now: 0.0,
        };
        assert!(matches!(s.step(&mut io), Ok(RenderStep::Done(_))));
    }
    assert_eq!(reads, vec![0, 1, 2, 3]);
}

#[test]
fn a_truncated_vote_is_refused() {
    let mut s = session(moving_only(), Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), vec![1; W * H]);
    host.metas.insert("c".into(), meta());
    host.frames.insert(0, solid(10));
    let record: ConsistencyRecord = [(
        "m".to_string(),
        ConsistencyVote {
            x0: 0,
            y0: 0,
            w: 32,
            h: 16,
            bits: vec![0; 3],
            clean: vec![0; 64],
        },
    )]
    .into_iter()
    .collect();
    s.begin(
        input(0, plan(vec![place("m", "c", "n", 0.0)])),
        vec![(0, Some(record))],
    )
    .unwrap();
    let err = loop {
        let mut io = RenderIo {
            cache: &mut host.cache,
            compositor: &mut host.compositor,
            graph: &host.graph,
            labels: &host.labels,
            now: 0.0,
        };
        match s.step(&mut io) {
            Ok(RenderStep::NeedMeta(c)) => s.provide_meta(&c, Some(meta())),
            Ok(RenderStep::NeedFrame(i)) => s.frame_slot(i).copy_from_slice(&host.frames[&i]),
            other => break other,
        }
    };
    assert_eq!(err, Err(RenderError::BadVote));
}

#[test]
fn metas_come_back_dirty_in_first_changed_order_once() {
    let regions = vec![
        region("a", RegionKind::Moving, rect(0.0, 0.0, 16.0, H as f64), 1),
        region("b", RegionKind::Moving, rect(16.0, 0.0, 16.0, H as f64), 2),
    ];
    let mut labels = vec![1u8; W * H];
    for y in 0..H {
        for x in 16..W {
            labels[y * W + x] = 2;
        }
    }
    let mut s = session(regions, Vec::new());
    let mut host = Host::new(graph(&[("n", "c", 0.0)]), labels);
    host.metas.insert("y".into(), meta());
    host.metas.insert("x".into(), meta());
    host.frames.insert(0, solid(10));
    host.frames.insert(1, solid(10));
    let p = |order: [(&str, &str); 2]| {
        plan(
            order
                .iter()
                .map(|&(layer, canvas)| place(layer, canvas, "n", 0.0))
                .collect(),
        )
    };
    host.frame(&mut s, input(0, p([("a", "y"), ("b", "x")])))
        .unwrap();
    host.frame(&mut s, input(1, p([("b", "x"), ("a", "y")])))
        .unwrap();
    let dirty: Vec<String> = s.take_dirty_metas().into_iter().map(|(c, _)| c).collect();
    assert_eq!(dirty, vec!["y", "x"]);
    assert!(s.take_dirty_metas().is_empty());
}

#[test]
fn an_attached_fragment_paints_on_its_target_shifted_by_the_chain() {
    let attach = Attachment {
        id: "frag".into(),
        target: "main".into(),
        dx: 16.0,
        dy: 0.0,
        frame: 0,
        confidence: 1.0,
        node: "anchor".into(),
    };
    let mut s = session(moving_only(), vec![attach]);
    let mut host = Host::new(
        graph(&[("n", "frag", 0.0), ("anchor", "main", 0.0)]),
        vec![1; W * H],
    );
    host.metas.insert("main".into(), meta());
    host.frames.insert(0, solid(10));
    let done = host
        .frame(&mut s, input(0, plan(vec![place("m", "frag", "n", 0.0)])))
        .unwrap();
    let d = &done.observation.decisions[0];
    assert_eq!(d.canvas_id, "main");
    assert_eq!(
        (d.placement.canvas_id.as_str(), d.placement.x),
        ("main", 16.0)
    );
    assert_eq!(
        s.meta("main").unwrap().bounds,
        rect(16.0, 0.0, W as f64, H as f64)
    );
}

#[test]
fn the_tile_budget_is_raised_to_what_one_frame_paints() {
    let regions = vec![
        region("m", RegionKind::Moving, rect(0.0, 0.0, 320.0, 160.0), 1),
        region("f", RegionKind::Fixed, rect(0.0, 0.0, 10.5, 4.0), 2),
        region("i", RegionKind::Ignore, rect(0.0, 0.0, 3200.0, 3200.0), 3),
    ];
    let s = RenderSession::new(RenderConfig {
        width: 320,
        height: 160,
        factor: 1,
        noise: 0.0,
        regions,
        attachments: Vec::new(),
    });
    let mut cache = TileCache::new(TILE, 1.0).unwrap();
    let event = s.configure_tiles(&mut cache, 1.0).unwrap();
    // (320/16+1)·(160/16+1) + (ceil(10.5/16)+1)·(4/16 ceil +1) + 2; the ignored region does not count.
    let needed = 21 * 11 + 2 * 2 + 2;
    assert_eq!(cache.max_tiles(), needed);
    assert_eq!(event.code, "MEMORY_BUDGET_RAISED");
    let params: Vec<(&str, f64)> = event
        .params
        .iter()
        .filter(|(n, _)| *n != "mb")
        .copied()
        .collect();
    assert_eq!(params, vec![("from", 2.0), ("to", needed as f64)]);
    assert_eq!(
        event.detail,
        Some(Value::Object(vec![
            ("budgetMB", Value::Number(1.0)),
            ("tiles", Value::Number(needed as f64)),
            ("raisedBy", Value::Number((needed - 2) as f64)),
        ]))
    );
    let mut roomy = TileCache::new(TILE, 4096.0).unwrap();
    assert_eq!(s.configure_tiles(&mut roomy, 4096.0), None);
}
