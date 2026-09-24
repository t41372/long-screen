import { type Browser, type BrowserContext, chromium, type Page, webkit } from 'playwright';
import { createHandler, isDistStale, runBuild } from '../../main.ts';
export const root = new URL('../../', import.meta.url).pathname;
export interface Harness {
  browser: Browser;
  page: Page;
  base: string;
  errors: string[];
  external: string[];
  close(): Promise<void>;
}
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
  } = {},
): Promise<Harness> {
  await rebuildIfStale();
  const server = Deno.serve(
    { port: 0, hostname: options.hostname || '127.0.0.1', onListen: () => {} },
    createHandler({ root: distTest, mounts: { '/fixtures/': `${root}tests/fixtures`, '/test_case/': `${root}test_case` } }),
  );
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
