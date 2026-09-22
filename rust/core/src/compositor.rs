//! Pixel-ownership compositing of one placement into one tile (docs/ARCHITECTURE.md §六–七).
//!
//! This is the per-tile body of `Compositor.add()`: block-level conflict/replace decisions, coverage and
//! provisional bookkeeping, and the pixel writes themselves. Tile-cache traversal, temporal-conflict
//! records and diagnostics stay with the adapter, which owns storage.

use crate::geometry::{js_ceil, js_round, Rect};

pub const QUALITY_BLOCK: usize = 16;

/// Mutable view of one resident tile's buffers.
pub struct TileBuffers<'a> {
    pub size: usize,
    pub pixels: &'a mut [u8],
    pub coverage: &'a mut [u8],
    pub provisional: &'a mut [u8],
    pub quality: &'a mut [u8],
    pub conflicts: &'a mut [u8],
    pub owner: &'a mut [u32],
    pub score: &'a mut [f32],
    pub frozen: &'a [u8],
}

pub struct Observation<'a> {
    pub rgba: &'a [u8],
    pub width: usize,
    pub height: usize,
    /// Atlas label plane; `None` when the region is rectangular and fully owned (fast path).
    pub labels: Option<(&'a [u8], u8)>,
    pub occlusions: &'a [Rect],
    /// Per-pixel world-consistency mask (1 = consistent); `None` treats every pixel as consistent.
    pub consistent: Option<&'a [u8]>,
    pub confidence: f64,
    pub uncertain: bool,
    pub frame: u32,
}

#[derive(Default, Debug, PartialEq)]
pub struct TileStats {
    pub added: u32,
    pub conflicts: u32,
    pub uncertain: u32,
    pub provisional_delta: i32,
    pub changed: bool,
    /// Blocks flagged conflicting this call, as tile-local (bx, by).
    pub conflict_blocks: Vec<(u32, u32)>,
}

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
#[inline]
fn occluded(occlusions: &[Rect], sx: i64, sy: i64) -> bool {
    occlusions.iter().any(|o| o.contains(sx as f64, sy as f64))
}
#[inline]
fn px32(rgba: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([
        rgba[i * 4],
        rgba[i * 4 + 1],
        rgba[i * 4 + 2],
        rgba[i * 4 + 3],
    ])
}

/// Composites the part of `world` (region rect at its integer raster pose) that falls into tile (tx, ty).
#[allow(clippy::too_many_arguments)]
pub fn composite_tile(
    tile: &mut TileBuffers<'_>,
    obs: &Observation<'_>,
    world: Rect,
    ox: i64,
    oy: i64,
    tx: i64,
    ty: i64,
) -> TileStats {
    let size = tile.size as i64;
    let b = QUALITY_BLOCK as i64;
    let blocks = size / b;
    let (w, h) = (obs.width as i64, obs.height as i64);
    let mut stats = TileStats::default();
    let tile_rect = Rect {
        x: (tx * size) as f64,
        y: (ty * size) as f64,
        width: size as f64,
        height: size as f64,
    };
    let px = world.x.max(tile_rect.x);
    let py = world.y.max(tile_rect.y);
    let pw = ((world.x + world.width).min(tile_rect.x + tile_rect.width) - px).max(0.0);
    let ph = ((world.y + world.height).min(tile_rect.y + tile_rect.height) - py).max(0.0);
    let bx0 = ((px - tile_rect.x) / b as f64).floor() as i64;
    let by0 = ((py - tile_rect.y) / b as f64).floor() as i64;
    let bx1 = js_ceil((px + pw - tile_rect.x) / b as f64) as i64;
    let by1 = js_ceil((py + ph - tile_rect.y) / b as f64) as i64;
    let inside = |src: usize| obs.labels.is_none_or(|(labels, code)| labels[src] == code);
    for by in by0..by1 {
        for bx in bx0..bx1 {
            let q = (by * blocks + bx) as usize;
            let (mut mismatch, mut overlap, mut count, mut identical) = (0u32, 0u32, 0u32, 0u32);
            let sy0 = js_ceil(((by * b) as f64).max(world.y - tile_rect.y)) as i64;
            let sy1 =
                js_ceil((((by + 1) * b) as f64).min(world.y + world.height - tile_rect.y)) as i64;
            let sx0 = js_ceil(((bx * b) as f64).max(world.x - tile_rect.x)) as i64;
            let sx1 =
                js_ceil((((bx + 1) * b) as f64).min(world.x + world.width - tile_rect.x)) as i64;
            for y in sy0..sy1 {
                let sy = ty * size + y - oy;
                if sy < 0 || sy >= h {
                    continue;
                }
                for x in sx0..sx1 {
                    let sx = tx * size + x - ox;
                    if sx < 0 || sx >= w || occluded(obs.occlusions, sx, sy) {
                        continue;
                    }
                    let src = (sy * w + sx) as usize;
                    if !inside(src) {
                        continue;
                    }
                    let dst = (y * size + x) as usize;
                    count += 1;
                    if bit(tile.coverage, dst) {
                        overlap += 1;
                        if px32(tile.pixels, dst) == px32(obs.rgba, src) {
                            identical += 1;
                            continue;
                        }
                        let (i, j) = (dst * 4, src * 4);
                        let diff = ((tile.pixels[i] as i32 - obs.rgba[j] as i32).abs()
                            + (tile.pixels[i + 1] as i32 - obs.rgba[j + 1] as i32).abs()
                            + (tile.pixels[i + 2] as i32 - obs.rgba[j + 2] as i32).abs())
                            as f64
                            / 3.0;
                        if diff > 25.0 {
                            mismatch += 1;
                        }
                    }
                }
            }
            if count == 0 {
                continue;
            }
            let (mut covered_in_block, mut provisional_in_block) = (0u32, 0i32);
            for row in 0..b {
                let i = (((by * b + row) * size + bx * b) >> 3) as usize;
                covered_in_block +=
                    tile.coverage[i].count_ones() + tile.coverage[i + 1].count_ones();
                provisional_in_block += (tile.provisional[i].count_ones()
                    + tile.provisional[i + 1].count_ones())
                    as i32;
            }
            // Exact whole-block reproduction is corroboration, not a write; but standing provisional bits still
            // need healing, so only skip when there is nothing to clear either.
            if identical == count && provisional_in_block == 0 {
                continue;
            }
            let conflict = overlap >= 12 && mismatch as f64 / overlap as f64 > 0.16;
            let complete = overlap == covered_in_block;
            let edge = ((tx * size + bx * b) as f64 - world.x)
                .min((ty * size + by * b) as f64 - world.y)
                .min(world.x + world.width - (tx * size + (bx + 1) * b) as f64)
                .min(world.y + world.height - (ty * size + (by + 1) * b) as f64);
            let mut sharpness = 0f64;
            if (!conflict && tile.frozen[q] == 0 && complete) || tile.owner[q] == 0 {
                for y in sy0..sy1 {
                    let sy = ty * size + y - oy;
                    if sy < 0 || sy >= h {
                        continue;
                    }
                    for x in sx0..sx1 {
                        let sx = tx * size + x - ox;
                        if sx <= 0 || sx >= w - 1 || occluded(obs.occlusions, sx, sy) {
                            continue;
                        }
                        let src = (sy * w + sx) as usize;
                        if inside(src) {
                            let j = src * 4;
                            sharpness +=
                                (obs.rgba[j - 4] as i32 - obs.rgba[j + 4] as i32).abs() as f64;
                        }
                    }
                }
            }
            let had_provisional = provisional_in_block > 0;
            let score = obs.confidence * 100.0
                + (12.0f64).min(sharpness / count as f64 * 0.15)
                + (6.0f64).min(edge.max(0.0) / 40.0);
            let replace =
                complete && !conflict && tile.frozen[q] == 0 && score > tile.score[q] as f64 + 4.0;
            if conflict {
                tile.conflicts[q] = 1;
                stats.conflict_blocks.push((bx as u32, by as u32));
                stats.conflicts += mismatch;
                stats.changed = true;
            }
            if replace || overlap < count || provisional_in_block > 0 {
                for y in sy0..sy1 {
                    let sy = ty * size + y - oy;
                    if sy < 0 || sy >= h {
                        continue;
                    }
                    for x in sx0..sx1 {
                        let sx = tx * size + x - ox;
                        if sx < 0 || sx >= w || occluded(obs.occlusions, sx, sy) {
                            continue;
                        }
                        let src = (sy * w + sx) as usize;
                        if !inside(src) {
                            continue;
                        }
                        let dst = (y * size + x) as usize;
                        let fresh = !bit(tile.coverage, dst);
                        let bad = obs.consistent.is_some_and(|c| c[src] == 0);
                        let was_provisional = bit(tile.provisional, dst);
                        // Fresh pixels are always written; an inconsistent observation never overwrites covered
                        // content; a covered provisional pixel is healed by any consistent observation; otherwise
                        // the ordinary replace gate decides.
                        let write = if fresh {
                            true
                        } else if bad {
                            false
                        } else {
                            was_provisional || replace
                        };
                        if !write {
                            // A rejected observation that reproduces what is stored condemns the stored pixel too.
                            if bad
                                && !was_provisional
                                && px32(tile.pixels, dst) == px32(obs.rgba, src)
                            {
                                set_bit(tile.provisional, dst);
                                stats.provisional_delta += 1;
                                provisional_in_block += 1;
                                stats.changed = true;
                            }
                            continue;
                        }
                        tile.pixels[dst * 4..dst * 4 + 4]
                            .copy_from_slice(&obs.rgba[src * 4..src * 4 + 4]);
                        if fresh {
                            set_bit(tile.coverage, dst);
                            stats.added += 1;
                            if obs.uncertain {
                                stats.uncertain += 1;
                            }
                        }
                        if bad {
                            if !was_provisional {
                                set_bit(tile.provisional, dst);
                                stats.provisional_delta += 1;
                                provisional_in_block += 1;
                            }
                        } else if was_provisional {
                            clear_bit(tile.provisional, dst);
                            stats.provisional_delta -= 1;
                            provisional_in_block -= 1;
                        }
                        stats.changed = true;
                    }
                }
            }
            let quality = js_round(obs.confidence * 255.0) as u8;
            if replace || tile.owner[q] == 0 {
                tile.quality[q] = quality;
                tile.owner[q] = obs.frame + 1;
                tile.score[q] = score as f32;
            } else if obs.uncertain {
                tile.quality[q] = if tile.owner[q] != 0 {
                    tile.quality[q].min(quality)
                } else {
                    quality
                };
            }
            if had_provisional && provisional_in_block == 0 && !obs.uncertain {
                tile.quality[q] = tile.quality[q].max(quality);
            }
            if provisional_in_block > 0 {
                tile.quality[q] = tile.quality[q].min(64);
            }
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_pixels_are_written_and_counted() {
        let size = 32usize;
        let mut pixels = vec![0u8; size * size * 4];
        let mut coverage = vec![0u8; size * size / 8];
        let mut provisional = vec![0u8; size * size / 8];
        let blocks = (size / QUALITY_BLOCK).pow(2);
        let (mut quality, mut conflicts, mut owner, mut score, frozen) = (
            vec![0u8; blocks],
            vec![0u8; blocks],
            vec![0u32; blocks],
            vec![0f32; blocks],
            vec![0u8; blocks],
        );
        let mut tile = TileBuffers {
            size,
            pixels: &mut pixels,
            coverage: &mut coverage,
            provisional: &mut provisional,
            quality: &mut quality,
            conflicts: &mut conflicts,
            owner: &mut owner,
            score: &mut score,
            frozen: &frozen,
        };
        let rgba: Vec<u8> = (0..20 * 10).flat_map(|i| [i as u8, 7, 9, 255]).collect();
        let obs = Observation {
            rgba: &rgba,
            width: 20,
            height: 10,
            labels: None,
            occlusions: &[],
            consistent: None,
            confidence: 0.9,
            uncertain: false,
            frame: 3,
        };
        let world = Rect {
            x: 5.0,
            y: 6.0,
            width: 20.0,
            height: 10.0,
        };
        let stats = composite_tile(&mut tile, &obs, world, 5, 6, 0, 0);
        assert_eq!(stats.added, 200);
        assert!(stats.changed && stats.conflict_blocks.is_empty());
        assert_eq!(tile.owner[0], 4);
        assert_eq!(tile.pixels[(6 * size + 5) * 4], 0);
        assert_eq!(tile.pixels[(6 * size + 6) * 4], 1);
    }
}
