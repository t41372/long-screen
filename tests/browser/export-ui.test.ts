import { assert, assertEquals } from '@std/assert';
import { harness, root } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
import '../support/core.ts';
// What a user gets from the export panel: "下载长图" is one PNG of the whole current canvas named after the recording,
// never a ZIP; "复制长图" puts that same image on the clipboard; the archival project ZIP is still available under
// "高级导出". Failure modes: a ZIP or sheets instead of one image, an image of a different size than the canvas, a
// generic file name, a clipboard write that silently does nothing, or the copy leaving the panel disabled.
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
      await page.selectOption('#demo-select', 'comic');
      await page.click('#demo-btn');
      await page.waitForFunction('["complete","partial","error"].includes(longScreen.getProject()?.status)', null, { timeout: 240000 });
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
      const selected = await page.evaluate(
        '({ w: Math.round(longScreen.viewer.current.bounds.width), h: Math.round(longScreen.viewer.current.bounds.height) })',
      ) as { w: number; h: number };
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-png')]);
      assertEquals(download.suggestedFilename(), 'demo-comic-长图.png');
      const path = `${root}test-results/export-ui.png`;
      await download.saveAs(path);
      const image = await decodePNG(await Deno.readFile(path));
      assertEquals([image.width, image.height], [selected.w, selected.h]);
      await page.waitForFunction('!document.querySelector("#copy-png").disabled', null, { timeout: 30000 });
      await page.click('#copy-png');
      await page.waitForFunction(`/已复制|复制失败/.test(document.querySelector('#toast').textContent)`, null, { timeout: 120000 });
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
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
