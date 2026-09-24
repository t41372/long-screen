//! Stage: native-precision band edges and the content rectangle, per-region crop/solid assignment, the
//! pane-divider's native-column crop refinement, and the post-refinement bounding-box recompute.

use super::construct::low_change_run;
use super::{band, intersect, stat_at, Bands, RegionOut};
use crate::geometry::{js_ceil, js_round, Rect};

/// `nativeEdge` (`LayerLearner`, private): locates a stationary/moving edge on native rows/columns near the
/// analysis estimate; falls back to the scaled estimate when there is no native-resolution evidence.
#[allow(clippy::too_many_arguments)]
pub(super) fn native_edge(
    stats: Option<&[f64]>,
    estimate: i64,
    scale: f64,
    direction: i8,
    limit: i64,
    threshold: f64,
    native_frames: f64,
) -> i64 {
    let guess = js_round(estimate as f64 * scale) as i64;
    let stats = match stats {
        Some(s) if native_frames != 0.0 => s,
        _ => return guess,
    };
    let window = js_ceil(2.0 * scale) as i64 + 1;
    let lo = 0i64.max(guess - window);
    let hi = limit.min(guess + window);
    let edge = if direction == 1 {
        let mut edge = lo;
        while edge < hi && stat_at(stats, edge) / native_frames < threshold {
            edge += 1;
        }
        edge
    } else {
        let mut edge = hi;
        while edge > lo && stat_at(stats, edge - 1) / native_frames < threshold {
            edge -= 1;
        }
        edge
    };
    if (edge - guess).abs() <= window {
        edge
    } else {
        guess
    }
}

/// Native band edges and the native-pixel content rectangle (`finish()`'s "Native-precision band edges" block).
pub struct NativeEdges {
    pub top: i64,
    pub bottom: i64,
    pub left: i64,
    pub right: i64,
    pub content: Rect,
}

#[allow(clippy::too_many_arguments)]
pub fn compute_native_edges(
    bands: &Bands,
    native_row_change: Option<&[f64]>,
    native_col_change: Option<&[f64]>,
    native_frames: f64,
    height: i64,
    width: i64,
    factor: f64,
    native_width: f64,
    native_height: f64,
) -> NativeEdges {
    let native_top = if bands.top > 0 {
        native_edge(
            native_row_change,
            bands.top,
            factor,
            1,
            native_height as i64,
            0.9,
            native_frames,
        )
    } else {
        0
    };
    let native_bottom = if bands.bottom < height {
        native_edge(
            native_row_change,
            bands.bottom,
            factor,
            -1,
            native_height as i64,
            0.9,
            native_frames,
        )
    } else {
        native_height as i64
    };
    let native_left = bands.exact_left.map(|v| v as i64).unwrap_or_else(|| {
        if bands.left > 0 {
            native_edge(
                native_col_change,
                bands.left,
                factor,
                1,
                native_width as i64,
                0.7,
                native_frames,
            )
        } else {
            0
        }
    });
    let native_right = bands.exact_right.map(|v| v as i64).unwrap_or_else(|| {
        if bands.right < width {
            native_edge(
                native_col_change,
                bands.right,
                factor,
                -1,
                native_width as i64,
                0.7,
                native_frames,
            )
        } else {
            native_width as i64
        }
    });
    let content = Rect {
        x: native_left as f64,
        y: native_top as f64,
        width: 0f64.max((native_right - native_left) as f64),
        height: 0f64.max((native_bottom - native_top) as f64),
    };
    NativeEdges {
        top: native_top,
        bottom: native_bottom,
        left: native_left,
        right: native_right,
        content,
    }
}

/// Assigns each region's native-pixel `crop` and `solid` from its `band_side` (or, lacking one, the first band
/// its cells touch, checked in order 1, 2, 3, 4) — `finish()`'s per-region crop/solid loop.
#[allow(clippy::too_many_arguments)]
pub fn assign_native_crops(
    regions: &mut [RegionOut],
    edges: &NativeEdges,
    native_width: f64,
    native_height: f64,
    cols: i64,
    cell: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
) {
    for r in regions.iter_mut() {
        let side = r.band_side.unwrap_or_else(|| {
            r.cells
                .as_ref()
                .filter(|c| !c.is_empty())
                .map(|cells| {
                    for which in [1u8, 2, 3, 4] {
                        if cells.iter().any(|&i| {
                            band(i, cols, cell, width, height, top, bottom, left, right) == which
                        }) {
                            return which;
                        }
                    }
                    0
                })
                .unwrap_or(0)
        });
        r.crop = Some(match side {
            1 => Rect {
                x: 0.0,
                y: 0.0,
                width: native_width,
                height: edges.top as f64,
            },
            2 => Rect {
                x: 0.0,
                y: edges.bottom as f64,
                width: native_width,
                height: native_height - edges.bottom as f64,
            },
            3 => Rect {
                x: 0.0,
                y: edges.top as f64,
                width: edges.left as f64,
                height: edges.content.height,
            },
            4 => Rect {
                x: edges.right as f64,
                y: edges.top as f64,
                width: native_width - edges.right as f64,
                height: edges.content.height,
            },
            _ => edges.content,
        });
        r.solid = side > 0;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: refine the pane-divider crop and the crops of the regions either side of it on native columns.
// ---------------------------------------------------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn refine_vertical_cut_crops(
    regions: &mut [RegionOut],
    edges: &NativeEdges,
    vertical_cut: i64,
    cell: i64,
    cols: i64,
    divider_start: i64,
    divider_end: i64,
    native_col_change: Option<&[f64]>,
    native_frames: f64,
    native_width: f64,
    factor: f64,
) {
    if vertical_cut == 0 {
        return;
    }
    let coarse = vertical_cut * cell;
    let analysis_start = divider_start.min(coarse);
    let analysis_end = divider_end.max(coarse);
    let native_run = if let Some(stats) = native_col_change.filter(|_| native_frames != 0.0) {
        low_change_run(
            stats,
            native_frames,
            js_round((analysis_start + analysis_end) as f64 / 2.0 * factor) as i64,
            js_ceil(48.0 * factor) as i64,
            native_width as i64,
        )
    } else {
        None
    };
    let (n_start, n_end) = native_run.unwrap_or((
        js_round(analysis_start as f64 * factor) as i64,
        js_round(analysis_end as f64 * factor) as i64,
    ));
    for r in regions.iter_mut() {
        if r.solid {
            continue;
        }
        let Some(cells) = &r.cells else { continue };
        if cells.is_empty() {
            continue;
        }
        if cells.iter().all(|&i| i % cols < vertical_cut) {
            r.crop = Some(Rect {
                x: edges.content.x,
                y: edges.top as f64,
                width: 0f64.max(n_start as f64 - edges.content.x),
                height: edges.content.height,
            });
        } else if cells.iter().all(|&i| i % cols >= vertical_cut) {
            r.crop = Some(Rect {
                x: n_end as f64,
                y: edges.top as f64,
                width: 0f64.max(edges.content.x + edges.content.width - n_end as f64),
                height: edges.content.height,
            });
        }
    }
    if let Some(divider) = regions.iter_mut().find(|r| r.name == "固定分隔界面") {
        divider.crop = Some(Rect {
            x: n_start as f64,
            y: edges.top as f64,
            width: 0f64.max((n_end - n_start) as f64),
            height: edges.content.height,
        });
        divider.solid = n_end > n_start;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: recompute bounding boxes after every pixel-level refinement above.
// ---------------------------------------------------------------------------------------------------------------
pub fn recompute_bounding_boxes(
    regions: &mut [RegionOut],
    width: i64,
    height: i64,
    native_width: f64,
    native_height: f64,
    factor: f64,
) {
    for r in regions.iter_mut() {
        if r.solid {
            r.rect = r.crop.unwrap_or(r.rect);
            continue;
        }
        let mask = r.mask.as_ref().unwrap();
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (width, height, -1i64, -1i64);
        for y in 0..height {
            for x in 0..width {
                if mask[(y * width + x) as usize] != 0 {
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
            }
        }
        if max_x < 0 {
            r.rect = Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            };
            continue;
        }
        // A mask bbox touching the last analysis row/column may stop short of the native edge because the final
        // box is partial. Extend the raw rect all the way to the native (or crop) edge there, so no native pixel
        // goes unowned.
        let right = if max_x == width - 1 {
            native_width
        } else {
            js_round((max_x + 1) as f64 * factor) as f64
        };
        let bottom = if max_y == height - 1 {
            native_height
        } else {
            js_round((max_y + 1) as f64 * factor) as f64
        };
        let rx = js_round(min_x as f64 * factor) as f64;
        let ry = js_round(min_y as f64 * factor) as f64;
        let raw = Rect {
            x: rx,
            y: ry,
            width: right - rx,
            height: bottom - ry,
        };
        r.rect = match r.crop {
            Some(crop) => intersect(raw, crop),
            None => raw,
        };
    }
}
