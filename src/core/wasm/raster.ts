/** Pixel-format conversion and simple per-pixel raster kernels (mirrors `rust/core/src/abi/raster.rs`). */
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
/** RGBA of a decoded frame given in its `VideoFrame.copyTo` layout (see rust/core/src/yuv.rs for the codes). `dest`,
 *  when given and the right length, is filled in place instead of allocating a fresh output buffer — how
 *  `planarConverter` (src/media/convert.ts) hands this the explicit-release pool's buffer (src/media/pool.ts)
 *  instead of paying for a new 30 MB buffer every frame. Either way this is one copy out of the arena (the arena
 *  itself is scratch, replanned by the next call), never zero — that is left to the zero-copy-into-the-ring path. */
export function frameToRGBA(
  core: Core,
  src: Uint8Array,
  format: number,
  layout: { offset: number; stride: number }[],
  width: number,
  height: number,
  matrix: number,
  dest?: Uint8ClampedArray,
): Uint8ClampedArray {
  const [input, planes, output] = core.scratch([src.byteLength, 32, width * height * 4]);
  core.writeBytes(input, src);
  const table = new Uint32Array(8);
  layout.slice(0, 4).forEach((p, i) => table.set([p.offset, p.stride], i * 2));
  core.writeBytes(planes, table);
  core.check(core.exports.ls_frame_to_rgba(input, src.byteLength, format, width, height, planes, matrix, output), 'frameToRGBA');
  if (dest && dest.length === width * height * 4) {
    dest.set(new Uint8Array(core.exports.memory.buffer, output, width * height * 4));
    return dest;
  }
  return new Uint8ClampedArray(core.readBytes(output, width * height * 4).buffer);
}
/** Refreshes a fixed region's resident saved pixels (`rw × rh` RGBA from `(x0, y0)`) from a resident frame and
 *  labels; true when a pixel the region owns changed. */
export function fixedUpdate(
  core: Core,
  saved: { ptr: number; length: number },
  frame: ResidentFrame,
  labels: { ptr: number; length: number },
  x0: number,
  y0: number,
  rw: number,
  rh: number,
  code: number,
): boolean {
  if (saved.length !== rw * rh * 4 || labels.length !== frame.width * frame.height) {
    throw new Error('CORE_BAD_ARGUMENT: fixed region buffers do not match.');
  }
  return core.check(
    core.exports.ls_fixed_update(saved.ptr, frame.ptr, labels.ptr, frame.width, frame.height, x0, y0, rw, rh, code),
    'fixedUpdate',
  ) === 1;
}
export function meanDifference(core: Core, a: Gray, b: Gray): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  const [pa, pb] = core.scratch([a.data.byteLength, b.data.byteLength]);
  core.writeBytes(pa, a.data);
  core.writeBytes(pb, b.data);
  return core.exports.ls_mean_difference(pa, pb, a.data.byteLength);
}
