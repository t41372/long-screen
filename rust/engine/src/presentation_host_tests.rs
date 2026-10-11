//! Native host test of the presentation stage: frames a canvas and then builds the framed canvas's preview pyramid
//! through the public API alone, the way a native host does it — a synchronous loop over an in-memory store that
//! answers every request and stores what the sessions hand back.

use crate::framing::{FramingSession, Outcome, Reference, SaveTile, SourceCanvas, Step};
use crate::pyramid::{self, PyramidSession};
use crate::tiles::{StoredTile, Tile, TileCache, TileKey};
use long_screen_core::geometry::Rect;
use std::collections::BTreeMap;

const SIZE: usize = 32;

#[derive(Default)]
struct Store {
    tiles: BTreeMap<String, (TileKey, StoredTile)>,
}

impl Store {
    fn put(&mut self, t: Tile) {
        self.tiles.insert(
            t.key.path(),
            (
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
            ),
        );
    }

    fn get(&self, key: &TileKey) -> Option<StoredTile> {
        self.tiles.get(&key.path()).map(|(_, t)| t.clone())
    }

    /// `(x, y, observed)` of the stored tiles of `canvas` at `level`, in the store's key order.
    fn index(&self, canvas: &str, level: u32) -> Vec<(i32, i32, u64)> {
        let prefix = format!("{canvas}/{level}/");
        self.tiles
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(_, (k, t))| {
                let observed = t
                    .coverage
                    .as_ref()
                    .map_or(0, |c| crate::tiles::count_covered(c));
                (k.x, k.y, observed)
            })
            .collect()
    }
}

#[test]
fn a_native_host_frames_a_canvas_and_builds_its_pyramid() {
    let mut store = Store::default();
    // A 100 × 90 reconstructed canvas: 4 × 3 fully observed, opaque tiles.
    for x in 0..4 {
        for y in 0..3 {
            let n = SIZE * SIZE;
            let mut pixels = vec![0u8; n * 4];
            for p in pixels.chunks_exact_mut(4) {
                p.copy_from_slice(&[60 + x as u8 * 30, 40 + y as u8 * 50, 90, 255]);
            }
            store.tiles.insert(
                TileKey::new("world", 0, x, y).path(),
                (
                    TileKey::new("world", 0, x, y),
                    StoredTile {
                        pixels,
                        coverage: Some(vec![255; n / 8]),
                        ..StoredTile::default()
                    },
                ),
            );
        }
    }
    // A 64 × 48 reference frame seen through a 40 × 30 pane at (8, 12).
    let (rw, rh) = (64usize, 48usize);
    let mut rgba = Vec::with_capacity(rw * rh * 4);
    for y in 0..rh {
        for x in 0..rw {
            rgba.extend_from_slice(&[x as u8 * 3, y as u8 * 4, 20, 255]);
        }
    }
    let pane = Rect {
        x: 8.0,
        y: 12.0,
        width: 40.0,
        height: 30.0,
    };
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    cache.set_max_tiles(3);
    let mut framing = FramingSession::new(
        SourceCanvas {
            id: "world".into(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 90.0,
            },
            tile_count: 12,
            attached: false,
        },
        pane,
        Vec::new(),
        SIZE,
        crate::framing::DEFAULT_MAX_TILES,
    );
    let framed = loop {
        match framing.step(&mut cache, 0.0).unwrap() {
            Step::NeedReference => framing
                .reference(Some(Reference {
                    frame: 7,
                    width: rw,
                    height: rh,
                    rgba: rgba.clone(),
                }))
                .unwrap(),
            Step::NeedIndex => {
                for (x, y, observed) in store.index("world", 0) {
                    framing.index(x, y, observed).unwrap();
                }
            }
            Step::Next => {}
            Step::NeedTile(key) => {
                while let Some(t) = cache.evict() {
                    if t.dirty {
                        cache.encoded();
                        store.put(t);
                    }
                }
                let stored = store.get(&key);
                cache.insert(key, stored).unwrap();
            }
            Step::Save(SaveTile::Resident(id)) => {
                store.put(cache.get(id).unwrap().clone());
                cache.encoded();
                cache.saved(id);
            }
            Step::Save(SaveTile::Detached(t)) => {
                cache.encoded();
                store.put(*t);
            }
            Step::Done(Outcome::Framed(f)) => break f,
            Step::Done(other) => panic!("expected a framed canvas, got {other:?}"),
        }
    };
    // 64 + 100 − 40 = 124 wide, 48 + 90 − 30 = 108 tall: 4 × 4 tiles, every one painted.
    assert_eq!((framed.width, framed.height), (124.0, 108.0));
    assert_eq!(framed.tile_count, 16);
    assert_eq!(store.index("world-framed", 0).len(), 16);
    // Every reconstructed pixel is copied and covered; the chrome is copied but not covered.
    assert_eq!(
        framed.observed_pixels,
        100 * 90 + chrome_pixels(&pane, rw, rh)
    );
    // A reconstructed pixel lands at its canvas position plus the offset.
    let (ox, oy) = (framed.offset_x as usize, framed.offset_y as usize);
    let at = |x: usize, y: usize| {
        let t = store
            .get(&TileKey::new(
                "world-framed",
                0,
                (x / SIZE) as i32,
                (y / SIZE) as i32,
            ))
            .unwrap();
        let p = ((y % SIZE) * SIZE + x % SIZE) * 4;
        [
            t.pixels[p],
            t.pixels[p + 1],
            t.pixels[p + 2],
            t.pixels[p + 3],
        ]
    };
    assert_eq!(at(ox + 40, oy + 70), [60 + 30, 40 + 2 * 50, 90, 255]);
    // The chrome above the pane is the reference frame's own pixel.
    assert_eq!(at(3, 5), [9, 20, 20, 255]);

    // Its pyramid: 108 × 124 over 32-pixel tiles has two levels above level 0.
    let mut session =
        PyramidSession::new("world-framed", framed.width, framed.height, SIZE).unwrap();
    assert_eq!(session.levels(), pyramid::level_count(124.0, 108.0, SIZE));
    let mut levels = Vec::new();
    loop {
        match session.step() {
            pyramid::Step::NeedIndex { level } => {
                for (x, y, _) in store.index("world-framed", level - 1) {
                    session.queue(x, y).unwrap();
                }
            }
            pyramid::Step::NeedChildren { children, .. } => {
                let got = children.map(|k| store.get(&k).map(|t| t.pixels));
                session.provide(got).unwrap();
            }
            pyramid::Step::Parent {
                level,
                x,
                y,
                pixels,
            } => {
                if let Some(pixels) = pixels {
                    let key = TileKey::new("world-framed", level, x, y);
                    store.tiles.insert(
                        key.path(),
                        (
                            key,
                            StoredTile {
                                pixels,
                                ..StoredTile::default()
                            },
                        ),
                    );
                }
            }
            pyramid::Step::LevelDone { level } => levels.push(level),
            pyramid::Step::Done => break,
        }
    }
    assert_eq!(levels, vec![1, 2]);
    assert_eq!(store.index("world-framed", 1).len(), 4);
    assert_eq!(store.index("world-framed", 2).len(), 1);
}

/// Chrome pixels of the framed canvas: the reference frame outside the pane, all opaque and so all covered.
fn chrome_pixels(pane: &Rect, width: usize, height: usize) -> u64 {
    (width * height) as u64 - (pane.width * pane.height) as u64
}
