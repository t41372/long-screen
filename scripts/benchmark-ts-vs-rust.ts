/** Same inputs, same algorithm: the frozen TypeScript implementations the Rust core replaced
 *  (tests/support/reference/, kept as parity oracles) against the Rust core, per kernel, in Deno's V8 (Chrome's
 *  engine). Inputs are three consecutive decoded frames of a real recording (ffmpeg on PATH) or synthetic frames.
 *  Rust timings include copying inputs into and results out of Wasm memory; the pipeline avoids much of that by
 *  keeping frames resident, so they are conservative. Every kernel's outputs are compared, and a mismatch aborts.
 *
 *  LONGSCREEN_CORE=scalar|simd|threads [LONGSCREEN_THREADS=n] deno run -A scripts/benchmark-ts-vs-rust.ts [recording [first-frame]]
 */
import { assertEquals } from '@std/assert';
import '../tests/support/core.ts';
import { core, coreBuild } from '../src/core/wasm.ts';
import { analysisFactor, downscaleGray } from '../src/core/raster.ts';
import { extractFeatures, grayscale, matchFeatures } from '../src/core/features.ts';
import { estimateMotion } from '../src/core/motion.ts';
import { RegionAtlas } from '../src/core/layers.ts';
import type { Feature, Gray, MotionField, Region, RGBA } from '../src/types.ts';
import * as ts from '../tests/support/reference/kernels.ts';
import * as tsMotion from '../tests/support/reference/motion.ts';
import { ReferenceVotingRing } from '../tests/support/reference/voting.ts';
import { consistencyMaskReference } from '../tests/support/reference/consistency.ts';

const [recording, firstArg] = Deno.args;

async function decode(path: string, first: number): Promise<RGBA[]> {
  const probe = await new Deno.Command('ffprobe', {
    args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
  }).output();
  const [width, height] = new TextDecoder().decode(probe.stdout).trim().split(',').map(Number);
  const out = await new Deno.Command('ffmpeg', {
    args: [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `select=gte(n\\,${first})`,
      '-vsync',
      '0',
      '-frames:v',
      '3',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    stdout: 'piped',
  }).output();
  if (!out.success) throw new Error('ffmpeg could not decode the recording');
  const bytes = width * height * 4;
  return [0, 1, 2].map((i) => ({ width, height, data: new Uint8ClampedArray(out.stdout.buffer, i * bytes, bytes).slice() }));
}
function synthetic(width: number, height: number): RGBA[] {
  return [0, 40, 80].map((shift) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = ((((x * 7) >> 4) + (((y + shift) * 5) >> 5)) * 37 + ((x ^ (y + shift)) & 31)) & 255, o = (y * width + x) * 4;
        data.set([v, (v * 3) & 255, 255 - v, 255], o);
      }
    }
    return { width, height, data };
  });
}
const frames = recording ? await decode(recording, Number(firstArg || 120)) : synthetic(1418, 1590);
const { width: W, height: H } = frames[0], F = analysisFactor(W, H, 640);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const rows: { kernel: string; tsMS: number; rustMS: number }[] = [];
/** Interleaved rounds so drift in CPU speed hits both sides alike; `reps` calls per timed round. */
function bench<T>(kernel: string, a: () => T, b: () => T, same: (x: T, y: T) => void, rounds = 5, reps = 1): void {
  same(a(), b());
  const ta: number[] = [], tb: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const [run, times] of (r % 2 ? [[b, tb], [a, ta]] : [[a, ta], [b, tb]]) as [() => T, number[]][]) {
      const start = performance.now();
      for (let i = 0; i < reps; i++) run();
      times.push((performance.now() - start) / reps);
    }
  }
  rows.push({ kernel, tsMS: median(ta), rustMS: median(tb) });
}
// Every integer field and per-cell array must match exactly; the f64 motion confidence/error go through exp(), which
// Rust's libm and V8's Math.exp may round differently in the last bit (see docs/history/2026-09-rust-migration-log.md), so those are compared
// to the parity tests' 1e-9 relative tolerance and the largest difference is reported.
let motionFloatDiff = 0;
const sameMotion = (x: MotionField, y: MotionField) => {
  const strip = (f: MotionField) => ({ ...f, motions: f.motions.map((m) => ({ ...m, confidence: 0, error: 0 })) });
  assertEquals(strip(x), strip(y));
  x.motions.forEach((m, i) => {
    for (const k of ['confidence', 'error'] as const) {
      const d = Math.abs(m[k] - y.motions[i][k]) / Math.max(1e-300, Math.abs(y.motions[i][k]));
      if (d > 1e-9) throw new Error(`motion ${i} ${k}: ${m[k]} vs ${y.motions[i][k]}`);
      motionFloatDiff = Math.max(motionFloatDiff, d);
    }
  });
};
const sameGray = (x: Gray, y: Gray) => assertEquals([x.width, x.height, x.data], [y.width, y.height, y.data]);
const sameJSON = (x: unknown, y: unknown) => assertEquals(JSON.stringify(x), JSON.stringify(y));
// Rust ranks features by the same f64 score and returns it as f32 (the pipeline already stores it as f32 and never
// reads it after selection), so the score must equal the f32 rounding of the TS score exactly.
const sameFeatures = (x: Feature[], y: Feature[]) =>
  sameJSON(
    x.map((f) => ({ ...f, score: Math.fround(f.score), descriptor: [...f.descriptor] })),
    y.map((f) => ({ ...f, descriptor: [...f.descriptor] })),
  );

bench('grayscale (native)', () => ts.grayscale(frames[0].data, W, H), () => grayscale(frames[0].data, W, H), sameGray);
bench(`downscaleGray (f=${F})`, () => ts.downscaleGray(frames[0], F), () => downscaleGray(frames[0], F), sameGray);
const grays = frames.map((f) => downscaleGray(f, F));
bench('extractFeatures', () => ts.extractFeatures(grays[1]), () => extractFeatures(grays[1]), sameFeatures);
const fa = extractFeatures(grays[0]), fb = extractFeatures(grays[1]);
bench('matchFeatures', () => ts.matchFeatures(fa, fb), () => matchFeatures(fa, fb), sameJSON);
bench(
  'estimateMotion',
  () => tsMotion.estimateMotion(grays[0], grays[1], undefined, fa, fb),
  () => estimateMotion(grays[0], grays[1], undefined, fa, fb),
  sameMotion,
);

// Consistency mask for the middle frame against both neighbours, at the measured analysis displacement.
const motion = estimateMotion(grays[0], grays[1], undefined, fa, fb).motions[0] ?? { x: 0, y: 0 };
const step = { x: Math.round(motion.x * F), y: Math.round(motion.y * F) };
const region: Region = {
  id: 'r',
  name: 'r',
  kind: 'moving',
  rect: { x: 0, y: Math.round(H * .08), width: W, height: Math.round(H * .84) },
};
const atlas = new RegionAtlas([region], W, H), code = atlas.code(region);
const pose = { x: 0, y: 0 }, prevPose = { x: step.x, y: step.y }, nextPose = { x: -step.x, y: -step.y };
bench(
  // The frozen reference is the TS mask from before its invariants were hoisted; the TS that shipped was faster.
  'consistency mask (2 nbrs)*',
  () =>
    consistencyMaskReference(
      frames[1],
      atlas,
      region,
      code,
      pose,
      'c',
      { image: frames[0], ...prevPose, canvasId: 'c' },
      { image: frames[2], ...nextPose, canvasId: 'c' },
      undefined,
      F,
      10,
    ),
  () =>
    core().consistencyMask({
      image: frames[1],
      labels: atlas.labels,
      region: region.rect,
      code,
      pose,
      prev: { image: frames[0], ...prevPose },
      next: { image: frames[2], ...nextPose },
      factor: F,
      noise: 10,
    }),
  (x, y) => assertEquals(x, y),
  3,
);

// Voting: six earlier partners in the ring, then observe + pushFrame for the next frame, as in the solve pass.
const AW = grays[0].width, AH = grays[0].height;
const tsRing = new ReferenceVotingRing(F, 10, W, H, [region]);
const rustRing = core().votingRing([region], {
  factor: F,
  noise: 10,
  nativeWidth: W,
  nativeHeight: H,
  analysisWidth: AW,
  analysisHeight: AH,
  budgetBytes: 24 << 20,
});
for (let i = 0; i < 6; i++) {
  const p = { x: 0, y: -80 * i };
  tsRing.observe(region, 'c', p, grays[i % 3]);
  tsRing.pushFrame(i);
  rustRing.observe(0, 'c', p, grays[i % 3], false);
  rustRing.pushFrame(i);
}
let voteFrame = 6;
bench(
  'voting observe + push',
  () => {
    tsRing.observe(region, 'c', { x: 0, y: -80 * voteFrame }, grays[voteFrame % 3]);
    return tsRing.pushFrame(voteFrame).length;
  },
  () => {
    rustRing.observe(0, 'c', { x: 0, y: -80 * voteFrame }, grays[voteFrame++ % 3], false);
    return rustRing.pushFrame(voteFrame - 1).length;
  },
  (x, y) => assertEquals(x, y),
);
rustRing.free();

const tile = new Uint8Array(frames[1].data.buffer, 0, 512 * 512 * 4);
bench(
  'PNG Sub filter (512² tile)',
  () => ts.filterSub(new Uint8ClampedArray(tile), 512, 512),
  () => core().pngFilterSub(tile, 512, 512),
  (x, y) => assertEquals(x, y),
  5,
  5,
);
const filtered = core().pngFilterSub(tile, 512, 512);
bench(
  'PNG unfilter (512² tile)',
  () => ts.unfilterPNG(filtered, 512, 512, 4),
  () => core().pngUnfilter(filtered, 512, 512, 4),
  (x, y) => assertEquals(x, y),
  5,
  5,
);

console.log(
  JSON.stringify({
    motionFloatMaxRelativeDiff: motionFloatDiff,
    input: recording ? `${W}×${H} frames ${firstArg || 120}–` : `synthetic ${W}×${H}`,
    factor: F,
    core: coreBuild(),
  }),
);
for (const r of rows) {
  console.log(
    `${r.kernel.padEnd(28)} TS ${r.tsMS.toFixed(2).padStart(9)} ms   Rust ${r.rustMS.toFixed(2).padStart(8)} ms   ${
      (r.tsMS / r.rustMS).toFixed(1).padStart(5)
    }×`,
  );
}

// The threaded core's parked pool helpers would keep the process alive.
Deno.exit(0);
