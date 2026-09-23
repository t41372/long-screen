import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
// The device check page end to end, as a user runs it on a phone or Mac: environment, raw transfer costs, the GPU
// analysis kernel against the core on frame-sized images, and the full pipeline on a real recording with the
// analysis downscale forced to CPU and then to WebGPU — the stored tiles (PNG + every evidence array) must match.
Deno.test({
  name: 'browser: device check reports GPU parity and an identical CPU / WebGPU pipeline on a real recording',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ webgpu: true });
    try {
      // 320×240 is below the default analysis size; 160 makes the analysis factor 2 so the GPU kernel runs.
      await h.page.goto(h.base + '/device-check.html?analysisSize=160');
      await h.page.locator('#recording').setInputFiles(new URL('../fixtures/scroll.mp4', import.meta.url).pathname);
      await h.page.click('#run');
      await h.page.waitForFunction(() => document.title === 'Device check — done', undefined, { timeout: 240000 });
      const report = JSON.parse(await h.page.locator('#report').textContent() || '{}');
      assertEquals(report.error, undefined, report.error);
      assert(report.environment.adapter, 'no WebGPU adapter');
      assertEquals(report.transfers.length, 4);
      for (const row of report.analysisDownscale) {
        assertEquals(row.bitExact, true, `${row.size}: ${row.reason}`);
        assertEquals(row.backend, 'WebGPU box-luma + CPU registration', row.size);
      }
      assertEquals(report.pipeline.map((r: { compute: string }) => r.compute), ['cpu', 'webgpu']);
      assertEquals(report.pipeline[1].backend.backend, 'WebGPU box-luma + CPU registration', JSON.stringify(report.pipeline[1].backend));
      assert(report.pipeline[0].tiles > 0, 'the recording produced no tiles');
      assertEquals(report.pipelineIdentical, true, JSON.stringify(report.pipeline));
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
