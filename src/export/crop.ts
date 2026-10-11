/** The user's crop of a canvas: a rectangle in that canvas's world pixels, kept per canvas with the stored print
 *  (`crop/<canvasId>` in the print's `run/<id>/` namespace, src/worker.ts) and applied by exportCanvas to the PNG,
 *  the paged sheets and the clipboard copy. Rectangle arithmetic only; no pixel is touched here. */
import type { Rect } from '../types.ts';

/** Store key prefix of a print's crops, one row per cropped canvas. */
export const CROP_PREFIX = 'crop/';

/** The whole pixels an export of a canvas covers: its bounds, widened to pixel edges. */
export function canvasRect(bounds: Rect): Rect {
  const left = Math.floor(bounds.x), top = Math.floor(bounds.y);
  return { x: left, y: top, width: Math.ceil(bounds.x + bounds.width) - left, height: Math.ceil(bounds.y + bounds.height) - top };
}

/** `crop` as whole pixels (each edge rounded to the nearest pixel edge) inside the canvas, or undefined when that
 *  leaves nothing: an empty or inverted rectangle, one outside the canvas, or one with a non-finite coordinate. */
export function clampCrop(crop: Rect, bounds: Rect): Rect | undefined {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) return undefined;
  const canvas = canvasRect(bounds);
  const left = Math.max(canvas.x, Math.round(crop.x)), top = Math.max(canvas.y, Math.round(crop.y));
  const right = Math.min(canvas.x + canvas.width, Math.round(crop.x + crop.width)),
    bottom = Math.min(canvas.y + canvas.height, Math.round(crop.y + crop.height));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

/** Whether `rect` covers the whole canvas, i.e. cropping to it changes nothing. */
export function coversCanvas(rect: Rect, bounds: Rect): boolean {
  const canvas = canvasRect(bounds);
  return rect.x <= canvas.x && rect.y <= canvas.y && rect.x + rect.width >= canvas.x + canvas.width &&
    rect.y + rect.height >= canvas.y + canvas.height;
}
