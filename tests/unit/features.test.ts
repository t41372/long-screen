import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { extractFeatures, grayscale, matchFeatures } from '../../src/core/features.ts';
import { core } from '../../src/core/wasm.ts';
import { crop } from '../support/pixel-fixtures.ts';
import type { Feature } from '../../src/types.ts';
Deno.test('features: grayscale, blank frames yield no invented features, words and difference', () => {
  const g = grayscale(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assertEquals([...g.data], [255, 0]);
  const blank = { width: 160, height: 120, data: new Uint8Array(160 * 120).fill(245) };
  assertEquals(extractFeatures(blank).length, 0);
  assertEquals(matchFeatures(extractFeatures(blank), extractFeatures(blank)).length, 0);
  const f = extractFeatures(crop(0, 0));
  assert(f.length > 100);
  assert(core().featureWords(f).length > 10);
  assertEquals(core().meanDifference(blank, crop(0, 0, 10, 10)), 255);
  assertEquals(core().meanDifference(blank, blank), 0);
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
