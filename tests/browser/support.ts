import { type Browser, type BrowserContext, chromium, type Page, webkit } from 'playwright';
import { createHandler, isDistStale, runBuild } from '../../main.ts';
export const root = new URL('../../', import.meta.url).pathname;
export interface Harness {
  browser: Browser;
  page: Page;
  base: string;
  errors: string[];
  external: string[];
  /** Every Content-Security-Policy violation the page or its workers reported (the report bodies, as sent). */
  cspReports: string[];
  close(): Promise<void>;
}
/** Where the harness asks browsers to report CSP violations: every response's policy gets `report-uri` pointing here.
 *  A blocked resource is otherwise visible only in the browser's own console, which Playwright does not expose for
 *  workers, and the app falls back quietly from some of them (frames convert in-thread when a worker cannot start). */
const CSP_REPORTS = '/__csp-report';
/** The suite builds and serves its own dev build (with testkit.js and harness.html) in dist-test/, so it never
 *  replaces dist/ — a production dist/ from `deno task build:prod` stays exactly as it was built for a deploy, and a
 *  portable or production build never leaves these tests without their harness. */
export const distTest = `${root}dist-test`;
/** Rebuilds dist-test/ whenever it is missing or older than a build input (src/, static/ or the Rust core — see
 *  main.ts's `newestBuildInput`). Testing a stale bundle would silently verify code that is no longer shipped. The
 *  staleness decision and the build invocation are the same ones `deno task start` makes, imported from main.ts so
 *  there is exactly one of each. */
export async function rebuildIfStale(): Promise<void> {
  const { stale } = await isDistStale(root, distTest);
  if (stale && await runBuild(root, 'dist-test') !== 0) {
    throw new Error('dist-test/ is stale and rebuilding it failed');
  }
}
/** Serves dist-test/ (built on demand) plus fixtures and optional real recordings, and launches the system Chrome, which has H.264/HEVC decoders. */
export async function harness(
  options: {
    viewport?: { width: number; height: number };
    browser?: 'chromium' | 'webkit';
    hostname?: string;
    webgpu?: boolean;
    /** WebKit only: an ephemeral session, i.e. Safari Private Browsing (in-memory IndexedDB that rejects Blobs, no OPFS). */
    ephemeral?: boolean;
    /** Playwright context locale, e.g. 'en-US', 'zh-TW', 'ja-JP'. Defaults to 'zh-CN' so existing Chinese-text
     *  assertions keep working against a browser whose default locale (Playwright otherwise defaults to en-US)
     *  would now select the English UI. */
    locale?: string;
    /** Serve the app's Content-Security-Policy. Off by default, the header is left out: Playwright runs a string
     *  predicate (`waitForFunction('…')`, used throughout the suite) by evaluating the string in the page, which the
     *  policy forbids, and its `bypassCSP` option does not lift a header policy in WebKit. tests/browser/csp.test.ts
     *  turns it on and waits with functions instead. */
    csp?: boolean;
  } = {},
): Promise<Harness> {
  await rebuildIfStale();
  const handler = createHandler({ root: distTest, mounts: { '/fixtures/': `${root}tests/fixtures`, '/test_case/': `${root}test_case` } });
  const cspReports: string[] = [];
  const server = Deno.serve({ port: 0, hostname: options.hostname || '127.0.0.1', onListen: () => {} }, async (request) => {
    if (new URL(request.url).pathname === CSP_REPORTS) {
      cspReports.push(await request.text());
      return new Response(null, { status: 204 });
    }
    const response = await handler(request);
    const policy = response.headers.get('content-security-policy');
    if (!policy) return response;
    const headers = new Headers(response.headers);
    if (options.csp) headers.set('content-security-policy', `${policy}; report-uri ${CSP_REPORTS}`);
    else headers.delete('content-security-policy');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  const base = `http://${options.hostname || '127.0.0.1'}:${server.addr.port}`;
  const contextOptions = {
    viewport: options.viewport || { width: 1440, height: 1000 },
    acceptDownloads: true,
    locale: options.locale || 'zh-CN',
  };
  let browser: Browser, context: BrowserContext, profile: string | undefined;
  try {
    if (options.browser === 'webkit' && options.ephemeral) {
      browser = await webkit.launch({ headless: true });
      context = await browser.newContext(contextOptions);
    } else if (options.browser === 'webkit') {
      // A persistent profile is normal Safari storage; `ephemeral` gives the Private Browsing kind.
      profile = await Deno.makeTempDir({ prefix: 'long-screen-webkit-' });
      context = await webkit.launchPersistentContext(profile, { ...contextOptions, headless: true });
      browser = context.browser()!;
    } else {
      browser = await chromium.launch({
        channel: Deno.env.get('LONGSCREEN_CHANNEL') || 'chrome',
        headless: true,
        executablePath: Deno.env.get('LONGSCREEN_CHROME') || undefined,
        // Headless Linux Chrome only exposes WebGPU behind this flag; without a GPU it provides the SwiftShader
        // (software Vulkan) adapter, which runs the real Dawn/Tint stack: exact for integer kernels, not for timing.
        args: options.webgpu ? ['--enable-unsafe-webgpu'] : [],
      });
      context = await browser.newContext(contextOptions);
    }
  } catch (error) {
    await server.shutdown();
    if (profile) await Deno.remove(profile, { recursive: true });
    throw error;
  }
  const page = await context.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) external.push(r.url());
  });
  return {
    browser,
    page,
    base,
    errors,
    external,
    cspReports,
    close: async () => {
      await context.close();
      await browser.close();
      await server.shutdown();
      if (profile) await Deno.remove(profile, { recursive: true });
    },
  };
}
export async function realRecordings(): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${root}test_case`)) {
      if (entry.isFile && /\.(mov|mp4|webm)$/i.test(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch {
    // no recordings present
  }
  return names.sort();
}
