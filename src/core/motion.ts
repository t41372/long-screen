import type { Feature, Gray, MotionField, Point, Rect, RGBA } from '../types.ts';
import { clamp } from './math.ts';
import { core, type LabelMask, type PatchInput, type RefinementResult, type ResidentFrame, ResidentGray } from './wasm.ts';
/** Motion evidence on analysis and native images. Every kernel runs in the Rust core (rust/core/src/motion.rs),
 *  called through `core()` directly except where a doc comment below says otherwise. This module keeps the
 *  pure orchestration on top of it (`estimateMotion`, `extractPatches`, `probeScale`) plus `refineNative`/
 *  `refinePatches`, whose resident-frame call shape a test oracle still needs. */
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
  const featuresA = af || core().extractFeatures(a, 480), featuresB = bf || core().extractFeatures(b, 480);
  return core().estimateMotion(a, b, core().matchFeatures(featuresA, featuresB, true), featuresB.length);
}
export type NativeRefinement = RefinementResult;
/** Native-pixel refinement and verification. No frame resizing and no averaging of text at the seam. `mask`
 *  restricts both frames to one region's atlas membership. Kept as a wrapper (unlike this module's other former
 *  one-line delegations) because `tests/support/reference/track.ts`'s dual-mode plain/resident call sites need
 *  the `RGBA | ResidentFrame` signature `core().refineNative` has, which the frozen, plain-`RGBA`-only
 *  `tests/support/reference/motion.ts` copy does not model. */
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
/** Top-left corner in region-local native pixels. Same shape as `PatchInput` (wasm.ts), which `core().refinePatches` marshals. */
export type Patch = PatchInput;
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
/** Measures how well keyframe patches (region-local, in the keyframe's frame) align in the current native frame
 *  at `guess` (current → keyframe), refining on the native raster. Kept as a wrapper for the same
 *  resident-vs-plain reason as `refineNative` above. */
export function refinePatches(patches: Patch[], native: Gray | ResidentGray, region: Rect, guess: Point, radius = 3): NativeRefinement {
  return core().refinePatches(patches, native, region, guess, radius);
}
/** When translation fails, asks explicitly whether the previous observation explains the current one at another
 *  magnification. The only orchestration in this module that is not a thin pass-through: it drives several
 *  Rust kernels through `core()` in a loop over candidate scales. */
export function probeScale(
  previous: Gray,
  current: Gray,
  currentFeatures: Feature[],
  roi?: Rect,
  scales = [1.1, 1.25, 1.5, 2, 1 / 1.1, 1 / 1.25, 1 / 1.5, 1 / 2],
): { scale: number; error: number } | undefined {
  let best: { scale: number; error: number } | undefined;
  for (const scale of scales) {
    const scaled = core().resampleGray(previous, scale),
      features = core().extractFeatures(scaled, 320),
      matches = core().matchFeatures(features, currentFeatures, true);
    for (const m of core().translationHypotheses(matches, 4)) {
      if (m.support < 8) {
        continue;
      }
      const audit = core().auditTranslation(scaled, current, m.x, m.y, roi, true);
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
