import { assert, assertEquals } from '@std/assert';
import { unzipSync } from 'fflate';
import { harness } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
// decodePNG runs its scanline filters in the Rust core, so this Deno process loads it too (as the unit tests do).
import '../support/core.ts';
const results = new URL('../../test-results/', import.meta.url).pathname;
await Deno.mkdir(results, { recursive: true });
Deno.test({
  name:
    'browser UI: choose a real container, probe metadata via WebCodecs, reconstruct, export a native PNG; a reload brings the print back',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.screenshot({ path: `${results}desktop-empty.png`, fullPage: true });
      await page.setInputFiles('#file-input', `${new URL('../fixtures/negative-cts-v0.mov', import.meta.url).pathname}`);
      await page.waitForFunction(() => document.querySelector('#file-subtitle')?.textContent?.includes('43 帧'), null, { timeout: 30000 });
      const subtitle = await page.textContent('#file-subtitle');
      assert(subtitle?.includes('320 × 240') && subtitle.includes('avc1'), subtitle ?? '');
      assert(!(await page.isDisabled('#regions-btn')), 'regions button enabled after probe');
      await page.click('#start-btn');
      await page.waitForFunction('["complete","error","partial"].includes(longScreen.getProject()?.status)', null, { timeout: 180000 });
      const project = await page.evaluate('longScreen.getProject()') as {
        status: string;
        renderedFrames: number;
        canvasCount: number;
        id: string;
        error?: string;
      };
      assertEquals(project.status, 'complete', project.error);
      assertEquals(project.renderedFrames, 43);
      assert(project.canvasCount >= 2);
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const canvases = await page.evaluate(
        'longScreen.getCanvases().map(c => ({ kind: c.kind, w: Math.round(c.bounds.width), h: Math.round(c.bounds.height), tiles: c.tileCount }))',
      ) as { kind: string; w: number; h: number; tiles: number }[];
      const main = canvases.filter((c) => c.kind === 'moving').sort((a, b) => b.tiles - a.tiles)[0];
      assert(main.h > 300 && main.w >= 320, JSON.stringify(canvases));
      await page.screenshot({ path: `${results}desktop-result.png`, fullPage: true });
      // PNG export through the OPFS path (no save-file picker). Export always encodes viewer.current — with
      // `framing: 'context'` the canvas selector defaults to the framed presentation canvas, not the plain
      // `moving` layer `main` above, so the expected dimensions have to come from whatever is actually selected.
      await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const selected = await page.evaluate(
        '({ w: Math.round(longScreen.viewer.current.bounds.width), h: Math.round(longScreen.viewer.current.bounds.height) })',
      ) as { w: number; h: number };
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
      const path = `${results}ui-export.png`;
      await download.saveAs(path);
      const png = await decodePNG(await Deno.readFile(path));
      assertEquals(png.width, selected.w);
      assertEquals(png.height, selected.h);
      // The browser keeps the last print, so a reload (or a closed tab) puts it back on screen.
      await page.reload();
      await page.waitForFunction('!!window.longScreen');
      await page.waitForFunction(`longScreen.getProject()?.id === ${JSON.stringify(project.id)}`, null, { timeout: 30000 });
      await page.waitForFunction('document.body.classList.contains("has-result")', null, { timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#status-title')?.textContent === '拼好了', null, { timeout: 30000 });
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name:
    'browser UI: a file that is not a video (Markdown) is refused from its bytes with guidance; the recording chosen before stays selected',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.setInputFiles('#file-input', `${new URL('../fixtures/scroll.mp4', import.meta.url).pathname}`);
      await page.waitForFunction(() => document.querySelector('#file-subtitle')?.textContent?.includes('avc1'), null, { timeout: 30000 });
      const subtitle = await page.textContent('#file-subtitle');
      const notes = `${results}notes.md`;
      await Deno.writeTextFile(notes, '# 笔记\n\n不是视频。\n');
      await page.setInputFiles('#file-input', notes);
      await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('notes.md'), null, { timeout: 10000 });
      const toast = await page.textContent('#toast');
      assert(toast?.includes('“notes.md”不是视频（文本文件），没有打开。') && toast.includes('MP4、MOV、WebM 或 MKV'), toast ?? '');
      assertEquals(await page.textContent('#file-title'), 'scroll.mp4');
      assertEquals(await page.textContent('#file-subtitle'), subtitle);
      assert(!(await page.textContent('#diagnostics'))?.includes('PROBE_FAILED'), 'the Markdown file never reached the probe');
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser UI: built-in demo runs through the worker and exports a portable ZIP64 project; mobile layout has no horizontal overflow',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.evaluate('longScreen.startDemo("gap")');
      await page.waitForFunction(
        'longScreen.getProject()?.name === "demo-gap.generated" && ["complete","error","partial"].includes(longScreen.getProject()?.status)',
        null,
        { timeout: 240000 },
      );
      const project = await page.evaluate('longScreen.getProject()') as {
        status: string;
        canvasCount: number;
        diagnostics: Record<string, number>;
      };
      assertEquals(project.status, 'complete');
      assert(project.diagnostics.UNPLACED_FRAGMENT === 1, JSON.stringify(project.diagnostics));
      await page.click('.export-advanced summary');
      await page.waitForFunction('!document.querySelector("#export-project").disabled', null, { timeout: 30000 });
      await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-project')]);
      const path = `${results}demo-project.zip`;
      await download.saveAs(path);
      const bytes = await Deno.readFile(path), view = new DataView(bytes.buffer);
      assertEquals(view.getUint32(bytes.length - 22, true), 0x06054b50);
      // Read with a real unzip implementation (fflate), not a hand-decoded ZIP64 end record: client-zip
      // (src/export/zip.ts) only emits ZIP64 fields when the archive actually needs them, so a fixed-offset
      // ZIP64 EOCD locator is not a safe assumption for every export this button can produce.
      const count = Object.keys(unzipSync(bytes)).length;
      assert(count > 20, `zip entries ${count}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${results}mobile-layout.png`, fullPage: true });
      assert(
        !(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')),
        'horizontal overflow on a phone viewport',
      );
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser UI: the demo key puts the sample recording on the screen and prints the whole board from it',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      // The same path as a user's file: fetched from static/demo/, chosen, shown on the screen, then run. The chip in the
      // intro sentence is the one way in.
      await page.click('#demo-cta');
      await page.waitForFunction(() => document.querySelector('#file-title')?.textContent === '示例录屏.mp4', null, { timeout: 30000 });
      assert(await page.evaluate(() => !!document.querySelector<HTMLVideoElement>('#preview-video')?.src), 'the screen plays the sample');
      await page.waitForFunction(
        'longScreen.getProject()?.name === "示例录屏.mp4" && ["complete","error","partial"].includes(longScreen.getProject()?.status)',
        null,
        { timeout: 240000 },
      );
      const project = await page.evaluate('longScreen.getProject()') as { status: string; renderedFrames: number; error?: string };
      assertEquals(project.status, 'complete', project.error);
      assertEquals(project.renderedFrames, 343);
      const canvases = await page.evaluate(
        'longScreen.getCanvases().map(c => ({ kind: c.kind, w: Math.round(c.bounds.width), h: Math.round(c.bounds.height) }))',
      );
      assertEquals(canvases, [{ kind: 'moving', w: 2400, h: 1500 }]);
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      // Spread out, the print sits above its backdrop: the middle of the stage is the viewer, not the blur.
      await page.click('#expand-btn');
      const onTop = await page.evaluate(() => {
        const r = document.querySelector('#stage')!.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id;
      });
      assertEquals(onTop, 'viewer');
      await page.keyboard.press('Escape');
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser UI: a new print replaces the kept one; the clear key empties the printer and deletes the kept print',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      const page = h.page;
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      await page.setInputFiles('#file-input', `${new URL('../fixtures/scroll.mp4', import.meta.url).pathname}`);
      await page.waitForFunction(() => document.querySelector('#file-subtitle')?.textContent?.includes('avc1'), null, { timeout: 30000 });
      await page.click('#start-btn');
      await page.waitForFunction('["complete","error","partial"].includes(longScreen.getProject()?.status)', null, { timeout: 180000 });
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const gone = (id: string) =>
        page.waitForFunction((id) => (window as any).longScreen.rpc('open', { projectId: id }).then(() => false, () => true), id, {
          timeout: 30000,
          polling: 250,
        });
      // The browser keeps one print: printing again deletes the one before.
      const firstId = await page.evaluate('longScreen.getProject().id') as string;
      await page.click('#start-btn');
      await page.waitForFunction(
        `longScreen.getProject()?.id !== ${
          JSON.stringify(firstId)
        } && ["complete","error","partial"].includes(longScreen.getProject()?.status)`,
        null,
        { timeout: 180000 },
      );
      await gone(firstId);
      await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
      const projectId = await page.evaluate('longScreen.getProject().id') as string;
      await page.click('#clear-btn');
      await gone(projectId);
      const after = await page.evaluate(() => ({
        project: (globalThis as unknown as { longScreen: { getProject(): unknown } }).longScreen.getProject() ?? null,
        result: document.body.classList.contains('has-result'),
        title: document.querySelector('#file-title')?.textContent,
        screen: document.querySelector('#preview-video')?.hasAttribute('src'),
        start: (document.querySelector('#start-btn') as HTMLButtonElement).disabled,
        exportPng: (document.querySelector('#export-png') as HTMLButtonElement).disabled,
        log: document.querySelector('#diagnostics')?.textContent,
        count: document.querySelector('#progress-count')?.textContent,
      }));
      assertEquals(after.project, null);
      assertEquals(after.result, false);
      assertEquals(after.title, '还没放录屏');
      assertEquals(after.screen, false);
      assertEquals(after.start, true, 'nothing to print');
      assertEquals(after.exportPng, true);
      assert(after.log?.includes('都会记在这里'), after.log ?? '');
      assertEquals(after.count, '');
      // The same file can go straight back in.
      await page.setInputFiles('#file-input', `${new URL('../fixtures/scroll.mp4', import.meta.url).pathname}`);
      await page.waitForFunction(() => document.querySelector('#file-title')?.textContent === 'scroll.mp4', null, { timeout: 30000 });
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser UI: the settings flap opens where there is room and scrolls, so every setting can be reached',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A short window with the dial mid-screen (below it) and near the bottom (above it): the flap must stay inside
    // the window either way, and its last setting must scroll into view.
    for (const scroll of [300, 0]) {
      const h = await harness({ viewport: { width: 1000, height: 880 } });
      try {
        const page = h.page;
        await page.goto(h.base + '/');
        await page.waitForFunction('!!window.longScreen');
        await page.evaluate((y) => scrollTo(0, y), scroll);
        await page.click('#knobs-btn');
        await page.evaluate(() => (document.querySelector('details.advanced') as HTMLDetailsElement).open = true);
        const box = await page.evaluate(() => {
          const flap = document.querySelector('#knobs')!, rect = flap.getBoundingClientRect();
          flap.scrollTop = flap.scrollHeight;
          const last = document.querySelector('#decoder')!.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, lastTop: last.top, lastBottom: last.bottom, height: innerHeight };
        });
        assert(box.top >= 0 && box.bottom <= box.height, JSON.stringify(box));
        assert(box.lastTop >= box.top && box.lastBottom <= box.bottom, JSON.stringify(box));
        assertEquals(h.errors, []);
      } finally {
        await h.close();
      }
    }
  },
});
