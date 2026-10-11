/** Decoded-video-frame-to-RGBA conversion (mirrors `rust/wasm/src/yuv.rs`). */
import type { Core } from './core.ts';

/** What a conversion saw: pixels brighter than SDR white (HDR signals only; rust/long-screen/src/kernels/yuv/hdr.rs `ABOVE_WHITE`). */
export interface ConversionReport {
  above: number;
}
/** RGBA of a decoded frame given in its `VideoFrame.copyTo` layout (see rust/long-screen/src/kernels/yuv.rs for the format and colour
 *  codes). `dest`, when given and the right length, is filled in place instead of allocating a fresh output buffer —
 *  how `planarConverter` (src/media/convert.ts) hands this the explicit-release pool's buffer (src/media/pool.ts)
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
  report?: ConversionReport,
): Uint8ClampedArray {
  const [input, planes, output] = core.scratch([src.byteLength, 32, width * height * 4]);
  const above = convert(core, src, format, layout, width, height, matrix, input, planes, output);
  if (report) report.above = above;
  if (dest && dest.length === width * height * 4) {
    dest.set(new Uint8Array(core.exports.memory.buffer, output, width * height * 4));
    return dest;
  }
  return new Uint8ClampedArray(core.readBytes(output, width * height * 4).buffer);
}
/** `frameToRGBA` into core memory at `out` (`width × height × 4` bytes outside the scratch arena, e.g. a resident
 *  frame slot): the same conversion, without copying the RGBA out and back in. */
export function frameToCore(
  core: Core,
  src: Uint8Array,
  format: number,
  layout: { offset: number; stride: number }[],
  width: number,
  height: number,
  matrix: number,
  out: number,
): void {
  // One plan for every scratch buffer: the arena is replanned by each scratch() call.
  const [input, planes] = core.scratch([src.byteLength, 32]);
  convert(core, src, format, layout, width, height, matrix, input, planes, out);
}
function convert(
  core: Core,
  src: Uint8Array,
  format: number,
  layout: { offset: number; stride: number }[],
  width: number,
  height: number,
  matrix: number,
  input: number,
  planes: number,
  out: number,
): number {
  core.writeBytes(input, src);
  const table = new Uint32Array(8);
  layout.slice(0, 4).forEach((p, i) => table.set([p.offset, p.stride], i * 2));
  core.writeBytes(planes, table);
  return core.check(core.exports.ls_frame_to_rgba(input, src.byteLength, format, width, height, planes, matrix, out), 'frameToRGBA');
}
/** How `hdrToRGBA` receives R'G'B': RGBA8, or RGB10A2 (WebGPU `rgb10a2unorm`, red in the low ten bits). */
export const PACKINGS = { rgba8: 0, rgb10a2: 1 } as const;
/** Transfer codes shared with rust/long-screen/src/kernels/yuv.rs `Signal` (1 PQ, 2 HLG). */
export const TRANSFERS = { pq: 1, hlg: 2 } as const;
/** sRGB RGBA, written over `pixels` in place, of R'G'B' that a browser converted from an HDR frame without undoing its
 *  transfer (BT.2020 primaries, PQ or HLG); returns how many pixels lie above SDR white. */
export function hdrToRGBA(
  core: Core,
  pixels: Uint8Array | Uint8ClampedArray,
  packing: keyof typeof PACKINGS,
  width: number,
  height: number,
  transfer: keyof typeof TRANSFERS,
): number {
  const [buffer] = core.scratch([width * height * 4]);
  core.writeBytes(buffer, pixels);
  const above = core.check(
    core.exports.ls_hdr_rgb_to_rgba(buffer, PACKINGS[packing], width, height, TRANSFERS[transfer]),
    'hdrToRGBA',
  );
  pixels.set(new Uint8Array(core.exports.memory.buffer, buffer, width * height * 4));
  return above;
}
