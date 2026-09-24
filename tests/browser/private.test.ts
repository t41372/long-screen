import { assert, assertEquals } from '@std/assert';
import { harness, root } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
import '../support/core.ts';
import type { Project } from '../../src/types.ts';
// Safari Private Browsing, as a WebKit ephemeral session: IndexedDB lives in memory and rejects every Blob, and there
// is no OPFS. Ways the app could fail there: tiles (PNG Blobs) failing to persist so the run ends partial with a
// generic "Local storage transaction failed."; stored tiles coming back as byte records instead of Blobs, so the
// viewer or export cannot decode them; export refusing for lack of a disk; the user not told that closing the window
// discards the project.
Deno.test({
  name: 'browser (WebKit private browsing): a run completes, tiles read back as images, PNG and project export download',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ browser: 'webkit', ephemeral: true });
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      const caps = await page.evaluate('longScreen.rpc("capabilities")') as { privateStorage: boolean; opfs: boolean };
      assertEquals(caps.privateStorage, true, 'the session must be detected as one without Blob storage');
      await page.waitForFunction(`document.querySelector('#toast').textContent.includes('隐私浏览')`);
      await page.evaluate('longScreen.startDemo("gap")');
      await page.waitForFunction(
        '["complete", "partial", "error"].includes(longScreen.getProject()?.status)',
        null,
        { timeout: 300000 },
      );
      const project = await page.evaluate('longScreen.getProject()') as Project;
      assertEquals(project.status, 'complete', project.error);
      // A stored tile, read back through the worker the way the viewer reads it, decodes as a PNG image.
      const tile = await page.evaluate(async () => {
        const { rpc, getCanvases, getProject } = (window as any).longScreen;
        const canvas = getCanvases().find((c: { tileCount: number }) => c.tileCount > 0), size = getProject().settings.tileSize;
        const x0 = Math.floor(canvas.bounds.x / size), y0 = Math.floor(canvas.bounds.y / size);
        for (let y = y0; y < y0 + 8; y++) {
          for (let x = x0; x < x0 + 8; x++) {
            const t = await rpc('tile', { projectId: getProject().id, canvasId: canvas.id, level: 0, x, y });
            if (!t) continue;
            const bitmap = await createImageBitmap(t.blob);
            return { isBlob: t.blob instanceof Blob, type: t.blob.type, width: bitmap.width, coverage: t.coverage instanceof Uint8Array };
          }
        }
        return null;
      });
      assert(tile, 'no stored tile found');
      assertEquals([tile.isBlob, tile.type, tile.coverage], [true, 'image/png', true]);
      assert(tile.width > 0);
      // No disk: both exports are assembled in memory and offered as downloads.
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const selected = await page.evaluate(
        '({ w: Math.round(longScreen.viewer.current.bounds.width), h: Math.round(longScreen.viewer.current.bounds.height) })',
      ) as { w: number; h: number };
      const [png] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-png')]);
      assertEquals(await png.failure(), null);
      const pngPath = `${root}test-results/private-export.png`;
      await png.saveAs(pngPath);
      const image = await decodePNG(await Deno.readFile(pngPath));
      assertEquals([image.width, image.height], [selected.w, selected.h]);
      await page.click('.export-advanced summary');
      await page.waitForFunction('!document.querySelector("#export-project").disabled', null, { timeout: 30000 });
      const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-project')]);
      assertEquals(await zip.failure(), null);
      const zipPath = `${root}test-results/private-project.zip`;
      await zip.saveAs(zipPath);
      const bytes = await Deno.readFile(zipPath), view = new DataView(bytes.buffer);
      assertEquals(view.getUint32(bytes.length - 22, true), 0x06054b50, 'ZIP end-of-central-directory');
      // The browser keeps the last print: it survives a reload and its canvases can be opened again.
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      const listed = await page.evaluate(async (id: string) => {
        const { rpc } = (window as any).longScreen;
        const opened = await rpc('open', { projectId: id });
        return { status: opened.project.status, canvases: opened.canvases.length };
      }, project.id);
      assertEquals(listed.status, 'complete');
      assert(listed.canvases > 0);
      const toast = await page.evaluate(`document.querySelector('#toast').textContent`) as string;
      assert(!toast.includes('transaction failed'), toast);
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
