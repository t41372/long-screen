import { assert, assertEquals } from '@std/assert';
import { harness, root } from './support.ts';

// Exercise decoded-page ownership, opacity barriers and IndexedDB with native ground truth in both
// browser engines. The JSON and exported PNG make this an inspectable reconstruction, not just a run.
for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser ${browser}: deferred floating sources preserve clean pixels and export a native PNG`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const report = await h.page.evaluate(async () => {
          const kit = (globalThis as any).longScreenKit;
          const scenario = kit.buildScenario('floating'), db = await kit.Database.open();
          const engine = new kit.Engine(db, new kit.ScenarioSource(scenario), { ...kit.DEFAULT_SETTINGS, ...scenario.settings }, {
            progress: () => {},
            diagnostic: () => {},
            project: () => {},
          });
          const project = await engine.run(), store = engine.store;
          const canvases = [], observations = [];
          for await (const { value } of kit.iterate(store, 'canvas/')) canvases.push(value);
          for await (const { value } of kit.iterate(store, 'observation/')) observations.push(value);
          const regions = await store.get('regions'), atlas = new kit.RegionAtlas(regions, scenario.width, scenario.height);
          try {
            const truth = await kit.verifyLayer(
              { scenario, store, canvases, observations, regions, atlas, tileSize: engine.tiles.size },
              scenario.layers[0],
            );
            let provenance = 0;
            for await (const _ of kit.iterate(store, 'source-provenance/')) provenance++;
            const exported = await kit.exportCanvas(store, project, truth.mainCanvas, () => {}, undefined, 'single');
            const url = URL.createObjectURL(exported.blob);
            (globalThis as any).sourceTestPNG = url;
            return {
              status: project.status,
              error: project.error,
              frames: project.renderedFrames,
              maxError: truth.maxError,
              missing: truth.missing,
              invented: truth.invented,
              mismatched: truth.mismatched,
              contaminatedOverlay: truth.contaminatedOverlay,
              provenance,
              sources: await store.get('source-summary'),
              core: kit.corePlan,
            };
          } finally {
            atlas.dispose();
            await engine.tiles.clear();
          }
        });
        assertEquals(report.status, 'complete', report.error);
        assertEquals([report.maxError, report.missing, report.invented, report.mismatched, report.contaminatedOverlay], [0, 0, 0, 0, 0]);
        assert(report.provenance > 0 && report.sources.completed && report.sources.opacity.fields > 0);
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
        const out = `${root}test-results/source-optimization/browser-${browser}`;
        await Deno.mkdir(`${root}test-results/source-optimization`, { recursive: true });
        await Deno.writeTextFile(out + '.json', JSON.stringify(report, null, 2));
        const [download] = await Promise.all([
          h.page.waitForEvent('download'),
          h.page.evaluate(() => {
            const a = document.createElement('a');
            a.href = (globalThis as any).sourceTestPNG;
            a.download = 'floating.png';
            a.click();
          }),
        ]);
        await download.saveAs(out + '.png');
        assertEquals(await download.failure(), null);
      } finally {
        await h.close();
      }
    },
  });
}
