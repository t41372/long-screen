//! Pixel-ownership compositing of one placement into one tile (docs/ARCHITECTURE.md §六–七).
//!
//! This is the per-tile body of `Compositor.add()`: block-level conflict/replace decisions, coverage and
//! provisional bookkeeping, and the pixel writes themselves. Tile-cache traversal, temporal-conflict
//! records and diagnostics stay with the adapter, which owns storage.

use crate::geometry::{js_ceil, js_round, Rect};
use crate::pool::SyncPtr;

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

/// Tile geometry shared by every block of one call.
struct Geometry<'o, 'a> {
    obs: &'o Observation<'a>,
    world: Rect,
    size: i64,
    blocks: i64,
    /// Tile origin minus observation origin: `sx = x + dx`, `sy = y + dy` for tile-local (x, y).
    dx: i64,
    dy: i64,
    w: i64,
    h: i64,
    tile_x: f64,
    tile_y: f64,
}

/// Stats one chunk of block rows contributes; folded in chunk order.
#[derive(Default, Clone, Copy)]
struct Part {
    added: u32,
    conflicts: u32,
    uncertain: u32,
    provisional_delta: i32,
    changed: bool,
}

/// The block rows `by0..by1` of a tile, as disjoint sub-slices (row `by0` is local row 0).
struct Rows<'t> {
    pixels: &'t mut [u8],
    coverage: &'t mut [u8],
    provisional: &'t mut [u8],
    quality: &'t mut [u8],
    conflicts: &'t mut [u8],
    owner: &'t mut [u32],
    score: &'t mut [f32],
    frozen: &'t [u8],
    /// This call's conflict flag per block of these rows.
    flagged: &'t mut [u8],
    by0: i64,
}

/// Composites the part of `world` (region rect at its integer raster pose) that falls into tile (tx, ty).
/// Blocks are independent (each owns its pixels, coverage bits and block entries), so rows of blocks are split
/// across the pool; every count is an integer sum and the conflict list is rebuilt in (by, bx) order afterwards.
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
    if by1 <= by0 || bx1 <= bx0 {
        return stats;
    }
    let geo = Geometry {
        obs,
        world,
        size,
        blocks,
        dx: tx * size - ox,
        dy: ty * size - oy,
        w: obs.width as i64,
        h: obs.height as i64,
        tile_x: tile_rect.x,
        tile_y: tile_rect.y,
    };
    let rows = (by1 - by0) as usize;
    let chunks = crate::pool::chunks_for(rows * ((bx1 - bx0) * b * b) as usize, 16 * 1024);
    let mut parts = vec![Part::default(); chunks];
    let mut flagged = vec![0u8; rows * blocks as usize];
    let (row_px, row_bits, row_blocks) = (
        (b * size) as usize,
        (b * size / 8) as usize,
        blocks as usize,
    );
    let base = |r: usize| by0 as usize + r;
    let ptrs = (
        SyncPtr(tile.pixels.as_mut_ptr()),
        SyncPtr(tile.coverage.as_mut_ptr()),
        SyncPtr(tile.provisional.as_mut_ptr()),
        SyncPtr(tile.quality.as_mut_ptr()),
        SyncPtr(tile.conflicts.as_mut_ptr()),
        SyncPtr(tile.owner.as_mut_ptr()),
        SyncPtr(tile.score.as_mut_ptr()),
        SyncPtr(flagged.as_mut_ptr()),
        SyncPtr(parts.as_mut_ptr()),
    );
    let frozen = tile.frozen;
    crate::pool::par_for(chunks, |c| {
        let (ra, rb) = (
            crate::pool::split(rows, chunks, c),
            crate::pool::split(rows, chunks, c + 1),
        );
        if ra == rb {
            return;
        }
        let (a, n) = (base(ra), rb - ra);
        // SAFETY: chunk `c` owns block rows `a..a + n` exclusively; each buffer is row-major with the strides
        // below, so these sub-slices are disjoint across chunks and in bounds of the tile.
        let mut part = unsafe {
            Rows {
                pixels: std::slice::from_raw_parts_mut(
                    ptrs.0.get().add(a * row_px * 4),
                    n * row_px * 4,
                ),
                coverage: std::slice::from_raw_parts_mut(
                    ptrs.1.get().add(a * row_bits),
                    n * row_bits,
                ),
                provisional: std::slice::from_raw_parts_mut(
                    ptrs.2.get().add(a * row_bits),
                    n * row_bits,
                ),
                quality: std::slice::from_raw_parts_mut(
                    ptrs.3.get().add(a * row_blocks),
                    n * row_blocks,
                ),
                conflicts: std::slice::from_raw_parts_mut(
                    ptrs.4.get().add(a * row_blocks),
                    n * row_blocks,
                ),
                owner: std::slice::from_raw_parts_mut(
                    ptrs.5.get().add(a * row_blocks),
                    n * row_blocks,
                ),
                score: std::slice::from_raw_parts_mut(
                    ptrs.6.get().add(a * row_blocks),
                    n * row_blocks,
                ),
                frozen: &frozen[a * row_blocks..(a + n) * row_blocks],
                flagged: std::slice::from_raw_parts_mut(
                    ptrs.7.get().add(ra * row_blocks),
                    n * row_blocks,
                ),
                by0: a as i64,
            }
        };
        let mut sum = Part::default();
        for by in a as i64..(a + n) as i64 {
            for bx in bx0..bx1 {
                composite_block(&geo, &mut part, bx, by, &mut sum);
            }
        }
        // SAFETY: one slot per chunk.
        unsafe { *ptrs.8.get().add(c) = sum };
    });
    for p in &parts {
        stats.added += p.added;
        stats.conflicts += p.conflicts;
        stats.uncertain += p.uncertain;
        stats.provisional_delta += p.provisional_delta;
        stats.changed |= p.changed;
    }
    for r in 0..rows {
        for bx in bx0..bx1 {
            if flagged[r * blocks as usize + bx as usize] != 0 {
                stats
                    .conflict_blocks
                    .push((bx as u32, (by0 + r as i64) as u32));
            }
        }
    }
    stats
}

/// Integer x-range `[lo, hi)` of tile-local columns in `sx0..sx1` whose source column lies inside the frame.
#[inline]
fn columns(geo: &Geometry<'_, '_>, sx0: i64, sx1: i64) -> (i64, i64) {
    ((-geo.dx).max(sx0), (geo.w - geo.dx).min(sx1))
}

/// Some occlusion band covers source row `sy` (the per-pixel test is only needed then).
#[inline]
fn row_occluded(occlusions: &[Rect], sy: i64) -> bool {
    let fy = sy as f64;
    occlusions.iter().any(|o| fy >= o.y && fy < o.y + o.height)
}

/// Overlap statistics of one full 16-pixel block row: (count, overlap, identical, mismatch).
#[cfg(target_feature = "simd128")]
#[inline]
fn row_stats_simd(
    obs: &Observation<'_>,
    pixels: &[u8],
    coverage: &[u8],
    dst0: usize,
    src0: usize,
) -> (u32, u32, u32, u32) {
    use core::arch::wasm32::*;
    let inside: u32 = match obs.labels {
        None => 0xffff,
        // SAFETY: the caller established 16 in-frame source pixels starting at `src0`.
        Some((labels, code)) => unsafe {
            let l = v128_load(labels.as_ptr().add(src0) as *const v128);
            u8x16_bitmask(u8x16_eq(l, u8x16_splat(code))) as u32
        },
    };
    let cov = coverage[dst0 >> 3] as u32 | (coverage[(dst0 >> 3) + 1] as u32) << 8;
    let (mut eq, mut mism) = (0u32, 0u32);
    let rgb = u32x4_splat(0x00ff_ffff);
    let limit = u32x4_splat(75);
    for g in 0..4 {
        // SAFETY: 16 tile pixels at `dst0` and 16 source pixels at `src0` are in bounds (see caller).
        let (t, o) = unsafe {
            (
                v128_load(pixels.as_ptr().add((dst0 + 4 * g) * 4) as *const v128),
                v128_load(obs.rgba.as_ptr().add((src0 + 4 * g) * 4) as *const v128),
            )
        };
        eq |= (i32x4_bitmask(i32x4_eq(t, o)) as u32) << (4 * g);
        let d = v128_and(v128_or(u8x16_sub_sat(t, o), u8x16_sub_sat(o, t)), rgb);
        let sum = u32x4_extadd_pairwise_u16x8(u16x8_extadd_pairwise_u8x16(d));
        mism |= (i32x4_bitmask(u32x4_gt(sum, limit)) as u32) << (4 * g);
    }
    let ov = cov & inside;
    (
        inside.count_ones(),
        ov.count_ones(),
        (ov & eq).count_ones(),
        (ov & mism).count_ones(),
    )
}

fn composite_block(geo: &Geometry<'_, '_>, t: &mut Rows<'_>, bx: i64, by: i64, sum: &mut Part) {
    let obs = geo.obs;
    let world = geo.world;
    let (size, b) = (geo.size, QUALITY_BLOCK as i64);
    let (w, h) = (geo.w, geo.h);
    let (tile_x, tile_y) = (geo.tile_x, geo.tile_y);
    let ly = by - t.by0;
    let q = (ly * geo.blocks + bx) as usize;
    let inside = |src: usize| obs.labels.is_none_or(|(labels, code)| labels[src] == code);
    let (mut mismatch, mut overlap, mut count, mut identical) = (0u32, 0u32, 0u32, 0u32);
    let sy0 = js_ceil(((by * b) as f64).max(world.y - tile_y)) as i64;
    let sy1 = js_ceil((((by + 1) * b) as f64).min(world.y + world.height - tile_y)) as i64;
    let sx0 = js_ceil(((bx * b) as f64).max(world.x - tile_x)) as i64;
    let sx1 = js_ceil((((bx + 1) * b) as f64).min(world.x + world.width - tile_x)) as i64;
    let (cx0, cx1) = columns(geo, sx0, sx1);
    let full = cx0 == bx * b && cx1 == (bx + 1) * b;
    // Tile-local pixel index of (x, y) in these rows.
    let dst_of = |x: i64, y: i64| ((y - t.by0 * b) * size + x) as usize;
    for y in sy0..sy1 {
        let sy = y + geo.dy;
        if sy < 0 || sy >= h || cx1 <= cx0 {
            continue;
        }
        let occluded_row = row_occluded(obs.occlusions, sy);
        #[cfg(target_feature = "simd128")]
        if full && !occluded_row {
            let (c, o, i, m) = row_stats_simd(
                obs,
                t.pixels,
                t.coverage,
                dst_of(cx0, y),
                (sy * w + cx0 + geo.dx) as usize,
            );
            count += c;
            overlap += o;
            identical += i;
            mismatch += m;
            continue;
        }
        let _ = full;
        for x in cx0..cx1 {
            let sx = x + geo.dx;
            if occluded_row && occluded(obs.occlusions, sx, sy) {
                continue;
            }
            let src = (sy * w + sx) as usize;
            if !inside(src) {
                continue;
            }
            let dst = dst_of(x, y);
            count += 1;
            if bit(t.coverage, dst) {
                overlap += 1;
                if px32(t.pixels, dst) == px32(obs.rgba, src) {
                    identical += 1;
                    continue;
                }
                let (i, j) = (dst * 4, src * 4);
                let diff = ((t.pixels[i] as i32 - obs.rgba[j] as i32).abs()
                    + (t.pixels[i + 1] as i32 - obs.rgba[j + 1] as i32).abs()
                    + (t.pixels[i + 2] as i32 - obs.rgba[j + 2] as i32).abs())
                    as f64
                    / 3.0;
                if diff > 25.0 {
                    mismatch += 1;
                }
            }
        }
    }
    if count == 0 {
        return;
    }
    let (mut covered_in_block, mut provisional_in_block) = (0u32, 0i32);
    for row in 0..b {
        let i = dst_of(bx * b, by * b + row) >> 3;
        covered_in_block += t.coverage[i].count_ones() + t.coverage[i + 1].count_ones();
        provisional_in_block +=
            (t.provisional[i].count_ones() + t.provisional[i + 1].count_ones()) as i32;
    }
    // Exact whole-block reproduction is corroboration, not a write; but standing provisional bits still need
    // healing, so only skip when there is nothing to clear either.
    if identical == count && provisional_in_block == 0 {
        return;
    }
    let conflict = overlap >= 12 && mismatch as f64 / overlap as f64 > 0.16;
    let complete = overlap == covered_in_block;
    let edge = ((geo.tile_x as i64 + bx * b) as f64 - world.x)
        .min((geo.tile_y as i64 + by * b) as f64 - world.y)
        .min(world.x + world.width - (geo.tile_x as i64 + (bx + 1) * b) as f64)
        .min(world.y + world.height - (geo.tile_y as i64 + (by + 1) * b) as f64);
    // Integer gradient sum: every term is a small integer, so the f64 total the score uses is exact either way.
    let mut sharpness = 0u64;
    if (!conflict && t.frozen[q] == 0 && complete) || t.owner[q] == 0 {
        let (gx0, gx1) = ((1 - geo.dx).max(cx0), (w - 1 - geo.dx).min(cx1));
        for y in sy0..sy1 {
            let sy = y + geo.dy;
            if sy < 0 || sy >= h {
                continue;
            }
            let occluded_row = row_occluded(obs.occlusions, sy);
            for x in gx0..gx1 {
                let sx = x + geo.dx;
                if occluded_row && occluded(obs.occlusions, sx, sy) {
                    continue;
                }
                let src = (sy * w + sx) as usize;
                if inside(src) {
                    let j = src * 4;
                    sharpness +=
                        (obs.rgba[j - 4] as i32 - obs.rgba[j + 4] as i32).unsigned_abs() as u64;
                }
            }
        }
    }
    let had_provisional = provisional_in_block > 0;
    let score = obs.confidence * 100.0
        + (12.0f64).min(sharpness as f64 / count as f64 * 0.15)
        + (6.0f64).min(edge.max(0.0) / 40.0);
    let replace = complete && !conflict && t.frozen[q] == 0 && score > t.score[q] as f64 + 4.0;
    if conflict {
        t.conflicts[q] = 1;
        t.flagged[q] = 1;
        sum.conflicts += mismatch;
        sum.changed = true;
    }
    if replace || overlap < count || provisional_in_block > 0 {
        for y in sy0..sy1 {
            let sy = y + geo.dy;
            if sy < 0 || sy >= h {
                continue;
            }
            let occluded_row = row_occluded(obs.occlusions, sy);
            for x in cx0..cx1 {
                let sx = x + geo.dx;
                if occluded_row && occluded(obs.occlusions, sx, sy) {
                    continue;
                }
                let src = (sy * w + sx) as usize;
                if !inside(src) {
                    continue;
                }
                let dst = dst_of(x, y);
                let fresh = !bit(t.coverage, dst);
                let bad = obs.consistent.is_some_and(|c| c[src] == 0);
                let was_provisional = bit(t.provisional, dst);
                // Fresh pixels are always written; an inconsistent observation never overwrites covered content;
                // a covered provisional pixel is healed by any consistent observation; otherwise the ordinary
                // replace gate decides.
                let write = if fresh {
                    true
                } else if bad {
                    false
                } else {
                    was_provisional || replace
                };
                if !write {
                    // A rejected observation that reproduces what is stored condemns the stored pixel too.
                    if bad && !was_provisional && px32(t.pixels, dst) == px32(obs.rgba, src) {
                        set_bit(t.provisional, dst);
                        sum.provisional_delta += 1;
                        provisional_in_block += 1;
                        sum.changed = true;
                    }
                    continue;
                }
                t.pixels[dst * 4..dst * 4 + 4].copy_from_slice(&obs.rgba[src * 4..src * 4 + 4]);
                if fresh {
                    set_bit(t.coverage, dst);
                    sum.added += 1;
                    if obs.uncertain {
                        sum.uncertain += 1;
                    }
                }
                if bad {
                    if !was_provisional {
                        set_bit(t.provisional, dst);
                        sum.provisional_delta += 1;
                        provisional_in_block += 1;
                    }
                } else if was_provisional {
                    clear_bit(t.provisional, dst);
                    sum.provisional_delta -= 1;
                    provisional_in_block -= 1;
                }
                sum.changed = true;
            }
        }
    }
    // Block evidence is persisted with the tile, so any change to it must dirty the tile like a pixel write does;
    // otherwise whether it reaches storage depends on some later write happening before a flush or eviction.
    let before = (t.quality[q], t.owner[q], t.score[q].to_bits());
    let quality = js_round(obs.confidence * 255.0) as u8;
    if replace || t.owner[q] == 0 {
        t.quality[q] = quality;
        t.owner[q] = obs.frame + 1;
        t.score[q] = score as f32;
    } else if obs.uncertain {
        t.quality[q] = if t.owner[q] != 0 {
            t.quality[q].min(quality)
        } else {
            quality
        };
    }
    if had_provisional && provisional_in_block == 0 && !obs.uncertain {
        t.quality[q] = t.quality[q].max(quality);
    }
    if provisional_in_block > 0 {
        t.quality[q] = t.quality[q].min(64);
    }
    if (t.quality[q], t.owner[q], t.score[q].to_bits()) != before {
        sum.changed = true;
    }
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
