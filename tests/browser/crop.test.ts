import { assert, assertEquals } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import { dirname, toFileUrl } from '@std/path';
import { unzipSync } from 'fflate';
import { harness } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
import { CATALOGUES } from '../../src/i18n/index.ts';
// decodePNG runs its scanline filters in the Rust core, so this Deno process loads it too (as the unit tests do).
import '../support/core.ts';

const sha256 = async (bytes: Uint8Array) =>
  encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

for (const locale of ['zh-CN', 'ar']) {
  Deno.test({
    name: `browser crop (${locale}): drag and type a crop, export the exact window, restore after reload, and undo with whole print`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const results =
        new URL(locale === 'ar' ? '../../test-results/localization-expanded/rtl/' : '../../test-results/page-tweaks/', import.meta.url)
          .pathname;
      await Deno.mkdir(results, { recursive: true });
      const h = await harness({ locale });
      try {
        const page = h.page;
        await page.goto(h.base + '/');
        await page.waitForFunction('!!window.longScreen');
        await page.setInputFiles('#file-input', `${new URL('../fixtures/negative-cts-v0.mov', import.meta.url).pathname}`);
        await page.waitForFunction(() => document.querySelector('#file-subtitle')?.textContent?.includes('43'), null, { timeout: 30000 });
        assert(await page.isDisabled('#crop-btn'), 'nothing to crop before a print');
        await page.click('#start-btn');
        await page.waitForFunction('longScreen.getProject()?.status === "complete"', null, { timeout: 180000 });
        await page.waitForFunction(
          '!document.querySelector("#export-png").disabled && !document.querySelector("#crop-btn").disabled',
          null,
          {
            timeout: 30000,
          },
        );
        // Exports go through the OPFS path (no save-file picker), as in ui.test.ts.
        const noPicker = "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })";
        await page.evaluate(noPicker);
        const exportPNG = async (name: string) => {
          await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 60000 });
          const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
          await download.saveAs(`${results}${name}`);
          const bytes = await Deno.readFile(`${results}${name}`);
          return { png: await decodePNG(bytes), sha256: await sha256(bytes) };
        };
        const full = await exportPNG('crop-full.png');
        const origin = await page.evaluate(() => {
          const b =
            (globalThis as unknown as { longScreen: { viewer: { current: { bounds: { x: number; y: number } } } } }).longScreen.viewer
              .current.bounds;
          return { x: Math.floor(b.x), y: Math.floor(b.y) };
        });

        // Crop: drag the bottom-right grip in, then type all four edges, across the 512-pixel tile seam at y = 512.
        await page.click('#crop-btn');
        assertEquals(await page.locator('#crop-left').evaluate((el) => getComputedStyle(el).direction), 'ltr');
        assertEquals(await page.locator('#viewer').evaluate((el) => getComputedStyle(el).direction), 'ltr');
        assert(!(await page.isHidden('#crop-bar')) && !(await page.isHidden('#crop-box')));
        assertEquals(await page.inputValue('#crop-width'), String(full.png.width));
        assert(await page.isDisabled('#export-png'), 'exports wait while the crop box is up');
        // The view eases to the whole canvas when the box comes up; grab the grip once it has stopped moving.
        let grip = (await page.locator('#crop-box i[data-grip="se"]').boundingBox())!;
        for (let settled = 0; settled < 3;) {
          await page.waitForTimeout(80);
          const next = (await page.locator('#crop-box i[data-grip="se"]').boundingBox())!;
          settled = next.x === grip.x && next.y === grip.y ? settled + 1 : 0;
          grip = next;
        }
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x - 60, grip.y - 40, { steps: 6 });
        await page.mouse.up();
        const dragged = Number(await page.inputValue('#crop-width'));
        assert(
          dragged < full.png.width && Number(await page.inputValue('#crop-height')) < full.png.height,
          'dragging the grip shrinks the crop',
        );
        await page.fill('#crop-left', '7');
        await page.fill('#crop-top', '480');
        await page.fill('#crop-width', '150');
        await page.fill('#crop-height', '120');
        const crop = { x: 7, y: 480, width: 150, height: 120 };
        await page.screenshot({ path: `${results}crop-editing.png` });
        await page.click('#crop-apply');
        await page.waitForFunction(() => document.querySelector('#crop-btn')?.getAttribute('aria-pressed') === 'true');
        const croppedLabel = CATALOGUES[locale === 'ar' ? 'ar' : 'zh'].ui.crop.buttonCropped
          .replace('{{width}}', '150').replace('{{height}}', '120');
        assertEquals(await page.textContent('#crop-btn'), croppedLabel);
        await page.screenshot({ path: `${results}crop-applied.png` });

        const cut = await exportPNG('crop-cut.png');
        assertEquals([cut.png.width, cut.png.height], [crop.width, crop.height]);
        for (let y = 0; y < crop.height; y++) {
          const a = cut.png.data.subarray(y * crop.width * 4, (y + 1) * crop.width * 4),
            j = ((y + crop.y) * full.png.width + crop.x) * 4,
            b = full.png.data.subarray(j, j + crop.width * 4);
          assert(a.every((v, i) => v === b[i]), `row ${y} of the crop differs from the full export`);
        }

        // A reload brings the print back with its crop, and exports the same bytes.
        await page.reload();
        await page.waitForFunction('!!window.longScreen');
        await page.waitForFunction(() => document.querySelector('#crop-btn')?.getAttribute('aria-pressed') === 'true', null, {
          timeout: 30000,
        });
        await page.evaluate(noPicker);
        const again = await exportPNG('crop-reloaded.png');
        assertEquals(again.sha256, cut.sha256);

        // The whole print again: no crop is kept and the export is the full one.
        await page.click('#crop-btn');
        await page.click('#crop-full');
        assertEquals(await page.inputValue('#crop-left'), '0');
        await page.click('#crop-apply');
        await page.waitForFunction(() => document.querySelector('#crop-btn')?.getAttribute('aria-pressed') === 'false');
        const restored = await exportPNG('crop-reset.png');
        assertEquals(restored.sha256, full.sha256);
        const projectId = await page.evaluate('longScreen.getProject().id') as string;
        assertEquals(await page.evaluate(`longScreen.rpc('crops', { projectId: ${JSON.stringify(projectId)} })`), {});

        if (locale === 'ar') {
          // Open the actual exported viewer from disk. Its UI follows Arabic, while tiles and coordinates stay LTR.
          await page.locator('.export-advanced').evaluate((el: HTMLDetailsElement) => el.open = true);
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 120000 }),
            page.click('#export-project'),
          ]);
          await download.saveAs(`${results}project.zip`);
          const entries = unzipSync(await Deno.readFile(`${results}project.zip`));
          for (const [name, bytes] of Object.entries(entries)) {
            const path = `${results}project/${name}`;
            await Deno.mkdir(dirname(path), { recursive: true });
            await Deno.writeFile(path, bytes);
          }
          const offline = await page.context().newPage();
          const offlineErrors: string[] = [];
          offline.on('pageerror', (error) => offlineErrors.push(String(error)));
          await offline.goto(toFileUrl(`${results}project/index.html`).href);
          await offline.waitForFunction(() => !!document.querySelector('#status')?.textContent);
          await offline.waitForFunction('pending === 0 && [...cache.values()].some(image => image?.naturalWidth > 0)');
          assertEquals(await offline.getAttribute('html', 'dir'), 'rtl');
          assertEquals(await offline.getAttribute('html', 'lang'), 'ar');
          assertEquals(await offline.locator('canvas').evaluate((el) => getComputedStyle(el).direction), 'ltr');
          for (const width of [390, 1440]) {
            await offline.setViewportSize({ width, height: 900 });
            await offline.click('#fit');
            await offline.waitForFunction('pending === 0 && [...cache.values()].some(image => image?.naturalWidth > 0)');
            await offline.screenshot({ path: `${results}offline-${width}.png` });
            const fits = await offline.evaluate(() => {
              const header = document.querySelector('header')!.getBoundingClientRect();
              const canvas = document.querySelector('canvas')!.getBoundingClientRect();
              const footer = document.querySelector('footer')!.getBoundingClientRect();
              return document.documentElement.scrollWidth <= innerWidth + 1 && canvas.top >= header.bottom - 1 &&
                canvas.bottom <= footer.top + 1 && canvas.height > 0 && footer.bottom <= innerHeight + 1;
            });
            assert(fits, `Arabic offline viewer overlaps or overflows at ${width}px`);
          }
          assertEquals(offlineErrors, []);
          await offline.close();
        }

        await Deno.writeTextFile(
          `${results}crop-e2e.json`,
          JSON.stringify(
            {
              command: 'deno test --allow-all tests/browser/crop.test.ts',
              locale,
              canvasOrigin: origin,
              full: { width: full.png.width, height: full.png.height, sha256: full.sha256 },
              crop: { relativeToCanvas: crop, draggedWidthBeforeTyping: dragged },
              cropped: { width: cut.png.width, height: cut.png.height, sha256: cut.sha256, matchesFullWindow: true },
              afterReload: { sha256: again.sha256 },
              afterWholePrint: { sha256: restored.sha256, equalsFull: restored.sha256 === full.sha256 },
            },
            null,
            2,
          ),
        );
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
      } finally {
        await h.close();
      }
    },
  });
}
