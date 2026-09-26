import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { runScenario, verifyCanvasAccounting } from '../support/run.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { iterate } from '../../src/storage/db.ts';

// End-to-end failure contracts: final canonical coordinates, native alternative/provenance persistence,
// one extra sequential decode, exact tile accounting after replacement, and no work after an honoured stop.
Deno.test('deferred sources: floating replay persists alternatives and native provenance at final poses', async () => {
  const scenario = buildScenario('floating');
  const result = await runScenario(scenario, scenario.settings);
  try {
    assertEquals(result.project.status, 'complete');
    const summary = await result.store.get<{ replayPasses: number; candidates: number; resolvedBlocks: number }>('source-summary');
    assert(summary);
    assertEquals(summary.replayPasses, 1);
    assert(summary.candidates > 0 && summary.resolvedBlocks > 0);
    let provenance = 0;
    for await (const _ of iterate(result.store, 'source-provenance/')) provenance++;
    assert(provenance > 0);
    for (const prefix of ['source-analysis/', 'source-options/', 'source-blocks/']) {
      assertEquals((await result.store.scan(prefix)).length, 0, 'committed source shards must release recomputable scratch rows');
    }
    for (const canvas of result.canvases.filter((c) => c.kind !== 'presentation')) {
      const accounting = await verifyCanvasAccounting(result, canvas);
      assert(accounting.tileCountOk && accounting.observedPixelsOk, JSON.stringify(accounting));
    }
    await Deno.mkdir('test-results/full-scheme', { recursive: true });
    const truth = await verifyLayer(result, scenario.layers[0]);
    assertEquals(truth.contaminatedOverlayRecoverable, 0);
    assertEquals(truth.contaminatedOverlay, 0);
    await Deno.writeTextFile(
      'test-results/full-scheme/floating-source-summary.json',
      JSON.stringify(
        {
          ...summary,
          groundTruth: {
            missing: truth.missing,
            invented: truth.invented,
            mismatched: truth.mismatched,
            contaminatedOverlay: truth.contaminatedOverlay,
            recoverableOverlay: truth.contaminatedOverlayRecoverable,
            provisionalPixels: truth.mainCanvas.provisionalPixels,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    result.dispose();
  }
});

import { SOURCE_CASES, sourceCase } from '../support/source-cases.ts';
import { verifyLayer } from '../support/run.ts';
for (const name of SOURCE_CASES) {
  Deno.test(`deferred sources: native image counterexample ${name}`, async () => {
    const scenario = sourceCase(name), result = await runScenario(scenario, scenario.settings);
    try {
      assertEquals(result.project.status, 'complete', result.project.error);
      const truth = await verifyLayer(result, scenario.layers[0]);
      const report = {
        name,
        maxError: truth.maxError,
        missing: truth.missing,
        invented: truth.invented,
        mismatched: truth.mismatched,
        recoverableOverlay: truth.contaminatedOverlayRecoverable,
        unobservableOverlay: truth.contaminatedOverlayUnobservable,
        summary: await result.store.get('source-summary'),
      };
      await Deno.mkdir('test-results/full-scheme', { recursive: true });
      await Deno.writeTextFile(`test-results/full-scheme/${name}.json`, JSON.stringify(report, null, 2));
      assertEquals(truth.maxError, 0, 'registration must match independent truth');
      assertEquals(truth.missing, 0, 'clean observed content must remain');
      assertEquals(truth.invented, 0, 'no pixels outside observed page');
      assertEquals(truth.mismatched, 0, 'every output is an actual native observation');
      assertEquals(truth.contaminatedOverlayRecoverable, 0, 'every recoverable overlay pixel must use clean content');
    } finally {
      result.dispose();
    }
  });
}

import { Engine } from '../../src/pipeline/engine.ts';
import { DEFAULT_SETTINGS } from '../../src/types.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
Deno.test('deferred sources: stopping the ordered replay retains the committed render and skips presentation', async () => {
  const scenario = sourceCase('once-clean');
  let passes = 0;
  class StoppableSource extends ScenarioSource {
    override async *frames() {
      const pass = ++passes;
      for await (const frame of super.frames()) {
        if (pass === 4 && frame.index === 5) engine.stop();
        yield frame;
      }
    }
  }
  const engine = new Engine(new MemoryKV(), new StoppableSource(scenario), { ...DEFAULT_SETTINGS, ...scenario.settings }, {
    progress: () => {},
    diagnostic: () => {},
    project: () => {},
  });
  const project = await engine.run();
  assertEquals(passes, 4);
  assertEquals(project.status, 'partial');
  assertEquals(project.renderedFrames, scenario.frames.length);
  const summary = await engine.store.get<{ frames: number }>('source-summary');
  assertEquals(summary?.frames, 5);
  for await (const { value: canvas } of iterate<import('../../src/types.ts').CanvasMeta>(engine.store, 'canvas/')) {
    assert(canvas.kind !== 'presentation');
    assertEquals(canvas.maxLevel, 0);
  }
});

import { exportProject } from '../../src/export/project.ts';
import { unzipSync } from 'fflate';
Deno.test('deferred sources: export contains inspectable native alternatives, provenance and component epochs', async () => {
  const scenario = sourceCase('once-clean'), result = await runScenario(scenario, scenario.settings);
  try {
    const exported = await exportProject(result.store, result.project, () => {});
    assert(exported.blob);
    const entries = unzipSync(new Uint8Array(await exported.blob.arrayBuffer()));
    const names = Object.keys(entries);
    assert(names.some((k) => k.startsWith('sources/alternatives/') && k.endsWith('.png')));
    assert(names.some((k) => k.startsWith('sources/source-provenance/') && k.endsWith('.json')));
    const sidecar = names.find((k) => k.startsWith('sources/alternatives/') && k.endsWith('.json'))!;
    const metadata = JSON.parse(new TextDecoder().decode(entries[sidecar]));
    assert(metadata.patches.length > 0);
    assert(
      metadata.patches.every((p: { frame: number; poseX: number; poseY: number }) =>
        Number.isInteger(p.frame) && Number.isInteger(p.poseX) && Number.isInteger(p.poseY)
      ),
    );
    await Deno.writeFile('test-results/full-scheme/once-clean-project.zip', new Uint8Array(await exported.blob.arrayBuffer()));
  } finally {
    result.dispose();
  }
});

import { dynamicSourceCase } from '../support/source-cases.ts';
for (const partial of [false, true]) {
  Deno.test(`deferred sources: Engine dynamic component ${partial ? 'without a complete epoch' : '110/101/011'}`, async () => {
    const scenario = dynamicSourceCase(partial), result = await runScenario(scenario, scenario.settings);
    try {
      assertEquals(result.project.status, 'complete', result.project.error);
      const regions = await verifyLayer(result, scenario.layers[0]);
      assertEquals(regions.maxError, 0);
      const components = [];
      for await (const { value } of iterate<{ epoch: { frame: number; complete: boolean } }>(result.store, 'source-component/')) {
        components.push(value);
      }
      await Deno.writeTextFile(
        `test-results/full-scheme/dynamic-${partial ? 'partial' : 'epochs'}.json`,
        JSON.stringify({ components, summary: await result.store.get('source-summary') }, null, 2),
      );
      assert(components.length > 0, 'the changing page component must reach deferred epoch selection');
      if (partial) assert(components.some((c) => !c.epoch.complete), 'absence of a complete visible state must remain explicit');
      else {
        const first = result.observations[0].decisions.find((d) =>
          d.placement.layer === result.regions.find((r) => r.kind === 'moving')!.id
        )!.placement;
        const colours = [];
        for (let i = 0; i < 3; i++) {
          const x = 80 + i * 16 + 8 + first.x, y = 184 - 100 + 16 + first.y;
          const tile = await result.engine.tiles.get(first.canvasId, Math.floor(x / result.tileSize), Math.floor(y / result.tileSize));
          const at = ((y % result.tileSize) * result.tileSize + x % result.tileSize) * 4;
          colours.push(tile.pixels[at] > 100 ? 1 : 0);
        }
        assert(['110', '101', '011'].includes(colours.join('')), `unobserved component state ${colours.join('')}`);
      }
    } finally {
      result.dispose();
    }
  });
}

import { unpinSourceCase } from '../support/source-cases.ts';
Deno.test('deferred sources: automatically learned header releases into the page without losing newly exposed rows', async () => {
  const scenario = unpinSourceCase(), result = await runScenario(scenario, scenario.settings);
  try {
    assertEquals(result.project.status, 'complete', result.project.error);
    const truth = await verifyLayer(result, scenario.layers[0]);
    // Check the formerly pinned band against independent world pixels, without filtering through
    // the learned atlas (which would hide a mistaken permanent fixed-band assignment).
    const first = result.observations[0].decisions.find((d) => d.canvasId === truth.mainCanvas.id);
    const origin = first?.placement ?? result.observations[0].decisions.find((d) => !d.skipped)!.placement;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < scenario.width; x++) {
        const wx = x + origin.x, wy = y + origin.y - scenario.layers[0].path[0].y;
        const tx = Math.floor(wx / result.tileSize), ty = Math.floor(wy / result.tileSize);
        const tile = await result.engine.tiles.get(truth.mainCanvas.id, tx, ty);
        const i = (wy - ty * result.tileSize) * result.tileSize + wx - tx * result.tileSize;
        assert((tile.coverage[i >> 3] & (1 << (i & 7))) !== 0, `released page pixel missing at ${x},${y}`);
        const expected = scenario.layers[0].world.data.slice((y * scenario.width + x) * 4, (y * scenario.width + x) * 4 + 4);
        assertEquals(tile.pixels.slice(i * 4, i * 4 + 4), expected);
      }
    }

    const report = {
      regions: result.regions.map(({ mask, ...r }) => ({ ...r, maskBytes: mask?.length })),
      maxError: truth.maxError,
      missing: truth.missing,
      invented: truth.invented,
      mismatched: truth.mismatched,
      recoverableOverlay: truth.contaminatedOverlayRecoverable,
      summary: await result.store.get('source-summary'),
    };
    await Deno.writeTextFile('test-results/full-scheme/unpin.json', JSON.stringify(report, null, 2));
    assertEquals(truth.maxError, 0);
    assertEquals(truth.missing, 0);
    assertEquals(truth.invented, 0);
    assertEquals(truth.mismatched, 0);
    assertEquals(truth.contaminatedOverlayRecoverable, 0);
  } finally {
    result.dispose();
  }
});

import { independentSourceCase } from '../support/source-cases.ts';
Deno.test('deferred sources: a pointer crosses panes whose page motions are independent', async () => {
  const scenario = independentSourceCase(), result = await runScenario(scenario, scenario.settings);
  try {
    assertEquals(result.project.status, 'complete', result.project.error);
    const reports = [];
    for (const layer of scenario.layers) {
      const truth = await verifyLayer(result, layer);
      reports.push({
        layer: layer.id,
        maxError: truth.maxError,
        missing: truth.missing,
        invented: truth.invented,
        mismatched: truth.mismatched,
        recoverableOverlay: truth.contaminatedOverlayRecoverable,
      });
      assertEquals(truth.maxError, 0);
      assertEquals(truth.missing, 0);
      assertEquals(truth.invented, 0);
      assertEquals(truth.mismatched, 0);
      assertEquals(truth.contaminatedOverlayRecoverable, 0);
    }
    await Deno.writeTextFile(
      'test-results/full-scheme/independent-panes.json',
      JSON.stringify({ reports, summary: await result.store.get('source-summary') }, null, 2),
    );
  } finally {
    result.dispose();
  }
});

import type { FrameImage, Placement } from '../../src/types.ts';
import { renderFrame } from '../../src/synthetic/world.ts';
Deno.test('deferred sources: codec noise and raster phase preserve observed coverage and exact native provenance', async () => {
  const scenario = sourceCase('no-boundary-header');
  scenario.overlays = [];
  scenario.name = 'source-raster-phase';
  const native = (index: number) => {
    const image = renderFrame(scenario, index).image, raw = image.data.slice(), soft = Math.floor(index / 4) % 2 === 1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const at = (y * image.width + x) * 4, next = (Math.min(image.height - 1, y + 1) * image.width + x) * 4;
        const noise = (x * 17 + y * 29 + index * 31) % 5 - 2;
        for (let c = 0; c < 3; c++) image.data[at + c] = Math.round(soft ? (raw[at + c] + raw[next + c]) / 2 : raw[at + c]) + noise;
      }
    }
    return image;
  };
  class PhaseSource extends ScenarioSource {
    constructor() {
      super(scenario);
      this.info.noise = 10;
    }
    override async *frames(): AsyncGenerator<FrameImage> {
      for (let index = 0; index < scenario.frames.length; index++) {
        const f = scenario.frames[index];
        yield { index, time: f.time, duration: f.duration, image: native(index) };
      }
    }
  }
  const diagnostics: string[] = [];
  const engine = new Engine(new MemoryKV(), new PhaseSource(), { ...DEFAULT_SETTINGS, ...scenario.settings }, {
    progress: () => {},
    diagnostic: (d) => diagnostics.push(d.code),
    project: () => {},
  });
  const project = await engine.run();
  assertEquals(project.status, 'complete', project.error);
  const ledgers = new Map<number, { canvasId: string; placement: Placement; skipped?: boolean }[]>();
  const expected = new Map<string, Set<string>>();
  for await (
    const { value: row } of iterate<{ frame: number; decisions: { canvasId: string; placement: Placement; skipped?: boolean }[] }>(
      engine.store,
      'observation/',
    )
  ) {
    ledgers.set(row.frame, row.decisions);
    for (const d of row.decisions) {
      if (d.skipped || d.placement.skip) continue;
      const set = expected.get(d.canvasId) ?? new Set<string>();
      expected.set(d.canvasId, set);
      for (let y = 0; y < scenario.height; y++) {
        for (let x = 0; x < scenario.width; x++) set.add(`${x + Math.round(d.placement.x)},${y + Math.round(d.placement.y)}`);
      }
    }
  }
  let missing = 0, misattributed = 0, checked = 0;
  for (const [canvas, points] of expected) {
    for (const point of points) {
      const [x, y] = point.split(',').map(Number),
        tile = await engine.tiles.get(canvas, Math.floor(x / engine.tiles.size), Math.floor(y / engine.tiles.size));
      const at = ((y % engine.tiles.size + engine.tiles.size) % engine.tiles.size) * engine.tiles.size +
        (x % engine.tiles.size + engine.tiles.size) % engine.tiles.size;
      if (!(tile.coverage[at >> 3] & (1 << (at & 7)))) missing++;
    }
  }
  const frames = new Map<number, ReturnType<typeof native>>();
  for await (
    const { value: row } of iterate<
      { canvasId: string; size: number; x: number; y: number; blocks: { block: number; frames: Uint32Array; reasons: Uint8Array }[] }
    >(engine.store, 'source-provenance/')
  ) {
    for (const b of row.blocks) {
      for (let at = 0; at < 256; at++) {
        const frame = b.frames[at];
        if (frame === 0xffffffff) continue;
        const d = ledgers.get(frame)!.find((d) => d.canvasId === row.canvasId)!;
        const x = row.x * row.size + (b.block % 16) * 16 + at % 16,
          y = row.y * row.size + Math.floor(b.block / 16) * 16 + Math.floor(at / 16);
        const sx = x - Math.round(d.placement.x), sy = y - Math.round(d.placement.y);
        let image = frames.get(frame);
        if (!image) {
          image = native(frame);
          frames.set(frame, image);
        }
        const tile = await engine.tiles.get(row.canvasId, Math.floor(x / engine.tiles.size), Math.floor(y / engine.tiles.size));
        const out = (((y % engine.tiles.size + engine.tiles.size) % engine.tiles.size) * engine.tiles.size +
          (x % engine.tiles.size + engine.tiles.size) % engine.tiles.size) * 4;
        const src = (sy * scenario.width + sx) * 4;
        checked++;
        if (
          sx < 0 || sy < 0 || sx >= scenario.width || sy >= scenario.height ||
          [0, 1, 2, 3].some((c) => tile.pixels[out + c] !== image.data[src + c])
        ) misattributed++;
      }
    }
  }
  const components = [];
  for await (const { value } of iterate(engine.store, 'source-component/')) components.push(value);
  const report = { missing, misattributed, checked, diagnostics, components, summary: await engine.store.get('source-summary') };
  await Deno.writeTextFile('test-results/full-scheme/raster-phase.json', JSON.stringify(report, null, 2));
  assert(checked > 0);
  assertEquals(misattributed, 0);
  assertEquals(missing, 0, 'raster variation must not erase observed static content');
  assert(!diagnostics.includes('SOURCE_DYNAMIC_PARTIAL'), 'raster phase is not a partially visible content version');
});

import type { Row } from '../../src/storage/db.ts';
import { countCovered, type StoredTile } from '../../src/storage/tiles.ts';
Deno.test('deferred sources: a failed pixel/provenance commit retains a recoverable consistent print', async () => {
  class SourceFailure extends MemoryKV {
    failed = false;
    override async put(key: string, value: unknown): Promise<void> {
      if (!this.failed && key.includes('/source-provenance/')) {
        this.failed = true;
        throw new Error('injected source commit failure');
      }
      await super.put(key, value);
    }
    override async putMany(rows: Row[]): Promise<void> {
      // Real IndexedDB aborts the entire transaction. Inject before any row, reproducing that contract.
      if (!this.failed && rows.some((r) => r.key.includes('/source-provenance/'))) {
        this.failed = true;
        throw new Error('injected source commit failure');
      }
      await super.putMany(rows);
    }
  }
  const scenario = sourceCase('once-clean'), db = new SourceFailure(), codes: string[] = [];
  const engine = new Engine(db, new ScenarioSource(scenario), { ...DEFAULT_SETTINGS, ...scenario.settings }, {
    progress: () => {},
    diagnostic: (d) => codes.push(d.code),
    project: () => {},
  });
  const project = await engine.run();
  assert(db.failed);
  assertEquals(project.status, 'partial');
  assert(codes.includes('PERSISTENCE_ERROR'), 'a source transaction failure is a storage failure');
  for await (const { value: canvas } of iterate<import('../../src/types.ts').CanvasMeta>(engine.store, 'canvas/')) {
    if (canvas.kind === 'presentation') continue;
    let provisional = 0, covered = 0;
    for await (const { value: tile } of iterate<StoredTile>(engine.store, `tile/${canvas.id}/0/`)) {
      provisional += countCovered(tile.provisional ?? new Uint8Array());
      covered += countCovered(tile.coverage);
    }
    assertEquals(canvas.provisionalPixels, provisional);
    assertEquals(canvas.observedPixels, covered);
  }
  const summary = await engine.store.get<{ completed: boolean; stage: string }>('source-summary');
  assert(summary && !summary.completed);
  const exported = await exportProject(engine.store, project, () => {});
  assert(exported.blob);
  const names = Object.keys(unzipSync(new Uint8Array(await exported.blob.arrayBuffer())));
  assert(names.some((n) => n.startsWith('sources/alternatives/')), 'already committed native alternatives survive recovery/export');
});
Deno.test('deferred sources: stopping materialization commits pixels and their metadata together', async () => {
  let stop: () => void = () => {};
  class StopAfterChunk extends MemoryKV {
    signalled = false;
    override async putMany(rows: Row[]): Promise<void> {
      await super.putMany(rows);
      if (!this.signalled && rows.some((r) => r.key.includes('/source-provenance/'))) {
        this.signalled = true;
        stop();
      }
    }
    override async put(key: string, value: unknown): Promise<void> {
      await super.put(key, value);
      if (!this.signalled && key.includes('/source-provenance/')) {
        this.signalled = true;
        stop();
      }
    }
  }
  const scenario = sourceCase('once-clean'), db = new StopAfterChunk();
  const engine = new Engine(db, new ScenarioSource(scenario), { ...DEFAULT_SETTINGS, ...scenario.settings }, {
    progress: () => {},
    diagnostic: () => {},
    project: () => {},
  });
  stop = () => engine.stop();
  const project = await engine.run();
  assert(db.signalled);
  assertEquals(project.status, 'partial');
  for await (const { value: canvas } of iterate<import('../../src/types.ts').CanvasMeta>(engine.store, 'canvas/')) {
    if (canvas.kind === 'presentation') continue;
    let provisional = 0, covered = 0;
    for await (const { value: tile } of iterate<StoredTile>(engine.store, `tile/${canvas.id}/0/`)) {
      provisional += countCovered(tile.provisional ?? new Uint8Array());
      covered += countCovered(tile.coverage);
    }
    assertEquals(canvas.provisionalPixels, provisional);
    assertEquals(canvas.observedPixels, covered);
  }
  assertEquals((await engine.store.get<{ completed: boolean }>('source-summary'))?.completed, false);
});

Deno.test('deferred sources: a clean recording-tail observation remains recoverable inside an automatic fixed island', async () => {
  const scenario = buildScenario('phone'), layer = scenario.layers[0];
  const result = await runScenario(scenario, scenario.settings);
  try {
    const truth = await verifyLayer(result, layer);
    const first = result.observations[0].decisions.find((d) => d.canvasId === truth.mainCanvas.id)!.placement;
    const frames = scenario.frames.map((_, i) => renderFrame(scenario, i).image);
    const failures: { x: number; y: number; clean: number[] }[] = [];
    // Inspect the trailing page corner against raw frames, without treating the learned fixed
    // island as ground truth. Otherwise the verifier silently calls these clean looks unobservable.
    for (let y = 3100; y < 3290; y++) {
      for (let x = 288; x < 390; x++) {
        const wx = x + layer.viewport.x + first.x - layer.path[0].x;
        const wy = y + layer.viewport.y + first.y - layer.path[0].y;
        const tx = Math.floor(wx / result.tileSize), ty = Math.floor(wy / result.tileSize);
        const tile = await result.engine.tiles.get(truth.mainCanvas.id, tx, ty);
        const at = (wy - ty * result.tileSize) * result.tileSize + wx - tx * result.tileSize;
        if (!(tile.coverage[at >> 3] & (1 << (at & 7)))) continue;
        const gold = layer.world.data.subarray((y * layer.world.width + x) * 4, (y * layer.world.width + x) * 4 + 4);
        if (gold.every((v, c) => tile.pixels[at * 4 + c] === v)) continue;
        const clean = frames.flatMap((im, i) => {
          const sx = layer.viewport.x + x - layer.path[i].x, sy = layer.viewport.y + y - layer.path[i].y;
          if (
            sx < layer.viewport.x || sy < layer.viewport.y || sx >= layer.viewport.x + layer.viewport.width ||
            sy >= layer.viewport.y + layer.viewport.height
          ) return [];
          const p = (sy * im.width + sx) * 4;
          return gold.every((v, c) => im.data[p + c] === v) ? [i] : [];
        });
        if (clean.length) failures.push({ x, y, clean });
      }
    }
    await Deno.writeTextFile('test-results/full-scheme/phone-unmasked-tail.json', JSON.stringify({ failures }, null, 2));
    assertEquals(failures.length, 0, 'all raw clean observations in the trailing corner remain eligible');
  } finally {
    result.dispose();
  }
});
