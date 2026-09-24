import type { Feature, Gray, MotionField } from '../types.ts';
import { core, type PatchInput, type RefinementResult } from './wasm.ts';
/** Motion evidence on analysis and native images. Every kernel — including `extractPatches`, `probeScale` and
 *  `refineNative`/`refinePatches` — now runs in the Rust core (rust/core/src/motion.rs) and is called through
 *  `core()` directly at each use site; this module keeps only `estimateMotion`'s laziness (below) and the type
 *  aliases importers still use. */
export function estimateMotion(a: Gray, b: Gray, _previous?: MotionField, af?: Feature[], bf?: Feature[]): MotionField {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('FRAME_GEOMETRY_CHANGED');
  }
  // core().estimateMotion applies this SAME `< .12` gate itself (rust/core/src/motion.rs::estimate_motion), so
  // this check does not change its result — it exists only so a paused recording never pays for feature
  // extraction/matching it does not need. Kept as a real (not one-line) orchestration for that reason.
  const difference = core().meanDifference(a, b);
  if (difference < .12) {
    return core().estimateMotion(a, b, [], 0);
  }
  const featuresA = af || core().extractFeatures(a, 480), featuresB = bf || core().extractFeatures(b, 480);
  return core().estimateMotion(a, b, core().matchFeatures(featuresA, featuresB, true), featuresB.length);
}
/** Re-exported so `src/pipeline/solve/{track,region-step}.ts` need not import `core()`'s own type names. */
export type NativeRefinement = RefinementResult;
export type Patch = PatchInput;
