//! A native host driving the render pass through its public API the way the page does: decode one frame ahead,
//! composite the buffered frame with its previous and next frames in hand, answer every need from in-memory stores
//! (a one-tile cache, so every tile is evicted and reloaded), store dirty canvas metadata on a cadence, and keep
//! each frame's observation row.
//!
//! The recording scrolls a page down 4 px a frame under a 2 px screen-fixed red bar. Every page row is seen clean
//! in some frame; the world-consistency mask (docs/ARCHITECTURE.md §七) keeps the bar out of every row that a
//! clean frame painted first, and only the rows the very first frame painted under the bar keep it: no later
//! frame has two clean neighbours there to heal them, which is the documented recording-boundary limit.

use long_screen::engine::compositor::{Compositor, TemporalPolicy};
use long_screen::engine::pose_graph::{PoseGraph, PoseNode};
use long_screen::engine::render::{
    CanvasMeta, FrameInput, FramePlan, Observation, PlanPlacement, RegionKind, RenderConfig,
    RenderIo, RenderRegion, RenderSession, RenderStep,
};
use long_screen::engine::tiles::{StoredTile, TileCache, TileKey};
use long_screen::kernels::geometry::Rect;
use std::collections::HashMap;

const W: usize = 32;
const H: usize = 16;
const TILE: usize = 16;
const FRAMES: u32 = 8;
const STEP: usize = 4;
const BAR: std::ops::Range<usize> = 6..8;
const RED: [u8; 4] = [255, 0, 0, 255];

fn page(row: usize) -> [u8; 4] {
    [(row * 7 % 200) as u8 + 20, 100, 50, 255]
}

fn frame(t: u32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(W * H * 4);
    for y in 0..H {
        let px = if BAR.contains(&y) {
            RED
        } else {
            page(y + t as usize * STEP)
        };
        for _ in 0..W {
            rgba.extend_from_slice(&px);
        }
    }
    rgba
}

fn plan(t: u32) -> FramePlan {
    FramePlan {
        placements: vec![PlanPlacement {
            layer: "page".into(),
            canvas_id: "c".into(),
            node: format!("n{t}"),
            x: 0.0,
            y: (t as usize * STEP) as f64,
            confidence: 1.0,
            uncertain: false,
            time: t as f64 / 30.0,
            skip: None,
            occlusions: None,
        }],
        duplicate: false,
    }
}

fn stored(t: long_screen::engine::tiles::Tile) -> StoredTile {
    StoredTile {
        pixels: t.pixels,
        coverage: Some(t.coverage),
        provisional: Some(t.provisional),
        quality: Some(t.quality),
        conflicts: Some(t.conflicts),
        owner: Some(t.owner),
        score: Some(t.score),
        frozen: Some(t.frozen),
    }
}

struct Host {
    cache: TileCache,
    compositor: Compositor,
    graph: PoseGraph,
    labels: Vec<u8>,
    tiles: HashMap<TileKey, StoredTile>,
    metas: HashMap<String, CanvasMeta>,
    observations: Vec<Observation>,
}

impl Host {
    fn composite(
        &mut self,
        s: &mut RenderSession,
        t: u32,
        decoded: &HashMap<u32, Vec<u8>>,
        has_next: bool,
    ) {
        let input = FrameInput {
            index: t,
            time: t as f64 / 30.0,
            plan: plan(t),
            has_prev: t > 0,
            prev_plan: (t > 0).then(|| plan(t - 1)),
            has_next,
            next_plan: has_next.then(|| plan(t + 1)),
        };
        let wanted = s.wanted_votes(t, input.has_prev, input.has_next);
        s.begin(input, wanted.into_iter().map(|i| (i, None)).collect())
            .unwrap();
        loop {
            let mut io = RenderIo {
                cache: &mut self.cache,
                compositor: &mut self.compositor,
                graph: &self.graph,
                labels: &self.labels,
                now: t as f64,
            };
            match s.step(&mut io).unwrap() {
                RenderStep::NeedMeta(c) => s.provide_meta(&c, self.metas.get(&c).copied()),
                RenderStep::NeedFrame(i) => s.frame_slot(i).copy_from_slice(&decoded[&i]),
                RenderStep::NeedTile(key) => {
                    while let Some(id) = self.cache.victim() {
                        let old = self.cache.evict(id).unwrap();
                        if old.dirty {
                            self.tiles.insert(old.key.clone(), stored(old));
                        }
                    }
                    let tile = self.tiles.get(&key).cloned();
                    self.cache.insert(key, tile).unwrap();
                }
                RenderStep::NeedTemporal(c) => {
                    self.compositor.load_temporal(&c, Vec::new()).unwrap()
                }
                RenderStep::Done(outcome) => {
                    assert_eq!(outcome.latest.as_deref(), Some("c"));
                    self.observations.push(outcome.observation);
                    break;
                }
            }
        }
        assert!(s.take_events().iter().all(|e| e.code != "NONFINITE_POSE"));
        if t % 3 == 2 {
            for (id, meta) in s.take_dirty_metas() {
                self.metas.insert(id, meta);
            }
        }
    }
}

#[test]
fn a_scrolled_page_renders_through_the_lookahead_loop_and_keeps_the_bar_out() {
    let mut graph = PoseGraph::new();
    for t in 0..FRAMES {
        graph.hydrate_node(PoseNode {
            id: format!("n{t}"),
            canvas_id: "c".into(),
            frame: t,
            x: 0.0,
            y: (t as usize * STEP) as f64,
            original_x: 0.0,
            original_y: (t as usize * STEP) as f64,
            pinned: false,
            next: None,
        });
    }
    let whole = Rect {
        x: 0.0,
        y: 0.0,
        width: W as f64,
        height: H as f64,
    };
    let mut s = RenderSession::new(RenderConfig {
        width: W,
        height: H,
        factor: 1,
        noise: 0.0,
        regions: vec![RenderRegion {
            id: "page".into(),
            kind: RegionKind::Moving,
            rect: whole,
            code: 1,
            owned_pixels: (W * H) as f64,
        }],
        attachments: Vec::new(),
    });
    let mut cache = TileCache::new(TILE, 128.0).unwrap();
    cache.set_max_tiles(1);
    let mut host = Host {
        cache,
        compositor: Compositor::new(TemporalPolicy::Stable, W, H),
        graph,
        labels: vec![1; W * H],
        tiles: HashMap::new(),
        metas: HashMap::from([(
            "c".to_string(),
            CanvasMeta {
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                tile_count: 0.0,
                observed_pixels: 0.0,
                uncertain_pixels: 0.0,
                conflict_pixels: 0.0,
                provisional_pixels: 0.0,
                last_time: 0.0,
            },
        )]),
        observations: Vec::new(),
    };

    // One-frame lookahead: frame t is composited once t + 1 is decoded; the last one when decoding ends.
    let mut decoded = HashMap::new();
    let mut pending: Option<u32> = None;
    for t in 0..FRAMES {
        decoded.insert(t, frame(t));
        if let Some(p) = pending {
            host.composite(&mut s, p, &decoded, true);
            decoded.remove(&(p.wrapping_sub(1)));
        }
        pending = Some(t);
    }
    host.composite(&mut s, pending.unwrap(), &decoded, false);
    for (id, meta) in s.take_dirty_metas() {
        host.metas.insert(id, meta);
    }
    for id in host.cache.dirty(None) {
        let t = host.cache.get(id).unwrap().clone();
        host.tiles.insert(t.key.clone(), stored(t));
        host.cache.saved(id);
    }

    assert_eq!(host.observations.len(), FRAMES as usize);
    for (t, o) in host.observations.iter().enumerate() {
        assert_eq!(o.frame, t as u32);
        assert_eq!(o.decisions.len(), 1);
        assert!(!o.decisions[0].skipped && !o.decisions[0].reused_exact_observation);
    }
    let height = H + (FRAMES as usize - 1) * STEP;
    let meta = host.metas["c"];
    assert_eq!(
        meta.bounds,
        Rect {
            x: 0.0,
            y: 0.0,
            width: W as f64,
            height: height as f64
        }
    );
    assert_eq!(meta.observed_pixels, (W * height) as f64);
    assert_eq!(s.counters().observed_pixels, (W * height) as f64);

    let pixel = |x: usize, y: usize| -> [u8; 4] {
        let t = &host.tiles[&TileKey::new("c", 0, (x / TILE) as i32, (y / TILE) as i32)];
        let i = ((y % TILE) * TILE + x % TILE) * 4;
        t.pixels[i..i + 4].try_into().unwrap()
    };
    for y in 0..height {
        let expected = if BAR.contains(&y) { RED } else { page(y) };
        for x in [0, W - 1] {
            assert_eq!(pixel(x, y), expected, "world row {y}");
        }
    }
}
