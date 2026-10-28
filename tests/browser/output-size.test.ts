import { assert, assertEquals } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import { unzipSync } from 'fflate';
import { harness, root } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
import '../support/core.ts';

// Real recording -> worker -> kept crop -> resized PNG / clipboard. Failure cases: resizing only the preview,
// applying size before crop, losing the native print, lying about clipboard dimensions, invalid fields silently
// exporting the previous size, or size leaking into native sheets and archival tiles.
for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser output size: crop, resize, copy and restore native pixels in ${browser}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const directory = `${root}test-results/output-size/${browser}/`;
      await Deno.mkdir(directory, { recursive: true });
      const h = await harness({ browser, locale: browser === 'chromium' ? 'en-US' : 'zh-TW' });
      try {
        const page = h.page;
        if (browser === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.base });
        await page.goto(h.base);
        await page.waitForFunction('!!window.longScreen');
        assert(await page.isHidden('#output-size-bar'));
        await page.setInputFiles('#file-input', `${root}tests/fixtures/negative-cts-v0.mov`);
        await page.waitForFunction('document.querySelector("#file-subtitle").textContent.includes("43")');
        await page.click('#start-btn');
        await page.waitForFunction('longScreen.getProject()?.status === "complete"', null, { timeout: 180000 });
        await page.waitForFunction('!document.querySelector("#export-png").disabled');
        await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
        assert(await page.isVisible('#output-size-bar'));
        assertEquals(await page.inputValue('#output-size'), '1');
        const report: Record<string, unknown> = {
          command: 'deno test --allow-all tests/browser/output-size.test.ts',
          browser,
        };
        const download = async (name: string, expected?: [number, number]) => {
          const [file] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
          await file.saveAs(`${directory}${name}.png`);
          await page.waitForFunction('!document.querySelector("#export-png").disabled');
          const bytes = await Deno.readFile(`${directory}${name}.png`), image = await decodePNG(bytes);
          const dimensions: [number, number] = [image.width, image.height];
          if (expected) assertEquals(dimensions, expected);
          assertEquals(await page.textContent('#output-dimensions'), `${image.width} × ${image.height} px`);
          const sha256 = encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
          const message = await page.textContent('#progress-message');
          assert(!/native-size|原尺寸/.test(message ?? ''), 'export success must describe the actual output size');
          report[name] = { dimensions, sha256, bytes: bytes.length, message };
          return { dimensions, sha256 };
        };
        const native = await download('native');
        const [width, height] = native.dimensions, longest = Math.max(width, height);
        for (const scale of [.75, .5, .25]) {
          await page.selectOption('#output-size', String(scale));
          await download(`scale-${scale}`, [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))]);
        }
        await page.selectOption('#output-size', 'custom');
        for (const invalid of ['', '0', '-1', '1.5']) {
          await page.fill('#output-max-edge', invalid);
          assert(await page.isDisabled('#export-png'));
          assert(await page.isDisabled('#copy-png'));
          assertEquals(await page.getAttribute('#output-max-edge', 'aria-invalid'), '');
          assert(!(await page.isDisabled('#export-sheets')), 'native exports remain available');
        }
        await page.click('#crop-btn');
        await page.click('#crop-cancel');
        assert(await page.isDisabled('#export-png'), 'invalid size still blocks exporting after cancelling a crop');
        await page.fill('#output-max-edge', '321');
        const custom = await download('custom', [
          Math.max(1, Math.floor(width * Math.min(1, 321 / longest))),
          Math.max(1, Math.floor(height * Math.min(1, 321 / longest))),
        ]);
        if (browser === 'chromium') {
          await page.click('#copy-png');
          await page.waitForFunction('!document.querySelector("#copy-png").hasAttribute("aria-busy")');
          const copied = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const bitmap = await createImageBitmap(await items[0].getType('image/png'));
            const size = [bitmap.width, bitmap.height];
            bitmap.close();
            return size;
          });
          assertEquals(copied, custom.dimensions);
          assert((await page.textContent('#toast'))?.includes(custom.dimensions.join(' × ')));
          report.clipboard = copied;
        }
        await page.selectOption('#output-size', '1');
        assertEquals((await download('native-again')).sha256, native.sha256);

        await page.click('#crop-btn');
        await page.fill('#crop-left', '7');
        await page.fill('#crop-top', '480');
        await page.fill('#crop-width', '150');
        await page.fill('#crop-height', '121');
        await page.click('#crop-apply');
        await page.waitForFunction('document.querySelector("#crop-btn").getAttribute("aria-pressed") === "true"');
        await page.selectOption('#output-size', 'custom');
        await page.fill('#output-max-edge', '60');
        await download('crop-resized', [60, 48]);
        await page.screenshot({ path: `${directory}crop-resized-ui.png`, fullPage: true });

        // The native sheets still contain the 150 × 121 kept window, despite the 60px output limit.
        await page.locator('.export-advanced').evaluate((el: HTMLDetailsElement) => el.open = true);
        const [sheets] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-sheets')]);
        await sheets.saveAs(`${directory}sheets.zip`);
        const entries = unzipSync(await Deno.readFile(`${directory}sheets.zip`));
        const sheet = await decodePNG(entries[Object.keys(entries).find((name) => name.endsWith('.png'))!]);
        assertEquals([sheet.width, sheet.height], [150, 121]);
        report.sheets = [sheet.width, sheet.height];
        await page.waitForFunction('!document.querySelector("#export-png").disabled');
        // Size is a per-session export choice; reload restores the native print and its saved crop.
        await page.reload();
        await page.waitForFunction('!!window.longScreen && !document.querySelector("#export-png").disabled');
        assertEquals(await page.inputValue('#output-size'), '1');
        assertEquals(await page.textContent('#output-dimensions'), '150 × 121 px');
        report.restoredCrop = [150, 121];
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
        await Deno.writeTextFile(`${directory}report.json`, JSON.stringify(report, null, 2));
      } finally {
        await h.close();
      }
    },
  });
}

Deno.test({
  name: 'browser output size: English printer layouts keep size controls usable at every review width',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const directory = `${root}test-results/output-size/layout/`;
    await Deno.mkdir(directory, { recursive: true });
    const h = await harness({ locale: 'en-US' });
    try {
      const page = h.page;
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(h.base);
      await page.waitForFunction('!!window.longScreen');
      // The real demo key: decoding and reconstruction run before the screenshots are taken.
      await page.click('#demo-cta');
      await page.waitForFunction('longScreen.getProject()?.status === "complete"', null, { timeout: 240000 });
      await page.waitForFunction('!document.querySelector("#export-png").disabled');
      await page.selectOption('#output-size', 'custom');
      await page.fill('#output-max-edge', '8192');
      const layouts: unknown[] = [];
      for (const width of [390, 1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => scrollTo(0, 0));
        // ResizeObserver -> fit animation -> asynchronous tile fetches must settle before the review artifact.
        await page.waitForFunction('!longScreen.viewer.requested && longScreen.viewer.loading.size === 0');
        await page.screenshot({ path: `${directory}${width}-demo.png`, fullPage: true, animations: 'disabled' });
        const layout = await page.evaluate(() => {
          const select = document.querySelector<HTMLSelectElement>('#output-size')!, style = getComputedStyle(select);
          const measure = document.createElement('canvas').getContext('2d')!;
          measure.font = style.font;
          return {
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            selectedTextWidth: measure.measureText(select.selectedOptions[0].textContent!).width +
              parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
            controls: ['output-size', 'output-max-edge', 'output-dimensions'].map((id) => {
              const r = document.getElementById(id)!.getBoundingClientRect();
              return { id, left: r.left, right: r.right, width: r.width };
            }),
          };
        });
        assert(layout.scrollWidth <= width + 1, JSON.stringify(layout));
        for (const r of layout.controls) assert(r.left >= 0 && r.right <= width + 1 && r.width > 0, JSON.stringify(r));
        assert(layout.controls[0].width >= layout.selectedTextWidth - 1, 'the selected output size must be readable');
        layouts.push(layout);
        await page.click('#knobs-btn');
        await page.screenshot({ path: `${directory}${width}-settings.png`, animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.click('#note-btn');
        await page.screenshot({ path: `${directory}${width}-log.png`, animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.click('#expand-btn');
        await page.waitForFunction('!longScreen.viewer.requested && longScreen.viewer.loading.size === 0');
        await page.screenshot({ path: `${directory}${width}-spread.png`, animations: 'disabled' });
        await page.keyboard.press('Escape');
      }
      assertEquals(h.errors, []);
      await Deno.writeTextFile(
        `${directory}report.json`,
        JSON.stringify({ command: 'deno test --allow-all tests/browser/output-size.test.ts', layouts }, null, 2),
      );
    } finally {
      await h.close();
    }
  },
});
