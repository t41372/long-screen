import { assertEquals } from '@std/assert';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { type Layer, makeWorld } from '../../src/synthetic/world.ts';
import { iterate } from '../../src/storage/db.ts';
import { pngTileCodec, type StoredTile, type TileIndex } from '../../src/storage/tiles.ts';
import { runScenario, verifyLayer } from '../support/run.ts';

// Failure case: the unchanged middle of a moving document widget separates its
// changing ends. Choosing the ends independently stretches a 140 px slider to
// 190 px, a state absent from every input. The canvas must contain one whole moment.
Deno.test('components: a stationary middle does not split a document widget across moments', async () => {
  const world = makeWorld(800, 240, 133, 'article');
  const rect = { x: 80, y: 90, width: 280, height: 40 };
  world.fill(rect, [245, 244, 239]);
  const layer: Layer = {
    id: 'body',
    world,
    viewport: { x: 0, y: 0, width: 400, height: 240 },
    path: Array.from({ length: 24 }, (_, i) => ({ x: i * 5, y: 0 })),
    dynamics: [{
      rect,
      draw: (image, i) => image.fill({ x: 10 + [0, 50, 100, 50][i % 4], y: 8, width: 140, height: 12 }, [217, 33, 191]),
    }],
  };
  const scenario = {
    ...buildScenario('horizontal'),
    name: 'document-slider',
    width: 400,
    height: 240,
    overlays: [],
    layers: [layer],
    frames: Array.from({ length: 24 }, (_, i) => ({ time: i / 30, duration: 1 / 30 })),
  };
  const run = await runScenario(scenario, { ...scenario.settings, compute: 'cpu' });
  try {
    const report = await verifyLayer(run, layer);
    let count = 0;
    const xs = new Set<number>(), ys = new Set<number>();
    for await (const { value: tile } of iterate<TileIndex>(run.store, `tile-index/${report.mainCanvas.id}/0/`)) {
      const stored = (await run.store.get<StoredTile>(`tile/${report.mainCanvas.id}/0/${tile.x}_${tile.y}`))!;
      const pixels = await pngTileCodec.decode(stored.blob, run.tileSize);
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== 217 || pixels[i + 1] !== 33 || pixels[i + 2] !== 191 || !pixels[i + 3]) continue;
        count++;
        xs.add(tile.x * run.tileSize + (i / 4) % run.tileSize);
        ys.add(tile.y * run.tileSize + Math.floor(i / 4 / run.tileSize));
      }
    }
    await Deno.mkdir('test-results/component-moments', { recursive: true });
    await Deno.writeTextFile(
      'test-results/component-moments/document-slider.json',
      JSON.stringify(
        {
          command: 'deno test -A tests/unit/component-moments.test.ts',
          status: run.project.status,
          expected: { pixels: 1680, width: 140, height: 12 },
          actual: { pixels: count, width: xs.size, height: ys.size },
          maxError: report.maxError,
          missing: report.missing,
          invented: report.invented,
          mismatched: report.mismatched,
        },
        null,
        2,
      ),
    );
    assertEquals(run.project.status, 'complete');
    assertEquals(report.maxError, 0);
    assertEquals(report.missing, 0);
    assertEquals(report.invented, 0);
    assertEquals(report.mismatched, 0);
    assertEquals({ pixels: count, width: xs.size, height: ys.size }, { pixels: 1680, width: 140, height: 12 });
  } finally {
    run.dispose();
  }
});
