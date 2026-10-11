//! Failure cases for the scan session, written before it: each test names the way the pass could go wrong.

use super::*;

const W: usize = 320;
const H: usize = 240;
const FACTOR: usize = 2;
const HEADER: usize = 40;

/// Page texture: 8-pixel blocks of hashed grey, so corners exist everywhere and no shift aliases another.
fn page(x: usize, y: usize) -> u8 {
    let (bx, by) = ((x / 8) as u32, (y / 8) as u32);
    let mut h = bx.wrapping_mul(0x9e37_79b9) ^ by.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    (h >> 24) as u8
}

/// A frame of the page scrolled down by `scroll` native pixels under a fixed striped header.
fn frame(scroll: usize) -> Vec<u8> {
    let mut out = vec![0u8; W * H * 4];
    for y in 0..H {
        for x in 0..W {
            let v = if y < HEADER {
                if (x / 16 + y / 10) % 2 == 0 {
                    30
                } else {
                    220
                }
            } else {
                page(x, y + scroll)
            };
            out[(y * W + x) * 4..(y * W + x) * 4 + 4].copy_from_slice(&[v, v / 2, 255 - v, 255]);
        }
    }
    out
}

fn blank(value: u8) -> Vec<u8> {
    vec![value; W * H * 4]
}

fn meta(index: u32) -> FrameMeta {
    FrameMeta {
        index,
        time: index as f64 / 30.0,
        duration: 1.0 / 30.0,
    }
}

fn push(session: &mut ScanSession, index: u32, rgba: &[u8]) -> ScanStep {
    session.frame_buffer().copy_from_slice(rgba);
    session.push(meta(index), None).unwrap()
}

fn codes(step: &ScanStep) -> Vec<&'static str> {
    step.diagnostics.iter().map(|d| d.code).collect()
}

#[test]
fn the_first_frame_is_a_still_field_with_its_features_row() {
    let mut s = ScanSession::new(W, H, FACTOR);
    let step = push(&mut s, 0, &frame(0));
    assert!(step.first && !step.record.duplicate);
    assert_eq!(step.record.layout, FieldLayout::Initial);
    let f = &step.record.field;
    let features = step.features.as_ref().expect("a features row");
    let n = features.score.len();
    assert!(n >= 8, "the test page is textured ({n} features)");
    assert_eq!(
        (features.xy.len(), features.descriptors.len()),
        (2 * n, 8 * n)
    );
    assert_eq!(f.motions, vec![still(n)]);
    assert_eq!(
        (f.cols, f.rows, f.cell),
        (7, 5, 24),
        "160×120 analysis pixels in 24-pixel cells"
    );
    assert!(f.confidence.iter().all(|&c| c == 255));
    assert!(f.labels.iter().chain(&f.dynamic).all(|&c| c == 0));
    assert_eq!(
        (f.feature_count, f.difference, f.zoom, f.unknown),
        (n as u32, 0.0, 1.0, false)
    );
    assert!(step.diagnostics.is_empty());
}

#[test]
fn duplicates_are_exact_rgba_equality() {
    let mut s = ScanSession::new(W, H, FACTOR);
    let a = frame(0);
    s.frame_buffer().copy_from_slice(&a);
    assert!(!s.is_duplicate(), "the first frame repeats nothing");
    s.push(meta(0), None).unwrap();
    let mut b = a.clone();
    *b.last_mut().unwrap() ^= 1; // alpha of the last pixel only
    s.frame_buffer().copy_from_slice(&b);
    assert!(
        !s.is_duplicate(),
        "a one-byte alpha change is a new observation"
    );
    s.push(meta(1), None).unwrap();
    s.frame_buffer().copy_from_slice(&b);
    assert!(s.is_duplicate());
    let mut c = b.clone();
    c[0] ^= 1;
    // Rewriting the staged frame before push re-decides.
    s.frame_buffer().copy_from_slice(&c);
    assert!(s.is_duplicate(), "the answer is cached until push…");
    let step = s.push(meta(2), None).unwrap();
    assert!(step.record.duplicate, "…and push uses the same answer");
}

#[test]
fn a_duplicate_keeps_the_previous_layout_confidence_and_feature_count() {
    let mut s = ScanSession::new(W, H, FACTOR);
    let first = push(&mut s, 0, &frame(0));
    let dup = push(&mut s, 1, &frame(0));
    assert!(dup.record.duplicate && dup.features.is_none() && !dup.first);
    assert_eq!(
        dup.record.layout,
        FieldLayout::Initial,
        "inherits the first frame's layout"
    );
    let moved = push(&mut s, 2, &frame(12));
    assert_eq!(moved.record.layout, FieldLayout::Estimated);
    assert!(moved.features.is_some());
    let again = push(&mut s, 3, &frame(12));
    let (m, d) = (&moved.record.field, &again.record.field);
    assert!(again.record.duplicate);
    assert_eq!(again.record.layout, FieldLayout::Estimated);
    assert_eq!(d.confidence, m.confidence);
    assert_eq!(d.feature_count, m.feature_count);
    assert_eq!((d.cols, d.rows, d.cell), (m.cols, m.rows, m.cell));
    assert!(d.labels.iter().chain(&d.dynamic).all(|&c| c == 0));
    assert_eq!(d.labels.len(), m.labels.len());
    let features = first.features.unwrap().score.len();
    assert_eq!(
        d.motions,
        vec![still(features)],
        "support counts the reused features"
    );
    assert_eq!((d.difference, d.zoom, d.unknown), (0.0, 1.0, false));
}

#[test]
fn a_scroll_is_measured_in_analysis_pixels() {
    let mut s = ScanSession::new(W, H, FACTOR);
    push(&mut s, 0, &frame(0));
    let step = push(&mut s, 1, &frame(12));
    let best = step
        .record
        .field
        .motions
        .iter()
        .max_by_key(|m| m.support)
        .unwrap();
    assert_eq!(
        (best.x.round(), best.y.round()),
        (0.0, 6.0),
        "{:?}",
        step.record.field.motions
    );
    assert!(informative_field(&step.record.field));
    assert_eq!(s.learner().accumulators().informative_frames, 1);
}

#[test]
fn low_texture_is_reported_on_frame_zero_only() {
    let mut s = ScanSession::new(W, H, FACTOR);
    assert_eq!(
        codes(&push(&mut s, 0, &blank(200))),
        vec!["LOW_TEXTURE_UNOBSERVABLE"]
    );
    assert!(codes(&push(&mut s, 1, &blank(201))).is_empty());
}

#[test]
fn undersampling_starts_above_120_ms() {
    let mut s = ScanSession::new(W, H, FACTOR);
    s.frame_buffer().copy_from_slice(&frame(0));
    let at = |duration| FrameMeta {
        index: 0,
        time: 0.0,
        duration,
    };
    assert!(s.push(at(0.12), None).unwrap().diagnostics.is_empty());
    s.frame_buffer().copy_from_slice(&frame(3));
    let step = s
        .push(
            FrameMeta {
                index: 1,
                ..at(0.13)
            },
            None,
        )
        .unwrap();
    let d = step.diagnostics.last().unwrap();
    assert_eq!(
        (d.code, d.severity, d.frame, d.time),
        ("TEMPORAL_UNDERSAMPLING", Severity::Info, Some(1), Some(0.0))
    );
}

#[test]
fn slow_scrolling_is_learned_against_the_long_baseline() {
    let mut s = ScanSession::new(W, H, FACTOR);
    // One native pixel per frame is half an analysis pixel: no single step is evidence.
    for i in 0..12u32 {
        let step = push(&mut s, i, &frame(i as usize));
        assert!(
            !informative_field(&step.record.field),
            "frame {i} alone is not evidence"
        );
        if i < LONG_BASELINE_MIN_GAP {
            assert_eq!(
                s.learner().accumulators().informative_frames,
                0,
                "frame {i}: no retry before the gap"
            );
        }
    }
    let learned = s.learner().accumulators().informative_frames;
    assert!(
        learned >= 2,
        "the long baseline found {learned} informative pairs"
    );
    assert_eq!(
        s.baseline.as_ref().unwrap().index,
        8,
        "the baseline moves with each successful retry (frames 4 and 8)"
    );
}

#[test]
fn a_baseline_with_no_evidence_is_replaced_after_24_frames() {
    let mut s = ScanSession::new(W, H, FACTOR);
    let still_page = frame(0);
    for i in 0..=26u32 {
        // One pixel flickers: never a duplicate, never motion.
        let mut f = still_page.clone();
        f[(100 * W + 100) * 4] = (i * 7) as u8;
        push(&mut s, i, &f);
        let expected = if i <= LONG_BASELINE_MAX_GAP { 0 } else { 25 };
        assert_eq!(
            s.baseline.as_ref().unwrap().index,
            expected,
            "after frame {i}"
        );
    }
    assert_eq!(s.learner().accumulators().informative_frames, 0);
}

#[test]
fn a_host_gray_is_used_and_checked() {
    let (aw, ah) = ScanSession::new(W, H, FACTOR).analysis_size();
    let mut gray = vec![0u8; aw * ah];
    downscale_gray(&frame(0), W, H, FACTOR, &mut gray);
    let mut own = ScanSession::new(W, H, FACTOR);
    let mut hosted = ScanSession::new(W, H, FACTOR);
    hosted.frame_buffer().copy_from_slice(&frame(0));
    assert_eq!(
        hosted.push(meta(0), Some(&gray[1..])),
        Err(ScanError::GrayGeometry {
            expected: aw * ah,
            actual: aw * ah - 1
        })
    );
    assert_eq!(
        hosted.push(meta(0), Some(&gray)).unwrap(),
        push(&mut own, 0, &frame(0))
    );
    // A gray that differs from the frame is believed, not recomputed.
    let mut other = ScanSession::new(W, H, FACTOR);
    other.frame_buffer().copy_from_slice(&frame(0));
    let flat = other.push(meta(0), Some(&vec![128u8; aw * ah])).unwrap();
    assert_eq!(flat.features.unwrap().score.len(), 0);
}

#[test]
fn push_needs_a_written_frame_and_frames_live_in_three_buffers() {
    let mut s = ScanSession::new(W, H, FACTOR);
    assert_eq!(s.push(meta(0), None), Err(ScanError::NoFrame));
    for i in 0..30u32 {
        push(&mut s, i, &frame((i as usize * 5) % 40));
    }
    assert!(s.slots.len() <= 3, "{} frame buffers", s.slots.len());
}

#[test]
fn informative_field_compares_squared_length_at_the_norm_one_boundary() {
    let field = |x: f64, y: f64| MotionField {
        motions: vec![Motion {
            x,
            y,
            support: 10,
            unique: 6,
            confidence: 0.5,
            error: 0.0,
            ambiguous: false,
        }],
        labels: vec![0],
        confidence: vec![0],
        dynamic: vec![0],
        cols: 1,
        rows: 1,
        cell: 1,
        difference: 1.0,
        feature_count: 0,
        unknown: false,
        zoom: 1.0,
    };
    assert!(
        !informative_field(&field(0.6, 0.8)),
        "norm exactly 1 is not informative"
    );
    assert!(informative_field(&field(0.6 + f64::EPSILON * 4.0, 0.8)));
    assert!(informative_field(&field(3.0, 4.0)));
    assert!(!informative_field(&field(0.0, 0.0)));
    assert!(!informative_field(&MotionField {
        unknown: true,
        ..field(3.0, 4.0)
    }));
    assert!(!informative_field(&MotionField {
        difference: 0.19,
        ..field(3.0, 4.0)
    }));
}

#[test]
fn compact_features_keep_order_and_precision() {
    let f = |x, y, score: f64, w| Feature {
        x,
        y,
        score,
        descriptor: [w; 8],
    };
    let c = CompactFeatures::encode(&[f(3, -4, 0.1, 7), f(40000, 2, 2.5, 9)]);
    assert_eq!(
        c.xy,
        vec![3, -4, 40000i32 as i16, 2],
        "x/y wrap to i16 like an Int16Array"
    );
    assert_eq!(c.score, vec![0.1f32, 2.5]);
    assert_eq!(c.descriptors, [[7u32; 8], [9u32; 8]].concat());
}

/// End to end through the public API only: a page scrolling under a fixed header, then region finalisation.
#[test]
fn a_scrolling_page_under_a_fixed_header_becomes_two_regions() {
    let mut s = ScanSession::new(W, H, FACTOR);
    let mut rows = 0;
    for i in 0..16u32 {
        let step = push(&mut s, i, &frame(i as usize * 8));
        rows += 1 + step.features.is_some() as usize;
        assert!(step.diagnostics.is_empty(), "frame {i}: {:?}", codes(&step));
    }
    assert_eq!(rows, 32);
    let done = s.finish(&[]);
    let kinds: Vec<Kind> = done.regions.iter().map(|r| r.kind).collect();
    assert!(
        kinds.contains(&Kind::Fixed) && kinds.contains(&Kind::Moving),
        "{kinds:?}"
    );
    let fixed = done.regions.iter().find(|r| r.kind == Kind::Fixed).unwrap();
    assert_eq!((fixed.rect.y, fixed.rect.height), (0.0, HEADER as f64));
    let mask = &done.diagnostics[0];
    assert_eq!(mask.code, "AUTOMATIC_LAYER_MASK");
    let count = |k| done.regions.iter().filter(|r| r.kind == k).count() as f64;
    assert_eq!(
        mask.params,
        vec![
            ("moving", count(Kind::Moving)),
            ("fixed", count(Kind::Fixed))
        ]
    );
    let (labels, _) = crate::engine::layers::label_atlas(&done.regions, W, H).unwrap();
    assert!(
        labels.iter().all(|&l| l != 0),
        "every native pixel has an owner"
    );
}

#[test]
fn finishing_without_frames_builds_no_regions() {
    let none = ScanSession::new(W, H, FACTOR).finish(&[]);
    assert!(none.regions.is_empty());
    let mask = &none.diagnostics[0];
    assert_eq!(
        (mask.code, mask.params.clone()),
        (
            "AUTOMATIC_LAYER_MASK",
            vec![("moving", 0.0), ("fixed", 0.0)]
        )
    );
    let manual = [ManualRegion {
        name: "body".into(),
        kind: Kind::Ignore,
        rect: crate::kernels::geometry::Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
    }];
    let codes: Vec<_> = ScanSession::new(W, H, FACTOR)
        .finish(&manual)
        .diagnostics
        .iter()
        .map(|d| d.code)
        .collect();
    assert_eq!(codes, vec!["MANUAL_REGION_PRIORITY"]);
}

#[test]
fn manual_layouts_report_their_shape() {
    let mut s = ScanSession::new(W, H, FACTOR);
    push(&mut s, 0, &frame(0));
    let rect = |x, width| crate::kernels::geometry::Rect {
        x,
        y: 0.0,
        width,
        height: H as f64,
    };
    let manual = [
        ManualRegion {
            name: "a".into(),
            kind: Kind::Moving,
            rect: rect(0.0, 100.0),
        },
        ManualRegion {
            name: "b".into(),
            kind: Kind::Ignore,
            rect: rect(100.0, 100.0),
        },
        ManualRegion {
            name: "c".into(),
            kind: Kind::Moving,
            rect: rect(200.0, 100.0),
        },
    ];
    let done = s.finish(&manual);
    assert_eq!(done.regions.len(), 4, "20 native columns are uncovered");
    let codes: Vec<_> = done.diagnostics.iter().map(|d| d.code).collect();
    assert_eq!(
        codes,
        vec![
            "MANUAL_UNASSIGNED",
            "EXPLICITLY_EXCLUDED_REGION",
            "MANUAL_REGION_PRIORITY",
            "MULTIPLE_SCROLL_LAYERS"
        ]
    );
}
