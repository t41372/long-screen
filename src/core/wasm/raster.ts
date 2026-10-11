/** Pixel-format conversion and simple per-pixel raster kernels (mirrors `rust/wasm/src/raster.rs`). */
import type { Gray, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import { type FrameInput, ResidentFrame, type ResidentGray } from './memory.ts';

export function grayscale(core: Core, rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const n = width * height;
  const [input, output] = core.scratch([n * 4, n]);
  core.writeBytes(input, rgba);
  core.check(core.exports.ls_grayscale(input, width, height, output), 'grayscale');
  return { width, height, data: core.readBytes(output, n) };
}
/** Full-resolution luma of a resident frame, written into a resident plane without leaving core memory. */
export function grayscaleInto(core: Core, frame: ResidentFrame, out: ResidentGray): ResidentGray {
  if (out.width !== frame.width || out.height !== frame.height) {
    throw new Error('CORE_BAD_ARGUMENT: luma plane does not match the frame.');
  }
  core.check(core.exports.ls_grayscale(frame.ptr, frame.width, frame.height, out.ptr), 'grayscale');
  return out;
}
export function downscaleGray(core: Core, image: FrameInput, factor: number): Gray {
  const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
  const resident = image instanceof ResidentFrame;
  const [scratch, output] = core.scratch([resident ? 0 : image.width * image.height * 4, width * height]);
  const input = core.placeFrame(image, scratch);
  core.check(core.exports.ls_downscale_gray(input, image.width, image.height, factor, output), 'downscaleGray');
  return { width, height, data: core.readBytes(output, width * height) };
}
export function halveRGBA(core: Core, image: RGBA): RGBA {
  const width = Math.max(1, image.width >> 1), height = Math.max(1, image.height >> 1);
  const [input, output] = core.scratch([image.data.byteLength, width * height * 4]);
  core.writeBytes(input, image.data);
  core.check(core.exports.ls_halve_rgba(input, image.width, image.height, output), 'halveRGBA');
  return { width, height, data: new Uint8ClampedArray(core.readBytes(output, width * height * 4).buffer) };
}
export function meanDifference(core: Core, a: Gray, b: Gray): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  const [pa, pb] = core.scratch([a.data.byteLength, b.data.byteLength]);
  core.writeBytes(pa, a.data);
  core.writeBytes(pb, b.data);
  return core.exports.ls_mean_difference(pa, pb, a.data.byteLength);
}
