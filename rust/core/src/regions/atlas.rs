//! RegionAtlas pixel labelling (`src/core/layers.ts::RegionAtlas`'s constructor): native-resolution pixel
//! ownership, first-containing-region-wins, plus the per-code pixel counts `RegionAtlas.count()` needs — computed
//! in the same pass so the adapter never scans the label plane a second time in TS.
//!
//! `AtlasRegion`/`AtlasMask` borrow their mask bytes from the caller (they only need to live for this one call,
//! unlike `region::Region`/`Mask`, which `voting.rs`'s Ring retains across many calls and therefore must own).
//! Membership logic is `region::Region::contains`'s (mirrored here, not shared, to keep that borrow); a change to
//! one must be mirrored in the other — `tests/unit/parity/regions.test.ts` exercises both through the ABI and
//! would catch a drift.

use crate::geometry::{js_ceil, js_floor, Rect};

pub struct AtlasMask<'a> {
    pub width: usize,
    pub height: usize,
    /// Integer analysis factor the mask was built at; 0 selects the legacy ratio lookup.
    pub factor: u32,
    pub data: &'a [u8],
}

pub struct AtlasRegion<'a> {
    pub rect: Rect,
    pub exclusions: Vec<Rect>,
    pub crop: Option<Rect>,
    pub solid: bool,
    pub mask: Option<AtlasMask<'a>>,
}

#[inline]
fn clamp_index(value: i32, len: usize) -> usize {
    value.clamp(0, len as i32 - 1) as usize
}

impl AtlasRegion<'_> {
    /// Mirrors `region::Region::contains` exactly (see the module doc comment for why it is not shared).
    fn contains(&self, x: f64, y: f64, native_width: f64, native_height: f64) -> bool {
        if !self.rect.contains(x, y) || self.exclusions.iter().any(|r| r.contains(x, y)) {
            return false;
        }
        if self.crop.is_some_and(|c| !c.contains(x, y)) {
            return false;
        }
        if self.solid {
            return true;
        }
        let Some(mask) = &self.mask else {
            return true;
        };
        let (xx, yy) = if mask.factor > 0 {
            let f = mask.factor as f64;
            (
                clamp_index(js_floor(x / f), mask.width),
                clamp_index(js_floor(y / f), mask.height),
            )
        } else {
            (
                clamp_index(js_floor(x * mask.width as f64 / native_width), mask.width),
                clamp_index(
                    js_floor(y * mask.height as f64 / native_height),
                    mask.height,
                ),
            )
        };
        mask.data[yy * mask.width + xx] != 0
    }
}

/// Fills `out` (`width × height` bytes, adapter-owned — written directly, never allocated here) with
/// `RegionAtlas.labels`: 0 = owned by no region, otherwise `index + 1` into `regions`. Returns the per-code pixel
/// counts (`regions.len() + 1` entries, index 0 unused), or `None` when there are more than 254 regions (one
/// label byte can only encode 254 non-zero codes) — the ABI turns that into a status the adapter surfaces as the
/// same error `RegionAtlas`'s TS constructor used to throw, never a panic across the boundary.
pub fn label_atlas(
    regions: &[AtlasRegion],
    width: usize,
    height: usize,
    out: &mut [u8],
) -> Option<Vec<u32>> {
    if regions.len() > 254 {
        return None;
    }
    out.fill(0);
    let mut counts = vec![0u32; regions.len() + 1];
    for (index, region) in regions.iter().enumerate() {
        let code = (index + 1) as u8;
        let r = region.rect;
        let x0 = 0i64.max(js_floor(r.x) as i64) as usize;
        let y0 = 0i64.max(js_floor(r.y) as i64) as usize;
        let x1 = (width as i64).min(js_ceil(r.x + r.width) as i64).max(0) as usize;
        let y1 = (height as i64).min(js_ceil(r.y + r.height) as i64).max(0) as usize;
        for y in y0..y1.min(height) {
            for x in x0..x1.min(width) {
                let i = y * width + x;
                if out[i] == 0 && region.contains(x as f64, y as f64, width as f64, height as f64) {
                    out[i] = code;
                    counts[code as usize] += 1;
                }
            }
        }
    }
    Some(counts)
}
