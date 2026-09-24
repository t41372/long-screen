import { assert, assertEquals } from '@std/assert';
import { Engine, type EngineEvents } from '../../src/pipeline/engine.ts';
import { consistencyMask } from '../../src/pipeline/consistency.ts';
import { iterate, type KV, MemoryKV, Namespace, type Row } from '../../src/storage/db.ts';
import {
  DEFAULT_SETTINGS,
  type Diagnostic,
  type FrameImage,
  type FramePlan,
  type FrameSource,
  type MediaInfo,
  type Progress,
  type RGBA,
  type Settings,
} from '../../src/types.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { pad } from '../../src/core/math.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { runScenario } from '../support/run.ts';
import { core } from '../../src/core/wasm.ts';
/** Minimal synthetic FrameSource: deterministic, always-different pixel content (never bit-identical between
 * frames), independent of the synthetic-world/scenario machinery. Good enough for tests that only care about
 * control flow (error classification, disposal, batching), not placement correctness. */
function syntheticSource(count: number, width = 48, height = 32): FrameSource & { disposed: boolean } {
  const info: MediaInfo = {
    name: 'synthetic.generated',
    size: 0,
    width,
    height,
    codedWidth: width,
    codedHeight: height,
    rotation: 0,
    duration: count / 30,
    frameCount: count,
    codec: 'test',
    mode: 'test',
    warnings: [],
    notices: [],
  };
  const source = {
    info,
    disposed: false,
    dispose(): void {
      source.disposed = true;
    },
    async *frames(): AsyncGenerator<FrameImage> {
      for (let i = 0; i < count; i++) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let p = 0; p < width * height; p++) {
          const v = (p * 3 + i * 11) % 256;
          data[p * 4] = v;
          data[p * 4 + 1] = (v * 7) % 256;
          data[p * 4 + 2] = (v * 13) % 256;
          data[p * 4 + 3] = 255;
        }
        yield { image: { width, height, data }, time: i / 30, duration: 1 / 30, index: i };
        await Promise.resolve();
      }
    },
  };
  return source;
}
/** Wraps a FrameSource so a chosen call to frames() throws (decode failure) or yields a body-breaking frame
 * (algorithmic failure) at a chosen frame index. `pass` counts calls to frames() from 1: scan() is the first,
 * solve() the second, render() the third. */
function faultySource(
  inner: FrameSource,
  fault: { pass: number; frameIndex: number; kind: 'decode' | 'corrupt' },
): FrameSource & { disposed: boolean } {
  let calls = 0, disposed = false;
  return {
    info: inner.info,
    get disposed() {
      return disposed;
    },
    dispose(): void {
      disposed = true;
      inner.dispose();
    },
    async *frames(): AsyncGenerator<FrameImage> {
      calls++;
      const pass = calls;
      for await (const frame of inner.frames()) {
        if (fault.pass === pass && frame.index === fault.frameIndex) {
          if (fault.kind === 'decode') {
            throw new Error('SYNTHETIC_DECODE_FAILURE: simulated decoder crash');
          }
          // A generic algorithmic failure, unrelated to geometry or storage: equalRGBA/gray touch
          // image.data immediately, so an undefined data array throws deterministically.
          yield { ...frame, image: { ...frame.image, data: undefined as unknown as Uint8ClampedArray } };
          continue;
        }
        yield frame;
      }
    },
  };
}
/** Keeps the declared frame count but ends a selected decode pass after a shorter natural prefix. */
function truncatedSource(inner: FrameSource, limits: Record<number, number>): FrameSource & { disposed: boolean } {
  let calls = 0, disposed = false;
  return {
    info: inner.info,
    get disposed() {
      return disposed;
    },
    dispose(): void {
      disposed = true;
      inner.dispose();
    },
    async *frames(): AsyncGenerator<FrameImage> {
      const limit = limits[++calls];
      let yielded = 0;
      for await (const frame of inner.frames()) {
        if (limit !== undefined && yielded >= limit) break;
        yield frame;
        yielded++;
      }
    },
  };
}
function hideKey(db: MemoryKV, suffix: string): KV {
  return {
    get: (key) => key.endsWith(suffix) ? Promise.resolve(undefined) : db.get(key),
    put: (key, value) => db.put(key, value),
    delete: (key) => db.delete(key),
    deleteMany: (keys) => db.deleteMany(keys),
    scan: (prefix, options) => db.scan(prefix, options),
    putMany: (rows) => db.putMany(rows),
  };
}
function makeEngine(
  db: KV,
  source: FrameSource,
  settings: Partial<Settings>,
  onDiagnostic?: (d: Diagnostic) => void,
  onProgress?: (p: Progress) => void,
): Engine {
  const handlers: EngineEvents = { progress: (p) => onProgress?.(p), diagnostic: (d) => onDiagnostic?.(d), project: () => {} };
  return new Engine(db, source, { ...DEFAULT_SETTINGS, ...settings }, handlers);
}
async function codesOf(store: KV): Promise<Set<string>> {
  const codes = new Set<string>();
  for await (const { value } of iterate<Diagnostic>(store, 'diagnostic/')) codes.add(value.code);
  return codes;
}
// F21: the first persist() must be inside the try, or a failing initial write leaks the decoder/GPU device.
Deno.test('engine F21: a failing initial persist() still disposes the source (and resolves, not throws)', async () => {
  const db = new MemoryKV();
  const failFirst: KV = {
    get: (k) => db.get(k),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    putMany: (r) => db.putMany(r),
    put: () => Promise.reject(new Error('initial write failed')),
  };
  const source = syntheticSource(5);
  const engine = makeEngine(failFirst, source, {});
  const project = await engine.run();
  assertEquals(project.status, 'error');
  assert(project.error?.includes('initial write failed'), project.error);
  assert(source.disposed, 'source.dispose() must still run when the very first persist() throws');
});
// F22: scan() distinguishes a decode failure from an algorithmic failure from a storage failure.
Deno.test('engine F22: a decode-step failure after ≥1 frame yields DECODE_PREFIX_ONLY and a partial run', async () => {
  const inner = syntheticSource(10), source = faultySource(inner, { pass: 1, frameIndex: 4, kind: 'decode' });
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'partial');
  assertEquals(project.frames, 4);
  assert(diagnostics.some((d) => d.code === 'DECODE_PREFIX_ONLY'));
  assert(source.disposed);
});
Deno.test('engine F22: a decode-step failure on frame 0 rethrows (status error, no salvageable prefix)', async () => {
  const inner = syntheticSource(10), source = faultySource(inner, { pass: 1, frameIndex: 0, kind: 'decode' });
  const engine = makeEngine(new MemoryKV(), source, {});
  const project = await engine.run();
  assertEquals(project.status, 'error');
  assertEquals(project.frames, 0);
});
Deno.test('engine F22: a non-geometry, non-storage body failure yields ANALYSIS_PREFIX_ONLY, not DECODE_PREFIX_ONLY', async () => {
  const inner = syntheticSource(10), source = faultySource(inner, { pass: 1, frameIndex: 1, kind: 'corrupt' });
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'partial');
  assertEquals(project.frames, 1);
  assert(diagnostics.some((d) => d.code === 'ANALYSIS_PREFIX_ONLY'), JSON.stringify(diagnostics.map((d) => d.code)));
  assert(!diagnostics.some((d) => d.code === 'DECODE_PREFIX_ONLY'));
});
Deno.test('engine F22: a storage failure mid-scan yields PERSISTENCE_PREFIX_ONLY, marks partial, and does not retry writing', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  assert(scenario.frames.length > 24, 'scenario must be long enough to reach the 24-row pending batch inside scan()');
  // Only scan/scan-features rows fail; diagnostics, project and everything else keep working, so the failure is
  // unambiguously attributable to the scan-pending flush, not a coincidental diagnostics-journal failure.
  const flaky: KV = {
    get: (k) => db.get(k),
    put: (k, v) => db.put(k, v),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    putMany: (rows: Row[]) =>
      rows.some((r) => r.key.includes('/scan/') || r.key.includes('/scan-features/'))
        ? Promise.reject(new Error('disk quota exceeded'))
        : db.putMany(rows),
  };
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(flaky, source, {}, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'partial');
  assert(project.frames > 0 && project.frames < scenario.frames.length, String(project.frames));
  assert(diagnostics.some((d) => d.code === 'PERSISTENCE_PREFIX_ONLY'), JSON.stringify(diagnostics.map((d) => d.code)));
  assert(!diagnostics.some((d) => d.code === 'DECODE_PREFIX_ONLY' || d.code === 'ANALYSIS_PREFIX_ONLY'));
});
// F16: solve() and render() get the same decode-step/body-failure recovery shape as scan().
Deno.test('engine F16: a decode failure on solve()\'s pass (the SECOND frames() call) still lets render() run; one DECODE_PREFIX_ONLY names pass "solve"', async () => {
  const scenario = buildScenario('traversal'), inner = new ScenarioSource(scenario);
  const source = faultySource(inner, { pass: 2, frameIndex: 10, kind: 'decode' });
  const db = new MemoryKV();
  const engine = makeEngine(db, source, {});
  const project = await engine.run();
  assertEquals(project.status, 'partial');
  assert(project.renderedFrames > 0, 'render() must still have run on the geometry solve() managed to finish');
  assert(project.renderedFrames <= 10);
  const store = new Namespace(db, `run/${project.id}/`);
  let tiles = 0;
  for await (const _row of iterate(store, 'tile-index/')) tiles++;
  assert(tiles > 0, 'render() must have committed tiles for the solved prefix');
  const codes: Diagnostic[] = [];
  for await (const { value } of iterate<Diagnostic>(store, 'diagnostic/')) codes.push(value);
  const decodePrefix = codes.filter((d) => d.code === 'DECODE_PREFIX_ONLY');
  assertEquals(decodePrefix.length, 1);
  assertEquals((decodePrefix[0].detail as { pass?: string })?.pass, 'solve');
});
Deno.test('engine P0: a natural scan EOF before the declared frame count is partial and journaled', async () => {
  const inner = syntheticSource(6), source = truncatedSource(inner, { 1: 3 });
  const diagnostics: Diagnostic[] = [];
  const project = await makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  const mismatch = diagnostics.find((d) => d.code === 'PASS_FRAME_COUNT_MISMATCH');
  assert(mismatch, JSON.stringify(diagnostics.map((d) => d.code)));
  assertEquals(mismatch?.detail, { pass: 'scan', expected: 6, actual: 3 });
});
Deno.test('engine P0: a natural solve EOF does not silently render a short solved prefix', async () => {
  const inner = syntheticSource(6), source = truncatedSource(inner, { 2: 3 });
  const diagnostics: Diagnostic[] = [];
  const project = await makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  const mismatch = diagnostics.find((d) => d.code === 'PASS_FRAME_COUNT_MISMATCH');
  assert(mismatch, JSON.stringify(diagnostics.map((d) => d.code)));
  assertEquals(mismatch?.detail, { pass: 'solve', expected: 6, actual: 3 });
  assertEquals(project.renderedFrames, 3);
});
Deno.test('engine P0: explicitly skipped edit-list preroll is not a missing presentation frame', async () => {
  const source = syntheticSource(6), diagnostics: Diagnostic[] = [];
  source.info.frameCount = 7;
  source.info.notices = [{ code: 'NEGATIVE_TIMESTAMP_SKIPPED', message: 'Edit-list preroll.', count: 1 }];
  const project = await makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'complete');
  assertEquals(project.renderedFrames, 6);
  assert(!diagnostics.some((d) => d.code === 'PASS_FRAME_COUNT_MISMATCH'));
});
Deno.test('engine P0: a natural render EOF is partial even when every rendered plan exists', async () => {
  const inner = syntheticSource(6), source = truncatedSource(inner, { 3: 3 });
  const diagnostics: Diagnostic[] = [];
  const project = await makeEngine(new MemoryKV(), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  const mismatch = diagnostics.find((d) => d.code === 'PASS_FRAME_COUNT_MISMATCH');
  assert(mismatch, JSON.stringify(diagnostics.map((d) => d.code)));
  assertEquals(mismatch?.detail, { pass: 'render', expected: 6, actual: 3 });
  assertEquals(project.renderedFrames, 3);
});
Deno.test('engine P0: a missing scan record stops solve at the committed prefix with an explicit diagnostic', async () => {
  const db = new MemoryKV(), source = syntheticSource(6), diagnostics: Diagnostic[] = [];
  const project = await makeEngine(hideKey(db, `/scan/${pad(2)}`), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  assert(diagnostics.some((d) => d.code === 'MISSING_SCAN_RECORD'));
  assertEquals(project.renderedFrames, 2);
});
Deno.test('engine P0: a missing plan stops render at the committed prefix with an explicit diagnostic', async () => {
  const db = new MemoryKV(), source = syntheticSource(6), diagnostics: Diagnostic[] = [];
  const project = await makeEngine(hideKey(db, `/plan/${pad(2)}`), source, {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  assert(diagnostics.some((d) => d.code === 'MISSING_PLAN'));
  assertEquals(project.renderedFrames, 2);
});
Deno.test('engine P1: a failed final observation commit leaves the run partial instead of falsely complete', async () => {
  const db = new MemoryKV();
  const flaky: KV = {
    get: (key) => db.get(key),
    put: (key, value) => db.put(key, value),
    delete: (key) => db.delete(key),
    deleteMany: (keys) => db.deleteMany(keys),
    scan: (prefix, options) => db.scan(prefix, options),
    putMany: (rows) =>
      rows.some((row) => row.key.includes('/observation/')) ? Promise.reject(new Error('observation quota exceeded')) : db.putMany(rows),
  };
  const diagnostics: Diagnostic[] = [];
  const project = await makeEngine(flaky, syntheticSource(3), {}, (d) => diagnostics.push(d)).run();
  assertEquals(project.status, 'partial');
  assert(diagnostics.some((d) => d.code === 'PERSISTENCE_PREFIX_ONLY'));
  assertEquals((await db.scan(`run/${project.id}/observation/`, { limit: 10 })).length, 0);
});
Deno.test('engine raster consistency: rounds current and neighbour poses separately and ignores sticky neighbour occlusions', () => {
  const width = 48, height = 32;
  const image = (value: number): RGBA => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([value, value, value, 255], i);
    return { width, height, data };
  };
  const region = { id: 'body', name: 'body', kind: 'moving' as const, rect: { x: 0, y: 0, width, height } };
  const atlas = new RegionAtlas([region], width, height), code = atlas.code(region);
  try {
    const engine = makeEngine(new MemoryKV(), syntheticSource(1), {});
    const { factor, noise } = engine;
    const current = image(10), fractionalNeighbour = image(10);
    fractionalNeighbour.data[(10 * width + 11) * 4] = 255;
    fractionalNeighbour.data[(10 * width + 11) * 4 + 1] = 255;
    fractionalNeighbour.data[(10 * width + 11) * 4 + 2] = 255;
    const separatelyRounded = consistencyMask(
      current,
      atlas,
      region,
      code,
      { x: .49, y: 0 },
      'canvas',
      { prev: { image: fractionalNeighbour, x: -.49, y: 0, canvasId: 'canvas' }, factor, noise },
    ) as Uint8Array;
    assertEquals(separatelyRounded[10 * width + 10], 1, 'two poses rounding to the same raster origin must compare the same pixel');

    const changedNeighbour = image(10), pixel = (10 * width + 10) * 4;
    changedNeighbour.data[pixel] = changedNeighbour.data[pixel + 1] = changedNeighbour.data[pixel + 2] = 255;
    const withoutOcclusion = consistencyMask(
      current,
      atlas,
      region,
      code,
      { x: 0, y: 0 },
      'canvas',
      { prev: { image: changedNeighbour, x: 0, y: 0, canvasId: 'canvas' }, factor, noise },
    ) as Uint8Array;
    const withOcclusion = consistencyMask(
      current,
      atlas,
      region,
      code,
      { x: 0, y: 0 },
      'canvas',
      {
        prev: { image: changedNeighbour, x: 0, y: 0, canvasId: 'canvas', occlusions: [{ x: 10, y: 10, width: 1, height: 1 }] },
        factor,
        noise,
      },
    ) as Uint8Array;
    assertEquals(withoutOcclusion[pixel / 4], 0, 'an unmasked neighbour disagreement is inconsistent');
    assertEquals(withOcclusion[pixel / 4], 1, 'a sticky neighbour occlusion is not evidence against the current frame');
  } finally {
    atlas.dispose();
  }
});
Deno.test('engine integration: solve persists sticky occlusions and render carries them into observation decisions', async () => {
  const run = await runScenario(buildScenario('toolbar-collapse'), {});
  try {
    assertEquals(run.project.status, 'complete', run.project.error);
    let planned = 0, rendered = 0, plans = 0, observations = 0;
    for await (const { value } of iterate<FramePlan>(run.store, 'plan/')) {
      plans++;
      planned += value.placements.filter((placement) => placement.occlusions?.length).length;
    }
    for await (
      const { value } of iterate<{ decisions: { placement: FramePlan['placements'][number] }[] }>(run.store, 'observation/')
    ) {
      observations++;
      rendered += value.decisions.filter((decision) => decision.placement.occlusions?.length).length;
    }
    assertEquals(plans, run.project.frames, 'solve must persist one plan for every reconstructed frame');
    assertEquals(observations, run.project.renderedFrames, 'render must persist one observation ledger row per rendered frame');
    assert(planned > 0, 'the toolbar fixture must produce at least one sticky occlusion in solve()');
    assertEquals(rendered, planned, 'render must carry every solve-time sticky occlusion into its durable decision ledger');
    assert(run.codes.has('STICKY_OCCLUSION'), 'solve must journal the sticky-occlusion inference');
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
// F23: a frame-reference write failure is a warning, not a run failure (the scan-time preview thumbnail EngineEvents.preview
// carried is gone entirely — see src/pipeline/engine.ts's EngineEvents; it was unread by every caller).
Deno.test('engine F23: a frame-reference write failure is a warning (PRESENTATION_REFERENCE_FAILED), not a run failure; framing is then skipped', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const flaky: KV = {
    get: (k) => db.get(k),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    putMany: (r) => db.putMany(r),
    put: (k, v) => k.endsWith('frame-reference') ? Promise.reject(new Error('encode failed')) : db.put(k, v),
  };
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(flaky, source, { framing: 'context' }, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'complete', project.error);
  assert(diagnostics.some((d) => d.code === 'PRESENTATION_REFERENCE_FAILED'));
  const store = new Namespace(db, `run/${project.id}/`);
  let framed = 0;
  for await (const { value } of iterate<{ id: string }>(store, 'canvas/')) if (value.id.endsWith('-framed')) framed++;
  assertEquals(framed, 0, 'without a reference frame, buildFramedCanvas must not fabricate a framed canvas');
});
Deno.test('engine F23: a framing-stage failure is a warning (PRESENTATION_STAGE_FAILED) and never flips a finished core reconstruction to partial/error', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const flaky: KV = {
    get: (k) => db.get(k),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    putMany: (r) => db.putMany(r),
    put: (k, v) => /canvas\/.*-framed$/.test(k) ? Promise.reject(new Error('framing write failed')) : db.put(k, v),
  };
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(flaky, source, { framing: 'context' }, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'complete', project.error);
  assert(diagnostics.some((d) => d.code === 'PRESENTATION_STAGE_FAILED'), JSON.stringify(diagnostics.map((d) => d.code)));
});
Deno.test('engine F23: a pyramid-stage failure is a warning (PYRAMID_FAILED) and never flips a finished core reconstruction to partial/error', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const flaky: KV = {
    get: (k) => db.get(k),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    put: (k, v) => db.put(k, v),
    putMany: (rows: Row[]) =>
      rows.some((r) => r.key.includes('/1/')) ? Promise.reject(new Error('pyramid encode failed')) : db.putMany(rows),
  };
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(flaky, source, {}, (d) => diagnostics.push(d));
  const project = await engine.run();
  assertEquals(project.status, 'complete', project.error);
  assert(diagnostics.some((d) => d.code === 'PYRAMID_FAILED'), JSON.stringify(diagnostics.map((d) => d.code)));
});
// F24: stop is honoured during framing, not just scan/solve/render.
Deno.test('engine F24: a stop requested during the framing phase ends the run as partial', async () => {
  const scenario = buildScenario('traversal');
  const result = await runScenario(scenario, { framing: 'context' }, (engine) => {
    // deno-lint-ignore no-explicit-any
    const anyEngine = engine as any, original = anyEngine.events.progress.bind(anyEngine.events);
    anyEngine.events.progress = (p: Progress) => {
      if (p.phase === 'framing') engine.stopRequested = true;
      original(p);
    };
  });
  try {
    assertEquals(result.project.status, 'partial', result.project.error);
  } finally {
    // result.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    result.dispose();
  }
});
// F24 (graph.optimize path): a stop requested right as pose-graph relaxation begins unwinds via StopRequested,
// caught around graph.optimize() specifically, rather than crashing solve() or being silently ignored.
Deno.test('engine F24: a stop requested at the "optimizing" phase (graph.optimize) still ends the run as partial, with render still producing tiles', async () => {
  const scenario = buildScenario('revisit');
  const result = await runScenario(scenario, {}, (engine) => {
    // deno-lint-ignore no-explicit-any
    const anyEngine = engine as any, original = anyEngine.events.progress.bind(anyEngine.events);
    anyEngine.events.progress = (p: Progress) => {
      if (p.phase === 'optimizing') engine.stopRequested = true;
      original(p);
    };
  });
  try {
    assertEquals(result.project.status, 'partial', result.project.error);
    let tiles = 0;
    for await (const _row of iterate(result.store, 'tile-index/')) tiles++;
    assert(tiles > 0, 'render() must still have committed tiles for the solved prefix');
  } finally {
    // result.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    result.dispose();
  }
});
// E1: factor/refineRadius are computed lazily at the first decoded frame, from (possibly corrected) source geometry.
Deno.test('engine E1: factor is computed from the geometry the first decoded frame actually has, not the constructor-time provisional value', async () => {
  // Mimics source.ts's CONTAINER_SIZE_MISMATCH: info.width/height are wrong (and small: analysisFactor(50,50,100)
  // === 1) at construction time, and only become correct once frame 0 is decoded — the mutation happens before
  // that frame is yielded, exactly as CONTAINER_SIZE_MISMATCH does in source.ts. The corrected geometry is large
  // enough that its own factor differs (analysisFactor(400,300,100) === 4), so a stale provisional factor and a
  // correctly-recomputed one are numerically distinguishable, not just timing-distinguishable.
  const inner = syntheticSource(6, 50, 50);
  let correctedOnce = false;
  const source: FrameSource = {
    info: inner.info,
    dispose: () => inner.dispose(),
    async *frames() {
      for await (const frame of inner.frames()) {
        if (!correctedOnce) {
          inner.info.width = 400;
          inner.info.height = 300;
          correctedOnce = true;
        }
        yield frame.index === 0
          ? { ...frame, image: { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(255) } }
          : frame;
      }
    },
  };
  const engine = makeEngine(new MemoryKV(), source, { analysisSize: 100 });
  assertEquals(engine.factor, 1, 'the constructor-time provisional factor, from the wrong 50×50 metadata');
  const project = await engine.run();
  assert(project.status === 'complete' || project.status === 'partial', project.error);
  // Had the provisional value survived (the F-before bug), this would still read 1; recomputed from the corrected
  // 400×300 geometry at frame 0, it must read 4.
  assertEquals(engine.factor, 4);
});
// F25/F26: scan-time features live under scan-features/, and are deleted (with keyframe/word) once solve() is done.
Deno.test('engine F25: scan-features/, keyframe/ and word/ are all empty after a run completes', async () => {
  const result = await runScenario(buildScenario('revisit'));
  try {
    assertEquals(result.project.status, 'complete', result.project.error);
    for (const prefix of ['scan-features/', 'keyframe/', 'word/']) {
      const rows = await result.store.scan(prefix, { limit: 10 });
      assertEquals(rows.length, 0, `${prefix} must be empty after the run`);
    }
  } finally {
    // result.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    result.dispose();
  }
});
// F27: CanvasMeta is not put() once per placement per frame during render(); it is batched.
Deno.test('engine F27: render() does not write canvas/<id> once per placement per frame', async () => {
  const scenario = buildScenario('vertical'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  let canvasPuts = 0;
  const counting: KV = {
    get: (k) => db.get(k),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    put: (k, v) => {
      if (k.includes('/canvas/')) canvasPuts++;
      return db.put(k, v);
    },
    putMany: (rows: Row[]) => {
      canvasPuts += rows.filter((r) => r.key.includes('/canvas/')).length;
      return db.putMany(rows);
    },
  };
  const engine = makeEngine(counting, source, {});
  const project = await engine.run();
  assertEquals(project.status, 'complete', project.error);
  // Before F27, a single-layer scroll with 2 placements (moving + fixed) per frame wrote canvas/<id> twice per
  // frame; batched on the ~1.2s flush cadence, this run's canvas/ writes must land far below 2× its frame count.
  assert(
    canvasPuts < scenario.frames.length,
    `canvas/ writes ${canvasPuts} vs ${scenario.frames.length} frames — expected far fewer than one per frame`,
  );
});
// Diagnostics integrity: occurrences vs explicit count, and PROCESSING_ERROR is journaled.
Deno.test('engine: PROCESSING_ERROR is journaled (survives into diagnostic/ rows, not just the live event)', async () => {
  const inner = syntheticSource(3), source = faultySource(inner, { pass: 1, frameIndex: 0, kind: 'decode' });
  const db = new MemoryKV();
  const engine = makeEngine(db, source, {});
  const project = await engine.run();
  assertEquals(project.status, 'error');
  const store = new Namespace(db, `run/${project.id}/`);
  const codes = await codesOf(store);
  assert(codes.has('PROCESSING_ERROR'), [...codes].join(','));
});
// NONFINITE_POSE recovery: tracking now runs inside a single fused Rust call (core().trackOdometry, and later
// reacquire/driftCorrection), no longer individually visible/interceptable at the JS boundary a call-counting
// NaN-poison differential harness could monkeypatch, so this stubs the shell's own entry point directly and
// checks the shell's EXISTING recovery (region-step.ts's `!Number.isFinite(state.pose.x/.y)` guard, which runs
// before keyframeStep, pre-existing and unchanged by the Rust port) end to end: one diagnostic, a fresh
// fragment canvas, no non-finite coordinate reaches any persisted row, and the run still completes.
Deno.test('engine: a non-finite odometry delta is caught by NONFINITE_POSE, starts a new fragment canvas, and never persists a non-finite coordinate', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const c = core() as unknown as { trackOdometry(inputs: unknown): { decision: string; delta: { x: number; y: number } } };
  const original = c.trackOdometry.bind(c);
  let calls = 0;
  // Call 1: the region's first real odometry step (frame 1 — frame 0 founds the canvas via the 'start' gate and
  // never reaches trackOdometry), before any keyframe/anchor exists yet. Poisoning BOTH axes matters: driftCorrection
  // (the anchor re-measurement a later frame would run) recovers a poisoned axis whose true value happens to be 0,
  // because `js_round(NaN)` is 0 in Rust (`as i32` saturates NaN to 0, unlike `Math.round(NaN) === NaN` in the
  // historical TS) — silently "fixing" a single poisoned axis by coincidence in a straight vertical/horizontal
  // scroll. With no anchor yet, and both axes poisoned, there is nothing to recover through, so the pose stays
  // non-finite until the guard below catches it.
  const poisonAtCall = 1;
  let poisoned = false;
  c.trackOdometry = (inputs: unknown) => {
    calls++;
    const est = original(inputs);
    if (calls === poisonAtCall && est.decision === 'tracked') {
      poisoned = true;
      return { ...est, delta: { x: NaN, y: NaN } };
    }
    return est;
  };
  try {
    const diagnostics: Diagnostic[] = [];
    const engine = makeEngine(db, source, {}, (d) => diagnostics.push(d));
    const project = await engine.run();
    assert(poisoned, 'the stub never saw a tracked decision to poison — widen poisonAtCall or the scenario');
    await assertRecoversFromNonfinitePose(db, project, diagnostics);
  } finally {
    c.trackOdometry = original;
  }
});
/** Regression coverage for `isValidPose`'s `POSE_BOUND` check (track.ts), reusing the same odometry-delta
 * injection point and shared assertion as the NaN test above: `+Infinity` and `-Infinity` were already caught
 * at the pre-existing `Number.isFinite` guard (confirmed against a136135 — this is not a new failure mode for
 * those two), but `1e12` is finite and was NOT: it would have sailed through untouched. These three prove the
 * SAME guard now rejects all three uniformly, before `state.pose` can ever reach compositor.ts. This is NOT the
 * OOM reproduction (a `1e12` pose here never exhausted memory — `Compositor.add()`'s tile loop is sized from
 * the placement's rect width/height, not from its distance to the origin); see the `engine render:` test below
 * for the actual OOM repro (a plan/ row read back with `x`/`y` = `Infinity`, which solve.ts's own validation
 * cannot reach because it never runs on that row again). */
for (const [label, value] of [['+Infinity', Infinity], ['-Infinity', -Infinity], ['a huge finite offset (1e12)', 1e12]] as const) {
  Deno.test(`engine: an odometry delta of ${label} is caught by NONFINITE_POSE (out-of-range, not just non-finite) and never persists`, async () => {
    const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
    const c = core() as unknown as { trackOdometry(inputs: unknown): { decision: string; delta: { x: number; y: number } } };
    const original = c.trackOdometry.bind(c);
    let calls = 0, poisoned = false;
    c.trackOdometry = (inputs: unknown) => {
      calls++;
      const est = original(inputs);
      if (calls === 1 && est.decision === 'tracked') {
        poisoned = true;
        return { ...est, delta: { x: value, y: value } };
      }
      return est;
    };
    try {
      const diagnostics: Diagnostic[] = [];
      const engine = makeEngine(db, source, {}, (d) => diagnostics.push(d));
      const project = await engine.run();
      assert(poisoned, 'the stub never saw a tracked decision to poison — widen the scenario');
      await assertRecoversFromNonfinitePose(db, project, diagnostics);
    } finally {
      c.trackOdometry = original;
    }
  });
}
/** Shared assertions for the "a fused tracker call produces an invalid pose" tests (odometry NaN/±Infinity/1e12,
 * driftCorrection NaN): region-step.ts's `isValidPose(state.pose)` guard fires exactly once, with a finite
 * frame/time; no persisted plan/observation row carries a non-finite coordinate; the run still completes; and
 * the poisoned region gets a fresh fragment canvas (more than one distinct canvasId across the run's
 * placements). */
async function assertRecoversFromNonfinitePose(
  db: MemoryKV,
  project: { id: string; status: string; error?: string },
  diagnostics: Diagnostic[],
): Promise<void> {
  assertEquals(project.status, 'complete', project.error);
  const nonfinite = diagnostics.filter((d) => d.code === 'NONFINITE_POSE');
  assertEquals(nonfinite.length, 1, JSON.stringify(diagnostics.map((d) => d.code)));
  assert(Number.isFinite(nonfinite[0].frame) && Number.isFinite(nonfinite[0].time), JSON.stringify(nonfinite[0]));
  const store = new Namespace(db, `run/${project.id}/`);
  let planRows = 0, observationRows = 0;
  const canvasIds = new Set<string>();
  for await (const { value } of iterate<FramePlan>(store, 'plan/')) {
    planRows++;
    for (const p of value.placements) {
      assert(Number.isFinite(p.x) && Number.isFinite(p.y), `non-finite placement in plan/: ${JSON.stringify(p)}`);
      canvasIds.add(p.canvasId);
    }
  }
  for await (const { value } of iterate<{ decisions: { placement: { x: number; y: number } }[] }>(store, 'observation/')) {
    observationRows++;
    for (const d of value.decisions) {
      assert(
        Number.isFinite(d.placement.x) && Number.isFinite(d.placement.y),
        `non-finite placement in observation/: ${JSON.stringify(d.placement)}`,
      );
    }
  }
  assert(planRows > 0 && observationRows > 0, 'the run must actually have persisted plan/observation rows to check');
  // The recovery starts a fresh canvas for the poisoned region (state.fragment++ → a new canvasId), so more than
  // one distinct canvasId must appear across the run's placements for a single-layer scenario (normally one
  // continuous canvas per moving region).
  assert(canvasIds.size > 1, `expected a new fragment canvas after NONFINITE_POSE, got canvasIds=${[...canvasIds]}`);
}
// The same NONFINITE_POSE recovery, via a poisoned core().trackDriftCorrection instead. driftCorrection
// has no gate (region-step.ts always calls it once an anchor exists and the field difference clears .12), so the
// first call it makes is poisoned; a corrected (truthy) result's pose is what feeds state.pose, so only a
// poisoned TRUTHY result propagates — matching driftCorrection's own "undefined means no correction" contract.
Deno.test('engine: a non-finite driftCorrection pose is caught by NONFINITE_POSE, starts a new fragment canvas, and never persists a non-finite coordinate', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const c = core() as unknown as {
    trackDriftCorrection(inputs: unknown): { pose: { x: number; y: number } | undefined; error: number; filledNative: boolean };
  };
  const original = c.trackDriftCorrection.bind(c);
  let calls = 0, poisoned = false;
  c.trackDriftCorrection = (inputs: unknown) => {
    calls++;
    const est = original(inputs);
    if (calls === 1 && est.pose) {
      poisoned = true;
      return { ...est, pose: { x: NaN, y: NaN } };
    }
    return est;
  };
  try {
    const diagnostics: Diagnostic[] = [];
    const engine = makeEngine(db, source, {}, (d) => diagnostics.push(d));
    const project = await engine.run();
    assert(poisoned, 'the stub never saw a corrected pose to poison — widen the call index or the scenario');
    await assertRecoversFromNonfinitePose(db, project, diagnostics);
  } finally {
    c.trackDriftCorrection = original;
  }
});
/** Walks every value ever put() into `db` (structuredClone snapshots, so this also covers rows later
 * overwritten/deleted only in the sense that MemoryKV.data reflects the CURRENT persisted state — good enough
 * here since the assertion is "nothing non-finite is ever left behind", not a history check) and fails on the
 * first non-finite number found anywhere in the JSON tree: node/, edge/, keyframe/, attach/, canvas/, plan/ and
 * observation/ rows alike, not just the placement fields the NONFINITE_POSE tests above happen to check. */
function assertNoNonfiniteAnywhere(db: MemoryKV): void {
  const bad: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad.push(path);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  for (const [key, value] of db.data) walk(value, key);
  assert(bad.length === 0, `non-finite number(s) reached persisted rows: ${bad.join(', ')}`);
}
// Keyframe-step candidates (attachment, thin-overlap correction) are validated and rejected BEFORE they can move
// state.pose or be persisted — unlike the odometry/driftCorrection sources above, a rejected candidate here must
// NOT raise NONFINITE_POSE (nothing was ever assigned to isolate) and must not raise the diagnostic that
// normally announces a successful candidate (FRAGMENT_ATTACHED), matching attachVerdict()'s own "no verdict"
// contract on any other kind of failure.
Deno.test('engine: a non-finite attachment verdict is rejected before it can move state.pose or persist', async () => {
  const scenario = buildScenario('revisit'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const c = core() as unknown as {
    trackAttachVerdict(global: unknown, resolvedTargetEqCanvas: boolean, shift: unknown): { x: number; y: number } | undefined;
  };
  const original = c.trackAttachVerdict.bind(c);
  let poisoned = false;
  // Poisons the first call keyframe-step.ts actually makes (i.e. the first frame with a revisit match) rather
  // than waiting for a real attachment to occur (self-canvas revisits — the common case in a single-layer
  // scenario — never produce one): this is fault injection on the defensive check itself, not a reproduction of
  // an organic attachment.
  c.trackAttachVerdict = (global, eq, shift) => {
    if (!poisoned) {
      poisoned = true;
      return { x: Infinity, y: -Infinity };
    }
    return original(global, eq, shift);
  };
  try {
    const diagnostics: Diagnostic[] = [];
    const engine = makeEngine(db, source, {}, (d) => diagnostics.push(d));
    const project = await engine.run();
    assert(poisoned, 'the stub never saw a revisit match to poison — widen the scenario');
    assertEquals(project.status, 'complete', project.error);
    assertEquals(diagnostics.filter((d) => d.code === 'NONFINITE_POSE').length, 0, 'a rejected candidate must not isolate a fragment');
    assertEquals(diagnostics.filter((d) => d.code === 'FRAGMENT_ATTACHED').length, 0, 'the poisoned verdict must not be applied');
    assertNoNonfiniteAnywhere(db);
  } finally {
    c.trackAttachVerdict = original;
  }
});
Deno.test('engine: a non-finite thin-overlap correction is rejected before it can move state.pose or persist', async () => {
  const scenario = buildScenario('revisit'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  const c = core() as unknown as {
    trackThinOverlapEligible(weakStep: boolean, weak: boolean, ambiguous: boolean, confidence: number, error: number): boolean;
    trackThinOverlapCorrection(
      canonicalKeyframe: unknown,
      offset: unknown,
      pose: unknown,
    ): { target: { x: number; y: number }; discrepancy: number } | undefined;
  };
  const originalEligible = c.trackThinOverlapEligible.bind(c);
  const original = c.trackThinOverlapCorrection.bind(c);
  let poisoned = false;
  // The eligibility gate (weakStep/weak, unambiguous, confidence > .72, error < 8) is a narrow real-world
  // window; force it open so the fault-injected correction below actually gets a call to poison, the same way
  // the other tests in this file force their own gate open rather than searching for a scenario that clears it
  // by chance.
  c.trackThinOverlapEligible = () => true;
  c.trackThinOverlapCorrection = (canonicalKeyframe, offset, pose) => {
    if (!poisoned) {
      poisoned = true;
      return { target: { x: 1e12, y: 0 }, discrepancy: 0 };
    }
    return original(canonicalKeyframe, offset, pose);
  };
  try {
    const diagnostics: Diagnostic[] = [];
    const engine = makeEngine(db, source, {}, (d) => diagnostics.push(d));
    const project = await engine.run();
    assert(poisoned, 'the stub never saw a defined revisit match to poison — widen the scenario');
    assertEquals(project.status, 'complete', project.error);
    assertEquals(diagnostics.filter((d) => d.code === 'NONFINITE_POSE').length, 0, 'a rejected candidate must not isolate a fragment');
    assertEquals(diagnostics.filter((d) => d.code === 'TRAJECTORY_CORRECTED').length, 0, 'the poisoned correction must not be applied');
    assertNoNonfiniteAnywhere(db);
  } finally {
    c.trackThinOverlapEligible = originalEligible;
    c.trackThinOverlapCorrection = original;
  }
});
// render.ts's own isValidPose() guard, over a plan/ row read back from storage rather than one this same run's
// solve pass just wrote in-process (a foreign writer, bit rot, a future engine version — or simply a row solve.ts
// validated correctly at write time that is then read back unvalidated, which is exactly what happened here: at
// a136135, poisoning a plan/ row's x to Infinity this same way — confirmed manually with
// `deno run -A --v8-flags=--max-old-space-size=512` — reproduces "Fatal JavaScript out of memory" inside
// Compositor.add()'s tile-index loop, which is sized directly from the placement's x/y with no upper bound.
// That loop is unreachable from a poisoned ODOMETRY delta (region-step.ts's pre-existing `Number.isFinite`
// check already caught ±Infinity there, and a finite 1e12 offset never grows the loop's range at all — see the
// comment above the odometry-delta tests above); this is the one path that actually needs render's own check.
// Poison one moving placement's x on its way out of storage (KV.get, not the tracker) to exercise it.
Deno.test('engine render: a plan/ placement read back with an out-of-range pose is skipped by render before compositing, not persisted', async () => {
  const scenario = buildScenario('vertical'), db = new MemoryKV();
  let poisoned = false;
  const poisoning: KV = {
    put: (k, v) => db.put(k, v),
    delete: (k) => db.delete(k),
    deleteMany: (k) => db.deleteMany(k),
    scan: (p, o) => db.scan(p, o),
    putMany: (r) => db.putMany(r),
    get: async <T>(key: string) => {
      const value = await db.get<T>(key);
      if (!poisoned && key.includes('/plan/') && value && typeof value === 'object' && 'placements' in value) {
        const plan = value as unknown as FramePlan;
        const moving = plan.placements.find((p) => !p.skip);
        if (moving) {
          poisoned = true;
          return { ...plan, placements: plan.placements.map((p) => p === moving ? { ...p, x: Infinity } : p) } as unknown as T;
        }
      }
      return value;
    },
  };
  const source = new ScenarioSource(scenario);
  const diagnostics: Diagnostic[] = [];
  const engine = makeEngine(poisoning, source, {}, (d) => diagnostics.push(d));
  const project = await engine.run();
  assert(poisoned, 'the stub never saw a moving plan/ placement to poison');
  assertEquals(project.status, 'complete', project.error);
  assertEquals(diagnostics.filter((d) => d.code === 'NONFINITE_POSE').length, 1, JSON.stringify(diagnostics.map((d) => d.code)));
  const store = new Namespace(db, `run/${project.id}/`);
  for await (const { value } of iterate<{ decisions: { placement: { x: number; y: number } }[] }>(store, 'observation/')) {
    for (const d of value.decisions) {
      assert(
        Number.isFinite(d.placement.x) && Number.isFinite(d.placement.y),
        `non-finite placement in observation/: ${JSON.stringify(d)}`,
      );
    }
  }
});
// Project history index (coordinate with the UI worker's 'projects'/'delete' commands).
Deno.test('engine: persist() writes a project-index/<created>/<id> row on the first persist, once', async () => {
  const db = new MemoryKV(), source = syntheticSource(2);
  const engine = makeEngine(db, source, {});
  const project = await engine.run();
  const rows = await db.scan<string>(`project-index/${project.created}/`, { limit: 10 });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].key, `project-index/${project.created}/${project.id}`);
  assertEquals(rows[0].value, project.id);
});
