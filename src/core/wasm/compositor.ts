/** The engine's compositor (mirrors the `ls_compositor_*` exports in `rust/wasm/src/compositor.rs`). */
import type { Rect, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import { type BytesInput, type FrameInput, FreeGuard, Resident, ResidentFrame } from './memory.ts';
import type { CoreExports } from './exports.ts';
import type { TileCacheHandle } from './tiles.ts';
import {
  decodeId,
  readBlocksAt,
  readRowHeader,
  TEMPORAL_RECORD_HEADER_BYTES,
  type TemporalRow,
  writeBlocksAt,
  writeRowHeader,
} from './temporal.ts';

// --- The engine's compositor (`long_screen::engine::compositor` via `rust/wasm/src/compositor.rs`): one placement
// as a resumable job over the tile cache, the per-canvas temporal indexes, and the diagnostics they raise. ---

/** Layouts in `rust/wasm/src/compositor.rs`. */
const PLACEMENT_BYTES = 112, FRAME_BYTES = 20, STEP_OUT_BYTES = 80, DIAGNOSTIC_BYTES = 72;
/** `ls_compositor_begin`/`_step` statuses the caller turns into its own errors. */
export const COMPOSITOR_OUTSIDE_CANVAS = -11, COMPOSITOR_DISPOSED = -15 as const;

export interface CompositorPlacement {
  canvas: string;
  /** The region's rect on screen, its atlas code and how many pixels the atlas gives it. */
  region: Rect;
  code: number;
  ownedPixels: number;
  x: number;
  y: number;
  frame: number;
  time: number;
  confidence: number;
  uncertain: boolean;
  occlusions?: Rect[];
}
export interface CompositorFrameInput {
  image: FrameInput;
  /** The atlas label plane, resident in the core. */
  labels: Resident;
  consistent?: BytesInput;
}
export interface CompositorStats {
  added: number;
  conflicts: number;
  uncertain: number;
  tiles: number;
  /** The placed rect in canvas coordinates. */
  bounds: Rect;
  /** Net change in provisional pixels this placement contributed (set minus healed); can be negative. */
  provisionalPixels: number;
}
export type CompositorEvent =
  | { kind: 'incomplete'; frame: number; time: number; region: Rect }
  | { kind: 'conflict'; frame: number; time: number; region: Rect; confidence: number; regions: Rect[]; conflicts: number };
export type CompositorStep =
  | { kind: 'tile'; x: number; y: number }
  | { kind: 'temporal' }
  | { kind: 'done'; stats: CompositorStats; diagnostics: CompositorEvent[] };
export interface TemporalFlushRows {
  canvas: string;
  deleted: string[];
  dirty: TemporalRow[];
}

function rectAt(view: DataView, at: number): Rect {
  return {
    x: view.getFloat64(at, true),
    y: view.getFloat64(at + 8, true),
    width: view.getFloat64(at + 16, true),
    height: view.getFloat64(at + 24, true),
  };
}
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder();

export class CompositorHandle {
  private readonly freeGuard = new FreeGuard();
  /** The frame descriptor of the placement in progress, in the frame arena (it survives the PNG work between steps). */
  private frameDesc = 0;
  constructor(private readonly core: Core, private readonly exports: CoreExports, readonly handle: number) {}
  /** Plans one placement; returns 0, or `COMPOSITOR_OUTSIDE_CANVAS` when the placed rect leaves the canvas. */
  begin(tiles: TileCacheHandle, p: CompositorPlacement, frame: CompositorFrameInput): number {
    const { width, height } = frame.image, pixels = width * height;
    const residentImage = frame.image instanceof ResidentFrame ? frame.image : undefined;
    const residentConsistent = frame.consistent instanceof Resident ? frame.consistent : undefined;
    for (const [what, r] of [['labels', frame.labels], ['consistency mask', residentConsistent]] as const) {
      if (r && r.length !== pixels) throw new Error(`CORE_BAD_ARGUMENT: resident ${what} do not match the frame.`);
    }
    const [desc, rgbaScratch, consistentScratch] = this.core.scratchFrame([
      FRAME_BYTES,
      residentImage ? 0 : pixels * 4,
      frame.consistent && !residentConsistent ? pixels : 0,
    ]);
    const rgba = residentImage ? residentImage.ptr : rgbaScratch;
    if (!residentImage) this.core.writeBytes(rgba, (frame.image as RGBA).data);
    const consistent = residentConsistent ? residentConsistent.ptr : frame.consistent ? consistentScratch : 0;
    if (frame.consistent && !residentConsistent) this.core.writeBytes(consistentScratch, frame.consistent as Uint8Array);
    const fv = new DataView(this.exports.memory.buffer, desc, FRAME_BYTES);
    [rgba, width, height, frame.labels.ptr, consistent].forEach((v, i) => fv.setUint32(i * 4, v, true));
    this.frameDesc = desc;
    const canvas = textEncoder.encode(p.canvas), occlusions = p.occlusions ?? [];
    const [placement, canvasPtr, occ] = this.core.scratch([PLACEMENT_BYTES, Math.max(1, canvas.length), occlusions.length * 32]);
    this.core.writeBytes(canvasPtr, canvas);
    occlusions.forEach((r, i) => this.core.writeRect(occ + i * 32, r));
    const pv = new DataView(this.exports.memory.buffer, placement, PLACEMENT_BYTES);
    pv.setUint32(0, canvasPtr, true);
    pv.setUint32(4, canvas.length, true);
    this.core.writeRect(placement + 8, p.region);
    pv.setUint32(40, p.code, true);
    pv.setFloat64(48, p.ownedPixels, true);
    pv.setFloat64(56, p.x, true);
    pv.setFloat64(64, p.y, true);
    pv.setUint32(72, p.frame, true);
    pv.setFloat64(80, p.time, true);
    pv.setFloat64(88, p.confidence, true);
    pv.setUint32(96, p.uncertain ? 1 : 0, true);
    pv.setUint32(100, occlusions.length ? occ : 0, true);
    pv.setUint32(104, occlusions.length, true);
    const status = this.exports.ls_compositor_begin(this.handle, tiles.handle, placement, desc);
    return status === COMPOSITOR_OUTSIDE_CANVAS ? status : this.core.check(status, 'compositorBegin');
  }
  cancel(): void {
    this.exports.ls_compositor_cancel(this.handle);
  }
  /** Runs the placement until it needs a tile or temporal records, or is done; `now` stamps the tiles it writes.
   *  Returns the step, or `COMPOSITOR_DISPOSED` when the placement's canvas was disposed. */
  step(tiles: TileCacheHandle, now: number): CompositorStep | typeof COMPOSITOR_DISPOSED {
    const [out] = this.core.scratch([STEP_OUT_BYTES]);
    const status = this.exports.ls_compositor_step(this.handle, tiles.handle, this.frameDesc, now, out);
    if (status === COMPOSITOR_DISPOSED) return status;
    this.core.check(status, 'compositorStep');
    const view = new DataView(this.exports.memory.buffer, out, STEP_OUT_BYTES);
    if (status === 1) return { kind: 'tile', x: view.getInt32(0, true), y: view.getInt32(4, true) };
    if (status === 2) return { kind: 'temporal' };
    const stats: CompositorStats = {
      added: view.getFloat64(0, true),
      conflicts: view.getFloat64(8, true),
      uncertain: view.getFloat64(16, true),
      tiles: view.getFloat64(24, true),
      bounds: rectAt(view, 40),
      provisionalPixels: view.getFloat64(32, true),
    };
    const bytes = view.getUint32(72, true);
    const diagnostics: CompositorEvent[] = [];
    if (bytes) {
      const [buf] = this.core.scratch([bytes]);
      this.core.check(this.exports.ls_compositor_diagnostics(this.handle, buf), 'compositorDiagnostics');
      const d = new DataView(this.exports.memory.buffer, buf, bytes);
      for (let at = 0; at < bytes;) {
        const kind = d.getUint32(at, true), frame = d.getUint32(at + 4, true), time = d.getFloat64(at + 8, true);
        const region = rectAt(d, at + 16), count = d.getUint32(at + 64, true);
        const regions = Array.from({ length: count }, (_, i) => rectAt(d, at + DIAGNOSTIC_BYTES + i * 32));
        diagnostics.push(
          kind === 0 ? { kind: 'incomplete', frame, time, region } : {
            kind: 'conflict',
            frame,
            time,
            region,
            confidence: d.getFloat64(at + 48, true),
            regions,
            conflicts: d.getFloat64(at + 56, true),
          },
        );
        at += DIAGNOSTIC_BYTES + count * 32;
      }
    }
    return { kind: 'done', stats, diagnostics };
  }
  /** Seeds `canvas`'s temporal index from its stored rows, in ascending id order. */
  loadTemporal(canvas: string, rows: TemporalRow[]): void {
    const id = textEncoder.encode(canvas), total = rows.reduce((n, r) => n + r.blocks.length, 0);
    const [canvasPtr, headers, blocks] = this.core.scratch([Math.max(1, id.length), rows.length * TEMPORAL_RECORD_HEADER_BYTES, total * 8]);
    this.core.writeBytes(canvasPtr, id);
    const mem = new Uint8Array(this.exports.memory.buffer), view = new DataView(this.exports.memory.buffer);
    let at = blocks;
    rows.forEach((row, i) => {
      writeRowHeader(mem, view, headers + i * TEMPORAL_RECORD_HEADER_BYTES, row, row.blocks.length);
      writeBlocksAt(view, at, row.blocks);
      at += row.blocks.length * 8;
    });
    this.core.check(
      this.exports.ls_compositor_load_temporal(this.handle, canvasPtr, id.length, headers, blocks, rows.length),
      'compositorLoadTemporal',
    );
  }
  /** Temporal rows changed since the last flush, per canvas in first-loaded order. */
  flush(): TemporalFlushRows[] {
    const canvases = this.core.check(this.exports.ls_compositor_flush(this.handle), 'compositorFlush'), out: TemporalFlushRows[] = [];
    for (let c = 0; c < canvases; c++) {
      const [sizes] = this.core.scratch([16]);
      this.core.check(this.exports.ls_compositor_flush_sizes(this.handle, c, sizes), 'compositorFlushSizes');
      const sv = new DataView(this.exports.memory.buffer, sizes, 16);
      const [idBytes, deletedCount, dirtyCount, blockTotal] = [0, 1, 2, 3].map((i) => sv.getUint32(i * 4, true));
      const [idOut, deletedOut, headersOut, blocksOut] = this.core.scratch([
        Math.max(1, idBytes),
        deletedCount * 10,
        dirtyCount * TEMPORAL_RECORD_HEADER_BYTES,
        blockTotal * 8,
      ]);
      this.core.check(
        this.exports.ls_compositor_flush_take(this.handle, c, idOut, deletedOut, headersOut, blocksOut),
        'compositorFlushTake',
      );
      const mem = new Uint8Array(this.exports.memory.buffer), view = new DataView(this.exports.memory.buffer);
      const deleted = Array.from({ length: deletedCount }, (_, i) => decodeId(mem, deletedOut + i * 10));
      const dirty: TemporalRow[] = [];
      let at = blocksOut;
      for (let i = 0; i < dirtyCount; i++) {
        const { row, blockCount } = readRowHeader(mem, view, headersOut + i * TEMPORAL_RECORD_HEADER_BYTES);
        dirty.push({ ...row, blocks: readBlocksAt(view, at, blockCount) });
        at += blockCount * 8;
      }
      out.push({ canvas: textDecoder.decode(mem.slice(idOut, idOut + idBytes)), deleted, dirty });
    }
    return out;
  }
  /** Releases every canvas's index, keeping what the next `flush()` owes storage. */
  dispose(): void {
    this.exports.ls_compositor_dispose(this.handle);
  }
  free(): void {
    this.freeGuard.once(() => this.exports.ls_compositor_free(this.handle));
  }
}

export function newCompositor(
  core: Core,
  exports: CoreExports,
  latest: boolean,
  atlasWidth: number,
  atlasHeight: number,
): CompositorHandle {
  return new CompositorHandle(
    core,
    exports,
    core.check(exports.ls_compositor_new(latest ? 1 : 0, atlasWidth, atlasHeight), 'compositorNew'),
  );
}
