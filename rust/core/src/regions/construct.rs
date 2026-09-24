//! Stage: build one `Region` per group (paint its analysis-resolution mask), the pane divider, band expansion,
//! and cell-granularity mask copies.

use super::{band, stat_at, Kind, RegionOut};
use crate::geometry::{js_ceil, js_floor, js_round, Rect};

// ---------------------------------------------------------------------------------------------------------------
// Stage: build one Region per group and paint its analysis-resolution mask.
// ---------------------------------------------------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn build_regions(
    large: &[Vec<i64>],
    labels: &[i32],
    cols: i64,
    cell: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
    activity_acc: &[f64],
    observations: &[f64],
    informative_frames: f64,
    factor: u32,
) -> Vec<RegionOut> {
    let activity: Vec<f64> = large
        .iter()
        .map(|g| {
            let s: f64 = g.iter().map(|&i| activity_acc[i as usize]).sum();
            let o: f64 = g.iter().map(|&i| observations[i as usize]).sum();
            s / o.max(1.0)
        })
        .collect();
    let max_activity = activity.iter().cloned().fold(1.0, f64::max);
    let (sx, sy) = (factor as f64, factor as f64);
    let mut regions: Vec<RegionOut> = large
        .iter()
        .enumerate()
        .map(|(k, cells)| {
            let xs: Vec<i64> = cells.iter().map(|&i| i % cols).collect();
            let ys: Vec<i64> = cells.iter().map(|&i| i / cols).collect();
            let ax = *xs.iter().min().unwrap() * cell;
            let ay = *ys.iter().min().unwrap() * cell;
            let bx = width.min((*xs.iter().max().unwrap() + 1) * cell);
            let by = height.min((*ys.iter().max().unwrap() + 1) * cell);
            let fixed = cells
                .iter()
                .any(|&i| band(i, cols, cell, width, height, top, bottom, left, right) > 0)
                || (informative_frames >= 2.0
                    && activity[k] < max_activity * 0.08
                    && large.len() > 1);
            let rx = js_round(ax as f64 * sx) as f64;
            let ry = js_round(ay as f64 * sy) as f64;
            RegionOut {
                id: format!("layer-{k}"),
                name: if fixed {
                    "固定界面".into()
                } else {
                    format!("内容画布 {}", k + 1)
                },
                kind: if fixed { Kind::Fixed } else { Kind::Moving },
                cells: Some(cells.clone()),
                rect: Rect {
                    x: rx,
                    y: ry,
                    width: js_round(bx as f64 * sx) as f64 - rx,
                    height: js_round(by as f64 * sy) as f64 - ry,
                },
                mask: Some(vec![0u8; (width * height) as usize]),
                mask_width: width as usize,
                mask_height: height as usize,
                manual: false,
                unassigned: false,
                exclusions: Vec::new(),
                crop: None,
                solid: false,
                factor,
                band_side: None,
            }
        })
        .collect();
    for y in 0..height {
        for x in 0..width {
            let k = labels[(y / cell * cols + x / cell) as usize] as usize;
            let mask = regions[k].mask.as_mut().unwrap();
            mask[(y * width + x) as usize] = 1;
        }
    }
    regions
}

/// Nearest run of columns whose per-frame change stays below the stationary threshold; `[start, end)` or `None`.
/// Verbatim port target of `tests/support/reference/layers.ts::referenceLowChangeRun` (the frozen copy of
/// `src/core/layers.ts::lowChangeRun`).
pub(super) fn low_change_run(
    stats: &[f64],
    frames: f64,
    centre: i64,
    window: i64,
    limit: i64,
) -> Option<(i64, i64)> {
    let mut best: Option<(i64, i64)> = None;
    let mut best_distance = f64::INFINITY;
    let mut x = 1i64.max(centre - window);
    let hi = (limit - 1).min(centre + window);
    while x < hi {
        if stat_at(stats, x) / frames >= 0.7 {
            x += 1;
            continue;
        }
        let mut a = x;
        while a > 0 && stat_at(stats, a - 1) / frames < 0.7 {
            a -= 1;
        }
        while x + 1 < limit && stat_at(stats, x + 1) / frames < 0.7 {
            x += 1;
        }
        let b = x + 1;
        let d = if centre >= a && centre < b {
            0.0
        } else {
            (a - centre).abs().min((b - centre).abs()) as f64
        };
        if d < best_distance {
            best = Some((a, b));
            best_distance = d;
        }
        x += 1;
    }
    best
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: pane divider — a persistent global cut that closes weak, textureless bridges between independent panes.
// Returns the analysis-resolution [start, end) the divider covers (0,0 when there is no vertical cut).
// ---------------------------------------------------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn apply_pane_divider(
    regions: &mut Vec<RegionOut>,
    labels: &[i32],
    cols: i64,
    rows: i64,
    cell: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    vertical_cut: i64,
    col_change: &[f64],
    informative_frames: f64,
    factor: u32,
) -> (i64, i64) {
    if vertical_cut == 0 {
        return (0, 0);
    }
    let coarse = vertical_cut * cell;
    let run = low_change_run(col_change, informative_frames, coarse, 48, width);
    let (start, end) = run.unwrap_or((coarse, coarse));
    let mut divider_index: Option<usize> = None;
    if end > start {
        regions.push(RegionOut {
            id: format!("layer-{}", regions.len()),
            name: "固定分隔界面".into(),
            kind: Kind::Fixed,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            cells: None,
            mask: Some(vec![0u8; (width * height) as usize]),
            mask_width: width as usize,
            mask_height: height as usize,
            manual: false,
            unassigned: false,
            exclusions: Vec::new(),
            crop: None,
            solid: false,
            factor,
            band_side: None,
        });
        divider_index = Some(regions.len() - 1);
    }
    for y in top..bottom {
        let row = (rows - 1).min(y / cell);
        let left_idx = labels[(row * cols + 0i64.max(vertical_cut - 3)) as usize] as usize;
        let right_idx = labels[(row * cols + (cols - 1).min(vertical_cut + 2)) as usize] as usize;
        if left_idx == right_idx {
            continue;
        }
        let xa = 0i64.max(start.min(coarse) - cell);
        let xb = width.min(end.max(coarse) + cell);
        for x in xa..xb {
            let i = (y * width + x) as usize;
            for r in regions.iter_mut() {
                if let Some(m) = &mut r.mask {
                    m[i] = 0;
                }
            }
            let target = if x < start {
                left_idx
            } else if x >= end {
                right_idx
            } else {
                divider_index.unwrap_or(right_idx)
            };
            regions[target].mask.as_mut().unwrap()[i] = 1;
        }
    }
    (start, end)
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: band expansion — proven stationary edge bands absorb featureless pixels (a blank toolbar still belongs
// to the toolbar). A region whose cells touch more than one band keeps only the LAST band visited here (1, 2, 3,
// then 4) as its `band_side`, reproducing the TS's unconditional overwrite.
// ---------------------------------------------------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn expand_bands(
    regions: &mut Vec<RegionOut>,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
    native_width: f64,
    native_height: f64,
    cols: i64,
    cell: i64,
    factor: u32,
) {
    let band_rect = |which: u8| -> (i64, i64, i64, i64) {
        match which {
            1 => (0, 0, width, top),
            2 => (0, bottom, width, height),
            3 => (0, top, left, bottom),
            _ => (right, top, width, bottom),
        }
    };
    for which in [1u8, 2, 3, 4] {
        let (x0, y0, x1, y1) = band_rect(which);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let found = regions.iter().position(|r| {
            r.kind == Kind::Fixed
                && r.cells.as_ref().is_some_and(|cells| {
                    cells.iter().any(|&i| {
                        band(i, cols, cell, width, height, top, bottom, left, right) == which
                    })
                })
        });
        let index = match found {
            Some(i) => i,
            None => {
                regions.push(RegionOut {
                    id: format!("layer-{}", regions.len()),
                    name: "固定界面".into(),
                    kind: Kind::Fixed,
                    rect: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: native_width,
                        height: native_height,
                    },
                    cells: Some(Vec::new()),
                    mask: Some(vec![0u8; (width * height) as usize]),
                    mask_width: width as usize,
                    mask_height: height as usize,
                    manual: false,
                    unassigned: false,
                    exclusions: Vec::new(),
                    crop: None,
                    solid: false,
                    factor,
                    band_side: None,
                });
                regions.len() - 1
            }
        };
        regions[index].band_side = Some(which);
        for y in y0..y1 {
            for x in x0..x1 {
                let i = (y * width + x) as usize;
                for r in regions.iter_mut() {
                    if let Some(m) = &mut r.mask {
                        m[i] = 0;
                    }
                }
                regions[index].mask.as_mut().unwrap()[i] = 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: cell granularity — rows/columns strictly between a band edge and the next cell boundary belong to the
// content beside them, not to the band (the analysis mask is only cell-resolution).
// ---------------------------------------------------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn apply_cell_granularity(
    regions: &mut [RegionOut],
    width: i64,
    height: i64,
    cell: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
) {
    let cell_top = js_ceil(top as f64 / cell as f64) as i64 * cell;
    let cell_bottom = js_floor(bottom as f64 / cell as f64) as i64 * cell;
    let cell_left = js_ceil(left as f64 / cell as f64) as i64 * cell;
    let cell_right = js_floor(right as f64 / cell as f64) as i64 * cell;
    let copy_row = |regions: &mut [RegionOut], from: i64, to: i64| {
        if from < 0 || from >= height || to == from {
            return;
        }
        for r in regions.iter_mut() {
            if let Some(m) = &mut r.mask {
                let (f, t) = (from as usize, to as usize);
                let w = width as usize;
                m.copy_within(f * w..(f + 1) * w, t * w);
            }
        }
    };
    let copy_column = |regions: &mut [RegionOut], from: i64, to: i64| {
        if from < 0 || from >= width || to == from {
            return;
        }
        for r in regions.iter_mut() {
            if let Some(m) = &mut r.mask {
                for y in top..bottom {
                    let v = m[(y * width + from) as usize];
                    m[(y * width + to) as usize] = v;
                }
            }
        }
    };
    if top > 0 {
        for y in top..cell_top.min(bottom) {
            copy_row(regions, (height - 1).min(cell_top), y);
        }
    }
    if bottom < height {
        for y in cell_bottom.max(top)..bottom {
            copy_row(regions, 0i64.max(cell_bottom - 1), y);
        }
    }
    if left > 0 {
        for x in left..cell_left.min(right) {
            copy_column(regions, (width - 1).min(cell_left), x);
        }
    }
    if right < width {
        for x in cell_right.max(left)..right {
            copy_column(regions, 0i64.max(cell_right - 1), x);
        }
    }
}
