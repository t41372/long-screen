import { type AssessmentVote, AssessmentWasm, type ConsistencyInput } from './runner.ts';
import { downscaleGray } from '../../src/core/raster.ts';
import { Engine } from '../../src/pipeline/engine.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { DEFAULT_SETTINGS } from '../../src/types.ts';

function same(a: Uint8Array, b: Uint8Array): void {
  if (a.length !== b.length) throw new Error('Different output lengths');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`Pixel mismatch at ${i}: ${a[i]} != ${b[i]}`);
}

const asRGBA = (data: Uint8Array, width: number, height: number) => ({
  width,
  height,
  data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
});

function makeInput(width: number, height: number, seed: number, votes = true): ConsistencyInput {
  const image = new Uint8Array(width * height * 4), labels = new Uint8Array(width * height).fill(1);
  for (let i = 0; i < image.length; i++) image[i] = (Math.imul(i, 13 + seed % 5) + (i >>> 9)) & 255;
  const prev = image.slice(), next = image.slice();
  for (let i = 0; i < image.length; i += 137) prev[i] ^= 47;
  for (let i = 0; i < image.length; i += 359) next[i] ^= 23;
  for (let i = 0; i < labels.length; i += 43) labels[i] = 2;
  const factor = [1, 2, 4, 6][seed % 4];
  const vote = (salt: number): AssessmentVote => {
    const w = Math.ceil(width / factor), h = Math.ceil(height / factor);
    const bits = new Uint8Array(Math.ceil(w * h / 8)), clean = new Uint8Array(bits.length);
    for (let i = 0; i < w * h; i++) {
      if ((i + salt) % 173 === 0) bits[i >> 3] |= 1 << (i & 7);
      if ((i + salt) % 197 === 0) clean[i >> 3] |= 1 << (i & 7);
    }
    return { x0: seed % 3 - 1, y0: salt % 3 - 1, w, h, bits, clean };
  };
  const offsets = [-1.6, -.6, -.5000000000000001, -.5, -.49, 0, .49, .49999999999999994, .5, .6, 1.5];
  const pose = { x: offsets[seed % offsets.length], y: offsets[(seed + 3) % offsets.length] };
  const occlusions = [{ x: width / 3 + .25, y: height / 5, width: width / 7, height: height / 8 }];
  return {
    image,
    labels,
    width,
    height,
    factor,
    noise: seed % 2 ? 10 : 0,
    code: 1,
    pose,
    region: { x: seed % 3 - 1.5, y: -.25, width, height },
    voting: votes ? vote(7) : undefined,
    prev: seed % 7 === 0 ? undefined : {
      image: prev,
      x: -pose.x,
      y: -pose.y,
      canvasId: seed % 5 === 0 ? 'other' : 'canvas',
      occlusions,
      voting: votes ? vote(11) : undefined,
    },
    next: seed % 11 === 0 ? undefined : {
      image: next,
      x: pose.y,
      y: pose.x,
      canvasId: 'canvas',
      occlusions,
      voting: votes ? vote(23) : undefined,
    },
  };
}

function engine(noise: number): Engine {
  const source = new ScenarioSource(buildScenario('fixture'));
  source.info.noise = noise;
  return new Engine(new MemoryKV(), source, DEFAULT_SETTINGS, {
    progress: () => {},
    diagnostic: () => {},
    preview: () => {},
    project: () => {},
  });
}

function currentTS(e: Engine, input: ConsistencyInput): () => Uint8Array {
  e.factor = input.factor;
  const region = { id: 'assessment', name: 'assessment', kind: 'moving' as const, rect: input.region };
  const atlas = new RegionAtlas([region], input.width, input.height);
  atlas.labels.set(input.labels);
  const image = asRGBA(input.image, input.width, input.height);
  const neighbour = (n: ConsistencyInput['prev']) =>
    n && ({
      ...n,
      canvasId: n.canvasId ?? 'canvas',
      image: asRGBA(n.image, input.width, input.height),
    });
  const prev = neighbour(input.prev), next = neighbour(input.next);
  return () =>
    (e as unknown as { consistencyMask: (...args: unknown[]) => Uint8Array }).consistencyMask(
      image,
      atlas,
      region,
      input.code,
      input.pose,
      'canvas',
      prev,
      next,
      input.voting,
    );
}

function measure(paths: Record<string, () => void>, rounds = 9): Record<string, { medianMS: number; samplesMS: number[] }> {
  const names = Object.keys(paths), times: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, []]));
  for (let round = -3; round < rounds; round++) {
    const order = round % 2 ? names : [...names].reverse();
    for (const name of order) {
      const start = performance.now();
      paths[name]();
      const elapsed = performance.now() - start;
      if (round >= 0) times[name].push(elapsed);
    }
  }
  return Object.fromEntries(names.map((name) => [name, {
    medianMS: [...times[name]].sort((a, b) => a - b)[rounds >> 1],
    samplesMS: times[name],
  }]));
}

export async function runAssessment(bytes: Uint8Array<ArrayBuffer>) {
  const wasm = await AssessmentWasm.fromBytes(bytes), engines = [engine(0), engine(10)];
  for (let seed = 0; seed < 160; seed++) {
    const input = makeInput(7 + seed % 53, 5 + seed % 37, seed, seed % 3 !== 0);
    same(currentTS(engines[seed % 2], input)(), wasm.runConsistency(input));
  }
  for (const x of [-.5000000000000001, -.5, .49999999999999994, .5]) {
    const input = makeInput(8, 5, 3, false);
    input.pose = { x, y: 0 };
    input.prev = { image: input.image.slice(), x: 0, y: 0 };
    input.next = undefined;
    same(currentTS(engines[1], input)(), wasm.runConsistency(input));
  }
  const dimensions = [[641, 449, 2], [1082, 1920, 4], [1919, 1079, 4], [1, 3, 8]];
  for (const [w, h, factor] of dimensions) {
    const input = makeInput(w, h, 3);
    const expected = downscaleGray(asRGBA(input.image, w, h), factor), actual = wasm.runDownscale(input.image, w, h, factor);
    if (expected.width !== actual.width || expected.height !== actual.height) throw new Error('Downscale dimensions differ.');
    same(expected.data, actual.data);
  }
  const width = 3456, height = 2234;
  const consistency: Record<string, ReturnType<typeof measure>> = {};
  for (const votes of [true, false]) {
    const input = makeInput(width, height, 3, votes);
    // A large overlap exercises both neighbours, rather than mostly returning on the first mismatch.
    input.pose = { x: .49, y: -.49 };
    input.prev!.x = -.49;
    input.prev!.y = .49;
    input.next!.x = .49;
    input.next!.y = -.49;
    const ts = currentTS(engines[1], input), prepared = wasm.prepareConsistency(input);
    prepared.call();
    same(ts(), prepared.readOutput());
    let result: Uint8Array = new Uint8Array(0);
    consistency[votes ? 'votes-occlusions' : 'no-votes-occlusions'] = measure({
      typescript: () => {
        result = ts();
      },
      wasmResident: () => prepared.call(),
      wasmOneFrameAndOutputCopy: () => {
        prepared.copyCurrent(input.image);
        prepared.call();
        result = prepared.readOutput();
      },
      wasmThreeFramesAndOutputCopy: () => {
        prepared.copyAll(input.image, input.prev!.image, input.next!.image);
        prepared.call();
        result = prepared.readOutput();
      },
    });
    same(ts(), result);
    prepared.call();
    same(ts(), prepared.readOutput());
  }
  const input = makeInput(width, height, 3), rgba = asRGBA(input.image, width, height), factor = 6;
  wasm.reset();
  const pointer = wasm.copyIn(input.image), length = Math.ceil(width / factor) * Math.ceil(height / factor), output = wasm.alloc(length);
  const call = () => wasm.exports.downscale_gray(pointer, output, width, height, factor);
  const read = () => new Uint8Array(wasm.exports.memory.buffer, output, length).slice();
  call();
  same(downscaleGray(rgba, factor).data, read());
  let downscaleResult: Uint8Array = new Uint8Array(0);
  const downscale = measure({
    typescript: () => {
      downscaleResult = downscaleGray(rgba, factor).data;
    },
    wasmResident: call,
    wasmOneFrameAndOutputCopy: () => {
      new Uint8Array(wasm.exports.memory.buffer, pointer, input.image.length).set(input.image);
      call();
      downscaleResult = read();
    },
  });
  same(downscaleGray(rgba, factor).data, downscaleResult);
  return {
    width,
    height,
    factor,
    parity: { consistencyCases: 166, downscaleCases: 5, byteExact: true },
    consistency,
    downscale,
    wasmMemoryBytes: wasm.exports.memory.buffer.byteLength,
    notes:
      'Synthetic native-size kernels only. Scalar Wasm, reusable output. Resident excludes setup/copy; copy paths include output copy. No decode, storage, export or e2e measurement.',
  };
}

(globalThis as unknown as { runAssessment: typeof runAssessment }).runAssessment = runAssessment;
