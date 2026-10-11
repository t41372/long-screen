/** The keyframe index state object (`long_screen_engine::keyframes`), mirroring `rust/wasm/src/keyframes.rs`. */
import type { Feature } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { ByteReader, ByteWriter } from './bytes.ts';
import { writeFeatures } from './features.ts';

/** One `long_screen_engine::keyframes::KeyframeIndex` in core memory, released when it is garbage collected (the
 *  solve pass holds one for its whole run). */
export class KeyframeIndexState {
  private static readonly registry = new FinalizationRegistry<{ exports: CoreExports; handle: number }>(({ exports, handle }) =>
    exports.ls_keyframe_index_free(handle)
  );
  constructor(private readonly core: Core, private readonly exports: CoreExports, private readonly handle: number) {
    KeyframeIndexState.registry.register(this, { exports, handle });
  }
  /** Places `input` and `features` in one scratch plan: `[input ptr, input length, features ptr]`. */
  private place(input: ByteWriter, features: Feature[]): number[] {
    const [ptr, len, featuresPtr] = input.place(this.core, [features.length * this.core.featureBytes]);
    writeFeatures(this.core, featuresPtr, features);
    return [ptr, len, featuresPtr];
  }
  /** Posts a keyframe under its features' visual words. */
  add(id: string, layer: string, frame: number, features: Feature[]): void {
    const [ptr, len, featuresPtr] = this.place(new ByteWriter().str(id).str(layer).u32(frame), features);
    this.core.check(this.exports.ls_keyframe_index_add(this.handle, ptr, len, featuresPtr, features.length), 'keyframe index add');
  }
  /** Candidate keyframe ids for a query, most votes first, and whether the retrieval-budget warning is due now. */
  retrieve(
    layer: string,
    frame: number,
    features: Feature[],
    exclude: string | undefined,
    minGap: number | undefined,
  ): { candidates: string[]; budgetWarning: boolean } {
    const input = new ByteWriter().str(layer).u32(frame).bool(exclude !== undefined);
    if (exclude !== undefined) input.str(exclude);
    input.bool(minGap !== undefined);
    if (minGap !== undefined) input.u32(minGap);
    const [ptr, len, featuresPtr] = this.place(input, features);
    const length = this.core.check(
      this.exports.ls_keyframe_index_retrieve(this.handle, ptr, len, featuresPtr, features.length),
      'keyframe index retrieve',
    );
    const [out] = this.core.scratch([length]);
    this.core.check(this.exports.ls_keyframe_index_take(this.handle, out, length), 'keyframe index result');
    const r = new ByteReader(this.core.readBytes(out, length)), budgetWarning = r.bool(), candidates: string[] = [];
    for (let n = r.u32(); n > 0; n--) candidates.push(r.str());
    return { candidates, budgetWarning };
  }
  /** Whether the last retrieval admits a loaded candidate keyframe at `frame` (not an odometry neighbour). */
  admits(frame: number): boolean {
    return this.core.check(this.exports.ls_keyframe_index_admits(this.handle, frame), 'keyframe index admits') === 1;
  }
}

export function keyframeIndex(core: Core, exports: CoreExports): KeyframeIndexState {
  return new KeyframeIndexState(core, exports, core.check(exports.ls_keyframe_index_new(), 'keyframe index new'));
}
