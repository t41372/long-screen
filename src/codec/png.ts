import { CRC32, utf8 } from '../export/crc.ts';
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
function* rowsOf(pixels: Uint8ClampedArray, width: number, height: number): Generator<Uint8Array> {
  for (let y = 0; y < height; y++) {
    yield new Uint8Array(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4);
  }
}
export async function encodeRGBA(image: RGBA): Promise<Uint8Array<ArrayBuffer>> {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error('RGBA buffer does not match its dimensions.');
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of encodePNG(image.width, image.height, rowsOf(image.data, image.width, image.height))) {
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('COMPRESSION_UNAVAILABLE: PNG decoding needs DecompressionStream.');
  }
  const stream = new DecompressionStream('deflate'), writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const parts: Uint8Array[] = [], reader = stream.readable.getReader();
  let total = 0;
  while (true) {
    const r = await reader.read();
    if (r.done) {
      break;
    }
    parts.push(r.value);
    total += r.value.length;
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
/** Decodes 8-bit non-interlaced PNG (grey, grey+alpha, RGB, RGBA) into RGBA. Palette, 16-bit and interlaced images are rejected explicitly. */
export async function decodePNG(bytes: Uint8Array): Promise<RGBA> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a PNG file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, colour = -1, depth = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  let idatLength = 0, ended = false;
  while (offset + 8 <= bytes.length && !ended) {
    const size = view.getUint32(offset),
      type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset + 12 + size > bytes.length) {
      throw new Error(`Truncated PNG chunk ${type}.`);
    }
    const body = bytes.subarray(offset + 8, offset + 8 + size), crc = new CRC32();
    crc.update(bytes.subarray(offset + 4, offset + 8 + size));
    if (crc.digest() !== view.getUint32(offset + 8 + size)) {
      throw new Error(`PNG chunk ${type} failed its CRC check.`);
    }
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
      idatLength += body.length;
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
  const joined = new Uint8Array(idatLength);
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = await inflate(joined), stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`PNG data has ${raw.length} bytes; expected ${(stride + 1) * height}.`);
  }
  // Scanline reconstruction (all five PNG filters, any colour type → RGBA) runs in the Rust core.
  const out = core().pngUnfilter(raw, width, height, channels);
  return { width, height, data: out };
}
