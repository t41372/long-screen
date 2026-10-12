//! What one screen-fixed region showed at the start of the recording, without its transients (docs/ARCHITECTURE.md
//! §七 "屏幕固定区域").
//!
//! The render pass keeps, for every pixel the region owns, its value in the first frame and the runs of equal
//! values (within the source noise) that follow, until the region's first settled change of state ends that first
//! epoch. The value a pixel held longest in the epoch is what the bar showed then; where it differs from the first
//! frame, the first frame showed a transient (a pointer parked there at the start, a bar still fading in). Those
//! differences are only trusted in pointer-sized patches: a large difference is content changing under the bar,
//! and the first frame is kept there as it was.

use crate::kernels::geometry::{js_ceil, js_floor, Rect};
use crate::kernels::pool::SyncPtr;

/// Cell side, in pixels, of the grid the differences are grouped on.
const CELL: usize = 8;
/// Differences closer than this many cells belong to one patch: the glyphs of a line of text, an icon and its
/// label, stay together.
const REACH: usize = 4;
/// A patch is a transient when its differing pixels fit in this many pixels across and down: a pointer (about 36 × 54
/// on a 2× screen) does, together with the hover highlight of the button under it (owner_1.53.20's frame 0: 341 ×
/// 53 with the Incognito pill); a bar that changed, or content scrolling under it, does not.
const PATCH_W: usize = 384;
const PATCH: usize = 128;
/// Cells around a transient patch that take their longest-held values too.
const HALO: usize = 2;

#[inline]
fn px(rgba: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([
        rgba[i * 4],
        rgba[i * 4 + 1],
        rgba[i * 4 + 2],
        rgba[i * 4 + 3],
    ])
}

/// RGB channel-difference sum of two packed pixels.
#[inline]
fn distance(a: u32, b: u32) -> u32 {
    let (a, b) = (a.to_le_bytes(), b.to_le_bytes());
    a[0].abs_diff(b[0]) as u32 + a[1].abs_diff(b[1]) as u32 + a[2].abs_diff(b[2]) as u32
}

/// Per-pixel run history of one fixed region, laid out over its floored rect.
pub struct FixedHistory {
    x0: i64,
    y0: i64,
    w: usize,
    h: usize,
    /// Pixels the region owns inside the frame.
    inside: Vec<bool>,
    frame0: Vec<u32>,
    current: Vec<u32>,
    start: Vec<u32>,
    longest: Vec<u32>,
    length: Vec<u32>,
    /// Frame the first values came from; `None` until the first update.
    first_frame: Option<u32>,
    /// The first epoch is over; later updates are ignored.
    closed: bool,
}

impl FixedHistory {
    pub fn new(region: Rect) -> Self {
        let (x0, y0) = (js_floor(region.x) as i64, js_floor(region.y) as i64);
        let w = (js_ceil(region.x + region.width) as i64 - x0).max(0) as usize;
        let h = (js_ceil(region.y + region.height) as i64 - y0).max(0) as usize;
        let n = w * h;
        Self {
            x0,
            y0,
            w,
            h,
            inside: vec![false; n],
            frame0: vec![0; n],
            current: vec![0; n],
            start: vec![0; n],
            longest: vec![0; n],
            length: vec![0; n],
            first_frame: None,
            closed: false,
        }
    }

    /// Bytes the history holds.
    pub fn bytes(region: Rect) -> f64 {
        let w = (js_ceil(region.x + region.width) - js_floor(region.x)).max(0) as f64;
        let h = (js_ceil(region.y + region.height) - js_floor(region.y)).max(0) as f64;
        w * h * 21.0
    }

    /// The frame whose values [`FixedHistory::first`] starts from.
    pub fn first_frame(&self) -> Option<u32> {
        self.first_frame
    }

    pub fn closed(&self) -> bool {
        self.closed
    }

    /// The first frame's values, packed RGBA over the region's rect (0 where the region owns no pixel).
    pub fn frame0(&self) -> &[u32] {
        &self.frame0
    }

    /// Takes frame `frame`'s pixels (`rgba`, `width × height`, atlas `labels`, the region's `code`, the region's
    /// consistency mask `consistent`): a pixel that moved beyond `limit` (the RGB difference sum the source noise
    /// allows) from its current run ends that run. When the pixels that settled into a new value (consistent with a
    /// neighbouring frame) are more than a pointer could cover, the region changed state and the first epoch ends
    /// here. Returns that count of settled pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        rgba: &[u8],
        labels: &[u8],
        consistent: &[u8],
        width: usize,
        height: usize,
        code: u8,
        frame: u32,
        limit: u32,
    ) -> usize {
        if self.closed {
            return 0;
        }
        let first = self.first_frame.is_none();
        if first {
            self.first_frame = Some(frame);
        }
        let (w, h, x0, y0) = (self.w, self.h, self.x0, self.y0);
        let chunks = crate::kernels::pool::chunks_for(w * h, 64 * 1024);
        let mut counts = vec![0usize; chunks];
        let ptrs = (
            SyncPtr(self.inside.as_mut_ptr()),
            SyncPtr(self.frame0.as_mut_ptr()),
            SyncPtr(self.current.as_mut_ptr()),
            SyncPtr(self.start.as_mut_ptr()),
            SyncPtr(self.longest.as_mut_ptr()),
            SyncPtr(self.length.as_mut_ptr()),
            SyncPtr(counts.as_mut_ptr()),
        );
        crate::kernels::pool::par_for(chunks, |c| {
            let mut settled = 0usize;
            for y in crate::kernels::pool::split(h, chunks, c)
                ..crate::kernels::pool::split(h, chunks, c + 1)
            {
                let sy = y0 + y as i64;
                if sy < 0 || sy >= height as i64 {
                    continue;
                }
                for x in 0..w {
                    let sx = x0 + x as i64;
                    if sx < 0 || sx >= width as i64 {
                        continue;
                    }
                    let src = sy as usize * width + sx as usize;
                    let i = y * w + x;
                    // SAFETY: row `y` of every plane belongs to this chunk alone, and so does count `c`.
                    unsafe {
                        if first {
                            if labels[src] != code {
                                continue;
                            }
                            let v = px(rgba, src);
                            *ptrs.0.get().add(i) = true;
                            *ptrs.1.get().add(i) = v;
                            *ptrs.2.get().add(i) = v;
                            *ptrs.3.get().add(i) = frame;
                            *ptrs.4.get().add(i) = v;
                            continue;
                        }
                        if !*ptrs.0.get().add(i) {
                            continue;
                        }
                        let v = px(rgba, src);
                        let cur = *ptrs.2.get().add(i);
                        if distance(v, cur) > limit {
                            let run = frame - *ptrs.3.get().add(i);
                            if run > *ptrs.5.get().add(i) {
                                *ptrs.4.get().add(i) = cur;
                                *ptrs.5.get().add(i) = run;
                            }
                            *ptrs.2.get().add(i) = v;
                            *ptrs.3.get().add(i) = frame;
                            if consistent[src] != 0 {
                                settled += 1;
                            }
                        }
                    }
                }
            }
            // SAFETY: one count per chunk.
            unsafe { *ptrs.6.get().add(c) = settled };
        });
        let settled: usize = counts.iter().sum();
        let owned = self.inside.iter().filter(|&&b| b).count();
        if !first && settled > (PATCH * PATCH).min(owned / 4) {
            self.close(frame);
        }
        settled
    }

    /// Ends the first epoch before frame `end`: every current run is counted up to it, and later updates are
    /// ignored.
    pub fn close(&mut self, end: u32) {
        if self.closed || self.first_frame.is_none() {
            self.closed = true;
            return;
        }
        for i in 0..self.inside.len() {
            if !self.inside[i] {
                continue;
            }
            let run = end.saturating_sub(self.start[i]);
            if run > self.length[i] {
                self.longest[i] = self.current[i];
                self.length[i] = run;
            }
        }
        self.closed = true;
    }

    /// The first frame's pixels with its transients replaced (call after [`FixedHistory::close`]): where the value a
    /// pixel held longest in the first epoch differs from the first frame by more than `limit`, inside a patch no
    /// larger than a pointer, the longest-held value; elsewhere the first frame. Packed RGBA over the region's rect;
    /// 0 where the region owns no pixel.
    pub fn first(&self, limit: u32) -> Vec<u32> {
        let (w, h) = (self.w, self.h);
        let mut out = self.frame0.clone();
        let differs: Vec<bool> = (0..w * h)
            .map(|i| self.inside[i] && distance(self.longest[i], self.frame0[i]) > limit)
            .collect();
        let (gw, gh) = (w.div_ceil(CELL), h.div_ceil(CELL));
        let mut cells = vec![false; gw * gh];
        for y in 0..h {
            for x in 0..w {
                if differs[y * w + x] {
                    cells[(y / CELL) * gw + x / CELL] = true;
                }
            }
        }
        // Group the differing cells: two cells within REACH of each other belong to one patch.
        let mut label = vec![usize::MAX; gw * gh];
        let mut patches: Vec<(usize, usize, usize, usize)> = Vec::new();
        for seed in 0..gw * gh {
            if !cells[seed] || label[seed] != usize::MAX {
                continue;
            }
            let id = patches.len();
            let (sx, sy) = (seed % gw, seed / gw);
            let mut bounds = (sx, sy, sx, sy);
            label[seed] = id;
            let mut queue = vec![seed];
            while let Some(c) = queue.pop() {
                let (cx, cy) = (c % gw, c / gw);
                bounds = (
                    bounds.0.min(cx),
                    bounds.1.min(cy),
                    bounds.2.max(cx),
                    bounds.3.max(cy),
                );
                for ny in cy.saturating_sub(REACH)..(cy + REACH + 1).min(gh) {
                    for nx in cx.saturating_sub(REACH)..(cx + REACH + 1).min(gw) {
                        let n = ny * gw + nx;
                        if cells[n] && label[n] == usize::MAX {
                            label[n] = id;
                            queue.push(n);
                        }
                    }
                }
            }
            patches.push(bounds);
        }
        let small: Vec<bool> = patches
            .iter()
            .map(|&(x0, y0, x1, y1)| {
                (x1 - x0 + 1) * CELL <= PATCH_W && (y1 - y0 + 1) * CELL <= PATCH
            })
            .collect();
        // A transient's soft edge (a pointer's shadow) differs from the bar by less than the noise allows; around a
        // transient patch, out to HALO cells, every pixel takes the value it held longest.
        let mut fix = vec![false; gw * gh];
        for c in 0..gw * gh {
            if !cells[c] || !small[label[c]] {
                continue;
            }
            let (cx, cy) = (c % gw, c / gw);
            for ny in cy.saturating_sub(HALO)..(cy + HALO + 1).min(gh) {
                for nx in cx.saturating_sub(HALO)..(cx + HALO + 1).min(gw) {
                    let n = ny * gw + nx;
                    // A cell of a large patch is content changing, halo or not.
                    if !cells[n] || small[label[n]] {
                        fix[n] = true;
                    }
                }
            }
        }
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if self.inside[i] && fix[(y / CELL) * gw + x / CELL] {
                    out[i] = self.longest[i];
                }
            }
        }
        out
    }

    /// Writes [`FixedHistory::first`] into a frame-sized `rgba` at the region's pixels; returns whether any byte
    /// changed.
    pub fn paint(&self, first: &[u32], rgba: &mut [u8], width: usize, height: usize) -> bool {
        let mut changed = false;
        for y in 0..self.h {
            let sy = self.y0 + y as i64;
            if sy < 0 || sy >= height as i64 {
                continue;
            }
            for x in 0..self.w {
                let sx = self.x0 + x as i64;
                let i = y * self.w + x;
                if sx < 0 || sx >= width as i64 || !self.inside[i] {
                    continue;
                }
                let at = (sy as usize * width + sx as usize) * 4;
                let v = first[i].to_le_bytes();
                if rgba[at..at + 4] != v {
                    rgba[at..at + 4].copy_from_slice(&v);
                    changed = true;
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 480;
    const H: usize = 160;

    fn region() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: W as f64,
            height: H as f64,
        }
    }

    fn frame(v: u8) -> Vec<u8> {
        [v, v, v, 255].repeat(W * H)
    }

    fn fill(mut f: Vec<u8>, x: usize, y: usize, w: usize, h: usize, v: u8) -> Vec<u8> {
        for yy in y..y + h {
            for xx in x..x + w {
                let i = (yy * W + xx) * 4;
                f[i..i + 3].copy_from_slice(&[v, v, v]);
            }
        }
        f
    }

    /// Every frame through a history whose consistency mask is `consistent` everywhere.
    fn run(frames: &[Vec<u8>], labels: &[u8], consistent: u8) -> Vec<u32> {
        let mut hist = FixedHistory::new(region());
        let mask = vec![consistent; W * H];
        for (i, f) in frames.iter().enumerate() {
            hist.update(f, labels, &mask, W, H, 1, i as u32, 0);
        }
        hist.close(frames.len() as u32);
        hist.first(0)
    }

    fn at(first: &[u32], x: usize, y: usize) -> u8 {
        first[y * W + x].to_le_bytes()[0]
    }

    #[test]
    fn a_pointer_parked_in_the_first_frame_is_replaced_by_what_it_covered() {
        // Parked for 3 frames at the start, gone for the next 10.
        let pointer = || fill(frame(100), 20, 10, 18, 27, 250);
        let mut frames = vec![pointer(), pointer(), pointer()];
        frames.extend((0..10).map(|_| frame(100)));
        let first = run(&frames, &[1; W * H], 1);
        assert_eq!(at(&first, 25, 20), 100);
        assert_eq!(at(&first, 100, 20), 100);
    }

    #[test]
    fn a_change_after_the_first_epoch_keeps_the_first_frame() {
        // Hidden for 4 frames, then shown for 20, the change a subtle one (a background 20 levels lighter, under
        // any conflict threshold) but settled over the whole bar: the epoch ends there, so the first frame's state
        // is what the region showed then.
        let mut frames: Vec<_> = (0..4).map(|_| frame(30)).collect();
        frames.extend((0..20).map(|_| frame(50)));
        let first = run(&frames, &[1; W * H], 1);
        assert_eq!(at(&first, 100, 20), 30);
    }

    #[test]
    fn a_large_difference_is_content_and_keeps_the_first_frame() {
        // Never consistent, so the epoch never ends: a large area that held another value longer is still not a
        // transient.
        let mut frames = vec![frame(0)];
        frames.extend((0..20).map(|_| fill(frame(0), 0, 0, 400, 40, 200)));
        let first = run(&frames, &[1; W * H], 0);
        assert_eq!(at(&first, 50, 20), 0);
    }

    #[test]
    fn text_glyphs_close_together_form_one_patch() {
        // Thirty 6-px glyphs 14 px apart that all scroll away: 420 px wide together, so the first frame stays.
        let mut text = frame(255);
        for k in 0..30 {
            text = fill(text, 10 + k * 14, 15, 6, 10, 0);
        }
        let mut frames = vec![text.clone(), text];
        frames.extend((0..20).map(|_| frame(255)));
        let first = run(&frames, &[1; W * H], 0);
        assert_eq!(at(&first, 12, 20), 0);
    }

    #[test]
    fn pixels_the_region_does_not_own_are_left_alone() {
        let labels: Vec<u8> = (0..W * H)
            .map(|i| if i % W < 100 { 1 } else { 2 })
            .collect();
        let mut frames = vec![fill(frame(100), 150, 10, 10, 10, 250)];
        frames.extend((0..10).map(|_| frame(100)));
        let mut hist = FixedHistory::new(region());
        for (i, f) in frames.iter().enumerate() {
            hist.update(f, &labels, &[1; W * H], W, H, 1, i as u32, 0);
        }
        hist.close(frames.len() as u32);
        let mut out = frames[0].clone();
        let first = hist.first(0);
        hist.paint(&first, &mut out, W, H);
        assert_eq!(out, frames[0]);
    }
}
