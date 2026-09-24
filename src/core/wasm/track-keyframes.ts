/** `keyframes.ts::evaluateCandidates` fused into one call — split out of `wasm/track.ts`. See `track.ts`'s
 *  module doc comment for the split; `b`/`writePatches`/`resolveNative` stay there (shared with
 *  `track-reacquire.ts`). */
import type { Feature, Gray, Rect } from '../../types.ts';
import type { Core, PatchInput } from './core.ts';
import type { CoreExports } from './exports.ts';
import { CANDIDATE_RECORD_BYTES, KEYFRAME_BYTES, PATCH_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import type { FrameInput } from './memory.ts';
import type { ResidentGray } from './memory.ts';
import { b, resolveNative, writePatches } from './track.ts';

export interface EvaluateCandidatesKeyframe {
  features: Feature[];
  gray: Gray;
  patches: PatchInput[];
  /** This keyframe's own native-pixel pose. */
  x: number;
  y: number;
  /** The caller's `canonical` map, already resolved and interned for this keyframe: a keyframe with no
   *  attachment carries its own interned canvas index and `dx = dy = 0` — see `keyframes.ts::evaluateCandidates`
   *  and `rust/core/src/track/keyframes.rs`'s `CandidateKeyframe` doc comment. */
  canonicalIdx: number;
  dx: number;
  dy: number;
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
/** The single candidate `find()` returns (or `undefined` — see `EvaluateCandidatesQuery`'s call site). */
export interface EvaluateCandidatesResult {
  keyframeIndex: number;
  x: number;
  y: number;
  support: number;
  unique: number;
  ambiguous: boolean;
  error: number;
  analysisError: number;
  confidence: number;
}
/** `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor (this module's own wire format — see
 *  `rust/core/src/abi/track_keyframes.rs::KEYFRAME_BYTES`, asserted against the live module by `assertLayout`):
 *  u32 featuresPtr, featureCount, patchesPtr, patchCount, grayPtr, grayWidth, grayHeight, canonicalIdx, f64 x,
 *  y, dx, dy. */
const CANDIDATE_HEADER_BYTES = 8;

/** `keyframes.ts::evaluateCandidates` fused into one call, end to end: match + hypothesis + analysis-scale audit
 *  for every keyframe, then — only if at least one candidate passed the audit — the lazy native-plane fill (same
 *  rule as `reacquire`/`driftCorrection`), native-patch refinement, the confidence formula and the
 *  score/sort/strong-best/rival-ambiguity selection. Returns the one chosen candidate (or `undefined`), not a
 *  list — `keyframes.ts` no longer does any of its own scoring. */
export function evaluateCandidates(
  core: Core,
  exports: CoreExports,
  keyframes: EvaluateCandidatesKeyframe[],
  q: EvaluateCandidatesQuery,
): { result: EvaluateCandidatesResult | undefined; filledNative: boolean } {
  const { features, gray, roi, region, factor, radius, current, nativePlane, nativeFilled, native } = q;
  const src = resolveNative(current, nativePlane, native);
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
    CANDIDATE_HEADER_BYTES + CANDIDATE_RECORD_BYTES,
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
    desc.setUint32(base + 28, k.canonicalIdx, true);
    desc.setFloat64(base + 32, k.x, true);
    desc.setFloat64(base + 40, k.y, true);
    desc.setFloat64(base + 48, k.dx, true);
    desc.setFloat64(base + 56, k.dy, true);
  }
  writeFeatures(core, pFeatures, features);
  core.writeBytes(pGray, gray.data);
  core.writeRect(pRoi, roi);
  core.writeRect(pRegion, region);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const tag = exports.ls_keyframes_evaluate_candidates(
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
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: evaluate candidates.');
  const headerBytes = core.readBytes(pOut, CANDIDATE_HEADER_BYTES);
  const filledNative = new DataView(headerBytes.buffer, headerBytes.byteOffset, CANDIDATE_HEADER_BYTES).getUint32(0, true) === 1;
  if (tag === 0) return { result: undefined, filledNative };
  const recordBytes = core.readBytes(pOut + CANDIDATE_HEADER_BYTES, CANDIDATE_RECORD_BYTES);
  const rview = new DataView(recordBytes.buffer, recordBytes.byteOffset, CANDIDATE_RECORD_BYTES);
  return {
    result: {
      keyframeIndex: rview.getUint32(0, true),
      x: rview.getInt32(4, true),
      y: rview.getInt32(8, true),
      support: rview.getUint32(12, true),
      unique: rview.getUint32(16, true),
      ambiguous: rview.getUint32(20, true) === 1,
      error: rview.getFloat64(32, true),
      analysisError: rview.getFloat64(40, true),
      confidence: rview.getFloat64(48, true),
    },
    filledNative,
  };
}
