//! Per-frame identities for moving parts of learned overlay tracks.
//!
//! A long, multicolour track can average a thumb and its background into one
//! template that matches neither. Colour keys alone also find page margins.
//! Keep a bounded history of actual compact components instead: three compatible
//! observations must move independently of the page, and the page-locked position
//! must be visible and contradicted. The write pass reuses only those observed masks.
use super::locate::{page_coloured, Cells};
use super::model::{Kind, LayerModel, Track};
use super::{Footprint, CELL, TIER_FRINGE, TIER_OPAQUE};
use std::collections::BTreeMap;

const SEARCH_CELLS: usize = 128 * 1024;
const MAX_INSTANCES: usize = 16;
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
// Fixed across native and Wasm: pointer width must not choose different frames
// when a long recording fills its history. Covers a map node and Vec capacity.
const RECORD_OVERHEAD_BYTES: usize = 1024;
const HISTORY: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq)]
struct CellRect {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

#[derive(Clone)]
struct Stamp {
    frame: u32,
    rect: CellRect,
    colour: [u8; 3],
    area: usize,
    mask: Box<[u8]>,
}

impl Stamp {
    fn contains(&self, x: usize, y: usize) -> bool {
        let index = y * self.rect.width + x;
        self.mask[index / 8] & (1 << (index % 8)) != 0
    }

    fn record_bytes(&self) -> usize {
        self.mask.len() + RECORD_OVERHEAD_BYTES
    }
}

struct Observation {
    stamps: Vec<Stamp>,
    pose: (i64, i64),
    canvas: usize,
    confirmed: bool,
}

pub(super) struct ControlTracks {
    previous: Vec<Observation>,
    records: BTreeMap<u32, Vec<Stamp>>,
    record_bytes: usize,
    record_limit: usize,
}

pub(super) struct View {
    pub index: u32,
    pub canvas: usize,
    pub pose: (i64, i64),
}

fn record_limit(cells: usize) -> usize {
    MAX_RECORD_BYTES.min(cells * 4 + 4096)
}

/// Additional storage and scratch beyond the original localization. Cells are
/// reused, but remain live while the vote runs; the bound includes that lifetime.
pub(super) fn memory_bound(cells: usize) -> usize {
    record_limit(cells)
        + cells * 4
        + cells.min(SEARCH_CELLS) * (2 * std::mem::size_of::<usize>() + 5)
        + MAX_INSTANCES * HISTORY * 8 * std::mem::size_of::<Stamp>()
}

fn eligible(model: &LayerModel) -> impl Iterator<Item = &super::model::Object> {
    model
        .objects
        .iter()
        .filter(|object| object.kind == Kind::Opaque && object.track() != Track::None)
}

pub(super) fn needs_cells(model: &LayerModel) -> bool {
    eligible(model).any(|object| {
        let (x0, x1, y0, y1) = object.zone(model.cw, model.ch);
        (x1 - x0) * (y1 - y0) <= SEARCH_CELLS
    })
}

fn visible(footprint: &Footprint<'_>, model: &LayerModel, cx: usize, cy: usize) -> bool {
    let (x, y) = (model.x + (cx * CELL) as i64, model.y + (cy * CELL) as i64);
    (0..CELL).all(|dy| (0..CELL).all(|dx| footprint.contains(x + dx as i64, y + dy as i64)))
}

fn close(a: [u8; 3], b: [u8; 3], tau: i32) -> bool {
    (0..3).all(|k| (a[k] as i32 - b[k] as i32).abs() <= tau)
}

fn compatible(a: &Stamp, b: &Stamp, tau: i32) -> bool {
    a.rect.width.abs_diff(b.rect.width) <= 1
        && a.rect.height.abs_diff(b.rect.height) <= 1
        && a.area.min(b.area) * 10 >= a.area.max(b.area) * 9
        && close(a.colour, b.colour, tau)
}

/// Keep the same stable largest-first selection without accumulating every small
/// stripe in a text-heavy zone. Equal areas retain their original encounter order.
fn retain_candidate(candidates: &mut Vec<Stamp>, stamp: Stamp) {
    if candidates.iter().any(|other| other.rect == stamp.rect) {
        return;
    }
    if candidates.len() == MAX_INSTANCES {
        let mut smallest = 0;
        for i in 1..candidates.len() {
            if candidates[i].area <= candidates[smallest].area {
                smallest = i;
            }
        }
        if stamp.area <= candidates[smallest].area {
            return;
        }
        candidates.remove(smallest);
    }
    candidates.push(stamp);
}

fn detect(
    cells: &Cells,
    model: &LayerModel,
    footprint: &Footprint<'_>,
    tau: i32,
    frame: u32,
) -> Vec<Stamp> {
    let mut candidates = Vec::with_capacity(MAX_INSTANCES);
    let mut budget = SEARCH_CELLS;
    let tolerance = (tau / 3).max(2);
    for object in eligible(model) {
        let (x0, x1, y0, y1) = object.zone(model.cw, model.ch);
        let (width, height) = (x1 - x0, y1 - y0);
        let size = width * height;
        if size > budget {
            continue;
        }
        budget -= size;
        let mut seen: Vec<bool> = (0..size)
            .map(|i| !visible(footprint, model, x0 + i % width, y0 + i / width))
            .collect();
        // One workspace per zone, reused for every component. Capacity bounds both
        // allocation and traversal, including a flat page filling the whole zone.
        let mut pending = Vec::with_capacity(size);
        let mut component = Vec::with_capacity(size);
        for start in 0..size {
            if seen[start] {
                continue;
            }
            let seed = cells.rgb[(y0 + start / width) * cells.cw + x0 + start % width];
            pending.clear();
            component.clear();
            pending.push(start);
            seen[start] = true;
            let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
            let mut sums = [0u64; 3];
            while let Some(index) = pending.pop() {
                let (x, y) = (index % width, index / width);
                component.push(index);
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
                let rgb = cells.rgb[(y0 + y) * cells.cw + x0 + x];
                for k in 0..3 {
                    sums[k] += rgb[k] as u64;
                }
                for (nx, ny) in [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ] {
                    if nx >= width || ny >= height {
                        continue;
                    }
                    let next = ny * width + nx;
                    if !seen[next]
                        && close(cells.rgb[(y0 + ny) * cells.cw + x0 + nx], seed, tolerance)
                    {
                        seen[next] = true;
                        pending.push(next);
                    }
                }
            }
            let (w, h, area) = (right - left, bottom - top, component.len());
            if area < 16 || w.min(h) < 2 || w.max(h) < 3 * w.min(h) || area * 10 < w * h * 9 {
                continue;
            }
            let colour = sums.map(|sum| ((sum + area as u64 / 2) / area as u64) as u8);
            if page_coloured(cells, object, colour, tau) {
                continue;
            }
            let mut mask = vec![0u8; (w * h).div_ceil(8)];
            for &index in &component {
                let local = (index / width - top) * w + index % width - left;
                mask[local / 8] |= 1 << (local % 8);
            }
            retain_candidate(
                &mut candidates,
                Stamp {
                    frame,
                    rect: CellRect {
                        x: x0 + left,
                        y: y0 + top,
                        width: w,
                        height: h,
                    },
                    colour,
                    area,
                    mask: mask.into_boxed_slice(),
                },
            );
        }
    }
    candidates.sort_by_key(|stamp| std::cmp::Reverse(stamp.area));
    candidates
}

/// A repeated underline must not steal a document line's identity. Look where
/// the previous component would be under page motion, including sampling phase.
/// Missing or occluded evidence cannot disprove that explanation.
fn contradicts_page(
    previous: &Stamp,
    cells: &Cells,
    model: &LayerModel,
    footprint: &Footprint<'_>,
    delta: (i64, i64),
    tau: i32,
) -> bool {
    let x0 = (previous.rect.x as f64 + delta.0 as f64 / CELL as f64).floor() as i64;
    let y0 = (previous.rect.y as f64 + delta.1 as f64 / CELL as f64).floor() as i64;
    if x0 < 1
        || y0 < 1
        || x0 + previous.rect.width as i64 >= cells.cw as i64
        || y0 + previous.rect.height as i64 >= cells.ch as i64
    {
        return false;
    }
    let (mut same, mut count) = (0, 0);
    for y in 0..previous.rect.height {
        for x in 0..previous.rect.width {
            if !previous.contains(x, y) {
                continue;
            }
            let (cx, cy) = (x0 as usize + x, y0 as usize + y);
            if !visible(footprint, model, cx, cy) {
                return false;
            }
            count += 1;
            let agrees = (cy - 1..=cy + 1).any(|yy| {
                (cx - 1..=cx + 1).any(|xx| {
                    visible(footprint, model, xx, yy)
                        && close(cells.rgb[yy * cells.cw + xx], previous.colour, tau)
                })
            });
            same += agrees as usize;
        }
    }
    count > 0 && same * 5 < count * 4
}

impl ControlTracks {
    pub(super) fn new(cells: usize) -> Self {
        Self {
            previous: Vec::new(),
            records: BTreeMap::new(),
            record_bytes: 0,
            record_limit: record_limit(cells),
        }
    }

    fn remember(&mut self, stamp: &Stamp) {
        if self
            .records
            .get(&stamp.frame)
            .is_some_and(|records| records.iter().any(|s| s.rect == stamp.rect))
        {
            return;
        }
        let bytes = stamp.record_bytes();
        if self.record_bytes + bytes > self.record_limit {
            return;
        }
        self.records
            .entry(stamp.frame)
            .or_default()
            .push(stamp.clone());
        self.record_bytes += bytes;
    }

    pub(super) fn observe(
        &mut self,
        cells: &Cells,
        model: &LayerModel,
        footprint: &Footprint<'_>,
        tau: i32,
        view: View,
    ) {
        let View {
            index,
            canvas,
            pose,
        } = view;
        // A component has at least sixteen cells, hence at least two mask bytes.
        // Once no record can fit, further detection cannot affect the write pass.
        if self.record_limit - self.record_bytes < RECORD_OVERHEAD_BYTES + 2 {
            self.previous.clear();
            return;
        }
        let candidates = detect(cells, model, footprint, tau, index);
        let mut next = Vec::with_capacity(candidates.len());
        for current in &candidates {
            let mut matching = self.previous.iter().filter(|history| {
                history.canvas == canvas && compatible(history.stamps.last().unwrap(), current, tau)
            });
            let previous = matching.next().filter(|_| matching.next().is_none());
            let mut history = Observation {
                stamps: vec![current.clone()],
                pose,
                canvas,
                confirmed: false,
            };
            if let Some(previous) = previous {
                let last = previous.stamps.last().unwrap();
                let reverse = candidates
                    .iter()
                    .filter(|candidate| compatible(candidate, last, tau))
                    .count();
                let dx = CELL as i64 * (current.rect.x as i64 - last.rect.x as i64);
                let dy = CELL as i64 * (current.rect.y as i64 - last.rect.y as i64);
                let world_motion = (dx + pose.0 - previous.pose.0)
                    .abs()
                    .max((dy + pose.1 - previous.pose.1).abs());
                if reverse == 1
                    && world_motion >= 2 * CELL as i64
                    && contradicts_page(
                        last,
                        cells,
                        model,
                        footprint,
                        (previous.pose.0 - pose.0, previous.pose.1 - pose.1),
                        tau,
                    )
                {
                    history.stamps = previous.stamps.clone();
                    history.stamps.push(current.clone());
                    if history.stamps.len() > HISTORY {
                        history.stamps.remove(0);
                    }
                    let first = &history.stamps[0];
                    let moved = first
                        .rect
                        .x
                        .abs_diff(current.rect.x)
                        .max(first.rect.y.abs_diff(current.rect.y))
                        >= 2;
                    history.confirmed =
                        previous.confirmed || (history.stamps.len() == HISTORY && moved);
                }
            }
            if history.confirmed {
                for stamp in &history.stamps {
                    self.remember(stamp);
                }
            }
            next.push(history);
        }
        self.previous = next;
    }

    pub(super) fn apply(&self, index: u32, model: &LayerModel, zone: &[bool], tiers: &mut [u8]) {
        let Some(records) = self.records.get(&index) else {
            return;
        };
        for stamp in records {
            for y in 0..stamp.rect.height {
                for x in 0..stamp.rect.width {
                    if !stamp.contains(x, y) {
                        continue;
                    }
                    let (cx, cy) = (stamp.rect.x + x, stamp.rect.y + y);
                    let index = cy * model.cw + cx;
                    if !zone[index] {
                        continue;
                    }
                    tiers[index] = TIER_OPAQUE;
                    for yy in cy.saturating_sub(2)..=(cy + 2).min(model.ch - 1) {
                        for xx in cx.saturating_sub(2)..=(cx + 2).min(model.cw - 1) {
                            let at = yy * model.cw + xx;
                            if tiers[at] != TIER_OPAQUE {
                                tiers[at] = tiers[at].min(TIER_FRINGE);
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
