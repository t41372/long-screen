import { assert, assertEquals } from '@std/assert';
import { constantFrames, makeWorld, renderFrame, type Scenario, World } from '../../src/synthetic/world.ts';
import { fixedBand } from '../../src/synthetic/scenarios.ts';
import { runScenario, verifyLayer } from '../support/run.ts';
import { RegionAtlas, stationaryBoundary, stickyOcclusions } from '../../src/core/layers.ts';
import { TileStore } from '../../src/storage/tiles.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import type { FramePlan, Region, ScanRecord } from '../../src/types.ts';
import { pad } from '../../src/core/math.ts';

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
  assertEquals(run.project.status, 'complete', run.project.error);
  const result = await verifyLayer(run, layer);
  await Deno.mkdir('test-results', { recursive: true });
  await Deno.writeTextFile(
    'test-results/takeover-geometry.json',
    JSON.stringify(
      {
        verification: result,
        regions: run.regions.map(({ mask, cells, ...r }) => r),
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
  assertEquals(atlas.count(atlas.code(moving)), layer.viewport.width * layer.viewport.height);
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
});
Deno.test('takeover: appearance boundaries require a persistent edge; blank gutters alone offer no boundary', () => {
  const s = sparseScenario(), image = renderFrame(s, 0).image;
  assertEquals(stationaryBoundary(image, 'x', 90, 200, 100, 890, 'last'), 112);
  assertEquals(stationaryBoundary(image, 'x', 170, 250, 100, 890, 'first'), undefined);
  assertEquals(stationaryBoundary(image, 'y', 60, 95, 120, 1400, 'last'), 80);
  const region: Region = { id: 'p', name: 'p', kind: 'moving', rect: s.layers[0].viewport };
  assertEquals(stickyOcclusions(image, image, region, { x: 0, y: 0 }), []);
});
Deno.test('takeover: render cache rebalance avoids a viewport-sized cyclic eviction trap without an unbounded cache', async () => {
  const tiles = new TileStore(new MemoryKV(), 512, 128), before = tiles.maxTiles;
  tiles.configureBudget(128, 3456 * 2234 * 5 + 16 * 1024 * 1024);
  assert(tiles.maxTiles > before);
  for (let i = 0; i < tiles.maxTiles + 3; i++) await tiles.get('c', i, 0);
  assertEquals(tiles.peakResidentTiles, tiles.maxTiles);
  assertEquals(tiles.evictions, 3);
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
