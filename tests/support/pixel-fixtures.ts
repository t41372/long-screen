/** Shared fixtures for the core-module unit tests split out of the former core.test.ts (features/motion/raster/layers):
 *  a single deterministic noise page cropped into analysis-sized windows, its RGBA view, and the two-frame motion
 *  field helper every layer-learning test drives with. Kept here (not duplicated per file) so the split files stay
 *  exact behavioural mirrors of the original, unified test. */
import { extractFeatures } from '../../src/core/features.ts';
import { estimateMotion } from '../../src/core/motion.ts';
import { clamp, rng } from '../../src/core/math.ts';
import { referenceRegionContains } from './reference/layers.ts';
import type { Gray, Motion, MotionField, Rect, Region, RGBA } from '../../src/types.ts';

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

/** Former src/core/raster.ts exports with no production caller left (final-verify-report.md item 12): kept here
 *  only for tests/unit/raster.test.ts, which still exercises them directly. */
export function cropRGBA(image: RGBA, r: Rect): RGBA {
  const x = Math.round(r.x), y = Math.round(r.y), width = Math.round(r.width), height = Math.round(r.height);
  if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > image.width || y + height > image.height) {
    throw new Error(`Crop ${x},${y} ${width}×${height} exceeds the ${image.width}×${image.height} frame.`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    data.set(image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4), row * width * 4);
  }
  return { width, height, data };
}
/** Opaque RGB average at an integer factor; used only for previews, never for output pixels. */
export function downscaleRGBA(image: RGBA, factor: number): RGBA {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Invalid thumbnail factor ${factor}.`);
  }
  const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
  const data = new Uint8ClampedArray(width * height * 4), src = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Clamp the sampled box to the image: a dimension forced up to 1 by the max(1, …) above can be smaller than `factor`.
      const bh = Math.min(factor, image.height - y * factor), bw = Math.min(factor, image.width - x * factor), area = bw * bh;
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < bh; j++) {
        let i = ((y * factor + j) * image.width + x * factor) * 4;
        for (let k = 0; k < bw; k++, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / area;
      data[o + 1] = g / area;
      data[o + 2] = b / area;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
export function thumbnail(image: RGBA, maxWidth: number): RGBA {
  return downscaleRGBA(image, Math.max(1, Math.ceil(image.width / maxWidth)));
}
/** Former src/core/layers.ts::regionMotion, with no production caller left (final-verify-report.md item 12):
 *  kept here only for tests/unit/layers.test.ts. Uses the frozen `referenceRegionContains` (tests/support/
 *  reference/layers.ts) rather than a second copy of that check. */
export function regionMotion(field: MotionField, region: Region, width: number, height: number): Motion {
  if (region.kind === 'fixed') {
    return { x: 0, y: 0, support: 100, unique: 100, confidence: 1, error: 0, ambiguous: false };
  }
  const votes = new Float64Array(field.motions.length);
  let total = 0;
  for (let y = 0; y < field.rows; y++) {
    for (let x = 0; x < field.cols; x++) {
      const px = Math.min(width - 1, (x + .5) * field.cell * width / (field.cols * field.cell)),
        py = Math.min(height - 1, (y + .5) * field.cell * height / (field.rows * field.cell));
      // Map by actual analysis dimensions when available, not by padded grid dimensions.
      const nx = region.maskWidth ? Math.min(width - 1, (x + .5) * field.cell * width / region.maskWidth) : px;
      const ny = region.maskHeight ? Math.min(height - 1, (y + .5) * field.cell * height / region.maskHeight) : py;
      if (!referenceRegionContains(region, nx, ny, width, height)) {
        continue;
      }
      const i = y * field.cols + x, w = field.confidence[i] / 255;
      votes[field.labels[i]] += w;
      total += w;
    }
  }
  let best = 0;
  for (let i = 1; i < votes.length; i++) {
    if (votes[i] > votes[best]) {
      best = i;
    }
  }
  const m = field.motions[best];
  return { ...m, confidence: field.difference < .12 ? .98 : m.confidence * clamp(votes[best] / Math.max(.01, total) * 1.3, .25, 1) };
}
export function meanAbsoluteDifference(a: RGBA, b: RGBA): number {
  if (a.width !== b.width || a.height !== b.height) {
    return 255;
  }
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return s / (a.data.length / 4 * 3);
}
