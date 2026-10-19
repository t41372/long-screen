/** The hosted site's usage counter (src/ui/analytics.ts, src/analytics.ts) in real Chrome and Playwright WebKit, under
 *  the deployed CSP and cross-origin isolation.
 *
 *  Ways it could fail, each checked below:
 *  - the SDK does not load or send under COEP require-corp and the CSP (a CDN script would be refused; a send to a
 *    host the policy leaves out would be blocked and reported);
 *  - a run is not counted, counted twice, or ends with the wrong status (a stopped run must say `stopped`);
 *  - an event carries the file name, or the browser keeps a cookie or a PostHog entry in localStorage;
 *  - it loads under Global Privacy Control, or on a host that is not the hosted site (the other browser tests and
 *    csp.test.ts already assert no request leaves 127.0.0.1 there; here the GPC page must not even fetch the SDK).
 *
 *  The page counts only on the hosted hostnames, so the test names 127.0.0.1 as one before the page loads
 *  (`__LS_COUNTED_HOSTS__`), masks the marks of an automated browser, and answers PostHog's host itself. With LONGSCREEN_ANALYTICS_LIVE=1 it sends to the real
 *  PostHog project instead and requires each send to be accepted (HTTP 200); those events have $host 127.0.0.1.
 *  The report goes to test-results/analytics-<browser>.json; regenerate with
 *  `deno test --allow-all tests/browser/analytics.test.ts`. */
import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
import type { Page } from 'playwright';

const results = new URL('../../test-results/', import.meta.url).pathname;
await Deno.mkdir(results, { recursive: true });
const live = Deno.env.get('LONGSCREEN_ANALYTICS_LIVE') === '1';
const POSTHOG = 'https://us.i.posthog.com/';

type Kit = { longScreen?: { getProject(): { status?: string } | undefined } };
const settled = () => ['complete', 'partial', 'error'].includes((globalThis as unknown as Kit).longScreen?.getProject()?.status ?? '');

interface Sent {
  url: string;
  status?: number;
  events: { event: string; properties: Record<string, unknown> }[];
  raw: string;
}

/** A PostHog request body: JSON, gzipped (the SDK compresses with CompressionStream where it can) or base64. */
async function decode(url: string, body: Uint8Array<ArrayBuffer>): Promise<{ raw: string; events: Sent['events'] }> {
  let raw: string;
  if (body[0] === 0x1f && body[1] === 0x8b) {
    raw = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else {
    raw = new TextDecoder().decode(body);
    if (new URL(url).searchParams.get('compression') === 'base64' || raw.startsWith('data=')) {
      raw = new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(raw.replace(/^data=/, ''))), (c) => c.charCodeAt(0)));
    }
  }
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.batch ?? [parsed];
  return {
    raw,
    events: list.map((e: { event: string; properties: Record<string, unknown> }) => ({ event: e.event, properties: e.properties })),
  };
}

function watchPostHog(page: Page, sent: Sent[]): void {
  page.on('requestfinished', async (request) => {
    if (!request.url().startsWith(POSTHOG) || request.method() !== 'POST') return;
    const body = request.postDataBuffer();
    if (!body) return;
    const response = await request.response();
    const decoded = await decode(request.url(), new Uint8Array(body)).catch((e) => ({ raw: `undecodable: ${e}`, events: [] }));
    sent.push({ url: request.url(), status: response?.status(), ...decoded });
  });
}

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser ${browser}: the hosted site counts page views and runs, sends nothing identifying, and stays off under GPC`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser, locale: 'en-US', csp: true });
      const report: Record<string, unknown> = { browser, live };
      const sent: Sent[] = [];
      try {
        const { page } = h;
        const context = page.context();
        // PostHog drops events from browsers that look automated (navigator.webdriver, a HeadlessChrome user agent),
        // which is what the hosted site wants from real bots; the test browser looks like an ordinary one instead.
        await context.addInitScript(() => {
          (globalThis as unknown as { __LS_COUNTED_HOSTS__: string[] }).__LS_COUNTED_HOSTS__ = ['127.0.0.1'];
          const agent = navigator.userAgent.replace('HeadlessChrome', 'Chrome');
          Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
          Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => agent });
        });
        if (!live) {
          await context.route(`${POSTHOG}**`, (route) => {
            const origin = route.request().headers()['origin'] ?? '*';
            route.fulfill({
              status: 200,
              contentType: 'application/json',
              headers: {
                'access-control-allow-origin': origin,
                'access-control-allow-credentials': 'true',
                'access-control-allow-headers': '*',
                'access-control-allow-methods': 'POST, OPTIONS',
              },
              body: '{"status":"Ok"}',
            });
          });
        }
        watchPostHog(page, sent);
        await page.goto(h.base + '/');
        await page.waitForFunction(() => 'longScreen' in globalThis);
        report.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
        assertEquals(report.crossOriginIsolated, true);

        // A whole run (the demo), then one stopped part-way.
        await page.click('#demo-cta');
        await page.waitForFunction(settled, null, { timeout: 600000 });
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#start-btn')!.disabled, null, { timeout: 30000 });
        // By script: the sample is short, and Stop must land while the run is still going.
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('#start-btn')!.click());
        await page.waitForFunction(
          () => document.body.classList.contains('is-processing') && !!(globalThis as unknown as Kit).longScreen?.getProject(),
          null,
          {
            timeout: 60000,
            polling: 50,
          },
        );
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('#stop-btn')!.click());
        await page.waitForFunction(() => !document.body.classList.contains('is-processing'), null, { timeout: 600000 });

        const end = Date.now() + 30000;
        const events = () => sent.flatMap((s) => s.events);
        while (events().filter((e) => e.event === 'run_finished').length < 2 && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 250));
        }
        report.requests = sent.map(({ url, status, events }) => ({ url: url.split('?')[0], status, events: events.map((e) => e.event) }));
        report.events = events();
        const names = events().map((e) => e.event);
        assertEquals(names.filter((n) => n === '$pageview').length, 1);
        assertEquals(names.filter((n) => n === 'run_started').length, 2);
        const finished = events().filter((e) => e.event === 'run_finished').map((e) => e.properties);
        assertEquals(finished.map((p) => p.status), ['complete', 'stopped']);
        for (const p of finished) {
          assert(typeof p.frames === 'string' && /^\d+(-\d+|\+)$/.test(p.frames), `frames bucket: ${p.frames}`);
          assert(typeof p.elapsed_s === 'number');
          assertEquals(p.error_codes, []);
        }
        const started = events().filter((e) => e.event === 'run_started').map((e) => e.properties);
        assertEquals(started.map((p) => p.demo), [true, true]);
        assertEquals(started[0].threads, true);
        assert(started.every((p) => typeof p.decoder === 'string' && typeof p.analysis_size === 'number'));
        if (live) assert(sent.every((s) => s.status === 200), JSON.stringify(report.requests));

        // Nothing identifying in any payload, and nothing kept in the browser.
        const everything = sent.map((s) => s.raw).join('\n');
        for (const leak of ['sample-recording', 'sample.mp4', '示例录屏']) assert(!everything.includes(leak), `payload contains ${leak}`);
        report.cookies = await context.cookies();
        assertEquals(report.cookies, []);
        report.storageKeys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
        assert(!(report.storageKeys as string[]).some((k) => /^ph_|posthog/i.test(k)), String(report.storageKeys));
        report.cspReports = [...h.cspReports];
        assertEquals(h.cspReports, []);
        report.external = [...new Set(h.external.map((u) => new URL(u).origin))];
        assertEquals(report.external, ['https://us.i.posthog.com']);
        assertEquals(h.errors, []);

        // Global Privacy Control: the SDK is never fetched and nothing is sent.
        const gpc = await context.newPage();
        await gpc.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
        const gpcRequests: string[] = [];
        gpc.on('request', (r) => {
          if (r.url().includes('analytics.js') || r.url().startsWith(POSTHOG)) gpcRequests.push(r.url());
        });
        await gpc.goto(h.base + '/');
        await gpc.waitForFunction(() => 'longScreen' in globalThis);
        await gpc.waitForTimeout(3000);
        report.gpcRequests = gpcRequests;
        assertEquals(gpcRequests, []);
      } finally {
        report.requests ??= sent.map(({ url, status, raw }) => ({ url, status, raw }));
        await Deno.writeTextFile(`${results}analytics-${browser}${live ? '-live' : ''}.json`, JSON.stringify(report, null, 2) + '\n');
        await h.close();
      }
    },
  });
}
