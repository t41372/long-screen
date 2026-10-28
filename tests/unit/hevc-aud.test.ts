// Chrome 156 refuses an iPhone HEVC recording's first key chunk ("marked as type `key` but wasn't a key frame"):
// Apple's encoder writes an SEI before the access unit delimiter, and an AUD starts an access unit. Failure cases of
// moving the delimiter to the front: a NAL unit lost, duplicated or cut (the chunk must keep every byte); the wrong
// NAL length size (2-byte prefixes read as 4); a chunk already in order, or without a delimiter, rewritten anyway; a
// malformed length running past the chunk throwing instead of leaving the chunk alone.
import { assertEquals, assertStrictEquals } from '@std/assert';
import { audFirst, nalLengthSize } from '../../src/media/hevc.ts';

/** One HEVC NAL unit of `type` with `body` bytes after its two-byte header, behind a `size`-byte length prefix. */
function nal(type: number, body: number[], size: number): number[] {
  const unit = [type << 1, 1, ...body], length = unit.length;
  const prefix = Array.from({ length: size }, (_, i) => (length >> (8 * (size - 1 - i))) & 255);
  return [...prefix, ...unit];
}
const SEI = 39, AUD = 35, IDR = 20, TRAIL = 1;

for (const size of [4, 2, 1]) {
  Deno.test(`hevc: an SEI before the access unit delimiter moves behind it, every byte kept (${size}-byte lengths)`, () => {
    const sei = nal(SEI, [5, 6, 7], size), aud = nal(AUD, [0x50], size), sei2 = nal(SEI, [8], size), idr = nal(IDR, [9, 9, 9, 9], size);
    const chunk = new Uint8Array([...sei, ...aud, ...sei2, ...idr]);
    assertEquals([...audFirst(chunk, size)], [...aud, ...sei, ...sei2, ...idr]);
  });
}

Deno.test('hevc: a chunk that starts with its delimiter, or has none, is returned as it is', () => {
  const ordered = new Uint8Array([...nal(AUD, [0x50], 4), ...nal(SEI, [1], 4), ...nal(IDR, [2], 4)]);
  assertStrictEquals(audFirst(ordered, 4), ordered);
  const none = new Uint8Array([...nal(SEI, [1], 4), ...nal(IDR, [2], 4)]);
  assertStrictEquals(audFirst(none, 4), none);
  const delta = new Uint8Array([...nal(TRAIL, [3, 3], 4)]);
  assertStrictEquals(audFirst(delta, 4), delta);
});

Deno.test('hevc: a length running past the chunk leaves the chunk alone', () => {
  const broken = new Uint8Array([0, 0, 0, 99, SEI << 1, 1, 7, ...nal(AUD, [0x50], 4)]);
  assertStrictEquals(audFirst(broken, 4), broken);
  const short = new Uint8Array([...nal(SEI, [1], 4), 0, 0]);
  assertStrictEquals(audFirst(short, 4), short);
});

Deno.test('hevc: the NAL length size comes from the hvcC record, and is unknown without one', () => {
  const hvcc = new Uint8Array(23);
  hvcc[21] = 0xfc | 3;
  assertEquals(nalLengthSize(hvcc), 4);
  hvcc[21] = 0xfc | 1;
  assertEquals(nalLengthSize(hvcc.buffer), 2);
  assertEquals(nalLengthSize(new Uint8Array(10)), undefined);
  assertEquals(nalLengthSize(undefined), undefined);
});
