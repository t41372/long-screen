import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
import { decodePNG } from '../../src/codec/png.ts';
const results = new URL('../../test-results/', import.meta.url).pathname;
await Deno.mkdir(results, { recursive: true });
Deno.test({ name: 'browser UI: choose a real container, probe metadata via WebCodecs, reconstruct, restore from history and export a native PNG', sanitizeOps: false, sanitizeResources: false, fn: async () => {
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
        const project = await page.evaluate('longScreen.getProject()') as { status: string; renderedFrames: number; canvasCount: number; id: string; error?: string };
        assertEquals(project.status, 'complete', project.error);
        assertEquals(project.renderedFrames, 43);
        assert(project.canvasCount >= 2);
        await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
        const canvases = await page.evaluate('longScreen.getCanvases().map(c => ({ kind: c.kind, w: Math.round(c.bounds.width), h: Math.round(c.bounds.height), tiles: c.tileCount }))') as { kind: string; w: number; h: number; tiles: number }[];
        const main = canvases.filter(c => c.kind === 'moving').sort((a, b) => b.tiles - a.tiles)[0];
        assert(main.h > 300 && main.w >= 320, JSON.stringify(canvases));
        await page.screenshot({ path: `${results}desktop-result.png`, fullPage: true });
        // History restore after reload.
        await page.reload();
        await page.waitForFunction('!!window.longScreen');
        await page.click('#history-btn');
        await page.locator('.history-item').filter({ hasText: 'negative-cts-v0.mov' }).getByRole('button', { name: '打开', exact: true }).first().click();
        await page.waitForFunction(`longScreen.getProject()?.id === ${JSON.stringify(project.id)}`);
        // PNG export through the OPFS path (no save-file picker).
        await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
        await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png')]);
        const path = `${results}ui-export.png`;
        await download.saveAs(path);
        const png = await decodePNG(await Deno.readFile(path));
        assertEquals(png.width, main.w);
        assertEquals(png.height, main.h);
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
    }
    finally {
        await h.close();
    }
} });
Deno.test({ name: 'browser UI: built-in demo runs through the worker and exports a portable ZIP64 project; mobile layout has no horizontal overflow', sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const h = await harness();
    try {
        const page = h.page;
        await page.goto(h.base + '/');
        await page.waitForFunction('!!window.longScreen');
        await page.selectOption('#demo-select', 'gap');
        await page.click('#demo-btn');
        await page.waitForFunction('longScreen.getProject()?.name === "demo-gap.generated" && ["complete","error","partial"].includes(longScreen.getProject()?.status)', null, { timeout: 240000 });
        const project = await page.evaluate('longScreen.getProject()') as { status: string; canvasCount: number; diagnostics: Record<string, number> };
        assertEquals(project.status, 'complete');
        assert(project.diagnostics.UNPLACED_FRAGMENT === 1, JSON.stringify(project.diagnostics));
        await page.waitForFunction('!document.querySelector("#export-project").disabled', null, { timeout: 30000 });
        await page.evaluate("Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })");
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-project')]);
        const path = `${results}demo-project.zip`;
        await download.saveAs(path);
        const bytes = await Deno.readFile(path), view = new DataView(bytes.buffer);
        assertEquals(view.getUint32(bytes.length - 22, true), 0x06054b50);
        const at = Number(view.getBigUint64(bytes.length - 34, true)), count = Number(view.getBigUint64(at + 32, true));
        assert(count > 20, `zip entries ${count}`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${results}mobile-layout.png`, fullPage: true });
        assert(!(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')), 'horizontal overflow on a phone viewport');
        assertEquals(h.errors, []);
        assertEquals(h.external, []);
    }
    finally {
        await h.close();
    }
} });
