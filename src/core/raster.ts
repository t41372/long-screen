import type { Gray, Rect, RGBA } from '../types.ts';
import { core, ResidentFrame } from './wasm.ts';

/** The floating-point pose remains diagnostic data; every native raster operation uses this integer origin. */
export interface RasterPose {
  optimizedX: number;
  optimizedY: number;
  rasterX: number;
  rasterY: number;
}

export function resolveRasterPose(x: number, y: number): RasterPose {
  return { optimizedX: x, optimizedY: y, rasterX: Math.round(x), rasterY: Math.round(y) };
}

/** Integer analysis factor: each full analysis cell is factor×factor native pixels; edge cells may be partial. */
export function analysisFactor(width: number, height: number, analysisSize: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / Math.max(1, analysisSize)));
}
/** Box-filtered luma at an integer factor (Rust core). Deterministic in every runtime; no canvas resampling. */
export function downscaleGray(image: RGBA | ResidentFrame, factor: number): Gray {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Invalid analysis factor ${factor}.`);
  }
  return core().downscaleGray(image, factor);
}
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
/** 2:1 preview reduction with alpha weighting (Rust core), so unobserved (transparent) neighbours never darken observed pixels. */
export function halveRGBA(image: RGBA): RGBA {
  return core().halveRGBA(image);
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

/** Exact observation equality. Small or single-frame content updates must never be discarded by a similarity threshold. */
export function equalRGBA(a: RGBA, b: RGBA): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = new Uint32Array(a.data.buffer, a.data.byteOffset, a.data.length / 4);
  const y = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.length / 4);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
