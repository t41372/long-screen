//! Screen-motion witnesses and the appearance identity of wide, detached floating panels.
//! These supplement world-consistency voting; they never supply reconstructed pixel colours.
use super::{Layer, RegionSlot};

pub(super) fn add_screen_support(packed: &mut [u8], i: usize) -> bool {
    let shift = (i % 4) * 2;
    let before = (packed[i / 4] >> shift) & 3;
    if before < 3 {
        packed[i / 4] += 1 << shift;
    }
    before == 1
}

pub(super) fn screen_agrees(
    a: &[u8],
    b: &[u8],
    i: usize,
    width: usize,
    inside: &[u8],
    noise: i32,
) -> bool {
    if i < width + 1
        || i + width + 1 >= a.len()
        || i.is_multiple_of(width)
        || i % width + 1 == width
    {
        return false;
    }
    let mut difference = 0;
    for row in [i - width, i, i + width] {
        for j in row - 1..=row + 1 {
            if inside[j] == 0 {
                return false;
            }
            difference += (a[j] as i32 - b[j] as i32).abs();
        }
    }
    difference <= noise * 9
}

/// Compare whole patches; one similarly coloured tap is not evidence that two glyphs agree.
/// A one-cell search tolerates the box-grid phase; out-of-region taps leave the result unknown.
pub(super) fn page_patch_agrees(
    a: &[u8],
    b: &[u8],
    i: usize,
    j: usize,
    width: usize,
    inside: &[u8],
    noise: i32,
) -> bool {
    let height = a.len() / width;
    let (x, y) = (j % width, j / width);
    if i < width + 1
        || i + width + 1 >= a.len()
        || i.is_multiple_of(width)
        || i % width + 1 == width
    {
        return true;
    }
    for cy in y.saturating_sub(1)..=(y + 1).min(height - 1) {
        for cx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
            if cx == 0 || cy == 0 || cx + 1 == width || cy + 1 == height {
                continue;
            }
            let centre = cy * width + cx;
            let mut sum = 0;
            for row in 0..3 {
                for col in 0..3 {
                    let p = i + row * width + col - width - 1;
                    let q = centre + row * width + col - width - 1;
                    if inside[p] == 0 || inside[q] == 0 {
                        return true;
                    }
                    sum += (a[p] as i32 - b[q] as i32).abs();
                }
            }
            if sum <= noise * 9 {
                return true;
            }
        }
    }
    false
}

/// Screen-coordinate identity of a wide panel, learned from displacement-separated witnesses.
/// Its textured anchors let a frame inherit the footprint even when the page beneath has the
/// same colour. A removed/changed panel must match the anchors again; pauses never add votes.
pub(super) struct ScreenPanel {
    anchors: Vec<(usize, u8)>,
    footprint: Vec<u8>,
}

impl ScreenPanel {
    pub(super) fn learn(layer: &Layer, slot: &RegionSlot) -> Option<Self> {
        let (w, h) = (slot.box_.w as usize, slot.box_.h as usize);
        let mut bits = vec![0u8; (w * h).div_ceil(8)];
        for i in 0..w * h {
            if (layer.screen[i / 4] >> (i % 4 * 2)) & 3 >= 2 {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        let original = bits;
        let panel = wide_panels(&original, w, h)
            .into_iter()
            .max_by_key(|p| (p.right - p.left) * (p.bottom - p.top))?;
        let PanelBounds {
            left,
            right,
            top,
            bottom,
        } = panel;
        let mut footprint = vec![0; original.len()];
        fill_panel(&mut footprint, w, h, &slot.inside, panel);
        // Use original textured seeds for identity; flat background and the inferred shadow cannot
        // distinguish a floating input from a similarly coloured code block.
        let candidates: Vec<_> = (w + 1..w * (h - 1) - 1)
            .filter(|&i| {
                if i % w < left
                    || i % w >= right
                    || i / w < top
                    || i / w >= bottom
                    || i % w == 0
                    || i % w + 1 == w
                    || ((layer.screen[i / 4] >> (i % 4 * 2)) & 3) < 3
                {
                    return false;
                }
                let g = &layer.box_gray;
                (g[i - 1] as i32 - g[i + 1] as i32)
                    .abs()
                    .max((g[i - w] as i32 - g[i + w] as i32).abs())
                    >= 8
            })
            .collect();
        if candidates.len() < 16 {
            return None;
        }
        let count = candidates.len().min(96);
        let anchors = (0..count)
            .map(|k| {
                let i = candidates[k * candidates.len() / count];
                (i, layer.box_gray[i])
            })
            .collect();
        Some(Self { anchors, footprint })
    }

    pub(super) fn apply(&self, layer: &mut Layer, noise: i32) {
        let agreeing = self
            .anchors
            .iter()
            .filter(|&&(i, v)| (layer.box_gray[i] as i32 - v as i32).abs() <= noise)
            .count();
        if agreeing * 10 < self.anchors.len() * 9 {
            return;
        }
        for (byte, &mask) in self.footprint.iter().enumerate() {
            if mask == 0 {
                continue;
            }
            for bit in 0..8 {
                if mask & (1 << bit) == 0 {
                    continue;
                }
                let i = byte * 8 + bit;
                let shift = i % 4 * 2;
                layer.screen[i / 4] = (layer.screen[i / 4] & !(3 << shift)) | (2 << shift);
            }
        }
    }
}

/// A wide floating panel has one footprint, including the low-texture gaps between its glyphs
/// and its adjacent shadow. Only sustained wide rows of screen evidence qualify; small cursors,
/// buttons and isolated page coincidences keep their pixel-local verdicts.
pub(super) fn complete_wide_panels(bits: &mut [u8], width: usize, height: usize, inside: &[u8]) {
    for panel in wide_panels(bits, width, height) {
        fill_panel(bits, width, height, inside, panel);
    }
}

#[derive(Clone, Copy)]
struct PanelBounds {
    left: usize,
    right: usize,
    top: usize,
    bottom: usize,
}

fn wide_panels(bits: &[u8], width: usize, height: usize) -> Vec<PanelBounds> {
    let row_bounds: Vec<_> = (0..height)
        .map(|y| {
            // Separate objects must not become one wide panel merely because their bounding box
            // is wide. Small gaps admit glyph holes; a gap between a toast and FAB splits the run.
            let gap = (width / 64).max(2);
            let mut runs = Vec::new();
            let (mut count, mut left, mut right) = (0, width, 0);
            for x in 0..width {
                let i = y * width + x;
                if bits[i / 8] & (1 << (i % 8)) == 0 {
                    continue;
                }
                if count > 0 && x - right > gap {
                    runs.push((count, left, right));
                    count = 0;
                    left = width;
                }
                count += 1;
                left = left.min(x);
                right = x + 1;
            }
            runs.push((count, left, right));
            runs.into_iter()
                .filter(|&(count, left, right)| {
                    count * 3 >= width
                        && (right - left) * 3 >= width * 2
                        && (right - left) * 20 < width * 19
                })
                .max_by_key(|&(count, _, _)| count)
                .map(|(_, left, right)| (left, right))
        })
        .collect();
    let mut panels = Vec::new();
    let mut top = 0;
    while top < height {
        let Some((mut left, mut right)) = row_bounds[top] else {
            top += 1;
            continue;
        };
        let mut bottom = top + 1;
        while bottom < height && row_bounds[bottom].is_some() {
            let (a, b) = row_bounds[bottom].unwrap();
            left = left.min(a);
            right = right.max(b);
            bottom += 1;
        }
        let span = bottom - top;
        if span >= 4 && span * 5 <= height {
            panels.push(PanelBounds {
                left,
                right,
                top,
                bottom,
            });
        }
        top = bottom;
    }
    panels
}

fn fill_panel(bits: &mut [u8], width: usize, height: usize, inside: &[u8], panel: PanelBounds) {
    let PanelBounds {
        left,
        right,
        top,
        bottom,
    } = panel;
    let span = bottom - top;
    let halo = span.div_ceil(2);
    for y in top.saturating_sub(halo)..(bottom + halo).min(height) {
        for x in left.saturating_sub(span.div_ceil(4))..(right + span.div_ceil(4)).min(width) {
            let i = y * width + x;
            if inside[i] != 0 {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wide_panel_footprint_closes_holes_and_shadow_without_expanding_small_objects() {
        let (w, h) = (100, 100);
        let inside = vec![1; w * h];
        let mut bits = vec![0; (w * h).div_ceil(8)];
        for y in 72..82 {
            for x in 10..90 {
                if x % 5 != 0 {
                    let i = y * w + x;
                    bits[i / 8] |= 1 << (i % 8);
                }
            }
        }
        complete_wide_panels(&mut bits, w, h, &inside);
        let at = |x: usize, y: usize| bits[(y * w + x) / 8] & (1u8 << ((y * w + x) % 8)) != 0;
        assert!(at(50, 76) && at(50, 85));
        assert!(!at(50, 50) && !at(2, 76));
        let mut narrow = vec![0; bits.len()];
        for y in 72..82 {
            for x in 10..20 {
                let i = y * w + x;
                narrow[i / 8] |= 1 << (i % 8);
            }
        }
        let before = narrow.clone();
        complete_wide_panels(&mut narrow, w, h, &inside);
        assert_eq!(narrow, before);
    }
}
