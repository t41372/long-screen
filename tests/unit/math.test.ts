import { assertEquals } from '@std/assert';
import { clamp, DisjointSet, hamming, intersect, median, norm, pad, popcount, rng, union } from '../../src/core/math.ts';
Deno.test('math: clamp, median, norm, pad, popcount, hamming, rects', () => {
  assertEquals(clamp(5, 0, 3), 3);
  assertEquals(clamp(-1, 0, 3), 0);
  assertEquals(median([]), 0);
  assertEquals(median([7, 1, 3]), 3);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assertEquals(norm({ x: 3, y: 4 }), 5);
  assertEquals(pad(42), '0000000042');
  assertEquals(popcount(0xffffffff), 32);
  assertEquals(hamming(new Uint32Array([0xffffffff]), new Uint32Array([0])), 32);
  assertEquals(hamming(new Uint32Array([0xffffffff, 0xffffffff]), new Uint32Array([0, 0]), 10) > 10, true);
  assertEquals(union({ x: -30, y: -10, width: 20, height: 20 }, { x: 10, y: 40, width: 20, height: 10 }), {
    x: -30,
    y: -10,
    width: 60,
    height: 60,
  });
  assertEquals(union({ x: 0, y: 0, width: 0, height: 0 }, { x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  assertEquals(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }).width, 0);
  assertEquals(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), {
    x: 5,
    y: 5,
    width: 5,
    height: 5,
  });
});
Deno.test('math: rng is deterministic and DisjointSet unions by size with path compression', () => {
  const a = rng(1), b = rng(1);
  assertEquals(a(), b());
  const ds = new DisjointSet(6);
  ds.join(0, 1);
  ds.join(2, 3);
  ds.join(1, 3);
  ds.join(0, 0);
  ds.join(4, 5);
  ds.join(5, 0);
  assertEquals(new Set([0, 1, 2, 3, 4, 5].map((i) => ds.find(i))).size, 1);
  assertEquals(ds.size[ds.find(0)], 6);
});
