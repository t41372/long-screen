//! Native host test of the reveal stage: a page scrolls under a floating button that the compositor burned into the
//! canvas, and a synchronous host drives the reveal session through its public API alone — answering the memory check
//! and the observation rows, decoding every pass from frames held in memory, and bringing tiles in and out of a small
//! cache backed by an in-memory store, as the native command line will.

use crate::engine::reveal::{
    MemoryStage, ObservedDecision, Outcome, Pass, Provenance, RevealCanvas, RevealLayer,
    RevealSession, Step,
};
use crate::engine::tiles::{StoredTile, Tile, TileCache, TileKey};
use crate::kernels::geometry::Rect;
use std::collections::BTreeMap;

const SIZE: usize = 32;
const W: usize = 160;
const H: usize = 160;
const PAGE_H: usize = 480;
const STEP: usize = 16;
/// The floating button: a 16 × 16 magenta square fixed on screen.
const BUTTON: (usize, usize) = (64, 96);
const MAGENTA: [u8; 4] = [255, 0, 255, 255];

/// The page: a different colour in every 4 × 4 cell.
fn page(x: usize, y: usize) -> [u8; 4] {
    let h = ((x / 4) as u32)
        .wrapping_mul(2_654_435_761)
        .wrapping_add(((y / 4) as u32).wrapping_mul(40_503))
        .rotate_left(13)
        .wrapping_mul(2_246_822_519);
    [(h >> 24) as u8, (h >> 16) as u8, (h >> 8) as u8, 255]
}

/// Frame `k`: the page from world row `STEP × k`, with the button on top.
fn frame(k: usize) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(W * H * 4);
    for sy in 0..H {
        for sx in 0..W {
            let button =
                (BUTTON.0..BUTTON.0 + 16).contains(&sx) && (BUTTON.1..BUTTON.1 + 16).contains(&sy);
            rgba.extend_from_slice(&if button {
                MAGENTA
            } else {
                page(sx, sy + STEP * k)
            });
        }
    }
    rgba
}

#[derive(Default)]
struct Store {
    tiles: BTreeMap<String, StoredTile>,
}

impl Store {
    fn put(&mut self, t: &Tile) {
        self.tiles.insert(
            t.key.path(),
            StoredTile {
                pixels: t.pixels.clone(),
                coverage: Some(t.coverage.clone()),
                provisional: Some(t.provisional.clone()),
                quality: Some(t.quality.clone()),
                conflicts: Some(t.conflicts.clone()),
                owner: Some(t.owner.clone()),
                score: Some(t.score.clone()),
                frozen: Some(t.frozen.clone()),
            },
        );
    }

    /// The stored canvas pixel at world (x, y).
    fn pixel(&self, x: usize, y: usize) -> [u8; 4] {
        let key = TileKey::new("world", 0, (x / SIZE) as i32, (y / SIZE) as i32);
        let t = &self.tiles[&key.path()];
        let p = ((y % SIZE) * SIZE + x % SIZE) * 4;
        t.pixels[p..p + 4].try_into().unwrap()
    }
}

/// Makes room (storing what is dirty) and brings `key` in from the store.
fn load(cache: &mut TileCache, store: &mut Store, key: TileKey, loads: &mut usize) {
    while let Some(id) = cache.victim() {
        let t = cache.evict(id).unwrap();
        if t.dirty {
            cache.encoded();
            store.put(&t);
        }
    }
    let stored = store.tiles.get(&key.path()).cloned();
    cache.insert(key, stored).unwrap();
    *loads += 1;
}

#[test]
fn a_native_host_reveals_the_page_under_a_floating_button() {
    let frames: Vec<Vec<u8>> = (0..=(PAGE_H - H) / STEP).map(frame).collect();
    // The compositor's canvas: every world pixel from the first frame that showed it, so frame 0's button is burned
    // in at world (64, 96).
    let mut store = Store::default();
    for ty in 0..PAGE_H / SIZE {
        for tx in 0..W / SIZE {
            let mut pixels = vec![0u8; SIZE * SIZE * 4];
            for ly in 0..SIZE {
                for lx in 0..SIZE {
                    let (x, y) = (tx * SIZE + lx, ty * SIZE + ly);
                    let k = (y + 1).saturating_sub(H).div_ceil(STEP);
                    let p = ((y - STEP * k) * W + x) * 4;
                    pixels[(ly * SIZE + lx) * 4..(ly * SIZE + lx) * 4 + 4]
                        .copy_from_slice(&frames[k][p..p + 4]);
                }
            }
            store.tiles.insert(
                TileKey::new("world", 0, tx as i32, ty as i32).path(),
                StoredTile {
                    pixels,
                    coverage: Some(vec![0xff; SIZE * SIZE / 8]),
                    ..StoredTile::default()
                },
            );
        }
    }
    assert_eq!(store.pixel(70, 100), MAGENTA, "the button is burned in");

    let full = |w: usize, h: usize| Rect {
        x: 0.0,
        y: 0.0,
        width: w as f64,
        height: h as f64,
    };
    let mut session = RevealSession::new(
        W,
        H,
        10.0,
        SIZE,
        frames.len() as u32,
        vec![RevealLayer {
            id: "page".into(),
            rect: full(W, H),
            code: 0,
        }],
        vec![RevealCanvas {
            id: "world".into(),
            bounds: full(W, PAGE_H),
        }],
    )
    .unwrap();
    // A cache far smaller than the canvas, so tiles leave and come back while the passes write.
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    cache.set_max_tiles(4);
    let (mut loads, mut checkpoints) = (0, 0);
    let (mut passes, mut memory) = (Vec::new(), Vec::new());
    let mut provenance: Vec<Provenance> = Vec::new();
    let mut now = 0.0;
    let summary = loop {
        now += 1.0;
        match session.step(&mut cache, now).unwrap() {
            Step::NeedMemory { bytes, stage } => {
                memory.push((stage, bytes));
                session.memory(true, 0.0).unwrap();
            }
            Step::NeedObservations => {
                for k in 0..frames.len() {
                    let d = ObservedDecision {
                        canvas: "world".into(),
                        layer: "page".into(),
                        x: 0.0,
                        y: (STEP * k) as f64,
                        skip: false,
                        skipped: false,
                        occlusions: Vec::new(),
                    };
                    session.observation(k as u32, &[d]).unwrap();
                }
            }
            Step::NeedTile(key) => load(&mut cache, &mut store, key, &mut loads),
            Step::Checkpoint => checkpoints += 1,
            Step::Decode { pass, wanted } => {
                passes.push(pass);
                assert_eq!(wanted.len(), frames.len());
                for (k, f) in frames.iter().enumerate() {
                    if wanted[k] {
                        session.frame_buffer().unwrap().copy_from_slice(f);
                    }
                    session.push_frame(k as u32, None).unwrap();
                    loop {
                        match session.step(&mut cache, now).unwrap() {
                            Step::NextFrame => break,
                            Step::NeedTile(key) => load(&mut cache, &mut store, key, &mut loads),
                            other => panic!("unexpected {other:?} inside a frame"),
                        }
                    }
                }
                session.end_pass(None).unwrap();
                loop {
                    match session.step(&mut cache, now).unwrap() {
                        Step::PassDone(p) => {
                            assert_eq!(p, pass);
                            break;
                        }
                        Step::NeedTile(key) => load(&mut cache, &mut store, key, &mut loads),
                        other => panic!("unexpected {other:?} at the end of a pass"),
                    }
                }
            }
            Step::Provenance(p) => provenance.push(p),
            Step::Done(Outcome::Revealed(summary)) => break summary,
            other => panic!("unexpected {other:?}"),
        }
    };
    // The host flushes what is still dirty.
    for id in cache.dirty(None) {
        store.put(cache.get(id).unwrap());
        cache.saved(id);
    }

    // Every block was seen whole and clean, so the write pass holds no per-pixel fallback state.
    assert_eq!(memory[0].0, MemoryStage::Canvases);
    assert!(memory[0].1 > (3 * W * H * 4) as f64);
    assert_eq!(memory[1], (MemoryStage::Fallback, 0.0));
    assert_eq!(
        passes,
        vec![Pass::Learn, Pass::Agree, Pass::Relearn, Pass::Write]
    );
    assert_eq!(
        checkpoints,
        (W / SIZE) * (PAGE_H / SIZE),
        "one checkpoint per compositor tile"
    );
    assert!(loads > checkpoints, "tiles came back after eviction");
    assert!(summary.objects >= 1, "the button was modelled: {summary:?}");
    // The page is back under the burned-in button, and the rest of the canvas is untouched.
    for y in 0..PAGE_H {
        for x in 0..W {
            assert_eq!(store.pixel(x, y), page(x, y), "world ({x}, {y})");
        }
    }
    // Its block is owned by a later frame, which the provenance row names.
    let [p] = &provenance[..] else {
        panic!("one provenance row, got {}", provenance.len());
    };
    assert_eq!(
        (p.canvas.as_str(), p.gx, p.gy, p.bw),
        ("world", 0, 0, W / 16)
    );
    let source = p.source[(BUTTON.1 / 16) * p.bw + BUTTON.0 / 16];
    assert!(
        source >= 1,
        "block under the button comes from frame {source}"
    );
}
