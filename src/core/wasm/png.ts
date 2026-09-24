/** PNG scanline (un)filtering for the RGBA export path (mirrors `rust/core/src/abi/png.rs`). */
import type { Core } from './core.ts';

export function pngUnfilter(core: Core, raw: Uint8Array, width: number, height: number, channels: number): Uint8ClampedArray {
  const [input, output] = core.scratch([raw.byteLength, width * height * 4]);
  core.writeBytes(input, raw);
  core.check(core.exports.ls_png_unfilter(input, width, height, channels, output), 'PNG scanline reconstruction');
  return new Uint8ClampedArray(core.readBytes(output, width * height * 4).buffer);
}
export function pngFilterSub(core: Core, rgba: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const [input, output] = core.scratch([rgba.byteLength, (width * 4 + 1) * height]);
  core.writeBytes(input, rgba);
  core.check(core.exports.ls_png_filter_sub(input, width, height, output), 'PNG filtering');
  return core.readBytes(output, (width * 4 + 1) * height);
}
