import type { Gray, RGBA } from '../types.ts';
import { core, type ResidentFrame } from './wasm.ts';

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
