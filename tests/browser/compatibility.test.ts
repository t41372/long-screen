import { assert, assertEquals } from '@std/assert';
import { harness, root } from './support.ts';
import type { Project } from '../../src/types.ts';

await Deno.mkdir(`${root}test-results`, { recursive: true });

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser ${browser}: reconstruction and explicit export capability without crypto.randomUUID`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser, viewport: { width: 390, height: 844 } });
      try {
        const { page } = h;
        const removeUUID = "Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });";
        await page.addInitScript(removeUUID);
        await page.route('**/assets/worker.js', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: removeUUID + '\n' + await response.text() });
        });
        await page.goto(h.base);
        await page.waitForFunction('!!window.longScreen');
        await page.selectOption('#demo-select', 'glimpse');
        await page.click('#demo-btn');
        await page.waitForFunction('["complete", "partial", "error"].includes(longScreen.getProject()?.status)', null, { timeout: 600000 });
        const project = await page.evaluate<Project>('longScreen.getProject()');
        assertEquals(project.status, 'complete', JSON.stringify(project));
        assertEquals(await page.evaluate('typeof crypto.randomUUID'), 'undefined');
        await page.waitForFunction('!document.querySelector("#export-png").disabled');
        await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
        const { opfs } = await page.evaluate<{ opfs: boolean }>('longScreen.rpc("capabilities")');
        if (opfs) {
          const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
          assertEquals(await download.failure(), null);
        } else {
          await page.click('#export-png');
          await page.waitForFunction('document.querySelector("#toast").textContent.includes("DISK_EXPORT_UNAVAILABLE")');
          assertEquals(await page.evaluate('longScreen.getProject().status'), 'complete');
        }
        assertEquals(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        await page.screenshot({ path: `${root}test-results/compatibility-${browser}.png`, fullPage: true });
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
      } finally {
        await h.close();
      }
    },
  });

  Deno.test({
    name: `browser ${browser}: LAN HTTP supports explicit native-seek reconstruction without a secure context`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const hostname = Deno.networkInterfaces().find((i) => i.family === 'IPv4' && !i.address.startsWith('127.'))?.address;
      assert(hostname, 'LAN HTTP test requires a non-loopback IPv4 interface');
      const h = await harness({ browser, hostname, viewport: { width: 390, height: 844 } });
      try {
        const { page } = h;
        await page.goto(h.base);
        await page.waitForFunction('!!window.longScreen');
        assertEquals(await page.evaluate('isSecureContext'), false);
        assertEquals(await page.evaluate('typeof crypto.randomUUID'), 'undefined');
        await page.setInputFiles('#file-input', `${root}tests/fixtures/scroll.mp4`);
        await page.waitForFunction('!document.querySelector("#regions-btn").disabled', null, { timeout: 60000 });
        await page.click('details.advanced > summary');
        await page.selectOption('#decoder', 'compatibility');
        await page.click('#start-btn');
        await page.waitForFunction('["complete", "partial", "error"].includes(longScreen.getProject()?.status)', null, { timeout: 600000 });
        const project = await page.evaluate<Project>('longScreen.getProject()');
        assertEquals(project.status, 'complete', JSON.stringify(project));
        assert(project.renderedFrames > 0);
        assertEquals(project.settings.decoder, 'compatibility');
        await page.locator('#viewer').scrollIntoViewIfNeeded();
        await page.waitForFunction('Array.from(longScreen.viewer.cache.values()).some(e => e.bitmap) && !longScreen.viewer.loading.size');
        await page.waitForFunction(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('#viewer')!;
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let observed = 0;
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) observed++;
          return observed > 100;
        });
        assertEquals(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        await page.screenshot({ path: `${root}test-results/lan-http-${browser}.png` });
        if (await page.evaluate('typeof navigator.storage?.persist !== "function"')) {
          await page.click('#persist-btn');
          assert((await page.locator('#toast').textContent())?.includes('不支持申请持久存储'));
        }
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
      } finally {
        await h.close();
      }
    },
  });
}
