import { type Browser, chromium, type Page } from 'playwright';
import { createHandler } from '../../main.ts';
export const root = new URL('../../', import.meta.url).pathname;
export interface Harness {
  browser: Browser;
  page: Page;
  base: string;
  errors: string[];
  external: string[];
  close(): Promise<void>;
}
/** Newest mtime under a directory, so a bundle can be compared against the sources it was built from. */
async function newest(dir: string): Promise<number> {
  let latest = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      latest = Math.max(latest, await newest(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.html') || entry.name.endsWith('.css')) {
      latest = Math.max(latest, (await Deno.stat(path)).mtime?.getTime() ?? 0);
    }
  }
  return latest;
}
/** Rebuilds dist/ whenever it is missing or older than src/ or static/. Testing a stale bundle would silently verify code that is no longer shipped. */
export async function rebuildIfStale(): Promise<void> {
  let built = 0;
  try {
    built = (await Deno.stat(`${root}dist/assets/testkit.js`)).mtime?.getTime() ?? 0;
  } catch {
    built = 0;
  }
  const sources = Math.max(await newest(`${root}src`), await newest(`${root}static`));
  if (built > sources) {
    return;
  }
  const build = await new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-read', '--allow-write', '--allow-run', '--allow-env', `${root}scripts/build.ts`],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  if (!build.success) {
    throw new Error('dist/ is stale and rebuilding it failed');
  }
}
/** Serves dist/ (built on demand) plus fixtures and optional real recordings, and launches the system Chrome, which has H.264/HEVC decoders. */
export async function harness(options: { viewport?: { width: number; height: number } } = {}): Promise<Harness> {
  await rebuildIfStale();
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    createHandler({ root: `${root}dist`, mounts: { '/fixtures/': `${root}tests/fixtures`, '/test_case/': `${root}test_case` } }),
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const browser = await chromium.launch({
    channel: Deno.env.get('LONGSCREEN_CHANNEL') || 'chrome',
    headless: true,
    executablePath: Deno.env.get('LONGSCREEN_CHROME') || undefined,
  });
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 1000 }, acceptDownloads: true });
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
      await browser.close();
      await server.shutdown();
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
