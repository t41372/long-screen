import type { Rect } from '../types.ts';

/** A reduction ratio, an upper limit for upload dimensions, or both. Omitted fields preserve native size. */
export interface ImageSize {
  scale?: number;
  maxEdge?: number;
}

/** Fit the kept rectangle inside an optional upload limit, preserving its aspect ratio to whole pixels.
 *  A limit larger than the print never enlarges it. Shared by the output readout and the worker. */
export function outputDimensions(rect: Pick<Rect, 'width' | 'height'>, size: ImageSize = {}): { width: number; height: number } {
  const { maxEdge, scale = 1 } = size;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error('Invalid output scale');
  if (maxEdge !== undefined && (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 0x7fffffff)) {
    throw new Error('Invalid output size');
  }
  const ratio = maxEdge === undefined ? scale : Math.min(scale, maxEdge / Math.max(rect.width, rect.height));
  return { width: Math.max(1, Math.floor(rect.width * ratio)), height: Math.max(1, Math.floor(rect.height * ratio)) };
}
