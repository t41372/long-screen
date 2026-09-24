//! RegionAtlas pixel labelling (`src/core/layers.ts::RegionAtlas`'s constructor): native-resolution pixel
//! ownership, first-containing-region-wins, plus the per-code pixel counts `RegionAtlas.count()` needs — computed
//! in the same pass so the adapter never scans the label plane a second time in TS.
//!
//! `AtlasRegion`/`AtlasMask` are `crate::region::Region`/`Mask` instantiated over borrowed mask bytes (`&'a [u8]`)
//! instead of the default `Vec<u8>` — they only need to live for this one `label_atlas` call, unlike
//! `voting.rs`'s Ring, which retains a region across many calls and must own its mask. Membership logic (Region's
//! `contains()`) is shared, not mirrored — one implementation, not two independent copies;
//! `tests/unit/parity/regions.test.ts` still exercises both instantiations through the ABI.

use crate::geometry::{js_ceil, js_floor};
use crate::region::{Mask, Region};

pub type AtlasMask<'a> = Mask<&'a [u8]>;
pub type AtlasRegion<'a> = Region<&'a [u8]>;

/// Fills `out` (`width × height` bytes, adapter-owned — written directly, never allocated here) with
/// `RegionAtlas.labels`: 0 = owned by no region, otherwise `index + 1` into `regions`. Returns the per-code pixel
/// counts (`regions.len() + 1` entries, index 0 unused), or `None` when there are more than 254 regions (one
/// label byte can only encode 254 non-zero codes) — the ABI turns that into a status the adapter surfaces as the
/// same error `RegionAtlas`'s TS constructor throws (src/core/layers.ts), never a panic across the boundary.
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
