import { assertEquals, assertThrows } from '@std/assert';
import { outputDimensions } from '../../src/export/size.ts';

// Failure cases: enlarging small images, a longest edge over the requested upload limit, zero-width narrow
// prints, width/height swapped on landscapes, and accepting an empty or fractional custom size.
Deno.test('export size: fit the kept crop within a longest-edge limit without enlarging', () => {
  assertEquals(outputDimensions({ width: 1080, height: 40000 }), { width: 1080, height: 40000 });
  assertEquals(outputDimensions({ width: 1080, height: 40000 }, { maxEdge: 10000 }), { width: 270, height: 10000 });
  assertEquals(outputDimensions({ width: 40001, height: 1080 }, { maxEdge: 8192 }), { width: 8192, height: 221 });
  assertEquals(outputDimensions({ width: 1, height: 40000 }, { maxEdge: 1 }), { width: 1, height: 1 });
  assertEquals(outputDimensions({ width: 150, height: 120 }, { maxEdge: 8192 }), { width: 150, height: 120 });
  assertEquals(outputDimensions({ width: 440, height: 650 }, { scale: .75 }), { width: 330, height: 487 });
  assertEquals(outputDimensions({ width: 440, height: 650 }, { scale: .25 }), { width: 110, height: 162 });
  for (const limit of [0, -1, .5, NaN, Infinity]) {
    assertThrows(() => outputDimensions({ width: 150, height: 120 }, { maxEdge: limit }));
  }
  for (const scale of [0, -1, 1.1, NaN, Infinity]) {
    assertThrows(() => outputDimensions({ width: 150, height: 120 }, { scale }));
  }
});
