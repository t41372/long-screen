import { assert, assertEquals } from '@std/assert';
import { Engine, type EngineEvents } from '../../src/pipeline/engine.ts';
import { iterate, MemoryKV } from '../../src/storage/db.ts';
import { type CanvasMeta, DEFAULT_SETTINGS, type Progress } from '../../src/types.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
// The `stopped` latch: render()'s own stop check used to reset `stopRequested` to false right after honouring it,
// which erased the signal run() needs to skip the framing and pyramid stages — a stop mid-render used to still run
// both of those stages to completion. This drives a stop from the progress callback, the moment it first observes
// the 'rendering' phase, and checks all three symptoms: status, no framed canvas, no pyramid levels.
Deno.test('engine stop: a stop requested while rendering yields partial status with no framing or pyramid stage', async () => {
  const scenario = buildScenario('traversal'), db = new MemoryKV(), source = new ScenarioSource(scenario);
  let engine!: Engine, stopSignalled = false;
  const handlers: EngineEvents = {
    progress: (p: Progress) => {
      if (p.phase === 'rendering' && !stopSignalled) {
        stopSignalled = true;
        engine.stopRequested = true;
      }
    },
    diagnostic: () => {},
    project: () => {},
  };
  engine = new Engine(db, source, { ...DEFAULT_SETTINGS, framing: 'context' }, handlers);
  const project = await engine.run();
  assert(stopSignalled, 'the progress callback never observed the rendering phase; the test setup is not exercising render()');
  assertEquals(project.status, 'partial', project.error);
  assert(
    project.renderedFrames > 0 && project.renderedFrames < scenario.frames.length,
    `expected a stop partway through rendering, got ${project.renderedFrames} of ${scenario.frames.length} frames`,
  );
  const canvases: CanvasMeta[] = [];
  for await (const { value } of iterate<CanvasMeta>(engine.store, 'canvas/')) {
    canvases.push(value);
  }
  assert(canvases.length > 0, 'expected at least one canvas from solve()/render() before the stop');
  assert(
    !canvases.some((c) => c.kind === 'presentation'),
    'a stop during rendering must skip the framing stage entirely, not build any -framed canvas',
  );
  assert(
    canvases.every((c) => c.maxLevel === 0),
    'a stop during rendering must skip the pyramid stage entirely, not build any preview level',
  );
});
