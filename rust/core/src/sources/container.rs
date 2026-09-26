//! Evidence that a locally moving texture belongs to a page-anchored panel. A closed coloured
//! backdrop and its four boundaries must follow the page. Viewport margins are not containers.
use super::objects::{Bounds, View};
fn colour(view: View<'_>, x: i32, y: i32) -> Option<[u8; 3]> {
    if x < 0 || y < 0 || x >= view.width as i32 || y >= view.height as i32 {
        return None;
    }
    let i = y as usize * view.width + x as usize;
    if view.labels[i] != view.code {
        return None;
    }
    Some(view.rgba[i * 4..i * 4 + 3].try_into().unwrap())
}
fn close(a: [u8; 3], b: [u8; 3], noise: u8) -> bool {
    (0..3).map(|c| a[c].abs_diff(b[c]) as u32).sum::<u32>() <= noise as u32 * 3
}
pub fn enclosing_page_panel(
    current: View<'_>,
    previous: View<'_>,
    bounds: Bounds,
    noise: u8,
) -> Option<Bounds> {
    let page = (
        current.pose.0 - previous.pose.0,
        current.pose.1 - previous.pose.1,
    );
    if page.0.abs() + page.1.abs() < 2 {
        return None;
    }
    for sy in [bounds.y - 2, bounds.y + bounds.height + 1] {
        let sx = bounds.x + bounds.width / 2;
        let Some(background) = colour(current, sx, sy) else {
            continue;
        };
        let matches = |x, y| colour(current, x, y).is_some_and(|c| close(c, background, noise));
        let mut left = sx;
        let mut right = sx + 1;
        while left > 0 && matches(left - 1, sy) {
            left -= 1;
        }
        while right < current.width as i32 && matches(right, sy) {
            right += 1;
        }
        if left > bounds.x - 3 || right < bounds.x + bounds.width + 3 {
            continue;
        }
        for x in [left + 1, right - 2] {
            let mut top = sy;
            let mut bottom = sy + 1;
            while top > 0 && matches(x, top - 1) {
                top -= 1;
            }
            while bottom < current.height as i32 && matches(x, bottom) {
                bottom += 1;
            }
            if left <= 0
                || top <= 0
                || right >= current.width as i32
                || bottom >= current.height as i32
                || top > bounds.y - 3
                || bottom < bounds.y + bounds.height + 3
            {
                continue;
            }
            let mut agree = 0;
            let mut edges = 0;
            let mut check = |x: i32, y: i32, ox: i32, oy: i32| {
                let (Some(inside), Some(outside), Some(old_inside), Some(old_outside)) = (
                    colour(current, x, y),
                    colour(current, ox, oy),
                    colour(previous, x + page.0, y + page.1),
                    colour(previous, ox + page.0, oy + page.1),
                ) else {
                    return;
                };
                if close(inside, background, noise)
                    && !close(inside, outside, noise.saturating_add(2))
                {
                    edges += 1;
                    if close(inside, old_inside, noise) && close(outside, old_outside, noise) {
                        agree += 1;
                    }
                }
            };
            for k in 1..9 {
                let x = left + (right - left) * k / 10;
                check(x, top, x, top - 1);
                check(x, bottom - 1, x, bottom);
            }
            for k in 1..9 {
                let y = top + (bottom - top) * k / 10;
                check(left, y, left - 1, y);
                check(right - 1, y, right, y);
            }
            if edges < 24 || agree * 10 < edges * 9 {
                continue;
            }
            let mut plain = 0;
            let mut samples = 0;
            for y in (top..bottom).step_by(3) {
                for x in (left..right).step_by(3) {
                    samples += 1;
                    plain += matches(x, y) as usize;
                }
            }
            if plain * 4 < samples * 3 {
                continue;
            }
            return Some(Bounds {
                x: left + current.pose.0,
                y: top + current.pose.1,
                width: right - left,
                height: bottom - top,
            });
        }
    }
    None
}
