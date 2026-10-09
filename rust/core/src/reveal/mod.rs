//! Overlay-aware source selection (docs/ARCHITECTURE.md §七).
//!
//! The compositor writes the first good observation of every canvas pixel. Screen-fixed or screen-moving
//! overlays (a composer bar, a floating button, a scrollbar thumb, a cursor, a fade veil) are then burned into
//! the canvas wherever they happened to sit when a region was first seen. This module repairs that with three
//! frame-major passes over the decoded video, each a fixed amount of simple per-pixel work:
//!
//! 1. [`stats`]: per moving layer, per 2×2 screen cell, how the observation compares with the canvas at the same
//!    world position. Overlays show up as screen cells that keep disagreeing (opaque) or that only pass an
//!    attenuated copy of the page (veils), whatever page content scrolls beneath them.
//! 2. [`model`]: those cells become overlay objects with an appearance template. [`locate`] finds each object
//!    again in every frame (it may move, bounce or fade) and turns the result into a per-cell cleanliness tier.
//! 3. [`select`]: every canvas pixel keeps the value the cleanest observations agree on (a tolerant majority, so
//!    one clean sighting beats any number of covered ones and a passing cursor is outvoted). A second pass then
//!    takes whole 16×16 blocks from the latest fully clean frame that agrees, and gives each dynamic component
//!    (content that really changes over time) a single frame, so neither codec phase nor time is mixed.
//!
//! Pixel values are always copied from one decoded observation; nothing is averaged into the output.

pub mod blocks;
pub mod locate;
pub mod model;
pub mod run;
pub mod stats;

/// Side of one statistics cell in native pixels.
pub const CELL: usize = 2;
/// Side of one coherence block in native pixels (the compositor's quality block).
pub const BLOCK: usize = 16;

/// Tiers of one observed pixel, best last. An observation only competes with observations of its own tier.
pub const TIER_OPAQUE: u8 = 0;
pub const TIER_FRINGE: u8 = 1;
pub const TIER_VEIL: u8 = 2;
pub const TIER_CLEAN: u8 = 3;

/// Per-channel difference treated as disagreement, from the source's decode noise (10 for decoded video,
/// 0 for lossless synthetic sources).
#[inline]
pub fn tolerance(noise: f64) -> i32 {
    ((noise * 2.4).round() as i32).max(2)
}

/// Integer luma, 0..=255.
#[inline]
pub fn luma(r: u8, g: u8, b: u8) -> u32 {
    (r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8
}

/// One decoded RGBA frame.
pub struct Frame<'a> {
    pub rgba: &'a [u8],
    pub width: usize,
    pub height: usize,
}

/// Screen pixels that belong to one layer in one frame: inside the layer's rectangle, carrying its atlas label,
/// and outside this frame's occlusion rectangles, precomputed as a byte mask over the rectangle.
pub struct Footprint<'a> {
    /// Layer rectangle in native screen pixels.
    pub x: i64,
    pub y: i64,
    pub width: usize,
    pub height: usize,
    /// One byte per pixel of the rectangle, row-major; non-zero = in the footprint.
    pub mask: &'a [u8],
}

impl Footprint<'_> {
    #[inline]
    pub fn contains(&self, sx: i64, sy: i64) -> bool {
        let (lx, ly) = (sx - self.x, sy - self.y);
        lx >= 0
            && ly >= 0
            && (lx as usize) < self.width
            && (ly as usize) < self.height
            && self.mask[ly as usize * self.width + lx as usize] != 0
    }

    /// `label_mask` with this frame's occlusion rectangles `(x, y, width, height)` cleared.
    pub fn occlude(
        label_mask: &[u8],
        x: i64,
        y: i64,
        width: usize,
        height: usize,
        occlusions: &[(i64, i64, i64, i64)],
    ) -> Vec<u8> {
        let mut m = label_mask.to_vec();
        for &(ox, oy, ow, oh) in occlusions {
            let (x0, y0) = ((ox - x).max(0) as usize, (oy - y).max(0) as usize);
            let (x1, y1) = (
                ((ox + ow - x).max(0) as usize).min(width),
                ((oy + oh - y).max(0) as usize).min(height),
            );
            for ly in y0..y1.max(y0) {
                if x1 > x0 {
                    m[ly * width + x0..ly * width + x1].fill(0);
                }
            }
        }
        m
    }
}

/// A canvas region resident in memory: RGBA pixels with coverage, origin in world pixels.
pub struct CanvasView<'a> {
    pub x: i64,
    pub y: i64,
    pub width: usize,
    pub height: usize,
    pub rgba: &'a [u8],
    /// Coverage bits, one per pixel, row-major (the compositor's layout).
    pub coverage: &'a [u8],
}

impl CanvasView<'_> {
    #[inline]
    pub fn covered(&self, wx: i64, wy: i64) -> Option<usize> {
        let (lx, ly) = (wx - self.x, wy - self.y);
        if lx < 0 || ly < 0 || lx >= self.width as i64 || ly >= self.height as i64 {
            return None;
        }
        let i = ly as usize * self.width + lx as usize;
        (self.coverage[i >> 3] & (1 << (i & 7)) != 0).then_some(i)
    }
}
