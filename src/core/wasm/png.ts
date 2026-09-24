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

/** Tile codec: encodes `width×height` RGBA pixels to a complete PNG file (`Compression::Fast` + the `png`
 *  crate's default Adaptive filter — the dependency audit's chosen setting). One copy in (the pixels), one
 *  copy out (the finished bytes); the handle's own `Vec<u8>` never leaves core memory in between. */
export function pngEncode(core: Core, rgba: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const [input] = core.scratch([rgba.byteLength]);
  core.writeBytes(input, rgba);
  const handle = core.check(core.exports.ls_png_encode(input, width, height), 'PNG encode');
  try {
    const len = core.check(core.exports.ls_png_encode_len(handle), 'PNG encode length');
    const [output] = core.scratch([len]);
    core.check(core.exports.ls_png_encode_read(handle, output), 'PNG encode read');
    return core.readBytes(output, len);
  } finally {
    core.exports.ls_png_encode_free(handle);
  }
}

/** Tile codec: decodes a complete PNG file into RGBA. `width`/`height` are the caller's own IHDR read (see
 *  `abi/png.rs::ls_png_decode`'s doc comment for why the container is still validated in TS). One copy in, one
 *  copy out, no async streams. */
export function pngDecode(core: Core, bytes: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const cap = width * height * 4;
  const [input, output] = core.scratch([bytes.byteLength, cap]);
  core.writeBytes(input, bytes);
  core.check(core.exports.ls_png_decode(input, bytes.byteLength, output, cap), 'PNG decode');
  return new Uint8ClampedArray(core.readBytes(output, cap).buffer);
}

/** One-shot `crc32fast` (hardware-accelerated where available) over bytes already contiguous in memory
 *  (`src/codec/png.ts::decodePNG`'s per-chunk CRC check). Replaces the hand-rolled JS CRC32 table. */
export function crc32(core: Core, bytes: Uint8Array): number {
  const [input] = core.scratch([bytes.byteLength]);
  core.writeBytes(input, bytes);
  return core.exports.ls_crc32(input, bytes.byteLength) >>> 0;
}
