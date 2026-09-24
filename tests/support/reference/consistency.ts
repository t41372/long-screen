import { resolveRasterPose } from './math.ts';
import type { RegionAtlas } from '../../../src/core/layers.ts';
import type { Rect, Region, RGBA } from '../../../src/types.ts';

/** The pre-optimization implementation, kept independent so randomized tests can detect semantic drift. */
export interface ConsistencyReferenceVote {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  clean: Uint8Array;
}

export interface ConsistencyReferenceNeighbour {
  image: RGBA;
  x: number;
  y: number;
  canvasId: string;
  occlusions?: Rect[];
  voting?: ConsistencyReferenceVote;
}

export function consistencyMaskReference(
  image: RGBA,
  atlas: RegionAtlas,
  region: Region,
  code: number,
  pose: { x: number; y: number },
  canvasId: string,
  prev: ConsistencyReferenceNeighbour | undefined,
  next: ConsistencyReferenceNeighbour | undefined,
  voting: ConsistencyReferenceVote | undefined,
  factor: number,
  noise: number,
): Uint8Array {
  const W = image.width,
    H = image.height,
    out = new Uint8Array(W * H).fill(1),
    currentRaster = resolveRasterPose(pose.x, pose.y);
  const rx0 = Math.max(0, Math.floor(region.rect.x)), ry0 = Math.max(0, Math.floor(region.rect.y));
  const rx1 = Math.min(W, Math.ceil(region.rect.x + region.rect.width)), ry1 = Math.min(H, Math.ceil(region.rect.y + region.rect.height));
  const verdict = (v: ConsistencyReferenceVote | undefined, x: number, y: number): number => {
    if (!v) {
      return 0;
    }
    const lx = Math.floor(x / factor) - v.x0, ly = Math.floor(y / factor) - v.y0;
    if (lx < 0 || ly < 0 || lx >= v.w || ly >= v.h) {
      return 0;
    }
    const i = ly * v.w + lx, bit = 1 << (i & 7);
    return v.bits[i >> 3] & bit ? -1 : v.clean[i >> 3] & bit ? 1 : 0;
  };
  for (let sy = ry0; sy < ry1; sy++) {
    for (let sx = rx0; sx < rx1; sx++) {
      if (!atlas.contains(code, sx, sy)) {
        continue;
      }
      const src = sy * W + sx, k = src * 4;
      if (verdict(voting, sx, sy) < 0) {
        out[src] = 0;
        continue;
      }
      let checked = 0, condemned = 0, excused = 0;
      for (const neighbour of [prev, next]) {
        if (!neighbour || neighbour.canvasId !== canvasId) {
          continue;
        }
        const neighbourRaster = resolveRasterPose(neighbour.x, neighbour.y);
        const ix = sx + currentRaster.rasterX - neighbourRaster.rasterX, iy = sy + currentRaster.rasterY - neighbourRaster.rasterY;
        if (!atlas.contains(code, ix, iy)) {
          continue;
        }
        if (neighbour.occlusions?.some((r) => ix >= r.x && iy >= r.y && ix < r.x + r.width && iy < r.y + r.height)) {
          continue;
        }
        checked++;
        const j = (iy * W + ix) * 4;
        if (
          image.data[k] === neighbour.image.data[j] && image.data[k + 1] === neighbour.image.data[j + 1] &&
          image.data[k + 2] === neighbour.image.data[j + 2]
        ) continue;
        const diff = (Math.abs(image.data[k] - neighbour.image.data[j]) + Math.abs(image.data[k + 1] - neighbour.image.data[j + 1]) +
          Math.abs(image.data[k + 2] - neighbour.image.data[j + 2])) / 3;
        if (diff <= noise) {
          continue;
        }
        if (verdict(neighbour.voting, ix, iy) < 0) {
          excused++;
        } else {
          condemned++;
        }
      }
      if (condemned || excused && checked >= 2) {
        out[src] = 0;
      }
    }
  }
  return out;
}
