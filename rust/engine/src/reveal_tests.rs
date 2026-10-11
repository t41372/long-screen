// Failure cases, listed before the session was driven: a call out of turn accepted (memory without a request,
// observations before they were asked for, a frame outside a decode, a push while block copies are owed, a step after
// the end); a step after `NeedTile` that does not notice the tile never came; a refused memory check that still
// touches tiles or reports the wrong stage, size or field order; a stage with nothing to reveal that asks for memory;
// a decision kept on a canvas or layer the stage does not cover, a blind decision kept without a skip placement, a pose
// rounded the Rust way instead of the page's; the compositor's tiles taken in another order than row by row, or
// without a checkpoint after each; a block write that loses the coverage, provisional, owner, conflict or quality
// rules.
use super::*;
use crate::tiles::StoredTile;

const SIZE: usize = 32;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn layer(id: &str, r: Rect) -> RevealLayer {
    RevealLayer {
        id: id.into(),
        rect: r,
        code: 0,
    }
}

fn canvas(id: &str, r: Rect) -> RevealCanvas {
    RevealCanvas {
        id: id.into(),
        bounds: r,
    }
}

fn decision(canvas: &str, layer: &str, x: f64, y: f64) -> ObservedDecision {
    ObservedDecision {
        canvas: canvas.into(),
        layer: layer.into(),
        x,
        y,
        skip: false,
        skipped: false,
        occlusions: Vec::new(),
    }
}

/// A 64 × 48 recording of one moving layer over the whole frame, one canvas of 64 × 96.
fn session(frames: u32) -> RevealSession {
    RevealSession::new(
        64,
        48,
        10.0,
        SIZE,
        frames,
        vec![layer("page", rect(0.0, 0.0, 64.0, 48.0))],
        vec![canvas("world", rect(0.0, 0.0, 64.0, 96.0))],
    )
    .unwrap()
}

/// Answers memory, observations and tiles (empty ones) until `until` matches; returns the steps on the way.
fn drive(
    s: &mut RevealSession,
    cache: &mut TileCache,
    rows: &[(u32, Vec<ObservedDecision>)],
    until: impl Fn(&Step) -> bool,
) -> Vec<Step> {
    let mut seen = Vec::new();
    loop {
        let step = s.step(cache, 1.0).unwrap();
        match &step {
            Step::NeedMemory { .. } => s.memory(true, 0.0).unwrap(),
            Step::NeedObservations => {
                for (frame, ds) in rows {
                    s.observation(*frame, ds).unwrap();
                }
            }
            Step::NeedTile(key) => {
                while let Some(id) = cache.victim() {
                    cache.evict(id);
                }
                cache.insert(key.clone(), None).unwrap();
            }
            _ => {}
        }
        let done = until(&step);
        seen.push(step);
        if done {
            return seen;
        }
    }
}

#[test]
fn calls_out_of_turn_are_refused() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(4);
    assert_eq!(s.memory(true, 0.0), Err(RevealError::Unexpected));
    assert_eq!(
        s.observation(0, &[decision("world", "page", 0.0, 0.0)]),
        Err(RevealError::Unexpected)
    );
    assert_eq!(s.push_frame(0, None), Err(RevealError::Unexpected));
    assert_eq!(s.end_pass(None), Err(RevealError::Unexpected));
    assert!(s.frame_buffer().is_err());
    assert!(matches!(
        s.step(&mut cache, 0.0),
        Ok(Step::NeedMemory { .. })
    ));
    // Stepping again without answering.
    assert_eq!(s.step(&mut cache, 0.0), Err(RevealError::Unexpected));
    s.memory(true, 0.0).unwrap();
    assert_eq!(s.memory(true, 0.0), Err(RevealError::Unexpected));
    assert_eq!(s.step(&mut cache, 0.0), Ok(Step::NeedObservations));
    s.observation(0, &[decision("world", "page", 0.0, 0.0)])
        .unwrap();
    // Ingest asks for the first tile; a frame or another observation now is out of turn.
    assert!(matches!(s.step(&mut cache, 0.0), Ok(Step::NeedTile(_))));
    assert_eq!(s.push_frame(0, None), Err(RevealError::Unexpected));
    assert_eq!(
        s.observation(1, &[decision("world", "page", 0.0, 0.0)]),
        Err(RevealError::Unexpected)
    );
}

#[test]
fn a_frame_cannot_be_pushed_while_block_copies_are_owed() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(3);
    drive(&mut s, &mut cache, &[], |st| {
        matches!(st, Step::Decode { .. })
    });
    s.copies = Some(Copies {
        source: 0,
        groups: vec![(TileKey::new("world", 0, 0, 0), Vec::new())],
        at: 0,
    });
    assert_eq!(s.push_frame(0, None), Err(RevealError::Unexpected));
    assert_eq!(s.end_pass(None), Err(RevealError::Unexpected));
    assert!(s.frame_buffer().is_err());
}

#[test]
fn a_tile_asked_for_and_not_inserted_is_an_error() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(4);
    drive(&mut s, &mut cache, &[], |st| {
        matches!(st, Step::NeedObservations)
    });
    let Ok(Step::NeedTile(key)) = s.step(&mut cache, 0.0) else {
        panic!("expected a tile request");
    };
    assert_eq!(key, TileKey::new("world", 0, 0, 0));
    assert_eq!(s.step(&mut cache, 0.0), Err(RevealError::NotProvided));
}

#[test]
fn nothing_to_reveal_asks_for_nothing() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    for (layers, canvases) in [
        (vec![], vec![canvas("world", rect(0.0, 0.0, 64.0, 96.0))]),
        (vec![layer("page", rect(0.0, 0.0, 64.0, 48.0))], vec![]),
    ] {
        let mut s = RevealSession::new(64, 48, 10.0, SIZE, 4, layers, canvases).unwrap();
        assert_eq!(s.step(&mut cache, 0.0), Ok(Step::Done(Outcome::Nothing)));
        assert_eq!(s.step(&mut cache, 0.0), Err(RevealError::Unexpected));
    }
}

#[test]
fn a_refused_memory_check_skips_the_stage_with_its_figures() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(4);
    let Ok(Step::NeedMemory { bytes, stage }) = s.step(&mut cache, 0.0) else {
        panic!("expected a memory check");
    };
    assert_eq!(stage, MemoryStage::Canvases);
    let expected = (canvas_bytes(64, 96) + layer_bytes(64, 48) + 3 * 64 * 48 * 4) as f64;
    assert_eq!(bytes, expected);
    s.memory(false, 300.0 * 1048576.0 + 524288.0).unwrap();
    let Ok(Step::Done(Outcome::Skipped(d))) = s.step(&mut cache, 0.0) else {
        panic!("expected the stage to be skipped");
    };
    let mb = js_round(expected / 1048576.0) as f64;
    assert_eq!(d.code, "REVEAL_SKIPPED");
    assert_eq!(d.severity, Severity::Warning);
    assert_eq!(d.params, vec![("need", mb)]);
    assert_eq!(
        d.detail,
        Some(Value::Object(vec![
            ("stage", Value::Text("canvases".into())),
            ("needMB", Value::Number(mb)),
            // Rounded half up, as the page's Math.round.
            ("coreMB", Value::Number(301.0)),
        ]))
    );
    assert!(cache.is_empty(), "no tile was touched");
    assert_eq!(s.step(&mut cache, 0.0), Err(RevealError::Unexpected));
}

#[test]
fn a_refused_fallback_check_names_its_stage() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(2);
    let rows = vec![
        (0, vec![decision("world", "page", 0.0, 0.0)]),
        (1, vec![decision("world", "page", 0.0, 16.0)]),
    ];
    let mut stage = None;
    let mut passes = Vec::new();
    loop {
        match s.step(&mut cache, 0.0).unwrap() {
            Step::NeedMemory { stage: st, .. } => {
                stage = Some(st);
                s.memory(st == MemoryStage::Canvases, 0.0).unwrap();
            }
            Step::NeedObservations => {
                for (frame, ds) in &rows {
                    s.observation(*frame, ds).unwrap();
                }
            }
            Step::NeedTile(key) => {
                cache.insert(key, None).unwrap();
            }
            Step::Decode { pass, wanted } => {
                passes.push(pass);
                for (i, w) in wanted.iter().enumerate() {
                    if *w {
                        s.frame_buffer().unwrap().fill(90);
                    }
                    s.push_frame(i as u32, None).unwrap();
                    assert_eq!(s.step(&mut cache, 0.0), Ok(Step::NextFrame));
                }
                s.end_pass(None).unwrap();
            }
            Step::Done(Outcome::Skipped(d)) => {
                assert_eq!(stage, Some(MemoryStage::Fallback));
                let Some(Value::Object(fields)) = d.detail else {
                    panic!("no detail");
                };
                assert_eq!(fields[0], ("stage", Value::Text("fallback".into())));
                break;
            }
            Step::Done(other) => panic!("unexpected end {other:?}"),
            _ => {}
        }
    }
    assert_eq!(passes, vec![Pass::Learn, Pass::Agree, Pass::Relearn]);
}

#[test]
fn bad_layers_and_label_planes_are_refused() {
    for l in [
        layer("thin", rect(0.2, 0.0, 0.5, 48.0)),
        RevealLayer {
            code: 256,
            ..layer("page", rect(0.0, 0.0, 64.0, 48.0))
        },
    ] {
        assert!(matches!(
            RevealSession::new(64, 48, 10.0, SIZE, 4, vec![l], vec![]),
            Err(RevealError::BadLayer)
        ));
    }
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(2);
    drive(&mut s, &mut cache, &[], |st| {
        matches!(st, Step::Decode { .. })
    });
    assert_eq!(s.push_frame(0, Some(&[0; 10])), Err(RevealError::BadLabels));
    assert_eq!(s.end_pass(Some(&[0; 10])), Err(RevealError::BadLabels));
}

#[test]
fn observations_keep_only_the_decisions_the_stage_covers() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(6);
    let blind = |x: f64, y: f64, skip: bool| ObservedDecision {
        skipped: true,
        skip,
        ..decision("world", "page", x, y)
    };
    let rows = vec![
        // Tracked at (0, 0) only: a still layer, so a blind frame at its pose counts when its placement is a skip.
        (0, vec![decision("world", "page", 0.0, 0.0)]),
        (1, vec![blind(0.0, 0.0, false)]),
        (2, vec![blind(0.0, 0.0, true)]),
        // Another canvas and another layer are not the stage's.
        (3, vec![decision("other", "page", 0.0, 0.0)]),
        (4, vec![decision("world", "sidebar", 0.0, 0.0)]),
        // −0.5 rounds to 0 on the page (Math.round), not to −1: the same pose as frame 0.
        (5, vec![decision("world", "page", -0.5, 0.4)]),
        // Past the frames the run decoded.
        (6, vec![decision("world", "page", 0.0, 0.0)]),
    ];
    drive(&mut s, &mut cache, &rows, |st| {
        matches!(st, Step::Decode { .. })
    });
    let poses: Vec<Vec<(i64, i64)>> = s
        .plans
        .iter()
        .map(|p| p.iter().map(|d| (d.x, d.y)).collect())
        .collect();
    assert_eq!(
        poses,
        vec![
            vec![(0, 0)],
            vec![],
            vec![(0, 0)],
            vec![],
            vec![],
            vec![(0, 0)]
        ]
    );
}

#[test]
fn a_blind_frame_of_a_layer_that_moved_does_not_vote() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    let mut s = session(3);
    let rows = vec![
        (0, vec![decision("world", "page", 0.0, 0.0)]),
        (1, vec![decision("world", "page", 0.0, 16.0)]),
        (
            2,
            vec![ObservedDecision {
                skipped: true,
                skip: true,
                ..decision("world", "page", 0.0, 16.0)
            }],
        ),
    ];
    let steps = drive(&mut s, &mut cache, &rows, |st| {
        matches!(st, Step::Decode { .. })
    });
    // The learn pass reads the frames that show the layer at a new pose: frames 0 and 1, not the blind frame 2.
    assert_eq!(
        steps.last(),
        Some(&Step::Decode {
            pass: Pass::Learn,
            wanted: vec![true, true, false]
        })
    );
}

#[test]
fn compositor_tiles_go_in_row_by_row_with_a_checkpoint_after_each() {
    let mut cache = TileCache::new(SIZE, 128.0).unwrap();
    // Canvases at negative and fractional origins, and one without width.
    let mut s = RevealSession::new(
        64,
        48,
        10.0,
        SIZE,
        2,
        vec![layer("page", rect(0.0, 0.0, 64.0, 48.0))],
        vec![
            canvas("a", rect(-40.0, -1.5, 70.0, 40.0)),
            canvas("empty", rect(0.0, 0.0, 0.0, 100.0)),
            canvas("b", rect(10.0, 31.0, 20.0, 2.0)),
        ],
    )
    .unwrap();
    let steps = drive(&mut s, &mut cache, &[], |st| {
        matches!(st, Step::Decode { .. })
    });
    let mut order = Vec::new();
    for pair in steps.windows(2) {
        if let Step::NeedTile(k) = &pair[0] {
            assert_eq!(pair[1], Step::Checkpoint, "a checkpoint follows each tile");
            order.push((k.canvas.clone(), k.x, k.y));
        }
    }
    let a = |x, y| ("a".to_string(), x, y);
    let b = |x, y| ("b".to_string(), x, y);
    assert_eq!(
        order,
        vec![
            a(-2, -1),
            a(-1, -1),
            a(0, -1),
            a(-2, 0),
            a(-1, 0),
            a(0, 0),
            a(-2, 1),
            a(-1, 1),
            a(0, 1),
            b(0, 0),
            b(0, 1)
        ]
    );
}

fn tile(size: usize) -> Tile {
    let mut cache = TileCache::new(size, 128.0).unwrap();
    let id = cache
        .insert(
            TileKey::new("t", 0, 0, 0),
            Some(StoredTile {
                pixels: vec![7; size * size * 4],
                provisional: Some(vec![0xff; size * size / 8]),
                quality: Some(vec![250, 10, 10, 10]),
                conflicts: Some(vec![3; 4]),
                owner: Some(vec![9; 4]),
                ..StoredTile::default()
            }),
        )
        .unwrap();
    cache.get(id).unwrap().clone()
}

#[test]
fn a_whole_block_copy_settles_its_block() {
    let mut t = tile(32);
    let src: Vec<u8> = (0..64).map(|i| i as u8).collect();
    // Block (1, 1) of the tile: (16, 16).
    write_block(&mut t, 32, (16, 16), 41, Kind::Coherent, |_| &src, false);
    for r in 0..16 {
        let p = (16 + r) * 32 + 16;
        assert_eq!(&t.pixels[p * 4..p * 4 + 64], &src[..]);
        assert_eq!(t.coverage[p >> 3], 0xff);
        assert_eq!(t.coverage[(p >> 3) + 1], 0xff);
        assert_eq!(t.provisional[p >> 3], 0);
        // The row's left half belongs to the block beside it.
        assert_eq!(t.provisional[(p >> 3) - 1], 0xff);
    }
    assert_eq!(t.owner, vec![9, 9, 9, 42]);
    assert_eq!(t.conflicts, vec![3, 3, 3, 0]);
    assert_eq!(t.quality[3], REVEALED_QUALITY);
    // A provisional view copied whole is owned by its frame but settles nothing.
    let mut t = tile(32);
    write_block(&mut t, 32, (0, 0), 5, Kind::Provisional, |_| &src, false);
    assert_eq!(t.owner[0], 6);
    assert_eq!((t.conflicts[0], t.quality[0]), (3, 250));
    assert_eq!(t.provisional[0], 0xff);
}

#[test]
fn a_masked_block_writes_only_its_opaque_pixels() {
    let mut t = tile(32);
    let mut src = vec![0u8; 64];
    for x in 0..16 {
        let alpha = if x % 2 == 0 { 255 } else { 0 };
        src[x * 4..x * 4 + 4].copy_from_slice(&[200, 100, 50, alpha]);
    }
    write_block(&mut t, 32, (16, 0), 12, Kind::Fallback, |_| &src, true);
    let p = 16;
    assert_eq!(&t.pixels[p * 4..p * 4 + 4], &[200, 100, 50, 255]);
    assert_eq!(&t.pixels[(p + 1) * 4..(p + 1) * 4 + 4], &[7, 7, 7, 7]);
    assert_eq!(t.coverage[p >> 3], 0b0101_0101);
    // Per-pixel fallback values keep the compositor's owner and settle nothing.
    assert_eq!(t.owner[1], 9);
    assert_eq!(t.provisional[p >> 3], 0xff);
    let mut t = tile(32);
    write_block(&mut t, 32, (16, 0), 12, Kind::Edge, |_| &src, true);
    assert_eq!(t.provisional[16 >> 3], 0b1010_1010);
    assert_eq!(
        (t.owner[1], t.conflicts[1], t.quality[1]),
        (13, 0, REVEALED_QUALITY)
    );
}

#[test]
fn negative_blocks_find_their_tile_and_place() {
    assert_eq!(block_tile(-1, -3, 32), (-1, -2, 16, 16));
    assert_eq!(block_tile(2, 0, 32), (1, 0, 0, 0));
    assert_eq!(pixel_span(-1.5, 3.0), (-1, 3));
    assert_eq!(pixel_span(2.0, -1.0), (2, 0));
}
