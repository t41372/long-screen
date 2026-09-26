//! Remove a confirmed surrounding background from the mask of a narrow moving object. This only
//! weakens an occlusion claim; it never declares pixels clean or changes their observed colours.
use super::objects::{Bounds, MaskRun, View};

#[cfg(test)]
mod tests {
    use super::*;
    // Failure cases: a residual footprint includes connected page background; a flat overlay
    // separates its glyph from that background; agreement without a textured page witness is weak.
    #[test]
    fn page_background_reachability_requires_motion_seeds_and_respects_colour_boundaries() {
        let (w, h) = (64, 48);
        let mut rgba = [250, 249, 245, 255].repeat(w * h);
        for y in 8..40 {
            for x in 32..56 {
                rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[207, 103, 80, 255]);
            }
        }
        for y in 12..36 {
            rgba[(y * w + 12) * 4..(y * w + 12) * 4 + 4].copy_from_slice(&[40, 50, 60, 255]);
        }
        // A bright glyph enclosed by the fixed object is not connected page background.
        rgba[(24 * w + 44) * 4..(24 * w + 44) * 4 + 4].copy_from_slice(&[250, 249, 245, 255]);
        let labels = vec![1; w * h];
        let view = View {
            rgba: &rgba,
            labels: &labels,
            width: w,
            height: h,
            code: 1,
            pose: (0, 0),
        };
        let mut visible = vec![0; w * h];
        for y in 12..36 {
            visible[y * w + 13] = 1;
        }
        let reached = page_connected(view, &visible, 0);
        assert!(reached[4 * w + 60]);
        assert!(!reached[24 * w + 40]);
        assert!(!reached[24 * w + 44]);
        assert!(!page_connected(view, &vec![0; w * h], 0).iter().any(|v| *v));
    }

    #[test]
    fn narrow_object_keeps_its_foreground_but_not_the_connected_page_margin() {
        let (w, h) = (24, 64);
        let mut rgba = [250, 250, 250, 255].repeat(w * h);
        for y in 12..52 {
            for x in 10..14 {
                rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[150, 150, 150, 255]);
            }
        }
        // An enclosed bright pixel is part of the object, not the exterior background.
        rgba[(30 * w + 11) * 4..(30 * w + 11) * 4 + 4].copy_from_slice(&[250, 250, 250, 255]);
        let labels = vec![1; w * h];
        let view = View {
            rgba: &rgba,
            labels: &labels,
            width: w,
            height: h,
            code: 1,
            pose: (0, 0),
        };
        let mut core: Vec<_> = (10..54)
            .filter(|&y| y != 51)
            .map(|y| MaskRun { x: 8, y, length: 8 })
            .collect();
        exclude_margin(
            view,
            Bounds {
                x: 8,
                y: 10,
                width: 8,
                height: 44,
            },
            &mut core,
            0,
        );
        let covers = |x, y| {
            core.iter()
                .any(|r| r.y == y && r.x <= x && r.x + r.length as i32 > x)
        };
        assert!(!covers(8, 10));
        assert!(!covers(14, 30));
        assert!(covers(10, 30));
        assert!(covers(11, 30));
        assert!(
            covers(10, 51),
            "motion rounding must not cut off a connected uniform foreground"
        );
        assert!(
            !covers(10, 52),
            "the foreground stops at its actual native colour boundary"
        );
    }
}

/// A connected native colour surface can share a page witness without borrowing the colour of
/// a neighbour. Textured motion seeds are required; a blank match or an enclosed glyph is not one.
/// This is affiliation evidence only, so callers must not promote these pixels to Visible.
pub fn page_connected(view: View<'_>, visibility: &[u8], noise: u8) -> Vec<bool> {
    let n = view.width * view.height;
    let mut visited = vec![false; n];
    let mut reached = vec![false; n];
    let mut component = Vec::<u32>::new();
    for seed in 0..n {
        if visited[seed] || view.labels[seed] != view.code {
            continue;
        }
        visited[seed] = true;
        component.clear();
        component.push(seed as u32);
        let rgb: [u8; 3] = view.rgba[seed * 4..seed * 4 + 3].try_into().unwrap();
        let mut support = 0;
        let mut at = 0;
        while at < component.len() {
            let i = component[at] as usize;
            at += 1;
            let (x, y) = (i % view.width, i / view.width);
            let neighbours = [
                x.checked_sub(1).map(|_| i - 1),
                (x + 1 < view.width).then_some(i + 1),
                y.checked_sub(1).map(|_| i - view.width),
                (y + 1 < view.height).then_some(i + view.width),
            ];
            let textured = visibility[i] == 1
                && neighbours.iter().flatten().any(|&j| {
                    (0..3)
                        .map(|c| view.rgba[i * 4 + c].abs_diff(view.rgba[j * 4 + c]) as u32)
                        .sum::<u32>()
                        > noise as u32 * 3 + 6
                });
            support += textured as usize;
            for j in neighbours.into_iter().flatten() {
                if !visited[j]
                    && view.labels[j] == view.code
                    && close(view.rgba[j * 4..j * 4 + 3].try_into().unwrap(), rgb, noise)
                {
                    visited[j] = true;
                    component.push(j as u32);
                }
            }
        }
        if support >= 8 {
            for &i in &component {
                reached[i as usize] = true;
            }
        }
    }
    reached
}

fn colour(view: View<'_>, x: i32, y: i32) -> Option<[u8; 3]> {
    if x < 0 || y < 0 || x >= view.width as i32 || y >= view.height as i32 {
        return None;
    }
    let i = y as usize * view.width + x as usize;
    (view.labels[i] == view.code).then(|| view.rgba[i * 4..i * 4 + 3].try_into().unwrap())
}
fn close(a: [u8; 3], b: [u8; 3], noise: u8) -> bool {
    (0..3).map(|c| a[c].abs_diff(b[c]) as u32).sum::<u32>() <= noise as u32 * 3
}
pub fn exclude_margin(view: View<'_>, b: Bounds, runs: &mut Vec<MaskRun>, noise: u8) {
    // Two genuine exterior sides are required; an interior edge substitutes for at most one
    // clipped side. Full-width chrome therefore cannot be mistaken for page background.
    if b.width <= 0 || b.height <= 0 {
        return;
    }
    let narrow = b.width.min(b.height) <= 16 && b.width.max(b.height) >= 4 * b.width.min(b.height);
    if b.x < 0
        || b.y < 0
        || b.x + b.width > view.width as i32
        || b.y + b.height > view.height as i32
    {
        return;
    }
    let n = b.width as usize * b.height as usize;
    if n > 65536 {
        return;
    }
    let mut sides = Vec::new();
    for side in 0..4 {
        let length = if side < 2 { b.width } else { b.height };
        let points = |inside: bool| -> Vec<_> {
            (0..length)
                .filter_map(|i| {
                    let (x, y) = match side {
                        0 => (b.x + i, b.y - if inside { 0 } else { 1 }),
                        1 => (b.x + i, b.y + b.height - if inside { 1 } else { 0 }),
                        2 => (b.x - if inside { 0 } else { 1 }, b.y + i),
                        _ => (b.x + b.width - if inside { 1 } else { 0 }, b.y + i),
                    };
                    colour(view, x, y)
                })
                .collect()
        };
        let outside = points(false);
        let genuine = outside.len() * 2 >= length as usize && outside.len() >= 4;
        let pixels = if genuine { outside } else { points(true) };
        if pixels.len() >= 4 {
            sides.push((pixels, genuine));
        }
    }
    let mut background = None;
    for (pixels, _) in &sides {
        let mut counts = std::collections::BTreeMap::new();
        for &rgb in pixels {
            *counts.entry(rgb).or_insert(0usize) += 1;
        }
        let Some((&mode, _)) = counts.iter().max_by_key(|(_, n)| *n) else {
            continue;
        };
        let mut support = 0;
        let mut exterior = 0;
        for (side, genuine) in &sides {
            if side.iter().filter(|&&rgb| close(rgb, mode, noise)).count() * 4 >= side.len() * 3 {
                support += 1;
                exterior += *genuine as usize;
            }
        }
        if support >= 3 && exterior >= 2 {
            background = Some(mode);
            break;
        }
    }
    let Some(background) = background else {
        return;
    };
    let mut reached = vec![false; n];
    let mut stack = Vec::<usize>::new();
    let push = |i: usize, reached: &mut [bool], stack: &mut Vec<usize>| {
        if !reached[i]
            && colour(
                view,
                b.x + (i % b.width as usize) as i32,
                b.y + (i / b.width as usize) as i32,
            )
            .is_some_and(|rgb| close(rgb, background, noise))
        {
            reached[i] = true;
            stack.push(i);
        }
    };
    let w = b.width as usize;
    let h = b.height as usize;
    for x in 0..w {
        push(x, &mut reached, &mut stack);
        push((h - 1) * w + x, &mut reached, &mut stack);
    }
    for y in 0..h {
        push(y * w, &mut reached, &mut stack);
        push(y * w + w - 1, &mut reached, &mut stack);
    }
    while let Some(i) = stack.pop() {
        let (x, y) = (i % w, i / w);
        if x > 0 {
            push(i - 1, &mut reached, &mut stack);
        }
        if x + 1 < w {
            push(i + 1, &mut reached, &mut stack);
        }
        if y > 0 {
            push(i - w, &mut reached, &mut stack);
        }
        if y + 1 < h {
            push(i + w, &mut reached, &mut stack);
        }
    }
    let mut filtered = Vec::new();
    for r in runs.iter() {
        let mut start = None;
        for x in r.x..=r.x + r.length as i32 {
            let inside = x >= b.x && x < b.x + b.width && r.y >= b.y && r.y < b.y + b.height;
            let keep = x < r.x + r.length as i32
                && (!inside || !reached[((r.y - b.y) * b.width + x - b.x) as usize]);
            if keep && start.is_none() {
                start = Some(x);
            }
            if !keep {
                if let Some(first) = start.take() {
                    filtered.push(MaskRun {
                        x: first,
                        y: r.y,
                        length: (x - first) as u32,
                    });
                }
            }
        }
    }
    // A uniform scrollbar can move by a rounded pixel. Its contour, not the fitted translation,
    // determines the last row: extend only a dominant observed foreground colour, connected to
    // existing evidence and unable to cross the exterior-background flood.
    let mut mask = vec![false; n];
    let mut colours = std::collections::BTreeMap::new();
    for r in &filtered {
        for x in r.x..r.x + r.length as i32 {
            if x >= b.x && x < b.x + b.width && r.y >= b.y && r.y < b.y + b.height {
                let i = ((r.y - b.y) * b.width + x - b.x) as usize;
                if !mask[i] {
                    if let Some(rgb) = colour(view, x, r.y) {
                        *colours.entry(rgb).or_insert(0usize) += 1;
                    }
                }
                mask[i] = true;
            }
        }
    }
    if let Some((&mode, _)) = colours.iter().max_by_key(|(_, count)| *count) {
        let total: usize = colours.values().sum();
        let support: usize = colours
            .iter()
            .filter(|(rgb, _)| close(**rgb, mode, noise))
            .map(|(_, n)| *n)
            .sum();
        if narrow && support >= 8 && support * 5 >= total * 4 {
            let mut visited = vec![false; n];
            let mut pending = Vec::new();
            let push =
                |i: usize, visited: &mut [bool], mask: &mut [bool], pending: &mut Vec<usize>| {
                    if !visited[i]
                        && !reached[i]
                        && colour(view, b.x + (i % w) as i32, b.y + (i / w) as i32)
                            .is_some_and(|rgb| close(rgb, mode, noise))
                    {
                        visited[i] = true;
                        mask[i] = true;
                        pending.push(i);
                    }
                };
            for i in 0..n {
                if mask[i] {
                    push(i, &mut visited, &mut mask, &mut pending);
                }
            }
            while let Some(i) = pending.pop() {
                let (x, y) = (i % w, i / w);
                if x > 0 {
                    push(i - 1, &mut visited, &mut mask, &mut pending);
                }
                if x + 1 < w {
                    push(i + 1, &mut visited, &mut mask, &mut pending);
                }
                if y > 0 {
                    push(i - w, &mut visited, &mut mask, &mut pending);
                }
                if y + 1 < h {
                    push(i + w, &mut visited, &mut mask, &mut pending);
                }
            }
            let mut out = Vec::new();
            for r in &filtered {
                if r.y < b.y || r.y >= b.y + b.height {
                    out.push(r.clone());
                    continue;
                }
                let end = r.x + r.length as i32;
                if r.x < b.x {
                    out.push(MaskRun {
                        x: r.x,
                        y: r.y,
                        length: (end.min(b.x) - r.x) as u32,
                    });
                }
                if end > b.x + b.width {
                    let x = r.x.max(b.x + b.width);
                    out.push(MaskRun {
                        x,
                        y: r.y,
                        length: (end - x) as u32,
                    });
                }
            }
            for y in 0..h {
                let mut start = None;
                for x in 0..=w {
                    let on = x < w && mask[y * w + x];
                    if on && start.is_none() {
                        start = Some(x);
                    }
                    if !on {
                        if let Some(first) = start.take() {
                            out.push(MaskRun {
                                x: b.x + first as i32,
                                y: b.y + y as i32,
                                length: (x - first) as u32,
                            });
                        }
                    }
                }
            }
            out.sort_by_key(|r| (r.y, r.x));
            filtered = out;
        }
    }
    *runs = filtered;
}

/// A newly exposed piece of an automatic fixed island may have no previous-frame witness. The
/// next frame can support its connected native surface using matching page coordinates elsewhere
/// on that surface, even if the target point itself has since moved under an overlay.
pub fn previous_witness(
    frame: u32,
    current: View<'_>,
    previous: View<'_>,
    noise: u8,
    visibility: &[u8],
    ownership: &[u8],
    objects: &[super::objects::ObjectObservation],
) -> Vec<super::objects::ObjectObservation> {
    let mut eligible = visibility.to_vec();
    // A tracked overlay can travel at page speed. Its own positive motion pixels cannot lend
    // affiliation to a previous frame; connected-background evidence was established separately.
    for object in objects.iter().filter(|o| o.frame == frame) {
        let b = object.bounds;
        for y in (b.y - 4).max(0)..(b.y + b.height + 4).min(current.height as i32) {
            for x in (b.x - 4).max(0)..(b.x + b.width + 4).min(current.width as i32) {
                let i = y as usize * current.width + x as usize;
                if eligible[i] == 1 {
                    eligible[i] = 0;
                }
            }
        }
    }
    let mut witnesses = vec![0; previous.width * previous.height];
    let (dx, dy) = (
        current.pose.0 - previous.pose.0,
        current.pose.1 - previous.pose.1,
    );
    for y in 0..current.height {
        for x in 0..current.width {
            let i = y * current.width + x;
            if !matches!(eligible[i], 1 | 4) || current.labels[i] != current.code {
                continue;
            }
            let (px, py) = (x as i32 + dx, y as i32 + dy);
            let Some(rgb) = colour(previous, px, py) else {
                continue;
            };
            if close(
                rgb,
                current.rgba[i * 4..i * 4 + 3].try_into().unwrap(),
                noise,
            ) {
                witnesses[py as usize * previous.width + px as usize] = 1;
            }
        }
    }
    let background = page_connected(previous, &witnesses, noise);
    let details = enclosed_detail(previous, &background, noise);
    [
        (background, super::objects::MotionRole::Background),
        (details, super::objects::MotionRole::PageSurface),
    ]
    .into_iter()
    .filter_map(|(mask, role)| {
        let mut core = Vec::new();
        for y in 0..previous.height {
            let mut start = None;
            for x in 0..=previous.width {
                let on = x < previous.width
                    && ownership[y * previous.width + x] != previous.code
                    && mask[y * previous.width + x];
                if on && start.is_none() {
                    start = Some(x);
                }
                if !on {
                    if let Some(left) = start.take() {
                        core.push(MaskRun {
                            x: left as i32,
                            y: y as i32,
                            length: (x - left) as u32,
                        });
                    }
                }
            }
        }
        (!core.is_empty()).then_some(super::objects::ObjectObservation {
            region: current.code as u16,
            id: 0,
            frame: frame.saturating_sub(1),
            bounds: Bounds {
                x: 0,
                y: 0,
                width: previous.width as i32,
                height: previous.height as i32,
            },
            role,
            core,
            pose_x: previous.pose.0,
            pose_y: previous.pose.1,
        })
    })
    .collect()
}

/// Small details wholly enclosed by one supported page surface inherit uncertain affiliation.
/// Unlike the surrounding background itself, these colours have no independent motion witness;
/// object occlusion must remain able to reject them during retrospective annotation.
fn enclosed_detail(view: View<'_>, background: &[bool], noise: u8) -> Vec<bool> {
    let n = view.width * view.height;
    let mut visited = background.to_vec();
    let mut details = vec![false; n];
    let mut component = Vec::new();
    for seed in 0..n {
        if visited[seed] || view.labels[seed] != view.code {
            continue;
        }
        visited[seed] = true;
        component.clear();
        component.push(seed);
        let (mut left, mut right, mut top, mut bottom) = (
            seed % view.width,
            seed % view.width,
            seed / view.width,
            seed / view.width,
        );
        let mut boundary = None;
        let mut enclosed = true;
        let mut clipped = 0u8;
        let mut at = 0;
        while at < component.len() {
            let i = component[at];
            at += 1;
            let (x, y) = (i % view.width, i / view.width);
            left = left.min(x);
            right = right.max(x);
            top = top.min(y);
            bottom = bottom.max(y);
            clipped |= (x == 0) as u8
                | ((x + 1 == view.width) as u8) << 1
                | ((y == 0) as u8) << 2
                | ((y + 1 == view.height) as u8) << 3;
            for j in [
                x.checked_sub(1).map(|_| i - 1),
                (x + 1 < view.width).then_some(i + 1),
                y.checked_sub(1).map(|_| i - view.width),
                (y + 1 < view.height).then_some(i + view.width),
            ]
            .into_iter()
            .flatten()
            {
                if view.labels[j] != view.code {
                    clipped |= if j + 1 == i {
                        1
                    } else if j == i + 1 {
                        2
                    } else if j < i {
                        4
                    } else {
                        8
                    };
                    continue;
                }
                if background[j] {
                    let rgb = view.rgba[j * 4..j * 4 + 3].try_into().unwrap();
                    if let Some(prior) = boundary {
                        enclosed &= close(prior, rgb, noise);
                    } else {
                        boundary = Some(rgb);
                    }
                } else if !visited[j] {
                    visited[j] = true;
                    component.push(j);
                }
            }
        }
        if enclosed
            && clipped.count_ones() <= 1
            && boundary.is_some()
            && component.len() <= 256
            && right - left < 32
            && bottom - top < 32
        {
            for &i in &component {
                details[i] = true;
            }
        }
    }
    details
}

pub fn refine_objects(
    frame: u32,
    current: View<'_>,
    visibility: &mut [u8],
    noise: u8,
    objects: &mut [super::objects::ObjectObservation],
) {
    let mut page_witnesses = visibility.to_vec();
    // Residual objects can temporarily follow the page. Their own motion evidence cannot
    // establish the surrounding background; require seeds outside every proposed footprint.
    for object in objects.iter().filter(|o| o.frame == frame) {
        let b = object.bounds;
        for y in (b.y - 4).max(0)..(b.y + b.height + 4).min(current.height as i32) {
            for x in (b.x - 4).max(0)..(b.x + b.width + 4).min(current.width as i32) {
                page_witnesses[y as usize * current.width + x as usize] = 0;
            }
        }
    }
    let background = super::background::page_connected(current, &page_witnesses, noise);
    for (i, &page) in background.iter().enumerate() {
        if page && visibility[i] != 1 {
            visibility[i] = 4;
        }
    }
    for object in objects.iter_mut().filter(|o| o.frame == frame) {
        let mut core = Vec::new();
        for run in &object.core {
            let mut start = None;
            for x in run.x..=run.x + run.length as i32 {
                let on = x < run.x + run.length as i32
                    && !background[run.y as usize * current.width + x as usize];
                if on && start.is_none() {
                    start = Some(x);
                }
                if !on {
                    if let Some(x0) = start.take() {
                        core.push(MaskRun {
                            x: x0,
                            y: run.y,
                            length: (x - x0) as u32,
                        });
                    }
                }
            }
        }
        object.core = core;
    }
}
