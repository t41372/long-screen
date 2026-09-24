import '../support/core.ts';
import type { CanvasMeta, Diagnostic, Project, Region, Settings } from '../../src/types.ts';
import { DEFAULT_SETTINGS } from '../../src/types.ts';
import { Engine, type EngineEvents } from '../../src/pipeline/engine.ts';
import { iterate, type KV, MemoryKV, Namespace } from '../../src/storage/db.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import type { Scenario } from '../../src/synthetic/world.ts';
import type { Observation, VerifiableRun } from '../../src/synthetic/verify.ts';
export { matchRegion, verifyCanvasAccounting, verifyFixed, verifyLayer } from '../../src/synthetic/verify.ts';
export interface RunResult extends VerifiableRun {
  engine: Engine;
  db: MemoryKV;
  project: Project;
  diagnostics: Diagnostic[];
  codes: Set<string>;
  memory: { peakResidentTiles: number; tileCacheLimit: number };
  events: { progress: number; diagnostics: Diagnostic[]; projects: number };
  seconds: number;
  /** Frees `atlas`'s core-resident buffer. `atlas` now owns Wasm-side memory (src/core/layers.ts's RegionAtlas),
   *  so a caller done reading a RunResult must call this — checkScenario() and collectRun()'s few direct callers
   *  do. Safe to call more than once. */
  dispose(): void;
}
export async function runScenario(
  scenario: Scenario,
  settings: Partial<Settings> = {},
  control?: (engine: Engine) => void,
): Promise<RunResult> {
  const db = new MemoryKV(), source = new ScenarioSource(scenario);
  const events: RunResult['events'] = { progress: 0, diagnostics: [], projects: 0 };
  const handlers: EngineEvents = {
    progress: () => events.progress++,
    diagnostic: (d) => events.diagnostics.push(d),
    project: () => events.projects++,
  };
  const engine = new Engine(db, source, { ...DEFAULT_SETTINGS, ...settings }, handlers);
  control?.(engine);
  const started = performance.now();
  const project = await engine.run();
  const seconds = (performance.now() - started) / 1000;
  return { ...await collectRun(db, project, scenario, engine.tiles.size), engine, db, events, seconds };
}
/** Reads a finished run back from storage. Shared by Deno tests and the browser test kit. */
export async function collectRun(
  db: KV,
  project: Project,
  scenario: Scenario,
  tileSize: number,
): Promise<
  & VerifiableRun
  & { project: Project; store: KV; diagnostics: Diagnostic[]; codes: Set<string>; memory: RunResult['memory']; dispose(): void }
> {
  const store = new Namespace(db, `run/${project.id}/`);
  const canvases: CanvasMeta[] = [], observations: Observation[] = [], diagnostics: Diagnostic[] = [];
  for await (const { value } of iterate<CanvasMeta>(store, 'canvas/')) {
    canvases.push(value);
  }
  for await (const { value } of iterate<Observation>(store, 'observation/')) {
    observations.push(value);
  }
  for await (const { value } of iterate<Diagnostic>(store, 'diagnostic/')) {
    diagnostics.push(value);
  }
  const regions = (await store.get<Region[]>('regions')) || [];
  const atlas = new RegionAtlas(regions, scenario.width, scenario.height);
  const memory = (await store.get<RunResult['memory']>('memory-stats')) || { peakResidentTiles: 0, tileCacheLimit: 0 };
  return {
    scenario,
    project,
    store,
    canvases,
    observations,
    diagnostics,
    codes: new Set(diagnostics.map((d) => d.code)),
    regions,
    atlas,
    memory,
    tileSize,
    dispose: () => atlas.dispose(),
  };
}
