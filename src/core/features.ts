import type { Feature, Gray, Match, Rect } from '../types.ts';
import { core } from './wasm.ts';
/** Analysis-resolution feature pipeline. Every kernel below runs in the Rust core (rust/core/src/features.rs,
 *  raster.rs); this module only keeps the historical call shape for the pipeline and tests. */
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
/** Four independent 12-bit bands; persistent postings support old, distant revisits. */
export function featureWords(features: Feature[]): number[] {
  return core().featureWords(features);
}
/** `ls_mean_difference` (rust/core/src/raster.rs); kept here only for the historical call shape tests use. */
export function meanDifference(a: Gray, b: Gray): number {
  return core().meanDifference(a, b);
}
