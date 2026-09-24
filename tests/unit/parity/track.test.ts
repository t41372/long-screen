/** Byte-exact parity between the Rust tracking verdicts (rust/core/src/track.rs + abi/track.rs, phase 3a of R4b)
 *  and the frozen TS oracle they replace (tests/support/reference/track.ts). Runs on whichever build
 *  `LONGSCREEN_CORE` selects (scalar/simd/threads — see tests/support/core.ts). Only the stateless verdicts
 *  covered by phase 3a are exercised here; odometry/reacquire/driftCorrection stay TS until phase 3b. */
import { assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import * as ref from '../../support/reference/track.ts';
import type { Feature, Match, Point } from '../../../src/types.ts';

Deno.test('core parity: track.uncertainty matches the frozen oracle', async () => {
  const core = await ensureCore();
  const confidences = [-1, 0, 0.05, 0.3, 0.5, 0.5999999999999999, 0.6, 0.6000000000000001, 0.72, 0.95, 1, NaN, Infinity, -Infinity];
  for (const confidence of confidences) {
    for (const ambiguous of [false, true]) {
      for (const weakStep of [false, true]) {
        assertEquals(
          core.trackUncertainty(confidence, ambiguous, weakStep),
          ref.uncertainty(confidence, ambiguous, weakStep),
          `confidence=${confidence} ambiguous=${ambiguous} weakStep=${weakStep}`,
        );
      }
    }
  }
});

Deno.test('core parity: track.relocalizeVerdict matches the frozen oracle', async () => {
  const core = await ensureCore();
  const matches: ({ ambiguous: boolean; confidence: number } | undefined)[] = [
    undefined,
    { ambiguous: false, confidence: 0.6 },
    { ambiguous: false, confidence: 0.6000000000000001 },
    { ambiguous: false, confidence: 0.9 },
    { ambiguous: true, confidence: 0.9 },
    { ambiguous: false, confidence: 0 },
  ];
  for (const match of matches) {
    for (const zoomChange of [false, true]) {
      assertEquals(
        core.trackRelocalizeVerdict(match, zoomChange),
        ref.relocalizeVerdict(match, zoomChange),
        `match=${JSON.stringify(match)} zoomChange=${zoomChange}`,
      );
    }
  }
});

Deno.test('core parity: track.fragmentCause gate matches the frozen oracle', async () => {
  const core = await ensureCore();
  const g = { width: 400, height: 300, data: new Uint8Array(400 * 300) };
  const roi = { x: 0, y: 0, width: 10, height: 10 };
  for (const zoomChange of [false, true]) {
    for (const hasPreviousGray of [false, true]) {
      for (const blind of [false, true]) {
        const gate = core.trackFragmentCauseGate(zoomChange, hasPreviousGray, blind);
        // Cross-check against the actual TS decision function's branch (which calls probeScale, a
        // separate existing kernel — here we only check which branch it took).
        const previousGray = hasPreviousGray ? g : undefined;
        const took = ref.fragmentCause(zoomChange, 1.2, previousGray, blind, g, [], roi);
        if (zoomChange) {
          assertEquals(gate, 'zoom-change');
          assertEquals(took, { scale: 1.2, error: 0 });
        } else if (hasPreviousGray && !blind) {
          assertEquals(gate, 'probe-scale');
        } else {
          assertEquals(gate, 'none');
          assertEquals(took, undefined);
        }
      }
    }
  }
});

Deno.test('core parity: track.occlusionEligible matches the frozen oracle', async () => {
  const core = await ensureCore();
  const decisions: ('tracked' | 'static' | 'blind' | 'lost')[] = ['tracked', 'static', 'blind', 'lost'];
  for (const hasPrevious of [false, true]) {
    for (const kindMoving of [false, true]) {
      for (const decision of decisions) {
        assertEquals(
          core.trackOcclusionEligible(hasPrevious, kindMoving, decision),
          ref.occlusionEligible(hasPrevious, kindMoving ? 'moving' : 'fixed', decision),
          `hasPrevious=${hasPrevious} kindMoving=${kindMoving} decision=${decision}`,
        );
      }
    }
  }
});

const P = (x: number, y: number): Point => ({ x, y });

Deno.test('core parity: track.targetPose matches the frozen oracle', async () => {
  const core = await ensureCore();
  const cases: [Point, Point, Point][] = [
    [P(0, 0), P(0, 0), P(0, 0)],
    [P(100.5, -20.25), P(3.125, -0.5), P(-7, 12)],
    [P(NaN, 0), P(1, 1), P(1, 1)],
    [P(Infinity, -Infinity), P(1, 1), P(1, 1)],
  ];
  for (const [keyframe, offset, shift] of cases) {
    assertEquals(core.trackTargetPose(keyframe, offset, shift), ref.targetPose(keyframe, offset, shift));
  }
});

Deno.test('core parity: track.attachVerdict matches the frozen oracle', async () => {
  const core = await ensureCore();
  const globals: ({ keyframe: Point; offset: Point; ambiguous: boolean; confidence: number } | undefined)[] = [
    undefined,
    { keyframe: P(10, 20), offset: P(1, 1), ambiguous: false, confidence: 0.72 },
    { keyframe: P(10, 20), offset: P(1, 1), ambiguous: false, confidence: 0.7200000000000001 },
    { keyframe: P(10, 20), offset: P(1, 1), ambiguous: true, confidence: 0.9 },
    { keyframe: P(10, 20), offset: P(1, 1), ambiguous: false, confidence: 0.9 },
  ];
  const shift = P(5, -3);
  for (const global of globals) {
    for (const resolvedEq of [false, true]) {
      const actual = core.trackAttachVerdict(global, resolvedEq, shift);
      const expected = ref.attachVerdict(global, resolvedEq ? 'same' : 'other', 'same', shift);
      assertEquals(actual, expected?.pose, `global=${JSON.stringify(global)} resolvedEq=${resolvedEq}`);
    }
  }
});

Deno.test('core parity: track.odometryWeight matches the frozen oracle', async () => {
  const core = await ensureCore();
  for (const weakStep of [false, true]) {
    assertEquals(core.trackOdometryWeight(weakStep), ref.odometryWeight(weakStep));
  }
});

Deno.test('core parity: track.thinOverlapEligible matches the frozen oracle', async () => {
  const core = await ensureCore();
  const confidences = [0.72, 0.7200000000000001, 0.9];
  const errors = [7.999999999999999, 8, 8.000000000000002, 4];
  for (const weakStep of [false, true]) {
    for (const weak of [false, true]) {
      for (const ambiguous of [false, true]) {
        for (const confidence of confidences) {
          for (const error of errors) {
            assertEquals(
              core.trackThinOverlapEligible(weakStep, weak, ambiguous, confidence, error),
              ref.thinOverlapEligible(weakStep, weak, ambiguous, confidence, error),
              `weakStep=${weakStep} weak=${weak} ambiguous=${ambiguous} confidence=${confidence} error=${error}`,
            );
          }
        }
      }
    }
  }
});

Deno.test('core parity: track.thinOverlapCorrection matches the frozen oracle', async () => {
  const core = await ensureCore();
  const cases: [Point, Point, Point][] = [
    [P(0, 0), P(0, 0), P(0, 0)],
    [P(0, 0), P(0, 0), P(16, 0)],
    [P(0, 0), P(0, 0), P(15.999999999999998, 0)],
    [P(100, 200), P(3, -4), P(90, 210)],
    [P(NaN, 0), P(0, 0), P(0, 0)],
  ];
  for (const [canonicalKeyframe, offset, pose] of cases) {
    assertEquals(
      core.trackThinOverlapCorrection(canonicalKeyframe, offset, pose),
      ref.thinOverlapCorrection({ canonicalKeyframe, offset, pose }),
      JSON.stringify({ canonicalKeyframe, offset, pose }),
    );
  }
});

Deno.test('core parity: track.loopClosureVerdict matches the frozen oracle', async () => {
  const core = await ensureCore();
  const globals: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number }[] = [
    { keyframe: P(0, 0), offset: P(0, 0), ambiguous: false, confidence: 0.9 },
    { keyframe: P(0, 0), offset: P(0, 0), ambiguous: true, confidence: 0.9 },
    { keyframe: P(0, 0), offset: P(0, 0), ambiguous: false, confidence: 0.5 },
    { keyframe: P(100, 0), offset: P(0, 0), ambiguous: false, confidence: 0.9 },
  ];
  const poses: Point[] = [P(0, 0), P(15.9, 0), P(16, 0), P(16.1, 0), P(1, 1)];
  for (const global of globals) {
    for (const pose of poses) {
      assertEquals(
        core.trackLoopClosureVerdict(global, P(0, 0), pose),
        ref.loopClosureVerdict(global, P(0, 0), pose),
        `global=${JSON.stringify(global)} pose=${JSON.stringify(pose)}`,
      );
    }
  }
});

Deno.test('core parity: track.needsKeyframe matches the frozen oracle', async () => {
  const core = await ensureCore();
  const rect = { width: 100, height: 160 };
  const cases: [boolean, Point | undefined, Point, number | undefined, number, number][] = [
    [true, undefined, P(0, 0), undefined, 0, 0],
    [false, undefined, P(0, 0), undefined, 0, 0],
    [false, P(0, 0), P(1000, 1000), 0, 500, 1],
    [true, P(0, 0), P(48, 0), 0, 1, 0],
    [true, P(0, 0), P(48.0001, 0), 0, 1, 0],
    [true, undefined, P(0, 0), 0, 91, 0.3],
    [true, undefined, P(0, 0), 0, 90, 0.3],
    [true, undefined, P(0, 0), 0, 91, 0.19999999999999998],
  ];
  for (const [kindMoving, anchor, pose, lastNodeFrame, frameIndex, fieldDifference] of cases) {
    assertEquals(
      core.trackNeedsKeyframe(kindMoving, anchor, pose, lastNodeFrame, rect, frameIndex, fieldDifference),
      ref.needsKeyframe(kindMoving ? 'moving' : 'fixed', anchor, pose, lastNodeFrame, rect, frameIndex, fieldDifference),
      JSON.stringify({ kindMoving, anchor, pose, lastNodeFrame, frameIndex, fieldDifference }),
    );
  }
});

Deno.test('core parity: track.zoomChanged matches the frozen oracle', async () => {
  const core = await ensureCore();
  const cases: [number | undefined, number][] = [
    [undefined, 1],
    [undefined, 1.0400000000000001],
    [undefined, 0.96],
    [1, 1],
    [1.04, 1],
    [1.0400000000000001, 1],
    [0.9599999999999999, 1],
  ];
  for (const [regionZoom, fieldZoom] of cases) {
    assertEquals(
      core.trackZoomChanged(regionZoom, fieldZoom),
      ref.zoomChanged(regionZoom, fieldZoom),
      `regionZoom=${regionZoom} fieldZoom=${fieldZoom}`,
    );
  }
});

function feature(x: number, y: number): Feature {
  return { x, y, score: 0, descriptor: new Uint32Array(0) };
}
function randomMatches(count: number, uniqueRatio: number, seed: number): Match[] {
  const rnd = rng(seed), out: Match[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      a: feature(rnd() * 400, rnd() * 300),
      b: feature(rnd() * 400, rnd() * 300),
      distance: rnd() * 64,
      unique: rnd() < uniqueRatio,
    });
  }
  return out;
}

Deno.test('core parity: track.regionZoom matches the frozen oracle over random match sets', async () => {
  const core = await ensureCore();
  for (const kindMoving of [false, true]) {
    for (const [count, uniqueRatio, seed] of [[0, 1, 1], [5, 1, 2], [8, 1, 3], [8, 0.5, 4], [40, 0.3, 5], [40, 0.9, 6]] as const) {
      const matches = randomMatches(count, uniqueRatio, seed);
      assertEquals(
        core.trackRegionZoom(kindMoving, matches),
        ref.regionZoom(kindMoving ? 'moving' : 'fixed', matches),
        `kindMoving=${kindMoving} count=${count} uniqueRatio=${uniqueRatio} seed=${seed}`,
      );
    }
  }
});
