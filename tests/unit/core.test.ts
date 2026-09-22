import { assert, assertEquals, assertThrows } from '@std/assert';
import { clamp, DisjointSet, hamming, intersect, median, norm, pad, popcount, rng, union } from '../../src/core/math.ts';
import { extractFeatures, featureWords, grayscale, matchFeatures, meanDifference, smooth } from '../../src/core/features.ts';
import {
  auditTranslation,
  detectScale,
  estimateMotion,
  extractPatches,
  probeScale,
  refineNative,
  refinePatches,
  refineTranslation,
  resampleGray,
  translationHypotheses,
  verifyTranslation,
} from '../../src/core/motion.ts';
import {
  analysisFactor,
  cropRGBA,
  downscaleGray,
  downscaleRGBA,
  halveRGBA,
  meanAbsoluteDifference,
  resolveRasterPose,
  thumbnail,
} from '../../src/core/raster.ts';
import { LayerLearner, RegionAtlas, regionContains, regionMotion } from '../../src/core/layers.ts';
import { PoseGraph } from '../../src/core/pose-graph.ts';
import { KeyframeIndex } from '../../src/core/keyframes.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import type { Feature, Gray, Match, Region, RGBA } from '../../src/types.ts';
import { makeWorld } from '../../src/synthetic/world.ts';
const random = rng(997), W = 760, H = 700, world = Uint8Array.from({ length: W * H }, () => Math.floor(random() * 256));
function crop(x: number, y: number, w = 320, h = 240): Gray {
  const data = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    data.set(world.subarray((y + row) * W + x, (y + row) * W + x + w), row * w);
  }
  return { width: w, height: h, data };
}
const rgba = (g: Gray): RGBA => ({
  width: g.width,
  height: g.height,
  data: Uint8ClampedArray.from({ length: g.width * g.height * 4 }, (_, i) => i % 4 === 3 ? 255 : g.data[i >> 2]),
});
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
Deno.test('features: grayscale, smooth, blank frames yield no invented features, words and difference', () => {
  const g = grayscale(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assertEquals([...g.data], [255, 0]);
  const blank = { width: 160, height: 120, data: new Uint8Array(160 * 120).fill(245) };
  assertEquals(extractFeatures(blank).length, 0);
  assertEquals(matchFeatures(extractFeatures(blank), extractFeatures(blank)).length, 0);
  assertEquals(smooth(blank).data[500], 245);
  const f = extractFeatures(crop(0, 0));
  assert(f.length > 100);
  assert(featureWords(f).length > 10);
  assertEquals(meanDifference(blank, crop(0, 0, 10, 10)), 255);
  assertEquals(meanDifference(blank, blank), 0);
  const roi = extractFeatures(crop(0, 0), 480, { x: 0, y: 0, width: 40, height: 40 });
  assert(roi.every((p) => p.x < 40 && p.y < 40));
});
Deno.test('features: repeated descriptors are not unique; ambiguous alternatives are marked', () => {
  const descriptor = new Uint32Array(8).fill(0xabcdef),
    features: Feature[] = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: 30, score: 1, descriptor }));
  assert(matchFeatures(features, features).every((m) => !m.unique));
  assertEquals(matchFeatures(features, features, false).length, 0);
  const other = features.map((f) => ({ ...f, descriptor: new Uint32Array(8).fill(0xffffffff) }));
  assertEquals(matchFeatures(features, other).length, 0);
});
for (
  const [dx, dy, name] of [
    [0, 21, 'vertical'],
    [27, 0, 'horizontal'],
    [13, 19, 'odd diagonal'],
    [-7, 31, 'reverse diagonal'],
    [27, -13, 'up-right'],
    [0, 0, 'pause'],
    [1, -1, 'jitter'],
    [0, 175, 'fast fling'],
  ] as [number, number, string][]
) {
  Deno.test(`motion: 2D registration ${name}`, () => {
    const a = crop(180, 220), b = crop(180 + dx, 220 + dy), field = estimateMotion(a, b);
    assert(!field.unknown);
    assertEquals(field.motions[0].x, dx);
    assertEquals(field.motions[0].y, dy);
  });
}
Deno.test('motion: reversal, unrelated frames, geometry mismatch, consensus ambiguity', () => {
  const a = crop(180, 220), b = crop(210, 265), forward = estimateMotion(a, b), back = estimateMotion(b, a, forward);
  assertEquals(back.motions[0].x, -30);
  assertEquals(back.motions[0].y, -45);
  const m = estimateMotion(crop(0, 0, 240, 180), crop(450, 400, 240, 180));
  assert(m.unknown || m.motions.every((v) => v.confidence < .65));
  assertThrows(() => estimateMotion(crop(0, 0, 100, 100), crop(0, 0, 120, 100)), Error, 'FRAME_GEOMETRY_CHANGED');
  const desc = new Uint32Array(8),
    matches: Match[] = Array.from(
      { length: 12 },
      (_, i) => ({
        a: { x: i * 20, y: 50, score: 1, descriptor: desc },
        b: { x: i * 20, y: 30, score: 1, descriptor: desc },
        distance: 0,
        unique: false,
      }),
    );
  const h = translationHypotheses(matches)[0];
  assert(h.ambiguous);
  assertEquals(h.y, 20);
  assertEquals(translationHypotheses([]).length, 0);
  assertEquals(translationHypotheses(matches.slice(0, 2)).length, 0);
});
Deno.test('motion: verify/audit/refine on analysis images', () => {
  const a = crop(100, 100), b = crop(117, 123);
  assert(verifyTranslation(a, b, 17, 23) < 1);
  assert(verifyTranslation(a, b, 40, 40) > 20);
  assertEquals(verifyTranslation(a, b, 17, 23, { x: 0, y: 0, width: 10, height: 10 }), Infinity);
  const good = auditTranslation(a, b, 17, 23), bad = auditTranslation(a, b, 30, 30), none = auditTranslation(a, b, 300, 300);
  assert(good.error < 1 && good.mismatch < .01 && good.agreement > .9 && good.blocks > 4);
  assert(bad.error > 20 && bad.agreement < .2);
  assertEquals(none.error, Infinity);
  assertEquals(none.overlap, 0);
  const tolerant = auditTranslation(a, b, 18, 23, undefined, true);
  assert(tolerant.error < good.error + 30);
  assertEquals(refineTranslation(a, b, { x: 16.4, y: 23.6 }), { x: 17, y: 23 });
  assertEquals(refineTranslation(a, b, { x: 17, y: 23 }, { x: 0, y: 0, width: 4, height: 4 }), { x: 17, y: 23 });
});
Deno.test('motion: native refinement returns integer offsets, errors and runner-up gaps; degenerate masks never produce NaN', () => {
  const a = rgba(crop(100, 100)), b = rgba(crop(117, 123));
  const p = refineNative(a, b, { x: 17.2, y: 22.7 }, { x: 0, y: 0, width: 320, height: 240 });
  assertEquals([p.x, p.y], [17, 23]);
  assert(p.error < 1 && p.runnerUp > 20 && p.samples > 100);
  const masked = refineNative(a, b, { x: 17, y: 23 }, { x: 0, y: 0, width: 320, height: 240 }, () => false);
  assertEquals(masked.error, Infinity);
  const tiny = { width: 20, height: 20, data: new Uint8ClampedArray(1600) };
  const q = refineNative(tiny, tiny, { x: 0, y: 40 }, { x: 0, y: 0, width: 20, height: 3 });
  assert(Number.isFinite(q.x) && Number.isFinite(q.y) && q.error === Infinity);
  const other = refineNative(a, { ...b, width: 100 }, { x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 10 });
  assertEquals(other.error, Infinity);
  const mostlyMasked = refineNative(a, b, { x: 17, y: 23 }, { x: 0, y: 0, width: 320, height: 240 }, (x) => x < 6);
  assert(!Number.isFinite(mostlyMasked.error) || mostlyMasked.error >= 0);
});
Deno.test('motion: keyframe patches measure revisits at native precision', () => {
  const native = crop(0, 0, 400, 300), region = { x: 0, y: 0, width: 400, height: 300 }, features = extractFeatures(native, 60);
  const patches = extractPatches(native, region, features, 1);
  assert(patches.length >= 10 && patches.every((p) => p.data.length === 1024));
  assertEquals(extractPatches(native, { x: 0, y: 0, width: 20, height: 20 }, features, 1).length, 0);
  // The viewport moved by (9, 6): keyframe-local content now sits 9 px left and 6 px up, so the displacement is (+9, +6).
  const moved = crop(9, 6, 400, 300);
  const r = refinePatches(patches, moved, region, { x: 8, y: 7 }, 3);
  assertEquals([r.x, r.y], [9, 6]);
  assert(r.error < 1 && r.runnerUp > 10);
  assertEquals(refinePatches([], moved, region, { x: 0, y: 0 }).error, Infinity);
  assert(
    refinePatches(patches, moved, region, { x: 200, y: 200 }).error === Infinity ||
      refinePatches(patches, moved, region, { x: 200, y: 200 }).error > 20,
  );
});
Deno.test('motion: scale detection and explicit magnification probe', () => {
  const a = crop(40, 40, 300, 220), features = extractFeatures(a), matches = matchFeatures(features, features);
  assertEquals(detectScale(matches), 1);
  assertEquals(detectScale([]), 1);
  const page = makeWorld(700, 500, 5, 'cards', 2), g: Gray = { width: 700, height: 500, data: grayscale(page.data, 700, 500).data };
  const zoomed = resampleGray(g, 1.25), cropped = { width: 640, height: 448, data: new Uint8Array(640 * 448) };
  for (let y = 0; y < 448; y++) {
    cropped.data.set(zoomed.data.subarray(y * zoomed.width, y * zoomed.width + 640), y * 640);
  }
  const base = { width: 640, height: 448, data: new Uint8Array(640 * 448) };
  for (let y = 0; y < 448; y++) {
    base.data.set(g.data.subarray(y * 700, y * 700 + 640), y * 640);
  }
  const probe = probeScale(base, cropped, extractFeatures(cropped));
  assert(probe && Math.abs(probe.scale - 1.25) < .01, JSON.stringify(probe));
  assertEquals(probeScale(base, crop(0, 0, 640, 448), extractFeatures(crop(0, 0, 640, 448))), undefined);
  assertEquals(resampleGray({ width: 1, height: 1, data: new Uint8Array([7]) }, 3).width, 3);
});
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
  const half = halveRGBA(transparent);
  assertEquals([...half.data], [100, 100, 100, 64]);
  assertEquals([...halveRGBA({ width: 1, height: 1, data: new Uint8ClampedArray(4) }).data], [0, 0, 0, 0]);
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
function fieldFor(prev: Gray, cur: Gray) {
  return estimateMotion(prev, cur, undefined, extractFeatures(prev), extractFeatures(cur));
}
Deno.test('layers: learner separates a stationary band from scrolling content with native-precision edges', () => {
  const page = makeWorld(400, 1200, 9, 'article'), header = new Uint8Array(400 * 37).fill(30);
  for (let i = 0; i < header.length; i += 7) {
    header[i] = 200;
  }
  const frame = (offset: number): Gray => {
    const data = new Uint8Array(400 * 300);
    data.set(header);
    const g = grayscale(page.data, 400, 1200);
    for (let y = 37; y < 300; y++) {
      data.set(g.data.subarray((offset + y - 37) * 400, (offset + y - 37) * 400 + 400), y * 400);
    }
    return { width: 400, height: 300, data };
  };
  const learner = new LayerLearner(400, 300);
  let prev = frame(0);
  for (let i = 1; i < 12; i++) {
    const cur = frame(i * 23);
    learner.add(fieldFor(prev, cur), prev, cur, rgba(prev), rgba(cur));
    prev = cur;
  }
  const regions = learner.finish(400, 300);
  const fixed = regions.find((r) => r.kind === 'fixed'), moving = regions.find((r) => r.kind === 'moving');
  assert(fixed && moving);
  assertEquals(fixed.rect.height, 37);
  assertEquals(moving.rect.y, 37);
  assert(fixed.solid && fixed.crop && fixed.crop.height === 37);
  assert(regionContains(fixed, 10, 36, 400, 300) && !regionContains(fixed, 10, 37, 400, 300));
  assert(regionContains(moving, 10, 37, 400, 300) && !regionContains(moving, 10, 36, 400, 300));
  const atlas = new RegionAtlas(regions, 400, 300);
  assertEquals(atlas.count(atlas.code(fixed)), 400 * 37);
  assertEquals(atlas.count(atlas.code(moving)), 400 * 263);
  assert(!atlas.contains(atlas.code(moving), -1, 50) && !atlas.contains(atlas.code(moving), 10, 300));
  assertThrows(() => atlas.code({ id: 'x', name: 'x', kind: 'moving', rect: { x: 0, y: 0, width: 1, height: 1 } }));
  assertEquals(
    regionMotion(
      {
        motions: [{ x: 0, y: 0, support: 0, unique: 0, confidence: 0, error: 0, ambiguous: false }],
        labels: new Uint8Array(1),
        confidence: new Uint8Array(1),
        dynamic: new Uint8Array(1),
        cols: 1,
        rows: 1,
        cell: 24,
        difference: 0,
        featureCount: 0,
        unknown: false,
        zoom: 1,
      },
      fixed,
      400,
      300,
    ).confidence,
    1,
  );
});
Deno.test('layers: uninformative input yields a single moving region; manual regions keep unassigned pixels explicit', () => {
  const learner = new LayerLearner(100, 100), blank = { width: 100, height: 100, data: new Uint8Array(10000).fill(200) };
  learner.add(fieldFor(blank, blank), blank, blank);
  const regions = learner.finish(200, 200);
  assertEquals(regions.length, 1);
  assertEquals(regions[0].kind, 'moving');
  const manual = new LayerLearner(100, 100).finish(200, 200, [{
    id: 'a',
    name: 'body',
    kind: 'moving',
    rect: { x: 20, y: 20, width: 100, height: 100 },
  }, { id: 'b', name: 'ignore', kind: 'ignore', rect: { x: 40, y: 40, width: 20, height: 20 } }]);
  const body = manual[0], unknown = manual.find((r) => r.unassigned)!;
  assert(regionContains(body, 30, 30, 200, 200));
  assert(!regionContains(body, 45, 45, 200, 200));
  assert(regionContains(unknown, 180, 180, 200, 200));
  assert(!regionContains(unknown, 30, 30, 200, 200));
  const full = new LayerLearner(100, 100).finish(200, 200, [{
    id: 'a',
    name: 'body',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  }]);
  assertEquals(full.length, 1);
  const region: Region = {
    id: 'r',
    name: 'r',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    mask: new Uint8Array([1, 0, 0, 1]),
    maskWidth: 2,
    maskHeight: 2,
  };
  assert(regionContains(region, 1, 1, 10, 10) && !regionContains(region, 8, 1, 10, 10));
  const atlas = new RegionAtlas([region], 10, 10);
  assertEquals(atlas.count(1), 50);
  assertThrows(() => new RegionAtlas(Array.from({ length: 255 }, (_, i) => ({ ...region, id: String(i) })), 10, 10));
});
Deno.test('layers: two independently moving panes are split at a native-precision divider', () => {
  const left = makeWorld(300, 1400, 21, 'cards'), right = makeWorld(300, 1400, 22, 'article');
  const gl = grayscale(left.data, 300, 1400), gr = grayscale(right.data, 300, 1400);
  const frame = (a: number, b: number): Gray => {
    const data = new Uint8Array(640 * 300).fill(60);
    for (let y = 0; y < 300; y++) {
      data.set(gl.data.subarray((a + y) * 300, (a + y) * 300 + 300), y * 640);
      data.set(gr.data.subarray((b + y) * 300, (b + y) * 300 + 300), y * 640 + 335);
    }
    return { width: 640, height: 300, data };
  };
  const learner = new LayerLearner(640, 300);
  let prev = frame(0, 0);
  for (let i = 1; i < 16; i++) {
    const cur = frame(i * 17, i < 8 ? 0 : (i - 7) * 11);
    learner.add(fieldFor(prev, cur), prev, cur, rgba(prev), rgba(cur));
    prev = cur;
  }
  const regions = learner.finish(640, 300), moving = regions.filter((r) => r.kind === 'moving');
  assertEquals(moving.length, 2, JSON.stringify(regions.map((r) => [r.kind, r.rect])));
  const [l, r] = moving.sort((a, b) => a.rect.x - b.rect.x);
  assert(l.rect.x + l.rect.width <= 300 + 1 && r.rect.x >= 335 - 1, JSON.stringify([l.rect, r.rect]));
});
Deno.test('pose graph: loop closure keeps the pinned origin, isolated components get no invented relation, edges stay on disk', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  const a = await graph.add('a', 0, { x: 0, y: 0 }),
    b = await graph.add('a', 10, { x: 100, y: 80 }, a),
    c = await graph.add('a', 20, { x: 4, y: 3 }, b);
  await graph.connect(a.id, c.id, 0, 0, 20, 'loop');
  await graph.connect(a.id, c.id, 0, 0, 20, 'loop');
  await graph.connect(a.id, a.id, 0, 0, 1, 'loop');
  const result = await graph.optimize(async () => {});
  assert(result.iterations > 0 && result.residual < 5);
  const origin = (await graph.get(a.id))!, end = (await graph.get(c.id))!;
  assertEquals([origin.x, origin.y], [0, 0]);
  assert(Math.hypot(end.x, end.y) < .3);
  const mid = await graph.correction(b.id, 15), last = await graph.correction(c.id, 20), first = await graph.correction(a.id, 0);
  assert(Number.isFinite(mid.x) && Number.isFinite(last.y) && first.x === 0);
  const g2 = new PoseGraph(new MemoryKV());
  const p = await g2.add('first', 0, { x: 0, y: 0 }), q = await g2.add('second', 1, { x: 0, y: 0 });
  assertEquals(await g2.optimize(async () => {}), { residual: 0, iterations: 0 });
  assert((await g2.get(p.id))!.pinned && (await g2.get(q.id))!.pinned);
  await assertRejectsAsync(() => g2.connect(p.id, 'missing', 0, 0, 1, 'loop'));
  await assertRejectsAsync(() => g2.correction('missing', 0));
  const g3 = new PoseGraph(new MemoryKV()), origin3 = await g3.add('canvas', 0, { x: 0, y: 0 });
  for (let i = 1; i <= 100; i++) {
    const node = await g3.add('canvas', i, { x: i, y: -i });
    await g3.connect(origin3.id, node.id, i, -i, 1, 'loop');
  }
  assertEquals((await g3.get(origin3.id))!.edges.length, 0);
  assertEquals((await g3.db.scan(`edge/${origin3.id}/`, { limit: 1000 })).length, 100);
});
async function assertRejectsAsync(fn: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, 'expected rejection');
}
Deno.test('keyframes: relocalization finds a revisit at native precision and refuses ambiguous repeats', async () => {
  const db = new MemoryKV(),
    warnings: string[] = [],
    index = new KeyframeIndex(db, async (m) => {
      warnings.push(m);
    });
  const page = makeWorld(900, 1400, 77, 'article'), g = grayscale(page.data, 900, 1400);
  const view = (x: number, y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) {
      data.set(g.data.subarray((y + row) * 900 + x, (y + row) * 900 + x + 640), row * 640);
    }
    return { width: 640, height: 400, data };
  };
  const region = { x: 0, y: 0, width: 640, height: 400 }, roi = region;
  for (const [frame, x, y] of [[0, 0, 0], [10, 0, 300], [20, 100, 700]] as [number, number, number][]) {
    const gray = view(x, y), features = extractFeatures(gray);
    await index.add({
      id: `body/${frame}`,
      node: `body-part-0/${frame}`,
      canvasId: 'body-part-0',
      layer: 'body',
      frame,
      features,
      gray,
      x,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  const current = view(37, 323), features = extractFeatures(current);
  const found = await index.find({ features, gray: current, native: current, layer: 'body', frame: 60, roi, region, factor: 1, radius: 3 });
  assert(found && !found.ambiguous, JSON.stringify(found && { ...found, keyframe: found.keyframe.id }));
  assertEquals([found!.keyframe.x + found!.offset.x, found!.keyframe.y + found!.offset.y], [37, 323]);
  assertEquals(
    await index.find({
      features: features.slice(0, 4),
      gray: current,
      native: current,
      layer: 'body',
      frame: 60,
      roi,
      region,
      factor: 1,
      radius: 3,
    }),
    undefined,
  );
  assertEquals(
    await index.find({ features, gray: current, native: current, layer: 'other', frame: 60, roi, region, factor: 1, radius: 3 }),
    undefined,
  );
  assertEquals(
    await index.find({
      features,
      gray: current,
      native: current,
      layer: 'body',
      frame: 11,
      roi,
      region,
      factor: 1,
      radius: 3,
      exclude: 'body/0',
      minGap: 20,
    }),
    undefined,
  );
  // Identical repeated rows: two keyframes one period apart both explain the observation.
  const list = makeWorld(900, 1400, 131, 'list'), lg = grayscale(list.data, 900, 1400);
  const lview = (y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) data.set(lg.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
    return { width: 640, height: 400, data };
  };
  const repeated = new KeyframeIndex(db, async () => {});
  for (const [frame, y] of [[0, 200], [30, 244], [60, 288]] as [number, number][]) {
    const gray = lview(y), f = extractFeatures(gray);
    await repeated.add({
      id: `list/${frame}`,
      node: `list-part-0/${frame}`,
      canvasId: 'list-part-0',
      layer: 'list',
      frame,
      features: f,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, f, 1),
    });
  }
  const probe = lview(222),
    match = await repeated.find({
      features: extractFeatures(probe),
      gray: probe,
      native: probe,
      layer: 'list',
      frame: 100,
      roi,
      region,
      factor: 1,
      radius: 3,
    });
  assert(!match || match.ambiguous, JSON.stringify(match && { ...match, keyframe: match.keyframe.id }));
});
Deno.test('keyframes: a densely keyframed long scroll spreads candidate retrieval across a 100+ posting and warns once per layer', async () => {
  const db = new MemoryKV(),
    warnings: string[] = [],
    index = new KeyframeIndex(db, async (m) => {
      warnings.push(m);
    });
  const region = { x: 0, y: 0, width: 640, height: 400 }, COUNT = 150, STEP = 3, BASE = 200;
  function sliding(seed: number): (y: number) => Gray {
    const page = makeWorld(900, 1400, seed, 'article'), g = grayscale(page.data, 900, 1400);
    return (y: number): Gray => {
      const data = new Uint8Array(640 * 400);
      for (let row = 0; row < 400; row++) {
        data.set(g.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
      }
      return { width: 640, height: 400, data };
    };
  }
  // A 3px-per-keyframe scroll over 150 keyframes: any word anchored to a stable piece of page content stays inside
  // the 400px-tall viewport (and so keeps appearing in that word's posting) for up to ~130 consecutive keyframes —
  // comfortably past both the 48-candidate forward budget and the 96-entry retrieval budget, on a single layer.
  const view = sliding(555);
  for (let i = 0; i < COUNT; i++) {
    const y = BASE + i * STEP, gray = view(y), features = extractFeatures(gray);
    await index.add({
      id: `body/${i}`,
      node: `body-part-0/${i}`,
      canvasId: 'body-part-0',
      layer: 'body',
      frame: i,
      features,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  // Revisit precisely where the LATE keyframe (index 120) was minted. A forward-only scan of an over-full posting
  // can only ever surface the earliest-indexed keyframes on a word this repetitive, so without the reverse "spread"
  // scan this revisit could never be matched against its true, late-indexed keyframe.
  const targetY = BASE + 120 * STEP, query = view(targetY), qf = extractFeatures(query);
  const found = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 1000,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(found && !found.ambiguous, JSON.stringify(found && { ...found, keyframe: found.keyframe.id }));
  assert(found!.keyframe.frame >= 60, `expected the late keyframe to be reachable as a candidate, got frame ${found!.keyframe.frame}`);
  assertEquals(warnings.length, 1, 'the repetitive-posting budget warning must fire exactly once');
  const found2 = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 1001,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(found2);
  assertEquals(warnings.length, 1, 'a second find() call on the same layer must not warn again');
  // A second layer, equally repetitive, gets its own independent single warning.
  const view2 = sliding(556);
  for (let i = 0; i < COUNT; i++) {
    const y = BASE + i * STEP, gray = view2(y), features = extractFeatures(gray);
    await index.add({
      id: `other/${i}`,
      node: `other-part-0/${i}`,
      canvasId: 'other-part-0',
      layer: 'other',
      frame: i,
      features,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  const query2 = view2(targetY), qf2 = extractFeatures(query2);
  const foundOther = await index.find({
    features: qf2,
    gray: query2,
    native: query2,
    layer: 'other',
    frame: 1000,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(foundOther);
  assertEquals(warnings.length, 2, 'a different layer must get its own single warning, independent of the first');
});
Deno.test('keyframes: canonical resolves a fragment-space rival to the same place as its attachment target (not ambiguous), and stays ambiguous when they genuinely differ', async () => {
  const db = new MemoryKV(), index = new KeyframeIndex(db, async () => {});
  const region = { x: 0, y: 0, width: 640, height: 400 };
  const page = makeWorld(900, 1400, 900, 'article'), g = grayscale(page.data, 900, 1400);
  const view = (y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) data.set(g.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
    return { width: 640, height: 400, data };
  };
  const shared = view(300), features = extractFeatures(shared), patches = extractPatches(shared, region, features, 1);
  // Same physical content, recorded twice: once under a fragment's own raw canvasId/coordinates (as first observed,
  // before it was attached), once under the main canvas it was later attached to. A raw-coordinate comparison would
  // see these as two different places; `canonical` maps the fragment into the main canvas's coordinate space.
  await index.add({
    id: 'frag/0',
    node: 'frag-part-0/0',
    canvasId: 'frag-part-0',
    layer: 'body',
    frame: 0,
    features,
    gray: shared,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    patches,
  });
  await index.add({
    id: 'main/50',
    node: 'main-part-0/50',
    canvasId: 'main-part-0',
    layer: 'body',
    frame: 50,
    features,
    gray: shared,
    x: 500,
    y: 300,
    scaleX: 1,
    scaleY: 1,
    patches,
  });
  const query = view(300), qf = extractFeatures(query);
  const samePlace = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 200,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
    canonical: (canvasId: string) =>
      canvasId === 'frag-part-0' ? { canvasId: 'main-part-0', dx: 500, dy: 300 } : { canvasId, dx: 0, dy: 0 },
  });
  assert(samePlace, 'expected a relocalization');
  assert(!samePlace!.ambiguous, 'a rival that canonicalizes to the same place must not be ambiguous');
  const differentPlace = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 201,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
    canonical: (canvasId: string) => canvasId === 'frag-part-0' ? { canvasId: 'main-part-0', dx: 0, dy: 0 } : { canvasId, dx: 0, dy: 0 },
  });
  assert(differentPlace, 'expected a relocalization');
  assert(differentPlace!.ambiguous, 'a rival that canonicalizes to a genuinely different place must stay ambiguous');
});
