/** The installed app (PWA): the service worker (src/sw.ts), the manifest and the header's install key
 *  (src/ui/install.ts), in real Chrome and Playwright WebKit.
 *
 *  Ways it could fail, each checked below:
 *  - the worker never installs (one precached URL fails, e.g. the page under the wrong name) → no offline copy;
 *  - the copy misses a file a run needs (a worker, the core build planCore picks, a font, the sample) → offline
 *    loads break or a run fails;
 *  - a page served from the copy loses cross-origin isolation (headers not kept) → the threads core goes unused;
 *  - online loads come from the copy instead of the network → a deploy does not reach visitors;
 *  - an update leaves the old build's cache behind;
 *  - Chrome does not consider the page installable (manifest or icons wrong);
 *  - the install key shows where it cannot work, hides where it can, or does the wrong thing when pressed.
 *
 *  "Offline" here is the server shut down: every request to the origin fails, as with no connection, in both
 *  browsers. The report goes to test-results/pwa-<browser>.json with screenshots beside it; regenerate with
 *  `deno test --allow-all tests/browser/pwa.test.ts`. */
import { assert, assertEquals } from '@std/assert';
import { type BrowserContext, chromium, devices, type Page, webkit } from 'playwright';
import { createHandler } from '../../main.ts';
import { distTest, harness, rebuildIfStale, root } from './support.ts';
import type { Project } from '../../src/types.ts';

const results = `${root}test-results/`;
await Deno.mkdir(results, { recursive: true });

/** A server for dist-test/ that can go away and come back on the same port (the same origin, so the same service
 *  worker), and can change what it serves: `marker` is added to the page's body, `nextBuild` replaces the build hash in
 *  sw.js (what a new deploy looks like to the browser). */
function server() {
  const handler = createHandler({ root: distTest });
  const state = { marker: '', nextBuild: '' };
  let port = 0, current: Deno.HttpServer<Deno.NetAddr> | undefined;
  const serve = () => {
    current = Deno.serve({ port, hostname: '127.0.0.1', onListen: () => {} }, async (request) => {
      const path = new URL(request.url).pathname;
      const change = path === '/' && state.marker
        ? (text: string) => text.replace('</body>', state.marker + '</body>')
        : path === '/sw.js' && state.nextBuild
        ? (text: string) => text.replace(/(\\"version\\":\\")[0-9a-f]+/, `$1${state.nextBuild}`)
        : undefined;
      if (!change) return handler(request);
      // A changed file is a new file: no 304 against the browser's copy of the old one.
      const headers = new Headers(request.headers);
      headers.delete('if-none-match');
      headers.delete('if-modified-since');
      const response = await handler(new Request(request.url, { headers }));
      const out = new Headers(response.headers);
      for (const name of ['content-length', 'etag', 'last-modified']) out.delete(name);
      return new Response(change(await response.text()), { status: response.status, headers: out });
    });
    port = current.addr.port;
  };
  serve();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    up: serve,
    down: async () => {
      await current?.shutdown();
      current = undefined;
    },
  };
}

async function launch(browser: 'chromium' | 'webkit') {
  const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'en-US' };
  if (browser === 'webkit') {
    // Ephemeral, not a persistent profile as elsewhere: in Playwright WebKit's persistent contexts the Cache API
    // stores nothing (put() resolves, keys() stays empty), which would make any offline copy impossible to test.
    const instance = await webkit.launch({ headless: true });
    const context = await instance.newContext(contextOptions);
    return { context, close: () => context.close().then(() => instance.close()) };
  }
  // Persistent in Chrome: Chrome never offers installing from an incognito context, which newContext() is.
  const profile = await Deno.makeTempDir({ prefix: 'long-screen-chrome-' });
  const context = await chromium.launchPersistentContext(profile, {
    ...contextOptions,
    channel: Deno.env.get('LONGSCREEN_CHANNEL') || 'chrome',
    headless: true,
  });
  return { context, close: () => context.close().then(() => Deno.remove(profile, { recursive: true })) };
}

/** Polls `check` in the page until it resolves true. The Cache API only answers with promises, and in WebKit
 *  waitForFunction returned before such a promise had resolved. */
async function until(page: Page, check: (arg: any) => Promise<boolean>, arg: unknown, timeout = 60000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await page.evaluate(check, arg)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Opens the app in a new tab. `errors` collects page errors; `failed` every network request that failed, workers'
 *  included (not blob: URLs, which the page's own video element aborts when it moves to another file):
 *  the app falls back quietly when a worker cannot start (frames convert in-thread instead), so a run that completes
 *  offline does not by itself show that the copy had every file. */
async function openApp(context: BrowserContext, base: string): Promise<{ page: Page; errors: string[]; failed: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [], failed: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => /^https?:/.test(r.url()) && failed.push(`${r.url()} ${r.failure()?.errorText}`));
  await page.goto(base + '/');
  await page.waitForFunction('!!window.longScreen');
  return { page, errors, failed };
}

/** The cache names this origin holds and, for each long-screen-* cache, how many entries it has. */
const cacheState = (page: Page) =>
  page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).length;
    return out;
  });

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name:
      `browser ${browser}: the installed app stores one whole build, opens and runs the demo offline, stays fresh online and drops the old build on update`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await rebuildIfStale();
      const { files, version } = JSON.parse(
        JSON.parse((await Deno.readTextFile(`${distTest}/sw.js`)).match(/JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)![1]),
      ) as { files: string[]; version: string };
      const site = server();
      const { context, close } = await launch(browser);
      const report: Record<string, unknown> = { browser, version, precached: files.length };
      try {
        let { page, errors, failed } = await openApp(context, site.base);
        const isolatedOnline = await page.evaluate('crossOriginIsolated');
        await page.evaluate('navigator.serviceWorker.ready');
        await until(
          page,
          ([name, count]: [string, number]) => caches.open(name).then((c) => c.keys()).then((k) => k.length === count),
          [`long-screen-${version}`, files.length],
        );
        report.cachesAfterInstall = await cacheState(page);
        assertEquals(report.cachesAfterInstall, { [`long-screen-${version}`]: files.length });

        if (browser === 'chromium') {
          const cdp = await context.newCDPSession(page);
          const installability = await cdp.send('Page.getInstallabilityErrors');
          const manifest = await cdp.send('Page.getAppManifest');
          report.installabilityErrors = installability.installabilityErrors;
          report.manifestErrors = manifest.errors;
          assertEquals(installability.installabilityErrors, []);
          assertEquals(manifest.errors, []);
        }

        // Online, controlled by the worker: the page still comes from the network, so a change on the server shows.
        site.state.marker = '<i id="served-fresh"></i>';
        await page.reload();
        await page.waitForFunction('!!window.longScreen');
        assert(await page.evaluate('!!navigator.serviceWorker.controller'), 'the reloaded page is controlled by the service worker');
        report.freshOnline = await page.evaluate("!!document.getElementById('served-fresh')");
        assert(report.freshOnline, 'an online reload under the service worker still loads the page from the network');
        site.state.marker = '';

        // Offline: the page, its workers and the core come from the copy, isolation intact, and a run completes.
        await site.down();
        failed.length = 0;
        await page.reload();
        await page.waitForFunction('!!window.longScreen', null, { timeout: 30000 });
        report.isolatedOnline = isolatedOnline;
        report.isolatedOffline = await page.evaluate('crossOriginIsolated');
        assertEquals(report.isolatedOffline, isolatedOnline);
        // The sample-recording demo, as a visitor would press it: the recording, the decoder's workers and the core
        // all have to come from the copy.
        await page.click('#demo-cta');
        await page.waitForFunction('["complete", "partial", "error"].includes(longScreen.getProject()?.status)', null, { timeout: 600000 });
        const project = await page.evaluate<Project>('longScreen.getProject()');
        report.offlineDemo = project.status;
        assertEquals(project.status, 'complete', JSON.stringify(project.status));
        await page.screenshot({ path: `${results}pwa-offline-${browser}.png`, fullPage: true });
        report.offlineFailedRequests = [...failed];
        assertEquals(failed, []);
        assertEquals(errors, []);

        // A new deploy: the changed sw.js installs the new build's cache beside the old one; once every tab of the old
        // worker is closed, the new one takes over and deletes the old build's cache.
        await site.up();
        const next = 'feedc0de00000000';
        site.state.nextBuild = next;
        report.updateInstalled = await page.evaluate(async () => {
          const registration = (await navigator.serviceWorker.getRegistration())!;
          await registration.update();
          const worker = registration.installing ?? registration.waiting;
          if (!worker) return 'no new worker';
          while (worker.state === 'installing') {
            await new Promise((resolve) => worker.addEventListener('statechange', resolve, { once: true }));
          }
          return worker.state;
        });
        assertEquals(report.updateInstalled, 'installed');
        report.cachesWhileWaiting = await cacheState(page);
        assertEquals(report.cachesWhileWaiting, { [`long-screen-${version}`]: files.length, [`long-screen-${next}`]: files.length });
        await page.close();
        ({ page, errors, failed } = await openApp(context, site.base));
        await until(page, () => caches.keys().then((k) => k.filter((n) => n.startsWith('long-screen-')).length === 1), null);
        report.cachesAfterUpdate = await cacheState(page);
        assertEquals(report.cachesAfterUpdate, { [`long-screen-${next}`]: files.length });
        assertEquals(errors, []);
      } finally {
        await Deno.writeTextFile(`${results}pwa-${browser}.json`, JSON.stringify(report, null, 2) + '\n');
        await close();
        await site.down();
      }
    },
  });
}

/** The install key's state after load: whether it shows, and which steps its dialog would show. */
const keyState = (page: Page) =>
  page.evaluate(() => ({
    shown: !document.querySelector<HTMLElement>('#install-btn')!.hidden,
    ios: !document.querySelector<HTMLElement>('#install-ios')!.hidden,
    mac: !document.querySelector<HTMLElement>('#install-mac')!.hidden,
  }));

Deno.test({
  name: 'browser chromium: the install key appears with the browser install prompt, asks once, and goes away once installed',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ locale: 'en-US' });
    try {
      const { page } = h;
      // Chrome decides on its own when to offer installing; the test keeps that offer from the page and makes its own,
      // with a prompt it can see.
      await page.addInitScript(() => {
        addEventListener('beforeinstallprompt', (e) => e.isTrusted && e.stopImmediatePropagation(), { capture: true });
      });
      await page.goto(h.base + '/');
      await page.waitForFunction('!!window.longScreen');
      assertEquals((await keyState(page)).shown, false, 'no key before the browser offers installing');
      const offer = () =>
        page.evaluate(() => {
          const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
            prompt: () => {
              (globalThis as unknown as { prompted: number }).prompted = ((globalThis as unknown as { prompted?: number }).prompted ?? 0) +
                1;
              return Promise.resolve();
            },
            userChoice: Promise.resolve({ outcome: 'dismissed' }),
          });
          dispatchEvent(event);
          return event.defaultPrevented;
        });
      assertEquals(await offer(), true, 'the page takes over the prompt (no mini-infobar)');
      assertEquals((await keyState(page)).shown, true);
      await page.screenshot({ path: `${results}pwa-key-chromium.png`, clip: { x: 0, y: 0, width: 1440, height: 90 } });
      await page.click('#install-btn');
      assertEquals(await page.evaluate('globalThis.prompted'), 1);
      assertEquals((await keyState(page)).shown, false, 'a used prompt cannot be shown again, so the key goes');
      assertEquals(await page.evaluate('document.querySelector("#install-dialog").open'), false);
      await offer();
      assertEquals((await keyState(page)).shown, true, 'a new offer brings it back');
      await page.evaluate("dispatchEvent(new Event('appinstalled'))");
      assertEquals((await keyState(page)).shown, false, 'installed: no key');
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: 'browser webkit: Safari shows the install key with the steps for its platform, and none when running installed',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await rebuildIfStale();
    const site = server();
    const iphone = devices['iPhone 13'];
    const cases = [
      {
        name: 'mac',
        options: { viewport: { width: 1440, height: 1000 } },
        standalone: false,
        expect: { shown: true, ios: false, mac: true },
      },
      { name: 'iphone', options: iphone, standalone: false, expect: { shown: true, ios: true, mac: false } },
      // iPadOS Safari reports itself as a Mac; touch points tell it apart.
      {
        name: 'ipad',
        options: { ...devices['iPad (gen 7)'], userAgent: devices['Desktop Safari'].userAgent },
        touchPoints: 5,
        standalone: false,
        expect: { shown: true, ios: true, mac: false },
      },
      { name: 'iphone-installed', options: iphone, standalone: true, expect: { shown: false, ios: true, mac: false } },
    ];
    const instance = await webkit.launch({ headless: true });
    try {
      for (const c of cases) {
        const context = await instance.newContext({ ...c.options, locale: 'en-US' });
        try {
          const page = await context.newPage();
          if (c.standalone) await page.addInitScript("Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true })");
          if ('touchPoints' in c) {
            await page.addInitScript(`Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => ${c.touchPoints} })`);
          }
          await page.goto(site.base + '/');
          await page.waitForFunction('!!window.longScreen');
          assertEquals(await keyState(page), c.expect, c.name);
          if (c.expect.shown) {
            await page.click('#install-btn');
            await page.waitForFunction('document.querySelector("#install-dialog").open');
            await page.screenshot({ path: `${results}pwa-steps-${c.name}.png` });
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await instance.close();
      await site.down();
    }
  },
});
