// English-locale gate: with the worker told to speak English (setLocale('en')), no diagnostic message/action and
// no progress message the Engine emits may contain a Han character. Runs several synthetic scenarios chosen to
// trip a wide variety of diagnostics (region shape, motion ambiguity, zoom, revisit/loop-closure, dynamic
// content), plus a minimal exportProject/exportCanvas run for the export-side catalogue. Always restores 'zh' in
// a finally, so a failure here never leaks into a later test file (though `deno test --parallel` isolates test
// files into separate processes anyway).
import '../support/core.ts';
import { assert } from '@std/assert';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { Engine, type EngineEvents } from '../../src/pipeline/engine.ts';
import { DEFAULT_SETTINGS, type Diagnostic, type Project } from '../../src/types.ts';
import { MemoryKV, Namespace } from '../../src/storage/db.ts';
import { TileStore } from '../../src/storage/tiles.ts';
import { setLocale } from '../../src/i18n/index.ts';
import { exportCanvas, exportProject } from '../../src/export/project.ts';

const HAN = /\p{Script=Han}/u;

function assertNoHan(label: string, text: string | undefined): void {
  if (text === undefined) return;
  assert(!HAN.test(text), `${label}: unexpected Han character in "${text}"`);
}

/** Runs one synthetic scenario through the real Engine, collecting every diagnostic (live events, which include
 *  every one a persisted diagnostic/ row would also carry) and every progress message. */
async function runCollecting(name: string): Promise<{ diagnostics: Diagnostic[]; progressMessages: string[]; project: Project }> {
  const scenario = buildScenario(name);
  const db = new MemoryKV(), source = new ScenarioSource(scenario);
  const diagnostics: Diagnostic[] = [], progressMessages: string[] = [];
  const handlers: EngineEvents = {
    progress: (p) => {
      if (p.message !== undefined) progressMessages.push(p.message);
    },
    diagnostic: (d) => diagnostics.push(d),
    project: () => {},
  };
  const engine = new Engine(db, source, { ...DEFAULT_SETTINGS, ...scenario.settings }, handlers);
  const project = await engine.run();
  return { diagnostics, progressMessages, project };
}

const SCENARIOS = ['traversal', 'gap', 'zoom', 'repeated-list-reversal', 'dynamic'];

for (const name of SCENARIOS) {
  Deno.test(`i18n-pipeline: scenario ${name} emits no Han text with setLocale('en')`, async () => {
    setLocale('en');
    try {
      const { diagnostics, progressMessages } = await runCollecting(name);
      assert(diagnostics.length > 0, `${name}: expected at least one diagnostic to check`);
      for (const d of diagnostics) {
        assertNoHan(`${name}/${d.code}.message`, d.message);
        assertNoHan(`${name}/${d.code}.action`, d.action);
      }
      for (const message of progressMessages) {
        assertNoHan(`${name}/progress`, message);
      }
    } finally {
      setLocale('zh');
    }
  });
}

Deno.test("i18n-pipeline: exportProject/exportCanvas progress and result messages have no Han text with setLocale('en')", async () => {
  setLocale('en');
  try {
    const db = new MemoryKV(),
      p: Project = {
        id: 'p1',
        created: '',
        updated: '',
        name: 'x',
        settings: { ...DEFAULT_SETTINGS, tileSize: 64, memoryMB: 64 },
        status: 'complete',
        frames: 1,
        renderedFrames: 1,
        canvasCount: 1,
        tiles: 0,
        observedPixels: 0,
        diagnostics: {},
        regions: [],
      };
    const store = new Namespace(db, `run/${p.id}/`);
    const messages: string[] = [];
    const projectResult = await exportProject(store, p, (m) => messages.push(m));
    assertNoHan('exportProject.result.message', projectResult.message);
    for (const m of messages) assertNoHan('exportProject.progress', m);

    const tiles = new TileStore(store, 64, 64);
    await tiles.flush();
    const meta = {
      id: 'c',
      layer: 'l',
      name: 'c',
      kind: 'moving' as const,
      bounds: { x: 0, y: 0, width: 4, height: 4 },
      tileCount: 0,
      observedPixels: 0,
      uncertainPixels: 0,
      conflictPixels: 0,
      provisionalPixels: 0,
      maxLevel: 0,
      fragment: 0,
      firstTime: 0,
      lastTime: 1,
    };
    const canvasMessages: string[] = [];
    const canvasResult = await exportCanvas(store, p, meta, (m) => canvasMessages.push(m));
    assertNoHan('exportCanvas.result.message', canvasResult.message);
    for (const m of canvasMessages) assertNoHan('exportCanvas.progress', m);
  } finally {
    setLocale('zh');
  }
});
