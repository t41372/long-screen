/** Presentation-canvas synthesis (`src/core/framing.ts::buildFramedCanvas`, mirrors `rust/core/src/abi/framing.rs`):
 *  layout/coordinate mapping, background-extension statistics, and the two per-tile passes the shell drives once
 *  per output tile — `paintTile` (native chrome + background bands) and `foldEvidence` (up to four overlapping
 *  source tiles' pixels/coverage/provisional bits/block evidence). Tile-cache traversal, the O(perimeter)
 *  candidate pre-check and KV writes stay in `src/core/framing.ts`. */
import type { Rect, Region, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { LAYOUT_BYTES, VOTING_REGION_BYTES } from './exports.ts';
import type { Resident } from './memory.ts';

export interface FrameLayout {
  width: number;
  height: number;
  pane: Rect;
  content: Rect;
  dx: number;
  dy: number;
  seamX: number;
}
/** The mutable buffers of one resident tile, as `TileStore` holds them (`storage/tiles.ts::Tile`). */
export interface FramingTile {
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  provisional: Uint8Array;
  quality: Uint8Array;
  score: Float32Array;
  owner: Uint32Array;
  conflicts: Uint8Array;
  frozen: Uint8Array;
}
export interface SourceFramingTile extends FramingTile {
  sx: number;
  sy: number;
}
const SOURCE_TILE_BYTES = 40, MAX_SOURCE_TILES = 4;

function writeLayout(view: DataView, layout: FrameLayout): void {
  view.setFloat64(0, layout.pane.x, true);
  view.setFloat64(8, layout.pane.y, true);
  view.setFloat64(16, layout.pane.width, true);
  view.setFloat64(24, layout.pane.height, true);
  view.setFloat64(32, layout.content.x, true);
  view.setFloat64(40, layout.content.y, true);
  view.setFloat64(48, layout.content.width, true);
  view.setFloat64(56, layout.content.height, true);
  view.setFloat64(64, layout.dx, true);
  view.setFloat64(72, layout.dy, true);
  view.setFloat64(80, layout.seamX, true);
  view.setFloat64(88, layout.width, true);
  view.setFloat64(96, layout.height, true);
}
function readLayout(view: DataView): FrameLayout {
  return {
    pane: { x: view.getFloat64(0, true), y: view.getFloat64(8, true), width: view.getFloat64(16, true), height: view.getFloat64(24, true) },
    content: {
      x: view.getFloat64(32, true),
      y: view.getFloat64(40, true),
      width: view.getFloat64(48, true),
      height: view.getFloat64(56, true),
    },
    dx: view.getFloat64(64, true),
    dy: view.getFloat64(72, true),
    seamX: view.getFloat64(80, true),
    width: view.getFloat64(88, true),
    height: view.getFloat64(96, true),
  };
}
function writeRect(view: DataView, at: number, r: Rect): void {
  view.setFloat64(at, r.x, true);
  view.setFloat64(at + 8, r.y, true);
  view.setFloat64(at + 16, r.width, true);
  view.setFloat64(at + 24, r.height, true);
}

/** `frameLayout()`: not on the per-tile hot path (called once per canvas), so a plain `scratch()` round trip is fine. */
export function frameLayout(
  core: Core,
  exports: CoreExports,
  source: { width: number; height: number },
  pane: Rect,
  boundsWidth: number,
  boundsHeight: number,
): FrameLayout {
  const [paneP, outP] = core.scratch([32, LAYOUT_BYTES]);
  core.writeRect(paneP, pane);
  core.check(exports.ls_frame_layout(source.width, source.height, paneP, boundsWidth, boundsHeight, outP), 'frameLayout');
  return readLayout(new DataView(exports.memory.buffer, outP, LAYOUT_BYTES));
}
/** `frameCoordinate()`: test/diagnostic use only — the per-tile kernels classify pixels inline. */
export function frameCoordinate(
  core: Core,
  exports: CoreExports,
  layout: FrameLayout,
  x: number,
  y: number,
): { x: number; y: number } | undefined | null {
  const [layoutP, outP] = core.scratch([LAYOUT_BYTES, 16]);
  writeLayout(new DataView(exports.memory.buffer, layoutP, LAYOUT_BYTES), layout);
  const kind = core.check(exports.ls_frame_coordinate(layoutP, x, y, outP), 'frameCoordinate');
  if (kind === 0) return null;
  if (kind === 1) return undefined;
  const view = new DataView(exports.memory.buffer, outP, 16);
  return { x: view.getFloat64(0, true), y: view.getFloat64(8, true) };
}

/** One canvas's worth of session state for `buildFramedCanvas`: the reference frame and background statistics
 *  uploaded once, plus reused scratch slots for the per-tile calls. Dispose exactly once (the pipeline's finally). */
export interface FramingSession {
  layout: FrameLayout;
  /** Pass 1: native-chrome/background synthesis for `bounds` (`boundsFor(tx, ty)`, already tile-clipped). Only
   *  `tile.pixels`/`tile.coverage` are touched; content-rect pixels are left as `tiles.get` returned them. */
  paintTile(tile: FramingTile, bounds: Rect): void;
  /** Pass 2: folds up to four overlapping resident source tiles into `tile` at `bounds`. */
  foldEvidence(tile: FramingTile, bounds: Rect, sourceBoundsX: number, sourceBoundsY: number, sources: SourceFramingTile[]): void;
  dispose(): void;
}

/** Uploads `regions` (ignore regions here) into PERSISTENT core memory (`ls_frame_paint_tile`'s pointer is read
 *  by every tile of a session, and transient `core.scratch()` resets on the very next unrelated kernel call —
 *  e.g. the PNG decode a `tiles.get()` between two tiles can trigger — so it would silently corrupt). Caller
 *  frees the returned residents exactly once (session `dispose()`). Frees every resident it allocated itself
 *  before rethrowing (e.g. a mask-size mismatch caught partway through the `forEach` below) — otherwise a
 *  region upload thrown away by the caller (nothing left to call `dispose()` on `residents`, since the throw
 *  never returns them) would leak every allocation this function made before the error. */
function uploadRegions(core: Core, exports: CoreExports, regions: Region[]): { ptr: number; count: number; residents: Resident[] } {
  if (!regions.length) return { ptr: 0, count: 0, residents: [] };
  const residents: Resident[] = [];
  try {
    const alloc = (len: number): number => {
      if (!len) return 0;
      const r = core.alloc(len);
      residents.push(r);
      return r.ptr;
    };
    const descriptor = core.alloc(regions.length * VOTING_REGION_BYTES);
    residents.push(descriptor);
    const view = new DataView(exports.memory.buffer, descriptor.ptr, regions.length * VOTING_REGION_BYTES);
    regions.forEach((r, i) => {
      const o = i * VOTING_REGION_BYTES;
      core.writeRect(descriptor.ptr + o, r.rect);
      const exclusionsPtr = alloc((r.exclusions?.length || 0) * 32);
      (r.exclusions || []).forEach((e, k) => core.writeRect(exclusionsPtr + k * 32, e));
      view.setUint32(o + 32, exclusionsPtr, true);
      view.setUint32(o + 36, r.exclusions?.length || 0, true);
      const cropPtr = alloc(r.crop ? 32 : 0);
      if (r.crop) core.writeRect(cropPtr, r.crop);
      view.setUint32(o + 40, cropPtr, true);
      view.setUint32(o + 44, r.solid ? 1 : 0, true);
      const useMask = !!r.mask && !r.solid;
      const maskPtr = alloc(useMask ? r.mask!.byteLength : 0);
      if (useMask) {
        if (!r.maskWidth || !r.maskHeight || r.mask!.byteLength !== r.maskWidth * r.maskHeight) {
          throw new Error(`CORE_BAD_ARGUMENT: region ${r.id} mask does not match its declared ${r.maskWidth}×${r.maskHeight}.`);
        }
        core.writeBytes(maskPtr, r.mask!);
      }
      view.setUint32(o + 48, maskPtr, true);
      view.setUint32(o + 52, useMask ? r.maskWidth! : 0, true);
      view.setUint32(o + 56, useMask ? r.maskHeight! : 0, true);
      view.setUint32(o + 60, useMask ? r.factor || 0 : 0, true);
    });
    return { ptr: descriptor.ptr, count: regions.length, residents };
  } catch (error) {
    for (const r of residents) r.free();
    throw error;
  }
}

/** Opens a framing session for one presentation canvas: uploads the reference frame and computes the background
 *  rows/columns once (`ls_frame_backgrounds`), then plans reused frame-wide scratch for every subsequent
 *  `paintTile`/`foldEvidence` call (never per-pixel FFI — one call per output tile, mirroring `composite.ts`).
 *  Every persistent allocation made here (`sourceFrame`, `bgRows`, `bgColumns`, the ignore-region residents) is
 *  normally freed by the returned session's `dispose()` — but nothing calls `dispose()` on a session that was
 *  never returned, so a throw partway through this function (a bad `ls_frame_backgrounds` status, an
 *  out-of-memory `core.alloc`, or `uploadRegions` rethrowing after freeing its own residents) must free
 *  whatever this function already allocated itself before propagating the error, or that memory leaks for the
 *  rest of the session. */
export function openFramingSession(
  core: Core,
  exports: CoreExports,
  source: RGBA,
  layout: FrameLayout,
  ignoreRegions: Region[],
  tileSize: number,
): FramingSession {
  const toFree: Resident[] = [];
  try {
    const sourceFrame = core.frame(source.width, source.height);
    toFree.push(sourceFrame);
    sourceFrame.write(source.data);
    const bgRows = core.alloc(source.height * 4);
    toFree.push(bgRows);
    const bgColumns = core.alloc(source.width * 4);
    toFree.push(bgColumns);
    const [panePtr] = core.scratch([32]);
    core.writeRect(panePtr, layout.pane);
    core.check(
      exports.ls_frame_backgrounds(sourceFrame.ptr, source.width, source.height, panePtr, bgRows.ptr, bgColumns.ptr),
      'frameBackgrounds',
    );
    const { ptr: ignorePtr, count: ignoreCount, residents: ignoreResidents } = uploadRegions(core, exports, ignoreRegions);
    toFree.push(...ignoreResidents);

    const n = tileSize * tileSize, bits = Math.ceil(n / 8), blocks = (tileSize / 16) ** 2;
    const sizes: number[] = [
      LAYOUT_BYTES,
      76, // paint descriptor
      96, // fold descriptor
      n * 4, // tile.pixels
      bits, // tile.coverage
      bits, // tile.provisional
      blocks, // tile.quality
      blocks * 4, // tile.score
      blocks * 4, // tile.owner
      blocks, // tile.conflicts
      blocks, // tile.frozen
      MAX_SOURCE_TILES * SOURCE_TILE_BYTES,
    ];
    for (let i = 0; i < MAX_SOURCE_TILES; i++) sizes.push(n * 4, bits, bits, blocks, blocks * 4, blocks * 4, blocks, blocks);
    const ptr = core.scratchFrame(sizes);
    const [layoutP, paintDescP, foldDescP, tPixels, tCoverage, tProvisional, tQuality, tScore, tOwner, tConflicts, tFrozen, sourcesP] = ptr;
    writeLayout(new DataView(exports.memory.buffer, layoutP, LAYOUT_BYTES), layout);
    const sourceSlots = Array.from({ length: MAX_SOURCE_TILES }, (_, i) => ptr.slice(12 + i * 8, 12 + i * 8 + 8));

    const writeTileIn = (tile: FramingTile, which: 'pixels' | 'all') => {
      core.writeBytes(tPixels, tile.pixels);
      core.writeBytes(tCoverage, tile.coverage);
      if (which === 'all') {
        core.writeBytes(tProvisional, tile.provisional);
        core.writeBytes(tQuality, tile.quality);
        core.writeBytes(tScore, tile.score);
        core.writeBytes(tOwner, tile.owner);
        core.writeBytes(tConflicts, tile.conflicts);
        core.writeBytes(tFrozen, tile.frozen);
      }
    };
    const readTileOut = (tile: FramingTile, which: 'pixels' | 'all') => {
      const mem = new Uint8Array(exports.memory.buffer);
      tile.pixels.set(mem.subarray(tPixels, tPixels + n * 4));
      tile.coverage.set(mem.subarray(tCoverage, tCoverage + tile.coverage.byteLength));
      if (which === 'all') {
        tile.provisional.set(mem.subarray(tProvisional, tProvisional + tile.provisional.byteLength));
        tile.quality.set(mem.subarray(tQuality, tQuality + blocks));
        tile.score.set(new Float32Array(exports.memory.buffer, tScore, blocks));
        tile.owner.set(new Uint32Array(exports.memory.buffer, tOwner, blocks));
        tile.conflicts.set(mem.subarray(tConflicts, tConflicts + blocks));
        tile.frozen.set(mem.subarray(tFrozen, tFrozen + blocks));
      }
    };

    return {
      layout,
      paintTile(tile, bounds) {
        writeTileIn(tile, 'pixels');
        const view = new DataView(exports.memory.buffer, paintDescP, 76);
        view.setUint32(0, layoutP, true);
        writeRect(view, 4, bounds);
        view.setUint32(36, sourceFrame.ptr, true);
        view.setUint32(40, source.width, true);
        view.setUint32(44, source.height, true);
        view.setUint32(48, bgRows.ptr, true);
        view.setUint32(52, bgColumns.ptr, true);
        view.setUint32(56, ignorePtr, true);
        view.setUint32(60, ignoreCount, true);
        view.setUint32(64, tileSize, true);
        view.setUint32(68, tPixels, true);
        view.setUint32(72, tCoverage, true);
        core.check(exports.ls_frame_paint_tile(paintDescP), 'framePaintTile');
        readTileOut(tile, 'pixels');
      },
      foldEvidence(tile, bounds, sourceBoundsX, sourceBoundsY, sources) {
        if (sources.length > MAX_SOURCE_TILES) {
          throw new Error(`CORE_BAD_ARGUMENT: at most ${MAX_SOURCE_TILES} source tiles fold into one output tile.`);
        }
        writeTileIn(tile, 'all');
        sources.forEach((s, i) => {
          const [sp, sc, spr, sq, ssc, so, scf, sfr] = sourceSlots[i];
          core.writeBytes(sp, s.pixels);
          core.writeBytes(sc, s.coverage);
          core.writeBytes(spr, s.provisional);
          core.writeBytes(sq, s.quality);
          core.writeBytes(ssc, s.score);
          core.writeBytes(so, s.owner);
          core.writeBytes(scf, s.conflicts);
          core.writeBytes(sfr, s.frozen);
          const ev = new DataView(exports.memory.buffer, sourcesP + i * SOURCE_TILE_BYTES, SOURCE_TILE_BYTES);
          ev.setInt32(0, s.sx, true);
          ev.setInt32(4, s.sy, true);
          ev.setUint32(8, sp, true);
          ev.setUint32(12, sc, true);
          ev.setUint32(16, spr, true);
          ev.setUint32(20, sq, true);
          ev.setUint32(24, ssc, true);
          ev.setUint32(28, so, true);
          ev.setUint32(32, scf, true);
          ev.setUint32(36, sfr, true);
        });
        const view = new DataView(exports.memory.buffer, foldDescP, 96);
        view.setUint32(0, layoutP, true);
        writeRect(view, 4, bounds);
        view.setFloat64(36, sourceBoundsX, true);
        view.setFloat64(44, sourceBoundsY, true);
        view.setUint32(52, tileSize, true);
        view.setUint32(56, tPixels, true);
        view.setUint32(60, tCoverage, true);
        view.setUint32(64, tProvisional, true);
        view.setUint32(68, tQuality, true);
        view.setUint32(72, tScore, true);
        view.setUint32(76, tOwner, true);
        view.setUint32(80, tConflicts, true);
        view.setUint32(84, tFrozen, true);
        view.setUint32(88, sources.length, true);
        view.setUint32(92, sourcesP, true);
        core.check(exports.ls_frame_fold_evidence(foldDescP), 'frameFoldEvidence');
        readTileOut(tile, 'all');
      },
      dispose() {
        for (const r of toFree) r.free();
      },
    };
  } catch (error) {
    for (const r of toFree) r.free();
    throw error;
  }
}
