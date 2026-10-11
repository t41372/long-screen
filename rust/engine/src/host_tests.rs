//! Native host test: drives the tile cache and the compositor through their public API the way a native host does: a synchronous loop
//! that answers every `NeedTile` / `NeedTemporal` from an in-memory store and keeps what the cache evicts.

use crate::compositor::{
    CompositeError, Compositor, CompositorDiagnostic, Frame, Outcome, Placement, Step,
    TemporalPolicy,
};
use crate::tiles::{StoredTile, Tile, TileCache, TileKey};
use long_screen_core::geometry::Rect;
use std::collections::HashMap;

const TILE: usize = 16;
const W: usize = 32;
const H: usize = 16;

#[derive(Default)]
struct Host {
    store: HashMap<TileKey, StoredTile>,
    stored_writes: usize,
}

impl Host {
    fn keep(&mut self, t: Tile) {
        if t.dirty {
            self.stored_writes += 1;
            self.store.insert(
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
    }

    fn run(
        &mut self,
        compositor: &mut Compositor,
        cache: &mut TileCache,
        frame: &Frame,
    ) -> Result<Outcome, CompositeError> {
        loop {
            match compositor.step(cache, frame, 1.0)? {
                Step::NeedTile(key) => {
                    while let Some(id) = cache.victim() {
                        let t = cache.evict(id).unwrap();
                        self.keep(t);
                    }
                    let stored = self.store.get(&key).cloned();
                    cache.insert(key, stored).unwrap();
                }
                Step::NeedTemporal(canvas) => compositor.load_temporal(&canvas, Vec::new())?,
                Step::Done(outcome) => return Ok(outcome),
            }
        }
    }
}

fn solid(rgba: [u8; 4]) -> Vec<u8> {
    rgba.iter().copied().cycle().take(W * H * 4).collect()
}

fn placement(frame: u32) -> Placement {
    Placement {
        canvas: "c".into(),
        region: Rect {
            x: 0.0,
            y: 0.0,
            width: W as f64,
            height: H as f64,
        },
        code: 1,
        owned_pixels: (W * H) as f64,
        x: 0.0,
        y: 0.0,
        frame,
        time: frame as f64 / 30.0,
        confidence: 0.5,
        uncertain: false,
        occlusions: Vec::new(),
    }
}

fn frame<'a>(rgba: &'a [u8], labels: &'a [u8]) -> Frame<'a> {
    Frame {
        rgba,
        width: W,
        height: H,
        labels,
        consistent: None,
    }
}

#[test]
fn step_without_a_placement_is_refused() {
    let mut cache = TileCache::new(TILE, 128.0).unwrap();
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    let (rgba, labels) = (solid([1, 2, 3, 255]), vec![1; W * H]);
    assert_eq!(
        compositor.step(&mut cache, &frame(&rgba, &labels), 0.0),
        Err(CompositeError::NoPlacement)
    );
}

#[test]
fn a_second_placement_before_the_first_finishes_is_refused() {
    let cache = TileCache::new(TILE, 128.0).unwrap();
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    compositor.begin(&cache, placement(0), W, H).unwrap();
    assert_eq!(
        compositor.begin(&cache, placement(1), W, H),
        Err(CompositeError::Busy)
    );
    compositor.cancel();
    assert!(compositor.begin(&cache, placement(1), W, H).is_ok());
}

#[test]
fn a_frame_of_another_size_is_refused() {
    let cache = TileCache::new(TILE, 128.0).unwrap();
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    assert_eq!(
        compositor.begin(&cache, placement(0), W, H + 1),
        Err(CompositeError::FrameSize)
    );
}

#[test]
fn a_pose_outside_the_addressable_canvas_is_refused() {
    let cache = TileCache::new(TILE, 128.0).unwrap();
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    for x in [f64::NAN, f64::INFINITY, 1e12] {
        let p = Placement { x, ..placement(0) };
        assert_eq!(
            compositor.begin(&cache, p, W, H),
            Err(CompositeError::OutsideCanvas)
        );
    }
}

#[test]
fn two_frames_paint_conflict_resolve_and_survive_eviction() {
    let mut cache = TileCache::new(TILE, 128.0).unwrap();
    // One tile at a time: the placement spans two tiles, so every step evicts the other one.
    cache.set_max_tiles(1);
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    let mut host = Host::default();
    let labels = vec![1u8; W * H];

    let base = solid([100, 100, 100, 255]);
    compositor.begin(&cache, placement(0), W, H).unwrap();
    let first = host
        .run(&mut compositor, &mut cache, &frame(&base, &labels))
        .unwrap();
    assert_eq!(first.stats.added, (W * H) as u64);
    assert_eq!(first.stats.tiles, 2);
    assert!(first.diagnostics.is_empty());
    assert_eq!(
        cache.stats().evictions,
        1,
        "the first tile left to make room for the second"
    );
    assert_eq!(
        host.stored_writes, 1,
        "the evicted tile was dirty and stored"
    );

    let hot = solid([250, 10, 10, 255]);
    compositor.begin(&cache, placement(1), W, H).unwrap();
    let second = host
        .run(&mut compositor, &mut cache, &frame(&hot, &labels))
        .unwrap();
    assert_eq!(second.stats.added, 0, "every pixel was already covered");
    let conflicts: Vec<_> = second
        .diagnostics
        .iter()
        .filter(|d| matches!(d, CompositorDiagnostic::Conflict { .. }))
        .collect();
    assert_eq!(conflicts.len(), 1, "one conflict summary per placement");
    assert_eq!(
        cache.stats().decoded,
        2,
        "both tiles were reloaded from what the host stored"
    );

    // Flush the cache the way a host does and check the stored pixels: the conflict took the complete moment.
    for id in cache.dirty(None) {
        let t = cache.get(id).unwrap().clone();
        host.keep(t);
        cache.saved(id);
    }
    while let Some(id) = cache.victim() {
        let t = cache.evict(id).unwrap();
        host.keep(t);
    }
    for x in 0..2 {
        let t = &host.store[&TileKey::new("c", 0, x, 0)];
        assert!(t.pixels.chunks_exact(4).all(|p| p == [250, 10, 10, 255]));
        assert!(t.coverage.as_ref().unwrap().iter().all(|&b| b == 0xff));
    }

    let flushed = compositor.flush();
    assert_eq!(flushed.len(), 1);
    assert_eq!(flushed[0].canvas, "c");
    assert!(flushed[0].deleted.is_empty());
    assert_eq!(
        flushed[0].dirty.len(),
        1,
        "one temporal record for the conflicting area"
    );
    assert!(flushed[0].dirty[0].0.complete);
    assert!(
        compositor.flush()[0].dirty.is_empty(),
        "a second flush has nothing left"
    );
}

#[test]
fn a_conflict_on_a_disposed_canvas_is_refused_and_the_flush_keeps_its_rows() {
    let mut cache = TileCache::new(TILE, 128.0).unwrap();
    let mut compositor = Compositor::new(TemporalPolicy::Stable, W, H);
    let mut host = Host::default();
    let labels = vec![1u8; W * H];
    let (base, hot) = (solid([100, 100, 100, 255]), solid([250, 10, 10, 255]));
    compositor.begin(&cache, placement(0), W, H).unwrap();
    host.run(&mut compositor, &mut cache, &frame(&base, &labels))
        .unwrap();
    compositor.begin(&cache, placement(1), W, H).unwrap();
    host.run(&mut compositor, &mut cache, &frame(&hot, &labels))
        .unwrap();
    compositor.dispose();
    compositor.begin(&cache, placement(2), W, H).unwrap();
    assert_eq!(
        host.run(&mut compositor, &mut cache, &frame(&base, &labels)),
        Err(CompositeError::Disposed)
    );
    assert_eq!(
        compositor.flush()[0].dirty.len(),
        1,
        "disposing kept the unflushed record"
    );
}

#[test]
fn loading_temporal_records_twice_is_refused() {
    let mut compositor = Compositor::new(TemporalPolicy::Latest, W, H);
    compositor.load_temporal("c", Vec::new()).unwrap();
    assert_eq!(
        compositor.load_temporal("c", Vec::new()),
        Err(CompositeError::Unexpected)
    );
}
