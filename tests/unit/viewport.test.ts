import { assertEquals } from '@std/assert';
import { type Layer, layerTranslation, renderFrame, World } from '../../src/synthetic/world.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { runScenario, verifyLayer } from '../support/run.ts';

// Failure cases for the truth model: a newly exposed strip is omitted, or moving the
// viewport origin is counted again as page motion. Native inputs must remain lossless.
Deno.test('viewport truth: expansion exposes new pixels without shifting shared content', () => {
  const world = new World(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      world.data.set([x, y, x ^ y, 255], (y * 32 + x) * 4);
    }
  }
  const layer: Layer = {
    id: 'body',
    world,
    viewport: { x: 2, y: 8, width: 16, height: 8 },
    viewports: [{ x: 2, y: 8, width: 16, height: 8 }, { x: 2, y: 4, width: 16, height: 12 }],
    path: [{ x: 3, y: 10 }, { x: 3, y: 6 }],
  };
  const original = buildScenario('toolbar-collapse');
  const scenario = { ...original, width: 20, height: 20, layers: [layer], overlays: [], frames: original.frames.slice(0, 2) };
  const before = renderFrame(scenario, 0).image, after = renderFrame(scenario, 1).image;
  const pixel = (data: Uint8ClampedArray, x: number, y: number) => [...data.slice((y * 20 + x) * 4, (y * 20 + x + 1) * 4)];
  assertEquals(pixel(after.data, 2, 4), [3, 6, 3 ^ 6, 255]);
  assertEquals(pixel(before.data, 2, 8), pixel(after.data, 2, 8));
  assertEquals(layerTranslation(layer, 0), { x: 3, y: 10 });
  assertEquals(layerTranslation(layer, 1), { x: 3, y: 10 });
});

// A header can be browser chrome or a document title that becomes sticky. When
// both produce the same recording, retrospective viewport inference must not
// discard the only observation of the document title. Keep this data-loss guard
// instead of accepting an improvement in the chrome-only invented-pixel metric.
Deno.test('viewport: identical recordings cannot justify discarding a unique sticky document title', async () => {
  const scenario = buildScenario('toolbar-collapse');
  const initial = renderFrame(scenario, 0).image, source = scenario.layers[0];
  const titleHeight = source.viewport.y;
  const world = new World(source.world.width, source.world.height + titleHeight);
  for (let y = 0; y < titleHeight; y++) {
    world.data.set(initial.data.subarray(y * scenario.width * 4, (y + 1) * scenario.width * 4), y * world.width * 4);
  }
  world.data.set(source.world.data, titleHeight * world.width * 4);
  const document: Layer = {
    ...source,
    world,
    viewport: { x: 0, y: 0, width: scenario.width, height: scenario.height },
    viewports: undefined,
    path: source.path.map((_, frame) => layerTranslation(source, frame)),
  };
  const alternative = {
    ...scenario,
    layers: [document],
    overlays: scenario.overlays.map((overlay) => ({
      ...overlay,
      draw: (...args: Parameters<typeof overlay.draw>) => args[1] === 0 ? [] : overlay.draw(...args),
    })),
  };
  for (let frame = 0; frame < scenario.frames.length; frame++) {
    assertEquals(renderFrame(alternative, frame).image.data, renderFrame(scenario, frame).image.data);
  }
  const result = await runScenario(scenario, scenario.settings);
  try {
    const v = await verifyLayer({ ...result, scenario: alternative }, document);
    await Deno.mkdir('test-results/viewport', { recursive: true });
    await Deno.writeTextFile(
      'test-results/viewport/sticky-document-title.json',
      JSON.stringify(
        {
          command: 'deno test -A tests/unit/viewport.test.ts',
          truth: 'toolbar-collapse recording, verified against a sticky document title world',
          status: result.project.status,
          frames: scenario.frames.length,
          framesOnMain: v.framesOnMain,
          maxError: v.maxError,
          missing: v.missing,
          invented: v.invented,
          mismatched: v.mismatched,
          contaminatedOverlayRecoverable: v.contaminatedOverlayRecoverable,
        },
        null,
        2,
      ),
    );
    assertEquals(result.project.status, 'complete');
    assertEquals(v.framesOnMain, scenario.frames.length);
    assertEquals(v.maxError, 0);
    assertEquals(v.missing, 0, 'the initial document title has no later unobscured observation');
    assertEquals(v.mismatched, 0);
    assertEquals(v.contaminatedOverlayRecoverable, 0);
  } finally {
    result.dispose();
  }
});
