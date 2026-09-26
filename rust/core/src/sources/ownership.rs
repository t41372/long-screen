//! Alternative ownership for automatic interior fixed islands. Permanent outer chrome and ambiguous
//! overlapping panes keep their original labels; no image values or output pixels are changed here.
use super::objects::Bounds;
use serde::Deserialize;
#[derive(Deserialize)]
pub struct Region {
    pub code: u8,
    pub fixed: bool,
    pub rect: Bounds,
    pub crop: Bounds,
}
fn contains(a: Bounds, b: Bounds) -> bool {
    b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
}
pub fn parent_labels(labels: &[u8], regions: &[Region], out: &mut [u8]) -> usize {
    let mut parents = [0u8; 256];
    for child in regions.iter().filter(|r| r.fixed) {
        let candidates: Vec<_> = regions
            .iter()
            .filter(|r| !r.fixed && contains(r.crop, child.rect) && contains(r.rect, child.rect))
            .filter(|r| {
                let a = r.crop;
                let b = child.rect;
                !(b.x <= a.x && b.x + b.width >= a.x + a.width
                    || b.y <= a.y && b.y + b.height >= a.y + a.height)
            })
            .collect();
        if candidates.len() == 1 {
            parents[child.code as usize] = candidates[0].code;
        }
    }
    let mut changed = 0;
    for (&label, target) in labels.iter().zip(out) {
        let parent = parents[label as usize];
        *target = if parent != 0 {
            changed += 1;
            parent
        } else {
            label
        };
    }
    changed
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interior_islands_gain_one_parent_without_absorbing_outer_chrome() {
        let b = |x, y, w, h| Bounds {
            x,
            y,
            width: w,
            height: h,
        };
        let regions = vec![
            Region {
                code: 1,
                fixed: false,
                rect: b(0, 10, 100, 80),
                crop: b(0, 10, 100, 80),
            },
            Region {
                code: 2,
                fixed: true,
                rect: b(0, 0, 100, 10),
                crop: b(0, 0, 100, 10),
            },
            Region {
                code: 3,
                fixed: true,
                rect: b(80, 70, 20, 20),
                crop: b(80, 70, 20, 20),
            },
            Region {
                code: 4,
                fixed: true,
                rect: b(0, 10, 10, 80),
                crop: b(0, 10, 10, 80),
            },
        ];
        let mut out = [0; 4];
        assert_eq!(parent_labels(&[1, 2, 3, 4], &regions, &mut out), 1);
        assert_eq!(out, [1, 2, 1, 4]);
    }
}

/// Index possible parent observations even when the compositor saw no disagreement: the only
/// clean frame may have been assigned to a fixed island and therefore never reached compositing.
#[derive(Deserialize)]
pub struct Replay {
    pub width: usize,
    pub height: usize,
    pub code: u8,
    pub side: usize,
    pub poses: Vec<(i32, i32)>,
}
pub fn shards(labels: &[u8], parents: &[u8], replay: Replay) -> Vec<super::materialize::Shard> {
    use std::collections::{BTreeMap, BTreeSet};
    let mut runs = Vec::new();
    for y in 0..replay.height {
        let mut x = 0;
        while x < replay.width {
            let belongs = |x| {
                let i = y * replay.width + x;
                labels[i] != replay.code && parents[i] == replay.code
            };
            if !belongs(x) {
                x += 1;
                continue;
            }
            let first = x;
            while x < replay.width && belongs(x) {
                x += 1;
            }
            runs.push((first as i32, x as i32, y as i32));
        }
    }
    let side = replay.side as i32;
    let blocks = replay.side / super::SIDE;
    let mut shards = BTreeMap::<(i32, i32), Vec<u8>>::new();
    for (px, py) in replay.poses.into_iter().collect::<BTreeSet<_>>() {
        for &(left, right, y) in &runs {
            let wy = y + py;
            let by = wy.div_euclid(super::SIDE as i32);
            for bx in (left + px).div_euclid(super::SIDE as i32)
                ..=(right - 1 + px).div_euclid(super::SIDE as i32)
            {
                let wx = bx * super::SIDE as i32;
                let key = (wx.div_euclid(side), wy.div_euclid(side));
                let at = by.rem_euclid(blocks as i32) as usize * blocks
                    + bx.rem_euclid(blocks as i32) as usize;
                shards
                    .entry(key)
                    .or_insert_with(|| vec![0; blocks * blocks])[at] = 1;
            }
        }
    }
    shards
        .into_iter()
        .map(|((x, y), disputes)| super::materialize::Shard { x, y, disputes })
        .collect()
}
