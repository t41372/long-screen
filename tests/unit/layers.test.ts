import { assert, assertEquals } from '@std/assert';
import { extractFeatures, grayscale } from '../../src/core/features.ts';
import { estimateMotion } from '../../src/core/motion.ts';
import { LayerLearner, RegionAtlas, regionContains } from '../../src/core/layers.ts';
import { contains } from '../../src/core/math.ts';
import { fixedBand } from '../../src/synthetic/scenarios.ts';
import { constantFrames, linearPath, makeWorld, type Scenario } from '../../src/synthetic/world.ts';
import { runScenario, verifyLayer } from '../support/run.ts';
import type { Gray, Point } from '../../src/types.ts';

function fieldFor(prev: Gray, cur: Gray) {
  return estimateMotion(prev, cur, undefined, extractFeatures(prev), extractFeatures(cur));
}
// F7: the downscale truth is floor(x/factor); nativeWidth/nativeHeight are NOT exact multiples of factor here
// (3843 = 640×6+3, 1802 = 300×6+2), reproducing a mask bbox that touches the last analysis row/column while the
// native image still has a few trailing rows/columns beyond it.
Deno.test('layers: non-divisible native geometry owns every content pixel; regionContains matches floor(x/factor)', () => {
  const factor = 6, aw = 640, ah = 300;
  const left = makeWorld(300, 1400, 21, 'cards'), right = makeWorld(300, 1400, 22, 'article');
  const gl = grayscale(left.data, 300, 1400), gr = grayscale(right.data, 300, 1400);
  const frame = (a: number, b: number): Gray => {
    const data = new Uint8Array(aw * ah).fill(60);
    for (let y = 0; y < ah; y++) {
      data.set(gl.data.subarray((a + y) * 300, (a + y) * 300 + 300), y * aw);
      data.set(gr.data.subarray((b + y) * 300, (b + y) * 300 + 300), y * aw + 335);
    }
    return { width: aw, height: ah, data };
  };
  const learner = new LayerLearner(aw, ah);
  let prev = frame(0, 0);
  for (let i = 1; i < 16; i++) {
    const cur = frame(i * 17, i < 8 ? 0 : (i - 7) * 11);
    learner.add(fieldFor(prev, cur), prev, cur);
    prev = cur;
  }
  const nativeWidth = aw * factor + 3, nativeHeight = ah * factor + 2;
  const regions = learner.finish(nativeWidth, nativeHeight, undefined, factor);
  const moving = regions.filter((r) => r.kind === 'moving');
  assertEquals(moving.length, 2, JSON.stringify(regions.map((r) => [r.kind, r.rect])));
  // No native pixel inside the (here: full-frame) content area is owned by no region.
  const atlas = new RegionAtlas(regions, nativeWidth, nativeHeight);
  let unowned = 0;
  for (let i = 0; i < atlas.labels.length; i++) if (!atlas.labels[i]) unowned++;
  assertEquals(unowned, 0, `${unowned} of ${atlas.labels.length} native pixels are owned by no region`);
  // regionContains must agree with floor(x/factor) (clamped), including in the remainder strip beyond aw*factor/ah*factor.
  const masked = regions.find((r) => r.mask && !r.solid)!;
  for (
    const [x, y] of [[0, 0], [nativeWidth - 1, 10], [10, nativeHeight - 1], [nativeWidth - 1, nativeHeight - 1], [
      nativeWidth - 2,
      nativeHeight - 2,
    ]]
  ) {
    const xx = Math.min(masked.maskWidth! - 1, Math.floor(x / factor)), yy = Math.min(masked.maskHeight! - 1, Math.floor(y / factor));
    const expected = contains(masked.rect, x, y) && (!masked.crop || contains(masked.crop, x, y)) &&
      !!masked.mask![yy * masked.maskWidth! + xx];
    assertEquals(regionContains(masked, x, y, nativeWidth, nativeHeight), expected, `(${x},${y})`);
  }
});
// F5: a fixed header at high DPI where the native per-frame displacement is strictly below one analysis pixel
// (factor 2, 1 native px/frame ⇒ 0.5 analysis px/frame). A single frame-to-frame step never clears the layer
// evidence threshold; only a long-baseline (frame t−k vs t) comparison accumulates enough displacement to.
function slowScrollScenario(): Scenario {
  const width = 1280, height = 896, headerHeight = 96, viewport = { x: 0, y: headerHeight, width, height: height - headerHeight };
  const world = makeWorld(width, 2200, 331, 'article'), frames = 120;
  const path: Point[] = Array.from({ length: frames }, (_, i) => ({ x: 0, y: i }));
  return {
    name: 'slow-scroll-sub-analysis-pixel',
    description: '每帧原生位移小于一个分析像素；长基线证据仍需拆分固定头部。',
    width,
    height,
    background: [251, 250, 246],
    layers: [{ id: 'body', viewport, world, path }],
    overlays: [fixedBand('header', { x: 0, y: 0, width, height: headerHeight }, 501)],
    frames: constantFrames(frames, 30),
    expect: {
      fragments: { body: 0 },
      diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
      maxError: 0,
      status: 'complete',
    },
  };
}
Deno.test('layers: sub-analysis-pixel scrolling still separates a fixed header via long-baseline evidence', async () => {
  const scenario = slowScrollScenario(), headerHeight = scenario.layers[0].viewport.y, layer = scenario.layers[0];
  const run = await runScenario(scenario);
  assertEquals(run.project.status, 'complete', run.project.error);
  const moving = run.regions.filter((r) => r.kind === 'moving');
  assertEquals(moving.length, 1, JSON.stringify(run.regions.map((r) => [r.kind, r.rect])));
  assert(moving[0].rect.y >= headerHeight, `moving region rect.y=${moving[0].rect.y} should be >= header height ${headerHeight}`);
  const fixed = run.regions.find((r) => r.kind === 'fixed' && r.rect.y <= 0 && r.rect.y + r.rect.height >= headerHeight);
  assert(fixed, `no fixed region covers the header band; regions=${JSON.stringify(run.regions.map((r) => [r.kind, r.rect]))}`);
  const result = await verifyLayer(run, layer);
  assertEquals(result.maxError, 0);
  assertEquals(result.missing, 0);
  assertEquals(result.invented, 0);
  assertEquals(result.mismatched, 0);
  assertEquals(result.fragments.length, 0);
});
// F7 end-to-end: a 1080p-class desktop capture whose HEIGHT is not an exact multiple of the analysis factor
// (1082 / 4 = 270.5, matching 'factor4' in scenarios.ts but with a non-divisible height), run through the whole
// scan → solve → render pipeline, not just LayerLearner.finish() in isolation. The path is monotonic (unlike
// 'factor4', which reverses direction): a reversal deep in repeating 'cards' content lands the frame-to-frame
// odometry on a period-aliased candidate ~670px away — reproducible identically at the divisible height 1080
// and with other world seeds, i.e. a pre-existing motion-matching ambiguity unrelated to factor divisibility
// (see this agent's final report) — and would make this test assert something it isn't measuring.
function factor4NonDivisibleScenario(): Scenario {
  const RW = 1920, RH = 1082, RH_HEADER = 80;
  const world = makeWorld(2400, 2600, 8181, 'cards', 4);
  const path = linearPath([{ x: 0, y: 0 }, { x: 200, y: 900 }, { x: 400, y: 1500 }], [14, 12]);
  return {
    name: 'factor4-non-divisible',
    description: '桌面横屏，高度不能被分析因子整除 (1082 / 4)。',
    width: RW,
    height: RH,
    background: [251, 250, 246],
    layers: [{ id: 'body', viewport: { x: 0, y: RH_HEADER, width: RW, height: RH - RH_HEADER }, world, path }],
    overlays: [fixedBand('header', { x: 0, y: 0, width: RW, height: RH_HEADER }, 823)],
    frames: constantFrames(path.length, 30),
    expect: {
      fragments: { body: 0 },
      diagnostics: { present: [], absent: ['UNPLACED_FRAGMENT', 'PROCESSING_ERROR'] },
      maxError: 0,
      status: 'complete',
    },
  };
}
Deno.test('layers: non-divisible 1080p-class geometry (1920×1082, analysisSize 480, factor 4) places without error', async () => {
  const scenario = factor4NonDivisibleScenario(), layer = scenario.layers[0];
  const run = await runScenario(scenario, { analysisSize: 480 });
  assertEquals(run.project.status, 'complete', run.project.error);
  assertEquals(run.engine.factor, 4);
  const result = await verifyLayer(run, layer);
  assertEquals(result.maxError, 0, `errors=${JSON.stringify(result.errors)}`);
  assertEquals(result.missing, 0);
  assertEquals(result.invented, 0);
  assertEquals(result.mismatched, 0);
  assertEquals(result.fragments.length, 0);
});
