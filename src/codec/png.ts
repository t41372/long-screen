import { CRC32, utf8 } from '../export/crc.ts';
import type { RGBA } from '../types.ts';
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
      let batch = new Uint8Array(stride * batchRows), used = 0;
      for await (const row of rows) {
        if (row.length !== width * 4) throw new Error('PNG row has incorrect byte length.');
        const offset = used * stride;
        batch[offset] = 1;
        batch.set(row.subarray(0, 4), offset + 1);
        for (let i = 4; i < row.length; i++) batch[offset + i + 1] = (row[i] - row[i - 4]) & 255;
        used++;
        count++;
        // One native compression write per ~64 KiB, not per scanline. Bounded memory, same PNG predictor.
        if (used === batchRows) {
          await writer.write(batch);
          batch = new Uint8Array(stride * batchRows);
          used = 0;
        }
      }
      if (used) await writer.write(batch.subarray(0, used * stride));
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
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
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
  const out = new Uint8ClampedArray(width * height * 4);
  let line = new Uint8Array(stride), previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    switch (filter) {
      case 0:
        line.set(src);
        break;
      case 1:
        line.set(src.subarray(0, channels));
        for (let i = channels; i < stride; i++) line[i] = src[i] + line[i - channels];
        break;
      case 2:
        for (let i = 0; i < stride; i++) line[i] = src[i] + previous[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++) line[i] = src[i] + (((i >= channels ? line[i - channels] : 0) + previous[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          line[i] = src[i] + paeth(i >= channels ? line[i - channels] : 0, previous[i], i >= channels ? previous[i - channels] : 0);
        }
        break;
      default:
        throw new Error(`Invalid PNG filter ${filter}.`);
    }
    // Tile PNGs are already RGBA: preserve bytes directly, including transparent RGB.
    if (channels === 4) {
      out.set(line, y * stride);
    } else {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4, i = x * channels;
        if (channels >= 3) {
          out[o] = line[i];
          out[o + 1] = line[i + 1];
          out[o + 2] = line[i + 2];
          out[o + 3] = 255;
        } else {
          out[o] = out[o + 1] = out[o + 2] = line[i];
          out[o + 3] = channels === 2 ? line[i + 1] : 255;
        }
      }
    }
    const scratch = previous;
    previous = line;
    line = scratch;
  }
  return { width, height, data: out };
}
