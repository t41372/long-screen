/** Region construction and pixel labelling (`src/core/layers.ts::LayerLearner.finish`, `RegionAtlas`), mirroring
 *  `rust/core/src/abi/regions.rs`. Three coarse-grained calls, no per-region or per-pixel round trip:
 *  `finishRegions` builds every algorithmic-path region in one call; `manualUncovered` is the one expensive step
 *  of `finish()`'s manual-region branch (the rest is cheap object marshalling `LayerLearner.finish()` keeps
 *  in TS, over data the caller already holds); `labelAtlasResident` builds `RegionAtlas`'s label plane directly
 *  into a NEW core-resident buffer (never copied out and back — the caller owns and frees it) plus the per-code
 *  pixel counts, in one call. */
import type { Rect, Region } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { REGION_HEADER_BYTES, REGIONS_FINISH_DESC_BYTES, VOTING_REGION_BYTES } from './exports.ts';
import { writeRegionDescriptor } from './marshal.ts';
import { type FrameInput, type Resident, ResidentFrame } from './memory.ts';

export interface FinishAccumulators {
  informativeFrames: number;
  nativeFrames: number;
  rowChange: Float64Array;
  colChange: Float64Array;
  colMean: Float64Array;
  colGain: Float64Array;
  horizontalGain: Float64Array;
  split: Float64Array;
  evidence: Float64Array;
  activity: Float64Array;
  observations: Float64Array;
  nativeRowChange?: Float64Array;
  nativeColChange?: Float64Array;
}

/** Builds every algorithmic-path region of `finish()` (band detection through the sticky-header cleanup) in one
 *  call. `reference` is the last informative native frame (appearance evidence), when the scan pass kept one. */
export function finishRegions(
  core: Core,
  exports: CoreExports,
  width: number,
  height: number,
  cell: number,
  acc: FinishAccumulators,
  nativeWidth: number,
  nativeHeight: number,
  factor: number,
  reference?: FrameInput,
): Region[] {
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell), n = cols * rows;
  const referenceBytes = reference && !(reference instanceof ResidentFrame) ? reference.width * reference.height * 4 : 0;
  const sizes = [
    REGIONS_FINISH_DESC_BYTES,
    height * 8,
    width * 8,
    width * 8,
    cols * 8,
    rows * 8,
    n * 2 * 8,
    n * 2 * 8,
    n * 8,
    n * 8,
    acc.nativeRowChange ? acc.nativeRowChange.length * 8 : 0,
    acc.nativeColChange ? acc.nativeColChange.length * 8 : 0,
    referenceBytes,
  ];
  const [
    desc,
    rowChangePtr,
    colChangePtr,
    colMeanPtr,
    colGainPtr,
    horizontalGainPtr,
    splitPtr,
    evidencePtr,
    activityPtr,
    observationsPtr,
    nativeRowChangePtr,
    nativeColChangePtr,
    referenceScratch,
  ] = core.scratch(sizes);
  core.writeBytes(rowChangePtr, acc.rowChange);
  core.writeBytes(colChangePtr, acc.colChange);
  core.writeBytes(colMeanPtr, acc.colMean);
  core.writeBytes(colGainPtr, acc.colGain);
  core.writeBytes(horizontalGainPtr, acc.horizontalGain);
  core.writeBytes(splitPtr, acc.split);
  core.writeBytes(evidencePtr, acc.evidence);
  core.writeBytes(activityPtr, acc.activity);
  core.writeBytes(observationsPtr, acc.observations);
  if (acc.nativeRowChange) core.writeBytes(nativeRowChangePtr, acc.nativeRowChange);
  if (acc.nativeColChange) core.writeBytes(nativeColChangePtr, acc.nativeColChange);
  const referencePtr = reference ? core.placeFrame(reference, referenceScratch) : 0;
  const view = new DataView(exports.memory.buffer, desc, REGIONS_FINISH_DESC_BYTES);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, cell, true);
  view.setFloat64(16, acc.informativeFrames, true);
  view.setFloat64(24, acc.nativeFrames, true);
  view.setUint32(32, rowChangePtr, true);
  view.setUint32(36, colChangePtr, true);
  view.setUint32(40, colMeanPtr, true);
  view.setUint32(44, colGainPtr, true);
  view.setUint32(48, horizontalGainPtr, true);
  view.setUint32(52, splitPtr, true);
  view.setUint32(56, evidencePtr, true);
  view.setUint32(60, activityPtr, true);
  view.setUint32(64, observationsPtr, true);
  view.setUint32(68, acc.nativeRowChange ? nativeRowChangePtr : 0, true);
  view.setUint32(72, acc.nativeColChange ? nativeColChangePtr : 0, true);
  view.setUint32(76, referencePtr, true);
  view.setUint32(80, reference ? reference.width : 0, true);
  view.setUint32(84, reference ? reference.height : 0, true);
  view.setFloat64(88, nativeWidth, true);
  view.setFloat64(96, nativeHeight, true);
  view.setUint32(104, factor, true);
  const handle = core.check(exports.ls_regions_finish(desc), 'regions finish');
  try {
    const count = core.check(exports.ls_regions_count(handle), 'regions count');
    const cellsTotal = core.check(exports.ls_regions_cells_total(handle), 'regions cells total');
    // Safe to re-plan the arena here (aliasing the descriptor/accumulator buffers above): `ls_regions_finish`
    // already copied everything it read into the handle's own `Vec<RegionOut>`, so nothing still borrows them.
    // `labelAtlas` below must NOT do this — see its comment.
    const [headersPtr, masksPtr, cellsPtr] = core.scratch([count * REGION_HEADER_BYTES, count * width * height, cellsTotal * 4]);
    core.check(exports.ls_regions_read_headers(handle, headersPtr), 'regions read headers');
    core.check(exports.ls_regions_read_masks(handle, masksPtr), 'regions read masks');
    core.check(exports.ls_regions_read_cells(handle, cellsPtr), 'regions read cells');
    const headers = new DataView(exports.memory.buffer, headersPtr, count * REGION_HEADER_BYTES);
    const masks = new Uint8Array(exports.memory.buffer, masksPtr, count * width * height);
    // `core.readBytes()`, not `exports.memory.buffer.slice()`: on the threads build `memory.buffer` is a
    // `SharedArrayBuffer`, and `ArrayBuffer.prototype.slice`/`SharedArrayBuffer.prototype.slice` return the same
    // buffer type as their receiver — a "copy" of a `SharedArrayBuffer` is still shared. `readBytes` instead
    // slices the `Uint8Array` *view*, and `TypedArray.prototype.slice` always allocates a plain `ArrayBuffer`
    // regardless of the source, giving a genuine copy that is safe to hand to `structuredClone`/`postMessage`/
    // IndexedDB later (see regions-parity.test.ts's shared-memory guard test).
    const cellsBytes = core.readBytes(cellsPtr, cellsTotal * 4);
    const cellIndices = new Uint32Array(cellsBytes.buffer, cellsBytes.byteOffset, cellsTotal);
    const readRect = (at: number): Rect => ({
      x: headers.getFloat64(at, true),
      y: headers.getFloat64(at + 8, true),
      width: headers.getFloat64(at + 16, true),
      height: headers.getFloat64(at + 24, true),
    });
    const out: Region[] = [];
    let cellsAt = 0;
    for (let i = 0; i < count; i++) {
      const o = i * REGION_HEADER_BYTES;
      const kind = headers.getUint32(o, true) === 1 ? 'fixed' : 'moving';
      const idIndex = headers.getUint32(o + 4, true);
      const bandSide = headers.getUint32(o + 8, true);
      const hasCells = headers.getUint32(o + 12, true) !== 0;
      const cellsCount = headers.getUint32(o + 16, true);
      const rect = readRect(o + 20);
      const crop = readRect(o + 52);
      const solid = headers.getUint32(o + 84, true) !== 0;
      const mask = masks.slice(i * width * height, (i + 1) * width * height);
      const cells = hasCells ? Array.from(cellIndices.subarray(cellsAt, cellsAt + cellsCount)) : undefined;
      cellsAt += cellsCount;
      // Object shape (key order) matches the frozen TS oracle exactly: it is part of the persisted row (F2 —
      // `this.store.put('regions', ...)` hashes key insertion order), not just data.
      let region: Region;
      if (!hasCells) {
        // The pane divider: `finish()` never gave it a `cells` array.
        region = { id: `layer-${idIndex}`, name: '固定分隔界面', kind: 'fixed', rect, mask, maskWidth: width, maskHeight: height, factor };
      } else if (cellsCount === 0) {
        // A band-expansion-created fixed region: `cells: []` at construction, never appended to.
        region = {
          id: `layer-${idIndex}`,
          name: '固定界面',
          kind: 'fixed',
          rect,
          mask,
          maskWidth: width,
          maskHeight: height,
          cells: [],
          factor,
        } as Region;
      } else {
        region = {
          id: `layer-${idIndex}`,
          name: kind === 'fixed' ? '固定界面' : `内容画布 ${idIndex + 1}`,
          kind,
          cells,
          rect,
          mask,
          maskWidth: width,
          maskHeight: height,
          factor,
        } as Region;
      }
      if (bandSide > 0) (region as Region & { bandSide?: number }).bandSide = bandSide;
      region.crop = crop;
      region.solid = solid;
      out.push(region);
    }
    return out;
  } finally {
    exports.ls_regions_free(handle);
  }
}

/** The expensive step of `finish()`'s manual-region branch: is every native pixel covered by at least one of
 *  `manual`'s rects? */
export function manualUncovered(core: Core, exports: CoreExports, manual: Rect[], nativeWidth: number, nativeHeight: number): boolean {
  if (!manual.length) return true;
  const [ptr] = core.scratch([manual.length * 32]);
  manual.forEach((r, i) => core.writeRect(ptr + i * 32, r));
  return core.check(exports.ls_regions_manual_uncovered(ptr, manual.length, nativeWidth, nativeHeight), 'regions manual uncovered') === 1;
}

const STATUS_TOO_MANY_REGIONS = -2;

/** `RegionAtlas`'s pixel labelling for `regions`, written directly into a NEW core-resident label plane (never a
 *  scratch buffer copied back out to JS — the hot compositing path reads it from core memory, see solve.ts/
 *  render.ts/compositor.ts), plus the per-code pixel counts computed in the same Rust call. Reuses the 64-byte
 *  per-region wire format `ls_voting_new` defines (rect, exclusions, crop, solid, mask). Caller owns the
 *  returned `resident` and must free it exactly once (`RegionAtlas.dispose()` / `run()`'s finally). */
export function labelAtlasResident(
  core: Core,
  exports: CoreExports,
  regions: Region[],
  width: number,
  height: number,
): { resident: Resident; counts: Uint32Array } {
  if (regions.length > 254) {
    // Matches the error `RegionAtlas`'s former all-TS constructor threw; the Rust side rejects the same limit
    // with `STATUS_TOO_MANY_REGIONS`, checked below too in case a caller bypasses this early return.
    throw new Error('Too many regions for the pixel atlas.');
  }
  // The label plane is a PERSISTENT allocation (core.alloc, freed by the caller later), not part of the
  // transient scratch arena: it must survive this call. Every transient buffer (region descriptors and the
  // small counts output) is planned in ONE scratch() call: the arena is a bump allocator that resets to its
  // start on each plan(), so a second call would silently alias — or, once large enough to regrow, invalidate —
  // the pointers this one already handed out.
  const resident = core.alloc(width * height);
  try {
    const sizes: number[] = [regions.length * VOTING_REGION_BYTES];
    for (const r of regions) {
      sizes.push((r.exclusions?.length || 0) * 32, r.crop ? 32 : 0, r.mask && !r.solid ? r.mask.byteLength : 0);
    }
    sizes.push((regions.length + 1) * 4);
    const ptr = core.scratch(sizes), base = ptr[0], countsPtr = ptr[ptr.length - 1];
    regions.forEach((r, i) => {
      const [exclusions, crop, mask] = ptr.slice(1 + i * 3, 4 + i * 3);
      writeRegionDescriptor(exports, base, i * VOTING_REGION_BYTES, r, exclusions, crop, mask);
    });
    const status = exports.ls_regions_label_atlas(base, regions.length, width, height, resident.ptr, countsPtr);
    if (status === STATUS_TOO_MANY_REGIONS) throw new Error('Too many regions for the pixel atlas.');
    core.check(status, 'regions label atlas');
    // See the shared-memory note on the identical pattern in `finishRegions` above: `readBytes` (a
    // `Uint8Array.slice()`), not `exports.memory.buffer.slice()`, so `counts` is a plain copy even on the
    // threads build's `SharedArrayBuffer`-backed memory. `RegionAtlas.counts` (src/core/layers.ts) lives for
    // the whole run, so a shared view here would silently outlive the call it came from.
    const countsBytes = core.readBytes(countsPtr, (regions.length + 1) * 4);
    const counts = new Uint32Array(countsBytes.buffer, countsBytes.byteOffset, regions.length + 1);
    return { resident, counts };
  } catch (error) {
    resident.free();
    throw error;
  }
}
