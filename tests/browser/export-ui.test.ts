import { assert, assertEquals } from '@std/assert';
import { unzipSync } from 'fflate';
import { harness, root } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
import '../support/core.ts';
// What a user gets from the export panel: "下载大截图" is one PNG of the whole current canvas named after the recording,
// never a ZIP; "复制大截图" puts that same image on the clipboard; the archival project ZIP is still available under
// "更多导出方式", alongside "分页导出" (the paged-sheets ZIP, restored to the UI as an explicit choice — see
// src/export/project.ts's 'sheets' layout). Failure modes: a ZIP or sheets instead of one image, an image of a
// different size than the canvas, a generic file name, a clipboard write that silently does nothing, the copy
// leaving the panel disabled, or "分页导出" producing something other than a ZIP with at least one PNG and a manifest.
// While an export or copy works, the finished printer must not look as if it ran again: no `is-processing` (the hum,
// scan line, paper feed and blinking light), the gauge kept at the print's own state, the other controls locked, and
// the pressed key marked busy until it is done.
/** Entry names from a ZIP archive's central directory, read with a real reader (fflate, same approach as
 *  tests/unit/export.test.ts's zipEntries, duplicated here since browser tests don't share unit test helpers) —
 *  client-zip only emits ZIP64 records when the archive actually needs them, so a fixed-offset ZIP64 EOCD reader
 *  is no longer a safe assumption for a small test archive like this one's. */
function zipEntries(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes));
}
Deno.test({
  name: 'browser UI: download gives one PNG of the whole canvas, copy puts the same image on the clipboard',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.base });
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.evaluate('longScreen.startDemo("comic")');
      await page.waitForFunction('["complete","partial","error"].includes(longScreen.getProject()?.status)', null, { timeout: 240000 });
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
      const selected = await page.evaluate(
        '({ w: Math.round(longScreen.viewer.current.bounds.width), h: Math.round(longScreen.viewer.current.bounds.height) })',
      ) as { w: number; h: number };
      // Snapshots the page when `selector`'s key turns busy, and what the gauge showed before the click.
      const watch = (selector: string) =>
        page.evaluate((selector) => {
          const key = document.querySelector(selector)!, w = window as unknown as { seen?: unknown; before?: unknown };
          const gauge = () => ({
            pct: document.querySelector('#progress-pct')!.textContent,
            done: document.querySelector('#gauge')!.classList.contains('done'),
          });
          w.seen = undefined;
          w.before = gauge();
          const observer = new MutationObserver(() => {
            if (key.getAttribute('aria-busy') !== 'true') return;
            w.seen = {
              processing: document.body.classList.contains('is-processing'),
              printer: getComputedStyle(document.querySelector('.printer')!).animationName,
              gauge: gauge(),
              unlocked: ['#start-btn', '#clear-btn', '#export-png', '#copy-png', '#export-sheets', '#export-project']
                .filter((s) => !document.querySelector<HTMLButtonElement>(s)!.disabled),
            };
            observer.disconnect();
          });
          observer.observe(key, { attributes: true });
        }, selector);
      const seen = async (selector: string) => {
        const { seen, before } = await page.evaluate('({ seen: window.seen, before: window.before })') as {
          seen: unknown;
          before: unknown;
        };
        assertEquals(seen, { processing: false, printer: 'none', gauge: before, unlocked: [] }, selector);
        assertEquals(await page.evaluate((s) => document.querySelector(s)!.hasAttribute('aria-busy'), selector), false, selector);
      };
      await watch('#export-png');
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-png')]);
      await seen('#export-png');
      assertEquals(download.suggestedFilename(), 'demo-comic-大截图.png');
      const path = `${root}test-results/export-ui.png`;
      await download.saveAs(path);
      const image = await decodePNG(await Deno.readFile(path));
      assertEquals([image.width, image.height], [selected.w, selected.h]);
      await page.waitForFunction('!document.querySelector("#copy-png").disabled', null, { timeout: 30000 });
      await watch('#copy-png');
      await page.click('#copy-png');
      await page.waitForFunction(`/已复制|复制失败/.test(document.querySelector('#toast').textContent)`, null, { timeout: 120000 });
      await page.waitForFunction('!document.querySelector("#copy-png").hasAttribute("aria-busy")', null, { timeout: 30000 });
      await seen('#copy-png');
      const toast = await page.evaluate(`document.querySelector('#toast').textContent`) as string;
      assert(toast.includes('已复制'), toast);
      const copied = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items.find((i) => i.types.includes('image/png'));
        if (!item) return null;
        const bitmap = await createImageBitmap(await item.getType('image/png'));
        return { width: bitmap.width, height: bitmap.height };
      });
      assertEquals(copied, { width: selected.w, height: selected.h });
      assertEquals(await page.evaluate('document.querySelector("#copy-png").disabled'), false, 'the panel is usable again');
      // The archival export is one click further away, not gone.
      await page.click('.export-advanced summary');
      assert(await page.isVisible('#export-project'));
      // "分页导出" is the explicit paged-sheets entry point: a ZIP with at least one native-size PNG and a manifest.
      await page.waitForFunction('!document.querySelector("#export-sheets").disabled', null, { timeout: 30000 });
      // Real-browser throughput of the client-zip-backed writer (src/export/zip.ts), not a pass/fail assertion —
      // informational only.
      const zipStarted = performance.now();
      const [sheetsDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 180000 }),
        page.click('#export-sheets'),
      ]);
      assertEquals(sheetsDownload.suggestedFilename(), 'long-screen-sheets.zip');
      const sheetsPath = `${root}test-results/export-ui-sheets.zip`;
      await sheetsDownload.saveAs(sheetsPath);
      const zipMS = performance.now() - zipStarted, zipMiB = (await Deno.stat(sheetsPath)).size / (1024 * 1024);
      console.log(
        `export-ui: sheets ZIP ${zipMiB.toFixed(2)} MiB in ${zipMS.toFixed(0)} ms (${
          (zipMS / zipMiB).toFixed(2)
        } ms/MiB, click-to-download)`,
      );
      const sheetsNames = zipEntries(await Deno.readFile(sheetsPath));
      assert(sheetsNames.includes('manifest.json'), sheetsNames.join(','));
      assert(sheetsNames.filter((n) => n.endsWith('.png')).length >= 1, sheetsNames.join(','));
      assertEquals(await page.evaluate('document.querySelector("#export-sheets").disabled'), false, 'the panel is usable again');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
