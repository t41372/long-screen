import type { Feature, Gray, MotionField } from '../types.ts';
import { core, type PatchInput, type RefinementResult } from './wasm.ts';
/** Motion evidence on analysis images. The estimate — including the paused-pair shortcut that skips feature
 *  extraction and matching — runs in the engine (rust/engine/src/scan.rs `estimate_motion`); the other kernels
 *  (`extractPatches`, `probeScale`, `refineNative`/`refinePatches`) are called through `core()` at each use site. */
export function estimateMotion(a: Gray, b: Gray, _previous?: MotionField, af?: Feature[], bf?: Feature[]): MotionField {
  return core().estimateMotionBetween(a, b, af, bf);
}
/** Re-exported so `src/pipeline/solve/{track,region-step}.ts` need not import `core()`'s own type names. */
export type NativeRefinement = RefinementResult;
export type Patch = PatchInput;
