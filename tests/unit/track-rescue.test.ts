// The odometry rescue (src/pipeline/solve/region-step.ts `applyLost`): a step the plain native error rejected but the
// core still measured unambiguously (rust/core/src/track/odometry.rs `Rescue`) is placed as a tracked step, and only
// where the run would otherwise start a new fragment. Failure cases: the rescue ignored, so a measured step still
// breaks the canvas in two (the iPhone recording had 234 fragments); and the rescue taken although none was offered.
// The core's own decision is replaced at the shell's entry points, as the NONFINITE_POSE tests do: the first tracked
// step is rejected and the anchor re-acquisition on that same frame fails, and with no other keyframe to relocalise
// onto yet the run is left with only the rescue or a new fragment.
import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { core } from '../../src/core/wasm.ts';
import { Engine } from '../../src/pipeline/engine.ts';
import { iterate, MemoryKV, Namespace } from '../../src/storage/db.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { type CanvasMeta, DEFAULT_SETTINGS, type Diagnostic, type Placement } from '../../src/types.ts';
import type { OdometryEstimate } from '../../src/pipeline/solve/track.ts';

/** Runs `vertical` with its first tracked odometry step rejected, offering the measured step as a rescue or not. */
async function run(reject: 'none' | 'without rescue' | 'with rescue') {
  const db = new MemoryKV(), codes = new Set<string>();
  const c = core() as unknown as {
    trackOdometry(inputs: unknown): OdometryEstimate;
    trackReacquire(inputs: unknown): { result: unknown; filledNative: boolean };
  };
  const original = c.trackOdometry.bind(c), originalReacquire = c.trackReacquire.bind(c);
  let rejected = false, reacquireFails = false;
  c.trackReacquire = (inputs: unknown) => {
    const out = originalReacquire(inputs);
    if (!reacquireFails) return out;
    reacquireFails = false;
    return { ...out, result: undefined };
  };
  c.trackOdometry = (inputs: unknown) => {
    const est = original(inputs);
    if (reject === 'none' || rejected || est.decision !== 'tracked') return est;
    rejected = reacquireFails = true;
    const { delta, confidence, ambiguous, weakStep, stepError } = est;
    return {
      ...est,
      decision: 'lost',
      rescue: reject === 'with rescue' ? { delta, confidence, ambiguous, weakStep, stepError } : undefined,
    };
  };
  try {
    const engine = new Engine(db, new ScenarioSource(buildScenario('vertical')), { ...DEFAULT_SETTINGS }, {
      progress: () => {},
      diagnostic: (d: Diagnostic) => void codes.add(d.code),
      project: () => {},
    });
    const project = await engine.run();
    const store = new Namespace(db, `run/${project.id}/`), canvases: CanvasMeta[] = [], plans: Placement[][] = [];
    for await (const { value } of iterate<CanvasMeta>(store, 'canvas/')) canvases.push(value);
    for await (const { value } of iterate<{ placements: Placement[] }>(store, 'plan/')) plans.push(value.placements);
    const moving = canvases.filter((m) => m.kind === 'moving' && !m.attachedTo);
    return {
      status: project.status,
      rejected,
      codes,
      moving,
      poses: plans.map((p) => p.map((q) => `${q.canvasId}@${q.x},${q.y}`).join(' ')),
    };
  } finally {
    c.trackOdometry = original;
    c.trackReacquire = originalReacquire;
  }
}

Deno.test('track: a rejected step that odometry measured is placed instead of starting a new fragment', async () => {
  const plain = await run('none'), lost = await run('without rescue'), rescued = await run('with rescue');
  assert(lost.rejected && rescued.rejected, 'the stub never saw a tracked step to reject');
  // Control: without a rescue the rejected step starts a fragment, so the rescue below is what keeps one canvas.
  assert(lost.codes.has('UNPLACED_FRAGMENT'), [...lost.codes].join(','));
  assertEquals(rescued.status, 'complete');
  assert(!rescued.codes.has('UNPLACED_FRAGMENT'), [...rescued.codes].join(','));
  assertEquals(rescued.moving.length, plain.moving.length, 'one canvas, as when the step was never rejected');
  assertEquals(rescued.poses, plain.poses, 'every observation placed where the untouched run placed it');
});
