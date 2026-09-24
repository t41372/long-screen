import '../support/core.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { analysisFactor, downscaleGray, resolveRasterPose } from '../../src/core/raster.ts';
import { core } from '../../src/core/wasm.ts';
import { referenceRegionContains as regionContains } from '../support/reference/layers.ts';
import { cropRGBA, downscaleRGBA, meanAbsoluteDifference, thumbnail } from '../support/pixel-fixtures.ts';
import type { Gray, Region, RGBA } from '../../src/types.ts';
Deno.test('raster: integer analysis factor, exact box downscale, crops, previews', () => {
  assertEquals(analysisFactor(3456, 2234, 640), 6);
  assertEquals(analysisFactor(640, 448, 640), 1);
  assertEquals(analysisFactor(100, 100, 0), 100);
  const image: RGBA = {
    width: 4,
    height: 2,
    data: new Uint8ClampedArray([
      255,
      255,
      255,
      255,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      0,
      0,
      0,
      255,
    ]),
  };
  const g1 = downscaleGray(image, 1), g2 = downscaleGray(image, 2);
  assertEquals([...g1.data], [255, 0, 255, 0, 255, 0, 255, 0]);
  assertEquals(g2.width, 2);
  assertEquals(g2.height, 1);
  assertEquals([...g2.data], [127, 127]);
  assertEquals(resolveRasterPose(7.6, -2.4), { optimizedX: 7.6, optimizedY: -2.4, rasterX: 8, rasterY: -2 });
  const nonDiv = patternImage(5, 3),
    g3 = downscaleGray(nonDiv, 2),
    r3 = referenceGray(nonDiv, 2),
    t3 = downscaleRGBA(nonDiv, 2),
    r4 = referenceRGBA(nonDiv, 2);
  assertEquals([g3.width, g3.height], [3, 2], 'ceil dimensions retain the partial right/bottom boxes');
  assertEquals([...g3.data], [...r3.data]);
  assertEquals([t3.width, t3.height], [3, 2]);
  assertEquals([...t3.data], [...r4.data]);
  const partialRegion: Region = {
    id: 'partial',
    name: 'partial',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 5, height: 3 },
    mask: Uint8Array.from([0, 0, 1, 0, 0, 1]),
    maskWidth: 3,
    maskHeight: 2,
    factor: 2,
  };
  assert(regionContains(partialRegion, 4, 2, 5, 3), 'the final partial analysis cell must own the native edge');
  assert(!regionContains(partialRegion, 2, 0, 5, 3), 'mask membership must still use the exact analysis cell');
  assertThrows(() => downscaleGray(image, 0));
  assertThrows(() => downscaleRGBA(image, 1.5));
  assertEquals(downscaleRGBA(image, 2).data[3], 255);
  assertEquals(thumbnail(image, 2).width, 2);
  const c = cropRGBA(image, { x: 1, y: 0, width: 2, height: 1 });
  assertEquals([...c.data], [0, 0, 0, 255, 255, 255, 255, 255]);
  assertThrows(() => cropRGBA(image, { x: 3, y: 0, width: 2, height: 1 }));
  const transparent: RGBA = { width: 2, height: 2, data: new Uint8ClampedArray([100, 100, 100, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
  const half = core().halveRGBA(transparent);
  assertEquals([...half.data], [100, 100, 100, 64]);
  assertEquals([...core().halveRGBA({ width: 1, height: 1, data: new Uint8ClampedArray(4) }).data], [0, 0, 0, 0]);
  assertEquals(meanAbsoluteDifference(image, image), 0);
  assertEquals(meanAbsoluteDifference(image, c), 255);
});
/** Deterministic non-uniform fill: distinguishes an out-of-bounds read (undefined/NaN) from a correct box average. */
function patternImage(width: number, height: number): RGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) % 256;
      data[i + 1] = (x * 3 + y * 11) % 256;
      data[i + 2] = (x + y * 5) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}
/** Ground truth computed independently of raster.ts: the box clamped to the image, luma summed then averaged then shifted. */
function referenceGray(image: RGBA, factor: number): Gray {
  const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bh = Math.min(factor, image.height - y * factor), bw = Math.min(factor, image.width - x * factor);
      let sum = 0;
      for (let j = 0; j < bh; j++) {
        for (let k = 0; k < bw; k++) {
          const i = ((y * factor + j) * image.width + x * factor + k) * 4;
          sum += image.data[i] * 77 + image.data[i + 1] * 150 + image.data[i + 2] * 29;
        }
      }
      data[y * width + x] = Math.floor((sum / (bw * bh)) / 256);
    }
  }
  return { width, height, data };
}
function referenceRGBA(image: RGBA, factor: number): RGBA {
  const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bh = Math.min(factor, image.height - y * factor), bw = Math.min(factor, image.width - x * factor), area = bw * bh;
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < bh; j++) {
        for (let k = 0; k < bw; k++) {
          const i = ((y * factor + j) * image.width + x * factor + k) * 4;
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / area;
      data[o + 1] = g / area;
      data[o + 2] = b / area;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
Deno.test('raster: box downscale clamps to the image when a dimension is smaller than the analysis factor', () => {
  const wide = patternImage(10000, 10), g1 = downscaleGray(wide, 16), r1 = referenceGray(wide, 16);
  assertEquals(g1.width, 625);
  assertEquals(g1.height, 1);
  assertEquals([...g1.data], [...r1.data]);
  assert(g1.data.some((v) => v !== 0), 'entire analysis image collapsed to zero');
  const narrow = patternImage(10, 32), g2 = downscaleGray(narrow, 16), r2 = referenceGray(narrow, 16);
  assertEquals(g2.width, 1);
  assertEquals(g2.height, 2);
  assertEquals([...g2.data], [...r2.data]);
  const banner = patternImage(6400, 5), t = thumbnail(banner, 640), r3 = referenceRGBA(banner, Math.ceil(6400 / 640));
  assertEquals(t.width, r3.width);
  assertEquals(t.height, r3.height);
  assertEquals([...t.data], [...r3.data]);
  assert(t.data.some((v, i) => i % 4 !== 3 && v !== 0), 'thumbnail collapsed to black');
});
