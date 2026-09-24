/** Kernel microbenchmarks for the Rust core in Deno's V8 (the same engine as Chrome): voting ring observe,
 *  consistency mask, and composite tile on synthetic 1418×1590 / factor-3 inputs. Reports median ms per call
 *  for each core module given on the command line, interleaved, so build variants can be compared directly.
 *
 *  deno run --allow-read scripts/benchmark-kernels.ts [label=path/to/core.wasm ...]
 *  Defaults to the scalar and SIMD outputs of scripts/build-core.sh. */
import { Core } from '../src/core/wasm.ts';
import type { Region, RGBA } from '../src/types.ts';

const args = Deno.args.length ? Deno.args : [
  'scalar=rust/target/scalar/wasm32-unknown-unknown/release/long_screen_core.wasm',
  'simd=rust/target/simd/wasm32-unknown-unknown/release/long_screen_core.wasm',
];
const cores: [string, Core][] = [];
for (const arg of args) {
  const [label, path] = arg.split('=');
  cores.push([label, await Core.instantiate(await Deno.readFile(path))]);
}
const W = 1418, H = 1590, F = 3, AW = Math.ceil(W / F), AH = Math.ceil(H / F);
const frame = (shift: number): RGBA => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = ((((x * 7) >> 4) + (((y + shift) * 5) >> 5)) * 37 + ((x ^ (y + shift)) & 31)) & 255, o = (y * W + x) * 4;
      data[o] = v;
      data[o + 1] = (v * 3) & 255;
      data[o + 2] = 255 - v;
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
};
const frames = [frame(0), frame(40), frame(80)];
const labels = new Uint8Array(W * H).fill(1);
const region: Region = { id: 'r', name: 'r', kind: 'moving', rect: { x: 0, y: 0, width: W, height: H } };
const gray = (core: Core, f: RGBA) => core.downscaleGray(f, F);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
async function bench(name: string, run: (core: Core) => void, rounds = 7, reps = 3): Promise<void> {
  const times = new Map<string, number[]>(cores.map(([label]) => [label, []]));
  for (const [, core] of cores) run(core);
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...cores].reverse() : cores;
    for (const [label, core] of order) {
      const start = performance.now();
      for (let i = 0; i < reps; i++) run(core);
      times.get(label)!.push((performance.now() - start) / reps);
    }
  }
  console.log(name.padEnd(28), [...times].map(([l, t]) => `${l} ${median(t).toFixed(2)} ms`).join('   '));
}

const rings = new Map<Core, ReturnType<Core['votingRing']>>();
for (const [, core] of cores) {
  const ring = core.votingRing([region], {
    factor: F,
    noise: 10,
    nativeWidth: W,
    nativeHeight: H,
    analysisWidth: AW,
    analysisHeight: AH,
    budgetBytes: 24 << 20,
  });
  // Seed six partners past dmin so observe() does the full comparison work.
  for (let i = 0; i < 6; i++) {
    ring.observe(0, 'c', { x: 0, y: 100 * (i + 1) }, gray(core, frames[i % 3]), false);
    ring.pushFrame(i);
  }
  rings.set(core, ring);
}
let frameIndex = 100;
await bench('voting observe (6 partners)', (core) => {
  const ring = rings.get(core)!;
  ring.observe(0, 'c', { x: 0, y: 100 * 7 + (frameIndex % 3) }, gray(core, frames[frameIndex % 3]), false);
  ring.pushFrame(frameIndex++);
});
await bench('consistency mask (2 nbrs)', (core) => {
  core.consistencyMask({
    image: frames[1],
    labels,
    region: region.rect,
    code: 1,
    pose: { x: 0, y: 40 },
    prev: { image: frames[0], x: 0, y: 0 },
    next: { image: frames[2], x: 0, y: 80 },
    factor: F,
    noise: 10,
  });
});
await bench('downscaleGray f=3', (core) => gray(core, frames[0]));
await bench('grayscale', (core) => core.grayscale(frames[0].data, W, H));
const tileSize = 512, n = tileSize * tileSize, blocks = (tileSize / 16) ** 2;
const tile = () => ({
  pixels: new Uint8ClampedArray(n * 4),
  coverage: new Uint8Array(n / 8),
  provisional: new Uint8Array(n / 8),
  quality: new Uint8Array(blocks),
  conflicts: new Uint8Array(blocks),
  owner: new Uint32Array(blocks),
  score: new Float32Array(blocks),
  frozen: new Uint8Array(blocks),
});
const tiles = new Map<Core, ReturnType<typeof tile>[]>(cores.map(([, core]) => [core, Array.from({ length: 12 }, tile)]));
await bench('composite 12 tiles', (core) => {
  const prepared = core.prepareObservation(
    { image: frames[frameIndex % 3], confidence: .8, uncertain: false, frame: frameIndex },
    tileSize,
  );
  const set = tiles.get(core)!;
  let k = 0;
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      prepared.compositeTile(set[k++], { x: 0, y: (frameIndex % 3) * 40, width: W, height: H }, 0, (frameIndex % 3) * 40, tx, ty);
    }
  }
  frameIndex++;
});
for (const ring of rings.values()) ring.free();
