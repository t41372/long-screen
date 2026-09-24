import '../support/core.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { LayerLearner, RegionAtlas, stationaryBoundary, stickyOcclusions } from '../../src/core/layers.ts';
import { core } from '../../src/core/wasm.ts';
import { contains } from '../../src/core/math.ts';
import { referenceRegionContains as regionContains } from '../support/reference/layers.ts';
import { fixedBand } from '../../src/synthetic/scenarios.ts';
import {
  constantFrames,
  fillRGBA,
  linearPath,
  makeWorld,
  type Overlay,
  renderFrame,
  type Scenario,
  World,
} from '../../src/synthetic/world.ts';
import { runScenario, verifyLayer } from '../support/run.ts';
import { fieldFor, regionMotion, rgba } from '../support/pixel-fixtures.ts';
import type { FramePlan, Gray, Point, Region, ScanRecord } from '../../src/types.ts';
import { pad } from '../../src/core/math.ts';
// F7: the downscale truth is floor(x/factor); nativeWidth/nativeHeight are NOT exact multiples of factor here
// (3843 = 640×6+3, 1802 = 300×6+2), reproducing a mask bbox that touches the last analysis row/column while the
// native image still has a few trailing rows/columns beyond it.
Deno.test('layers: non-divisible native geometry owns every content pixel; regionContains matches floor(x/factor)', () => {
  const factor = 6, aw = 640, ah = 300;
  const left = makeWorld(300, 1400, 21, 'cards'), right = makeWorld(300, 1400, 22, 'article');
  const gl = core().grayscale(left.data, 300, 1400), gr = core().grayscale(right.data, 300, 1400);
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
  try {
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
  } finally {
    atlas.dispose();
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
  try {
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
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
// F7 end-to-end: a 1080p-class desktop capture whose HEIGHT is not an exact multiple of the analysis factor
// (1082 / 4 = 270.5, matching 'factor4' in scenarios.ts but with a non-divisible height), run through the whole
// scan → solve → render pipeline, not just LayerLearner.finish() in isolation. The path is monotonic (unlike
// 'factor4', which reverses direction): a reversal deep in repeating 'cards' content lands the frame-to-frame
// odometry on a period-aliased candidate ~670px away — reproducible identically at the divisible height 1080
// and with other world seeds, i.e. a pre-existing motion-matching ambiguity unrelated to factor divisibility —
// and would make this test assert something it isn't measuring.
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
  try {
    assertEquals(run.project.status, 'complete', run.project.error);
    assertEquals(run.engine.factor, 4);
    const result = await verifyLayer(run, layer);
    assertEquals(result.maxError, 0, `errors=${JSON.stringify(result.errors)}`);
    assertEquals(result.missing, 0);
    assertEquals(result.invented, 0);
    assertEquals(result.mismatched, 0);
    assertEquals(result.fragments.length, 0);
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
Deno.test('layers: learner separates a stationary band from scrolling content with native-precision edges', () => {
  const page = makeWorld(400, 1200, 9, 'article'), header = new Uint8Array(400 * 37).fill(30);
  for (let i = 0; i < header.length; i += 7) {
    header[i] = 200;
  }
  const frame = (offset: number): Gray => {
    const data = new Uint8Array(400 * 300);
    data.set(header);
    const g = core().grayscale(page.data, 400, 1200);
    for (let y = 37; y < 300; y++) {
      data.set(g.data.subarray((offset + y - 37) * 400, (offset + y - 37) * 400 + 400), y * 400);
    }
    return { width: 400, height: 300, data };
  };
  const learner = new LayerLearner(400, 300);
  let prev = frame(0);
  for (let i = 1; i < 12; i++) {
    const cur = frame(i * 23);
    learner.add(fieldFor(prev, cur), prev, cur, rgba(prev), rgba(cur));
    prev = cur;
  }
  const regions = learner.finish(400, 300);
  const fixed = regions.find((r) => r.kind === 'fixed'), moving = regions.find((r) => r.kind === 'moving');
  assert(fixed && moving);
  assertEquals(fixed.rect.height, 37);
  assertEquals(moving.rect.y, 37);
  assert(fixed.solid && fixed.crop && fixed.crop.height === 37);
  assert(regionContains(fixed, 10, 36, 400, 300) && !regionContains(fixed, 10, 37, 400, 300));
  assert(regionContains(moving, 10, 37, 400, 300) && !regionContains(moving, 10, 36, 400, 300));
  const atlas = new RegionAtlas(regions, 400, 300);
  try {
    assertEquals(atlas.count(atlas.code(fixed)), 400 * 37);
    assertEquals(atlas.count(atlas.code(moving)), 400 * 263);
    assert(!atlas.contains(atlas.code(moving), -1, 50) && !atlas.contains(atlas.code(moving), 10, 300));
    assertThrows(() => atlas.code({ id: 'x', name: 'x', kind: 'moving', rect: { x: 0, y: 0, width: 1, height: 1 } }));
  } finally {
    atlas.dispose();
  }
  assertEquals(
    regionMotion(
      {
        motions: [{ x: 0, y: 0, support: 0, unique: 0, confidence: 0, error: 0, ambiguous: false }],
        labels: new Uint8Array(1),
        confidence: new Uint8Array(1),
        dynamic: new Uint8Array(1),
        cols: 1,
        rows: 1,
        cell: 24,
        difference: 0,
        featureCount: 0,
        unknown: false,
        zoom: 1,
      },
      fixed,
      400,
      300,
    ).confidence,
    1,
  );
});
Deno.test('layers: uninformative input yields a single moving region; manual regions keep unassigned pixels explicit', () => {
  const learner = new LayerLearner(100, 100), blank = { width: 100, height: 100, data: new Uint8Array(10000).fill(200) };
  learner.add(fieldFor(blank, blank), blank, blank);
  const regions = learner.finish(200, 200);
  assertEquals(regions.length, 1);
  assertEquals(regions[0].kind, 'moving');
  const manual = new LayerLearner(100, 100).finish(200, 200, [{
    id: 'a',
    name: 'body',
    kind: 'moving',
    rect: { x: 20, y: 20, width: 100, height: 100 },
  }, { id: 'b', name: 'ignore', kind: 'ignore', rect: { x: 40, y: 40, width: 20, height: 20 } }]);
  const body = manual[0], unknown = manual.find((r) => r.unassigned)!;
  assert(regionContains(body, 30, 30, 200, 200));
  assert(!regionContains(body, 45, 45, 200, 200));
  assert(regionContains(unknown, 180, 180, 200, 200));
  assert(!regionContains(unknown, 30, 30, 200, 200));
  const full = new LayerLearner(100, 100).finish(200, 200, [{
    id: 'a',
    name: 'body',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 200, height: 200 },
  }]);
  assertEquals(full.length, 1);
  const region: Region = {
    id: 'r',
    name: 'r',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    mask: new Uint8Array([1, 0, 0, 1]),
    maskWidth: 2,
    maskHeight: 2,
  };
  assert(regionContains(region, 1, 1, 10, 10) && !regionContains(region, 8, 1, 10, 10));
  const atlas = new RegionAtlas([region], 10, 10);
  try {
    assertEquals(atlas.count(1), 50);
    assertThrows(() => new RegionAtlas(Array.from({ length: 255 }, (_, i) => ({ ...region, id: String(i) })), 10, 10));
  } finally {
    atlas.dispose();
  }
});
Deno.test('layers: two independently moving panes are split at a native-precision divider', () => {
  const left = makeWorld(300, 1400, 21, 'cards'), right = makeWorld(300, 1400, 22, 'article');
  const gl = core().grayscale(left.data, 300, 1400), gr = core().grayscale(right.data, 300, 1400);
  const frame = (a: number, b: number): Gray => {
    const data = new Uint8Array(640 * 300).fill(60);
    for (let y = 0; y < 300; y++) {
      data.set(gl.data.subarray((a + y) * 300, (a + y) * 300 + 300), y * 640);
      data.set(gr.data.subarray((b + y) * 300, (b + y) * 300 + 300), y * 640 + 335);
    }
    return { width: 640, height: 300, data };
  };
  const learner = new LayerLearner(640, 300);
  let prev = frame(0, 0);
  for (let i = 1; i < 16; i++) {
    const cur = frame(i * 17, i < 8 ? 0 : (i - 7) * 11);
    learner.add(fieldFor(prev, cur), prev, cur, rgba(prev), rgba(cur));
    prev = cur;
  }
  const regions = learner.finish(640, 300), moving = regions.filter((r) => r.kind === 'moving');
  assertEquals(moving.length, 2, JSON.stringify(regions.map((r) => [r.kind, r.rect])));
  const [l, r] = moving.sort((a, b) => a.rect.x - b.rect.x);
  assert(l.rect.x + l.rect.width <= 300 + 1 && r.rect.x >= 335 - 1, JSON.stringify([l.rect, r.rect]));
});
// Moved from takeover.test.ts (redistributed by subject): appearance-boundary and sticky-toolbar tests belong with
// the layers module (stationaryBoundary/stickyOcclusions live in src/core/layers.ts), and the sparse traversal
// end-to-end run below exercises the region atlas built from the same module.
function sparseScenario(): Scenario {
  const width = 1536, height = 960, viewport = { x: 112, y: 80, width: 1304, height: 824 };
  const world = new World(1800, 2200, [255, 255, 255]), column = makeWorld(680, 2200, 211, 'article');
  for (let y = 0; y < 2200; y++) world.data.set(column.data.subarray(y * 680 * 4, (y + 1) * 680 * 4), (y * 1800 + 370) * 4);
  const path = [
    { x: 0, y: 0 },
    { x: 17, y: 51 },
    { x: 38, y: 113 },
    { x: 81, y: 179 },
    { x: 149, y: 231 },
    { x: 127, y: 189 },
    { x: 79, y: 129 },
    { x: 31, y: 69 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 71, y: 75 },
    { x: 111, y: 135 },
    { x: 81, y: 211 },
    { x: 19, y: 275 },
  ];
  return {
    name: 'sparse-four-sided-random-walk',
    description: 'High-resolution narrow content with wide white gutters and four fixed sides; odd 2D movements and exact duplicates.',
    width,
    height,
    background: [30, 45, 54],
    layers: [{ id: 'body', viewport, world, path }],
    overlays: [
      fixedBand('top', { x: 0, y: 0, width, height: 80 }, 1),
      fixedBand('bottom', { x: 0, y: 904, width, height: 56 }, 2),
      fixedBand('left', { x: 0, y: 80, width: 112, height: 824 }, 3, [30, 45, 54]),
      fixedBand('right', { x: 1416, y: 80, width: 120, height: 824 }, 4, [38, 45, 61]),
    ],
    frames: constantFrames(path.length, 30),
    expect: { fragments: { body: 0 }, diagnostics: { present: [], absent: [] }, maxError: 0, status: 'complete' },
  };
}
Deno.test('takeover: high-resolution sparse 2D traversal preserves full pane, gutters, and all four frame sides', async () => {
  const scenario = sparseScenario(), run = await runScenario(scenario, { framing: 'context' }), layer = scenario.layers[0];
  try {
    assertEquals(run.project.status, 'complete', run.project.error);
    const result = await verifyLayer(run, layer);
    await Deno.mkdir('test-results', { recursive: true });
    await Deno.writeTextFile(
      'test-results/takeover-geometry.json',
      JSON.stringify(
        {
          verification: result,
          regions: run.regions.map(({ mask: _mask, cells: _cells, ...r }) => r),
          performance: await run.store.get('performance'),
        },
        null,
        2,
      ),
    );
    assertEquals(result.maxError, 0);
    assertEquals(result.missing, 0);
    assertEquals(result.invented, 0);
    assertEquals(result.mismatched, 0);
    const moving = run.regions.find((r) => r.id === result.regionId)!;
    assertEquals(moving.rect, layer.viewport);
    const atlas = new RegionAtlas(run.regions, scenario.width, scenario.height);
    try {
      assertEquals(atlas.count(atlas.code(moving)), layer.viewport.width * layer.viewport.height);
    } finally {
      atlas.dispose();
    }
    assertEquals(run.observations.length, scenario.frames.length);
    const framed = run.canvases.find((c) => c.presentation?.sourceCanvas === result.mainCanvas.id);
    assert(framed?.presentation);
    assertEquals(framed.bounds.width, result.mainCanvas.bounds.width + 112 + 120);
    assertEquals(framed.bounds.height, result.mainCanvas.bounds.height + 80 + 56);
    const stats = await run.store.get<{ exactDuplicateFrames: number; skippedPaints: number }>('performance');
    assert(stats && stats.exactDuplicateFrames >= 3 && stats.skippedPaints >= 3);
    const scan = await run.store.get<ScanRecord>(`scan/${pad(9)}`), plan = await run.store.get<FramePlan>(`plan/${pad(9)}`);
    assert(scan?.duplicate && plan?.duplicate);
    assertEquals(run.memory.peakResidentTiles <= run.memory.tileCacheLimit, true);
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
Deno.test('takeover: appearance boundaries require a persistent edge; blank gutters alone offer no boundary', () => {
  const s = sparseScenario(), image = renderFrame(s, 0).image;
  assertEquals(stationaryBoundary(image, 'x', 90, 200, 100, 890, 'last'), 112);
  assertEquals(stationaryBoundary(image, 'x', 170, 250, 100, 890, 'first'), undefined);
  assertEquals(stationaryBoundary(image, 'y', 60, 95, 120, 1400, 'last'), 80);
  const region: Region = { id: 'p', name: 'p', kind: 'moving', rect: s.layers[0].viewport };
  assertEquals(stickyOcclusions(image, image, region, { x: 0, y: 0 }), []);
});
Deno.test('takeover: sticky toolbar evidence survives a pause but not a changed or removed toolbar', () => {
  const world = makeWorld(600, 900, 731, 'article');
  const make = (dy: number) => {
    const data = new Uint8ClampedArray(600 * 400 * 4);
    for (let y = 0; y < 400; y++) data.set(world.data.subarray((y + dy) * 600 * 4, (y + dy + 1) * 600 * 4), y * 600 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 600; x++) {
        const glyph = y > 17 && y < 39 && x > 40 && x < 530 && x % 17 < 8;
        data.set(y === 63 ? [20, 20, 20, 255] : glyph ? [50, 50, 50, 255] : [230, 230, 230, 255], (y * 600 + x) * 4);
      }
    }
    return { width: 600, height: 400, data };
  };
  const region: Region = { id: 'p', name: 'p', kind: 'moving', rect: { x: 0, y: 0, width: 600, height: 400 } };
  const a = make(0), b = make(35), masks = stickyOcclusions(a, b, region, { x: 0, y: 35 });
  assertEquals(masks, [{ x: 0, y: 0, width: 600, height: 64 }]);
  const paused = make(35);
  paused.data[(390 * 600 + 42) * 4] ^= 1;
  assertEquals(stickyOcclusions(b, paused, region, { x: 0, y: 0 }, masks), masks);
  paused.data[(25 * 600 + 80) * 4] ^= 1;
  assertEquals(stickyOcclusions(b, paused, region, { x: 0, y: 0 }, masks), []);
  assertEquals(stickyOcclusions(b, { ...paused, width: 601 }, region, { x: 0, y: 35 }, masks), []);
  assertEquals(stickyOcclusions(b, b, region, { x: 0, y: 0 }, [{ x: -1, y: 0, width: 601, height: 64 }]), []);
});
// Moved from geometry.test.ts (renamed pose-graph.test.ts; these two were not pose-graph tests): fragment
// attach/loop-closure and per-pane zoom both belong with the layers/region module they exercise end to end.
// Points strictly between `from` and `to` at `step` spacing, then `to` itself — used to build a continuous scroll leg
// without duplicating the previous leg's endpoint (which would insert a spurious zero-motion frame at the seam).
function ramp(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  if (to > from) {
    for (let y = from + step; y < to; y += step) out.push(y);
  } else {
    for (let y = from - step; y > to; y -= step) out.push(y);
  }
  out.push(to);
  return out;
}
function attachLoopScenario(): Scenario {
  const W = 640, H = 448, HEADER = 48, viewport = { x: 0, y: HEADER, width: W, height: H - HEADER };
  const world = makeWorld(900, 3400, 331, 'article');
  // 1) continuous scroll 0→960 (keyframes minted every ~120px of travel on a 640×400 pane).
  // 2) a single no-overlap jump to y=2400 (UNPLACED_FRAGMENT: a brand new, unlocated fragment).
  // 3) continuous scroll back UP 2400→840, still tracked frame-to-frame the whole way (never lost), so the fragment
  //    re-enters the main canvas's observed territory and a keyframe-mint's global search finds a main-canvas keyframe
  //    (FRAGMENT_ATTACHED).
  // 4) continue up to 180: pure revisits of the main canvas's own territory (LOOP_CLOSURE).
  // 5) scroll back DOWN to 2580: passes back through the territory the fragment observed in (2)/(3) before it was
  //    attached — those keyframes still carry the fragment's raw (pre-attach) canvasId, exercising the canonical-space
  //    fixes (A1/A3/A4/A6).
  const ys = [0, ...ramp(0, 960, 60), 2400, ...ramp(2400, 840, 60), ...ramp(840, 180, 60), ...ramp(180, 2580, 60)];
  const path = ys.map((y) => ({ x: 0, y }));
  return {
    name: 'attach-then-loop',
    description: '独立滚动片段先无重叠跳转，再连续回滚重新接回主画布，随后继续回访主画布及已接回片段各自的历史区域。',
    width: W,
    height: H,
    background: [251, 250, 246],
    layers: [{ id: 'body', viewport, world, path }],
    overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 41)],
    frames: constantFrames(path.length, 30),
    expect: { fragments: {}, diagnostics: { present: [], absent: [] }, maxError: 0, status: 'complete' },
  };
}
Deno.test('geometry: a no-overlap jump that tracks back into view attaches to the main canvas, then closes loops on both sides of the seam', async () => {
  const scenario = attachLoopScenario(), run = await runScenario(scenario), layer = scenario.layers[0];
  try {
    assertEquals(run.project.status, 'complete', run.project.error);
    if (!run.codes.has('UNPLACED_FRAGMENT') || !run.codes.has('FRAGMENT_ATTACHED')) {
      console.log(
        'geometry/attach-then-loop diagnostics:',
        run.diagnostics.map((d) => ({ code: d.code, frame: d.frame, canvasId: d.canvasId })),
      );
    }
    assert(run.codes.has('UNPLACED_FRAGMENT'), `expected UNPLACED_FRAGMENT; got ${[...run.codes].join(',')}`);
    assert(run.codes.has('FRAGMENT_ATTACHED'), `expected FRAGMENT_ATTACHED; got ${[...run.codes].join(',')}`);
    const attach = run.diagnostics.find((d) => d.code === 'FRAGMENT_ATTACHED')!;
    const loopsAfterAttach = run.diagnostics.filter((d) => d.code === 'LOOP_CLOSURE' && (d.frame ?? -1) > (attach.frame ?? Infinity));
    assert(
      loopsAfterAttach.length > 0,
      `expected a LOOP_CLOSURE after the attach frame (${attach.frame}); loop closures at: ${
        run.diagnostics.filter((d) => d.code === 'LOOP_CLOSURE').map((d) => d.frame).join(',')
      }`,
    );
    const result = await verifyLayer(run, layer);
    if (result.maxError !== 0 || result.missing !== 0 || result.invented !== 0 || result.mismatched !== 0) {
      console.log('geometry/attach-then-loop verifyLayer:', result);
      console.log(
        'geometry/attach-then-loop diagnostics:',
        run.diagnostics.map((d) => ({ code: d.code, frame: d.frame, canvasId: d.canvasId, detail: d.detail })),
      );
    }
    assertEquals(result.maxError, 0);
    assertEquals(result.missing, 0);
    assertEquals(result.invented, 0);
    assertEquals(result.mismatched, 0);
    const fragment = run.canvases.find((c) => c.layer === result.regionId && c.fragment > 0);
    assert(fragment, 'no fragment canvas was ever created');
    assertEquals(fragment!.attachedTo, result.mainCanvas.id);
    assertEquals(fragment!.tileCount, 0, 'an attached fragment must hold no tiles of its own');
    for (const o of run.observations) {
      const d = o.decisions.find((x) => x.placement.layer === result.regionId);
      assert(d, `frame ${o.frame}: no decision recorded for layer ${result.regionId}`);
      if (d!.skipped) {
        continue;
      }
      assertEquals(
        d!.canvasId,
        result.mainCanvas.id,
        `frame ${o.frame}: resolved to ${d!.canvasId}, expected the main canvas ${result.mainCanvas.id}`,
      );
    }
    const summary = await run.store.get<{ residual: number }>('graph-summary');
    assert(summary, 'no graph-summary was written');
    assert(summary!.residual < 1, `graph residual ${summary!.residual} is too high`);
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
function paneZoomScenario(): Scenario {
  const W = 640, H = 448, HEADER = 48;
  // Same two-pane geometry as the 'panes' scenario (proven to split into independent moving regions): reusing its
  // exact path shape and seeds avoids reproducing the region-learner's split heuristics from scratch.
  const left = makeWorld(318, 2400, 71, 'cards'), right = makeWorld(318, 2600, 72, 'article');
  const n = 75, lp: Point[] = [], rp: Point[] = [];
  for (let i = 0; i < n; i++) {
    lp.push({ x: 0, y: i < 35 ? i * 8 : 280 - (i - 35) * 5 });
    rp.push({ x: 0, y: i < 20 ? 0 : (i - 20) * 7 });
  }
  // Gradual zoom on the right pane only, well after both panes are established: four measurable steps (6/6/6/5%) so
  // per-frame scale evidence is real, then holds.
  const zoom = Array.from({ length: n }, (_, i) => i < 60 ? 1 : i === 60 ? 1.06 : i === 61 ? 1.12 : i === 62 ? 1.19 : 1.25);
  const divider: Overlay = {
    id: 'divider',
    kind: 'fixed',
    draw: (frame) => {
      const r = { x: 318, y: HEADER, width: 4, height: H - HEADER };
      fillRGBA(frame, r, [57, 67, 55]);
      return [r];
    },
  };
  return {
    name: 'pane-zoom',
    description: '右侧 pane 渐进式缩放，左侧 pane 继续独立滚动，互不影响。',
    width: W,
    height: H,
    background: [251, 250, 246],
    layers: [
      { id: 'left', viewport: { x: 0, y: HEADER, width: 318, height: H - HEADER }, world: left, path: lp },
      { id: 'right', viewport: { x: 322, y: HEADER, width: 318, height: H - HEADER }, world: right, path: rp, zoom },
    ],
    overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 42), divider],
    frames: constantFrames(n, 30),
    expect: { fragments: {}, diagnostics: { present: [], absent: [] }, maxError: 0, status: 'complete' },
  };
}
Deno.test('geometry: a per-pane zoom fragments only the zooming pane, not its co-scrolling sibling', async () => {
  const scenario = paneZoomScenario(), run = await runScenario(scenario);
  try {
    assertEquals(run.project.status, 'complete', run.project.error);
    const leftResult = await verifyLayer(run, scenario.layers[0]), rightResult = await verifyLayer(run, scenario.layers[1]);
    if (leftResult.fragments.length || leftResult.maxError || leftResult.missing || leftResult.invented || leftResult.mismatched) {
      console.log(
        'geometry/pane-zoom left:',
        leftResult,
        run.diagnostics.filter((d) => d.canvasId?.startsWith(`${leftResult.regionId}-part-`)),
      );
    }
    assertEquals(leftResult.fragments.length, 0, `left pane fragmented: ${leftResult.fragments.map((c) => c.id).join(',')}`);
    assertEquals(leftResult.maxError, 0);
    assertEquals(leftResult.missing, 0);
    assertEquals(leftResult.invented, 0);
    assertEquals(leftResult.mismatched, 0);
    const leftBad = run.diagnostics.filter((d) =>
      (d.code === 'SCALE_CHANGE_FRAGMENT' || d.code === 'UNPLACED_FRAGMENT') && d.canvasId?.startsWith(`${leftResult.regionId}-part-`)
    );
    assertEquals(leftBad.length, 0, `left pane got a fragmentation diagnostic meant for the zooming pane: ${JSON.stringify(leftBad)}`);
    assert(rightResult.fragments.length >= 1, 'right pane did not fragment when it zoomed');
    assert(run.codes.has('SCALE_CHANGE_FRAGMENT'), `expected SCALE_CHANGE_FRAGMENT for the zooming pane; got ${[...run.codes].join(',')}`);
  } finally {
    // run.atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer that nothing else frees.
    run.dispose();
  }
});
