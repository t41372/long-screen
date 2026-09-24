/** Shared fixtures for the core-module unit tests split out of the former core.test.ts (features/motion/raster/layers):
 *  a single deterministic noise page cropped into analysis-sized windows, its RGBA view, and the two-frame motion
 *  field helper every layer-learning test drives with. Kept here (not duplicated per file) so the split files stay
 *  exact behavioural mirrors of the original, unified test. */
import { extractFeatures } from '../../src/core/features.ts';
import { estimateMotion } from '../../src/core/motion.ts';
import { rng } from '../../src/core/math.ts';
import type { Gray, RGBA } from '../../src/types.ts';

export const PIXEL_W = 760, PIXEL_H = 700;
const random = rng(997);
export const pixelWorld = Uint8Array.from({ length: PIXEL_W * PIXEL_H }, () => Math.floor(random() * 256));

export function crop(x: number, y: number, w = 320, h = 240): Gray {
  const data = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    data.set(pixelWorld.subarray((y + row) * PIXEL_W + x, (y + row) * PIXEL_W + x + w), row * w);
  }
  return { width: w, height: h, data };
}

export const rgba = (g: Gray): RGBA => ({
  width: g.width,
  height: g.height,
  data: Uint8ClampedArray.from({ length: g.width * g.height * 4 }, (_, i) => i % 4 === 3 ? 255 : g.data[i >> 2]),
});

/** Two-frame motion field, feature-driven, used by every layer-learning test to feed LayerLearner.add(). */
export function fieldFor(prev: Gray, cur: Gray) {
  return estimateMotion(prev, cur, undefined, extractFeatures(prev), extractFeatures(cur));
}
