//! Stage: union-find over analysis cells, then grouping into scroll containers.

use super::band;
use crate::geometry::js_floor;

// ---------------------------------------------------------------------------------------------------------------
// Stage: union-find over analysis cells, then grouping into scroll containers.
// ---------------------------------------------------------------------------------------------------------------
pub struct DisjointSet {
    parent: Vec<i64>,
    size: Vec<i64>,
}

impl DisjointSet {
    pub fn new(n: usize) -> Self {
        DisjointSet {
            parent: (0..n as i64).collect(),
            size: vec![1; n],
        }
    }
    pub fn find(&mut self, i: i64) -> i64 {
        let mut r = i;
        while self.parent[r as usize] != r {
            r = self.parent[r as usize];
        }
        let mut cur = i;
        while self.parent[cur as usize] != cur {
            let next = self.parent[cur as usize];
            self.parent[cur as usize] = r;
            cur = next;
        }
        r
    }
    pub fn join(&mut self, a: i64, b: i64) {
        let (mut a, mut b) = (self.find(a), self.find(b));
        if a == b {
            return;
        }
        if self.size[a as usize] < self.size[b as usize] {
            std::mem::swap(&mut a, &mut b);
        }
        self.parent[b as usize] = a;
        self.size[a as usize] += self.size[b as usize];
    }
}

#[allow(clippy::too_many_arguments)]
pub fn union_find_cells(
    cols: i64,
    rows: i64,
    cell: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    left: i64,
    right: i64,
    vertical_cut: i64,
    horizontal_cut: i64,
    evidence: &[f64],
    split: &[f64],
    informative_frames: f64,
) -> DisjointSet {
    let n = (cols * rows) as usize;
    let mut ds = DisjointSet::new(n);
    for y in 0..rows {
        for x in 0..cols {
            let i = y * cols + x;
            let candidates = [
                (if x + 1 < cols { i + 1 } else { -1 }, 0i64),
                (if y + 1 < rows { i + cols } else { -1 }, 1i64),
            ];
            for (j, k) in candidates {
                if j < 0 {
                    continue;
                }
                let bi = band(i, cols, cell, width, height, top, bottom, left, right);
                let bj = band(j, cols, cell, width, height, top, bottom, left, right);
                if bi != bj {
                    continue;
                }
                if bi == 0
                    && ((vertical_cut != 0
                        && ((i % cols < vertical_cut) != (j % cols < vertical_cut)))
                        || (horizontal_cut != 0
                            && ((i / cols < horizontal_cut) != (j / cols < horizontal_cut))))
                {
                    continue;
                }
                let e = evidence[(i * 2 + k) as usize];
                let s = split[(i * 2 + k) as usize];
                if bi > 0 || e < (2.0f64).max(informative_frames * 0.04) || s / e < 0.32 {
                    ds.join(i, j);
                }
            }
        }
    }
    ds
}

/// Groups cells by root, in the insertion order a JS `Map` would produce (first time each root is seen while
/// scanning cells 0..n), keeps only groups with ≥ `minimum` cells (falling back to one all-cells group), sorts
/// descending by size (stable — ties keep that insertion order), then fills every ungrouped cell into its nearest
/// group by Manhattan distance, growing groups as it goes (later cells see earlier fills, exactly as the TS
/// `large[choice].push(i)` mutation-during-scan does).
pub fn group_and_label(ds: &mut DisjointSet, n: i64, cols: i64) -> (Vec<Vec<i64>>, Vec<i32>) {
    let mut root_to_group: Vec<i64> = vec![-1; n as usize];
    let mut groups: Vec<Vec<i64>> = Vec::new();
    for i in 0..n {
        let root = ds.find(i);
        let slot = root_to_group[root as usize];
        if slot < 0 {
            root_to_group[root as usize] = groups.len() as i64;
            groups.push(vec![i]);
        } else {
            groups[slot as usize].push(i);
        }
    }
    let minimum = (3i64).max(js_floor(n as f64 * 0.025) as i64);
    let mut large: Vec<Vec<i64>> = groups
        .into_iter()
        .filter(|g| g.len() as i64 >= minimum)
        .collect();
    large.sort_by_key(|g| std::cmp::Reverse(g.len()));
    if large.is_empty() {
        large.push((0..n).collect());
    }
    let mut labels = vec![-1i32; n as usize];
    for (k, g) in large.iter().enumerate() {
        for &i in g {
            labels[i as usize] = k as i32;
        }
    }
    for i in 0..n {
        if labels[i as usize] < 0 {
            let x = i % cols;
            let y = i / cols;
            let (mut best, mut choice) = (f64::INFINITY, 0usize);
            for (k, g) in large.iter().enumerate() {
                for &j in g {
                    let d = (x - j % cols).abs() + (y - j / cols).abs();
                    if (d as f64) < best {
                        best = d as f64;
                        choice = k;
                    }
                }
            }
            labels[i as usize] = choice as i32;
            large[choice].push(i);
        }
    }
    (large, labels)
}
