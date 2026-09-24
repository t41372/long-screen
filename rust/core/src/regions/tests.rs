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
