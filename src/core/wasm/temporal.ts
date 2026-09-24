/** Temporal-conflict block components and the per-tile write step of `overwritePatch` (mirrors
 *  `rust/core/src/abi/temporal.rs`): the 8-connected-components step of `Compositor.components` and the pixel
 *  write in `Compositor.overwritePatch` (src/core/compositor.ts). */
import type { Rect } from '../../types.ts';
import type { Core } from './core.ts';

const HEADER_BYTES = 20;
export interface TemporalComponent {
  bounds: Rect;
  /** Absolute [bx, by] block coordinates, never just the bounding box. */
  blocks: [number, number][];
}

/** `cells` must already be in the caller's seed order (see rust/core/src/temporal.rs::components doc comment). */
export function temporalComponents(core: Core, cells: [number, number][], size: number): TemporalComponent[] {
  const n = cells.length;
  if (n === 0) return [];
  const [input, header, blocksBuf] = core.scratch([n * 8, n * HEADER_BYTES, n * 8]);
  const words = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    words[i * 2] = cells[i][0];
    words[i * 2 + 1] = cells[i][1];
  }
  core.writeBytes(input, words);
  const count = core.check(core.exports.ls_temporal_components(input, n, size, header, blocksBuf), 'temporalComponents');
  const headerView = new DataView(core.readBytes(header, count * HEADER_BYTES).buffer);
  const blocksView = new DataView(core.readBytes(blocksBuf, n * 8).buffer);
  const out: TemporalComponent[] = [];
  let boff = 0;
  for (let i = 0; i < count; i++) {
    const at = i * HEADER_BYTES;
    const bounds: Rect = {
      x: headerView.getInt32(at, true),
      y: headerView.getInt32(at + 4, true),
      width: headerView.getInt32(at + 8, true),
      height: headerView.getInt32(at + 12, true),
    };
    const blockCount = headerView.getUint32(at + 16, true);
    const blocks: [number, number][] = [];
    for (let k = 0; k < blockCount; k++) {
      blocks.push([blocksView.getInt32(boff, true), blocksView.getInt32(boff + 4, true)]);
      boff += 8;
    }
    out.push({ bounds, blocks });
  }
  return out;
}

const OVERWRITE_TILE_HEADER_BYTES = 32, OVERWRITE_OUTPUT_BYTES = 16;
/** The mutable buffers of one resident tile, as `TileStore` holds them (mirrors `wasm/composite.ts`'s
 *  `CompositeTile`, but `frozen` is written here, not only read — `overwritePatch` sets it under the 'stable'
 *  policy). */
export interface OverwriteTile {
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  provisional: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  frozen: Uint8Array;
}
export interface OverwriteStats {
  added: number;
  conflictPixels: number;
  /** Always ≤ 0 (see `PatchResult.provisionalPixels` in src/core/compositor.ts). */
  provisionalPixels: number;
  changed: boolean;
}

/** Mirrors `Compositor.overwritePatch`'s per-tile inner loop (src/core/compositor.ts): unconditionally copies
 *  every pixel of `blocks` (absolute block coordinates already restricted to this tile) from `image` into the
 *  tile. `image` is always a plain frame (`overwritePatch` is only ever called with the observation's original
 *  RGBA, never a resident frame). `tileSize` must equal `tile.pixels`'s own (native) tile size. */
export function overwriteTile(
  core: Core,
  tile: OverwriteTile,
  tileSize: number,
  image: { data: Uint8ClampedArray; width: number; height: number },
  blocks: [number, number][],
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  frame: number,
  confidence: number,
  stable: boolean,
): OverwriteStats {
  const n = tileSize * tileSize, tileBlocks = (tileSize / 16) ** 2, blockCount = blocks.length;
  const [tileDesc, tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tFrozen, rgbaScratch, blocksScratch, out] = core.scratch(
    [
      OVERWRITE_TILE_HEADER_BYTES,
      n * 4,
      Math.ceil(n / 8),
      Math.ceil(n / 8),
      tileBlocks,
      tileBlocks,
      tileBlocks * 4,
      tileBlocks,
      image.width * image.height * 4,
      blockCount * 8,
      OVERWRITE_OUTPUT_BYTES,
    ],
  );
  core.writeBytes(tPixels, tile.pixels);
  core.writeBytes(tCoverage, tile.coverage);
  core.writeBytes(tProvisional, tile.provisional);
  core.writeBytes(tQuality, tile.quality);
  core.writeBytes(tConflicts, tile.conflicts);
  core.writeBytes(tOwner, tile.owner);
  core.writeBytes(tFrozen, tile.frozen);
  const tileView = new DataView(core.exports.memory.buffer, tileDesc, OVERWRITE_TILE_HEADER_BYTES);
  [tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tFrozen].forEach((p, i) => tileView.setUint32(i * 4, p, true));
  tileView.setUint32(28, tileSize, true);
  core.writeBytes(rgbaScratch, image.data);
  const blocksView = new DataView(core.exports.memory.buffer, blocksScratch, blockCount * 8);
  blocks.forEach(([bx, by], i) => {
    blocksView.setInt32(i * 8, bx, true);
    blocksView.setInt32(i * 8 + 4, by, true);
  });
  core.check(
    core.exports.ls_overwrite_tile(
      tileDesc,
      rgbaScratch,
      image.width,
      image.height,
      blockCount ? blocksScratch : 0,
      blockCount,
      ox,
      oy,
      tx,
      ty,
      frame,
      confidence,
      stable ? 1 : 0,
      out,
    ),
    'overwriteTile',
  );
  const mem = new Uint8Array(core.exports.memory.buffer);
  const result = new DataView(core.exports.memory.buffer, out, OVERWRITE_OUTPUT_BYTES);
  const changed = result.getUint32(12, true) === 1;
  if (changed) {
    tile.pixels.set(mem.subarray(tPixels, tPixels + n * 4));
    tile.coverage.set(mem.subarray(tCoverage, tCoverage + tile.coverage.byteLength));
    tile.provisional.set(mem.subarray(tProvisional, tProvisional + tile.provisional.byteLength));
  }
  tile.quality.set(mem.subarray(tQuality, tQuality + tileBlocks));
  tile.conflicts.set(mem.subarray(tConflicts, tConflicts + tileBlocks));
  tile.owner.set(new Uint32Array(mem.buffer, tOwner, tileBlocks));
  tile.frozen.set(mem.subarray(tFrozen, tFrozen + tileBlocks));
  return {
    added: result.getUint32(0, true),
    conflictPixels: result.getUint32(4, true),
    provisionalPixels: result.getInt32(8, true),
    changed,
  };
}
