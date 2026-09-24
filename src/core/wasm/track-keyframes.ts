/** `keyframes.ts::evaluateCandidates` fused into one call — split out of `wasm/track.ts`. See `track.ts`'s
 *  module doc comment for the split; `b`/`writePatches`/`resolveNative` stay there (shared with
 *  `track-reacquire.ts`). */
import type { Feature, Gray, Rect } from '../../types.ts';
import type { Core, PatchInput } from './core.ts';
import type { CoreExports } from './exports.ts';
import { PATCH_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import type { FrameInput } from './memory.ts';
import type { ResidentGray } from './memory.ts';
import { b, resolveNative, writePatches } from './track.ts';

export interface EvaluateCandidatesKeyframe {
  features: Feature[];
  gray: Gray;
  patches: PatchInput[];
}
export interface EvaluateCandidatesQuery {
  features: Feature[];
  gray: Gray;
  roi: Rect;
  region: Rect;
  factor: number;
  radius: number;
  /** See `ReacquireInputs.current`'s doc comment for the resident-lazy-fill contract — `undefined` here means
   *  the caller has no resident frame to offer at all (direct `evaluateCandidates`/`find()` callers in tests,
   *  which do not go through `solve.ts`'s frame loop); `resolveNative` treats that exactly like any other
   *  non-resident `current` (mode 0, `native()` called eagerly). */
  current: FrameInput | undefined;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
}
export interface EvaluateCandidatesResult {
  keyframeIndex: number;
  x: number;
  y: number;
  support: number;
  unique: number;
  ambiguous: boolean;
  strong: boolean;
  error: number;
  analysisError: number;
}
/** `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor (this module's own wire format — see
 *  `rust/core/src/abi/track.rs::KEYFRAME_BYTES`): u32 featuresPtr, featureCount, patchesPtr, patchCount,
 *  grayPtr, grayWidth, grayHeight, padding. */
const KEYFRAME_BYTES = 32;
const CANDIDATE_HEADER_BYTES = 8;
const CANDIDATE_RECORD_BYTES = 48;

/** `keyframes.ts::evaluateCandidates` fused into one call: match + hypothesis + analysis-scale
 *  audit for every keyframe, then — only if at least one candidate passed the audit — the lazy native-plane
 *  fill (same rule as `reacquire`/`driftCorrection`) and native-patch refinement. Returns the audited-and-
 *  refined candidate list, not the final pick: `keyframes.ts` finishes the `Math.exp` confidence formula and
 *  the sort/best/rival selection in TS (see `rust/core/src/track.rs::RefinedCandidate`'s doc comment — that
 *  selection needs the exact host-`Math.exp`'d confidence as its sort key, so it cannot move to Rust without
 *  a second bit-exactness risk on top of `OdometryEstimate.confidence`'s). */
export function evaluateCandidates(
  core: Core,
  exports: CoreExports,
  keyframes: EvaluateCandidatesKeyframe[],
  q: EvaluateCandidatesQuery,
): { results: EvaluateCandidatesResult[]; filledNative: boolean } {
  const { features, gray, roi, region, factor, radius, current, nativePlane, nativeFilled, native } = q;
  const src = resolveNative(current, nativePlane, native);
  const maxRecords = keyframes.length * 8;
  const perKeyframeSizes = keyframes.flatMap((k) => [
    k.features.length * core.featureBytes,
    k.patches.length * PATCH_BYTES,
    k.gray.data.byteLength,
    ...k.patches.map((p) => p.data.byteLength),
  ]);
  const ptr = core.scratch([
    keyframes.length * KEYFRAME_BYTES,
    features.length * core.featureBytes,
    gray.data.byteLength,
    32,
    32,
    src.scratchBytes,
    CANDIDATE_HEADER_BYTES + maxRecords * CANDIDATE_RECORD_BYTES,
    ...perKeyframeSizes,
  ]);
  const [pKeyframes, pFeatures, pGray, pRoi, pRegion, pFallback, pOut] = ptr;
  let cursor = 7;
  const desc = new DataView(core.exports.memory.buffer);
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i];
    const featuresPtr = ptr[cursor++], patchListPtr = ptr[cursor++], grayPtr = ptr[cursor++];
    const dataPtrs = k.patches.map(() => ptr[cursor++]);
    writeFeatures(core, featuresPtr, k.features);
    writePatches(core, patchListPtr, dataPtrs, k.patches);
    core.writeBytes(grayPtr, k.gray.data);
    const base = pKeyframes + i * KEYFRAME_BYTES;
    desc.setUint32(base, featuresPtr, true);
    desc.setUint32(base + 4, k.features.length, true);
    desc.setUint32(base + 8, patchListPtr, true);
    desc.setUint32(base + 12, k.patches.length, true);
    desc.setUint32(base + 16, grayPtr, true);
    desc.setUint32(base + 20, k.gray.width, true);
    desc.setUint32(base + 24, k.gray.height, true);
    desc.setUint32(base + 28, 0, true);
  }
  writeFeatures(core, pFeatures, features);
  core.writeBytes(pGray, gray.data);
  core.writeRect(pRoi, roi);
  core.writeRect(pRegion, region);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const count = exports.ls_keyframes_evaluate_candidates(
    pKeyframes,
    keyframes.length,
    pFeatures,
    features.length,
    pGray,
    gray.width,
    gray.height,
    pRoi,
    pRegion,
    factor,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (count === -1) throw new Error('CORE_BAD_ARGUMENT: evaluate candidates.');
  if (count === 0) return { results: [], filledNative: false };
  const headerBytes = core.readBytes(pOut, CANDIDATE_HEADER_BYTES);
  const filledNative = new DataView(headerBytes.buffer, headerBytes.byteOffset, CANDIDATE_HEADER_BYTES).getUint32(0, true) === 1;
  const recordBytes = core.readBytes(pOut + CANDIDATE_HEADER_BYTES, count * CANDIDATE_RECORD_BYTES);
  const rview = new DataView(recordBytes.buffer, recordBytes.byteOffset, count * CANDIDATE_RECORD_BYTES);
  const results: EvaluateCandidatesResult[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * CANDIDATE_RECORD_BYTES;
    results.push({
      keyframeIndex: rview.getUint32(o, true),
      x: rview.getInt32(o + 4, true),
      y: rview.getInt32(o + 8, true),
      support: rview.getUint32(o + 12, true),
      unique: rview.getUint32(o + 16, true),
      ambiguous: rview.getUint32(o + 20, true) === 1,
      strong: rview.getUint32(o + 24, true) === 1,
      error: rview.getFloat64(o + 32, true),
      analysisError: rview.getFloat64(o + 40, true),
    });
  }
  return { results, filledNative };
}
