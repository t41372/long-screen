import {
  consistencyMaskReference,
  type ConsistencyReferenceNeighbour,
  type ConsistencyReferenceVote,
} from '../tests/support/consistency-reference.ts';
import { RegionAtlas } from '../src/core/layers.ts';
import { analysisFactor } from '../src/core/raster.ts';
import { DEFAULT_SETTINGS, type Rect, type RGBA } from '../src/types.ts';
import { Engine } from '../src/pipeline/engine.ts';
import { MemoryKV } from '../src/storage/db.ts';
import { ScenarioSource } from '../src/synthetic/source.ts';
import { buildScenario } from '../src/synthetic/scenarios.ts';

const WIDTH = 3456, HEIGHT = 2234, ANALYSIS_SIZE = 640, FACTOR = analysisFactor(WIDTH, HEIGHT, ANALYSIS_SIZE);
const ROUNDS = 6;

function option(name: string, fallback: number): number {
  const value = Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function makeFrameData(): { current: RGBA; prev: RGBA; next: RGBA } {
  const pixels = WIDTH * HEIGHT;
  const current = new Uint8ClampedArray(pixels * 4), prev = new Uint8ClampedArray(pixels * 4), next = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    const i = p * 4, value = (p * 17 + (p >>> 9) * 13) & 255;
    current[i] = prev[i] = next[i] = value;
    current[i + 1] = prev[i + 1] = next[i + 1] = (value * 5 + 29) & 255;
    current[i + 2] = prev[i + 2] = next[i + 2] = (value * 11 + 7) & 255;
    current[i + 3] = prev[i + 3] = next[i + 3] = 255;
  }
  // Include exact matches, differences inside noise10, and larger disagreements in every measured call.
  for (let p = 7919; p < pixels; p += 104729) {
    const i = p * 4;
    current[i] = (current[i] + 43) & 255;
    prev[i + 1] = (prev[i + 1] + 5) & 255;
    next[i + 2] = (next[i + 2] + 37) & 255;
  }
  return {
    current: { width: WIDTH, height: HEIGHT, data: current },
    prev: { width: WIDTH, height: HEIGHT, data: prev },
    next: { width: WIDTH, height: HEIGHT, data: next },
  };
}

function packedVote(x0: number, y0: number, w: number, h: number, salt: number): ConsistencyReferenceVote {
  const cells = w * h, bytes = Math.ceil(cells / 8), bits = new Uint8Array(bytes), clean = new Uint8Array(bytes);
  for (let i = 0; i < cells; i++) {
    const bit = 1 << (i & 7), byte = i >> 3;
    // Keep most cells verdict-free while exercising both packed bitsets and both verdict outcomes.
    if ((i + salt) % 173 === 0) bits[byte] |= bit;
    else if ((i + salt * 3) % 197 === 0) clean[byte] |= bit;
  }
  return { x0, y0, w, h, bits, clean };
}

function assertSame(actual: Uint8Array, expected: Uint8Array, sample: string): void {
  if (actual.length !== expected.length) throw new Error(`${sample}: unexpected mask length.`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${sample}: mask diverged at pixel ${i}.`);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

interface BenchmarkCase {
  name: string;
  factor: number;
  noise: number;
  pose: { x: number; y: number };
  prev?: ConsistencyReferenceNeighbour;
  next?: ConsistencyReferenceNeighbour;
  voting?: ConsistencyReferenceVote;
}

const rounds = option('rounds', ROUNDS),
  source10 = new ScenarioSource(buildScenario('fixture')),
  source0 = new ScenarioSource(buildScenario('fixture'));
source10.info.noise = 10;
source0.info.noise = 0;
const makeEngine = (source: ScenarioSource): Engine =>
  new Engine(new MemoryKV(), source, DEFAULT_SETTINGS, {
    progress: () => {},
    diagnostic: () => {},
    preview: () => {},
    project: () => {},
  });
const engines = { noise10: makeEngine(source10), lossless: makeEngine(source0) };
const region = { id: 'benchmark', name: 'benchmark', kind: 'moving' as const, rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT } };
const atlas = new RegionAtlas([region], WIDTH, HEIGHT), code = atlas.code(region), data = makeFrameData();
const voteWidth = Math.ceil(WIDTH / FACTOR), voteHeight = Math.ceil(HEIGHT / FACTOR);
const occlusions: Rect[] = [
  { x: 240, y: 180, width: 96, height: 72 },
  { x: 1180, y: 760, width: 128, height: 96 },
  { x: 2320, y: 1320, width: 144, height: 112 },
  { x: 3060, y: 1980, width: 180, height: 120 },
];
const factor6Neighbours = (
  voting: boolean,
  withOcclusions = true,
): { prev: ConsistencyReferenceNeighbour; next: ConsistencyReferenceNeighbour } => ({
  prev: {
    image: data.prev,
    x: -.49,
    y: .49,
    canvasId: 'canvas',
    occlusions: withOcclusions ? occlusions : undefined,
    voting: voting ? packedVote(0, 0, voteWidth, voteHeight, 11) : undefined,
  },
  next: {
    image: data.next,
    x: .49,
    y: -.49,
    canvasId: 'canvas',
    occlusions: withOcclusions ? occlusions : undefined,
    voting: voting ? packedVote(0, 0, voteWidth, voteHeight, 29) : undefined,
  },
});
const factor6 = factor6Neighbours(true), lossless = factor6Neighbours(false, false);
const cases: BenchmarkCase[] = [
  {
    name: 'factor6-noise10-packed-voting-occlusions',
    factor: FACTOR,
    noise: 10,
    pose: { x: .49, y: -.49 },
    prev: factor6.prev,
    next: factor6.next,
    voting: packedVote(0, 0, voteWidth, voteHeight, 47),
  },
  {
    name: 'factor1-lossless-no-votes',
    factor: 1,
    noise: 0,
    pose: { x: .49, y: -.49 },
    prev: lossless.prev,
    next: lossless.next,
  },
];

function run(engine: Engine, benchmarkCase: BenchmarkCase, useReference: boolean): { elapsed: number; result: Uint8Array } {
  (engine as unknown as { factor: number }).factor = benchmarkCase.factor;
  const started = performance.now();
  const result = useReference
    ? consistencyMaskReference(
      data.current,
      atlas,
      region,
      code,
      benchmarkCase.pose,
      'canvas',
      benchmarkCase.prev,
      benchmarkCase.next,
      benchmarkCase.voting,
      benchmarkCase.factor,
      benchmarkCase.noise,
    )
    : (engine as unknown as { consistencyMask: (...args: unknown[]) => Uint8Array }).consistencyMask(
      data.current,
      atlas,
      region,
      code,
      benchmarkCase.pose,
      'canvas',
      benchmarkCase.prev,
      benchmarkCase.next,
      benchmarkCase.voting,
    );
  return { elapsed: performance.now() - started, result };
}

// Warm both paths, then alternate old/new order by case and round. Only one call per implementation/case/round is measured.
for (const benchmarkCase of cases) {
  const engine = benchmarkCase.noise ? engines.noise10 : engines.lossless;
  run(engine, benchmarkCase, true);
  run(engine, benchmarkCase, false);
}
const measurements = new Map<string, { reference: number[]; optimized: number[] }>();
for (const benchmarkCase of cases) measurements.set(benchmarkCase.name, { reference: [], optimized: [] });
for (let round = 0; round < rounds; round++) {
  for (let index = 0; index < cases.length; index++) {
    const benchmarkCase = cases[index], engine = benchmarkCase.noise ? engines.noise10 : engines.lossless;
    const sample = measurements.get(benchmarkCase.name)!;
    const referenceFirst = (round + index) % 2 === 0;
    const reference = referenceFirst ? run(engine, benchmarkCase, true) : run(engine, benchmarkCase, false);
    const optimized = referenceFirst ? run(engine, benchmarkCase, false) : run(engine, benchmarkCase, true);
    const referenceRun = referenceFirst ? reference : optimized, optimizedRun = referenceFirst ? optimized : reference;
    sample.reference.push(referenceRun.elapsed);
    sample.optimized.push(optimizedRun.elapsed);
    assertSame(optimizedRun.result, referenceRun.result, `${benchmarkCase.name} round ${round}`);
  }
}

console.log(JSON.stringify({
  dimensions: `${WIDTH}x${HEIGHT}`,
  analysisSize: ANALYSIS_SIZE,
  factor: FACTOR,
  rounds,
  cases: Object.fromEntries([...measurements].map(([name, sample]) => [name, {
    referenceMedianMs: Number(median(sample.reference).toFixed(2)),
    optimizedMedianMs: Number(median(sample.optimized).toFixed(2)),
    speedup: Number((median(sample.reference) / median(sample.optimized)).toFixed(2)),
    referenceSamplesMs: sample.reference.map((value) => Number(value.toFixed(2))),
    optimizedSamplesMs: sample.optimized.map((value) => Number(value.toFixed(2))),
  }])),
}));
