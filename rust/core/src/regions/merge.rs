//! Stage: merge slivers into the nearest large moving region, absorb sticky/collapsing header edge regions into
//! the main pane, and the final filter + single-full-pane fallback.

use super::{intersect, Kind, RegionOut, Rgba};
use crate::chrome::{stationary_boundary, Axis, Choose};
use crate::geometry::Rect;

// ---------------------------------------------------------------------------------------------------------------
// Stage: merge slivers into the nearest large moving region, then absorb sticky/collapsing header edge regions
// into the main pane. Both mutate `rect`/`mask` in place and re-derive their working sets on every iteration,
// exactly as the TS does (later merges see the effect of earlier ones).
// ---------------------------------------------------------------------------------------------------------------
fn rect_area(r: &Rect) -> f64 {
    r.width * r.height
}

pub fn merge_small_regions(regions: &mut [RegionOut], valid: &[usize], factor: f64) {
    let (sx, sy) = (factor, factor);
    let largest_moving = valid
        .iter()
        .filter(|&&i| regions[i].kind == Kind::Moving)
        .map(|&i| rect_area(&regions[i].rect))
        .fold(0.0, f64::max);
    let small_list: Vec<usize> = valid
        .iter()
        .copied()
        .filter(|&i| {
            let r = &regions[i].rect;
            regions[i].kind == Kind::Moving
                && (r.width < 30.0 * sx
                    || r.height < 30.0 * sy
                    || rect_area(r) < largest_moving * 0.08)
        })
        .collect();
    for small in small_list {
        let small_rect = regions[small].rect;
        let mut candidates: Vec<usize> = valid
            .iter()
            .copied()
            .filter(|&i| {
                i != small
                    && regions[i].kind == Kind::Moving
                    && rect_area(&regions[i].rect) > rect_area(&small_rect) * 3.0
            })
            .collect();
        candidates.sort_by(|&a, &b| {
            let distance = |r: &Rect| -> f64 {
                0f64.max((r.x - small_rect.x - small_rect.width).max(small_rect.x - r.x - r.width))
                    + 0f64.max(
                        (r.y - small_rect.y - small_rect.height).max(small_rect.y - r.y - r.height),
                    )
            };
            distance(&regions[a].rect)
                .partial_cmp(&distance(&regions[b].rect))
                .unwrap()
        });
        let Some(&other) = candidates.first() else {
            continue;
        };
        let small_mask = regions[small].mask.clone().unwrap();
        {
            let other_mask = regions[other].mask.as_mut().unwrap();
            for (i, &v) in small_mask.iter().enumerate() {
                if v != 0 {
                    other_mask[i] = 1;
                }
            }
        }
        {
            let small_mask = regions[small].mask.as_mut().unwrap();
            for v in small_mask.iter_mut() {
                *v = 0;
            }
        }
        let other_rect = regions[other].rect;
        let x = other_rect.x.min(small_rect.x);
        let y = other_rect.y.min(small_rect.y);
        regions[other].rect = Rect {
            x,
            y,
            width: (other_rect.x + other_rect.width).max(small_rect.x + small_rect.width) - x,
            height: (other_rect.y + other_rect.height).max(small_rect.y + small_rect.height) - y,
        };
        regions[small].rect.width = 0.0;
    }
}

#[allow(clippy::too_many_arguments)]
pub fn cleanup_sticky_headers(
    regions: &mut [RegionOut],
    valid: &[usize],
    content: Rect,
    cell: i64,
    factor: f64,
    reference: Option<&Rgba>,
) {
    let sy = factor;
    // First element with the maximum area wins on a tie (a stable descending sort's [0], not Rust's `max_by`
    // which keeps the LAST maximum).
    let mut main: Option<usize> = None;
    let mut main_area = f64::NEG_INFINITY;
    for &i in valid.iter().filter(|&&i| regions[i].kind == Kind::Moving) {
        let a = rect_area(&regions[i].rect);
        if a > main_area {
            main_area = a;
            main = Some(i);
        }
    }
    let Some(main) = main else { return };
    let edge_list: Vec<usize> = valid
        .iter()
        .copied()
        .filter(|&i| {
            let r = &regions[i].rect;
            i != main
                && regions[i].kind == Kind::Moving
                && r.width > content.width * 0.8
                && r.height < content.height * 0.3
        })
        .collect();
    for edge in edge_list {
        let edge_rect = regions[edge].rect;
        let main_rect = regions[main].rect;
        let overlap = intersect(edge_rect, main_rect);
        let edge_ok = edge_rect.y <= content.y + sy
            || edge_rect.y + edge_rect.height >= content.y + content.height - sy;
        let overlap_ok = overlap.height >= cell as f64 * sy * 0.8;
        let boundary_ok = match reference {
            None => true,
            Some(img) => stationary_boundary(
                img.data,
                img.width,
                img.height,
                Axis::Y,
                overlap.y,
                overlap.y + overlap.height,
                content.x,
                content.x + content.width,
                Choose::First,
            )
            .is_none(),
        };
        if edge_ok && overlap_ok && boundary_ok {
            let edge_mask = regions[edge].mask.clone().unwrap();
            {
                let main_mask = regions[main].mask.as_mut().unwrap();
                for (i, &v) in edge_mask.iter().enumerate() {
                    if v != 0 {
                        main_mask[i] = 1;
                    }
                }
            }
            regions[edge].rect.width = 0.0;
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stage: final filtering and the single-full-pane fallback.
// ---------------------------------------------------------------------------------------------------------------
pub fn finalize(mut regions: Vec<RegionOut>, valid: &[usize], content: Rect) -> Vec<RegionOut> {
    let result_idx: Vec<usize> = valid
        .iter()
        .copied()
        .filter(|&i| regions[i].rect.width > 0.0)
        .collect();
    let moving_idx: Vec<usize> = result_idx
        .iter()
        .copied()
        .filter(|&i| regions[i].kind == Kind::Moving)
        .collect();
    if moving_idx.len() == 1 {
        let solo = moving_idx[0];
        let all_ok = result_idx.iter().all(|&i| {
            i == solo
                || (regions[i].kind == Kind::Fixed
                    && regions[i].solid
                    && rect_area(&intersect(regions[i].rect, content)) == 0.0)
        });
        if all_ok {
            regions[solo].crop = Some(content);
            regions[solo].rect = content;
            regions[solo].solid = true;
        }
    }
    // Extract in `result_idx` order, leaving everything else behind.
    let mut taken: Vec<Option<RegionOut>> = regions.into_iter().map(Some).collect();
    result_idx
        .into_iter()
        .map(|i| taken[i].take().unwrap())
        .collect()
}
