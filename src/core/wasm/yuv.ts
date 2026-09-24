/** Decoded-video-frame-to-RGBA conversion (mirrors `rust/core/src/abi/yuv.rs`). */
import type { Core } from './core.ts';

/** RGBA of a decoded frame given in its `VideoFrame.copyTo` layout (see rust/core/src/yuv.rs for the codes). `dest`,
 *  when given and the right length, is filled in place instead of allocating a fresh output buffer — how
 *  `planarConverter` (src/media/convert.ts) hands this the explicit-release pool's buffer (src/media/pool.ts)
 *  instead of paying for a new 30 MB buffer every frame. Either way this is one copy out of the arena (the arena
 *  itself is scratch, replanned by the next call). */
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
