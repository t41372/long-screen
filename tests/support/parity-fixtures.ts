import type { Gray, RGBA } from '../../src/types.ts';
import { rng } from '../../src/core/math.ts';

/** Deterministic textured page: blocks, gradients and noise, so corners, flat areas and repeated structure all occur. */
export function textureGray(width: number, height: number, seed: number): Gray {
  const random = rng(seed | 1), data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = ((x >> 5) * 7 + (y >> 5) * 13) & 3, base = block === 0 ? 30 : block === 1 ? 120 : block === 2 ? 200 : (x + y) & 255;
      data[y * width + x] = Math.min(255, Math.max(0, base + Math.floor(random() * 24) - 12));
    }
  }
  return { width, height, data };
}
export function rgbaOf(g: Gray): RGBA {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) {
    data[i * 4] = g.data[i];
    data[i * 4 + 1] = (g.data[i] * 3) & 255;
    data[i * 4 + 2] = 255 - g.data[i];
    data[i * 4 + 3] = 255;
  }
  return { width: g.width, height: g.height, data };
}
