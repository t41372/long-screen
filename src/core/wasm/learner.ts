/** Layer-learner handles: accumulates per-frame motion-discontinuity evidence across a whole recording
 *  (mirrors `rust/core/src/abi/learner.rs`). */
import type { Gray, MotionField } from '../../types.ts';
import type { Core } from './core.ts';
import { type FrameInput, ResidentFrame } from './memory.ts';
import type { CoreExports } from './exports.ts';
import { LEARNER_FIELD_BYTES, LEARNER_MOTION_BYTES } from './exports.ts';

/** Accumulators of the core-resident layer learner, read back once for `LayerLearner.finish()`. */
export interface LearnerAccumulators {
  split: Float64Array;
  evidence: Float64Array;
  activity: Float64Array;
  observations: Float64Array;
  rowFixed: Float64Array;
  rowMoving: Float64Array;
  rowChange: Float64Array;
  colChange: Float64Array;
  colMean: Float64Array;
  colGain: Float64Array;
  horizontalGain: Float64Array;
  nativeRowChange?: Float64Array;
  nativeColChange?: Float64Array;
  nativeColMean?: Float64Array;
  informativeFrames: number;
  nativeFrames: number;
}
const LEARNER_ARRAYS = [
  'split',
  'evidence',
  'activity',
  'observations',
  'rowFixed',
  'rowMoving',
  'rowChange',
  'colChange',
  'colMean',
  'colGain',
  'horizontalGain',
  'nativeRowChange',
  'nativeColChange',
  'nativeColMean',
] as const;

/** Core-resident layer-learning accumulators (rust/core/src/layers.rs): one `add()` per informative motion field
 *  during the scan pass, `read()` once for `finish()`, `free()` always. */
export class LearnerHandle {
  private freed = false;
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly width: number,
    readonly height: number,
  ) {}
  /** Returns whether the field was informative (and therefore accumulated). Native frames are optional and may
   *  already be resident in the core. */
  add(field: MotionField, prev: Gray, current: Gray, prevNative?: FrameInput, currentNative?: FrameInput): boolean {
    const pixels = this.width * this.height, cells = field.cols * field.rows;
    if (prev.data.byteLength !== pixels || current.data.byteLength !== pixels) {
      throw new Error('CORE_BAD_ARGUMENT: analysis frame size differs from the layer learner.');
    }
    const native = prevNative && currentNative && prevNative.width === currentNative.width && prevNative.height === currentNative.height
      ? { width: prevNative.width, height: prevNative.height }
      : undefined;
    const nativeBytes = native ? native.width * native.height * 4 : 0;
    const [desc, motions, labels, confidence, dynamic, pPrev, pCur, pPrevNative, pCurNative] = this.core.scratch([
      LEARNER_FIELD_BYTES,
      field.motions.length * LEARNER_MOTION_BYTES,
      cells,
      cells,
      cells,
      pixels,
      pixels,
      native && !(prevNative instanceof ResidentFrame) ? nativeBytes : 0,
      native && !(currentNative instanceof ResidentFrame) ? nativeBytes : 0,
    ]);
    const view = new DataView(this.exports.memory.buffer);
    field.motions.forEach((m, i) => {
      const o = motions + i * LEARNER_MOTION_BYTES;
      view.setFloat64(o, m.x, true);
      view.setFloat64(o + 8, m.y, true);
      view.setUint32(o + 16, m.support, true);
      view.setUint32(o + 20, 0, true);
      view.setFloat64(o + 24, m.confidence, true);
    });
    this.core.writeBytes(labels, field.labels);
    this.core.writeBytes(confidence, field.confidence);
    this.core.writeBytes(dynamic, field.dynamic);
    this.core.writeBytes(pPrev, prev.data);
    this.core.writeBytes(pCur, current.data);
    const place = (frame: FrameInput | undefined, scratch: number): number => {
      if (!native || !frame) return 0;
      if (frame instanceof ResidentFrame) return frame.ptr;
      this.core.writeBytes(scratch, frame.data);
      return scratch;
    };
    const nPrev = place(prevNative, pPrevNative), nCur = place(currentNative, pCurNative);
    view.setUint32(desc, motions, true);
    view.setUint32(desc + 4, field.motions.length, true);
    view.setUint32(desc + 8, labels, true);
    view.setUint32(desc + 12, confidence, true);
    view.setUint32(desc + 16, dynamic, true);
    view.setUint32(desc + 20, field.cols, true);
    view.setUint32(desc + 24, field.rows, true);
    view.setUint32(desc + 28, field.unknown ? 1 : 0, true);
    view.setFloat64(desc + 32, field.difference, true);
    return this.core.check(
      this.exports.ls_learner_add(this.handle, desc, pPrev, pCur, nPrev, nCur, native?.width ?? 0, native?.height ?? 0),
      'learner add',
    ) === 1;
  }
  read(): LearnerAccumulators {
    const out: Record<string, Float64Array | number> = {};
    const array = (which: number): Float64Array => {
      const length = this.core.check(this.exports.ls_learner_len(this.handle, which), 'learner length');
      const [ptr] = this.core.scratch([length * 8]);
      this.core.check(this.exports.ls_learner_read(this.handle, which, ptr), 'learner read');
      return new Float64Array(this.core.readBytes(ptr, length * 8).buffer);
    };
    LEARNER_ARRAYS.forEach((name, which) => {
      const values = array(which);
      if (values.length || which < 11) out[name] = values;
    });
    const counts = array(14);
    return { ...out, informativeFrames: counts[0], nativeFrames: counts[1] } as unknown as LearnerAccumulators;
  }
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.exports.ls_learner_free(this.handle);
    this.handle = 0;
  }
}

export function learner(core: Core, exports: CoreExports, width: number, height: number): LearnerHandle {
  const handle = core.check(exports.ls_learner_new(width, height), 'layer learner');
  return new LearnerHandle(core, exports, handle, width, height);
}
