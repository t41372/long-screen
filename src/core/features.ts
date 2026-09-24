import type { Feature, Gray, Match, Rect } from '../types.ts';
import { core } from './wasm.ts';
/** Analysis-resolution feature pipeline. Every kernel below runs in the Rust core (rust/core/src/features.rs).
 *  Kept only because src/pipeline/solve/** still imports these three by this call shape; call `core()` directly
 *  outside solve/**, and delete this file once solve/** does too. */
export function grayscale(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  return core().grayscale(rgba, width, height);
}
/** Spatially balanced minimum-eigenvalue corners and deterministic 256-bit BRIEF. */
export function extractFeatures(image: Gray, maxFeatures = 480, roi?: Rect): Feature[] {
  return core().extractFeatures(image, maxFeatures, roi);
}
/** Mutual-nearest distinct matches, plus explicitly marked ambiguous alternatives. */
export function matchFeatures(a: Feature[], b: Feature[], includeAmbiguous = true): Match[] {
  return core().matchFeatures(a, b, includeAmbiguous);
}
