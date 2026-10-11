/** The npm/JSR package (src/package/, built by scripts/build-package.ts into dist-package/) used the way another site
 *  would use it, in real Chrome and WebKit: tests/package/consumer.html imports the built `index.js` through an import
 *  map and reconstructs the app's sample recording (static/demo/sample.mp4)
 *   - on a cross-origin-isolated page, where the threaded core must load;
 *   - on a page without COOP/COEP, where the single-thread SIMD core must load instead;
 *   - bundled by `deno bundle` (esbuild) into one consumer script with the package's files copied next to it.
 *  Each run's PNGs must be byte-identical to the app's own reconstruction of the same recording in the same browser,
 *  and no package database may be left behind, after a finished run or a cancelled one. The package's declarations
 *  must also type-check from a consumer's TypeScript. Writes test-results/ts-package/package-e2e.json and a
 *  screenshot per run. */
import { assert, assertEquals } from '@std/assert';
import { ensureDir } from '@std/fs';
import type { Page } from 'playwright';
import { createHandler } from '../../main.ts';
import { harness, root } from './support.ts';
import { DEFAULT_SETTINGS } from '../../src/types.ts';

const out = `${root}test-results/ts-package/`;
const pkg = `${root}dist-package`;
const bundled = `${out}bundled`;
const SAMPLE = '/sample/sample.mp4';
/** Every run here, the app's and the package's, converts decoded frames on the CPU (`compute: 'cpu'`). With the
 *  default `auto`, the first frame times a WebGPU conversion against the CPU one and keeps the faster, and the two
 *  convert YUV to RGB slightly differently, so two runs of the app itself can differ in pixels; the comparison would
 *  then test that timing race instead of the package. */
await ensureDir(out);

async function deno(args: string[]): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), { args, cwd: root, stdout: 'inherit', stderr: 'inherit' }).output();
  if (!result.success) throw new Error(`deno ${args.join(' ')} failed (exit ${result.code})`);
}

/** Builds dist-package/ from this checkout (the core comes from rust/target, which the browser suite's own build
 *  keeps current), then bundles the consumer with `deno bundle` the way an esbuild user would and copies the
 *  package's files next to the bundle. */
async function prepare(): Promise<void> {
  await deno(['run', '-A', 'scripts/build-package.ts', '--skip-core']);
  await Deno.remove(bundled, { recursive: true }).catch(() => {});
  await ensureDir(bundled);
  const config = `${out}bundle-config.json`;
  await Deno.writeTextFile(config, JSON.stringify({ imports: { 'long-screen': `${pkg}/index.js` } }, null, 2));
  await deno([
    'bundle',
    '--platform',
    'browser',
    '--quiet',
    '--config',
    config,
    '-o',
    `${bundled}/consumer.js`,
    'tests/package/consumer.js',
  ]);
  for await (const entry of Deno.readDir(pkg)) {
    if (/\.(?:js|wasm)$/.test(entry.name) && entry.name !== 'index.js') {
      await Deno.copyFile(`${pkg}/${entry.name}`, `${bundled}/${entry.name}`);
    }
  }
  // The same page; its import map is unused, since the bundle no longer imports `long-screen`.
  await Deno.copyFile(`${root}tests/package/consumer.html`, `${bundled}/index.html`);
  const script = await Deno.readTextFile(`${bundled}/consumer.js`);
  assert(!/from\s*["']long-screen["']/.test(script), 'the bundle inlines the package');
  assert(script.includes('new URL("./worker.js", import.meta.url)'), 'the bundle keeps the worker reference relative to itself');
  // A consumer's TypeScript sees the published declarations through index.js's @ts-self-types directive.
  const typed = `${out}typed-consumer.ts`;
  await Deno.writeTextFile(
    typed,
    [
      "import { type Diagnostic, type Print, reconstruct, type ReconstructResult } from 'long-screen';",
      "const run = reconstruct(new Blob(), { locale: 'zh', settings: { framing: 'region' }, onProgress: (p) => p.fraction });",
      'const result: ReconstructResult = await run.result;',
      'const png: Blob = result.prints[0].png;',
      'const first: Print | undefined = result.prints[0];',
      'const codes: string[] = result.diagnostics.map((d: Diagnostic) => d.code);',
      '// @ts-expect-error: a setting outside the allowed values',
      'reconstruct(new Blob(), { settings: { tileSize: 300 } });',
      'export { codes, first, png };',
      '',
    ].join('\n'),
  );
  await deno(['check', '--config', config, typed]);
}

/** Serves the consumer, the built package and the sample. Without isolation, the COOP/COEP/CORP headers the dev
 *  server always sends are taken off again, as on a host that sends none. */
function serve(isolated: boolean): { base: string; close: () => Promise<void> } {
  const handler = createHandler({
    root: `${root}tests/package`,
    mounts: { '/dist-package/': pkg, '/sample/': `${root}static/demo`, '/bundled/': bundled },
  });
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (request) => {
    const response = await handler(request);
    if (isolated) return response;
    const headers = new Headers(response.headers);
    for (const name of ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']) headers.delete(name);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

interface PrintHash {
  kind: string;
  width: number;
  height: number;
  sha256: string;
}
interface ConsumerRun {
  status: string;
  error?: string;
  frames: number;
  ms: number;
  prints: (PrintHash & { id: string; name: string; label: string; fragment: number; bytes: number; type: string })[];
  codes: Record<string, number>;
  core?: { variant: string; threads: number; reason: string };
  phases: string[];
  crossOriginIsolated: boolean;
  leftDatabases: string[] | null;
}

/** The app's own print of the sample: the demo key, then each printable canvas exported as one PNG and hashed. */
async function appPrints(page: Page, base: string) {
  await page.goto(base + '/');
  await page.waitForFunction('!!window.longScreen');
  const started = performance.now();
  // See SAMPLE: frames are converted on the CPU, as in the package runs.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#compute')!;
    select.value = 'cpu';
    select.dispatchEvent(new Event('change'));
  });
  await page.click('#demo-cta');
  await page.waitForFunction('["complete","error","partial"].includes(longScreen.getProject()?.status)', null, { timeout: 240000 });
  const ms = Math.round(performance.now() - started);
  await page.waitForFunction('!document.querySelector("#export-png").disabled', null, { timeout: 30000 });
  return {
    ms,
    ...await page.evaluate(async () => {
      // deno-lint-ignore no-explicit-any
      const ls = (globalThis as any).longScreen;
      const project = ls.getProject();
      if (project.status !== 'complete') throw new Error(`app run ended ${project.status}: ${project.error}`);
      const rank = (c: { kind: string }) => c.kind === 'presentation' ? -1 : c.kind === 'fixed' ? 1 : 0;
      const canvases = (ls.getCanvases() as {
        id: string;
        kind: string;
        tileCount: number;
        attachedTo?: string;
        observedPixels: number;
        bounds: { width: number; height: number };
      }[])
        .filter((c) => c.tileCount > 0 && !c.attachedTo).sort((a, b) => rank(a) - rank(b) || b.observedPixels - a.observedPixels);
      const prints = [];
      for (const c of canvases) {
        const out = await ls.rpc('export', { projectId: project.id, canvasId: c.id, format: 'png', layout: 'single' });
        const bytes = await out.blob.arrayBuffer();
        if (out.temporary) await ls.rpc('cleanup-export', { key: out.temporary });
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        prints.push({
          kind: c.kind,
          width: Math.round(c.bounds.width),
          height: Math.round(c.bounds.height),
          sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
        });
      }
      const diagnostics: { code: string; message: string }[] = [];
      let after: string | undefined;
      while (true) {
        const rows = await ls.rpc('diagnostics', { projectId: project.id, after });
        diagnostics.push(...rows.map((r: { value: { code: string; message: string } }) => r.value));
        if (rows.length < 100) break;
        after = rows.at(-1).key;
      }
      const codes: Record<string, number> = {};
      for (const d of diagnostics) codes[d.code] = (codes[d.code] ?? 0) + 1;
      return {
        frames: project.renderedFrames,
        settings: project.settings,
        prints,
        codes,
        backend: diagnostics.find((d) => d.code === 'COMPUTE_BACKEND')?.message,
        conversion: diagnostics.find((d) => d.code === 'FRAME_CONVERSION')?.message,
      };
    }),
  };
}

async function consumerRun(page: Page, url: string, shot: string): Promise<ConsumerRun> {
  await page.goto(url);
  await page.waitForFunction('globalThis.consumerReady === true', null, { timeout: 30000 });
  const run = await page.evaluate(
    (sample) =>
      (globalThis as unknown as { runSample(url: string, settings: unknown): Promise<ConsumerRun> }).runSample(sample, { compute: 'cpu' }),
    SAMPLE,
  );
  await page.screenshot({ path: shot, fullPage: true });
  return run;
}

const report: Record<string, unknown> = {
  command: 'deno test --allow-all tests/browser/package.test.ts',
  sample: 'static/demo/sample.mp4',
};
let prepared: Promise<void> | undefined;

for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `package (${browser}): the built package reconstructs the sample like the app does, threaded or not, bundled or not`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await (prepared ??= prepare());
      const h = await harness({ browser, locale: 'en-US' });
      const isolated = serve(true), plain = serve(false);
      try {
        const app = await appPrints(h.page, h.base);
        assertEquals(app.settings, { ...DEFAULT_SETTINGS, compute: 'cpu' }, 'the app ran with the settings the package runs use');
        assert(app.prints.length > 0, 'the app composed a print');
        const page = await h.page.context().newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        const runs: Record<string, ConsumerRun> = {};
        const variants = [
          ['isolated', `${isolated.base}/consumer.html`, 'threads'],
          ['not-isolated', `${plain.base}/consumer.html`, 'simd'],
          ['bundled', `${isolated.base}/bundled/index.html`, 'threads'],
        ] as const;
        for (const [variant, url] of variants) runs[variant] = await consumerRun(page, url, `${out}${browser}-${variant}.png`);
        const cancelled = await page.evaluate(
          (sample) =>
            (globalThis as unknown as { cancelSample(url: string): Promise<{ outcome: string; leftDatabases: string[] }> }).cancelSample(
              sample,
            ),
          SAMPLE,
        );
        // Recorded before the checks below, so a failing run still leaves its numbers in the artifact.
        report[browser] = { app, runs, cancelled };
        await Deno.writeTextFile(`${out}package-e2e.json`, JSON.stringify(report, null, 2) + '\n');
        for (const [variant, , core] of variants) {
          const run = runs[variant];
          assertEquals(run.status, 'complete', run.error);
          assertEquals(run.crossOriginIsolated, variant !== 'not-isolated');
          assertEquals(run.core?.variant, core, `${variant}: ${run.core?.reason}`);
          assertEquals(run.frames, app.frames);
          assertEquals(
            run.prints.map(({ kind, width, height, sha256 }) => ({ kind, width, height, sha256 })),
            app.prints,
            `${variant}: the package's PNGs are the app's, byte for byte`,
          );
          assert(run.prints.every((p) => p.type === 'image/png' && p.label && p.name));
          assertEquals(run.phases.at(-1), 'export');
          assertEquals(run.leftDatabases, [], 'a finished call leaves no database behind');
        }
        assertEquals(cancelled, { outcome: 'AbortError', leftDatabases: [] }, 'cancel() rejects and leaves no database behind');
        assertEquals(errors, []);
      } finally {
        await isolated.close();
        await plain.close();
        await h.close();
      }
    },
  });
}
