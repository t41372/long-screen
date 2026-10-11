//! Cheap Rust-side unit tests for the parts of the region-construction port that don't need Wasm (see
//! tests/unit/parity/regions.test.ts for the real, Wasm-backed oracle comparison).

use super::bands::strongest_cut;
use super::cells::{group_and_label, DisjointSet};
use super::crops::native_edge;
use super::*;

#[test]
fn disjoint_set_unions_by_size_and_compresses_paths() {
    let mut ds = DisjointSet::new(5);
    ds.join(0, 1);
    ds.join(1, 2);
    ds.join(3, 4);
    assert_eq!(ds.find(0), ds.find(2));
    assert_ne!(ds.find(0), ds.find(3));
    ds.join(2, 3);
    assert_eq!(ds.find(0), ds.find(4));
}

#[test]
fn strongest_cut_picks_first_maximum_above_threshold() {
    // 8 bins; informativeFrames = 10; bin 3 clears 12% (>1.2) and is the unique max.
    let g = [0.0, 0.0, 0.5, 1.3, 1.3, 0.0, 0.0, 0.0];
    // Ties keep the FIRST index (strict `>` in the scan), so two equal maxima both at 1.3 resolve to index 3.
    assert_eq!(strongest_cut(&g, 10.0), 3);
    // Below the 4-frame floor, no cut is ever accepted.
    assert_eq!(strongest_cut(&g, 3.0), 0);
}

#[test]
fn group_and_label_keeps_map_insertion_order_and_grows_groups_during_the_fill_scan() {
    // 6 cells, 2 columns: a 4-cell union (0,1,2,3) and two singletons (4,5) below the `minimum` floor
    // (max(3, floor(6*.025)) = 3), so 4 and 5 must be assigned to the nearest large group by Manhattan
    // distance, and (per the TS) that assignment can feed later distance comparisons within the same scan.
    let cols = 2;
    let n = 6;
    let mut ds = DisjointSet::new(n);
    ds.join(0, 1);
    ds.join(1, 2);
    ds.join(2, 3);
    let (large, labels) = group_and_label(&mut ds, n as i64, cols);
    assert_eq!(
        large.len(),
        1,
        "cells 4 and 5 fall below the minimum and must fold into the sole large group"
    );
    assert_eq!(labels, [0, 0, 0, 0, 0, 0]);
    assert_eq!(large[0].len(), 6);
}

#[test]
fn native_edge_falls_back_to_the_scaled_estimate_without_native_stats() {
    assert_eq!(native_edge(None, 10, 2.0, 1, 100, 0.9, 0.0), 20);
    assert_eq!(native_edge(None, 10, 2.0, -1, 100, 0.9, 5.0), 20);
}

#[test]
fn label_atlas_first_region_wins_on_overlap_and_counts_match_the_labels() {
    use super::atlas::AtlasRegion;
    let a = AtlasRegion {
        rect: Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        exclusions: vec![],
        crop: None,
        solid: true,
        mask: None,
    };
    let b = AtlasRegion {
        rect: Rect {
            x: 5.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        exclusions: vec![],
        crop: None,
        solid: true,
        mask: None,
    };
    let mut out = vec![0u8; 15 * 10];
    let counts = label_atlas(&[a, b], 15, 10, &mut out).unwrap();
    // The overlap (x in [5,10)) belongs to the FIRST region (a), matching `regionContains` first-wins order.
    assert_eq!(out[5], 1);
    assert_eq!(out[12], 2);
    assert_eq!(out[0], 1);
    assert_eq!(counts.len(), 3);
    assert_eq!(counts[1] as usize, out.iter().filter(|&&c| c == 1).count());
    assert_eq!(counts[2] as usize, out.iter().filter(|&&c| c == 2).count());
}

/// Blank/no-evidence run (zero informative frames, no reference frame): every threshold check that requires
/// `informativeFrames >= 2` is skipped, so top/bottom/left/right stay full-frame, evidence/split are both
/// zero (accepted as "not enough evidence to split", per `e < max(2, informativeFrames*.04)`), and the whole
/// grid unions into one region. `finalize`'s single-full-pane rule then makes it solid and fills `content`
/// exactly — the same fallback `LayerLearner.finish()` produces for a learner that never saw an informative
/// frame.
#[test]
fn finish_falls_back_to_one_solid_pane_with_no_evidence() {
    let width = 4usize;
    let height = 4usize;
    let cell = 24usize; // cols = rows = 1
    let zeros = vec![0.0; 4];
    let input = FinishInput {
        width,
        height,
        cell,
        informative_frames: 0.0,
        native_frames: 0.0,
        row_change: &zeros,
        col_change: &zeros,
        col_moving: &zeros,
        col_mean: &zeros,
        col_gain: &zeros,
        horizontal_gain: &zeros,
        split: &[0.0, 0.0],
        evidence: &[0.0, 0.0],
        activity: &[0.0],
        observations: &[0.0],
        native_row_change: None,
        native_col_change: None,
        reference: None,
    };
    let regions = finish(&input, 96.0, 96.0, 24);
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].kind, Kind::Moving);
    assert!(regions[0].solid);
    assert_eq!(
        regions[0].rect,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 96.0,
            height: 96.0
        }
    );
}

/// Runs analysis frames through the learner (one model moving 4 px down, every cell confident), then `finish()` at
/// factor 1 without a native reference, so the left/right band test reads the column statistics alone.
fn learn(width: usize, height: usize, frames: &[Vec<u8>]) -> Vec<RegionOut> {
    use crate::kernels::layers::{Field, FieldMotion, Learner};
    let mut learner = Learner::new(width, height);
    let motions = [FieldMotion {
        x: 0.0,
        y: 4.0,
        support: 100,
        confidence: 1.0,
    }];
    let cells = learner.cols * learner.rows;
    let (labels, confidence, dynamic) = (vec![0u8; cells], vec![255u8; cells], vec![0u8; cells]);
    let field = Field {
        motions: &motions,
        labels: &labels,
        confidence: &confidence,
        dynamic: &dynamic,
        cols: learner.cols,
        rows: learner.rows,
        difference: 1.0,
        unknown: false,
    };
    for pair in frames.windows(2) {
        assert!(learner.add(&field, &pair[0], &pair[1], None));
    }
    let input = FinishInput {
        width,
        height,
        cell: learner.cell,
        informative_frames: learner.informative_frames as f64,
        native_frames: 0.0,
        row_change: &learner.row_change,
        col_change: &learner.col_change,
        col_moving: &learner.col_moving,
        col_mean: &learner.col_mean,
        col_gain: &learner.col_gain,
        horizontal_gain: &learner.horizontal_gain,
        split: &learner.split,
        evidence: &learner.evidence,
        activity: &learner.activity,
        observations: &learner.observations,
        native_row_change: None,
        native_col_change: None,
        reference: None,
    };
    finish(&input, width as f64, height as f64, 1)
}

/// A page scrolling 4 px a frame beside a 24-px sidebar that stands still except at `bounce` frames, where
/// the whole window (sidebar included) is shifted down 4 px, as macOS's elastic overscroll does at a page's end.
fn sidebar_frames(
    count: usize,
    bounce: &[usize],
    sparse_right: Option<&dyn Fn(usize) -> bool>,
) -> Vec<Vec<u8>> {
    let (w, h) = (120usize, 72usize);
    (0..count)
        .map(|f| {
            let shift = if bounce.contains(&f) { 4 } else { 0 };
            let mut g = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    let v = if x < 24 {
                        // Sidebar: icon-like blocks, distinct per column so the band has visible structure.
                        let sy = y + 80 - shift;
                        if (sy / 6) % 2 == 0 && x % 8 < 5 {
                            200 - x as i32 * 4
                        } else {
                            30
                        }
                    } else if x >= 96 && sparse_right.is_some() {
                        // A sparse right-hand pane: one faint text line, present (and scrolling) only in some frames.
                        let sy = y + f * 4;
                        if sparse_right.unwrap()(f) && sy % 36 < 2 {
                            50
                        } else {
                            30
                        }
                    } else {
                        // Scrolling page content.
                        let sy = y + f * 4 + 80 - shift;
                        (((x * 7) ^ (sy * 13)) % 97 + 60) as i32
                    };
                    g[y * w + x] = v as u8;
                }
            }
            g
        })
        .collect()
}

/// Failure case (g.mov): a fixed sidebar that the whole window's bounce moved in 20 of 479 frames lost its band,
/// because the mean change those frames added crossed 0.7, and the sidebar was painted into the scrolling canvas.
#[test]
fn a_sidebar_still_but_for_a_few_bounces_is_a_fixed_band() {
    for bounce in [&[][..], &[10, 11, 30, 31][..]] {
        let regions = learn(120, 72, &sidebar_frames(41, bounce, None));
        let fixed: Vec<_> = regions
            .iter()
            .filter(|r| r.kind == Kind::Fixed)
            .map(|r| r.rect)
            .collect();
        assert!(
            fixed.iter().any(|r| r.x == 0.0 && r.width == 24.0),
            "bounce at {bounce:?}: expected a fixed 24-px left band, got {fixed:?}"
        );
    }
}

/// Failure case the other way: a sparse pane whose content moves in most frames (faint, so its mean change per
/// frame is small) must stay with the moving page, not be frozen as a band.
#[test]
fn a_sparse_pane_that_moves_in_most_frames_is_not_a_band() {
    let present = |f: usize| !f.is_multiple_of(4);
    let frames = sidebar_frames(41, &[], Some(&present));
    let regions = learn(120, 72, &frames);
    let fixed_right: Vec<_> = regions
        .iter()
        .filter(|r| r.kind == Kind::Fixed && r.rect.x + r.rect.width == 120.0 && r.rect.x > 0.0)
        .map(|r| r.rect)
        .collect();
    assert!(
        fixed_right.is_empty(),
        "the moving pane was frozen as a right band: {fixed_right:?}"
    );
}
