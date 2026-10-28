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
        pixel_fixed: &zeros,
        pixel_moving: &zeros,
        native_row_change: None,
        native_row_middle: None,
        native_col_change: None,
        row_fixed: None,
        row_moving: None,
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
        pixel_fixed: &learner.pixel_fixed,
        pixel_moving: &learner.pixel_moving,
        native_row_change: None,
        native_row_middle: None,
        native_col_change: None,
        row_fixed: None,
        row_moving: None,
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

/// A 100×60 window seen at factor 1: a sidebar over x 0..20 (lines of text in `sidebar_text`, else blank) with its
/// edge at x 20, an empty dark margin over x 20..60 that never changes, and page content over x 60..100 that moves in
/// every informative frame. Returns the bands.
fn wide_margin_bands(sidebar_text: bool) -> super::bands::Bands {
    let (w, h) = (100usize, 60usize);
    let mut rgba = vec![255u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let v = if x < 20 {
                if sidebar_text && y % 6 == 0 && (3..17).contains(&x) {
                    200
                } else {
                    60
                }
            } else if x < 60 {
                10
            } else if (y + x) % 7 < 3 {
                230
            } else {
                40
            };
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 3].fill(v);
        }
    }
    let reference = Rgba {
        width: w,
        height: h,
        data: &rgba,
    };
    let frames = 10.0;
    let row_change = vec![frames; h];
    let col_moving: Vec<f64> = (0..w).map(|x| if x < 60 { 0.0 } else { frames }).collect();
    let col_mean = vec![0.0; w];
    super::bands::detect_bands(
        w as i64,
        h as i64,
        frames,
        &row_change,
        None,
        (&[], &[]),
        &col_moving,
        &col_mean,
        Some(&reference),
        w as f64,
        h as f64,
        1.0,
    )
}

// test_2: the browser's tab panel and ChatGPT's sidebar stand still, and so does the empty dark margin of the chat
// beside them, so the walk over stationary columns ran past 45% of the width and the whole left band was thrown
// away; the sidebar stayed in the moving layer and tore. At the cap, the sidebar's own edge is still looked for.
#[test]
fn a_sidebar_beside_an_empty_margin_wider_than_the_cap_is_a_left_band() {
    let bands = wide_margin_bands(true);
    assert_eq!(bands.left, 20);
    assert_eq!(bands.exact_left, Some(20.0));
}

// A blank strip with an edge is still page geometry, not a sidebar (§十: 侧边带要有可见结构).
#[test]
fn a_blank_strip_beside_an_empty_margin_is_not_a_left_band() {
    let bands = wide_margin_bands(false);
    assert_eq!(bands.left, 0);
    assert_eq!(bands.exact_left, None);
}

/// One frame's motion field for `learn_fields`: the models (dx, dy) and each analysis cell's model index.
type FrameField = (Vec<(f64, f64)>, Vec<u8>);

/// Runs `frames` through the learner with a per-frame motion field: `field(f)` gives frame f's models (the first
/// is the page's, whatever moves) and the model each analysis cell is labelled with. Then `finish()` at factor 1.
fn learn_fields(
    width: usize,
    height: usize,
    frames: &[Vec<u8>],
    field: &dyn Fn(usize, usize, usize) -> FrameField,
) -> Vec<RegionOut> {
    learn_fields_seeing(width, height, frames, field, false)
}

/// `learn_fields`, with the last frame as the appearance reference when `with_reference` is set.
fn learn_fields_seeing(
    width: usize,
    height: usize,
    frames: &[Vec<u8>],
    field: &dyn Fn(usize, usize, usize) -> FrameField,
    with_reference: bool,
) -> Vec<RegionOut> {
    use crate::kernels::layers::{Field, FieldMotion, Learner};
    let mut learner = Learner::new(width, height);
    let (cols, rows) = (learner.cols, learner.rows);
    let cells = cols * rows;
    let (confidence, dynamic) = (vec![255u8; cells], vec![0u8; cells]);
    for (f, pair) in frames.windows(2).enumerate() {
        let (models, labels) = field(f + 1, cols, rows);
        let motions: Vec<FieldMotion> = models
            .iter()
            .map(|&(x, y)| FieldMotion {
                x,
                y,
                support: 100,
                confidence: 1.0,
            })
            .collect();
        let field = Field {
            motions: &motions,
            labels: &labels,
            confidence: &confidence,
            dynamic: &dynamic,
            cols,
            rows,
            difference: 1.0,
            unknown: false,
        };
        assert!(learner.add(&field, &pair[0], &pair[1], None));
    }
    let rgba: Vec<u8> = frames
        .last()
        .unwrap()
        .iter()
        .flat_map(|&v| [v, v, v, 255])
        .collect();
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
        pixel_fixed: &learner.pixel_fixed,
        pixel_moving: &learner.pixel_moving,
        native_row_change: None,
        native_row_middle: None,
        native_col_change: None,
        reference: with_reference.then(|| Rgba {
            width,
            height,
            data: &rgba,
        }),
        row_fixed: None,
        row_moving: None,
    };
    finish(&input, width as f64, height as f64, 1)
}

/// Textured content: a pattern that changes along both axes, sampled at world position (x, y).
fn texture(x: usize, y: usize) -> u8 {
    (((x * 7) ^ (y * 13)) % 97 + 60) as u8
}

/// Failure case (new_ip_1's header, new_ip_9's glass tab bar, new_mac_1's YouTube masthead and sidebar): a bar
/// that stays on screen while the page scrolls 4 px a frame, but whose pixels still change a little every frame
/// (the page shows through it, a title collapses), so its rows' mean change is over the band walk's 0.9 and no
/// top band is found. The field gives its cells the page's motion in half the frames, as a field does where the
/// page shows through, so its activity is far above 8 % of the page's. It must be learned as fixed UI, not as a
/// second scroll layer that the solve then tears into one fragment per state.
#[test]
fn a_bar_that_stays_put_while_its_pixels_flicker_is_fixed_ui() {
    for with_reference in [false, true] {
        let (moving, fixed) = flickering_bar(&|x, y| texture(x + 500, y), with_reference);
        assert_eq!(
            moving.len(),
            1,
            "expected one scroll layer, got {moving:?} (fixed {fixed:?})"
        );
        assert!(
            fixed
                .iter()
                .any(|r| r.y == 0.0 && r.height == 48.0 && r.width == 96.0),
            "expected the bar as fixed UI, got fixed {fixed:?}, moving {moving:?}"
        );
    }
}

/// Failure case (pub_2's empty chat margin, 584 × 504 px of black under the app's top bar): an area that stays put
/// while the page scrolls, but whose only structure is the one line where it meets the bar above. The line's pixels
/// vote for standing still, the blank ones for nothing, so its votes alone made it a fixed canvas of an empty
/// image. With an appearance reference it must stay what it was before: a moving region, not screen-fixed UI.
#[test]
fn a_blank_area_whose_only_structure_is_one_line_is_not_fixed_ui() {
    let line = |_: usize, y: usize| if y == 20 { 200 } else { 0 };
    let (moving, fixed) = flickering_bar(&line, true);
    assert!(
        fixed.is_empty() && moving.len() == 2,
        "expected the blank area to stay a moving region, got moving {moving:?}, fixed {fixed:?}"
    );
    // Without a reference there is nothing to look at, and the votes decide as before.
    let (_, fixed) = flickering_bar(&line, false);
    assert_eq!(fixed.len(), 1, "{fixed:?}");
}

/// A 48-row bar painted by `bar(x, y)` stays on screen with a 2-level flicker on top (alternating frames) over a
/// page scrolling 4 px a frame; the field gives the bar's cells the page's motion in half the frames, as a field
/// does where the page shows through. Returns the (moving, fixed) region rects.
fn flickering_bar(
    bar_paint: &dyn Fn(usize, usize) -> u8,
    with_reference: bool,
) -> (Vec<Rect>, Vec<Rect>) {
    let (w, h, bar) = (96usize, 144usize, 48usize);
    let frames: Vec<Vec<u8>> = (0..41)
        .map(|f| {
            let mut g = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    g[y * w + x] = if y < bar {
                        bar_paint(x, y) + if f % 2 == 0 { 2 } else { 0 }
                    } else {
                        texture(x, y + f * 4)
                    };
                }
            }
            g
        })
        .collect();
    let regions = learn_fields_seeing(
        w,
        h,
        &frames,
        &|f, cols, rows| {
            let mut labels = vec![0u8; cols * rows];
            if f % 2 == 1 {
                labels[..cols * (bar / 24)].fill(1);
            }
            let _ = rows;
            (vec![(0.0, 4.0), (0.0, 0.0)], labels)
        },
        with_reference,
    );
    let moving: Vec<_> = regions
        .iter()
        .filter(|r| r.kind == Kind::Moving)
        .map(|r| r.rect)
        .collect();
    let fixed: Vec<_> = regions
        .iter()
        .filter(|r| r.kind == Kind::Fixed)
        .map(|r| r.rect)
        .collect();
    (moving, fixed)
}

/// Failure case the other way: a narrower pane that scrolls on its own in more frames than it stands still, beside
/// a wider pane that scrolls in the rest, is a second scroll layer and stays one.
#[test]
fn a_second_pane_that_mostly_scrolls_stays_a_scroll_layer() {
    let (w, h, split) = (144usize, 144usize, 96usize);
    let right_moves = |f: usize| f > 12;
    let frames: Vec<Vec<u8>> = (0..41)
        .map(|f| {
            let (left_offset, right_offset) = if right_moves(f) {
                (12 * 4, (f - 12) * 4)
            } else {
                (f * 4, 0)
            };
            let mut g = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    g[y * w + x] = if x < split {
                        texture(x, y + left_offset)
                    } else {
                        texture(x + 300, y + right_offset)
                    };
                }
            }
            g
        })
        .collect();
    let regions = learn_fields(w, h, &frames, &|f, cols, rows| {
        let mut labels = vec![0u8; cols * rows];
        for y in 0..rows {
            for x in 0..cols {
                let right = x * 24 >= split;
                labels[y * cols + x] = if right == right_moves(f) { 0 } else { 1 };
            }
        }
        (vec![(0.0, 4.0), (0.0, 0.0)], labels)
    });
    let moving: Vec<_> = regions
        .iter()
        .filter(|r| r.kind == Kind::Moving)
        .map(|r| r.rect)
        .collect();
    assert_eq!(
        moving.len(),
        2,
        "expected both panes as scroll layers, got {moving:?}"
    );
}

// Translucent chrome: every row of an iOS 26 glass bar changes as the page scrolls beneath it, so the change test
// finds no band on that side. The bar's own icons and text still stand still, which the row votes record
// (`Learner::row_fixed` against `Learner::row_moving`). `fixed`/`moving` are per-frame vote counts for the rows of
// `[0, chrome)`; every other row votes like scrolling content.
fn glass_bands(chrome: usize, fixed: f64, moving: f64, still_rows: usize) -> super::bands::Bands {
    glass_bands_over(chrome, fixed, moving, still_rows, &[])
}

/// `glass_bands`, with fixed objects floating on the page: in the rows of each `(from, to, samples)`, that many of
/// the row's sampled pixels stand still in every frame and never follow the page, while the rows' totals still vote
/// like scrolling content (the page around the objects is far larger than they are).
fn glass_bands_over(
    chrome: usize,
    fixed: f64,
    moving: f64,
    still_rows: usize,
    objects: &[(usize, usize, usize)],
) -> super::bands::Bands {
    let (w, h) = (204usize, 300usize);
    let frames = 10.0;
    let samples = ((w - 4).div_ceil(4)) as f64;
    let row_change: Vec<f64> = (0..h)
        .map(|y| if y < still_rows { 0.0 } else { 5.0 * frames })
        .collect();
    let row_fixed: Vec<f64> = (0..h)
        .map(|y| frames * if y < chrome { fixed } else { 0.02 * samples })
        .collect();
    let row_moving: Vec<f64> = (0..h)
        .map(|y| frames * if y < chrome { moving } else { 0.3 * samples })
        .collect();
    let col_moving = vec![frames; w];
    let col_mean = vec![0.0; w];
    let mut pixel_fixed = vec![0.0; w * h];
    let pixel_moving = vec![0.0; w * h];
    for &(from, to, samples) in objects {
        for y in from..to {
            for k in 0..samples {
                pixel_fixed[y * w + 2 + 4 * k] = frames;
            }
        }
    }
    super::bands::detect_bands(
        w as i64,
        h as i64,
        frames,
        &row_change,
        Some((&row_fixed, &row_moving)),
        (&pixel_fixed, &pixel_moving),
        &col_moving,
        &col_mean,
        None,
        w as f64,
        h as f64,
        1.0,
    )
}

#[test]
fn a_glass_bar_whose_icons_stand_still_is_a_top_band() {
    let bands = glass_bands(40, 15.0, 2.0, 0);
    assert_eq!((bands.top, bands.bottom), (40, 300));
}

#[test]
fn rows_that_mostly_follow_the_page_are_not_a_band() {
    // Standing still wins at some pixels of scrolling content too (sub-pixel steps, loading images), but not
    // 1.5 times as often as the motion does.
    let bands = glass_bands(40, 15.0, 12.0, 0);
    assert_eq!(bands.top, 0);
}

#[test]
fn a_handful_of_still_pixels_in_a_bare_row_is_not_a_band() {
    // 1 vote per frame in a row of 50 samples is under the 3% floor, however few the moving votes.
    let bands = glass_bands(40, 1.0, 0.0, 0);
    assert_eq!(bands.top, 0);
}

#[test]
fn a_fade_over_the_page_without_icons_is_not_a_band() {
    // Standing still wins at a fade because each row dims the page differently, but on no row at the density of
    // a bar's icons and text (5 of 50 samples here, against a fifth or more).
    let bands = glass_bands(40, 5.0, 1.0, 0);
    assert_eq!(bands.top, 0);
}

#[test]
fn a_side_the_change_test_already_bounds_keeps_its_edge() {
    // Rows 0..12 pass the change test, so the votes of rows 12..40 are not consulted on that side.
    let bands = glass_bands(40, 15.0, 2.0, 12);
    assert_eq!(bands.top, 12);
}

// The lower part of an iOS 26 glass bar: the blur fades out downwards, the page shows through ever more clearly and
// votes for the motion, so the row votes stop the band early (new_ip_2 at 285 of 480 px, new_ip_3 at 155), while
// the bar's buttons, avatar and name capsule still float there. Counted per sampled pixel, they stand still.

#[test]
fn objects_floating_right_under_a_glass_band_belong_to_it() {
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(40, 110, 8)]);
    assert_eq!(bands.top, 110);
}

#[test]
fn a_short_gap_between_the_objects_does_not_end_the_band() {
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(40, 70, 8), (85, 110, 8)]);
    assert_eq!(bands.top, 110);
}

#[test]
fn a_float_button_past_a_stretch_of_page_stays_out_of_the_band() {
    // A button floating on the page past a stretch of rows with no standing-still pixels (25 rows at factor 1 here)
    // is not part of the bar above it.
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(40, 105, 8), (130, 134, 8)]);
    assert_eq!(bands.top, 105);
}

#[test]
fn a_bar_soft_edge_of_a_few_rows_does_not_move_the_band() {
    // The halo above new_ip_3's input bar: dense standing-still rows right past the band's edge, 35 px of them,
    // where the page shows through sharply. Only objects as tall as `FIXED_ROW_RUN` move the band.
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(40, 75, 40)]);
    assert_eq!(bands.top, 40);
}

#[test]
fn a_few_still_pixels_in_a_row_do_not_extend_the_band() {
    // Under an icon's width of samples: a scrollbar or a stray still pixel of the page.
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(40, 110, 4)]);
    assert_eq!(bands.top, 40);
}

#[test]
fn a_band_found_by_the_change_test_is_not_extended() {
    let bands = glass_bands_over(40, 15.0, 2.0, 12, &[(12, 110, 8)]);
    assert_eq!(bands.top, 12);
}

#[test]
fn still_pixels_down_the_whole_screen_do_not_extend_the_band() {
    // A sidebar (or anything else fixed beside the page) stands still in every row; a walk that reaches the 45 % cap
    // has found no bar edge, and the band stays as the votes found it.
    let bands = glass_bands_over(40, 15.0, 2.0, 0, &[(0, 300, 8)]);
    assert_eq!((bands.top, bands.bottom), (40, 300));
}

// A scrollbar's thumb at the window's edge (new_mac_4, a code editor): the thumb's columns move in about 40 % of the
// frames, so the walk in from the right edge stops at them, and the blank strip outside the thumb has no structure:
// no right band, and the minimap standing still inside the thumb stays in the moving layer. Ways a crossing could go
// wrong, written before it was allowed (the numbers are the engine's own `pixel_fixed`/`pixel_moving` per sampled
// pixel and frame on the recordings):
// - a thumb with a fixed panel beside it is not crossed (new_mac_4: the thumb 0.07 / 0.0001, the minimap 0.12 / 0);
// - columns that move with the page beside the thumb are taken (pub_1: 0.017 following under the thumb);
// - what stands still beyond the thumb but is no panel is taken: a blank margin with a resting pointer (own_c, 3.8
//   times as often still as following), an empty strip by the page's edge (own_g, 0.016 still);
// - a thumb in the last columns, where no pixel is sampled, is crossed on no evidence;
// - the crossing runs without the votes (the change-only bands) or on the left without being mirrored.
struct Thumb {
    /// Per sampled pixel and frame, in the thumb's columns: standing still, following the page.
    thumb: (f64, f64),
    /// The same beyond it, up to the page.
    beyond: (f64, f64),
    /// The thumb's first column (4 wide) and the page's last column + 1 (the panel is `[page, thumb - 8)`).
    at: usize,
    /// Share of the columns beyond the thumb that carry `beyond` (from the page's side); the rest stand still blank.
    filled: f64,
    page: usize,
    votes: bool,
    mirror: bool,
}

const THUMB: Thumb = Thumb {
    thumb: (0.07, 0.0001),
    beyond: (0.12, 0.0),
    at: 528,
    page: 440,
    filled: 1.0,
    votes: true,
    mirror: false,
};

fn thumb_bands(t: Thumb) -> super::bands::Bands {
    let (w, h) = (600usize, 100usize);
    let frames = 40.0;
    // `x` as seen from the right edge, or from the left one when mirrored.
    let at = |x: usize| if t.mirror { w - 1 - x } else { x };
    let mut col_moving = vec![0.0; w];
    let mut col_mean = vec![200.0 * frames; w];
    let (mut pixel_fixed, mut pixel_moving) = (vec![0.0; w * h], vec![0.0; w * h]);
    for x in 0..w {
        let c = at(x);
        let (moves, votes, mean) = if x < t.page {
            (1.0, (0.02, 0.4), 120.0 + (x % 9) as f64 * 9.0)
        } else if x < t.at - 8 {
            let inside = ((x - t.page) as f64) < t.filled * (t.at - 8 - t.page) as f64;
            let votes = if inside { t.beyond } else { (0.0, 0.0) };
            (0.0, votes, 90.0 + (x % 7) as f64 * 15.0)
        } else if (t.at..t.at + 4).contains(&x) {
            (0.4, t.thumb, 200.0)
        } else {
            (0.0, (0.0, 0.0), 200.0)
        };
        col_moving[c] = moves * frames;
        col_mean[c] = mean * frames;
        for y in 0..h {
            pixel_fixed[y * w + c] = votes.0 * frames;
            pixel_moving[y * w + c] = votes.1 * frames;
        }
    }
    let row_change = vec![5.0 * frames; h];
    let (row_fixed, row_moving) = (vec![0.0; h], vec![frames * 100.0; h]);
    super::bands::detect_bands(
        w as i64,
        h as i64,
        frames,
        &row_change,
        t.votes.then_some((&row_fixed[..], &row_moving[..])),
        (&pixel_fixed, &pixel_moving),
        &col_moving,
        &col_mean,
        None,
        w as f64,
        h as f64,
        1.0,
    )
}

#[test]
fn a_fixed_panel_beyond_a_scrollbar_thumb_is_a_side_band() {
    let bands = thumb_bands(THUMB);
    assert_eq!((bands.left, bands.right), (0, 440));
    let bands = thumb_bands(Thumb {
        mirror: true,
        ..THUMB
    });
    assert_eq!((bands.left, bands.right), (160, 600));
}

#[test]
fn a_thumb_beside_what_follows_the_page_is_not_crossed() {
    // pub_1: the page's notes show under and beside the thumb.
    let bands = thumb_bands(Thumb {
        thumb: (0.2, 0.017),
        ..THUMB
    });
    assert_eq!((bands.left, bands.right), (0, 600));
}

#[test]
fn what_stands_still_beyond_a_thumb_must_be_a_panel() {
    // own_c: a blank margin with a resting pointer, 3.8 times as often still as following.
    let bands = thumb_bands(Thumb {
        beyond: (0.0675, 0.0178),
        ..THUMB
    });
    assert_eq!(bands.right, 600);
    // own_g: an empty strip by the page's edge, 0.016 standing still.
    let bands = thumb_bands(Thumb {
        beyond: (0.016, 0.0),
        ..THUMB
    });
    assert_eq!(bands.right, 600);
    // A blank margin with a button floating on it: what stands still there fills under half of its columns, however
    // often it votes (thumb-beside-margin).
    let bands = thumb_bands(Thumb {
        beyond: (0.12, 0.0),
        filled: 0.4,
        ..THUMB
    });
    assert_eq!(bands.right, 600);
}

#[test]
fn a_thumb_with_no_sampled_column_is_not_crossed() {
    // The last two columns are never sampled; a thumb there carries no votes either way.
    let bands = thumb_bands(Thumb {
        at: 596,
        page: 500,
        ..THUMB
    });
    assert_eq!(bands.right, 600);
}

#[test]
fn without_the_votes_the_walk_stops_at_the_thumb() {
    let bands = thumb_bands(Thumb {
        votes: false,
        ..THUMB
    });
    assert_eq!(bands.right, 600);
}

/// `glass_bands_over` with the row votes of every row given by `votes(y)` (standing still, following, per frame).
fn vote_bands(votes: &dyn Fn(usize) -> (f64, f64)) -> super::bands::Bands {
    vote_bands_with_objects(votes, &|_| 0)
}

/// `objects(y)`: how many of row `y`'s sampled columns (every 4th from 2) belong to an object standing still in half
/// the frames and never following the page.
fn vote_bands_with_objects(
    votes: &dyn Fn(usize) -> (f64, f64),
    objects: &dyn Fn(usize) -> usize,
) -> super::bands::Bands {
    let (w, h) = (204usize, 300usize);
    let frames = 10.0;
    let row_change = vec![5.0 * frames; h];
    let row_fixed: Vec<f64> = (0..h).map(|y| frames * votes(y).0).collect();
    let row_moving: Vec<f64> = (0..h).map(|y| frames * votes(y).1).collect();
    let (mut pixel_fixed, pixel_moving) = (vec![0.0; w * h], vec![0.0; w * h]);
    for y in 0..h {
        for i in 0..objects(y) {
            pixel_fixed[y * w + 2 + 4 * i] = 0.5 * frames;
        }
    }
    super::bands::detect_bands(
        w as i64,
        h as i64,
        frames,
        &row_change,
        Some((&row_fixed, &row_moving)),
        (&pixel_fixed, &pixel_moving),
        &vec![frames; w],
        &vec![0.0; w],
        None,
        w as f64,
        h as f64,
        1.0,
    )
}

// new_ip_3's bottom bar: its last rows stand still only about 1.5 to 2 times as often as they follow the page (the
// home indicator over the glass). Four more informative frames (an odd-step fix in motion) took row 564 from 1.53
// to 1.48, the walk from the bottom edge stopped there with 9 rows and no dense structure, and the whole bottom band
// was gone, its tab icons burnt into the print. Ways a gap-tolerant walk could fail, written before it:
// - a bar with a few rows just under the ratio near its edge is still cut there;
// - the walk crosses rows the page clearly moves: own_f's floating composer sits above rows at 1.16 to 1.32 where
//   the page shows through, and crossing them made it a band reaching up over page text and a floating button;
// - the walk crosses more than a bar's spacing of page rows into something standing still further in;
// - the band ends inside the gap instead of at the last row that stands still.
const BAR: (f64, f64) = (15.0, 2.0);
const PAGE: (f64, f64) = (1.0, 15.0);
/// Standing still 1.45 times as often as following the page: just under the ratio.
const NEAR: (f64, f64) = (14.5, 10.0);
/// 1.3 times: the page moves these rows too often for them to be the bar's.
const UNDER: (f64, f64) = (13.0, 10.0);

#[test]
fn a_few_rows_just_under_the_ratio_do_not_cut_a_bar() {
    let bands = vote_bands(&|y| match y {
        3..6 => NEAR,
        _ if y < 40 => BAR,
        _ => PAGE,
    });
    assert_eq!(bands.top, 40);
    let bands = vote_bands(&|y| match y {
        294..297 => NEAR,
        _ if y >= 260 => BAR,
        _ => PAGE,
    });
    assert_eq!(bands.bottom, 260);
}

#[test]
fn rows_the_page_moves_too_often_end_a_bar() {
    let bands = vote_bands(&|y| match y {
        10..12 => UNDER,
        _ if y < 40 => BAR,
        _ => PAGE,
    });
    assert_eq!(bands.top, 10);
    let bands = vote_bands(&|y| match y {
        288..290 => UNDER,
        _ if y >= 260 => BAR,
        _ => PAGE,
    });
    assert_eq!(bands.bottom, 290);
}

// pub_6's status bar: the rows through the bottom of the Dynamic Island stand still only 1.08 to 1.42 times as often
// as they follow the page, because the page shows through on both sides of the island, but the island's own pixels
// stand still in every frame (25 sampled pixels a row). The walk stopped above them and the band cut the island in
// two, its lower half torn in the print. own_f's rows under ChatGPT's input box (1.16 to 1.32) hold no such pixel.
const DILUTED: (f64, f64) = (11.0, 10.0);

#[test]
fn rows_whose_objects_stand_still_do_not_cut_a_bar() {
    let bands = vote_bands_with_objects(
        &|y| match y {
            10..13 => DILUTED,
            _ if y < 20 => BAR,
            _ => PAGE,
        },
        &|y| if (10..13).contains(&y) { 10 } else { 0 },
    );
    assert_eq!(bands.top, 20);
    let bands = vote_bands_with_objects(
        &|y| match y {
            10..13 => DILUTED,
            _ if y < 20 => BAR,
            _ => PAGE,
        },
        &|_| 0,
    );
    assert_eq!(bands.top, 10);
}

#[test]
fn the_walk_does_not_cross_more_than_a_bars_spacing_of_page() {
    // A bar of 10 rows, 25 rows of page (over the 20 px gap), then rows standing still again further in.
    let bands = vote_bands(&|y| {
        if y < 10 || (35..60).contains(&y) {
            BAR
        } else {
            PAGE
        }
    });
    assert_eq!(bands.top, 10);
    // A gap at the end of the bar is not part of it: the band ends at the last row that stands still.
    let bands = vote_bands(&|y| if y < 30 { BAR } else { PAGE });
    assert_eq!(bands.top, 30);
    // A walk whose first row follows the page finds no bar, as before.
    let bands = vote_bands(&|y| if (3..40).contains(&y) { BAR } else { PAGE });
    assert_eq!(bands.top, 0);
}

// A bottom sheet whose top corners are rounded (new_ip_6 and new_ip_7, Google Maps' place sheet): the page shows
// through the corners in the sheet's first rows, so their mean change stays above 0.9 for 28 native px and the change
// test ends the band there, leaving the sheet's white edge in the moving layer, where every pan burns it into the map.
// Ways a band edge past those rows could go wrong, written before it was allowed (the numbers are the engine's own
// accumulators on the 32 recordings):
// - page rows next to a bar, whose sampled pixels vote "still" because the motion lands on the bar, join it
//   (new_ip_4, new_ip_8: 0.94–1.0 of the samples, but each native row changes as much as the page does);
// - a fade over the page joins the bar (pub_2: 0.57 of the samples still);
// - a header that slides over the page and stands still in between joins the bar (`header-lag-collapse`: its rows
//   change across their whole width while it slides);
// - an analysis row holding the page's last native rows joins it (new_mac_2's top bar);
// - rows standing still down to the walk's cap are taken as a bar's edge;
// - the native edge is put where the change falls under 0.9 instead of at the sheet's edge;
// - the top side is not mirrored.
struct Sheet {
    /// Per frame, the native change of the sheet's rounded rows over the whole row (from their first row on), and over
    /// the middle half of the row.
    edge_change: (f64, f64),
    edge_middle: f64,
    /// Sampled pixels (of 50) of the rounded rows that stand still.
    fixed_samples: usize,
    /// First analysis row of the rounded rows (they end at 252, where the change test's band starts).
    from: usize,
    top: bool,
}

const SHEET: Sheet = Sheet {
    edge_change: (6.0, 1.0),
    edge_middle: 0.1,
    fixed_samples: 50,
    from: 248,
    top: false,
};

/// The bands and native band edges for a 204×300 analysis frame at factor 5 (1020×1500 native): page rows change by
/// 5 a frame (30 native, in the middle too), the sheet's rounded rows run from 3 native rows into analysis row `t.from`
/// (1243 for 248) to 1260, its body below them stands still. Returns the bands as the change test found them, after
/// `extend_past_bar_edges`, and both native edges (top or bottom, as `t.top` asks).
fn sheet_bands(t: Sheet) -> (Bands, Bands, i64, i64) {
    let (w, h, factor) = (204usize, 300usize, 5usize);
    let (nw, nh) = (w * factor, h * factor);
    let frames = 10.0;
    let flip = |y: usize, n: usize| if t.top { n - 1 - y } else { y };
    let (mut row_change, mut native, mut middle) = (vec![0.0; h], vec![0.0; nh], vec![0.0; nh]);
    let (mut pixel_fixed, pixel_moving) = (vec![0.0; w * h], vec![0.0; w * h]);
    for y in 0..h {
        let change = if y < t.from {
            5.0
        } else if y < 252 {
            1.5
        } else {
            0.0
        };
        row_change[flip(y, h)] = change * frames;
        if (t.from..252).contains(&y) {
            for k in 0..t.fixed_samples {
                pixel_fixed[flip(y, h) * w + 2 + 4 * k] = frames;
            }
        }
    }
    // The rounded rows start 3 native rows into analysis row `t.from`.
    let first = t.from * factor + 3;
    for n in 0..nh {
        let (change, mid) = if n < first {
            (30.0, 30.0)
        } else if n < 1260 {
            let (a, b) = t.edge_change;
            (
                a + (b - a) * (n - first) as f64 / (1259 - first) as f64,
                t.edge_middle,
            )
        } else {
            (0.1, 0.1)
        };
        native[flip(n, nh)] = change * frames;
        middle[flip(n, nh)] = mid * frames;
    }
    let (row_fixed, row_moving) = (vec![0.0; h], vec![0.0; h]);
    let col_moving = vec![frames; w];
    let col_mean = vec![0.0; w];
    let detect = || {
        super::bands::detect_bands(
            w as i64,
            h as i64,
            frames,
            &row_change,
            Some((&row_fixed, &row_moving)),
            (&pixel_fixed, &pixel_moving),
            &col_moving,
            &col_mean,
            None,
            nw as f64,
            nh as f64,
            factor as f64,
        )
    };
    let (found, mut bands) = (detect(), detect());
    super::bands::extend_past_bar_edges(
        &mut bands,
        w as i64,
        h as i64,
        frames,
        (&pixel_fixed, &pixel_moving),
        &middle,
        frames,
        factor as f64,
    );
    let edge = |b: &Bands| {
        let e = compute_native_edges(
            b,
            Some(&native),
            None,
            frames,
            h as i64,
            w as i64,
            factor as f64,
            nw as f64,
            nh as f64,
        );
        if t.top {
            e.top
        } else {
            e.bottom
        }
    };
    let (before, after) = (edge(&found), edge(&bands));
    (found, bands, before, after)
}

#[test]
fn a_sheet_with_rounded_corners_starts_at_its_top_edge() {
    let (found, bands, before, after) = sheet_bands(SHEET);
    assert_eq!(found.bottom, 252);
    // Analysis row 248 still holds three native rows of the page; the native edge is the sheet's own. The band (the
    // analysis cells) stays.
    assert_eq!(
        (bands.bottom, bands.bar_edge.1, after),
        (252, Some(249), 1243),
        "change test: {before}"
    );
}

#[test]
fn a_top_bar_with_rounded_lower_corners_ends_at_its_bottom_edge() {
    let (found, bands, _, after) = sheet_bands(Sheet { top: true, ..SHEET });
    assert_eq!(found.top, 48);
    assert_eq!(
        (bands.top, bands.bar_edge.0, after),
        (48, Some(51), 1500 - 1243)
    );
}

#[test]
fn page_rows_whose_pixels_vote_still_beside_a_bar_stay_page() {
    // Every sampled pixel stands still often enough, but each native row changes as much as the page, in the middle too.
    let (found, bands, before, after) = sheet_bands(Sheet {
        edge_change: (30.0, 30.0),
        edge_middle: 30.0,
        ..SHEET
    });
    assert_eq!((bands.bar_edge.1, after), (None, before));
    assert_eq!(bands.bottom, found.bottom);
}

#[test]
fn a_header_changing_across_its_width_stays_out() {
    // Its pixels stand still in most frames and never follow the page, but it slides over the page now and then: its
    // rows change in the middle as well, a little above the change test's threshold.
    let (_, bands, before, after) = sheet_bands(Sheet {
        edge_middle: 1.2,
        ..SHEET
    });
    assert_eq!((bands.bar_edge.1, after), (None, before));
}

#[test]
fn a_fade_over_the_page_stays_page() {
    // Only about half the samples stand still.
    let (_, bands, before, after) = sheet_bands(Sheet {
        fixed_samples: 28,
        ..SHEET
    });
    assert_eq!((bands.bar_edge.1, after), (None, before));
}

#[test]
fn rows_standing_still_down_to_the_cap_are_no_bar_edge() {
    let (_, bands, before, after) = sheet_bands(Sheet { from: 150, ..SHEET });
    assert_eq!((bands.bar_edge.1, after), (None, before));
}
