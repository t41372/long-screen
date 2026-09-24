import '../support/core.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { extractFeatures, grayscale, matchFeatures } from '../../src/core/features.ts';
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
import { crop, rgba } from '../support/pixel-fixtures.ts';
import type { Gray, Match } from '../../src/types.ts';
import { makeWorld } from '../../src/synthetic/world.ts';
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
  const masked = refineNative(a, b, { x: 17, y: 23 }, { x: 0, y: 0, width: 320, height: 240 }, {
    labels: new Uint8Array(320 * 240),
    code: 1,
  });
  assertEquals(masked.error, Infinity);
  const tiny = { width: 20, height: 20, data: new Uint8ClampedArray(1600) };
  const q = refineNative(tiny, tiny, { x: 0, y: 40 }, { x: 0, y: 0, width: 20, height: 3 });
  assert(Number.isFinite(q.x) && Number.isFinite(q.y) && q.error === Infinity);
  const other = refineNative(a, { ...b, width: 100 }, { x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 10 });
  assertEquals(other.error, Infinity);
  const stripe = new Uint8Array(320 * 240);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 6; x++) stripe[y * 320 + x] = 1;
  const mostlyMasked = refineNative(a, b, { x: 17, y: 23 }, { x: 0, y: 0, width: 320, height: 240 }, { labels: stripe, code: 1 });
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
