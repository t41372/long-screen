/** Tile compositing: merges one prepared observation into a resident tile's pixels, coverage and quality
 *  bookkeeping (mirrors `rust/core/src/abi/compositor.rs`). */
import type { Rect, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import { type BytesInput, type FrameInput, Resident, ResidentFrame } from './memory.ts';
import { COMPOSITE_HEADER } from './exports.ts';

/** The mutable buffers of one resident tile, as `TileStore` holds them. */
export interface CompositeTile {
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  provisional: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen: Uint8Array;
  disputes?: Uint8Array;
}
export interface CompositeObservation {
  image: FrameInput;
  /** Atlas labels and this region's code; omitted for a rectangular region that owns its whole rect. */
  mask?: { labels: BytesInput; code: number };
  occlusions?: Rect[];
  consistent?: BytesInput;
  noise?: number;
  confidence: number;
  uncertain: boolean;
  frame: number;
}
export interface CompositeTileStats {
  added: number;
  conflicts: number;
  uncertain: number;
  provisionalPixels: number;
  changed: boolean;
  /** Tile-local block coordinates flagged conflicting by this call. */
  conflictBlocks: [number, number][];
}

/** Keeps one observation resident across the tiles of a frame so the frame is copied into Wasm memory once. */
export interface PreparedObservation {
  compositeTile(tile: CompositeTile, world: Rect, ox: number, oy: number, tx: number, ty: number): CompositeTileStats;
}

/** Plans the frame-wide observation buffers once; each `compositeTile` call then only moves one tile. */
export function prepareObservation(core: Core, obs: CompositeObservation, tileSize: number): PreparedObservation {
  const { width, height } = obs.image, pixels = width * height, n = tileSize * tileSize, blocks = (tileSize / 16) ** 2;
  const occlusions = obs.occlusions || [];
  const residentImage = obs.image instanceof ResidentFrame ? obs.image : undefined;
  const residentLabels = obs.mask?.labels instanceof Resident ? obs.mask.labels : undefined;
  const residentConsistent = obs.consistent instanceof Resident ? obs.consistent : undefined;
  for (const [what, r] of [['labels', residentLabels], ['consistency mask', residentConsistent]] as const) {
    if (r && r.length !== pixels) throw new Error(`CORE_BAD_ARGUMENT: resident ${what} do not match the frame.`);
  }
  const ptr = core.scratchFrame([
    residentImage ? 0 : pixels * 4,
    obs.mask && !residentLabels ? pixels : 0,
    occlusions.length * 32,
    obs.consistent && !residentConsistent ? pixels : 0,
    64,
    32,
    COMPOSITE_HEADER + 8 * blocks,
    40,
    n * 4,
    Math.ceil(n / 8),
    Math.ceil(n / 8),
    blocks,
    blocks,
    blocks * 4,
    blocks * 4,
    blocks,
    blocks,
  ]);
  const [
    rgbaScratch,
    labelsScratch,
    occ,
    consistentScratch,
    desc,
    world,
    output,
    tileDesc,
    tPixels,
    tCoverage,
    tProvisional,
    tQuality,
    tConflicts,
    tOwner,
    tScore,
    tFrozen,
    tDisputes,
  ] = ptr;
  const rgba = residentImage ? residentImage.ptr : rgbaScratch;
  if (!residentImage) core.writeBytes(rgba, (obs.image as RGBA).data);
  const labels = residentLabels ? residentLabels.ptr : labelsScratch;
  if (obs.mask && !residentLabels) core.writeBytes(labels, obs.mask.labels as Uint8Array);
  occlusions.forEach((r, i) => core.writeRect(occ + i * 32, r));
  const consistent = residentConsistent ? residentConsistent.ptr : consistentScratch;
  if (obs.consistent && !residentConsistent) core.writeBytes(consistent, obs.consistent as Uint8Array);
  const view = new DataView(core.exports.memory.buffer, desc, 64);
  view.setUint32(0, rgba, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, obs.mask ? labels : 0, true);
  view.setUint32(16, obs.mask?.code ?? 0, true);
  view.setUint32(20, occlusions.length ? occ : 0, true);
  view.setUint32(24, occlusions.length, true);
  view.setUint32(28, obs.consistent ? consistent : 0, true);
  view.setFloat64(32, obs.confidence, true);
  view.setUint32(40, obs.uncertain ? 1 : 0, true);
  view.setUint32(44, obs.frame, true);
  view.setFloat64(48, obs.noise ?? 0, true);
  const tileView = new DataView(core.exports.memory.buffer, tileDesc, 40);
  [tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tScore, tFrozen].forEach((p, i) => tileView.setUint32(i * 4, p, true));
  tileView.setUint32(32, tileSize, true);
  return {
    compositeTile: (tile, rect, ox, oy, tx, ty) => {
      if (tile.pixels.byteLength !== n * 4) throw new Error('CORE_BAD_ARGUMENT: tile size differs from the prepared observation.');
      core.writeBytes(tPixels, tile.pixels);
      core.writeBytes(tCoverage, tile.coverage);
      core.writeBytes(tProvisional, tile.provisional);
      core.writeBytes(tQuality, tile.quality);
      core.writeBytes(tConflicts, tile.conflicts);
      core.writeBytes(tOwner, tile.owner);
      core.writeBytes(tScore, tile.score);
      core.writeBytes(tFrozen, tile.frozen);
      if (tile.disputes) core.writeBytes(tDisputes, tile.disputes);
      new DataView(core.exports.memory.buffer, tileDesc, 40).setUint32(36, tile.disputes ? tDisputes : 0, true);
      core.writeRect(world, rect);
      core.check(core.exports.ls_composite_tile(tileDesc, desc, world, ox, oy, tx, ty, output), 'compositeTile');
      const result = new DataView(core.exports.memory.buffer, output, COMPOSITE_HEADER + 8 * blocks);
      const changed = result.getUint32(16, true) === 1,
        count = result.getUint32(20, true),
        mem = new Uint8Array(core.exports.memory.buffer);
      if (changed) {
        tile.pixels.set(mem.subarray(tPixels, tPixels + n * 4));
        tile.coverage.set(mem.subarray(tCoverage, tCoverage + tile.coverage.byteLength));
        tile.provisional.set(mem.subarray(tProvisional, tProvisional + tile.provisional.byteLength));
      }
      // Block metadata can change without any pixel write (quality caps, ownership, conflicts).
      tile.quality.set(mem.subarray(tQuality, tQuality + blocks));
      tile.conflicts.set(mem.subarray(tConflicts, tConflicts + blocks));
      tile.owner.set(new Uint32Array(mem.buffer, tOwner, blocks));
      tile.score.set(new Float32Array(mem.buffer, tScore, blocks));
      if (tile.disputes) tile.disputes.set(mem.subarray(tDisputes, tDisputes + blocks));
      const conflictBlocks: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        conflictBlocks.push([result.getUint32(COMPOSITE_HEADER + i * 8, true), result.getUint32(COMPOSITE_HEADER + i * 8 + 4, true)]);
      }
      return {
        added: result.getUint32(0, true),
        conflicts: result.getUint32(4, true),
        uncertain: result.getUint32(8, true),
        provisionalPixels: result.getInt32(12, true),
        changed,
        conflictBlocks,
      };
    },
  };
}
