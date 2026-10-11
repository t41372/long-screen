//! The preview pyramid of one canvas (docs/ARCHITECTURE.md §八): each level halves the one below it, four child tiles
//! per parent tile, alpha-weighted so unobserved pixels never darken observed ones. Level 0 stays at source
//! resolution and is never rewritten.
//!
//! [`PyramidSession`] builds one canvas's levels as a resumable job the host drives. The pyramid does not go through
//! the tile cache: the host reads stored child tiles and writes parent tiles straight to and from storage. Per
//! level, [`PyramidSession::step`] first asks for the stored tile index of the level below ([`Step::NeedIndex`]:
//! the host passes every row to [`PyramidSession::queue`], which names the parent tile to queue), then works
//! through the queued parents in storage-key order: [`Step::NeedChildren`] names the four child tiles to read
//! ([`PyramidSession::provide`]), [`Step::Parent`] hands back the assembled parent (or `None` when no child exists)
//! for the host to store before it drops the parent from its queue and checks for pause and stop.
//! [`Step::LevelDone`] reports a finished level, [`Step::Done`] the last one.

use crate::tiles::TileKey;
use long_screen_core::pyramid::assemble_parent;
use std::collections::BTreeMap;

/// Levels above level 0: how many times `size` doubles before it reaches the larger bound dimension, i.e.
/// `ceil(log2(max(width, height) / size))` clamped to 0, counted by doubling so it never depends on a
/// floating-point logarithm.
pub fn level_count(width: f64, height: f64, size: usize) -> u32 {
    let max_dimension = width.max(height);
    let mut levels = 0;
    let mut scale = size as f64;
    while scale < max_dimension {
        levels += 1;
        scale *= 2.0;
    }
    levels
}

/// The storage-key suffix of a queued parent, `x_y`; the queue runs in the byte order of these keys, which is the
/// order the host's store iterates them in.
pub fn queue_key(x: i32, y: i32) -> String {
    format!("{x}_{y}")
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Pass every stored tile-index row of level `level - 1` to [`PyramidSession::queue`], then step again.
    NeedIndex {
        level: u32,
    },
    /// Read these four child tiles (quadrant order: `[dx=0,dy=0]`, `[1,0]`, `[0,1]`, `[1,1]`), pass their decoded
    /// pixels (or `None` for one that is not stored) to [`PyramidSession::provide`], then step again.
    NeedChildren {
        level: u32,
        x: i32,
        y: i32,
        children: [TileKey; 4],
    },
    /// One queued parent is done: store `pixels` (`size × size` RGBA) as tile `x_y` of `level` when there are any,
    /// then drop the parent from the queue and step again.
    Parent {
        level: u32,
        x: i32,
        y: i32,
        pixels: Option<Vec<u8>>,
    },
    /// Every parent of `level` is done: the canvas now has `level` as its top level.
    LevelDone {
        level: u32,
    },
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PyramidError {
    /// The tile size is not a positive even number.
    BadSize,
    /// `queue` outside [`Step::NeedIndex`], or `provide` outside [`Step::NeedChildren`].
    Unexpected,
    /// A provided child does not hold `size × size` RGBA pixels.
    BadChild,
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    /// Next step asks for the index of the level below `level`.
    Start(u32),
    /// The host is passing index rows for `level`.
    Indexing(u32),
    /// Working through the queue of `level`.
    Parents(u32),
    /// The children of the parent at the queue's head were asked for.
    Children(u32, i32, i32),
    /// The children of that parent were provided.
    Provided(u32, i32, i32),
    Done,
}

/// One canvas's pyramid in progress.
pub struct PyramidSession {
    canvas: String,
    size: usize,
    levels: u32,
    phase: Phase,
    queue: BTreeMap<String, (i32, i32)>,
    children: [Option<Vec<u8>>; 4],
}

impl PyramidSession {
    /// A pyramid for canvas `canvas` whose bounds are `width × height`, over `size`-pixel tiles.
    pub fn new(canvas: &str, width: f64, height: f64, size: usize) -> Result<Self, PyramidError> {
        if size == 0 || !size.is_multiple_of(2) {
            return Err(PyramidError::BadSize);
        }
        let levels = level_count(width, height, size);
        Ok(Self {
            canvas: canvas.to_string(),
            size,
            levels,
            phase: if levels == 0 {
                Phase::Done
            } else {
                Phase::Start(1)
            },
            queue: BTreeMap::new(),
            children: [None, None, None, None],
        })
    }

    /// Levels above level 0 this canvas gets.
    pub fn levels(&self) -> u32 {
        self.levels
    }

    /// One stored index row `(x, y)` of the level below: queues its parent and returns the parent's coordinates
    /// (the host records the queued parent under them).
    pub fn queue(&mut self, x: i32, y: i32) -> Result<(i32, i32), PyramidError> {
        if !matches!(self.phase, Phase::Indexing(_)) {
            return Err(PyramidError::Unexpected);
        }
        let parent = (x.div_euclid(2), y.div_euclid(2));
        self.queue.insert(queue_key(parent.0, parent.1), parent);
        Ok(parent)
    }

    /// The decoded pixels of the four children [`Step::NeedChildren`] asked for, `None` for each one not stored.
    pub fn provide(&mut self, children: [Option<Vec<u8>>; 4]) -> Result<(), PyramidError> {
        let Phase::Children(level, x, y) = self.phase else {
            return Err(PyramidError::Unexpected);
        };
        let n = self.size * self.size * 4;
        if children.iter().flatten().any(|c| c.len() != n) {
            return Err(PyramidError::BadChild);
        }
        self.children = children;
        self.phase = Phase::Provided(level, x, y);
        Ok(())
    }

    pub fn step(&mut self) -> Step {
        match self.phase.clone() {
            Phase::Start(level) => {
                self.phase = Phase::Indexing(level);
                Step::NeedIndex { level }
            }
            Phase::Indexing(level) | Phase::Parents(level) => match self.queue.pop_first() {
                Some((_, (x, y))) => {
                    self.phase = Phase::Children(level, x, y);
                    let child = |dx: i32, dy: i32| {
                        TileKey::new(&self.canvas, level - 1, x * 2 + dx, y * 2 + dy)
                    };
                    Step::NeedChildren {
                        level,
                        x,
                        y,
                        children: [child(0, 0), child(1, 0), child(0, 1), child(1, 1)],
                    }
                }
                None => {
                    self.phase = if level < self.levels {
                        Phase::Start(level + 1)
                    } else {
                        Phase::Done
                    };
                    Step::LevelDone { level }
                }
            },
            // Asked again without the children: ask again.
            Phase::Children(level, x, y) => {
                let child = |dx: i32, dy: i32| {
                    TileKey::new(&self.canvas, level - 1, x * 2 + dx, y * 2 + dy)
                };
                Step::NeedChildren {
                    level,
                    x,
                    y,
                    children: [child(0, 0), child(1, 0), child(0, 1), child(1, 1)],
                }
            }
            Phase::Provided(level, x, y) => {
                self.phase = Phase::Parents(level);
                let children = std::mem::take(&mut self.children);
                let pixels = children.iter().any(Option::is_some).then(|| {
                    let mut out = vec![0u8; self.size * self.size * 4];
                    let [a, b, c, d] = &children;
                    assemble_parent(
                        [a.as_deref(), b.as_deref(), c.as_deref(), d.as_deref()],
                        self.size,
                        &mut out,
                    );
                    out
                });
                Step::Parent {
                    level,
                    x,
                    y,
                    pixels,
                }
            }
            Phase::Done => Step::Done,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives a session to the end against `stored` level-0 tiles (opaque pixels of one value each), returning every
    /// parent written as `(level, x, y, first pixel)`, the levels reported done, and the queued parents.
    fn run(
        size: usize,
        width: f64,
        height: f64,
        level0: &[(i32, i32, u8)],
    ) -> (Vec<(u32, i32, i32, [u8; 4])>, Vec<u32>, usize) {
        let mut session = PyramidSession::new("c", width, height, size).unwrap();
        let mut store: BTreeMap<(u32, i32, i32), Vec<u8>> = BTreeMap::new();
        for &(x, y, v) in level0 {
            let mut px = vec![v; size * size * 4];
            px.iter_mut().skip(3).step_by(4).for_each(|a| *a = 255);
            store.insert((0, x, y), px);
        }
        let (mut parents, mut done, mut queued) = (Vec::new(), Vec::new(), 0);
        loop {
            match session.step() {
                Step::NeedIndex { level } => {
                    // The store's index order: string keys `x_y`.
                    let mut rows: Vec<(String, i32, i32)> = store
                        .keys()
                        .filter(|k| k.0 == level - 1)
                        .map(|&(_, x, y)| (queue_key(x, y), x, y))
                        .collect();
                    rows.sort();
                    for (_, x, y) in rows {
                        session.queue(x, y).unwrap();
                        queued += 1;
                    }
                }
                Step::NeedChildren { children, .. } => {
                    let got = children
                        .clone()
                        .map(|k| store.get(&(k.level, k.x, k.y)).cloned());
                    session.provide(got).unwrap();
                }
                Step::Parent {
                    level,
                    x,
                    y,
                    pixels,
                } => {
                    if let Some(p) = pixels {
                        parents.push((level, x, y, [p[0], p[1], p[2], p[3]]));
                        store.insert((level, x, y), p);
                    }
                }
                Step::LevelDone { level } => done.push(level),
                Step::Done => return (parents, done, queued),
            }
        }
    }

    #[test]
    fn level_count_matches_the_doubling_table() {
        let size = 64;
        for (width, expected) in [
            (1.0, 0),
            (63.0, 0),
            (64.0, 0),
            (65.0, 1),
            (128.0, 1),
            (129.0, 2),
            (256.0, 2),
            (257.0, 3),
        ] {
            assert_eq!(level_count(width, 1.0, size), expected, "width {width}");
            assert_eq!(level_count(1.0, width, size), expected, "height {width}");
        }
    }

    #[test]
    fn a_canvas_within_one_tile_has_no_levels_and_asks_for_nothing() {
        let mut s = PyramidSession::new("c", 10.0, 10.0, 64).unwrap();
        assert_eq!(s.levels(), 0);
        assert_eq!(s.step(), Step::Done);
    }

    #[test]
    fn an_odd_or_zero_tile_size_is_refused() {
        assert_eq!(
            PyramidSession::new("c", 1.0, 1.0, 0).err(),
            Some(PyramidError::BadSize)
        );
        assert_eq!(
            PyramidSession::new("c", 1.0, 1.0, 15).err(),
            Some(PyramidError::BadSize)
        );
    }

    #[test]
    fn queue_and_provide_out_of_turn_are_refused() {
        let mut s = PyramidSession::new("c", 200.0, 10.0, 64).unwrap();
        assert_eq!(s.queue(0, 0), Err(PyramidError::Unexpected));
        assert_eq!(
            s.provide([None, None, None, None]),
            Err(PyramidError::Unexpected)
        );
        assert_eq!(s.step(), Step::NeedIndex { level: 1 });
        assert_eq!(
            s.provide([None, None, None, None]),
            Err(PyramidError::Unexpected)
        );
        s.queue(0, 0).unwrap();
        assert!(matches!(s.step(), Step::NeedChildren { .. }));
        assert_eq!(s.queue(0, 0), Err(PyramidError::Unexpected));
        assert_eq!(
            s.provide([Some(vec![0; 3]), None, None, None]),
            Err(PyramidError::BadChild)
        );
    }

    #[test]
    fn parents_floor_negative_coordinates_and_run_in_storage_key_order() {
        let mut s = PyramidSession::new("c", 4096.0, 64.0, 64).unwrap();
        assert_eq!(s.step(), Step::NeedIndex { level: 1 });
        // -1 → -1 (floor, not truncation); 20 and 21 share parent 10; 2 → 1.
        assert_eq!(s.queue(-1, 0).unwrap(), (-1, 0));
        assert_eq!(s.queue(20, 0).unwrap(), (10, 0));
        assert_eq!(s.queue(21, 1).unwrap(), (10, 0));
        assert_eq!(s.queue(2, 0).unwrap(), (1, 0));
        let mut order = Vec::new();
        loop {
            match s.step() {
                Step::NeedChildren { x, y, children, .. } => {
                    order.push((x, y));
                    assert_eq!(children[1], TileKey::new("c", 0, x * 2 + 1, y * 2));
                    assert_eq!(children[2], TileKey::new("c", 0, x * 2, y * 2 + 1));
                    s.provide([None, None, None, None]).unwrap();
                }
                Step::Parent { pixels, .. } => assert!(pixels.is_none()),
                Step::LevelDone { level } => {
                    assert_eq!(level, 1);
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        // "-1_0" < "10_0" < "1_0": byte order of the keys, not numeric order.
        assert_eq!(order, vec![(-1, 0), (10, 0), (1, 0)]);
    }

    #[test]
    fn a_two_level_canvas_builds_each_level_from_the_one_below() {
        // 256 × 64 at 64-pixel tiles: levels 1 and 2; four level-0 tiles in a row.
        let (parents, done, queued) = run(
            64,
            256.0,
            64.0,
            &[(0, 0, 10), (1, 0, 20), (2, 0, 30), (3, 0, 40)],
        );
        assert_eq!(done, vec![1, 2]);
        // Level 1: (0,0) from tiles 0,1 and (1,0) from tiles 2,3; level 2: (0,0) from both level-1 tiles.
        assert_eq!(
            parents.iter().map(|p| (p.0, p.1, p.2)).collect::<Vec<_>>(),
            vec![(1, 0, 0), (1, 1, 0), (2, 0, 0)]
        );
        // The top-left quadrant of each parent is its first child halved: opaque, the child's value.
        assert_eq!(parents[0].3, [10, 10, 10, 255]);
        assert_eq!(parents[1].3, [30, 30, 30, 255]);
        assert_eq!(parents[2].3, [10, 10, 10, 255]);
        assert_eq!(queued, 4 + 2);
    }

    #[test]
    fn a_missing_quadrant_stays_transparent() {
        let (parents, ..) = run(64, 128.0, 128.0, &[(1, 1, 50)]);
        assert_eq!(parents.len(), 1);
        // Only the bottom-right child exists: the top-left pixel is untouched zero.
        assert_eq!(parents[0].3, [0, 0, 0, 0]);
    }
}
