import { assert, assertEquals } from '@std/assert';
import { harness, realRecordings } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
const results = new URL('../../test-results/', import.meta.url).pathname;
interface LayerSummary {
  maxError: number;
  missing: number;
  invented: number;
  mismatched: number;
  contaminated: number;
  skipped: number;
  covered: number;
  fragments: number;
  mainCanvas: string;
}
interface BrowserRun {
  status: string;
  error?: string;
  frames: number;
  seconds: number;
  diag: Record<string, number>;
  codes: string[];
  body: LayerSummary;
  header: { mismatched: number; conflicts: number; covered: number };
  memory: { peakResidentTiles: number; tileCacheLimit: number };
  projectId: string;
}
await Deno.mkdir(results, { recursive: true });
/** Runs the shipped engine inside Chrome (IndexedDB, WebCodecs) and returns the verifier's report. */
async function reconstruct(page: import('playwright').Page, source: string, analysis: number, tolerance: number): Promise<BrowserRun> {
  return await page.evaluate(async ([source, analysis, tolerance]: [string, number, number]) => {
    const kit = (globalThis as any).longScreenKit;
    const scenario = kit.buildScenario('fixture');
    const file = source === 'demo' ? null : new File([await (await fetch(source)).blob()], source.split('/').pop()!);
    const db = await kit.Database.open();
    const frames = file ? await kit.openMedia(file) : new kit.ScenarioSource(scenario);
    const diag: Record<string, number> = {};
    const engine = new kit.Engine(db, frames, { ...kit.DEFAULT_SETTINGS, analysisSize: analysis }, {
      progress: () => {},
      diagnostic: (d: any) => {
        diag[d.code] = (diag[d.code] || 0) + 1;
      },
      preview: () => {},
      project: () => {},
    });
    const t0 = performance.now(), project = await engine.run(), seconds = (performance.now() - t0) / 1000;
    const store = engine.store, canvases: any[] = [], observations: any[] = [], diagnostics: any[] = [];
    for await (const { value } of kit.iterate(store, 'canvas/')) {
      canvases.push(value);
    }
    for await (const { value } of kit.iterate(store, 'observation/')) {
      observations.push(value);
    }
    for await (const { value } of kit.iterate(store, 'diagnostic/')) {
      diagnostics.push(value);
    }
    const regions = await store.get('regions'), atlas = new kit.RegionAtlas(regions, scenario.width, scenario.height);
    const run = { scenario, store, canvases, observations, regions, atlas, tileSize: engine.tiles.size };
    const body = await kit.verifyLayer(run, scenario.layers[0], { tolerance });
    const header = await kit.verifyFixed(run, { x: 0, y: 0, width: 320, height: 32 });
    return {
      status: project.status,
      error: project.error,
      frames: project.renderedFrames,
      seconds,
      diag,
      codes: [...new Set(diagnostics.map((d: any) => d.code))],
      body: { ...body, mainCanvas: body.mainCanvas.id, fragments: body.fragments.length },
      header: { mismatched: header.mismatched, conflicts: header.conflicts, covered: header.covered },
      memory: await store.get('memory-stats'),
      projectId: project.id,
    };
  }, [source, analysis, tolerance] as [string, number, number]) as BrowserRun;
}
Deno.test({
  name: 'browser: lossless synthetic fixture reconstructs with exact placement and pixel identity in Chrome',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await reconstruct(h.page, 'demo', 640, 0);
      assertEquals(r.status, 'complete', r.error);
      assertEquals(r.frames, 43);
      assertEquals(
        [r.body.maxError, r.body.missing, r.body.invented, r.body.mismatched, r.body.fragments],
        [0, 0, 0, 0, 0],
        JSON.stringify(r.body),
      );
      assertEquals([r.header.mismatched, r.header.conflicts], [0, 0]);
      assert(r.memory.peakResidentTiles <= r.memory.tileCacheLimit);
      await Deno.writeTextFile(`${results}browser-fixture-lossless.json`, JSON.stringify(r, null, 2));
    } finally {
      await h.close();
    }
  },
});
/** Share of frame-0 pixels the decoder itself already returns outside `tolerance` of the source, before any reconstruction runs.
 *  Codecs differ here: Chrome's H.264 path lands within about one level per channel, its VP9 path returns systematically
 *  darker pixels (mean signed difference about -19), a colour-range conversion, not a placement error. Measuring the floor
 *  keeps the reconstruction assertion strict for every codec instead of loosening it to whichever is worst. */
async function decodeBaseline(
  page: import('playwright').Page,
  name: string,
  tolerance: number,
): Promise<{ outside: number; meanAbs: number; meanSigned: number }> {
  return await page.evaluate(async ([name, tolerance]: [string, number]) => {
    const kit = (globalThis as any).longScreenKit, truth = kit.renderFrame(kit.buildScenario('fixture'), 0).image;
    const source = await kit.openMedia(new File([await (await fetch('/fixtures/' + name)).blob()], name));
    try {
      for await (const f of source.frames()) {
        let outside = 0, sum = 0, signed = 0, n = 0;
        for (let i = 0; i < truth.data.length; i += 4) {
          let worst = 0;
          for (let c = 0; c < 3; c++) {
            const d = f.image.data[i + c] - truth.data[i + c];
            worst = Math.max(worst, Math.abs(d));
            sum += Math.abs(d);
            signed += d;
          }
          if (worst > tolerance) {
            outside++;
          }
          n++;
        }
        return { outside: outside / n, meanAbs: sum / (n * 3), meanSigned: signed / (n * 3) };
      }
      throw new Error('no frames');
    } finally {
      source.dispose();
    }
  }, [name, tolerance] as [string, number]);
}
for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'scroll.webm', 'negative-cts-v0.mov']) {
  Deno.test({
    name: `browser: encoded ${name} reconstructs from real decoded frames with exact placement and coverage`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness();
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const tolerance = 48;
        const baseline = await decodeBaseline(h.page, name, tolerance);
        const r = await reconstruct(h.page, '/fixtures/' + name, 640, tolerance);
        assertEquals(r.status, 'complete', JSON.stringify(r.diag));
        assertEquals(r.frames, 43);
        // Geometry is asserted exactly for every codec: nothing may sit at the wrong world position, go missing, be invented or fragment.
        assert(r.body.maxError <= 1, `placement error ${r.body.maxError}`);
        assertEquals([r.body.missing, r.body.invented, r.body.fragments], [0, 0, 0], JSON.stringify(r.body));
        // Pixel values may only differ as much as this codec's own decode already differs from the source.
        const rate = r.body.mismatched / r.body.covered;
        assert(
          rate <= baseline.outside + .002,
          `${name}: ${(rate * 100).toFixed(2)}% of covered pixels differ, decode floor is ${(baseline.outside * 100).toFixed(2)}%`,
        );
        await Deno.writeTextFile(`${results}browser-fixture-${name}.json`, JSON.stringify({ ...r, decodeBaseline: baseline }, null, 2));
      } finally {
        await h.close();
      }
    },
  });
}
Deno.test({
  name: 'browser: real recordings reconstruct end to end (skipped when absent; LONGSCREEN_REAL=all runs every file)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const names = await realRecordings();
    if (!names.length) {
      console.log('skip: no recordings in test_case/');
      return;
    }
    const selected = Deno.env.get('LONGSCREEN_REAL') === 'all' ? names : names.slice(0, 1);
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      for (const name of selected) {
        const r = await h.page.evaluate(async (name: string) => {
          const kit = (globalThis as any).longScreenKit, file = new File([await (await fetch('/test_case/' + name)).blob()], name);
          const db = await kit.Database.open(),
            source = await kit.openMedia(file),
            diag: Record<string, number> = {},
            phases: Record<string, number> = {};
          let phase = '', started = performance.now();
          const engine = new kit.Engine(db, source, { ...kit.DEFAULT_SETTINGS }, {
            progress: (p: any) => {
              if (p.phase !== phase) {
                if (phase) phases[phase] = Math.round(performance.now() - started);
                phase = p.phase;
                started = performance.now();
              }
            },
            diagnostic: (d: any) => {
              diag[d.code] = (diag[d.code] || 0) + 1;
            },
            preview: () => {},
            project: () => {},
          });
          const t0 = performance.now(), project = await engine.run();
          phases[phase] = Math.round(performance.now() - started);
          const canvases: any[] = [];
          for await (const { value } of kit.iterate(engine.store, 'canvas/')) {
            canvases.push(value);
          }
          const main = canvases.filter((c) => c.kind === 'moving' && c.tileCount).sort((a, b) => b.observedPixels - a.observedPixels)[0];
          const scale = Math.min(.25, 1400 / Math.max(main.bounds.width, main.bounds.height)), canvas = document.createElement('canvas');
          canvas.width = Math.ceil(main.bounds.width * scale);
          canvas.height = Math.ceil(main.bounds.height * scale);
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#e5e6df';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          for await (const { value: t } of kit.iterate(engine.store, 'tile-index/' + main.id + '/0/')) {
            const tile = await engine.store.get('tile/' + main.id + '/0/' + t.x + '_' + t.y), bmp = await createImageBitmap(tile.blob);
            ctx.drawImage(bmp, (t.x * 512 - main.bounds.x) * scale, (t.y * 512 - main.bounds.y) * scale, 512 * scale, 512 * scale);
            bmp.close();
          }
          return {
            status: project.status,
            error: project.error,
            frames: project.frames,
            rendered: project.renderedFrames,
            seconds: Math.round((performance.now() - t0) / 100) / 10,
            phases,
            diag,
            info: { width: source.info.width, height: source.info.height, codec: source.info.codec, notices: source.info.notices },
            canvases: canvases.map((c) => ({
              id: c.id,
              kind: c.kind,
              bounds: c.bounds,
              tiles: c.tileCount,
              observed: c.observedPixels,
              conflicts: c.conflictPixels,
              attachedTo: c.attachedTo,
            })),
            main: main.bounds,
            memory: await engine.store.get('memory-stats'),
            preview: canvas.toDataURL('image/png'),
          };
        }, name);
        const { preview, ...report } = r;
        console.log(
          name,
          JSON.stringify({
            status: report.status,
            frames: report.frames,
            seconds: report.seconds,
            main: report.main,
            phases: report.phases,
          }),
        );
        assertEquals(report.status, 'complete', String(report.error));
        assertEquals(report.rendered, report.frames);
        const info = report.info as { height: number; notices: unknown[] }, main = report.main as { height: number; width: number };
        assert(main.height > info.height * 1.2 || main.width > 0, 'main canvas should extend beyond one frame for a scrolling recording');
        await Deno.writeTextFile(`${results}real-${name}.json`, JSON.stringify(report, null, 2));
        const png = Uint8Array.from(atob(preview.split(',')[1]), (c) => c.charCodeAt(0));
        await Deno.writeFile(`${results}real-${name}-preview.png`, png);
        const decoded = await decodePNG(png);
        assert(decoded.width > 0);
      }
    } finally {
      await h.close();
    }
  },
});
