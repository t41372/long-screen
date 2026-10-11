// The performance row says where each pass's reading time went (`FrameSource.stats`, src/pipeline/context.ts
// `recordSource`): the benchmark splits decoding from conversion with it. Failure case: a source's timings never
// reaching the row, so a slow conversion hides inside the stage total.
import '../support/core.ts';
import { assertEquals } from '@std/assert';
import { Engine } from '../../src/pipeline/engine.ts';
import { MemoryKV, Namespace } from '../../src/storage/db.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { DEFAULT_SETTINGS, type SourceStats } from '../../src/types.ts';

Deno.test("engine: a source's decode and conversion timings reach the performance row for each pass", async () => {
  class TimedSource extends ScenarioSource {
    readonly stats: SourceStats = { frames: 0, converted: 0, decodeMS: 12.5, convertMS: 3.25 };
  }
  const db = new MemoryKV(), source = new TimedSource(buildScenario('vertical'));
  const project = await new Engine(db, source, { ...DEFAULT_SETTINGS }, { progress: () => {}, diagnostic: () => {}, project: () => {} })
    .run();
  const row = await new Namespace(db, `run/${project.id}/`).get<Record<string, number>>('performance');
  for (const stage of ['scan', 'solve']) {
    assertEquals([row?.[`${stage}.decodeMS`], row?.[`${stage}.convertMS`]], [12.5, 3.25], stage);
  }
});
