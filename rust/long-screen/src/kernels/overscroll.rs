//! Elastic overscroll (docs/ARCHITECTURE.md §十 "合成与瞬态像素"): where a canvas's page ends, read from how its
//! placements move, and how much of one frame past that end is the background the browser shows there.
//!
//! At a page edge macOS, iOS and photo viewers let the content run past the edge and spring back. Tracking follows
//! the content, so those frames' poses pass the edge and the strip of the frame beyond it shows the window's
//! background, not the page. [`page_edges`] finds each edge from the trajectory alone; [`background_lines`] counts how
//! many lines of one frame, from the region's outer side inward, hold nothing that belongs to the page.

use std::collections::BTreeMap;

/// One side of a region, in the order [`Edges::overshoot`] reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Bottom,
    Left,
    Right,
}

pub const SIDES: [Side; 4] = [Side::Top, Side::Bottom, Side::Left, Side::Right];

/// One painted placement of a canvas: its frame and the pose the compositor paints at (rounded).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pose {
    pub frame: u32,
    pub x: i64,
    pub y: i64,
}

/// The page's edges as pose limits: a placement whose pose passes one shows background past that side.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Edges {
    /// Smallest y, largest y, smallest x, largest x a placement can take without leaving the page.
    pub top: Option<i64>,
    pub bottom: Option<i64>,
    pub left: Option<i64>,
    pub right: Option<i64>,
}

impl Edges {
    /// How far a placement at `(x, y)` runs past each side ([`SIDES`] order), 0 where it does not.
    pub fn overshoot(&self, x: i64, y: i64) -> [i64; 4] {
        let past = |edge: Option<i64>, outward: i64| edge.map_or(0, |e| (outward - e).max(0));
        [
            past(self.top.map(|e| -e), -y),
            past(self.bottom, y),
            past(self.left.map(|e| -e), -x),
            past(self.right, x),
        ]
    }

    pub fn is_empty(&self) -> bool {
        *self == Edges::default()
    }
}

/// Frames further apart than this are not one motion (another fragment, frames the plan left out).
const GAP: u32 = 3;
/// A spring comes to rest in small steps: the last [`TAIL`] moves back toward the page are at most this many pixels.
const CONVERGE: i64 = 5;
const TAIL: usize = 3;
/// A return comes back from at least this far past where it ends.
const MIN_DEPTH: i64 = 2;
/// No rubber band runs further past the edge than a quarter of the region's extent along that axis.
const CAP_NUM: i64 = 1;
const CAP_DEN: i64 = 4;
/// Pose values this close together are one place.
const NEAR: i64 = 3;
/// Frames the page rests at a place, counted over [`NEAR`], before that place counts as somewhere it stays.
const HEAVY_REST: u32 = 8;

/// The page's edges of one canvas from its placements in frame order. `width` and `height` are the region's size.
///
/// Each side is read on its own, as an outward coordinate `u` (−y for the top, y for the bottom, −x for the left,
/// x for the right):
/// 1. A *return* is a run of frames past some value `r`, entered from the page side, that comes back to `r` in
///    small, settling steps (the last [`TAIL`] moves back are at most [`CONVERGE`] px) and stops there or turns
///    out again; it reached at least [`MIN_DEPTH`] and at most a quarter of the extent past `r`. It is *settled* when the
///    page then stays at `r` for two more frames.
/// 2. The edge is near the outermost group of settled returns that holds at least a quarter as many returns as the
///    largest group (returns within [`NEAR`] px are a group). Without settled returns it is near the outermost group
///    of returns; if the page never stayed there ([`HEAVY_REST`] frames), the spring was left before it settled,
///    and the edge is the outermost place on the page side, within the cap, where the page did stay.
/// 3. Of the values around that group, the edge is the one the page rested at most often (the outer one on a tie):
///    a held drag rests past the edge for a moment, the page rests at the edge for much longer.
/// 4. A frame further past the edge than the cap means the page goes on past it, so that side has no edge.
/// 5. A page that came to a complete stop (both axes) past the edge [`HEAVY_REST`] times more often than at it
///    stayed there the way it stays anywhere on the page: a spring only rests at the edge, and a finger holding a
///    drag past it is the moment rule 3 sets against the page's rest at the edge. That side has no edge; the turn
///    was an ordinary reversal at the far end of what the recording saw. Measured: the demo recording's bowed pans
///    turn 20 px inside the top and 24 px inside the right side of the page, ease in like springs and hold there for
///    5–7 frames while the other axis keeps moving 20–30 px a frame, and the whiteboard margin passes
///    [`background_lines`]; the page stood still 9 frames at the true top and 13 at the true right side and never at
///    the turns. Real springs settle with the page still moving sideways too (test_1 at 18–120 px a frame, test_4
///    at 12–18), so the other axis's motion cannot tell them apart; what the real ones never do is stand still past
///    the edge for longer than at it.
pub fn page_edges(track: &[Pose], width: i64, height: i64) -> Edges {
    let along = |f: &dyn Fn(&Pose) -> i64| -> Vec<(u32, i64)> {
        track.iter().map(|p| (p.frame, f(p))).collect()
    };
    // The places, as each side's outward coordinate, where the page stood completely still for a frame.
    let still: Vec<&Pose> = track
        .windows(2)
        .filter(|w| joined(w[0].frame, w[1].frame) && (w[0].x, w[0].y) == (w[1].x, w[1].y))
        .map(|w| &w[1])
        .collect();
    let stops = |f: &dyn Fn(&Pose) -> i64| -> Vec<i64> { still.iter().map(|p| f(p)).collect() };
    let side = |u: &dyn Fn(&Pose) -> i64, extent: i64| {
        edge(&along(u), extent).filter(|&e| !stays_past(&stops(u), e))
    };
    Edges {
        top: side(&|p| -p.y, height).map(|e| -e),
        bottom: side(&|p| p.y, height),
        left: side(&|p| -p.x, width).map(|e| -e),
        right: side(&|p| p.x, width),
    }
}

/// Rule 5 of [`page_edges`]: the page stood still past `edge` (more than [`NEAR`] out) [`HEAVY_REST`] times more
/// often than at it (within [`NEAR`]). `stops` are the outward coordinates of the frames it stood still at.
fn stays_past(stops: &[i64], edge: i64) -> bool {
    let at = stops.iter().filter(|&&u| (u - edge).abs() <= NEAR).count() as u32;
    let past = stops.iter().filter(|&&u| u > edge + NEAR).count() as u32;
    past >= at + HEAVY_REST
}

/// One return: where it ended and whether the page stayed there.
struct Return {
    end: i64,
    settled: bool,
}

/// Whether frames `a` and `b` (in order) are consecutive enough to be one motion.
fn joined(a: u32, b: u32) -> bool {
    b.saturating_sub(a) <= GAP
}

fn returns(seq: &[(u32, i64)], extent: i64) -> Vec<Return> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..seq.len() {
        if i > 0 && !joined(seq[i - 1].0, seq[i].0) {
            start = i;
        }
        if i == start {
            continue;
        }
        let u = seq[i].1;
        // Arrived moving back toward the page, and does not keep going.
        if seq[i - 1].1 <= u {
            continue;
        }
        let next = seq.get(i + 1).filter(|n| joined(seq[i].0, n.0));
        if next.is_some_and(|n| n.1 < u) {
            continue;
        }
        // The run past `u` that ends here must have been entered from the page side.
        let mut j = i - 1;
        while seq[j].1 > u && j > start {
            j -= 1;
        }
        if seq[j].1 > u {
            continue;
        }
        let mut tail = 0;
        let mut k = i;
        while k > j + 1 && tail < TAIL {
            let step = seq[k - 1].1 - seq[k].1;
            if !(0..=CONVERGE).contains(&step) {
                break;
            }
            if step > 0 {
                tail += 1;
            }
            k -= 1;
        }
        if tail < TAIL {
            continue;
        }
        let depth = seq[j + 1..i].iter().map(|s| s.1).max().unwrap_or(u) - u;
        if depth < MIN_DEPTH || depth * CAP_DEN > extent * CAP_NUM {
            continue;
        }
        let stays = |k: usize| {
            seq.get(k)
                .is_some_and(|s| s.1 == u && joined(seq[k - 1].0, s.0))
        };
        out.push(Return {
            end: u,
            settled: stays(i + 1) && stays(i + 2),
        });
    }
    out
}

/// The outermost group of values (within [`NEAR`] of each other) holding at least a quarter of the largest group,
/// as its innermost and outermost value.
fn outermost_group(mut values: Vec<i64>) -> Option<(i64, i64)> {
    values.sort_unstable();
    let mut groups: Vec<(i64, i64, usize)> = Vec::new();
    for v in values {
        match groups.last_mut() {
            Some(g) if v - g.1 <= NEAR => {
                g.1 = v;
                g.2 += 1;
            }
            _ => groups.push((v, v, 1)),
        }
    }
    let largest = groups.iter().map(|g| g.2).max()?;
    let need = largest.div_ceil(4);
    groups
        .iter()
        .rev()
        .find(|g| g.2 >= need)
        .map(|g| (g.0, g.1))
}

fn edge(seq: &[(u32, i64)], extent: i64) -> Option<i64> {
    let found = returns(seq, extent);
    let mut rests: BTreeMap<i64, u32> = BTreeMap::new();
    for w in seq.windows(2) {
        if joined(w[0].0, w[1].0) && w[0].1 == w[1].1 {
            *rests.entry(w[1].1).or_default() += 1;
        }
    }
    let mass = |lo: i64, hi: i64| rests.range(lo..=hi).map(|(_, &n)| n).sum::<u32>();
    let settled: Vec<i64> = found.iter().filter(|r| r.settled).map(|r| r.end).collect();
    let (mut lo, mut hi) = if settled.is_empty() {
        outermost_group(found.iter().map(|r| r.end).collect())?
    } else {
        outermost_group(settled.clone())?
    };
    if settled.is_empty() && mass(lo - NEAR, hi + NEAR) < HEAVY_REST {
        let reach = extent * CAP_NUM / CAP_DEN;
        let stayed = rests
            .range(lo - reach..lo)
            .rev()
            .map(|(&v, _)| v)
            .find(|&v| mass(v - NEAR, v + NEAR) >= HEAVY_REST);
        if let Some(v) = stayed {
            (lo, hi) = (v, v);
        }
    }
    let edge = rests
        .range(lo - NEAR..=hi + NEAR)
        .max_by_key(|(&v, &n)| (n, v))
        .map_or(lo, |(&v, _)| v);
    let beyond = seq.iter().map(|s| s.1 - edge).max().unwrap_or(0);
    (beyond * CAP_DEN <= extent * CAP_NUM).then_some(edge)
}

/// One frame of a region and what [`background_lines`] compares it with.
pub struct Lines<'a> {
    /// The frame, RGBA, `width × height`.
    pub rgba: &'a [u8],
    pub width: usize,
    pub height: usize,
    /// The atlas label plane and the region's code; `None` for a rectangular region (every pixel of the rect is its).
    pub labels: Option<(&'a [u8], u8)>,
    /// The region's rect on screen in whole pixels: x, y, width, height.
    pub region: (i64, i64, i64, i64),
    /// The neighbouring frames whose placement differs from this frame's: a pixel equal to one of them at the same
    /// screen position stays put on screen while the page moves.
    pub neighbours: [Option<&'a [u8]>; 2],
    /// The source's per-channel decode noise.
    pub noise: f64,
}

/// Share of a line, out of 20, that must be background for the line to be: 19 (95 %), so a pointer tip or a
/// scrollbar thumb's edge does not stop the count.
const LINE_SHARE: usize = 19;

/// The most lines in a row that may hold something pinned to the screen over the band and still be counted: a
/// scrollbar along the viewport's edge, not a panel or a button.
pub const PINNED_RUN: usize = 32;

/// What one line of the strip shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Line {
    Background,
    /// Background apart from something that stays put on screen while the page moves.
    Pinned,
    Content,
}

/// How many lines of `side`, from the region's outer side inward and at most `max`, show only background: each line
/// one colour, apart from a few stray pixels (a pointer tip, a scrollbar thumb's edge).
///
/// A line that is one colour only once the pixels pinned to the screen are left aside (equal to a neighbouring
/// frame at the same screen position although the page moved) is counted when at most [`PINNED_RUN`] such lines
/// come in a row and background follows them: a scrollbar along the viewport's edge (test_5's
/// bottom). A longer run stops the count like page content does, and so does a run the strip ends in: a pinned
/// panel is not told apart from the page. Counting every pinned line removed test_3's sign-in pill above the page
/// top, but it also took test_2's sidebar promo, which sits in the moving layer, out of the bounce frames at the
/// page end, and the promo's clean copy there gave way to a torn one.
pub fn background_lines(input: &Lines, side: Side, max: usize) -> usize {
    let (w, h) = (input.width as i64, input.height as i64);
    let x0 = input.region.0.clamp(0, w);
    let y0 = input.region.1.clamp(0, h);
    let x1 = (input.region.0 + input.region.2).clamp(x0, w);
    let y1 = (input.region.1 + input.region.3).clamp(y0, h);
    let count = match side {
        Side::Top | Side::Bottom => y1 - y0,
        Side::Left | Side::Right => x1 - x0,
    } as usize;
    let mut pixels: Vec<usize> = Vec::new();
    let (mut counted, mut pinned) = (0, 0);
    for line in 0..count.min(max) {
        let l = line as i64;
        pixels.clear();
        let mut push = |x: i64, y: i64| {
            let i = (y * w + x) as usize;
            if input.labels.is_none_or(|(labels, code)| labels[i] == code) {
                pixels.push(i);
            }
        };
        match side {
            Side::Top => (x0..x1).for_each(|x| push(x, y0 + l)),
            Side::Bottom => (x0..x1).for_each(|x| push(x, y1 - 1 - l)),
            Side::Left => (y0..y1).for_each(|y| push(x0 + l, y)),
            Side::Right => (y0..y1).for_each(|y| push(x1 - 1 - l, y)),
        }
        match classify(input, &pixels) {
            Line::Background => {
                counted = line + 1;
                pinned = 0;
            }
            Line::Pinned if pinned < PINNED_RUN => pinned += 1,
            _ => break,
        }
    }
    counted
}

/// What one line's pixels show: background when at least [`LINE_SHARE`]/20 of them are within the source's noise of
/// the line's median colour; pinned when that share is reached only with the pixels equal to a neighbouring frame at
/// the same screen position.
fn classify(input: &Lines, pixels: &[usize]) -> Line {
    if pixels.is_empty() {
        return Line::Background;
    }
    let rgba = input.rgba;
    let mut histogram = [[0u32; 256]; 3];
    for &i in pixels {
        for (c, h) in histogram.iter_mut().enumerate() {
            h[rgba[i * 4 + c] as usize] += 1;
        }
    }
    let half = pixels.len().div_ceil(2) as u32;
    let median = histogram.map(|h| {
        let mut seen = 0;
        h.iter()
            .position(|&n| {
                seen += n;
                seen >= half
            })
            .unwrap_or(0) as u8
    });
    // The mean per-channel difference is at most the source's noise.
    let limit = 3.0 * input.noise;
    let near = |a: &[u8], b: &[u8]| {
        let d: i32 = (0..3).map(|c| (a[c] as i32 - b[c] as i32).abs()).sum();
        d as f64 <= limit
    };
    let (mut plain, mut pinned) = (0, 0);
    for &i in pixels {
        let p = &rgba[i * 4..i * 4 + 3];
        if near(p, &median) {
            plain += 1;
        } else if input
            .neighbours
            .iter()
            .flatten()
            .any(|n| near(p, &n[i * 4..i * 4 + 3]))
        {
            pinned += 1;
        }
    }
    let enough = |n: usize| n * 20 >= pixels.len() * LINE_SHARE;
    if enough(plain) {
        Line::Background
    } else if enough(plain + pinned) {
        Line::Pinned
    } else {
        Line::Content
    }
}

#[cfg(test)]
mod tests;
