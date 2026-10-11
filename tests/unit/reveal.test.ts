import '../support/core.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { Engine } from '../../src/pipeline/engine.ts';
import { iterate, MemoryKV } from '../../src/storage/db.ts';
import { type CanvasMeta, DEFAULT_SETTINGS, type Diagnostic } from '../../src/types.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { core } from '../../src/core/wasm.ts';
import type { RevealSessionHandle } from '../../src/core/wasm/reveal.ts';
import { t } from '../../src/i18n/index.ts';

// The reveal stage through the whole Engine on the `traversal` scenario. Failure cases: a memory check that does not
// fit fails the run or ends it partial, is silent, loses the size, the stage or the journal row's field order, or
// still writes provenance or summary rows, or a skip at the second check is reported as the first; a stop during the
// passes still writes the summary or lets framing run; a cache too small for the tiles a pass writes changes what is
// stored; the session's binding accepts a step after a tile it asked for was never brought in, or hands out a frame
// buffer outside a decode.

type Patch = { answers?: boolean[]; onSession?: (engine: Engine, session: RevealSessionHandle) => void };

async function run(patch: Patch = {}) {
  const c = core() as unknown as Record<string, unknown>;
  const original = core().revealSession;
  let calls = 0;
  const answers = patch.answers;
  if (answers) c.canAllocate = () => answers[Math.min(calls++, answers.length - 1)];
  const db = new MemoryKV(), source = new ScenarioSource(buildScenario('traversal'));
  const engine = new Engine(db, source, { ...DEFAULT_SETTINGS }, { progress: () => {}, diagnostic: () => {}, project: () => {} });
  if (patch.onSession) {
    c.revealSession = function (this: ReturnType<typeof core>, input: Parameters<typeof original>[0]) {
      const session = original.call(this, input);
      patch.onSession!(engine, session);
      return session;
    };
  }
  try {
    const project = await engine.run();
    const rows = new Map<string, unknown>(), skipped: Diagnostic[] = [];
    for await (const { key, value } of iterate(engine.store, '')) rows.set(key, value);
    for await (const { value } of iterate<Diagnostic>(engine.store, 'diagnostic/')) {
      if (value.code === 'REVEAL_SKIPPED') skipped.push(value);
    }
    if (answers) assertEquals(calls, answers.length, 'the core was asked once per memory check');
    return { status: project.status, rows, skipped };
  } finally {
    delete c.canAllocate;
    delete c.revealSession;
  }
}

for (const [stage, answers] of [['canvases', [false]], ['fallback', [true, false]]] as const) {
  Deno.test(`reveal: memory that does not fit at the ${stage} check skips the stage and says why`, async () => {
    const { status, rows, skipped } = await run({ answers: [...answers] });
    assertEquals(status, 'complete');
    assertEquals(skipped.length, 1);
    const [d] = skipped, detail = d.detail as { stage: string; needMB: number; coreMB: number };
    assertEquals(Object.keys(d), ['code', 'severity', 'message', 'action', 'detail']);
    assertEquals(Object.keys(detail), ['stage', 'needMB', 'coreMB']);
    assertEquals(detail.stage, stage);
    assertEquals(d.severity, 'warning');
    assertEquals(d.message, t('diag.REVEAL_SKIPPED.message', { need: detail.needMB }));
    assertEquals(d.action, t('diag.REVEAL_SKIPPED.action'));
    assert(detail.coreMB > 0);
    const keys = [...rows.keys()];
    assert(!keys.some((k) => k.startsWith('reveal/') || k === 'reveal-summary'), keys.filter((k) => k.startsWith('reveal')).join());
  });
}

/** Every stored tile, canvas and reveal row, with the summary's wall-clock seconds left out. */
function output(rows: Map<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of rows) {
    if (key === 'reveal-summary') {
      const { seconds: _, ...rest } = value as Record<string, unknown>;
      out.set(key, rest);
    } else if (/^(tile|tile-index|canvas|reveal)\//.test(key)) out.set(key, value);
  }
  return out;
}

Deno.test('reveal: core memory that grows while a decoded frame is handed over still stores the same print', async () => {
  // Failure case: the host builds its view of core memory before asking the session for the frame buffer, which can
  // allocate a frame slot and grow memory; the view is then detached (or too short) and the copy throws.
  const plain = await run({ answers: [true, true] });
  let grown = 0;
  const growing = await run({
    answers: [true, true],
    onSession: (_, session) => {
      const frameBuffer = session.frameBuffer.bind(session);
      session.frameBuffer = () => {
        core().exports.memory.grow(1);
        grown++;
        return frameBuffer();
      };
    },
  });
  assert(grown > 0, 'the reveal passes took decoded frames');
  assertEquals(growing.status, 'complete');
  assertEquals(output(growing.rows).size, output(plain.rows).size);
  for (const [key, value] of output(plain.rows)) {
    if (key === 'reveal-summary' || key.startsWith('reveal/')) assertEquals(output(growing.rows).get(key), value, key);
  }
});

Deno.test('reveal: tiles leaving the cache while the passes write store the same print', async () => {
  const plain = await run({ answers: [true, true] });
  let loads = 0;
  const small = await run({
    onSession: (engine) => {
      // After the first compositor tile, every tile is stored and dropped, and the cache holds two from then on:
      // the reference, the fallback blocks, the block copies of each vote frame and the deferred blocks all bring
      // their tiles back in.
      const ctx = (engine as unknown as { ctx: { checkpoint(): Promise<void> } }).ctx, checkpoint = ctx.checkpoint.bind(ctx);
      let dropped = false;
      ctx.checkpoint = async () => {
        if (!dropped) {
          dropped = true;
          await engine.tiles.clear();
          engine.tiles.maxTiles = 2;
        }
        await checkpoint();
      };
      const load = engine.tiles.load.bind(engine.tiles);
      engine.tiles.load = (...args) => (loads++, load(...args));
    },
  });
  assertEquals(plain.status, 'complete');
  assertEquals(small.status, 'complete');
  assert(loads > 10, `${loads} tile loads`);
  assertEquals(plain.skipped, []);
  const summary = plain.rows.get('reveal-summary') as Record<string, number>;
  assertEquals(Object.keys(summary), [
    'objects',
    'components',
    'coherentBlocks',
    'componentBlocks',
    'provisionalBlocks',
    'fallbackBlocks',
    'seconds',
  ]);
  assert([...plain.rows.keys()].some((k) => k.startsWith('reveal/')));
  const a = output(plain.rows), b = output(small.rows);
  assertEquals([...b.keys()].sort(), [...a.keys()].sort());
  for (const [key, value] of a) {
    const other = b.get(key) as Record<string, unknown>;
    // Tile blobs are PNGs of the same pixels; compare their bytes.
    if (value && typeof value === 'object' && (value as { blob?: Blob }).blob instanceof Blob) {
      const { blob, ...rest } = value as { blob: Blob };
      const { blob: otherBlob, ...otherRest } = other as { blob: Blob };
      assertEquals(new Uint8Array(await otherBlob.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()), key);
      assertEquals(otherRest, rest, key);
    } else assertEquals(other, value, key);
  }
});

Deno.test('reveal: a stop during the passes ends the run partial without a summary or framing', async () => {
  const { status, rows } = await run({
    onSession: (engine, session) => {
      const push = session.push.bind(session);
      session.push = (index, labels) => {
        push(index, labels);
        engine.stopRequested = true;
      };
    },
  });
  assertEquals(status, 'partial');
  assert(!rows.has('reveal-summary'));
  assert(![...rows.keys()].some((k) => k.startsWith('reveal/')));
  const canvases = [...rows].filter(([k]) => k.startsWith('canvas/')).map(([, v]) => v as CanvasMeta);
  assert(canvases.length > 0 && !canvases.some((c) => c.kind === 'presentation'));
});

Deno.test('reveal session binding: out-of-turn calls throw', () => {
  const session = core().revealSession({
    width: 64,
    height: 48,
    noise: 10,
    tileSize: 32,
    frames: 2,
    layers: [{ id: 'page', rect: { x: 0, y: 0, width: 64, height: 48 }, code: 0 }],
    canvases: [{ id: 'world', bounds: { x: 0, y: 0, width: 64, height: 96 } }],
  });
  const tiles = core().tileCache(32, 128);
  try {
    assertThrows(() => session.frameBuffer(), Error, 'reveal frame buffer');
    assertEquals(session.step(tiles, 0).kind, 'memory');
    session.memory(true, 0);
    assertEquals(session.step(tiles, 0).kind, 'observations');
    assertEquals(session.step(tiles, 0), { kind: 'tile', canvas: 'world', level: 0, x: 0, y: 0 });
    assertThrows(() => session.step(tiles, 0), Error, 'before the tile it asked for was brought in');
  } finally {
    session.free();
    tiles.free();
  }
});
