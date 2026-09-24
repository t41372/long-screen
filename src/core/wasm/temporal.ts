/** Temporal-conflict block components, the per-tile write step of `overwritePatch`, and the in-memory temporal
 *  index + resolveTemporal's decision (mirrors `rust/core/src/abi/temporal.rs`): the 8-connected-components
 *  step of `Compositor.components`, the pixel write in `Compositor.overwritePatch`, and `Compositor`'s
 *  `TemporalIndex`/`resolveTemporal` (src/core/compositor.ts). */
import type { Rect, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { type FrameInput, FreeGuard, Resident, ResidentFrame } from './memory.ts';

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
/** The mutable buffers of one resident tile, as `TileStore` holds them (mirrors `wasm/compositor.ts`'s
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
 *  tile. `image` is a plain frame or a `ResidentFrame` already uploaded to the `FrameRing` for this observation
 *  (mirrors `prepareObservation`'s `residentImage` handling, src/core/wasm/compositor.ts) — a resident frame's
 *  pointer is growth-stable, so it is used in place instead of copying the whole frame (up to ~30MB at
 *  3456×2234) into scratch on every one of this call's per-tile invocations (`overwritePatch` calls this once
 *  per tile the patch touches). `tileSize` must equal `tile.pixels`'s own (native) tile size. */
export function overwriteTile(
  core: Core,
  tile: OverwriteTile,
  tileSize: number,
  image: FrameInput,
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
  const residentImage = image instanceof ResidentFrame ? image : undefined;
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
      residentImage ? 0 : image.width * image.height * 4,
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
  const rgba = residentImage ? residentImage.ptr : rgbaScratch;
  if (!residentImage) core.writeBytes(rgba, (image as RGBA).data);
  const blocksView = new DataView(core.exports.memory.buffer, blocksScratch, blockCount * 8);
  blocks.forEach(([bx, by], i) => {
    blocksView.setInt32(i * 8, bx, true);
    blocksView.setInt32(i * 8 + 4, by, true);
  });
  core.check(
    core.exports.ls_overwrite_tile(
      tileDesc,
      rgba,
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

// --- Temporal index: the in-memory record store + resolveTemporal's decision (rust/core/src/temporal.rs via
// rust/core/src/abi/temporal.rs). One `TemporalIndexHandle` per canvas, created lazily by `Compositor`. ---

/** Bytes per serialised temporal record header (mirrors `TEMPORAL_RECORD_HEADER_BYTES` in
 *  rust/core/src/abi/temporal.rs). */
const RECORD_HEADER_BYTES = 66;

/** One temporal record as `Compositor` sees it (mirrors `TemporalRegion` minus `canvasId`, src/core/compositor.ts
 *  — the index is already per-canvas, and `canvasId` is attached by the caller when building a persisted row). */
export interface TemporalRow {
  id: string;
  rect: Rect;
  /** Absolute [bx, by] block coordinates, in persisted (ascending (by, bx)) order. */
  blocks: [number, number][];
  chosenFrame: number;
  chosenTime: number;
  complete: boolean;
  revisions: number;
}

const idEncoder = new TextEncoder(), idDecoder = new TextDecoder();
function encodeId(mem: Uint8Array, at: number, id: string): void {
  mem.set(idEncoder.encode(id).subarray(0, 10), at);
}
function decodeId(mem: Uint8Array, at: number): string {
  // slice(), not subarray(): with the threads build core memory is a SharedArrayBuffer, and browsers' TextDecoder
  // rejects shared views ("The provided ArrayBufferView value must not be shared"). Deno accepts them, so only the
  // real-recording run in Chrome caught this.
  return idDecoder.decode(mem.slice(at, at + 10));
}
function writeRectAt(view: DataView, at: number, r: Rect): void {
  view.setFloat64(at, r.x, true);
  view.setFloat64(at + 8, r.y, true);
  view.setFloat64(at + 16, r.width, true);
  view.setFloat64(at + 24, r.height, true);
}
function readRectAt(view: DataView, at: number): Rect {
  return {
    x: view.getFloat64(at, true),
    y: view.getFloat64(at + 8, true),
    width: view.getFloat64(at + 16, true),
    height: view.getFloat64(at + 24, true),
  };
}
function writeRowHeader(mem: Uint8Array, view: DataView, at: number, row: Omit<TemporalRow, 'blocks'>, blockCount: number): void {
  encodeId(mem, at, row.id);
  writeRectAt(view, at + 10, row.rect);
  view.setUint32(at + 42, row.chosenFrame, true);
  view.setFloat64(at + 46, row.chosenTime, true);
  view.setUint32(at + 54, row.complete ? 1 : 0, true);
  view.setUint32(at + 58, row.revisions, true);
  view.setUint32(at + 62, blockCount, true);
}
function readRowHeader(mem: Uint8Array, view: DataView, at: number): { row: Omit<TemporalRow, 'blocks'>; blockCount: number } {
  return {
    row: {
      id: decodeId(mem, at),
      rect: readRectAt(view, at + 10),
      chosenFrame: view.getUint32(at + 42, true),
      chosenTime: view.getFloat64(at + 46, true),
      complete: view.getUint32(at + 54, true) !== 0,
      revisions: view.getUint32(at + 58, true),
    },
    blockCount: view.getUint32(at + 62, true),
  };
}
function writeBlocksAt(view: DataView, at: number, blocks: [number, number][]): void {
  blocks.forEach(([bx, by], i) => {
    view.setInt32(at + i * 8, bx, true);
    view.setInt32(at + i * 8 + 4, by, true);
  });
}
function readBlocksAt(view: DataView, at: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) out.push([view.getInt32(at + i * 8, true), view.getInt32(at + i * 8 + 4, true)]);
  return out;
}

/** The decision half of `resolveTemporal` computes without touching atlas/occlusion/consistency pixels: the
 *  caller sizes a buffer of `writeBlockCount` `(bx, by)` pairs for `maskCompleteAndCommit`. */
export interface TemporalDecideResult {
  writeBlockCount: number;
}
/** The maskComplete pixel walk plus the commit, in one call. */
export interface TemporalCommitResult {
  chosen: boolean;
  emitIncomplete: boolean;
  rect: Rect;
  writeBlocks: [number, number][];
}
export interface TemporalMaskInput {
  /** Core-resident label-plane pointer (`RegionAtlas.resident.ptr`, src/core/layers.ts) — read directly, never copied. */
  labelsPtr: number;
  atlasWidth: number;
  atlasHeight: number;
  code: number;
  occlusions: Rect[] | undefined;
  /** Undefined = no consistency mask. A `Resident`'s own `.ptr` is passed straight through (zero-copy, and
   *  growth-stable — no "read it before any other core call" requirement, unlike a live view of one); a plain
   *  `Uint8Array` is copied into scratch inside this same call (the Arena only guarantees offsets from one
   *  `scratch()` call stay valid for that one call, so it cannot be pre-copied by an earlier call and reused
   *  here). Always atlas-sized (`atlasWidth * atlasHeight` bytes) when given. */
  consistent: Uint8Array | Resident | undefined;
  ox: number;
  oy: number;
  writeBlockCount: number;
}

/** In-memory temporal index for one canvas (`TemporalIndex`, rust/core/src/temporal.rs): resolveTemporal's
 *  decision, one component at a time (`decide` then `maskCompleteAndCommit`), and the exact dirty/deleted row
 *  order `Compositor.flush()`/`dispose()` need (`flush`). `Compositor` owns one handle per canvas it has
 *  touched, created lazily and freed once (`free()`), mirroring `VotingRing`'s handle-wrapper shape
 *  (`src/core/wasm/voting.ts`). */
export class TemporalIndexHandle {
  private readonly freeGuard = new FreeGuard();
  constructor(private readonly core: Core, private readonly exports: CoreExports, private readonly handle: number) {}
  /** Seeds one persisted row — `Compositor.temporalIndex()`'s KV load loop calls this once per row, in KV scan
   *  (ascending id) order. */
  load(row: TemporalRow): void {
    const [header, blocks] = this.core.scratch([RECORD_HEADER_BYTES, row.blocks.length * 8]);
    const mem = new Uint8Array(this.exports.memory.buffer), view = new DataView(this.exports.memory.buffer);
    writeRowHeader(mem, view, header, row, row.blocks.length);
    writeBlocksAt(view, blocks, row.blocks);
    this.core.check(this.exports.ls_temporal_index_load(this.handle, header, blocks), 'temporalIndexLoad');
  }
  /** `nextSeq` mirrors `Compositor.temporalSequence` (src/core/compositor.ts): a plain counter the Compositor
   *  owns and shares across every canvas (not per-index state — a fresh id can otherwise collide across
   *  canvases). The caller threads the returned value back into its own field and into the next `decide()`
   *  call, on whichever canvas's handle that happens to be. Returns `[writeBlockCount, nextSeq]`. */
  decide(
    compBounds: Rect,
    compBlocks: [number, number][],
    frame: number,
    time: number,
    visible: Rect,
    latestPolicy: boolean,
    nextSeq: number,
  ): [number, number] {
    const [bounds, blocks, vis, out] = this.core.scratch([32, compBlocks.length * 8, 32, 12]);
    const view = new DataView(this.exports.memory.buffer);
    writeRectAt(view, bounds, compBounds);
    writeBlocksAt(view, blocks, compBlocks);
    writeRectAt(view, vis, visible);
    this.core.check(
      this.exports.ls_temporal_decide(this.handle, bounds, blocks, compBlocks.length, frame, time, vis, latestPolicy ? 1 : 0, nextSeq, out),
      'temporalDecide',
    );
    // Re-viewed after the call: it may have grown memory (a fresh HashMap/Vec allocation), detaching any
    // pre-call ArrayBuffer/DataView.
    const postView = new DataView(this.exports.memory.buffer);
    return [postView.getUint32(out, true), postView.getFloat64(out + 4, true)];
  }
  maskCompleteAndCommit(input: TemporalMaskInput): TemporalCommitResult {
    const occlusions = input.occlusions ?? [];
    const consistent = input.consistent;
    const consistentLen = consistent && !(consistent instanceof Resident) ? input.atlasWidth * input.atlasHeight : 0;
    const [occ, writeBlocksOut, out, consistentScratch] = this.core.scratch([
      occlusions.length * 32,
      input.writeBlockCount * 8,
      40,
      consistentLen,
    ]);
    const view = new DataView(this.exports.memory.buffer);
    occlusions.forEach((o, i) => writeRectAt(view, occ + i * 32, o));
    let consistentPtr = 0;
    if (consistent instanceof Resident) {
      consistentPtr = consistent.ptr;
    } else if (consistent) {
      this.core.writeBytes(consistentScratch, consistent);
      consistentPtr = consistentScratch;
    }
    this.core.check(
      this.exports.ls_temporal_mask_complete_and_commit(
        this.handle,
        input.labelsPtr,
        input.atlasWidth,
        input.atlasHeight,
        input.code,
        occlusions.length ? occ : 0,
        occlusions.length,
        consistentPtr,
        input.ox,
        input.oy,
        writeBlocksOut,
        input.writeBlockCount,
        out,
      ),
      'temporalMaskCompleteAndCommit',
    );
    const postView = new DataView(this.exports.memory.buffer);
    return {
      chosen: postView.getUint32(out, true) !== 0,
      emitIncomplete: postView.getUint32(out + 4, true) !== 0,
      rect: readRectAt(postView, out + 8),
      writeBlocks: readBlocksAt(postView, writeBlocksOut, input.writeBlockCount),
    };
  }
  /** `Compositor.flush()`/`dispose()`'s exact persisted-row order: every deleted id, then every dirty row's
   *  current content, both in insertion order. */
  flush(): { deleted: string[]; dirty: TemporalRow[] } {
    const [sizesOut] = this.core.scratch([12]);
    this.core.check(this.exports.ls_temporal_flush_sizes(this.handle, sizesOut), 'temporalFlushSizes');
    const sizesView = new DataView(this.exports.memory.buffer);
    const deletedCount = sizesView.getUint32(sizesOut, true);
    const dirtyCount = sizesView.getUint32(sizesOut + 4, true);
    const dirtyBlockTotal = sizesView.getUint32(sizesOut + 8, true);
    const [deletedOut, headersOut, blocksOut] = this.core.scratch([
      deletedCount * 10,
      dirtyCount * RECORD_HEADER_BYTES,
      dirtyBlockTotal * 8,
    ]);
    this.core.check(
      this.exports.ls_temporal_flush_take(this.handle, deletedOut, deletedCount, headersOut, blocksOut, dirtyCount),
      'temporalFlushTake',
    );
    const mem = new Uint8Array(this.exports.memory.buffer), view = new DataView(this.exports.memory.buffer);
    const deleted: string[] = [];
    for (let i = 0; i < deletedCount; i++) deleted.push(decodeId(mem, deletedOut + i * 10));
    const dirty: TemporalRow[] = [];
    let boff = blocksOut;
    for (let i = 0; i < dirtyCount; i++) {
      const { row, blockCount } = readRowHeader(mem, view, headersOut + i * RECORD_HEADER_BYTES);
      dirty.push({ ...row, blocks: readBlocksAt(view, boff, blockCount) });
      boff += blockCount * 8;
    }
    return { deleted, dirty };
  }
  free(): void {
    this.freeGuard.once(() => this.exports.ls_temporal_index_free(this.handle));
  }
}
export function newTemporalIndex(core: Core, exports: CoreExports): TemporalIndexHandle {
  return new TemporalIndexHandle(core, exports, core.check(exports.ls_temporal_index_new(), 'temporalIndexNew'));
}
