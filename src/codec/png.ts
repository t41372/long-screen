import { CRC32, utf8 } from './crc.ts';
import type { RGBA } from '../types.ts';
import { core } from '../core/wasm.ts';
function chunk(type: string, body: Uint8Array): Uint8Array {
  const name = utf8(type), out = new Uint8Array(body.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(name, 4);
  out.set(body, 8);
  const crc = new CRC32();
  crc.update(name);
  crc.update(body);
  view.setUint32(body.length + 8, crc.digest());
  return out;
}
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Streaming PNG encoder with bounded row/deflater memory, independent of image height. No giant canvas. */
export async function* encodePNG(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff
  ) {
    throw new Error('Invalid PNG dimensions.');
  }
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'COMPRESSION_UNAVAILABLE: Streaming PNG needs CompressionStream. Every tile is encoded as a PNG, so no export path is available without it.',
    );
  }
  yield new Uint8Array(SIGNATURE);
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  yield chunk('IHDR', ihdr);
  const stream = new CompressionStream('deflate'), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
  let failure: unknown, finished = false;
  const producer = (async () => {
    try {
      let count = 0;
      const stride = width * 4 + 1, batchRows = Math.max(1, Math.floor(65536 / stride));
      // Rows are gathered raw and Sub-filtered in the Rust core one batch at a time: the filter has no
      // inter-row dependency, so the bytes equal a per-row filter while the core is entered ~30× less often.
      const raw = new Uint8Array(width * 4 * batchRows);
      let used = 0;
      const flush = async () => {
        await writer.write(core().pngFilterSub(raw.subarray(0, used * width * 4), width, used));
        used = 0;
      };
      for await (const row of rows) {
        if (row.length !== width * 4) throw new Error('PNG row has incorrect byte length.');
        raw.set(row, used * width * 4);
        used++;
        count++;
        // One native compression write per ~64 KiB, not per scanline. Bounded memory, same PNG predictor.
        if (used === batchRows) await flush();
      }
      if (used) await flush();
      if (count !== height) {
        throw new Error(`Expected ${height} PNG rows, received ${count}.`);
      }
      await writer.close();
    } catch (e) {
      failure = e;
      await writer.abort(e).catch(() => {});
    }
  })();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      yield chunk('IDAT', result.value);
    }
    await producer;
    if (failure) {
      throw failure;
    }
    finished = true;
    yield chunk('IEND', new Uint8Array());
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
    await producer;
  }
}
/** Tile codec: one call to the core's `png` crate encoder (`Compression::Fast` + its default Adaptive filter —
 *  the dependency audit's chosen setting), synchronous work behind this async signature. Replaces the streaming
 *  `encodePNG`/`CompressionStream` path above for the common case (a whole RGBA image already in memory); that
 *  path stays, for the giant single-PNG export whose height would otherwise need the whole canvas resident. */
export async function encodeRGBA(image: RGBA): Promise<Uint8Array<ArrayBuffer>> {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error('RGBA buffer does not match its dimensions.');
  }
  return core().pngEncode(
    new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    image.width,
    image.height,
  );
}
/** Decodes 8-bit non-interlaced PNG (grey, grey+alpha, RGB, RGBA) into RGBA. Palette, 16-bit and interlaced
 *  images are rejected explicitly. The container (signature, per-chunk CRC, IHDR colour/depth/interlace,
 *  truncation, IHDR/IEND presence) is still walked and verified here, in TS, so every rejection this function
 *  is tested against (`tests/unit/codec.test.ts`) keeps its exact existing message; only the actual pixel
 *  reconstruction (inflate + unfilter + colour expansion, no more `DecompressionStream`) moves to the core's
 *  `ls_png_decode`, which receives the whole validated file in one call. */
export async function decodePNG(bytes: Uint8Array): Promise<RGBA> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a PNG file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, colour = -1, depth = 0, interlace = 0, ended = false;
  while (offset + 8 <= bytes.length && !ended) {
    const size = view.getUint32(offset),
      type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset + 12 + size > bytes.length) {
      throw new Error(`Truncated PNG chunk ${type}.`);
    }
    if (core().crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== view.getUint32(offset + 8 + size)) {
      throw new Error(`PNG chunk ${type} failed its CRC check.`);
    }
    if (type === 'IHDR') {
      const body = bytes.subarray(offset + 8, offset + 8 + size);
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === 'IEND') {
      ended = true;
    }
    offset += 12 + size;
  }
  if (!ended || !width || !height) {
    throw new Error('PNG is missing IHDR or IEND.');
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (!channels || depth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG layout: colour type ${colour}, ${depth}-bit, interlace ${interlace}.`);
  }
  let out: Uint8ClampedArray;
  try {
    out = core().pngDecode(bytes, width, height);
  } catch (e) {
    // The one failure the container walk above cannot see — the scanline filter-type byte lives inside the
    // deflate stream — keeps its own distinct message via core.check()'s STATUS_BAD_FILTER convention (see
    // rust/core/src/abi/png.rs::classify). Anything else here means the declared IHDR dimensions do not match
    // the actual (inflated) scanline data length, the same condition the old inflate-in-TS path caught by
    // comparing byte counts directly.
    if (e instanceof Error && e.message.startsWith('Invalid PNG filter')) throw e;
    const stride = width * channels;
    throw new Error(
      `PNG data does not decode to its declared ${width}×${height}; expected ${(stride + 1) * height} bytes of scanline data.`,
    );
  }
  return { width, height, data: out };
}
