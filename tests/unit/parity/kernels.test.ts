/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import * as reference from '../../support/reference/kernels.ts';
import { rng } from '../../../src/core/math.ts';
import type { Feature, Gray, RGBA } from '../../../src/types.ts';

const random = rng(0x5eed);
function randomRGBA(width: number, height: number, smooth = false): RGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const v = smooth ? ((x * 7 + y * 13) ^ (x >> 3)) & 255 : Math.floor(random() * 256);
      data[o] = v;
      data[o + 1] = smooth ? (v * 3) & 255 : Math.floor(random() * 256);
      data[o + 2] = smooth ? (255 - v) & 255 : Math.floor(random() * 256);
      data[o + 3] = random() < .2 ? Math.floor(random() * 256) : 255;
    }
  }
  return { width, height, data };
}
function randomGray(width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  // Blocky texture with noise: gives many corners while keeping realistic flat areas.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (((x >> 4) + (y >> 4)) & 1 ? 200 : 40) + Math.floor(random() * 30);
    }
  }
  return { width, height, data };
}
const sameFeatures = (a: Feature[], b: Feature[]) => {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals([a[i].x, a[i].y], [b[i].x, b[i].y], `feature ${i} position`);
    assert(Math.abs(a[i].score - b[i].score) <= Math.abs(a[i].score) * 1e-6, `feature ${i} score ${a[i].score} vs ${b[i].score}`);
    assertEquals([...a[i].descriptor], [...b[i].descriptor], `feature ${i} descriptor`);
  }
};

Deno.test('core parity: grayscale, box downscale (partial cells) and alpha-weighted halving are byte-exact', async () => {
  const core = await ensureCore();
  for (const [w, h, factor] of [[1, 1, 1], [7, 5, 2], [641, 449, 2], [1082, 1920, 4], [1919, 1079, 4], [3, 9, 8], [64, 64, 1]]) {
    const image = randomRGBA(w, h);
    assertEquals(core.grayscale(image.data, w, h), reference.grayscale(image.data, w, h));
    assertEquals(core.downscaleGray(image, factor), reference.downscaleGray(image, factor));
    assertEquals(core.halveRGBA(image), reference.halveRGBA(image));
  }
});

Deno.test('core parity: features, descriptors, matches and visual words agree with the frozen TS kernels', async () => {
  const core = await ensureCore();
  for (const [w, h] of [[23, 23], [22, 40], [160, 120], [640, 360], [320, 240]]) {
    const g = randomGray(w, h);
    const expected = reference.extractFeatures(g), actual = core.extractFeatures(g, 480);
    sameFeatures(actual, expected);
    const roi = { x: w / 4, y: h / 3, width: w / 2, height: h / 2 };
    sameFeatures(core.extractFeatures(g, 120, roi), reference.extractFeatures(g, 120, roi));
    const shifted: Gray = { width: w, height: h, data: new Uint8Array(w * h) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) shifted.data[y * w + x] = g.data[Math.min(h - 1, y + 3) * w + Math.min(w - 1, x + 2)];
    }
    const other = reference.extractFeatures(shifted);
    for (const ambiguous of [true, false]) {
      const matches = core.matchFeatures(expected, other, ambiguous), ref = reference.matchFeatures(expected, other, ambiguous);
      assertEquals(matches.length, ref.length);
      for (let i = 0; i < ref.length; i++) {
        assert(matches[i].a === ref[i].a && matches[i].b === ref[i].b, `match ${i} identity`);
        assertEquals([matches[i].distance, matches[i].unique], [ref[i].distance, ref[i].unique]);
      }
    }
    assertEquals(core.featureWords(expected), reference.featureWords(expected));
    assertEquals(core.featureWords(expected.filter((_, i) => i % 2 === 0)), reference.featureWords(expected.filter((_, i) => i % 2 === 0)));
  }
  assertEquals(core.extractFeatures({ width: 5, height: 5, data: new Uint8Array(25) }, 10), []);
  assertEquals(core.matchFeatures([], [], true), []);
  assertEquals(core.featureWords([]), []);
});

Deno.test('core parity: PNG scanline reconstruction and Sub filtering are byte-exact for every filter and colour type', async () => {
  const core = await ensureCore();
  for (const channels of [1, 2, 3, 4]) {
    for (const [w, h] of [[1, 1], [5, 3], [64, 17], [512, 4]]) {
      const stride = w * channels, raw = new Uint8Array((stride + 1) * h);
      for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = y % 5;
        for (let i = 1; i <= stride; i++) raw[y * (stride + 1) + i] = Math.floor(random() * 256);
      }
      assertEquals(core.pngUnfilter(raw, w, h, channels), reference.unfilterPNG(raw, w, h, channels));
    }
  }
  const image = randomRGBA(37, 11);
  const filtered = core.pngFilterSub(new Uint8Array(image.data.buffer), 37, 11);
  assertEquals(filtered, reference.filterSub(image.data, 37, 11));
  assertEquals(core.pngUnfilter(filtered, 37, 11, 4), image.data);
  let threw = false;
  try {
    core.pngUnfilter(new Uint8Array([7, 0, 0, 0, 0]), 1, 1, 4);
  } catch (error) {
    threw = String(error).includes('Invalid PNG filter 7');
  }
  assert(threw, 'invalid filter byte must be reported explicitly');
});
