//! Stage: band detection (stationary top/bottom/left/right edges) + texture test, and the strongest-cut index
//! used to split analysis cells at a persistent global divider.

use super::{stat_at, Rgba};
use crate::kernels::chrome::{stationary_boundary, Axis, Choose};
use crate::kernels::geometry::{js_ceil, js_floor, js_round};

// ---------------------------------------------------------------------------------------------------------------
// Stage: band detection (stationary top/bottom/left/right edges) + texture test.
// ---------------------------------------------------------------------------------------------------------------
pub struct Bands {
    pub top: i64,
    pub bottom: i64,
    pub left: i64,
    pub right: i64,
    pub exact_left: Option<f64>,
    pub exact_right: Option<f64>,
}

/// Mean of the middle rows of the reference frame, sampled every 3rd row, per analysis column (`middleMean` in
/// the TS oracle); only built when a native reference frame is available.
fn middle_mean(width: i64, top: i64, bottom: i64, factor: f64, reference: &Rgba) -> Vec<f64> {
    let mut out = vec![0.0; width.max(0) as usize];
    for x in 0..width {
        let (mut sum, mut count): (f64, f64) = (0.0, 0.0);
        let mut y = top + 2;
        while y < bottom - 2 {
            let iy = js_floor(y as f64 * factor)
                .min(reference.height as i32 - 1)
                .max(0) as usize;
            let ix = js_floor(x as f64 * factor)
                .min(reference.width as i32 - 1)
                .max(0) as usize;
            let i = (iy * reference.width + ix) * 4;
            sum += (reference.data[i] as f64
                + reference.data[i + 1] as f64
                + reference.data[i + 2] as f64)
                / 3.0;
            count += 1.0;
            y += 3;
        }
        out[x as usize] = sum / count.max(1.0);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn textured(
    from: i64,
    to: i64,
    informative_frames: f64,
    reference: Option<&Rgba>,
    middle_mean: &[f64],
    col_mean: &[f64],
    top: i64,
    bottom: i64,
    factor: f64,
) -> bool {
    if to - from < 6 || informative_frames == 0.0 {
        return false;
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for x in from..to {
        let mean = if reference.is_some() {
            middle_mean[x as usize]
        } else {
            col_mean[x as usize] / informative_frames
        };
        lo = lo.min(mean);
        hi = hi.max(mean);
    }
    if reference.is_none() {
        return hi - lo > 6.0;
    }
    let img = reference.unwrap();
    let (sx, sy) = (factor, factor);
    let (mut structure, mut samples) = (0u32, 0u32);
    let mut y = top + 3;
    while y < bottom - 3 {
        let mut x = from + 1;
        while x < to - 1 {
            let nx = js_floor(x as f64 * sx) as i64;
            let ny = js_floor(y as f64 * sy) as i64;
            let step = js_round(sy).max(1) as i64;
            let i = (ny * img.width as i64 + nx) * 4;
            let a = i - step * img.width as i64 * 4;
            let b = i + step * img.width as i64 * 4;
            if a >= 0 && (b as usize) < img.data.len() {
                if (img.data[a as usize] as i32 - img.data[b as usize] as i32).abs() > 12 {
                    structure += 1;
                }
                samples += 1;
            }
            x += 2;
        }
        y += 2;
    }
    structure >= 8 && structure as f64 / (samples.max(1) as f64) > 0.003
}

/// Share of informative frames a column may move in and still count as stationary for the left/right bands. The
/// bands read how often a column moved, not its mean change: macOS's elastic overscroll moves the whole window, fixed
/// sidebar included, for a few frames at a page's end, and in g.mov those 20 of 479 frames lifted the sidebar's mean
/// change over 0.7 while it moved in under 0.05 of them. Every other recording's bands are the same under both.
const STATIONARY_COLUMN_SHARE: f64 = 0.25;

/// How many times as often standing still must beat the main motion at a row's sampled pixels for the row to count
/// as fixed chrome on a side the change test left without a band. Page content scrolling under a glass bar sits
/// near 1 : 14 (new_ip_3's middle rows) and at worst about 1 : 2 on any recording; the bars' own rows are 1.5 : 1
/// and up.
pub(super) const STATIONARY_VOTE_RATIO: f64 = 1.5;
/// Share of a row's sampled pixels (every 4th column) that must vote for standing still per informative frame,
/// so a row with almost no structure cannot pass on a handful of votes.
pub(super) const STATIONARY_VOTE_SHARE: f64 = 0.03;

/// Share of a row's sampled pixels at which standing still must win, per informative frame, on at least one row
/// of a band found by the votes. Bars hold icons and text: the densest row of each such band on the recordings is
/// at 0.41–0.62. A fade over the page bottom holds none, yet the motion hypothesis fails there too, because the fade
/// dims each row of the page differently as it scrolls through: own_f's 29-row fade under ChatGPT's input box peaks
/// at 0.087 and stays page content.
pub(super) const STATIONARY_STRUCTURE_SHARE: f64 = 0.2;

/// Share of the informative frames in which standing still must explain a sampled pixel (and `STATIONARY_VOTE_RATIO`
/// times as often as the main motion) for the pixel to count as part of a fixed object (`fixed_pixels`). Over the
/// middle 40 % of the screen, where only the page scrolls, no sampled pixel of any iPhone recording reaches even 0.2;
/// the result on the recordings is the same anywhere in 0.2–0.3.
const FIXED_PIXEL_SHARE: f64 = 0.25;
/// Sampled pixels (every 4th analysis column) of a fixed object a row must hold to carry a vote band on: about one
/// icon's width, not a stray pixel. The objects in the lower half of new_ip_2's and new_ip_3's bars give their rows
/// 4–10; the scroll-to-bottom button floating above new_ip_3's input bar 2–5, and some rows of the page under
/// pub_7's bar 2–4. With 3, pub_7's band walks 160 px into the page.
const FIXED_ROW_SAMPLES: usize = 5;
/// Native pixels of rows without such an object a vote band's extension may cross: the spacing between the rows of
/// one bar's objects. Across 40 px, pub_7's band reaches a few rows of its page that pass the count above and walks
/// 150 px into it; across 30 px, new_ip_3's input bar reaches the button floating above it (with 4 samples a row).
const FIXED_ROW_GAP: f64 = 20.0;
/// Native pixels the objects must add to a vote band before it takes them. The row votes already end a band where
/// its rows stop standing still; a glass bar's soft edge (its shadow or halo) spans a few rows more, where its
/// blur stands still but the page shows through sharply, and moving the band onto those rows only puts one moment
/// of the page into the fixed layer, a sliver of half a text line next to the scrolling page. The objects this is
/// for are buttons, avatars and name capsules, at least an icon tall (20 pt, 60 px at 3×): new_ip_2's and
/// new_ip_3's add 195 and 325 px, the soft edges under the status bars of new_ip_9 and pub_6 and above new_ip_3's
/// input bar 10–35 px.
const FIXED_ROW_RUN: f64 = 60.0;

/// Widest run of moving columns, in analysis columns and as a share of the width, that a side band's walk may cross
/// when they never follow the page: a scrollbar's thumb and track. The thumbs on the recordings are 3–5 columns
/// (0.5–0.9 % of the width).
const THUMB_COLUMNS: i64 = 6;
const THUMB_WIDTH_SHARE: f64 = 0.015;
/// Votes for the page's motion per sampled pixel and informative frame under which a column never follows the page.
/// new_mac_4's thumb columns: 0.0001 and 0; the columns a walk stops at beside pages that follow the page (pub_1's
/// "stars today" notes under the thumb) 0.017.
const THUMB_FOLLOW_SHARE: f64 = 0.002;
/// How many times as often standing still must win as the page's motion, in the crossed columns and in what stands
/// still beyond them, per sampled pixel: new_mac_4's thumb 650× and up, its minimap 700×; beyond the thumbs where no
/// fixed panel stands, a blank margin with a resting pointer (own_c) 3.8×, the page's sparse notes (pub_1) 3.5×, an
/// empty strip by a page's edge (own_g) 5.8×.
const THUMB_VOTE_RATIO: f64 = 10.0;
/// Share of the columns beyond a thumb that must each stand still as often as `STATIONARY_VOTE_SHARE`: a panel stands
/// still across its width (new_mac_4's minimap: 38 of its 44 columns), while a button floating on a blank margin
/// fills a few of the margin's columns however often it votes.
const THUMB_PANEL_SHARE: f64 = 2.0 / 3.0;

/// Votes per sampled pixel and informative frame, standing still and following the page, over the band rows
/// `[top, bottom)` of the sampled column standing for analysis column `x` (`Learner::add` samples every 4th column,
/// from 2, and not the last two). `None` where no column there is sampled: no evidence either way.
#[allow(clippy::too_many_arguments)]
fn column_votes(
    votes: (&[f64], &[f64]),
    x: i64,
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    frames: f64,
) -> Option<(f64, f64)> {
    let s = (x / 4) * 4 + 2;
    let (y0, y1) = (top.max(2), bottom.min(height - 2));
    if s >= width - 2 || y1 <= y0 {
        return None;
    }
    let (fixed, moving) = votes;
    let (mut f, mut m) = (0.0, 0.0);
    for y in y0..y1 {
        f += fixed[(y * width + s) as usize];
        m += moving[(y * width + s) as usize];
    }
    let n = (y1 - y0) as f64 * frames;
    Some((f / n, m / n))
}

/// Where a side band's walk stopped at a scrollbar's thumb: the edge of what stands still beyond it and the thumb's
/// inner edge (the panel lies between them), or `None`. From
/// `edge`, the walk's stop, the columns going inwards (`step` −1 on the right, +1 on the left) must start with a run
/// of `THUMB_COLUMNS` at most that move but never follow the page (`column_votes`: standing still wins
/// `STATIONARY_VOTE_SHARE` per pixel and frame, `THUMB_VOTE_RATIO` times as often as following, which stays under
/// `THUMB_FOLLOW_SHARE`); past it the walk goes on over stationary columns to `inner`. What it crosses there must be
/// a panel standing still: at least 6 columns (a band's minimum, the thumb not counted), its mean votes standing
/// still as a glass bar's rows do and `THUMB_VOTE_RATIO` times as often as following, in `THUMB_PANEL_SHARE` of its
/// columns each, and textured on its own (the thumb's ends give a blank margin vertical structure).
#[allow(clippy::too_many_arguments)]
fn past_thumb(
    edge: i64,
    step: i64,
    within: impl Fn(i64) -> bool,
    moved: impl Fn(i64) -> bool,
    votes: (&[f64], &[f64]),
    width: i64,
    height: i64,
    top: i64,
    bottom: i64,
    frames: f64,
    texture: impl Fn(i64, i64) -> bool,
) -> Option<(i64, i64)> {
    // The column a step inwards from a boundary `b`: `b - 1` on the right, `b` on the left.
    let col = |b: i64| if step < 0 { b - 1 } else { b };
    let never_follows = |x: i64| {
        column_votes(votes, x, width, height, top, bottom, frames).is_some_and(|(f, m)| {
            f >= STATIONARY_VOTE_SHARE && m <= THUMB_FOLLOW_SHARE && f >= THUMB_VOTE_RATIO * m
        })
    };
    let limit = THUMB_COLUMNS.min(js_floor(width as f64 * THUMB_WIDTH_SHARE) as i64);
    let mut k = edge;
    while within(k) && moved(col(k)) && never_follows(col(k)) && (k - edge).abs() < limit {
        k += step;
    }
    if k == edge || !within(k) || moved(col(k)) {
        return None;
    }
    let mut inner = k;
    while within(inner) && !moved(col(inner)) {
        inner += step;
    }
    let (from, to) = if step < 0 { (inner, k) } else { (k, inner) };
    if !within(inner) || to - from < 6 {
        return None;
    }
    let (mut f, mut m, mut n, mut standing) = (0.0, 0.0, 0.0, 0.0);
    for x in from..to {
        if let Some((cf, cm)) = column_votes(votes, x, width, height, top, bottom, frames) {
            f += cf;
            m += cm;
            n += 1.0;
            if cf >= STATIONARY_VOTE_SHARE {
                standing += 1.0;
            }
        }
    }
    if n == 0.0
        || f / n < STATIONARY_VOTE_SHARE
        || f < THUMB_VOTE_RATIO * m
        || standing < THUMB_PANEL_SHARE * n
        || !texture(from, to)
    {
        return None;
    }
    Some((inner, k))
}

/// Sampled pixels of row `y` that a fixed object holds: standing still explained them in `FIXED_PIXEL_SHARE` of the
/// informative frames and `STATIONARY_VOTE_RATIO` times as often as the main motion did. Unlike the row votes, the
/// page showing through around the object does not dilute them.
fn fixed_pixels(votes: (&[f64], &[f64]), y: i64, width: i64, height: i64, frames: f64) -> usize {
    let row = y.clamp(2, height - 3) * width;
    let (fixed, moving) = votes;
    let mut count = 0;
    let mut x = 2;
    while x < width - 2 {
        let f = stat_at(fixed, row + x);
        if f / frames >= FIXED_PIXEL_SHARE && f >= STATIONARY_VOTE_RATIO * stat_at(moving, row + x)
        {
            count += 1;
        }
        x += 4;
    }
    count
}

/// The last row of the bar a band found by the row votes belongs to, once the fixed objects beside its edge are
/// counted in. From `edge` (the first row past the band) the walk goes `step` rows at a time while `within` holds; a
/// row with `FIXED_ROW_SAMPLES` fixed pixels is part of the bar, and `FIXED_ROW_GAP` native px of rows without end
/// it. `None` when the rows up to the last such row span less than `FIXED_ROW_RUN`, or when the walk ran up to the
/// cap without such an end: then it has not found the end of a bar but something standing still down the screen (a
/// sidebar beside the page). Either way the band stays as the votes found it.
#[allow(clippy::too_many_arguments)]
fn last_row_of_fixed_objects(
    votes: (&[f64], &[f64]),
    edge: i64,
    step: i64,
    within: impl Fn(i64) -> bool,
    width: i64,
    height: i64,
    frames: f64,
    factor: f64,
) -> Option<i64> {
    let gap_rows = js_ceil(FIXED_ROW_GAP / factor) as i64;
    let (mut last, mut gap, mut y) = (None, 0, edge);
    while within(y) {
        if fixed_pixels(votes, y, width, height, frames) >= FIXED_ROW_SAMPLES {
            last = Some(y);
            gap = 0;
        } else {
            gap += 1;
            if gap > gap_rows {
                let run_rows = js_ceil(FIXED_ROW_RUN / factor) as i64;
                return last.filter(|&l| (l - edge) * step + 1 >= run_rows);
            }
        }
        y += step;
    }
    None
}

/// The row-vote test above.
fn stationary_by_votes(
    fixed: &[f64],
    moving: &[f64],
    y: i64,
    width: i64,
    height: i64,
    informative_frames: f64,
) -> bool {
    if height < 5 || width < 5 {
        return false;
    }
    let f = vote_share(fixed, y, width, height, informative_frames);
    let m = vote_share(moving, y, width, height, informative_frames);
    f >= STATIONARY_VOTE_SHARE && f >= STATIONARY_VOTE_RATIO * m
}

/// Votes per informative frame over the row's sampled pixels. `Learner::add` samples rows 2..height-2 only, so the
/// edge rows read their nearest sampled row.
fn vote_share(votes: &[f64], y: i64, width: i64, height: i64, informative_frames: f64) -> f64 {
    let row = y.clamp(2, height - 3);
    let samples = ((width - 4 + 3) / 4) as f64;
    stat_at(votes, row) / informative_frames / samples
}

/// Whether some row of `[from, to)` holds the dense standing-still structure of a bar (`STATIONARY_STRUCTURE_SHARE`).
fn holds_structure(
    fixed: &[f64],
    from: i64,
    to: i64,
    width: i64,
    height: i64,
    frames: f64,
) -> bool {
    (from..to).any(|y| vote_share(fixed, y, width, height, frames) >= STATIONARY_STRUCTURE_SHARE)
}

#[allow(clippy::too_many_arguments)]
pub fn detect_bands(
    width: i64,
    height: i64,
    informative_frames: f64,
    row_change: &[f64],
    row_votes: Option<(&[f64], &[f64])>,
    pixel_votes: (&[f64], &[f64]),
    col_moving: &[f64],
    col_mean: &[f64],
    reference: Option<&Rgba>,
    native_width: f64,
    native_height: f64,
    factor: f64,
) -> Bands {
    let (mut top, mut bottom) = (0i64, height);
    if informative_frames >= 2.0 {
        while (top as f64) < height as f64 * 0.45
            && stat_at(row_change, top) / informative_frames < 0.9
        {
            top += 1;
        }
        while bottom as f64 > height as f64 * 0.55
            && stat_at(row_change, bottom - 1) / informative_frames < 0.9
        {
            bottom -= 1;
        }
        if top < 6 || top as f64 >= height as f64 * 0.45 {
            top = 0;
        }
        if height - bottom < 6 || bottom as f64 <= height as f64 * 0.55 {
            bottom = height;
        }
        // Translucent chrome (iOS 26 glass bars, frosted headers) shows the scrolling page through itself, so
        // none of its rows passes the change test and that side gets no band at all. Only on such a side, a row
        // also counts as stationary when its fixed icons and text are evident: at its sampled pixels standing
        // still beats the main motion `STATIONARY_VOTE_RATIO` times as often as the reverse. The band must also
        // hold one row of dense standing-still structure, as a side band must be textured. The lower part of such a
        // bar lets the page through ever more clearly, and its rows then vote for the motion while the bar's buttons
        // and labels still float there, so the band then goes on over the rows those objects hold
        // (`last_row_of_fixed_objects`).
        if let Some((fixed, moving)) = row_votes {
            let still = |y: i64| {
                stat_at(row_change, y) / informative_frames < 0.9
                    || stationary_by_votes(fixed, moving, y, width, height, informative_frames)
            };
            if top == 0 {
                while (top as f64) < height as f64 * 0.45 && still(top) {
                    top += 1;
                }
                if top < 6
                    || top as f64 >= height as f64 * 0.45
                    || !holds_structure(fixed, 0, top, width, height, informative_frames)
                {
                    top = 0;
                } else if let Some(last) = last_row_of_fixed_objects(
                    pixel_votes,
                    top,
                    1,
                    |y| (y as f64) < height as f64 * 0.45,
                    width,
                    height,
                    informative_frames,
                    factor,
                ) {
                    top = last + 1;
                }
            }
            if bottom == height {
                while bottom as f64 > height as f64 * 0.55 && still(bottom - 1) {
                    bottom -= 1;
                }
                if height - bottom < 6
                    || bottom as f64 <= height as f64 * 0.55
                    || !holds_structure(fixed, bottom, height, width, height, informative_frames)
                {
                    bottom = height;
                } else if let Some(last) = last_row_of_fixed_objects(
                    pixel_votes,
                    bottom - 1,
                    -1,
                    |y| y as f64 > height as f64 * 0.55,
                    width,
                    height,
                    informative_frames,
                    factor,
                ) {
                    bottom = last;
                }
            }
        }
    }
    let mm = if let Some(img) = reference {
        middle_mean(width, top, bottom, factor, img)
    } else {
        Vec::new()
    };
    let (mut left, mut right) = (0i64, width);
    let (mut exact_left, mut exact_right) = (None, None);
    // The inner edges of scrollbar thumbs the walks crossed: a panel's own edge is looked for between the walk's stop
    // and a column short of the thumb, not at the thumb: the track's border runs the full height and is the strongest
    // edge there (new_mac_4: x 3178, the thumb from 3180), while a minimap shares the editor's background and may show
    // none, so the band then starts where the walk stopped.
    let (mut thumb_left, mut thumb_right) = (None, None);
    if informative_frames >= 2.0 {
        while (left as f64) < width as f64 * 0.45
            && stat_at(col_moving, left) / informative_frames < STATIONARY_COLUMN_SHARE
        {
            left += 1;
        }
        while right as f64 > width as f64 * 0.55
            && stat_at(col_moving, right - 1) / informative_frames < STATIONARY_COLUMN_SHARE
        {
            right -= 1;
        }
        // A scrollbar's thumb at the window's edge moves whenever the page does, so the walk stops at it although it
        // never follows the page; a fixed panel standing still beyond it (new_mac_4's minimap) then stayed in the
        // moving layer. With the votes at hand, the walk crosses such a thumb when what it reaches beyond is a panel
        // standing still (`past_thumb`); the thumb then belongs to the band.
        if row_votes.is_some() {
            let moved =
                |x: i64| stat_at(col_moving, x) / informative_frames >= STATIONARY_COLUMN_SHARE;
            let texture = |from: i64, to: i64| {
                textured(
                    from,
                    to,
                    informative_frames,
                    reference,
                    &mm,
                    col_mean,
                    top,
                    bottom,
                    factor,
                )
            };
            if (left as f64) < width as f64 * 0.45 {
                if let Some(inner) = past_thumb(
                    left,
                    1,
                    |b| (b as f64) < width as f64 * 0.45,
                    moved,
                    pixel_votes,
                    width,
                    height,
                    top,
                    bottom,
                    informative_frames,
                    texture,
                ) {
                    (left, thumb_left) = (inner.0, Some(inner.1));
                }
            }
            if right as f64 > width as f64 * 0.55 {
                if let Some(inner) = past_thumb(
                    right,
                    -1,
                    |b| b as f64 > width as f64 * 0.55,
                    moved,
                    pixel_votes,
                    width,
                    height,
                    top,
                    bottom,
                    informative_frames,
                    texture,
                ) {
                    (right, thumb_right) = (inner.0, Some(inner.1));
                }
            }
        }
        if let Some(img) = reference {
            let scale = factor;
            let cross_from = native_height.min((top as f64 * factor).ceil());
            let cross_to = native_height.min((bottom as f64 * factor).floor());
            // A walk that reached the 45% cap may have crossed an empty margin beside the sidebar, which stands just
            // as still (test_2: the chat's dark margin ran it to x 1584); the sidebar's own edge is still looked
            // for before the cap, and the texture test below still decides whether what it bounds is a sidebar.
            exact_left = if left > 0 {
                stationary_boundary(
                    img.data,
                    img.width,
                    img.height,
                    Axis::X,
                    thumb_left.map_or(0.0, |k| ((k + 1) as f64 * scale).floor()),
                    (left as f64 * scale).ceil(),
                    cross_from,
                    cross_to,
                    Choose::Last,
                )
            } else {
                None
            };
            exact_right = if right < width {
                stationary_boundary(
                    img.data,
                    img.width,
                    img.height,
                    Axis::X,
                    (right as f64 * scale).floor(),
                    thumb_right.map_or(native_width, |k| ((k - 1) as f64 * scale).ceil()),
                    cross_from,
                    cross_to,
                    Choose::First,
                )
            } else {
                None
            };
            if let Some(v) = exact_left {
                left = js_floor(v / scale) as i64;
            }
            if let Some(v) = exact_right {
                right = js_ceil(v / scale) as i64;
            }
        }
        if left < 6
            || (left as f64) >= width as f64 * 0.45
            || !textured(
                0,
                left,
                informative_frames,
                reference,
                &mm,
                col_mean,
                top,
                bottom,
                factor,
            )
        {
            left = 0;
            exact_left = None;
        }
        if width - right < 6
            || (right as f64) <= width as f64 * 0.55
            || !textured(
                right,
                width,
                informative_frames,
                reference,
                &mm,
                col_mean,
                top,
                bottom,
                factor,
            )
        {
            right = width;
            exact_right = None;
        }
    }
    Bands {
        top,
        bottom,
        left,
        right,
        exact_left,
        exact_right,
    }
}

/// Column/row index of the strongest binary split (`strongestCut`): the index maximising a two-sided coverage
/// gain, accepted only with ≥ 4 informative frames and > 12% of them agreeing.
pub fn strongest_cut(g: &[f64], informative_frames: f64) -> i64 {
    let mut best = 0i64;
    let hi = g.len() as i64 - 2;
    let mut k = 2i64;
    while k < hi {
        if g[k as usize] > g[best as usize] {
            best = k;
        }
        k += 1;
    }
    if informative_frames >= 4.0
        && g.get(best as usize).copied().unwrap_or(0.0) / informative_frames > 0.12
    {
        best
    } else {
        0
    }
}
