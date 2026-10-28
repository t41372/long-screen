/** HEVC chunk fix-ups the browser's decoder needs before it will take a chunk. */

/** NAL unit type of an access unit delimiter (ITU-T H.265 table 7-1). */
const AUD = 35;

/** Bytes in each NAL unit's length prefix, from an `hvcC` decoder configuration record (`lengthSizeMinusOne`, the low
 *  two bits of byte 21); `undefined` without a record, when the chunks are not length-prefixed this way. */
export function nalLengthSize(description: AllowSharedBufferSource | undefined): number | undefined {
  if (!description) return undefined;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  return bytes.length > 21 ? (bytes[21] & 3) + 1 : undefined;
}

/** A chunk whose access unit delimiter comes after other NAL units, with the delimiter moved to the front and every
 *  other byte kept in order. An iPhone's HEVC recordings write an SEI before the delimiter, and Chrome 156 refuses
 *  such a key chunk as "not a key frame", so the whole recording failed to decode. A chunk already in order, without
 *  a delimiter, or with a length that runs past its end is returned as it is. */
export function audFirst(chunk: Uint8Array, lengthSize: number): Uint8Array {
  let at = 0;
  while (at + lengthSize < chunk.length) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + chunk[at + i];
    const end = at + lengthSize + length;
    if (length < 1 || end > chunk.length) return chunk;
    if (((chunk[at + lengthSize] >> 1) & 63) === AUD) {
      if (at === 0) return chunk;
      const out = new Uint8Array(chunk.length);
      out.set(chunk.subarray(at, end), 0);
      out.set(chunk.subarray(0, at), end - at);
      out.set(chunk.subarray(end), end);
      return out;
    }
    at = end;
  }
  return chunk;
}
