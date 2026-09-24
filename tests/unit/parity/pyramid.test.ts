/** Byte-exact parity between `core().assemblePyramidParent` (rust/core/src/pyramid.rs) and the frozen TS loop
 *  `TileStore.buildPyramid` runs: halves each present child (reference.halveRGBA, the same frozen kernel
 *  tests/unit/parity/kernels.test.ts checks) and copies it into its quadrant of a zero-initialised parent tile. */
import { assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import * as reference from '../../support/reference/kernels.ts';
import { rng } from '../../../src/core/math.ts';
import type { RGBA } from '../../../src/types.ts';

const random = rng(0xbeef);
function randomChild(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(random() * 256);
    data[i + 1] = Math.floor(random() * 256);
    data[i + 2] = Math.floor(random() * 256);
    data[i + 3] = random() < .3 ? 0 : Math.floor(random() * 256);
  }
  return data;
}
/** The frozen assembly the old TS loop in TileStore.buildPyramid ran: halve each present child with the frozen
 *  TS kernel and copy it into its quadrant of a zero parent; an absent child's quadrant stays zero. */
function referenceAssemble(children: (Uint8ClampedArray | undefined)[], size: number): RGBA {
  const half = size / 2, parent = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < 4; i++) {
    const child = children[i];
    if (!child) continue;
    const dx = i % 2, dy = Math.floor(i / 2);
    const small = reference.halveRGBA({ width: size, height: size, data: child });
    for (let r = 0; r < half; r++) {
      parent.set(small.data.subarray(r * half * 4, (r + 1) * half * 4), ((dy * half + r) * size + dx * half) * 4);
    }
  }
  return { width: size, height: size, data: parent };
}

Deno.test('pyramid parity: assemblePyramidParent matches the frozen halve+copy loop for every child presence pattern', async () => {
  const core = await ensureCore();
  for (const size of [16, 32, 64]) {
    const full = [randomChild(size), randomChild(size), randomChild(size), randomChild(size)];
    // Every subset of {0,1,2,3} present, including none and all four.
    for (let mask = 0; mask < 16; mask++) {
      const children = full.map((c, i) => (mask & (1 << i) ? c : undefined));
      const expected = referenceAssemble(children, size);
      const actual = core.assemblePyramidParent(children, size);
      assertEquals(actual.width, expected.width);
      assertEquals(actual.height, expected.height);
      assertEquals([...actual.data], [...expected.data], `size ${size} mask ${mask}`);
    }
  }
});
