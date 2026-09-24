/** `track.ts::reacquire`/`driftCorrection` fused into one call each — split out of `wasm/track.ts`. See
 *  `track.ts`'s module doc comment for the split; `b2`/`writePatches`/`resolveNative` stay there (shared with
 *  `track-keyframes.ts`). */
import type { Feature, Gray, Point, Rect } from '../../types.ts';
import type { Core, PatchInput, RefinementResult } from './core.ts';
import type { CoreExports } from './exports.ts';
import { PATCH_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import type { FrameInput, ResidentGray } from './memory.ts';
import { b2, resolveNative, writePatches } from './track.ts';

export interface ReacquireEstimate {
  n: RefinementResult;
  ambiguous: boolean;
  confidence: number;
}
export interface ReacquireInputs {
  anchorFeatures: Feature[];
  ownFeatures: Feature[];
  anchorPatches: PatchInput[];
  current: FrameInput;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
  rect: Rect;
  f: number;
  radius: number;
}
/** `track.ts::reacquire`, fused into one call. `filledNative` tells the caller whether to update
 *  the SAME per-frame `native()` memo `solve.ts` owns (see `FrameInput.markNativeFilled`). */
export function reacquire(
  core: Core,
  exports: CoreExports,
  inputs: ReacquireInputs,
): { result: ReacquireEstimate | undefined; filledNative: boolean } {
  const { anchorFeatures, ownFeatures, anchorPatches, current, nativePlane, nativeFilled, native, rect, f, radius } = inputs;
  const src = resolveNative(current, nativePlane, native);
  const ptr = core.scratch([
    anchorFeatures.length * core.featureBytes,
    ownFeatures.length * core.featureBytes,
    anchorPatches.length * PATCH_BYTES,
    32,
    src.scratchBytes,
    TRACK_REACQUIRE_OUT_BYTES,
    ...anchorPatches.map((p) => p.data.byteLength),
  ]);
  const [pAnchorFeat, pOwnFeat, pPatchList, pRect, pFallback, pOut] = ptr, dataPtrs = ptr.slice(6);
  writeFeatures(core, pAnchorFeat, anchorFeatures);
  writeFeatures(core, pOwnFeat, ownFeatures);
  writePatches(core, pPatchList, dataPtrs, anchorPatches);
  core.writeRect(pRect, rect);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const tag = exports.ls_track_reacquire(
    pAnchorFeat,
    anchorFeatures.length,
    pOwnFeat,
    ownFeatures.length,
    pPatchList,
    anchorPatches.length,
    pRect,
    f,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b2(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: reacquire.');
  const bytes = core.readBytes(pOut, TRACK_REACQUIRE_OUT_BYTES), view = new DataView(bytes.buffer);
  const filledNative = view.getUint32(36, true) === 1;
  if (tag === 0) return { result: undefined, filledNative };
  const ambiguous = view.getUint32(8, true) === 1, error = view.getFloat64(24, true);
  // `confidence` off the wire is the RAW hypothesis confidence (rust/core/src/track.rs's `ReacquireEstimate` doc
  // comment); Math.exp finished here on the host's own implementation, same bit-exactness reason as
  // OdometryEstimate's confidence field.
  const confidence = Math.max(.05, view.getFloat64(16, true)) * Math.exp(-error / 20) * (ambiguous ? .6 : 1);
  return {
    result: {
      n: { x: view.getInt32(0, true), y: view.getInt32(4, true), error, samples: 0, runnerUp: 0 },
      ambiguous,
      confidence,
    },
    filledNative,
  };
}
const TRACK_REACQUIRE_OUT_BYTES = 40;

export interface DriftCorrectionInputs {
  anchor: { x: number; y: number; patches: PatchInput[] };
  pose: Point;
  current: FrameInput;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
  rect: Rect;
  radius: number;
}
/** `track.ts::driftCorrection`, fused into one call. No gate: the original always evaluates
 *  `native()`, so `filledNative` is true here whenever the resident plane wasn't already filled this frame. */
export function driftCorrection(
  core: Core,
  exports: CoreExports,
  inputs: DriftCorrectionInputs,
): { pose: Point | undefined; error: number; filledNative: boolean } {
  const { anchor, pose, current, nativePlane, nativeFilled, native, rect, radius } = inputs;
  const src = resolveNative(current, nativePlane, native);
  const ptr = core.scratch([
    anchor.patches.length * PATCH_BYTES,
    32,
    src.scratchBytes,
    TRACK_DRIFT_CORRECTION_OUT_BYTES,
    ...anchor.patches.map((p) => p.data.byteLength),
  ]);
  const [pPatchList, pRect, pFallback, pOut] = ptr, dataPtrs = ptr.slice(4);
  writePatches(core, pPatchList, dataPtrs, anchor.patches);
  core.writeRect(pRect, rect);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const tag = exports.ls_track_drift_correction(
    pPatchList,
    anchor.patches.length,
    pRect,
    anchor.x,
    anchor.y,
    pose.x,
    pose.y,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b2(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: driftCorrection.');
  const bytes = core.readBytes(pOut, TRACK_DRIFT_CORRECTION_OUT_BYTES), view = new DataView(bytes.buffer);
  const filledNative = view.getUint32(24, true) === 1;
  if (tag === 0) return { pose: undefined, error: Infinity, filledNative };
  return { pose: { x: view.getFloat64(0, true), y: view.getFloat64(8, true) }, error: view.getFloat64(16, true), filledNative };
}
const TRACK_DRIFT_CORRECTION_OUT_BYTES = 32;
