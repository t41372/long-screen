import type { Feature, Gray, Match, Motion, MotionField, Point, Rect, RGBA } from '../types.ts';
import { clamp } from './math.ts';
import { extractFeatures, matchFeatures } from './features.ts';
import { type AuditResult, core, type LabelMask, type RefinementResult, type ResidentFrame, ResidentGray } from './wasm.ts';
/** Motion evidence on analysis and native images. Every kernel runs in the Rust core (rust/core/src/motion.rs);
 *  this module keeps the pipeline-facing call shape and the pure orchestration (`probeScale`). */
export function translationHypotheses(matches: Match[], max = 6): Motion[] {
  return core().translationHypotheses(matches, max);
}
export function verifyTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect): number {
  return core().verifyTranslation(a, b, dx, dy, roi);
}
export type Audit = AuditResult;
/** Held-out photometric evidence, using textured pixels and clamping BOTH observations to the pane.
 * Block statistics separate "the page moved as hypothesised while one widget changed" from "this alignment is wrong".
 * `tolerant` accepts a ±1 pixel neighbourhood, for analysis images whose native motion is not a multiple of the factor. */
export function auditTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect, tolerant = false): Audit {
  return core().auditTranslation(a, b, dx, dy, roi, tolerant);
}
export function refineTranslation(a: Gray, b: Gray, p: Point, roi?: Rect, radius = 2): Point {
  return core().refineTranslation(a, b, p, roi, radius);
}
/** Similarity is a change detector, not an excuse to silently rescale source pixels. */
export function detectScale(matches: Match[]): number {
  return core().detectScale(matches);
}
export function estimateMotion(a: Gray, b: Gray, _previous?: MotionField, af?: Feature[], bf?: Feature[]): MotionField {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('FRAME_GEOMETRY_CHANGED');
  }
  // Identical analysis images indicate a possible pause; the core short-circuits before matching in that case,
  // so features are only extracted when they will be used.
  const difference = core().meanDifference(a, b);
  if (difference < .12) {
    return core().estimateMotion(a, b, [], 0);
  }
  const featuresA = af || extractFeatures(a), featuresB = bf || extractFeatures(b);
  return core().estimateMotion(a, b, matchFeatures(featuresA, featuresB), featuresB.length);
}
export type NativeRefinement = RefinementResult;
/** Native-pixel refinement and verification. No frame resizing and no averaging of text at the seam.
 * `mask` restricts both frames to one region's atlas membership. */
export function refineNative(
  a: RGBA | ResidentFrame,
  b: RGBA | ResidentFrame,
  guess: Point,
  region: Rect,
  mask?: LabelMask,
  radius = 3,
): NativeRefinement {
  return core().refineNative(a, b, guess, region, mask, radius);
}
export interface Patch {
  /** Top-left corner in region-local native pixels. */
  x: number;
  y: number;
  size: number;
  data: Uint8Array;
}
/** Native-resolution texture samples kept with a keyframe (a few KB) so revisits and loop edges are measured in native pixels, not analysis pixels. */
export function extractPatches(
  native: Gray | ResidentGray,
  region: Rect,
  features: Point[],
  factor: number,
  count = 24,
  size = 32,
): Patch[] {
  const out: Patch[] = [],
    rx = Math.round(region.x),
    ry = Math.round(region.y),
    rw = Math.round(region.width),
    rh = Math.round(region.height);
  if (rw < size + 2 || rh < size + 2) {
    return out;
  }
  const taken: Point[] = [];
  for (const f of features) {
    if (out.length >= count) {
      break;
    }
    const x = clamp(Math.round(f.x * factor) - size / 2, 0, rw - size), y = clamp(Math.round(f.y * factor) - size / 2, 0, rh - size);
    if (taken.some((t) => Math.abs(t.x - x) < size && Math.abs(t.y - y) < size)) {
      continue;
    }
    taken.push({ x, y });
    let data: Uint8Array;
    if (native instanceof ResidentGray) data = native.window(rx + x, ry + y, size, size);
    else {
      data = new Uint8Array(size * size);
      for (let row = 0; row < size; row++) {
        data.set(native.data.subarray((ry + y + row) * native.width + rx + x, (ry + y + row) * native.width + rx + x + size), row * size);
      }
    }
    out.push({ x, y, size, data });
  }
  return out;
}
/** Measures how well keyframe patches (region-local, in the keyframe's frame) align in the current native frame at `guess` (current → keyframe), refining on the native raster. */
export function refinePatches(patches: Patch[], native: Gray | ResidentGray, region: Rect, guess: Point, radius = 3): NativeRefinement {
  return core().refinePatches(patches, native, region, guess, radius);
}
/** Bilinear resample of an analysis image by a scale factor (probe only; output pixels are never resampled). */
export function resampleGray(g: Gray, scale: number): Gray {
  return core().resampleGray(g, scale);
}
/** When translation fails, asks explicitly whether the previous observation explains the current one at another magnification. */
export function probeScale(
  previous: Gray,
  current: Gray,
  currentFeatures: Feature[],
  roi?: Rect,
  scales = [1.1, 1.25, 1.5, 2, 1 / 1.1, 1 / 1.25, 1 / 1.5, 1 / 2],
): { scale: number; error: number } | undefined {
  let best: { scale: number; error: number } | undefined;
  for (const scale of scales) {
    const scaled = resampleGray(previous, scale),
      features = extractFeatures(scaled, 320),
      matches = matchFeatures(features, currentFeatures);
    for (const m of translationHypotheses(matches, 4)) {
      if (m.support < 8) {
        continue;
      }
      const audit = auditTranslation(scaled, current, m.x, m.y, roi, true);
      if (audit.samples < 200 || !Number.isFinite(audit.error) || audit.agreement < .5 || audit.agreeingError > 10) {
        continue;
      }
      if (!best || audit.agreeingError < best.error) {
        best = { scale, error: audit.agreeingError };
      }
    }
  }
  return best;
}
