/** FROZEN TypeScript kernels: the pre-migration implementations, kept verbatim as parity oracles for the
 *  Rust core (tests/unit/core-parity.test.ts). Not used by production code. Do not "fix" these; a behaviour
 *  change belongs in rust/core with a deliberately updated test. */
import type { Feature, Gray, Match, Rect, RGBA } from '../../../src/types.ts';
import { contains, hamming, rng } from './math.ts';
const random = rng(0xabc7361);
const pairs = Array.from({ length: 256 }, () => {
  const coord = () => Math.round((random() + random() + random() - 1.5) * 6);
  return [coord(), coord(), coord(), coord()];
});
export function grayscale(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { width, height, data };
}
export function smooth(g: Gray): Gray {
  const { width: w, height: h, data: a } = g, b = new Uint8Array(a.length);
  b.set(a);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      b[i] = (a[i - w - 1] + 2 * a[i - w] + a[i - w + 1] + 2 * a[i - 1] + 4 * a[i] + 2 * a[i + 1] + a[i + w - 1] + 2 * a[i + w] +
        a[i + w + 1]) >> 4;
    }
  }
  return { width: w, height: h, data: b };
}
/** Spatially balanced minimum-eigenvalue corners and deterministic 256-bit BRIEF. */
export function extractFeatures(image: Gray, maxFeatures = 480, roi?: Rect): Feature[] {
  const g = smooth(image), { width: w, height: h, data: d } = g;
  // Summed-area tensors: the old inner loop recomputed the same nine gradients for every candidate.
  // Integer sums in Float64 preserve the exact eigenvalue scores (including tie order) of that implementation.
  const stride = w + 1, length = stride * (h + 1);
  const tx = new Float64Array(length), ty = new Float64Array(length), txy = new Float64Array(length);
  for (let y = 1; y < h - 1; y++) {
    let xx = 0, yy = 0, xy = 0;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, gx = d[i + 1] - d[i - 1], gy = d[i + w] - d[i - w];
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
      const j = (y + 1) * stride + x + 1;
      tx[j] = tx[j - stride] + xx;
      ty[j] = ty[j - stride] + yy;
      txy[j] = txy[j - stride] + xy;
    }
  }
  const candidates: { x: number; y: number; score: number }[] = [], cell = 28;
  const localX = new Int32Array(cell * cell), localY = new Int32Array(cell * cell), localScore = new Float64Array(cell * cell);
  for (let by = 11; by < h - 11; by += cell) {
    for (let bx = 11; bx < w - 11; bx += cell) {
      let count = 0;
      for (let y = by; y < Math.min(h - 11, by + cell); y++) {
        for (let x = bx; x < Math.min(w - 11, bx + cell); x++) {
          if (roi && !contains(roi, x, y)) continue;
          const a = (y - 1) * stride + x - 1, b = a + 3, c = a + 3 * stride, e = c + 3;
          const xx = tx[e] - tx[b] - tx[c] + tx[a], yy = ty[e] - ty[b] - ty[c] + ty[a], xy = txy[e] - txy[b] - txy[c] + txy[a];
          const score = (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2;
          if (score > 100) {
            localX[count] = x;
            localY[count] = y;
            localScore[count++] = score;
          }
        }
      }
      // Three stable argmax passes replace a sort and hundreds of short-lived objects per cell.
      for (let n = 0; n < 3; n++) {
        let best = -1, score = 100;
        for (let i = 0; i < count; i++) {
          if (localScore[i] > score) {
            best = i;
            score = localScore[i];
          }
        }
        if (best < 0) break;
        const x = localX[best], y = localY[best];
        candidates.push({ x, y, score });
        for (let i = 0; i < count; i++) if ((localX[i] - x) ** 2 + (localY[i] - y) ** 2 <= 36) localScore[i] = 0;
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxFeatures).map((p) => {
    const descriptor = new Uint32Array(8);
    for (let bit = 0; bit < 256; bit++) {
      const [ax, ay, bx, by] = pairs[bit];
      if (d[(p.y + ay) * w + p.x + ax] < d[(p.y + by) * w + p.x + bx]) {
        descriptor[bit >> 5] |= 1 << (bit & 31);
      }
    }
    return { ...p, descriptor };
  });
}
/** Mutual-nearest distinct matches, plus explicitly marked ambiguous alternatives. */
export function matchFeatures(a: Feature[], b: Feature[], includeAmbiguous = true): Match[] {
  if (!a.length || !b.length) {
    return [];
  }
  const bestA = new Int32Array(a.length).fill(-1),
    bestDist = new Uint16Array(a.length).fill(257),
    second = new Uint16Array(a.length).fill(257);
  const bestB = new Int32Array(b.length).fill(-1), distB = new Uint16Array(b.length).fill(257);
  const alt = new Int32Array(a.length).fill(-1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = hamming(a[i].descriptor, b[j].descriptor, Math.max(second[i], distB[j]));
      if (d < bestDist[i]) {
        second[i] = bestDist[i];
        alt[i] = bestA[i];
        bestDist[i] = d;
        bestA[i] = j;
      } else if (d < second[i]) {
        second[i] = d;
        alt[i] = j;
      }
      if (d < distB[j]) {
        distB[j] = d;
        bestB[j] = i;
      }
    }
  }
  const out: Match[] = [];
  for (let i = 0; i < a.length; i++) {
    const j = bestA[i];
    if (j < 0 || bestDist[i] > 72) {
      continue;
    }
    const unique = bestB[j] === i && bestDist[i] < second[i] * 0.82 && second[i] - bestDist[i] >= 4;
    if (unique) {
      out.push({ a: a[i], b: b[j], distance: bestDist[i], unique: true });
    } else if (includeAmbiguous && bestDist[i] < 45) {
      out.push({ a: a[i], b: b[j], distance: bestDist[i], unique: false });
      const k = alt[i];
      if (k >= 0 && second[i] < bestDist[i] + 8) {
        out.push({ a: a[i], b: b[k], distance: second[i], unique: false });
      }
    }
  }
  return out;
}
export function featureWords(features: Feature[]): number[] {
  const words = new Set<number>();
  // Four independent 12-bit bands; persistent postings support old, distant revisits.
  for (const f of features) {
    for (let k = 0; k < 4; k++) {
      words.add((k << 12) | ((f.descriptor[k * 2] ^ (f.descriptor[k * 2 + 1] >>> 8)) & 4095));
    }
  }
  return [...words];
}
export function meanDifference(a: Gray, b: Gray): number {
  if (a.width !== b.width || a.height !== b.height) {
    return 255;
  }
  let s = 0;
  for (let i = 0; i < a.data.length; i++) {
    s += Math.abs(a.data[i] - b.data[i]);
  }
  return s / a.data.length;
}

export function downscaleGray(image: RGBA, factor: number): Gray {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Invalid analysis factor ${factor}.`);
  }
  const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
  const data = new Uint8Array(width * height), src = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Clamp the sampled box to the image: a dimension forced up to 1 by the max(1, …) above can be smaller than `factor`.
      const bh = Math.min(factor, image.height - y * factor), bw = Math.min(factor, image.width - x * factor);
      let sum = 0;
      for (let j = 0; j < bh; j++) {
        let i = ((y * factor + j) * image.width + x * factor) * 4;
        for (let k = 0; k < bw; k++, i += 4) {
          sum += src[i] * 77 + src[i + 1] * 150 + src[i + 2] * 29;
        }
      }
      data[y * width + x] = (sum / (bw * bh)) >> 8;
    }
  }
  return { width, height, data };
}

export function halveRGBA(image: RGBA): RGBA {
  const width = Math.max(1, image.width >> 1),
    height = Math.max(1, image.height >> 1),
    data = new Uint8ClampedArray(width * height * 4),
    src = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          const sx = Math.min(image.width - 1, x * 2 + k),
            sy = Math.min(image.height - 1, y * 2 + j),
            i = (sy * image.width + sx) * 4,
            w = src[i + 3];
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          a += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a) {
        data[o] = r / a;
        data[o + 1] = g / a;
        data[o + 2] = b / a;
        data[o + 3] = a / 4;
      }
    }
  }
  return { width, height, data };
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function unfilterPNG(raw: Uint8Array, width: number, height: number, channels: number): Uint8ClampedArray {
  const stride = width * channels, out = new Uint8ClampedArray(width * height * 4);
  let line = new Uint8Array(stride), previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    switch (filter) {
      case 0:
        line.set(src);
        break;
      case 1:
        line.set(src.subarray(0, channels));
        for (let i = channels; i < stride; i++) line[i] = src[i] + line[i - channels];
        break;
      case 2:
        for (let i = 0; i < stride; i++) line[i] = src[i] + previous[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++) line[i] = src[i] + (((i >= channels ? line[i - channels] : 0) + previous[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          line[i] = src[i] + paeth(i >= channels ? line[i - channels] : 0, previous[i], i >= channels ? previous[i - channels] : 0);
        }
        break;
      default:
        throw new Error(`Invalid PNG filter ${filter}.`);
    }
    if (channels === 4) {
      out.set(line, y * stride);
    } else {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4, i = x * channels;
        if (channels >= 3) {
          out[o] = line[i];
          out[o + 1] = line[i + 1];
          out[o + 2] = line[i + 2];
          out[o + 3] = 255;
        } else {
          out[o] = out[o + 1] = out[o + 2] = line[i];
          out[o + 3] = channels === 2 ? line[i + 1] : 255;
        }
      }
    }
    const scratch = previous;
    previous = line;
    line = scratch;
  }
  return out;
}
export function filterSub(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = width * 4, out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride), offset = y * (stride + 1);
    out[offset] = 1;
    out.set(row.subarray(0, 4), offset + 1);
    for (let i = 4; i < row.length; i++) out[offset + i + 1] = (row[i] - row[i - 4]) & 255;
  }
  return out;
}
