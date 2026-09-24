/** FROZEN pre-migration motion module (parity oracle for rust/core/src/motion.rs). Not used by production code. */
import type { Feature, Gray, Match, Motion, MotionField, Point, Rect, RGBA } from '../../../src/types.ts';
import { clamp, median, norm, rng } from './math.ts';
import { extractFeatures, matchFeatures, meanDifference } from './kernels.ts';
export function translationHypotheses(matches: Match[], max = 6): Motion[] {
  const bins = new Map<string, Match[]>();
  for (const m of matches) {
    const x = m.a.x - m.b.x, y = m.a.y - m.b.y, key = `${Math.round(x / 3)},${Math.round(y / 3)}`;
    let b = bins.get(key);
    if (!b) {
      bins.set(key, b = []);
    }
    b.push(m);
  }
  const seeds = [...bins.values()].sort((a, b) => b.length - a.length).slice(0, 32);
  const out: Motion[] = [];
  for (const seed of seeds) {
    let x = median(seed.map((m) => m.a.x - m.b.x)), y = median(seed.map((m) => m.a.y - m.b.y));
    const support = matches.filter((m) => Math.hypot(m.a.x - m.b.x - x, m.a.y - m.b.y - y) <= 2.5);
    if (support.length < 3) {
      continue;
    }
    x = median(support.map((m) => m.a.x - m.b.x));
    y = median(support.map((m) => m.a.y - m.b.y));
    if (out.some((p) => Math.hypot(p.x - x, p.y - y) < 3)) {
      continue;
    }
    const unique = support.filter((m) => m.unique).length;
    const spread = new Set(support.map((m) => `${m.b.x >> 5},${m.b.y >> 5}`)).size;
    const confidence = clamp(
      (1 - Math.exp(-support.length / 9)) * (0.48 + 0.52 * unique / support.length) * Math.min(1, spread / 4),
      0,
      0.99,
    );
    out.push({ x, y, support: support.length, unique, confidence, error: 0, ambiguous: unique < Math.min(6, support.length * .2) });
  }
  out.sort((a, b) => (b.support + b.unique) - (a.support + a.unique));
  return out.slice(0, max);
}
function patchError(a: Gray, b: Gray, dx: number, dy: number, r: Rect, step = 3): {
  error: number;
  texture: number;
  n: number;
} {
  const w = b.width, h = b.height, aw = a.width, ah = a.height;
  let total = 0, texture = 0, n = 0;
  const x0 = Math.max(1, Math.ceil(r.x), Math.ceil(-dx + 1)), x1 = Math.min(w - 1, r.x + r.width, aw - dx - 1);
  const y0 = Math.max(1, Math.ceil(r.y), Math.ceil(-dy + 1)), y1 = Math.min(h - 1, r.y + r.height, ah - dy - 1);
  dx = Math.round(dx);
  dy = Math.round(dy);
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = y * w + x, j = (y + dy) * aw + x + dx;
      const gradient = Math.abs(b.data[i + 1] - b.data[i - 1]) + Math.abs(b.data[i + w] - b.data[i - w]);
      // A clipped robust error prevents an animated object from dominating alignment.
      total += Math.min(70, Math.abs(a.data[j] - b.data[i])) * (gradient > 12 ? 2 : 1);
      texture += gradient;
      n += gradient > 12 ? 2 : 1;
    }
  }
  return { error: n > 8 ? total / n : Infinity, texture: n ? texture / n : 0, n };
}
export function verifyTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect): number {
  const r = roi || { x: 0, y: 0, width: b.width, height: b.height }, errors: number[] = [];
  for (let y = r.y; y < r.y + r.height; y += 48) {
    for (let x = r.x; x < r.x + r.width; x += 48) {
      const p = patchError(a, b, dx, dy, { x, y, width: Math.min(48, r.x + r.width - x), height: Math.min(48, r.y + r.height - y) }, 4);
      if (p.n > 12 && p.texture > 3) {
        errors.push(p.error);
      }
    }
  }
  if (errors.length < 2) {
    return Infinity;
  }
  errors.sort((x, y) => x - y);
  // Retain 75%: ordinary page content must agree, not just a single fixed logo.
  return errors.slice(0, Math.max(2, Math.ceil(errors.length * .75))).reduce((s, x) => s + x, 0) /
    Math.max(2, Math.ceil(errors.length * .75));
}
export interface Audit {
  /** Mean clipped absolute error over textured overlap pixels; Infinity without enough samples. */
  error: number;
  /** Fraction of textured overlap pixels that clearly disagree. */
  mismatch: number;
  /** Overlap area as a fraction of the pane. */
  overlap: number;
  samples: number;
  /** Textured 32×32 blocks in the overlap, and how many of them agree with the hypothesis. */
  blocks: number;
  agreeing: number;
  agreement: number;
  /** Mean error over agreeing blocks only: the alignment quality of the static part of the page. */
  agreeingError: number;
}
/** Held-out photometric evidence, using textured pixels and clamping BOTH observations to the pane.
 * Feature uniqueness is only pairwise; it does not prove that repeated cards are the same canvas region.
 * Block statistics separate "the page moved as hypothesised while one widget changed" from "this alignment is wrong".
 * `tolerant` accepts a ±1 pixel neighbourhood, for analysis images whose native motion is not a multiple of the factor. */
export function auditTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect, tolerant = false): Audit {
  const r = roi || { x: 0, y: 0, width: b.width, height: b.height };
  dx = Math.round(dx);
  dy = Math.round(dy);
  // ORACLE FIX (mirrors rust/core): the shipped TS sampled x+dx = 0 / y+dy = 0 and read a.data[j - width] out of
  // bounds (NaN in JS, a trap in Rust). Both gradients need a one-pixel margin in their own image.
  const x0 = Math.max(2, Math.ceil(r.x), Math.ceil(r.x - dx), 1 - dx), y0 = Math.max(2, Math.ceil(r.y), Math.ceil(r.y - dy), 1 - dy);
  const x1 = Math.min(b.width - 2, a.width - dx - 2, r.x + r.width, r.x + r.width - dx),
    y1 = Math.min(b.height - 2, a.height - dy - 2, r.y + r.height, r.y + r.height - dy);
  const overlap = Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / Math.max(1, r.width * r.height);
  const B = 32, bw = Math.max(1, Math.ceil((x1 - x0) / B)), bh = Math.max(1, Math.ceil((y1 - y0) / B));
  const blockError = new Float64Array(bw * bh), blockBad = new Float64Array(bw * bh), blockN = new Float64Array(bw * bh);
  let error = 0, bad = 0, n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * b.width + x, j = (y + dy) * a.width + x + dx;
      const gb = Math.abs(b.data[i + 1] - b.data[i - 1]) + Math.abs(b.data[i + b.width] - b.data[i - b.width]),
        ga = Math.abs(a.data[j + 1] - a.data[j - 1]) + Math.abs(a.data[j + a.width] - a.data[j - a.width]);
      if (Math.max(ga, gb) < 20) {
        continue;
      }
      let difference = Math.abs(a.data[j] - b.data[i]);
      if (tolerant) {
        difference = Math.min(
          difference,
          Math.abs(a.data[j + 1] - b.data[i]),
          Math.abs(a.data[j - 1] - b.data[i]),
          Math.abs(a.data[j + a.width] - b.data[i]),
          Math.abs(a.data[j - a.width] - b.data[i]),
        );
      }
      const clipped = Math.min(70, difference), q = Math.floor((y - y0) / B) * bw + Math.floor((x - x0) / B);
      error += clipped;
      blockError[q] += clipped;
      blockN[q]++;
      if (difference > 18) {
        bad++;
        blockBad[q]++;
      }
      n++;
    }
  }
  let blocks = 0, agreeing = 0, agreeingError = 0;
  for (let q = 0; q < blockN.length; q++) {
    if (blockN[q] < 12) {
      continue;
    }
    blocks++;
    if (blockError[q] / blockN[q] < 10 && blockBad[q] / blockN[q] < .2) {
      agreeing++;
      agreeingError += blockError[q] / blockN[q];
    }
  }
  return {
    error: n >= 24 ? error / n : Infinity,
    mismatch: n ? bad / n : 1,
    overlap,
    samples: n,
    blocks,
    agreeing,
    agreement: blocks ? agreeing / blocks : 0,
    agreeingError: agreeing ? agreeingError / agreeing : Infinity,
  };
}
export function refineTranslation(a: Gray, b: Gray, p: Point, roi?: Rect, radius = 2): Point {
  const r = roi || { x: 0, y: 0, width: b.width, height: b.height };
  let best = { x: Math.round(p.x), y: Math.round(p.y) }, error = Infinity;
  for (let dy = Math.round(p.y) - radius; dy <= Math.round(p.y) + radius; dy++) {
    for (let dx = Math.round(p.x) - radius; dx <= Math.round(p.x) + radius; dx++) {
      const e = patchError(a, b, dx, dy, r, 7).error;
      if (e < error - 1e-4 || (Math.abs(e - error) < 1e-4 && Math.hypot(dx - p.x, dy - p.y) < Math.hypot(best.x - p.x, best.y - p.y))) {
        error = e;
        best = { x: dx, y: dy };
      }
    }
  }
  return best;
}
/** Similarity is a change detector, not an excuse to silently rescale source pixels. */
export function detectScale(matches: Match[]): number {
  const m = matches.filter((m) => m.unique);
  if (m.length < 8) {
    return 1;
  }
  const random = rng(7641);
  let best = 0, bestScale = 1;
  for (let iter = 0; iter < 96; iter++) {
    const p = m[Math.floor(random() * m.length)], q = m[Math.floor(random() * m.length)];
    const bx = q.b.x - p.b.x, by = q.b.y - p.b.y, ax = q.a.x - p.a.x, ay = q.a.y - p.a.y, den = bx * bx + by * by;
    if (den < 1000) {
      continue;
    }
    const u = (ax * bx + ay * by) / den, v = (ay * bx - ax * by) / den, s = Math.hypot(u, v);
    if (s < .55 || s > 1.8) {
      continue;
    }
    const tx = p.a.x - u * p.b.x + v * p.b.y, ty = p.a.y - v * p.b.x - u * p.b.y;
    let n = 0;
    for (const r of m) {
      if (Math.hypot(u * r.b.x - v * r.b.y + tx - r.a.x, v * r.b.x + u * r.b.y + ty - r.a.y) < 2.5) {
        n++;
      }
    }
    if (n > best) {
      best = n;
      bestScale = s;
    }
  }
  return best >= Math.max(8, m.length * .5) ? bestScale : 1;
}
export function estimateMotion(a: Gray, b: Gray, _previous?: MotionField, af?: Feature[], bf?: Feature[]): MotionField {
  const cell = 24, cols = Math.ceil(b.width / cell), rows = Math.ceil(b.height / cell), n = cols * rows;
  const difference = meanDifference(a, b);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('FRAME_GEOMETRY_CHANGED');
  }
  // Identical analysis images indicate a possible pause, not proof of identical native pixels.
  if (difference < .12) {
    return {
      motions: [{ x: 0, y: 0, support: 0, unique: 0, confidence: .98, error: difference, ambiguous: false }],
      labels: new Uint8Array(n),
      confidence: new Uint8Array(n).fill(245),
      dynamic: new Uint8Array(n),
      cols,
      rows,
      cell,
      difference,
      featureCount: 0,
      unknown: false,
      zoom: 1,
    };
  }
  const featuresA = af || extractFeatures(a), featuresB = bf || extractFeatures(b), matches = matchFeatures(featuresA, featuresB);
  let motions = translationHypotheses(matches);
  // A few stable identities are useful for fixed chrome, even when it is a minority layer.
  if (!motions.some((m) => norm(m) < 1)) {
    motions.push({ x: 0, y: 0, support: 0, unique: 0, confidence: .5, error: 0, ambiguous: false });
  }
  if (!motions.length) {
    motions = [{ x: 0, y: 0, support: 0, unique: 0, confidence: 0, error: 255, ambiguous: true }];
  }
  for (const m of motions) {
    const inliers = matches.filter((p) => Math.hypot(p.a.x - p.b.x - m.x, p.a.y - p.b.y - m.y) < 3);
    // Refinement on inlier neighbourhoods avoids the fixed toolbar biasing a scroll model.
    let best = Infinity, bx = m.x, by = m.y;
    for (let y = Math.round(m.y) - 1; y <= Math.round(m.y) + 1; y++) {
      for (let x = Math.round(m.x) - 1; x <= Math.round(m.x) + 1; x++) {
        let sum = 0, k = 0;
        for (const p of inliers.slice(0, 45)) {
          const e = patchError(a, b, x, y, { x: p.b.x - 7, y: p.b.y - 7, width: 15, height: 15 }, 3).error;
          if (Number.isFinite(e)) {
            sum += e;
            k++;
          }
        }
        if (k && sum / k < best) {
          best = sum / k;
          bx = x;
          by = y;
        }
      }
    }
    m.x = bx;
    m.y = by;
    m.error = Number.isFinite(best) ? best : verifyTranslation(a, b, m.x, m.y);
    if (m.support > 0) {
      m.confidence *= Math.exp(-Math.min(80, m.error) / 35);
    }
  }
  motions.sort((a, b) => (b.support + b.unique) - (a.support + a.unique));
  const moving = motions.findIndex((m) => norm(m) > 1 && m.support >= 4);
  const dominant = moving >= 0 ? moving : 0;
  const labels = new Uint8Array(n), confidence = new Uint8Array(n), dynamic = new Uint8Array(n);
  const informative = new Uint8Array(n);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx,
        r = { x: cx * cell, y: cy * cell, width: Math.min(cell, b.width - cx * cell), height: Math.min(cell, b.height - cy * cell) };
      let best = Infinity, second = Infinity, choice = dominant, texture = 0, dominantError = Infinity;
      for (let k = 0; k < motions.length; k++) {
        const m = motions[k], p = patchError(a, b, m.x, m.y, r);
        texture = Math.max(texture, p.texture);
        if (k === dominant) {
          dominantError = p.error;
        }
        if (p.error < best) {
          second = best;
          best = p.error;
          choice = k;
        } else if (p.error < second) {
          second = p.error;
        }
      }
      // Content entering at the leading edge has no counterpart in the previous frame under the true motion; a competing
      // hypothesis "winning" there by default is not evidence of an independent layer.
      if (texture < 3 || !Number.isFinite(best) || second - best < .6 || (!Number.isFinite(dominantError) && choice !== dominant)) {
        labels[idx] = dominant;
        confidence[idx] = 65;
      } else {
        labels[idx] = choice;
        confidence[idx] = Math.round(255 * Math.exp(-best / 24) * clamp((second - best) / 8, .25, 1));
        informative[idx] = confidence[idx] > 100 ? 1 : 0;
        if (best > 22) {
          dynamic[idx] = 1;
          labels[idx] = dominant;
          confidence[idx] = 45;
        }
      }
    }
  }
  // Fill featureless regions using neighbouring evidence; record reduced confidence, never fabricate pixels.
  for (let pass = 0; pass < 3; pass++) {
    const next = labels.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (informative[i]) {
          continue;
        }
        const votes = new Float64Array(motions.length);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) {
              continue;
            }
            const j = yy * cols + xx;
            votes[labels[j]] += confidence[j] / (1 + dx * dx + dy * dy);
          }
        }
        let k = dominant;
        for (let j = 0; j < votes.length; j++) {
          if (votes[j] > votes[k]) {
            k = j;
          }
        }
        next[i] = k;
      }
    }
    labels.set(next);
  }
  const strongest = motions.reduce((m, n) => n.confidence > m.confidence ? n : m, motions[0]);
  const unknown = strongest.support < 4 && difference > 5;
  return {
    motions,
    labels,
    confidence,
    dynamic,
    cols,
    rows,
    cell,
    difference,
    featureCount: featuresB.length,
    unknown,
    zoom: detectScale(matches),
  };
}
export interface NativeRefinement extends Point {
  /** Mean clipped RGB error at the chosen integer offset; Infinity when the overlap has too little texture to judge. */
  error: number;
  samples: number;
  /** Error of the best offset more than two pixels away from the winner; small gaps mean repeated texture. */
  runnerUp: number;
}
/** Native-pixel refinement and verification. No frame resizing and no averaging of text at the seam. */
export function refineNative(
  a: RGBA,
  b: RGBA,
  guess: Point,
  region: Rect,
  mask?: (x: number, y: number) => boolean,
  radius = 3,
): NativeRefinement {
  if (a.width !== b.width || a.height !== b.height) {
    return { x: Math.round(guess.x), y: Math.round(guess.y), error: Infinity, samples: 0, runnerUp: Infinity };
  }
  const w = b.width, h = b.height, points: number[] = [], step = Math.max(3, Math.floor(Math.sqrt(region.width * region.height / 1600)));
  // Luma, not a single channel: a texture edge that only shows up as blue-on-green (equal red) must still count.
  const luma = (i: number) => (b.data[i] * 77 + b.data[i + 1] * 150 + b.data[i + 2] * 29) >> 8;
  for (let y = Math.max(2, Math.ceil(region.y)); y < Math.min(h - 2, region.y + region.height); y += step) {
    for (let x = Math.max(2, Math.ceil(region.x)); x < Math.min(w - 2, region.x + region.width); x += step) {
      if (mask && !mask(x, y)) {
        continue;
      }
      const i = (y * w + x) * 4;
      const grad = Math.abs(luma(i - 4) - luma(i + 4)) + Math.abs(luma(i - w * 4) - luma(i + w * 4));
      if (grad > 12) {
        points.push(y * w + x);
      }
    }
  }
  if (points.length < 12) {
    return { x: Math.round(guess.x), y: Math.round(guess.y), error: Infinity, samples: points.length, runnerUp: Infinity };
  }
  let samples = 0;
  const cost = (dx: number, dy: number): number => {
    let error = 0, n = 0;
    for (const p of points) {
      const x = p % w, y = Math.floor(p / w), xx = x + dx, yy = y + dy;
      if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) {
        continue;
      }
      if (mask && !mask(xx, yy)) {
        continue;
      }
      const i = p * 4, j = (yy * w + xx) * 4;
      error += Math.min(
        90,
        (Math.abs(a.data[j] - b.data[i]) + Math.abs(a.data[j + 1] - b.data[i + 1]) + Math.abs(a.data[j + 2] - b.data[i + 2])) / 3,
      );
      n++;
    }
    samples = Math.max(samples, n);
    return n >= 12 ? error / n : Infinity;
  };
  let best = Infinity, p = { x: Math.round(guess.x), y: Math.round(guess.y) };
  const costs: { x: number; y: number; e: number }[] = [];
  for (let y = Math.round(guess.y) - radius; y <= Math.round(guess.y) + radius; y++) {
    for (let x = Math.round(guess.x) - radius; x <= Math.round(guess.x) + radius; x++) {
      const e = cost(x, y);
      costs.push({ x, y, e });
      if (
        e < best - 1e-6 || (Math.abs(e - best) < 1e-6 && Math.hypot(x - guess.x, y - guess.y) < Math.hypot(p.x - guess.x, p.y - guess.y))
      ) {
        best = e;
        p = { x, y };
      }
    }
  }
  let runnerUp = Infinity;
  for (const c of costs) {
    if (Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) > 2) {
      runnerUp = Math.min(runnerUp, c.e);
    }
  }
  // Keep displacement on the native raster. Quadratic SAD interpolation is biased by codec ringing;
  // repeated fractional updates otherwise drift even for exact integer scrolling. Keyframe anchors
  // estimate the longer-baseline displacement independently, including subpixel-scroll quantization.
  return { x: p.x, y: p.y, error: best, samples, runnerUp };
}
export interface Patch {
  /** Top-left corner in region-local native pixels. */
  x: number;
  y: number;
  size: number;
  data: Uint8Array;
}
/** Native-resolution texture samples kept with a keyframe (a few KB) so revisits and loop edges are measured in native pixels, not analysis pixels. */
export function extractPatches(native: Gray, region: Rect, features: Point[], factor: number, count = 24, size = 32): Patch[] {
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
    const data = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      data.set(native.data.subarray((ry + y + row) * native.width + rx + x, (ry + y + row) * native.width + rx + x + size), row * size);
    }
    out.push({ x, y, size, data });
  }
  return out;
}
/** Measures how well keyframe patches (region-local, in the keyframe's frame) align in the current native frame at `guess` (current → keyframe), refining on the native raster. */
export function refinePatches(patches: Patch[], native: Gray, region: Rect, guess: Point, radius = 3): NativeRefinement {
  const rx = Math.round(region.x),
    ry = Math.round(region.y),
    rw = Math.round(region.width),
    rh = Math.round(region.height),
    w = native.width;
  const gx = Math.round(guess.x), gy = Math.round(guess.y);
  if (!patches.length) {
    return { x: gx, y: gy, error: Infinity, samples: 0, runnerUp: Infinity };
  }
  let samples = 0;
  const cost = (dx: number, dy: number): number => {
    let error = 0, n = 0;
    for (const p of patches) {
      // Patch pixel (px, py) sat at keyframe region-local (p.x + px, p.y + py); the same content is now at that minus the displacement.
      const cx = p.x - dx, cy = p.y - dy;
      if (cx < 0 || cy < 0 || cx + p.size > rw || cy + p.size > rh) {
        continue;
      }
      for (let py = 0; py < p.size; py += 2) {
        const rowA = (ry + cy + py) * w + rx + cx, rowP = py * p.size;
        for (let px = 0; px < p.size; px += 2) {
          error += Math.min(90, Math.abs(native.data[rowA + px] - p.data[rowP + px]));
          n++;
        }
      }
    }
    samples = Math.max(samples, n);
    return n >= 64 ? error / n : Infinity;
  };
  let best = Infinity, bx = gx, by = gy;
  const costs: { x: number; y: number; e: number }[] = [];
  for (let y = gy - radius; y <= gy + radius; y++) {
    for (let x = gx - radius; x <= gx + radius; x++) {
      const e = cost(x, y);
      costs.push({ x, y, e });
      if (e < best - 1e-6 || (Math.abs(e - best) < 1e-6 && Math.hypot(x - guess.x, y - guess.y) < Math.hypot(bx - guess.x, by - guess.y))) {
        best = e;
        bx = x;
        by = y;
      }
    }
  }
  let runnerUp = Infinity;
  for (const c of costs) {
    if (Math.max(Math.abs(c.x - bx), Math.abs(c.y - by)) > 2) {
      runnerUp = Math.min(runnerUp, c.e);
    }
  }
  return { x: bx, y: by, error: best, samples, runnerUp };
}

/** Bilinear resample of an analysis image by a scale factor (probe only; output pixels are never resampled). */
export function resampleGray(g: Gray, scale: number): Gray {
  const width = Math.max(2, Math.round(g.width * scale)),
    height = Math.max(2, Math.round(g.height * scale)),
    data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // ORACLE FIX (mirrors rust/core): clamp to the image, or a 1-pixel source reads undefined (→ 0) neighbours.
      const sx = Math.max(0, Math.min(g.width - 1.001, x / scale)),
        sy = Math.max(0, Math.min(g.height - 1.001, y / scale)),
        x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(g.width - 1, x0 + 1),
        y1 = Math.min(g.height - 1, y0 + 1),
        fx = sx - x0,
        fy = sy - y0,
        at = (xx: number, yy: number) => g.data[yy * g.width + xx];
      data[y * width + x] = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
    }
  }
  return { width, height, data };
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
