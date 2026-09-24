//! Temporal-conflict compositing: pure algorithms behind `Compositor` (src/core/compositor.ts) that do not
//! themselves touch KV storage. `components` and the pixel-write half of `overwritePatch` (`overwrite_tile`)
//! are ported here; the temporal index and the rest of `resolveTemporal`'s decision remain TS for now (see
//! docs/ARCHITECTURE.md §十 "合成与瞬态像素" for the invariants they keep).

use crate::geometry::js_round;
use std::collections::HashSet;

pub const QUALITY_BLOCK: usize = 16;

#[inline]
fn bit(bits: &[u8], p: usize) -> bool {
    bits[p >> 3] & (1 << (p & 7)) != 0
}
#[inline]
fn set_bit(bits: &mut [u8], p: usize) {
    bits[p >> 3] |= 1 << (p & 7);
}
#[inline]
fn clear_bit(bits: &mut [u8], p: usize) {
    bits[p >> 3] &= !(1 << (p & 7));
}

/// Mutable view of the tile buffers `overwrite_tile` touches. `frozen` is written here (unlike
/// `compositor::TileBuffers`, where `composite_tile` only ever reads it) because `overwritePatch` sets it under
/// the 'stable' policy.
pub struct OverwriteTile<'a> {
    pub size: usize,
    pub pixels: &'a mut [u8],
    pub coverage: &'a mut [u8],
    pub provisional: &'a mut [u8],
    pub quality: &'a mut [u8],
    pub conflicts: &'a mut [u8],
    pub owner: &'a mut [u32],
    pub frozen: &'a mut [u8],
}

#[derive(Default, Debug, PartialEq)]
pub struct OverwriteStats {
    pub added: u32,
    /// Every pixel written inside `blocks`, not only pixels whose value actually differed — mirrors
    /// `PatchResult.conflictPixels` in src/core/compositor.ts.
    pub conflict_pixels: u32,
    pub provisional_delta: i32,
    pub changed: bool,
}

/// Mirrors `Compositor.overwritePatch`'s per-tile inner loop (src/core/compositor.ts): unconditionally copies
/// every pixel of `blocks` (absolute block coordinates already restricted to this tile) from `rgba` into the
/// tile, marking coverage, healing any provisional bit, and bumping owner/quality/conflicts/frozen evidence.
/// The caller (`resolveTemporal`) has already proven the whole written set world-consistent (`maskComplete`)
/// before calling this, so every pixel here is guaranteed in-bounds — this mirrors, not re-derives, that guarantee.
#[allow(clippy::too_many_arguments)]
pub fn overwrite_tile(
    tile: &mut OverwriteTile<'_>,
    rgba: &[u8],
    img_width: i64,
    blocks: &[(i64, i64)],
    ox: i64,
    oy: i64,
    tx: i64,
    ty: i64,
    frame: u32,
    confidence: f64,
    stable: bool,
) -> OverwriteStats {
    let size = tile.size as i64;
    let b = QUALITY_BLOCK as i64;
    let per_tile = size / b;
    let mut stats = OverwriteStats::default();
    // Same rounding as `composite_tile`'s quality byte (rust/core/src/compositor.rs): Math.round, not Rust's
    // round-half-away-from-zero, for the .5 case.
    let quality = js_round(confidence * 255.0) as u8;
    for &(bx, by) in blocks {
        for y in by * b..by * b + b {
            for x in bx * b..bx * b + b {
                let src = (((y - oy) * img_width + (x - ox)) * 4) as usize;
                let dst = (((y - ty * size) * size + (x - tx * size)) * 4) as usize;
                tile.pixels[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
                let px = dst / 4;
                if !bit(tile.coverage, px) {
                    set_bit(tile.coverage, px);
                    stats.added += 1;
                }
                if bit(tile.provisional, px) {
                    clear_bit(tile.provisional, px);
                    stats.provisional_delta -= 1;
                }
                stats.changed = true;
                stats.conflict_pixels += 1;
            }
        }
        let local_bx = bx - tx * per_tile;
        let local_by = by - ty * per_tile;
        let q = (local_by * per_tile + local_bx) as usize;
        tile.owner[q] = frame + 1;
        tile.quality[q] = quality;
        tile.conflicts[q] = 1;
        if stable {
            tile.frozen[q] = 1;
        }
    }
    stats
}

/// One 8-connected component of conflicting `size`-px blocks: its bounding rect in native pixels, and every
/// block absolute coordinate that belongs to it (never just the bounding box — a concave, e.g. L-shaped,
/// conflict must not drag a pixel-identical block in its bounding box into the patch).
pub struct Component {
    pub x0: i32,
    pub y0: i32,
    pub width: i32,
    pub height: i32,
    pub blocks: Vec<(i32, i32)>,
}

/// Mirrors `Compositor.components` (src/core/compositor.ts): 8-connected components of `cells`, absolute block
/// coordinates. `cells` must already be in the caller's chosen seed order (TS sorts by tile-then-local-block
/// order before calling); a `HashSet` has no ordering guarantee, so a component's seed is the first `cells`
/// entry not yet claimed by an earlier component, walked in that same order — matching
/// `cells.values().next().value` on a `Set` built from the same sorted array. Within a component, block order
/// does not affect the result (the caller only ever treats it as a set).
pub fn components(cells: &[(i32, i32)], size: i32) -> Vec<Component> {
    let mut remaining: HashSet<(i32, i32)> = cells.iter().copied().collect();
    let mut out = Vec::new();
    for &seed in cells {
        if !remaining.remove(&seed) {
            continue;
        }
        let mut queue = vec![seed];
        let mut i = 0;
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        while i < queue.len() {
            let (x, y) = queue[i];
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let n = (x + dx, y + dy);
                    if remaining.remove(&n) {
                        queue.push(n);
                    }
                }
            }
            i += 1;
        }
        out.push(Component {
            x0: x0 * size,
            y0: y0 * size,
            width: (x1 - x0 + 1) * size,
            height: (y1 - y0 + 1) * size,
            blocks: queue,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_block() {
        let comps = components(&[(3, 4)], 16);
        assert_eq!(comps.len(), 1);
        assert_eq!(
            (comps[0].x0, comps[0].y0, comps[0].width, comps[0].height),
            (48, 64, 16, 16)
        );
        assert_eq!(comps[0].blocks, vec![(3, 4)]);
    }

    #[test]
    fn l_shape_stays_concave() {
        // An L: (0,0), (1,0), (0,1) — 8-connected, one component, but its bounding box (2x2) must not
        // silently gain the empty (1,1) cell in the output block list.
        let comps = components(&[(0, 0), (1, 0), (0, 1)], 16);
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].blocks.len(), 3);
        assert_eq!((comps[0].width, comps[0].height), (32, 32));
    }

    #[test]
    fn diagonal_touch_connects() {
        // 8-connected: a purely diagonal touch still joins one component.
        let comps = components(&[(0, 0), (1, 1)], 16);
        assert_eq!(comps.len(), 1);
    }

    #[test]
    fn disjoint_cells_split_and_keep_seed_order() {
        let comps = components(&[(0, 0), (10, 10), (0, 1)], 16);
        assert_eq!(comps.len(), 2);
        // Seed order: (0,0) is claimed first and absorbs (0,1); (10,10) starts the second component.
        assert_eq!(comps[0].blocks.len(), 2);
        assert_eq!(comps[1].blocks, vec![(10, 10)]);
    }

    #[test]
    fn overwrite_writes_pixels_and_evidence() {
        let size = 32usize;
        let blocks = (size / QUALITY_BLOCK).pow(2);
        let mut pixels = vec![0u8; size * size * 4];
        let mut coverage = vec![0u8; size * size / 8];
        let mut provisional = vec![0xffu8; size * size / 8]; // every pixel provisional beforehand
        let (mut quality, mut conflicts, mut owner, mut frozen) = (
            vec![0u8; blocks],
            vec![0u8; blocks],
            vec![0u32; blocks],
            vec![0u8; blocks],
        );
        let mut tile = OverwriteTile {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            conflicts: &mut conflicts,
            owner: &mut owner,
            frozen: &mut frozen,
        };
        let img_width = 32i64;
        let rgba: Vec<u8> = (0..img_width * img_width)
            .flat_map(|i| [i as u8, 1, 2, 255])
            .collect();
        let stats = overwrite_tile(
            &mut tile,
            &rgba,
            img_width,
            &[(0, 0)],
            0,
            0,
            0,
            0,
            3,
            0.7,
            true,
        );
        assert_eq!(stats.added, 256);
        assert_eq!(stats.conflict_pixels, 256);
        assert_eq!(stats.provisional_delta, -256);
        assert!(stats.changed);
        assert_eq!(tile.owner[0], 4);
        assert_eq!(tile.quality[0], 179); // js_round(0.7 * 255 = 178.5) rounds half up
        assert_eq!(tile.conflicts[0], 1);
        assert_eq!(tile.frozen[0], 1);
        assert_eq!(tile.pixels[0], 0);
        assert_eq!(tile.pixels[4], 1);
    }

    #[test]
    fn overwrite_respects_non_stable_policy() {
        let size = 16usize;
        let mut pixels = vec![0u8; size * size * 4];
        let mut coverage = vec![0u8; size * size / 8];
        let mut provisional = vec![0u8; size * size / 8];
        let (mut quality, mut conflicts, mut owner, mut frozen) =
            (vec![0u8; 1], vec![0u8; 1], vec![0u32; 1], vec![0u8; 1]);
        let mut tile = OverwriteTile {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            conflicts: &mut conflicts,
            owner: &mut owner,
            frozen: &mut frozen,
        };
        let rgba = vec![9u8; 16 * 16 * 4];
        overwrite_tile(&mut tile, &rgba, 16, &[(0, 0)], 0, 0, 0, 0, 0, 0.0, false);
        assert_eq!(tile.frozen[0], 0);
        assert_eq!(tile.quality[0], 0); // round(0.0 * 255)
    }
}
