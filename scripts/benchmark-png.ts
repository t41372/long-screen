import { resolve, toFileUrl } from '@std/path';
import { decodePNG, encodeRGBA } from '../src/codec/png.ts';

// Usage: deno run --allow-read scripts/benchmark-png.ts <baseline checkout>
const baseline = Deno.args[0];
if (!baseline) throw new Error('Provide a baseline checkout to compare the exact same encoded tile bytes.');
const before = (await import(toFileUrl(resolve(baseline, 'src/codec/png.ts')).href)).decodePNG as typeof decodePNG;
const size = 512, pixels = new Uint8ClampedArray(size * size * 4);
let seed = 17;
for (let i = 0; i < pixels.length; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  pixels[i] = seed >>> 24;
}
const bytes = await encodeRGBA({ width: size, height: size, data: pixels });
for (const decode of [before, decodePNG]) {
  const result = await decode(bytes);
  if (result.data.some((v, i) => v !== pixels[i])) throw new Error('Decoder changed pixel bytes.');
  for (let n = 0; n < 5; n++) await decode(bytes);
}
const iterations = 40, timings: Record<string, number[]> = { before: [], after: [] };
for (let round = 0; round < 6; round++) {
  const versions = round % 2 ? ['after', 'before'] : ['before', 'after'];
  for (const version of versions) {
    const decode = version === 'before' ? before : decodePNG, start = performance.now();
    for (let i = 0; i < iterations; i++) await decode(bytes);
    timings[version].push((performance.now() - start) / iterations);
  }
}
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[2] + sorted[3]) / 2;
};
console.log(JSON.stringify(
  {
    runtime: Deno.version,
    tileSize: size,
    compressedBytes: bytes.length,
    iterations,
    rounds: 6,
    msPerDecode: timings,
    medians: { before: median(timings.before), after: median(timings.after) },
    speedup: median(timings.before) / median(timings.after),
    scope: 'PNG decode only, including inflate; not whole-pipeline or iPhone performance.',
  },
  null,
  2,
));
