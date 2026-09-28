/** Alternating A/B measurements of the actual Rust/Wasm extractor (including blur, selection and BRIEF).
 * Usage: deno run -A scripts/benchmark-features.ts <baseline-root> <output.json>
 * Both roots must already have build:core outputs. Timings are kernel measurements, not pipeline speedups. */
import { assertEquals } from '@std/assert';
import { join, resolve } from '@std/path';
import { Core } from '../src/core/wasm.ts';
import { rng } from '../src/core/math.ts';

const [baseline, output] = Deno.args;
if (!baseline || !output) throw new Error('Usage: benchmark-features.ts <baseline-root> <output.json>');
const reports = [];
for (const variant of ['scalar', 'simd']) {
  const load = async (root: string) =>
    await Core.instantiate(await Deno.readFile(join(root, 'rust/target', variant, 'wasm32-unknown-unknown/release/long_screen_core.wasm')));
  const before = await load(resolve(baseline)), after = await load(Deno.cwd());
  try {
    for (const [width, height] of [[480, 270], [960, 540]]) {
      for (const pattern of ['flat', 'checker', 'noise']) {
        const random = rng(717);
        const data = Uint8Array.from(
          { length: width * height },
          (_, i) =>
            pattern === 'flat'
              ? 123
              : pattern === 'checker'
              ? ((Math.floor(i / width / 6) + Math.floor(i % width / 6)) % 2) * 255
              : Math.floor(random() * 256),
        );
        const gray = { width, height, data };
        assertEquals(after.extractFeatures(gray, 480), before.extractFeatures(gray, 480));
        const samples: number[][] = [[], []], cores = [before, after];
        for (let warm = 0; warm < 10; warm++) for (const core of cores) core.extractFeatures(gray, 480);
        const repetitions = 12;
        for (let round = 0; round < 15; round++) {
          for (const which of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now();
            for (let n = 0; n < repetitions; n++) cores[which].extractFeatures(gray, 480);
            samples[which].push((performance.now() - start) / repetitions);
          }
        }
        const medians = samples.map((s) => [...s].sort((a, b) => a - b)[Math.floor(s.length / 2)]);
        reports.push({
          variant,
          width,
          height,
          pattern,
          repetitions,
          samplesMS: samples,
          mediansMS: medians,
          speedup: medians[0] / medians[1],
          scratchBytes: { before: 24 * (width + 1) * (height + 1), after: 260 * width },
        });
      }
    }
  } finally {
    before.dispose();
    after.dispose();
  }
}
await Deno.writeTextFile(output, JSON.stringify({ command: Deno.args, generatedAt: new Date().toISOString(), reports }, null, 2));
console.log(`Feature parity passed; ${reports.length} A/B measurements written to ${output}.`);
