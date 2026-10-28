//! Nested scroll containers inside a moving region: a scroll box in an article that the page carries along, or a
//! pane of a layout the whole of which pans (docs/ARCHITECTURE.md §九). A container shows itself only in the frames
//! where it scrolls by itself: there its content moves by a second translation, not by the region's step. The solve
//! pass already knows the region's step and pose; this kernel finds the second translation among the feature
//! matches the step does not explain, lets every cell of the region vote for the region's step or for the second
//! translation (the stationary-versus-motion test of `kernels::layers::Learner::add` and `screen_fixed`, with the
//! second translation in place of standing still), and counts the votes per cell of the region's own canvas, where
//! a container that the region carries stays put. Cells that the second translation won often enough, connected,
//! are a container's footprint in the region's canvas.

use crate::kernels::geometry::js_hypot;
use crate::kernels::geometry::Rect;
use crate::kernels::motion::{translation_hypotheses, MatchPoints};
use std::collections::{HashMap, HashSet};

/// Side of a cell, in analysis pixels.
pub const CELL: i64 = 8;
/// Analysis pixels a cell samples per axis (every second one).
const SAMPLE: i64 = 2;
/// Grey levels by which one explanation must beat the other for the pixel to vote, as in `Learner::add`.
const MARGIN: i32 = 6;
/// Pixels of one kind a cell needs in a frame for its verdict that frame.
const MIN_VOTES: u32 = 2;
/// Analysis pixels by which a match must miss the region's step to count against it.
const MISS: f64 = 2.0;
/// Matches the second translation needs: a few corners of one container, not one stray pair.
const MIN_MATCHES: u32 = 6;
/// A second translation shorter than this, in analysis pixels, is something standing on screen (`screen_fixed`), or
/// noise, not a container scrolling.
pub const MIN_STEP: f64 = 2.0;
/// Frames in which a cell's content must have taken the second translation.
const OTHER_FRAMES: u16 = 4;
/// And at least this share of its votes: a container may scroll by itself rarely, but not almost never.
const OTHER_SHARE: f64 = 0.2;
/// Cells a footprint needs: about a 48 × 48 analysis-pixel box. Less is a widget, not a container.
const MIN_CELLS: usize = 36;
/// Cells the second translation must win in one connected block in a frame for any of them to count.
const FRAME_CELLS: usize = 16;

/// The second translation of a frame (content now at (x, y) was at (x + t.0, y + t.1) before, analysis pixels): the
/// strongest translation among the matches that miss the region's `step`, when it has `MIN_MATCHES` and is at least
/// `MIN_STEP` long on screen.
pub fn second_translation(matches: &[MatchPoints], step: (f64, f64)) -> Option<(f64, f64)> {
    let misses: Vec<MatchPoints> = matches
        .iter()
        .filter(|m| js_hypot(m.ax - m.bx - step.0, m.ay - m.by - step.1) > MISS)
        .copied()
        .collect();
    let best = translation_hypotheses(&misses, 1).into_iter().next()?;
    (best.support >= MIN_MATCHES && js_hypot(best.x, best.y) >= MIN_STEP)
        .then_some((best.x, best.y))
}

/// Whether a translation leaves the two frames any overlap (and is a number at all): one that does not shows nothing.
fn overlaps(t: (f64, f64), width: usize, height: usize) -> bool {
    t.0.abs() < width as f64 && t.1.abs() < height as f64
}

#[derive(Clone, Copy, Default)]
struct Votes {
    other: u16,
    region: u16,
    /// Sides of the region's rectangle the voting screen cell touched (1 left, 2 right, 4 top, 8 bottom) on frames
    /// the second translation won: the container may continue past what the region showed.
    open: u8,
}

/// A container's footprint in the region's canvas, in analysis pixels, and the sides on which it reached the edge of
/// what the region showed (it may continue there).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Footprint {
    pub x0: i64,
    pub y0: i64,
    pub x1: i64,
    pub y1: i64,
    pub open: u8,
    /// Frames the second translation won in its most-voted cell.
    pub frames: u16,
}

/// Votes for the second translation and for the region's step along one axis of the canvas, native pixels.
#[derive(Default)]
struct Profile {
    start: i64,
    votes: Vec<[u32; 2]>,
}

impl Profile {
    fn add(&mut self, at: i64, won: bool) {
        if self.votes.is_empty() {
            self.start = at;
        }
        if at < self.start {
            let grow = (self.start - at) as usize;
            self.votes.splice(0..0, std::iter::repeat_n([0, 0], grow));
            self.start = at;
        }
        let i = (at - self.start) as usize;
        if i >= self.votes.len() {
            self.votes.resize(i + 1, [0, 0]);
        }
        self.votes[i][won as usize] += 1;
    }

    /// The share of votes the second translation won at `at`, when there are at least `MIN_LINE_VOTES`.
    fn share(&self, at: i64) -> Option<f64> {
        let i = at - self.start;
        if i < 0 || i as usize >= self.votes.len() {
            return None;
        }
        let [lost, won] = self.votes[i as usize];
        (won + lost >= MIN_LINE_VOTES).then(|| won as f64 / (won + lost) as f64)
    }
}

/// Votes a native row or column needs before its share counts.
const MIN_LINE_VOTES: u32 = 8;
/// Native pixels sampled along each axis by `observe_native`: every one, as the edges are wanted to the pixel and the
/// frames with a second translation are few.
const NATIVE_SAMPLE: usize = 1;

/// Per-cell votes of one moving region, keyed by cell of the region's canvas, and per native row and column of the
/// canvas, for the footprint's edges.
#[derive(Default)]
pub struct Nested {
    cells: HashMap<(i64, i64), Votes>,
    /// Per cell, the frames (counted by `observe` calls) in which the second translation won it.
    won: HashMap<(i64, i64), Vec<u32>>,
    frame: u32,
    rows: Profile,
    columns: Profile,
}

impl Nested {
    pub fn new() -> Nested {
        Nested::default()
    }

    /// Adds one frame. `previous`/`current` are `width × height` analysis grays, `step` the region's step and `other`
    /// the frame's second translation (both as in [`second_translation`]), `pose` the region's pose in analysis pixels
    /// (canvas = screen + pose), `rect` the region's analysis rectangle `[x0, x1) × [y0, y1)` and `inside` its
    /// membership of an analysis pixel. Returns whether the second translation won a block of cells this frame.
    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &mut self,
        previous: &[u8],
        current: &[u8],
        width: usize,
        height: usize,
        step: (f64, f64),
        other: (f64, f64),
        pose: (f64, f64),
        rect: (i64, i64, i64, i64),
        inside: impl Fn(i64, i64) -> bool,
    ) -> bool {
        self.frame += 1;
        let (w, h) = (width as i64, height as i64);
        if !overlaps(step, width, height) || !overlaps(other, width, height) {
            return false;
        }
        let (sx, sy) = (step.0.round() as i64, step.1.round() as i64);
        let (ox, oy) = (other.0.round() as i64, other.1.round() as i64);
        let (px, py) = (pose.0.round() as i64, pose.1.round() as i64);
        let (rx0, ry0, rx1, ry1) = rect;
        let at = |x: i64, y: i64| -> Option<i32> {
            (x >= 0 && y >= 0 && x < w && y < h).then(|| previous[(y * w + x) as usize] as i32)
        };
        let mut verdicts: HashMap<(i64, i64), bool> = HashMap::new();
        let mut by = ry0;
        while by < ry1 {
            let mut bx = rx0;
            while bx < rx1 {
                let (mut won, mut lost, mut telling) = (0u32, 0u32, 0u32);
                for y in (by..(by + CELL).min(ry1)).step_by(SAMPLE as usize) {
                    for x in (bx..(bx + CELL).min(rx1)).step_by(SAMPLE as usize) {
                        if x < 0 || y < 0 || x >= w || y >= h || !inside(x, y) {
                            continue;
                        }
                        let (Some(a), Some(b)) = (at(x + sx, y + sy), at(x + ox, y + oy)) else {
                            continue;
                        };
                        let c = current[(y * w + x) as usize] as i32;
                        let (region, second) = ((a - c).abs(), (b - c).abs());
                        if region > MARGIN || second > MARGIN {
                            telling += 1;
                        }
                        // A vote needs one explanation to fit (within `MARGIN`) and the other not: content that
                        // changes into something unrelated fits neither.
                        if second <= MARGIN && second + MARGIN < region {
                            won += 1;
                        } else if region <= MARGIN && region + MARGIN < second {
                            lost += 1;
                        }
                    }
                }
                // Most of the samples that tell the two apart must agree: unrelated content fits neither.
                if won.max(lost) >= MIN_VOTES && 2 * won.max(lost) > telling && won != lost {
                    verdicts.insert((bx, by), won > lost);
                }
                bx += CELL;
            }
            by += CELL;
        }
        // A container moves as one block: the second translation's cells this frame count only in a connected block
        // of at least `FRAME_CELLS` that fills at least half its bounding box. A repeated layout (a list of identical
        // rows) lets the second translation win scattered cells where a row looks like the next one.
        let mut block: HashMap<(i64, i64), bool> = HashMap::new();
        let mut keys: Vec<(i64, i64)> = verdicts
            .iter()
            .filter(|(_, &w)| w)
            .map(|(k, _)| *k)
            .collect();
        keys.sort_unstable();
        let mut seen: HashMap<(i64, i64), bool> = HashMap::new();
        for &start in &keys {
            if seen.contains_key(&start) {
                continue;
            }
            seen.insert(start, true);
            let (mut stack, mut members) = (vec![start], Vec::new());
            while let Some(k) = stack.pop() {
                members.push(k);
                for n in [
                    (k.0 - CELL, k.1),
                    (k.0 + CELL, k.1),
                    (k.0, k.1 - CELL),
                    (k.0, k.1 + CELL),
                ] {
                    if verdicts.get(&n) == Some(&true) && !seen.contains_key(&n) {
                        seen.insert(n, true);
                        stack.push(n);
                    }
                }
            }
            let (x0, x1) = (
                members.iter().map(|k| k.0).min().unwrap(),
                members.iter().map(|k| k.0).max().unwrap(),
            );
            let (y0, y1) = (
                members.iter().map(|k| k.1).min().unwrap(),
                members.iter().map(|k| k.1).max().unwrap(),
            );
            let area = ((x1 - x0) / CELL + 1) * ((y1 - y0) / CELL + 1);
            // A container cannot move further between frames than it reaches along that direction and still show
            // its own content moved inside itself: a band of a list that shows the row a period further down (pub_1,
            // own_d, own_e, own_h: 41-156 analysis pixels, bands one to six cells tall) is a repetition, not a
            // container. The block must reach a cell beyond the second translation's step from the region's.
            let reaches = x1 + CELL - x0 >= (ox - sx).abs() + CELL
                && y1 + CELL - y0 >= (oy - sy).abs() + CELL;
            let solid = members.len() >= FRAME_CELLS && 2 * members.len() as i64 >= area && reaches;
            for k in members {
                block.insert(k, solid);
            }
        }
        let mut any = false;
        for (&(bx, by), &won) in &verdicts {
            if won && !block[&(bx, by)] {
                continue;
            }
            any |= won;
            // The cell of the region's canvas holding this screen cell's centre.
            let key = (
                (bx + CELL / 2 + px).div_euclid(CELL),
                (by + CELL / 2 + py).div_euclid(CELL),
            );
            let v = self.cells.entry(key).or_default();
            if won {
                v.other = v.other.saturating_add(1);
                self.won.entry(key).or_default().push(self.frame);
                // Within two cells of the region's edge counts as reaching it: the last cells can be blank. On the
                // side where the container's content enters, the band one step wide shows nothing the previous frame
                // had, so it takes no votes at all (pane-majority: 16 px a frame at the screen's bottom edge).
                let reach = |entering: i64| 2 * CELL + entering.max(0);
                v.open |= (bx < rx0 + reach(-ox)) as u8
                    | ((bx + reach(ox) >= rx1) as u8) << 1
                    | ((by < ry0 + reach(-oy)) as u8) << 2
                    | ((by + reach(oy) >= ry1) as u8) << 3;
            } else {
                v.region = v.region.saturating_add(1);
            }
        }
        any
    }

    /// Adds one frame's native votes to the row and column profiles: `previous`/`current` RGBA frames `width ×
    /// height`, `step`/`other` and `pose` in native pixels, `rect` the region's native rectangle and `inside` its
    /// membership of a native pixel. Only the frames with a second translation come here.
    #[allow(clippy::too_many_arguments)]
    pub fn observe_native(
        &mut self,
        previous: &[u8],
        current: &[u8],
        width: usize,
        height: usize,
        step: (f64, f64),
        other: (f64, f64),
        pose: (f64, f64),
        rect: (i64, i64, i64, i64),
        inside: impl Fn(i64, i64) -> bool,
    ) {
        let (w, h) = (width as i64, height as i64);
        if !overlaps(step, width, height) || !overlaps(other, width, height) {
            return;
        }
        let luma = |frame: &[u8], x: i64, y: i64| -> Option<i32> {
            (x >= 0 && y >= 0 && x < w && y < h).then(|| {
                let i = ((y * w + x) * 4) as usize;
                (frame[i] as i32 * 299 + frame[i + 1] as i32 * 587 + frame[i + 2] as i32 * 114)
                    / 1000
            })
        };
        let (sx, sy) = (step.0.round() as i64, step.1.round() as i64);
        let (ox, oy) = (other.0.round() as i64, other.1.round() as i64);
        let (px, py) = (pose.0.round() as i64, pose.1.round() as i64);
        let (rx0, ry0, rx1, ry1) = (rect.0.max(0), rect.1.max(0), rect.2.min(w), rect.3.min(h));
        for y in (ry0..ry1).step_by(NATIVE_SAMPLE) {
            for x in (rx0..rx1).step_by(NATIVE_SAMPLE) {
                if !inside(x, y) {
                    continue;
                }
                let (Some(c), Some(a), Some(b)) = (
                    luma(current, x, y),
                    luma(previous, x + sx, y + sy),
                    luma(previous, x + ox, y + oy),
                ) else {
                    continue;
                };
                let (region, second) = ((a - c).abs(), (b - c).abs());
                let won = second <= MARGIN && second + MARGIN < region;
                let lost = region <= MARGIN && region + MARGIN < second;
                if won || lost {
                    self.rows.add(y + py, won);
                    self.columns.add(x + px, won);
                }
                // Where the content came from is inside the container too: at the edge where new content enters,
                // the lines show nothing the previous frame had, but the lines it moved out of did.
                if won && (ox, oy) != (0, 0) {
                    if oy != 0 {
                        self.rows.add(y + oy + py, true);
                    }
                    if ox != 0 {
                        self.columns.add(x + ox + px, true);
                    }
                }
            }
        }
    }

    /// The footprint's edges in native canvas pixels, moved from the cell grid onto the native row or column where the
    /// share of votes the second translation won falls under halfway between its level inside and outside, walking out
    /// from inside (lines without votes, at the edge where the container's new content enters, count as inside);
    /// `None` on an open side (the container may continue past what the region showed) or where the profile does not
    /// tell.
    pub fn edges(&self, fp: &Footprint, factor: i64) -> [Option<i64>; 4] {
        let cell = CELL * factor;
        let (x0, y0, x1, y1) = (
            fp.x0 * factor,
            fp.y0 * factor,
            fp.x1 * factor,
            fp.y1 * factor,
        );
        let level = |p: &Profile, from: i64, to: i64| -> Option<f64> {
            let mut v: Vec<f64> = (from..to).filter_map(|a| p.share(a)).collect();
            if v.len() < 3 {
                return None;
            }
            v.sort_by(f64::total_cmp);
            Some(v[v.len() / 2])
        };
        // `inward` is the direction from outside to inside across the edge.
        let edge = |p: &Profile, coarse: i64, inward: i64, depth: i64| -> Option<i64> {
            let inner = level(
                p,
                coarse + inward * cell / 2,
                coarse + inward * depth.min(4 * cell),
            )
            .or_else(|| {
                level(
                    p,
                    coarse + inward * depth.min(4 * cell),
                    coarse + inward * cell / 2,
                )
            });
            let (a, b) = (coarse - inward * 4 * cell, coarse - inward * cell);
            let outer = level(p, a.min(b), a.max(b));
            let (inner, outer) = (inner?, outer?);
            if inner - outer < 0.2 {
                return None;
            }
            let half = (inner + outer) / 2.0;
            // From inside outward, through lines that are over halfway or have no votes (content entering at the
            // container's leading edge matches nothing in the previous frame), up to the first line under halfway.
            // The walk starts a whole cell inside: the coarse edge is the last cell's, up to a cell past the line
            // (nested-scroll-box: cells to 1064, the box's last row 1057, its border 1059).
            let mut at = coarse + inward * cell;
            for _ in 0..3 * cell {
                let next = at - inward;
                if p.share(next).is_some_and(|s| s < half) {
                    return Some(if inward > 0 { at } else { at + 1 });
                }
                at = next;
            }
            None
        };
        let open = |bit: u8| fp.open & bit != 0;
        [
            (!open(1))
                .then(|| edge(&self.columns, x0, 1, x1 - x0))
                .flatten(),
            (!open(4))
                .then(|| edge(&self.rows, y0, 1, y1 - y0))
                .flatten(),
            (!open(2))
                .then(|| edge(&self.columns, x1, -1, x1 - x0))
                .flatten(),
            (!open(8))
                .then(|| edge(&self.rows, y1, -1, y1 - y0))
                .flatten(),
        ]
    }

    /// The containers found: connected cells (4-neighbourhood) that took the second translation in at least
    /// `OTHER_FRAMES` frames and `OTHER_SHARE` of their votes, at least `MIN_CELLS` of them, largest first.
    pub fn footprints(&self) -> Vec<Footprint> {
        let qualifies = |v: &Votes| {
            v.other >= OTHER_FRAMES && v.other as f64 >= OTHER_SHARE * (v.other + v.region) as f64
        };
        let mut keys: Vec<(i64, i64)> = self
            .cells
            .iter()
            .filter(|(_, v)| qualifies(v))
            .map(|(k, _)| *k)
            .collect();
        keys.sort_unstable();
        let mut seen: HashMap<(i64, i64), bool> = keys.iter().map(|k| (*k, false)).collect();
        // Connected pieces: members, cell box [x0, y0, x1, y1], and the frames their cells were won in.
        struct Piece {
            members: Vec<(i64, i64)>,
            cells: [i64; 4],
            frames: Vec<u32>,
        }
        let mut pieces: Vec<Piece> = Vec::new();
        for &start in &keys {
            if seen[&start] {
                continue;
            }
            seen.insert(start, true);
            let (mut stack, mut members) = (vec![start], Vec::new());
            while let Some(k) = stack.pop() {
                members.push(k);
                for n in [
                    (k.0 - 1, k.1),
                    (k.0 + 1, k.1),
                    (k.0, k.1 - 1),
                    (k.0, k.1 + 1),
                ] {
                    if seen.get(&n) == Some(&false) {
                        seen.insert(n, true);
                        stack.push(n);
                    }
                }
            }
            members.sort_unstable();
            let cells = [
                members.iter().map(|k| k.0).min().unwrap(),
                members.iter().map(|k| k.1).min().unwrap(),
                members.iter().map(|k| k.0).max().unwrap() + 1,
                members.iter().map(|k| k.1).max().unwrap() + 1,
            ];
            let mut frames: Vec<u32> = members
                .iter()
                .flat_map(|k| self.won.get(k).into_iter().flatten().copied())
                .collect();
            frames.sort_unstable();
            frames.dedup();
            pieces.push(Piece {
                members,
                cells,
                frames,
            });
        }
        // Pieces of one container: in a frame every cell the second translation won moved by that one translation,
        // so pieces won in a common frame moved together. They are one container when nothing between them took
        // the region's step instead (a blank stripe across a box takes no votes; the page between two boxes does).
        let took_step = |v: &Votes| v.region >= OTHER_FRAMES && v.region > v.other;
        loop {
            let mut joined = false;
            'pairs: for i in 0..pieces.len() {
                for j in i + 1..pieces.len() {
                    let (a, b) = (&pieces[i], &pieces[j]);
                    if !a.frames.iter().any(|f| b.frames.binary_search(f).is_ok()) {
                        continue;
                    }
                    let u = [
                        a.cells[0].min(b.cells[0]),
                        a.cells[1].min(b.cells[1]),
                        a.cells[2].max(b.cells[2]),
                        a.cells[3].max(b.cells[3]),
                    ];
                    // The gap between the two boxes, where they face each other; boxes that do not face each other
                    // along either axis are not joined.
                    let (cols, rows) = (
                        a.cells[0].max(b.cells[0])..a.cells[2].min(b.cells[2]),
                        a.cells[1].max(b.cells[1])..a.cells[3].min(b.cells[3]),
                    );
                    let gap = if !cols.is_empty() && !rows.is_empty() {
                        Vec::new()
                    } else if !cols.is_empty() {
                        let gap_rows = a.cells[3].min(b.cells[3])..a.cells[1].max(b.cells[1]);
                        gap_rows
                            .flat_map(|y| cols.clone().map(move |x| (x, y)))
                            .collect()
                    } else if !rows.is_empty() {
                        let gap_cols = a.cells[2].min(b.cells[2])..a.cells[0].max(b.cells[0]);
                        rows.clone()
                            .flat_map(|y| gap_cols.clone().map(move |x| (x, y)))
                            .collect()
                    } else {
                        continue;
                    };
                    if gap.iter().any(|k| self.cells.get(k).is_some_and(took_step)) {
                        continue;
                    }
                    let b = pieces.remove(j);
                    let a = &mut pieces[i];
                    a.members.extend(b.members);
                    a.cells = u;
                    a.frames.extend(b.frames);
                    a.frames.sort_unstable();
                    a.frames.dedup();
                    joined = true;
                    break 'pairs;
                }
            }
            if !joined {
                break;
            }
        }
        let mut out: Vec<(usize, Footprint)> = pieces
            .into_iter()
            .filter(|p| p.members.len() >= MIN_CELLS)
            .map(|Piece { members, cells, .. }| {
                let v = |k: &(i64, i64)| self.cells[k];
                (
                    members.len(),
                    Footprint {
                        x0: cells[0] * CELL,
                        y0: cells[1] * CELL,
                        x1: cells[2] * CELL,
                        y1: cells[3] * CELL,
                        open: members.iter().fold(0, |o, k| o | v(k).open),
                        frames: members.iter().map(|k| v(k).other).max().unwrap(),
                    },
                )
            })
            .collect();
        out.sort_by(|a, b| b.0.cmp(&a.0));
        out.into_iter().map(|(_, f)| f).collect()
    }
}

/// Cell side, in native pixels, of the coverage [`Moments`] counts.
const MOMENT_CELL: f64 = 32.0;

/// The states a nested container's own scroll went through, for the one its parent's print shows: each state is one
/// own scroll on one of the container's canvases, with the frames it was seen in and what of the footprint they
/// showed.
#[derive(Default)]
pub struct Moments {
    states: Vec<Moment>,
    /// The frames in which its own scroll changed, and the state of the frame before.
    moved: u32,
    last: Option<(String, (i64, i64))>,
}

struct Moment {
    canvas: String,
    scroll: (i64, i64),
    frames: Vec<(u32, Rect)>,
    /// [`MOMENT_CELL`] cells of the parent's canvas the frames showed whole.
    cells: HashSet<(i64, i64)>,
}

impl Moments {
    /// Frame `frame` showed the container on `canvas` at own scroll `scroll` (its pose less its parent's, whole
    /// pixels) inside `clip`, its screen rectangle; `parent` is the parent's pose then.
    pub fn add(
        &mut self,
        canvas: &str,
        scroll: (i64, i64),
        frame: u32,
        clip: Rect,
        parent: (f64, f64),
    ) {
        if self
            .last
            .as_ref()
            .is_some_and(|(c, s)| c == canvas && *s != scroll)
        {
            self.moved += 1;
        }
        self.last = Some((canvas.to_string(), scroll));
        let at = match self
            .states
            .iter()
            .position(|m| m.canvas == canvas && m.scroll == scroll)
        {
            Some(at) => at,
            None => {
                self.states.push(Moment {
                    canvas: canvas.to_string(),
                    scroll,
                    frames: Vec::new(),
                    cells: HashSet::new(),
                });
                self.states.len() - 1
            }
        };
        let m = &mut self.states[at];
        m.frames.push((frame, clip));
        let (x0, y0) = (clip.x + parent.0, clip.y + parent.1);
        let span =
            |a: f64, b: f64| (a / MOMENT_CELL).ceil() as i64..(b / MOMENT_CELL).floor() as i64;
        for cy in span(y0, y0 + clip.height) {
            for cx in span(x0, x0 + clip.width) {
                m.cells.insert((cx, cy));
            }
        }
    }

    /// The frames in which the container's own scroll changed from the frame before it was seen in.
    pub fn moved(&self) -> u32 {
        self.moved
    }

    /// Whether the container scrolled by itself: it was seen in two states of its own scroll on one canvas.
    pub fn scrolled(&self) -> bool {
        self.states
            .iter()
            .enumerate()
            .any(|(i, a)| self.states[i + 1..].iter().any(|b| b.canvas == a.canvas))
    }

    /// The frames of the state the parent's print shows, with their clips: one state, so the print holds the
    /// container as it was at one moment. The order follows the reveal pass's for a dynamic component's moment
    /// (docs/ARCHITECTURE.md §七): a state that showed everything any state showed first, then one seen in more than
    /// one frame (corroborated), then the one that showed more, then the later.
    pub fn choose(&self) -> Vec<(u32, Rect)> {
        let all: HashSet<&(i64, i64)> = self.states.iter().flat_map(|m| &m.cells).collect();
        let rank = |m: &Moment| {
            let last = m.frames.iter().map(|f| f.0).max().unwrap_or(0);
            (
                m.cells.len() == all.len(),
                m.frames.len() > 1,
                m.cells.len(),
                last,
            )
        };
        self.states
            .iter()
            .max_by_key(|m| rank(m))
            .map(|m| m.frames.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 160;
    const H: usize = 120;

    fn texture(x: i64, y: i64, seed: u64) -> u8 {
        let v = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) as u64 ^ seed;
        (v.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
    }

    /// A page scrolled by `page` rows with a box at screen rows/cols given in page coordinates (40..120, 60..100)
    /// whose own content is scrolled by `own` rows.
    fn frame(page: i64, own: i64) -> Vec<u8> {
        boxed(page, own, (40, 60, 120, 100), false)
    }

    /// `frame` with the box at `b` (x0, y0, x1, y1 in page coordinates); with `border`, as on nested-scroll-box, the
    /// eight page rows under it are flat but for a dark line one row below the box.
    fn boxed(page: i64, own: i64, b: (i64, i64, i64, i64), border: bool) -> Vec<u8> {
        let mut out = vec![0u8; W * H];
        for y in 0..H as i64 {
            for x in 0..W as i64 {
                let (wx, wy) = (x, y + page);
                let inside = (b.0..b.2).contains(&wx) && (b.1..b.3).contains(&wy);
                let under =
                    border && (b.0 - 4..b.2 + 4).contains(&wx) && (b.3..b.3 + 8).contains(&wy);
                out[(y * W as i64 + x) as usize] = if inside {
                    texture(wx, wy + own, 7)
                } else if under {
                    if wy == b.3 + 1 {
                        20
                    } else {
                        200
                    }
                } else {
                    texture(wx, wy, 1)
                };
            }
        }
        out
    }

    /// The page scrolls 3 rows a frame, stands at 30 while the box scrolls `speed` rows a frame, then moves on; every
    /// frame is observed as the solve pass does.
    fn scrolled(frames: impl Fn(i64, i64) -> Vec<u8>, speed: i64) -> Nested {
        let rect = (0, 0, W as i64, H as i64);
        let mut n = Nested::new();
        let (mut page, mut own) = (0, 0);
        for t in 1..40i64 {
            let (p0, o0) = (page, own);
            if t <= 10 || t > 30 {
                page += 3;
            } else {
                own += speed;
            }
            let (a, b) = (frames(p0, o0), frames(page, own));
            let step = (0.0, (page - p0) as f64);
            let other = if own != o0 {
                (0.0, (own - o0) as f64)
            } else {
                (0.0, 20.0)
            };
            let pose = (0.0, page as f64);
            n.observe(&a, &b, W, H, step, other, pose, rect, |_, _| true);
            if own == o0 {
                continue;
            }
            let rgba = |g: &[u8]| g.iter().flat_map(|&v| [v, v, v, 255]).collect::<Vec<u8>>();
            n.observe_native(
                &rgba(&a),
                &rgba(&b),
                W,
                H,
                step,
                other,
                pose,
                rect,
                |_, _| true,
            );
        }
        n
    }

    // Failure cases for the edges, from nested-scroll-box: the border line under a box that scrolls toward it stands
    // still and must stop the walk; a box that reaches the region's bottom and scrolls more than two cells a frame
    // shows its last rows nothing from the previous frame, so they take no votes, and it is still open there. (The
    // coarse cells running most of a cell past the box's last row is the scenario's case: these frames do not
    // reproduce it.)
    #[test]
    fn a_bordered_box_ends_at_its_border_and_a_fast_one_at_the_region_edge_stays_open() {
        let bordered = scrolled(|page, own| boxed(page, own, (40, 60, 120, 98), true), 5);
        let found = bordered.footprints();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(bordered.edges(&found[0], 1)[3], Some(98), "{:?}", found[0]);
        // Standing at 30, the page shows rows 30..150: a box from 60 down past 150 reaches the screen's bottom.
        let tall = scrolled(|page, own| boxed(page, own, (40, 60, 120, 400), false), 20);
        let found = tall.footprints();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].open & 8, 8, "{:?}", found[0]);
    }

    fn matches(step: (f64, f64), n: usize) -> Vec<MatchPoints> {
        (0..n)
            .map(|i| MatchPoints {
                ax: i as f64 + step.0,
                ay: i as f64 + step.1,
                bx: i as f64,
                by: i as f64,
                unique: true,
            })
            .collect()
    }

    // Failure cases for the second translation: every match agreeing with the step; a handful of stray pairs; misses
    // that stand still on screen (a floating bar over a moving page is `screen_fixed`'s, not a container).
    #[test]
    fn a_second_translation_needs_enough_matches_that_move() {
        let page = matches((0.0, 12.0), 40);
        assert_eq!(second_translation(&page, (0.0, 12.0)), None);
        let mut few = page.clone();
        few.extend(matches((0.0, -20.0), 5));
        assert_eq!(second_translation(&few, (0.0, 12.0)), None);
        let mut still = page.clone();
        still.extend(matches((0.0, 0.0), 20));
        assert_eq!(second_translation(&still, (0.0, 12.0)), None);
        let mut boxed = page;
        boxed.extend(matches((0.0, 21.0), 12));
        assert_eq!(second_translation(&boxed, (0.0, 12.0)), Some((0.0, 21.0)));
    }

    // Failure cases for the footprint: a box the page carries without it scrolling (no footprint); the box's
    // footprint drifting with the page in the canvas (it must stay where the box sits on the page); a widget whose
    // content jumps about instead of scrolling (its votes spread too thin); the edge flags.
    #[test]
    fn a_box_that_scrolls_by_itself_has_a_footprint_where_it_sits_on_the_page() {
        let rect = (0, 0, W as i64, H as i64);
        let carried = {
            let mut n = Nested::new();
            for t in 1..20i64 {
                let (a, b) = (frame((t - 1) * 3, 0), frame(t * 3, 0));
                n.observe(
                    &a,
                    &b,
                    W,
                    H,
                    (0.0, 3.0),
                    (0.0, 9.0),
                    (0.0, (t * 3) as f64),
                    rect,
                    |_, _| true,
                );
            }
            n.footprints()
        };
        assert!(carried.is_empty(), "{carried:?}");
        let mut n = Nested::new();
        // The page scrolls 3 rows a frame, then stands at 30 while the box scrolls 5 rows a frame, then moves on.
        let mut page = 0;
        let mut own = 0;
        for t in 1..40i64 {
            let (p0, o0) = (page, own);
            if t <= 10 || t > 30 {
                page += 3;
            } else {
                own += 5;
            }
            let (a, b) = (frame(p0, o0), frame(page, own));
            let step = (0.0, (page - p0) as f64);
            let other = if own != o0 {
                (0.0, (own - o0) as f64)
            } else {
                (0.0, 20.0)
            };
            n.observe(
                &a,
                &b,
                W,
                H,
                step,
                other,
                (0.0, page as f64),
                rect,
                |_, _| true,
            );
            let rgba = |g: &[u8]| g.iter().flat_map(|&v| [v, v, v, 255]).collect::<Vec<u8>>();
            // Only the frames with a second translation reach the profiles, as in the solve pass.
            if own == o0 {
                continue;
            }
            n.observe_native(
                &rgba(&a),
                &rgba(&b),
                W,
                H,
                step,
                other,
                (0.0, page as f64),
                rect,
                |_, _| true,
            );
        }
        let found = n.footprints();
        assert_eq!(
            n.edges(&found[0], 1),
            [Some(40), Some(60), Some(120), Some(100)],
            "{:?}",
            found[0]
        );
        assert_eq!(found.len(), 1, "{found:?}");
        let f = found[0];
        assert!(
            f.x0 <= 48 && f.x1 >= 112 && f.y0 <= 68 && f.y1 >= 92,
            "{f:?}"
        );
        assert!(
            f.x0 >= 32 && f.x1 <= 128 && f.y0 >= 52 && f.y1 <= 108,
            "{f:?}"
        );
        assert_eq!(f.open, 0);
        assert!(f.frames >= 15);
        // A widget whose content changes to unrelated texture every frame takes no translation.
        let mut jumpy = Nested::new();
        for t in 1..40u64 {
            let a: Vec<u8> = (0..W * H).map(|i| texture(i as i64, 0, t)).collect();
            let b: Vec<u8> = (0..W * H).map(|i| texture(i as i64, 0, t + 100)).collect();
            jumpy.observe(
                &a,
                &b,
                W,
                H,
                (0.0, 0.0),
                (0.0, 7.0),
                (0.0, 0.0),
                rect,
                |_, _| true,
            );
        }
        assert!(jumpy.footprints().is_empty());
    }

    fn clip(y: f64, height: f64) -> Rect {
        Rect {
            x: 0.0,
            y,
            width: 128.0,
            height,
        }
    }

    // Failure cases for the moment a parent's print shows: one complete frame against a complete state seen twice
    // (the second is corroborated); a complete state against an incomplete one seen in more frames; two complete,
    // corroborated states (the later); the same scroll on another canvas (a fragment: not the same state); nothing
    // complete (corroborated, then the most shown); no state at all.
    #[test]
    fn a_parent_shows_its_container_complete_corroborated_and_late() {
        let still = (0.0, 0.0);
        let mut m = Moments::default();
        m.add("c", (0, 0), 1, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 2, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 3, clip(0.0, 128.0), still);
        assert_eq!(
            m.choose(),
            vec![(2, clip(0.0, 128.0)), (3, clip(0.0, 128.0))]
        );
        let mut m = Moments::default();
        m.add("c", (0, 0), 1, clip(0.0, 128.0), still);
        for f in 2..6 {
            m.add("c", (0, 40), f, clip(64.0, 64.0), still);
        }
        assert_eq!(m.choose(), vec![(1, clip(0.0, 128.0))]);
        let mut m = Moments::default();
        m.add("c", (0, 0), 1, clip(0.0, 128.0), still);
        m.add("c", (0, 0), 2, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 7, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 8, clip(0.0, 128.0), still);
        assert_eq!(
            m.choose(),
            vec![(7, clip(0.0, 128.0)), (8, clip(0.0, 128.0))]
        );
        let mut m = Moments::default();
        m.add("c", (0, 0), 1, clip(0.0, 128.0), still);
        m.add("d", (0, 0), 2, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 3, clip(0.0, 128.0), still);
        m.add("c", (0, 40), 4, clip(0.0, 128.0), still);
        assert_eq!(
            m.choose(),
            vec![(3, clip(0.0, 128.0)), (4, clip(0.0, 128.0))]
        );
        // The parent moves the container: the frames show different parts of the footprint, and no state all of it.
        let mut m = Moments::default();
        m.add("c", (0, 0), 1, clip(0.0, 64.0), (0.0, 0.0));
        m.add("c", (0, 0), 2, clip(0.0, 64.0), (0.0, 32.0));
        m.add("c", (0, 40), 3, clip(0.0, 96.0), (0.0, 0.0));
        m.add("c", (0, 80), 4, clip(0.0, 64.0), (0.0, 64.0));
        m.add("c", (0, 80), 5, clip(0.0, 64.0), (0.0, 64.0));
        m.add("c", (0, 120), 6, clip(0.0, 32.0), (0.0, 96.0));
        m.add("c", (0, 120), 7, clip(0.0, 32.0), (0.0, 64.0));
        assert_eq!(m.choose(), vec![(1, clip(0.0, 64.0)), (2, clip(0.0, 64.0))]);
        assert!(Moments::default().choose().is_empty());
    }

    // Failure case from five real recordings (pub_1, own_d, own_e, own_h: a list whose rows look alike): a band one
    // or two cells tall takes "the second translation" because it shows a row the next one down showed a frame
    // before, 58 or 41 analysis pixels away, more than the band is tall. A container cannot move further between
    // frames than it reaches along that direction and still show the same content inside itself; this band is no
    // container.
    #[test]
    fn a_band_showing_a_row_from_further_than_it_is_tall_is_no_container() {
        let rect = (0, 0, W as i64, H as i64);
        let band = 60..76i64;
        let frame = |t: i64| -> Vec<u8> {
            let mut out = vec![0u8; W * H];
            for y in 0..H as i64 {
                for x in 0..W as i64 {
                    out[(y * W as i64 + x) as usize] = if band.contains(&y) {
                        if t % 2 == 1 {
                            texture(x, y + 40, 1)
                        } else {
                            texture(x, y, 100 + t as u64)
                        }
                    } else {
                        texture(x, y, 1)
                    };
                }
            }
            out
        };
        let mut n = Nested::new();
        for t in 1..21i64 {
            let (a, b) = (frame(t - 1), frame(t));
            n.observe(
                &a,
                &b,
                W,
                H,
                (0.0, 0.0),
                (0.0, 40.0),
                (0.0, 0.0),
                rect,
                |_, _| true,
            );
        }
        assert!(n.footprints().is_empty(), "{:?}", n.footprints());
    }

    // Failure cases for a container the evidence splits (own_a once the bands above went: the chat column came out as
    // two footprints, one above the other, from blocks that won in the same frames): a box with a blank stripe across
    // its middle takes votes above and below the stripe only, and is one container; two boxes side by side that
    // scroll in different frames are two.
    #[test]
    fn pieces_of_one_container_join_and_two_containers_stay_apart() {
        let rect = (0, 0, W as i64, H as i64);
        // Page standing; box columns 20..140, rows 20..100, its own content scrolled by `own`, blank rows 52..68.
        let striped = |own: i64| -> Vec<u8> {
            let mut out = vec![0u8; W * H];
            for y in 0..H as i64 {
                for x in 0..W as i64 {
                    out[(y * W as i64 + x) as usize] =
                        if (20..140).contains(&x) && (20..100).contains(&y) {
                            if (52..68).contains(&y) {
                                128
                            } else {
                                texture(x, y + own, 7)
                            }
                        } else {
                            texture(x, y, 1)
                        };
                }
            }
            out
        };
        let mut one = Nested::new();
        for t in 1..12i64 {
            let (a, b) = (striped((t - 1) * 4), striped(t * 4));
            one.observe(
                &a,
                &b,
                W,
                H,
                (0.0, 0.0),
                (0.0, 4.0),
                (0.0, 0.0),
                rect,
                |_, _| true,
            );
        }
        let found = one.footprints();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].y0 <= 24 && found[0].y1 >= 96, "{:?}", found[0]);
        // Two boxes, columns 8..72 and 88..152, rows 20..100: the left scrolls in frames 1-8, the right in 9-16.
        let pair = |left: i64, right: i64| -> Vec<u8> {
            let mut out = vec![0u8; W * H];
            for y in 0..H as i64 {
                for x in 0..W as i64 {
                    out[(y * W as i64 + x) as usize] =
                        if (20..100).contains(&y) && (8..72).contains(&x) {
                            texture(x, y + left, 7)
                        } else if (20..100).contains(&y) && (88..152).contains(&x) {
                            texture(x, y + right, 9)
                        } else {
                            texture(x, y, 1)
                        };
                }
            }
            out
        };
        let mut two = Nested::new();
        let (mut left, mut right) = (0, 0);
        for t in 1..17i64 {
            let (l0, r0) = (left, right);
            if t <= 8 {
                left += 4
            } else {
                right += 4
            }
            let (a, b) = (pair(l0, r0), pair(left, right));
            two.observe(
                &a,
                &b,
                W,
                H,
                (0.0, 0.0),
                (0.0, 4.0),
                (0.0, 0.0),
                rect,
                |_, _| true,
            );
        }
        let found = two.footprints();
        assert_eq!(found.len(), 2, "{found:?}");
    }
}
