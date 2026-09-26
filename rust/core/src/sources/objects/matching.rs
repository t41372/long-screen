//! Native appearance and competing translation fits, shared by residual proposals and retained tracks.
use super::{Bounds, Track, View};
#[derive(Clone, Copy)]
pub(super) struct Point {
    pub(super) x: i32,
    pub(super) y: i32,
}
#[derive(Clone, Copy)]
pub(super) struct Fit {
    pub(super) dx: i32,
    pub(super) dy: i32,
    pub(super) inliers: usize,
    pub(super) error: u32,
}
pub(super) fn rgb_distance(a: &[u8], i: usize, b: &[u8], j: usize) -> u32 {
    (0..3)
        .map(|c| a[i * 4 + c].abs_diff(b[j * 4 + c]) as u32)
        .sum()
}
pub(super) fn pixel(view: View<'_>, x: i32, y: i32) -> Option<usize> {
    if x < 0 || y < 0 || x >= view.width as i32 || y >= view.height as i32 {
        return None;
    }
    Some(y as usize * view.width + x as usize)
}
pub(super) fn gradient(view: View<'_>, x: i32, y: i32) -> u32 {
    let (Some(l), Some(r), Some(t), Some(b)) = (
        pixel(view, x - 1, y),
        pixel(view, x + 1, y),
        pixel(view, x, y - 1),
        pixel(view, x, y + 1),
    ) else {
        return 0;
    };
    rgb_distance(view.rgba, l, view.rgba, r).max(rgb_distance(view.rgba, t, view.rgba, b))
}
pub(super) fn fit(a: View<'_>, b: View<'_>, points: &[Point], dx: i32, dy: i32, noise: u32) -> Fit {
    let mut out = Fit {
        dx,
        dy,
        inliers: 0,
        error: 0,
    };
    for p in points {
        let Some(j) = pixel(b, p.x + dx, p.y + dy) else {
            continue;
        };
        let i = p.y as usize * a.width + p.x as usize;
        let error = rgb_distance(a.rgba, i, b.rgba, j);
        if error <= noise * 3 {
            out.inliers += 1;
            out.error += error;
        }
    }
    out
}
fn better(a: Fit, b: Fit, page: (i32, i32)) -> bool {
    (
        a.inliers,
        std::cmp::Reverse(a.error),
        std::cmp::Reverse((a.dx - page.0).abs() + (a.dy - page.1).abs()),
    ) > (
        b.inliers,
        std::cmp::Reverse(b.error),
        std::cmp::Reverse((b.dx - page.0).abs() + (b.dy - page.1).abs()),
    )
}
pub(super) fn local_fit(
    current: View<'_>,
    previous: View<'_>,
    points: &[Point],
    bounds: Bounds,
    tracks: &[Track],
    noise: u32,
) -> Fit {
    let page = (
        current.pose.0 - previous.pose.0,
        current.pose.1 - previous.pose.1,
    );
    let mut best = fit(current, previous, points, page.0, page.1, noise);
    let zero = fit(current, previous, points, 0, 0, noise);
    if !points.is_empty() && zero.inliers == points.len() && best.inliers * 2 < points.len() {
        return zero;
    }
    let mut centres = vec![(0, 0), page];
    // Only nearby predicted tracks are plausible partners. Searching every track makes a noisy
    // frame quadratic in object count without adding useful correspondence evidence.
    let mut nearby: Vec<_> = tracks.iter().collect();
    nearby.sort_by_key(|t| t.bounds.distance(bounds));
    centres.extend(
        nearby
            .into_iter()
            .take(3)
            .map(|t| (t.bounds.x - bounds.x, t.bounds.y - bounds.y)),
    );
    centres.sort_unstable();
    centres.dedup();
    for (cx, cy) in centres {
        for dy in (-24..=24).step_by(4) {
            for dx in (-24..=24).step_by(4) {
                let candidate = fit(current, previous, points, cx + dx, cy + dy, noise);
                if better(candidate, best, page) {
                    best = candidate;
                }
            }
        }
    }
    let centre = (best.dx, best.dy);
    for dy in -3..=3 {
        for dx in -3..=3 {
            let candidate = fit(
                current,
                previous,
                points,
                centre.0 + dx,
                centre.1 + dy,
                noise,
            );
            if better(candidate, best, page) {
                best = candidate;
            }
        }
    }
    // Repeating glyphs can win a sparse-point vote at a false local offset. When zero motion is
    // a close rival, compare the complete native residual ROI once: the object's actual boundary
    // breaks that alias. Moving cursors whose zero-motion fit is poor do not pay for this scan.
    if (best.dx != 0 || best.dy != 0) && zero.inliers >= 8 && zero.inliers * 5 >= best.inliers * 4 {
        let agreement = |dx: i32, dy: i32| {
            let mut count = 0;
            for y in bounds.y..bounds.y + bounds.height {
                for x in bounds.x..bounds.x + bounds.width {
                    let i = y as usize * current.width + x as usize;
                    if current.labels[i] == current.code
                        && pixel(previous, x + dx, y + dy).is_some_and(|j| {
                            rgb_distance(current.rgba, i, previous.rgba, j) <= noise * 3
                        })
                    {
                        count += 1;
                    }
                }
            }
            count
        };
        if agreement(0, 0) > agreement(best.dx, best.dy) {
            best = zero;
        }
    }
    best
}

pub(super) fn track_template(
    current: View<'_>,
    anchors: &[(Point, [u8; 3])],
    velocity: (i32, i32),
    page: (i32, i32),
    noise: u32,
) -> Option<(i32, i32)> {
    let evaluate = |dx: i32, dy: i32| {
        anchors
            .iter()
            .filter(|&&(p, rgb)| {
                pixel(current, p.x + dx, p.y + dy).is_some_and(|i| {
                    (0..3)
                        .map(|c| current.rgba[i * 4 + c].abs_diff(rgb[c]) as u32)
                        .sum::<u32>()
                        <= noise * 3
                })
            })
            .count()
    };
    let mut best = (evaluate(velocity.0, velocity.1), velocity.0, velocity.1);
    let page_fit = evaluate(-page.0, -page.1);
    if page_fit > best.0 {
        best = (page_fit, -page.0, -page.1);
    }
    for dy in (-24..=24).step_by(4) {
        for dx in (-24..=24).step_by(4) {
            let at = (velocity.0 + dx, velocity.1 + dy);
            let n = evaluate(at.0, at.1);
            if n > best.0
                || n == best.0
                    && (at.0 - velocity.0).abs() + (at.1 - velocity.1).abs()
                        < (best.1 - velocity.0).abs() + (best.2 - velocity.1).abs()
            {
                best = (n, at.0, at.1);
            }
        }
    }
    let centre = (best.1, best.2);
    for dy in -3..=3 {
        for dx in -3..=3 {
            let at = (centre.0 + dx, centre.1 + dy);
            let n = evaluate(at.0, at.1);
            if n > best.0
                || n == best.0
                    && (at.0 - velocity.0).abs() + (at.1 - velocity.1).abs()
                        < (best.1 - velocity.0).abs() + (best.2 - velocity.1).abs()
            {
                best = (n, at.0, at.1);
            }
        }
    }
    if best.0 < 8 {
        return None;
    }
    // Require several persistent colours. Blank page pixels that happened to agree in the first
    // pair are not allowed to destroy an otherwise stable panel identity, nor keep it alive alone.
    let quant = (noise * 2 + 2).min(255) as u8;
    let mut groups = std::collections::BTreeMap::<[u8; 3], (usize, usize)>::new();
    for &(point, rgb) in anchors {
        let group = groups.entry(rgb.map(|c| c / quant)).or_default();
        group.0 += 1;
        if pixel(current, point.x + best.1, point.y + best.2).is_some_and(|i| {
            (0..3)
                .map(|c| current.rgba[i * 4 + c].abs_diff(rgb[c]) as u32)
                .sum::<u32>()
                <= noise * 3
        }) {
            group.1 += 1;
        }
    }
    let stable: Vec<_> = groups
        .values()
        .filter(|&&(total, matched)| matched * 10 >= total * 9)
        .collect();
    let repeated = stable.iter().filter(|&&(total, _)| *total >= 3).count();
    let matched: usize = stable.iter().map(|&&(_, matched)| matched).sum();
    let largest = stable
        .iter()
        .map(|&&(_, matched)| matched)
        .max()
        .unwrap_or(0);
    if (repeated < 2 && matched - largest < 8) || best.0 * 2 < anchors.len() {
        return None;
    }
    Some((best.1, best.2))
}
