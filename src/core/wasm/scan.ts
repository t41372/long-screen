/** The scan pass's engine session and the motion estimate it runs per frame (mirrors `rust/wasm/src/scan.rs`, over
 *  `rust/engine/src/scan.rs`). Marshalling only: the session decides duplicates, motion, layer learning, the rows
 *  and the diagnostics; this module copies frames in and decodes what comes back into the page's own objects. */
import type { CompactFeatures, Feature, Gray, Motion, MotionField, Region, RGBA, ScanRecord } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { MOTION_BYTES, MOTION_CELL, MOTION_FIELD_HEADER } from './exports.ts';
import { writeFeatures } from './features.ts';
import { ByteReader, takeResult } from './bytes.ts';
import { FreeGuard } from './memory.ts';
import { readFinished, writeManual } from './regions.ts';
import { type EngineDiagnostic, readDiagnostics } from './diagnostic.ts';

/** One analysed frame: its `scan/<frame>` row, its `scan-features/<frame>` row (absent for a duplicate), whether it
 *  was the run's first frame, and its diagnostics. */
export interface ScanStep {
  record: ScanRecord;
  features?: CompactFeatures;
  first: boolean;
  diagnostics: EngineDiagnostic[];
}

/** Decodes a motion field (`write_field` in rust/wasm/src/scan.rs). The persisted object's key order is the one the
 *  branch that laid the field out has always produced: the first frame's stand-in field, or an estimated one (a
 *  duplicate frame keeps its predecessor's), because the scenario fingerprint hashes key order. */
export function readField(r: ByteReader, initial: boolean): MotionField {
  const cols = r.u32(), rows = r.u32(), cell = r.u32(), count = r.u32();
  const difference = r.f64(), featureCount = r.u32(), unknown = r.u32() === 1, zoom = r.f64();
  const motionBytes = r.take(count * MOTION_BYTES), view = new DataView(motionBytes.buffer), motions: Motion[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * MOTION_BYTES;
    motions.push({
      x: view.getFloat64(o, true),
      y: view.getFloat64(o + 8, true),
      support: view.getUint32(o + 16, true),
      unique: view.getUint32(o + 20, true),
      confidence: view.getFloat64(o + 24, true),
      error: view.getFloat64(o + 32, true),
      ambiguous: view.getUint32(o + 40, true) === 1,
    });
  }
  const n = cols * rows, labels = r.take(n), confidence = r.take(n), dynamic = r.take(n);
  return initial
    ? { motions, labels, confidence, dynamic, cols, rows, cell, difference, featureCount, unknown, zoom }
    : { cols, rows, cell, motions, difference, featureCount, unknown, zoom, labels, confidence, dynamic };
}

/** A scan over `width × height` native frames at the integer analysis `factor`. */
export class ScanSession {
  private readonly freeGuard = new FreeGuard();
  readonly analysisWidth: number;
  readonly analysisHeight: number;
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly width: number,
    readonly height: number,
    readonly factor: number,
  ) {
    this.analysisWidth = Math.max(1, Math.ceil(width / factor));
    this.analysisHeight = Math.max(1, Math.ceil(height / factor));
  }
  /** Copies the next frame's RGBA into the session's own frame buffer (its size must be the session's). */
  write(image: RGBA): void {
    if (image.width !== this.width || image.height !== this.height) {
      throw new Error(`CORE_BAD_ARGUMENT: frame ${image.width}×${image.height} does not fit a ${this.width}×${this.height} scan.`);
    }
    const ptr = this.exports.ls_scan_frame(this.handle);
    if (!ptr) throw new Error('CORE_BAD_ARGUMENT: scan frame buffer.');
    new Uint8Array(this.exports.memory.buffer).set(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), ptr);
  }
  /** Whether the written frame repeats the previous one exactly (it then needs no analysis gray). */
  isDuplicate(): boolean {
    return this.core.check(this.exports.ls_scan_is_duplicate(this.handle), 'scan duplicate') === 1;
  }
  /** Analyses the written frame; `gray` is the host's own analysis gray (WebGPU), else the session computes it. */
  push(index: number, time: number, duration: number, gray?: Gray): ScanStep {
    let grayPtr = 0;
    if (gray) {
      [grayPtr] = this.core.scratch([gray.data.byteLength]);
      this.core.writeBytes(grayPtr, gray.data);
    }
    const length = this.core.check(
      this.exports.ls_scan_push(this.handle, index, time, duration, grayPtr, gray ? gray.data.byteLength : 0),
      'scan step',
    );
    const r = this.result(length, 'scan step result'), flags = r.u32();
    const duplicate = (flags & 1) !== 0, field = readField(r, (flags & 4) !== 0);
    let features: CompactFeatures | undefined;
    if (flags & 8) {
      const n = r.u32();
      features = {
        xy: new Int16Array(r.take(n * 4).buffer),
        score: new Float32Array(r.take(n * 4).buffer),
        descriptors: new Uint32Array(r.take(n * 32).buffer),
      };
    }
    return {
      record: { index, time, duration, field, duplicate },
      features,
      first: (flags & 2) !== 0,
      diagnostics: readDiagnostics(r),
    };
  }
  /** The run's regions (from `manual` when the settings place them by hand) and the diagnostics about them. */
  finish(manual: Region[]): { regions: Region[]; diagnostics: EngineDiagnostic[] } {
    const manualPtr = writeManual(this.core, this.exports, manual);
    const length = this.core.check(this.exports.ls_scan_finish(this.handle, manualPtr, manual.length), 'scan finish');
    const r = this.result(length, 'scan finish result'), diagnostics = readDiagnostics(r);
    return { regions: readFinished(this.core, this.exports, r, this.analysisWidth, this.analysisHeight, this.factor, manual), diagnostics };
  }
  private result(length: number, what: string): ByteReader {
    return takeResult(this.core, length, (out, n) => this.exports.ls_scan_take(this.handle, out, n), what);
  }
  free(): void {
    this.freeGuard.once(() => {
      this.exports.ls_scan_free(this.handle);
      this.handle = 0;
    });
  }
}

export function scanSession(core: Core, exports: CoreExports, width: number, height: number, factor: number): ScanSession {
  const handle = core.check(exports.ls_scan_new(width, height, factor), 'scan session');
  return new ScanSession(core, exports, handle, width, height, factor);
}

/** Motion from analysis frame `a` to `b`, matching the given features (extracted in the core when absent); a paused
 *  pair skips matching (rust/engine/src/scan.rs `estimate_motion`). */
export function estimateMotion(core: Core, exports: CoreExports, a: Gray, b: Gray, af?: Feature[], bf?: Feature[]): MotionField {
  if (a.width !== b.width || a.height !== b.height) throw new Error('FRAME_GEOMETRY_CHANGED');
  const capacity = MOTION_FIELD_HEADER + 8 * MOTION_BYTES + 3 * Math.ceil(a.width / MOTION_CELL) * Math.ceil(a.height / MOTION_CELL);
  const [pa, pb, pfa, pfb, out] = core.scratch([
    a.data.byteLength,
    b.data.byteLength,
    (af?.length ?? 0) * core.featureBytes,
    (bf?.length ?? 0) * core.featureBytes,
    capacity,
  ]);
  core.writeBytes(pa, a.data);
  core.writeBytes(pb, b.data);
  if (af) writeFeatures(core, pfa, af);
  if (bf) writeFeatures(core, pfb, bf);
  const length = core.check(
    exports.ls_scan_estimate_motion(
      pa,
      pb,
      a.width,
      a.height,
      pfa,
      af?.length ?? 0,
      pfb,
      bf?.length ?? 0,
      (af ? 1 : 0) | (bf ? 2 : 0),
      out,
    ),
    'estimateMotion',
  );
  return readField(new ByteReader(core.readBytes(out, length)), false);
}
