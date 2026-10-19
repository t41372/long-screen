/** The Content-Security-Policy (static/_headers, mirrored in main.ts) in real Chrome and Playwright WebKit: the page may
 *  load from and send to only its own origin plus Cloudflare Web Analytics, and nothing the app itself needs is blocked.
 *
 *  Ways it could fail, each checked below:
 *  - the policy is missing or not the deployed one (tests/unit/server.test.ts checks the second);
 *  - it blocks something a run needs: compiling the Wasm core, a worker, the threads core's helpers, the sample
 *    recording, a blob: video or a download. Some of these fall back quietly (frames convert in-thread when a worker
 *    cannot start), so a completed run alone does not show it: every violation is reported to the harness;
 *  - an inline script's hash is stale (the page's and the device check's `i18n-pending` scripts);
 *  - it blocks a route the main flow does not take: HDR colour conversion, or the compatibility decoder;
 *  - it lets the page send elsewhere: a fetch and an image aimed at another origin must be refused, and their reports
 *    also show that the harness hears violations at all.
 *
 *  Waits are functions, not strings: Playwright evaluates a string predicate in the page, which the policy forbids.
 *  The report goes to test-results/csp-<browser>.json; regenerate with `deno test --allow-all tests/browser/csp.test.ts`. */
import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
import type { Project } from '../../src/types.ts';

const results = new URL('../../test-results/', import.meta.url).pathname;
await Deno.mkdir(results, { recursive: true });

type Kit = { longScreen?: { getProject(): { status?: string } | undefined } };
const status = () => (globalThis as unknown as Kit).longScreen?.getProject()?.status ?? '';

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser ${browser}: the CSP blocks nothing a run, an export or the device check needs, and refuses other origins`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser, locale: 'en-US', csp: true });
      const report: Record<string, unknown> = { browser };
      try {
        const { page } = h;
        const response = await page.goto(h.base + '/');
        report.policy = response?.headers()['content-security-policy'];
        assert(String(report.policy).includes("default-src 'self'"), String(report.policy));
        await page.waitForFunction(() => 'longScreen' in globalThis);
        report.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
        assertEquals(report.crossOriginIsolated, true);
        await page.click('#demo-cta');
        await page.waitForFunction(
          () => ['complete', 'partial', 'error'].includes((globalThis as unknown as Kit).longScreen?.getProject()?.status ?? ''),
          null,
          { timeout: 600000 },
        );
        report.demo = await page.evaluate(status);
        assertEquals(report.demo, 'complete');
        // Downloads the ordinary way: headless Chrome cannot answer the save-file picker.
        await page.evaluate(() => Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true }));
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#export-png')!.disabled, null, { timeout: 30000 });
        const [png] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-png')]);
        report.pngBytes = (await Deno.stat(await png.path())).size;
        await page.click('.export-advanced summary');
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#export-project')!.disabled, null, { timeout: 30000 });
        const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-project')]);
        report.zipBytes = (await Deno.stat(await zip.path())).size;
        assert(Number(report.pngBytes) > 0 && Number(report.zipBytes) > 0);
        await page.goto(h.base + '/device-check.html');
        await page.waitForLoadState('load');
        // Reports are sent asynchronously after the violation.
        await page.waitForTimeout(1500);
        report.cspReports = [...h.cspReports];
        report.external = [...h.external];
        report.errors = [...h.errors];
        assertEquals(h.cspReports, []);
        assertEquals(h.external, []);
        assertEquals(h.errors, []);

        report.probe = await page.evaluate(async () => {
          const fetched = await fetch('https://csp-probe.invalid/fetch', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'refused');
          const image = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve('loaded');
            img.onerror = () => resolve('refused');
            img.src = 'https://csp-probe.invalid/image.png';
          });
          return { fetched, image };
        });
        assertEquals(report.probe, { fetched: 'refused', image: 'refused' });
        const end = Date.now() + 10000;
        while (h.cspReports.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
        const blocked = h.cspReports.map((body) => {
          const r = JSON.parse(body)['csp-report'];
          return `${r['effective-directive'] ?? r['violated-directive']} ${r['blocked-uri']}`;
        }).sort();
        report.probeReports = blocked;
        assertEquals(blocked, ['connect-src https://csp-probe.invalid/fetch', 'img-src https://csp-probe.invalid/image.png']);
      } finally {
        report.cspReports ??= [...h.cspReports];
        await Deno.writeTextFile(`${results}csp-${browser}.json`, JSON.stringify(report, null, 2) + '\n');
        await h.close();
      }
    },
  });

  // The other ways frames reach the core, each with its own browser APIs: an HDR recording decoded precisely (the
  // GPU and WebGL colour paths, the conversion workers) and the same recording through the compatibility decoder (a
  // native <video> on a blob: URL, captured by the page's frame bridge).
  Deno.test({
    name: `browser ${browser}: the CSP blocks nothing on the HDR and compatibility-decoder routes`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser, locale: 'en-US', csp: true });
      const report: Record<string, unknown> = { browser };
      try {
        const { page } = h;
        for (const decoder of ['precise', 'compatibility'] as const) {
          await page.goto(h.base + '/');
          await page.waitForFunction(() => 'longScreen' in globalThis);
          await page.setInputFiles('#file-input', new URL('../fixtures/hdr-pq.mp4', import.meta.url).pathname);
          await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#regions-btn')!.disabled, null, { timeout: 60000 });
          if (decoder === 'compatibility') {
            await page.click('#knobs-btn');
            await page.click('details.advanced > summary');
            await page.selectOption('#decoder', 'compatibility');
          }
          await page.evaluate(() => document.querySelector<HTMLButtonElement>('#start-btn')!.click());
          await page.waitForFunction(
            () => ['complete', 'partial', 'error'].includes((globalThis as unknown as Kit).longScreen?.getProject()?.status ?? ''),
            null,
            { timeout: 600000 },
          );
          const run = await page.evaluate(() => {
            const project = (globalThis as unknown as { longScreen: { getProject(): Project } }).longScreen.getProject();
            return { status: project.status, decoder: project.settings.decoder, hdrUnchecked: 'HDR_UNCHECKED' in project.diagnostics };
          });
          report[decoder] = run;
          assertEquals(run, { status: 'complete', decoder, hdrUnchecked: false });
        }
        await page.waitForTimeout(1500);
        report.cspReports = [...h.cspReports];
        report.external = [...h.external];
        report.errors = [...h.errors];
        assertEquals(h.cspReports, []);
        assertEquals(h.external, []);
        assertEquals(h.errors, []);
      } finally {
        report.cspReports ??= [...h.cspReports];
        await Deno.writeTextFile(`${results}csp-routes-${browser}.json`, JSON.stringify(report, null, 2) + '\n');
        await h.close();
      }
    },
  });
}
