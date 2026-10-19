import { basename, dirname, join, resolve, toFileUrl } from '@std/path';
import { type Browser, chromium, type Page, webkit } from 'playwright';

/**
 * Benchmarks the shipped browser pipeline, rather than a Node/Deno substitute. It deliberately writes only JSON and
 * Chrome CPU profiles: the recording and reconstructed pixels never leave the local browser or get copied to output.
 *
 * Examples:
 *   deno run --allow-all scripts/benchmark-pipeline.ts --input recording.mov
 *   deno run --allow-all scripts/benchmark-pipeline.ts --input recording.mov --baseline-root .baseline
 *   deno run --allow-all scripts/benchmark-pipeline.ts --input recording.mov --browser safari
 */
/** Where the pipeline runs: Chrome (Playwright, with CPU profiles and CDP metrics), WebKit (Playwright's build of
 *  Safari's engine, headless, so nothing can throttle it by taking focus), or the Safari / Firefox installed on this
 *  Mac, opened on a page the benchmark serves. */
type BrowserName = 'chrome' | 'webkit' | 'safari' | 'firefox';
const SYSTEM_BROWSERS: Partial<Record<BrowserName, string>> = { safari: 'Safari', firefox: 'Firefox' };
interface Options {
  input: string;
  browser: BrowserName;
  root: string;
  baselineRoot?: string;
  passes: number;
  output: string;
  analysisSize: number;
  verifyTiles: boolean;
  allowPartial: boolean;
  /** Write each canvas as PNG and the evidence rows the recording oracles read (scripts/check-recording-oracles.py). */
  exportCanvases: boolean;
  /** Rebuild only the TS bundles, reusing the cores already in rust/target. */
  skipCoreBuild: boolean;
  /** Skip the Chrome CPU profile, whose sampling slows the run it records. */
  noProfile: boolean;
  /** Tile keys matching this pattern also get their raw evidence arrays written (diagnosing a hash difference). */
  dumpEvidence?: string;
}

interface PhaseTimes {
  [phase: string]: number;
}

interface BrowserMetricSet {
  [name: string]: number;
}

interface PassReport {
  pass: number;
  /** Core build the page actually ran (undefined for trees that predate the threaded core). */
  core?: { variant: string; threads: number; reason: string };
  crossOriginIsolated?: boolean;
  userAgent?: string;
  /** System browsers: 500 ms samples of the run, and how many found the tab hidden or unfocused (throttled). */
  focus?: { samples: number; hidden: number; unfocused: number };
  status: string;
  error?: string;
  source: {
    name: string;
    width: number;
    height: number;
    duration: number;
    frames?: number;
    codec: string;
    notices?: unknown[];
    /** How decoded frames became RGBA (FrameConverter.describe) and the last decode's timing (FrameSource.stats). */
    conversion?: string;
    lastDecode?: unknown;
  };
  pipeline: {
    frames: number;
    renderedFrames: number;
    seconds: number;
    phases: PhaseTimes;
    persistedTimings?: Record<string, unknown>;
  };
  consistency: {
    exactDuplicateFrames?: number;
    skippedPaints?: number;
    votedLayers?: number;
    thinLayers?: number;
    diagnostics: Record<string, number>;
  };
  png: {
    encodes: number;
    decodes: number;
    encodedBytes: number;
    decodedBytes: number;
    encodeMS: number;
    decodeMS: number;
  };
  storage: {
    putManyCalls: number;
    rows: number;
    writeMS: number;
    /** `<phase> <method>` → calls and milliseconds of every read, scan and delete. */
    access?: Record<string, { calls: number; ms: number }>;
  };
  memory: {
    stats?: unknown;
    native: BrowserMetricSet;
    page: BrowserMetricSet;
  };
  canvases: Array<{
    id: string;
    kind: string;
    bounds: unknown;
    tileCount: number;
    observedPixels: number;
    conflictPixels: number;
  }>;
  browserErrors: string[];
  failedRequests: string[];
  externalRequests: string[];
  cpuProfile?: string;
  /** `sha256` covers every stored PNG and evidence row, byte for byte — it legitimately differs across a codec
   *  change even when reconstruction is unchanged. `contentSha256` covers decoded pixels plus every evidence array
   *  (coverage/provisional/quality/conflicts/owner/score/frozen), not the PNG bytes, so it is what the cross-root
   *  gate below actually verifies; `pixelsSha256` is pixels alone, kept for diagnosing which half of
   *  `contentSha256` moved. Per-tile hashes are written next to the report as `<label>-pass-<n>.tiles.json`. */
  storedTiles?: { count: number; sha256: string; pixelsSha256?: string; contentSha256?: string; seconds: number };
}

interface BenchmarkReport {
  generatedAt: string;
  root: string;
  input: string;
  browser: BrowserName;
  passes: number;
  analysisSize: number;
  results: PassReport[];
  summary: {
    seconds: { median: number; min: number; max: number };
    phasesMS: Record<string, { median: number; min: number; max: number }>;
    storage: { medianPutManyCalls: number; medianRows: number; medianWriteMS: number };
    png: { medianEncodes: number; medianDecodes: number; medianEncodeMS: number; medianDecodeMS: number };
  };
}

const usage = `Usage: deno run --allow-all scripts/benchmark-pipeline.ts --input FILE [options]

Options:
  --root DIR             repository root to benchmark (default: current directory)
  --baseline-root DIR    also benchmark this repository root before --root
  --passes N             full pipeline passes per root (default: 1)
  --analysis-size N      analysis long-edge limit (default: 640)
  --verify-tiles         hash decoded tile pixels + evidence after timing; fail on differences across runs
                         (raw PNG byte differences are reported as info, not a failure — see contentSha256)
  --dump-evidence REGEX  with --verify-tiles, also write raw evidence arrays of matching tile keys
  --allow-partial        accept a partial run (a stream-copied prefix whose container count exceeds its frames)
  --export-canvases      after timing, write every observed canvas as PNG and the canvas/observation/node/diagnostic/
                         reveal rows as <label>-pass-N.evidence.json (what scripts/check-recording-oracles.py reads)
  --skip-core-build      rebuild only the TS bundles, reusing the cores already in rust/target
  --no-profile           do not record a Chrome CPU profile (its sampling slows the timed run)
  --browser NAME         chrome (default), webkit (Playwright's build), or the installed safari / firefox; the
                         installed browsers open a tab that must stay in front, and support neither
                         --verify-tiles nor --export-canvases
  --output DIR           JSON/profile directory (default: test-results/benchmark-pipeline)
`;

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.\n\n${usage}`);
  }
  return value;
}

function parseArgs(args: string[]): Options {
  let input = '',
    browser: BrowserName = 'chrome',
    root = Deno.cwd(),
    baselineRoot: string | undefined,
    passes = 1,
    output = join(Deno.cwd(), 'test-results/benchmark-pipeline'),
    analysisSize = 640,
    verifyTiles = false,
    allowPartial = false,
    exportCanvases = false,
    skipCoreBuild = false,
    noProfile = false;
  let dumpEvidence: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input') {
      input = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--root') {
      root = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--baseline-root') {
      baselineRoot = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--passes') {
      passes = Number(valueAfter(args, i++, arg));
    } else if (arg === '--analysis-size') {
      analysisSize = Number(valueAfter(args, i++, arg));
    } else if (arg === '--output') {
      output = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--verify-tiles') {
      verifyTiles = true;
    } else if (arg === '--dump-evidence') {
      dumpEvidence = valueAfter(args, i++, arg);
    } else if (arg === '--allow-partial') {
      allowPartial = true;
    } else if (arg === '--export-canvases') {
      exportCanvases = true;
    } else if (arg === '--skip-core-build') {
      skipCoreBuild = true;
    } else if (arg === '--no-profile') {
      noProfile = true;
    } else if (arg === '--browser') {
      const name = valueAfter(args, i++, arg);
      if (!['chrome', 'webkit', 'safari', 'firefox'].includes(name)) throw new Error(`Unknown browser: ${name}\n\n${usage}`);
      browser = name as BrowserName;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      Deno.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
    }
  }
  if (!input) throw new Error(`--input is required.\n\n${usage}`);
  if (SYSTEM_BROWSERS[browser] && (verifyTiles || exportCanvases)) {
    throw new Error(`--verify-tiles and --export-canvases need a Playwright browser (chrome or webkit).`);
  }
  if (browser !== 'chrome') noProfile = true;
  if (!Number.isInteger(passes) || passes < 1 || passes > 20) throw new Error('--passes must be an integer from 1 to 20.');
  if (!Number.isInteger(analysisSize) || analysisSize < 320) throw new Error('--analysis-size must be an integer of at least 320.');
  if (!Deno.statSync(input).isFile) throw new Error(`Input is not a file: ${input}`);
  if (!Deno.statSync(root).isDirectory) throw new Error(`Repository root is not a directory: ${root}`);
  if (baselineRoot && !Deno.statSync(baselineRoot).isDirectory) throw new Error(`Baseline root is not a directory: ${baselineRoot}`);
  return {
    input,
    browser,
    root,
    baselineRoot,
    passes,
    output,
    analysisSize,
    verifyTiles,
    allowPartial,
    exportCanvases,
    skipCoreBuild,
    noProfile,
    dumpEvidence,
  };
}

/** The benchmark body, run inside the page: Playwright evaluates it, and benchmarkPage() serialises it for a system
 *  browser. It may only use what the page has (the test kit), never this module's scope. */
const benchmarkInPage = async ([sourceURL, analysis, verify]: [string, number, boolean]) => {
  const kit = (globalThis as any).longScreenKit;
  const inputName = decodeURIComponent(sourceURL.split('/').pop() || 'recording');
  const file = new File([await (await fetch(sourceURL)).blob()], inputName);
  const db = await kit.Database.open();
  const storage = { putManyCalls: 0, rows: 0, writeMS: 0 };
  const originalPutMany = db.putMany.bind(db);
  db.putMany = async (rows: Array<{ key: string; value: unknown }>) => {
    const started = performance.now();
    storage.putManyCalls++;
    storage.rows += rows.length;
    try {
      await originalPutMany(rows);
    } finally {
      storage.writeMS += performance.now() - started;
    }
  };
  // Reads, scans, deletes and writes per pipeline phase (`phase` below), so a slow store shows which stage pays for it.
  const access: Record<string, { calls: number; ms: number }> = {};
  for (const method of ['get', 'scan', 'delete', 'deleteMany', 'putMany'] as const) {
    const original = (db as any)[method].bind(db);
    (db as any)[method] = async (...args: unknown[]) => {
      // Writes are told apart by their first row's key family (run/<id>/ stripped), e.g. "solving putMany node".
      const first = method === 'putMany' ? (args[0] as Array<{ key: string }>)[0]?.key : undefined;
      const family = first ? ' ' + first.replace(/^run\/[^/]+\//, '').split('/')[0] : '';
      const started = performance.now(), bucket = access[`${phase || 'setup'} ${method}${family}`] ??= { calls: 0, ms: 0 };
      bucket.calls++;
      try {
        return await original(...args);
      } finally {
        bucket.ms += performance.now() - started;
      }
    };
  }
  const source = await kit.openMedia(file);
  const png = { encodes: 0, decodes: 0, encodedBytes: 0, decodedBytes: 0, encodeMS: 0, decodeMS: 0 };
  const phases: Record<string, number> = {};
  let phase = '', phaseStarted = performance.now(), lastProgressAt = 0;
  const diagnostics: Record<string, number> = {};
  const engine = new kit.Engine(db, source, { ...kit.DEFAULT_SETTINGS, analysisSize: analysis }, {
    progress: (progress: { phase: string; frames: number }) => {
      const now = performance.now();
      const phaseChanged = progress.phase !== phase;
      if (progress.phase !== phase) {
        if (phase) phases[phase] = (phases[phase] || 0) + now - phaseStarted;
        phase = progress.phase;
        phaseStarted = now;
      }
      if (phaseChanged || now - lastProgressAt >= 10000) {
        console.log(`BENCHMARK ${phase} (${progress.frames} frames)`);
        lastProgressAt = now;
      }
    },
    diagnostic: (diagnostic: { code: string }) => {
      diagnostics[diagnostic.code] = (diagnostics[diagnostic.code] || 0) + 1;
    },
    project: () => {},
  });
  const originalCodec = engine.tiles.codec;
  (engine.tiles as any).codec = {
    encode: async (image: unknown) => {
      const started = performance.now();
      png.encodes++;
      try {
        const blob = await originalCodec.encode(image);
        png.encodedBytes += blob.size;
        return blob;
      } finally {
        png.encodeMS += performance.now() - started;
      }
    },
    decode: async (blob: Blob, size: number) => {
      const started = performance.now();
      png.decodes++;
      png.decodedBytes += blob.size;
      try {
        return await originalCodec.decode(blob, size);
      } finally {
        png.decodeMS += performance.now() - started;
      }
    },
  };
  const started = performance.now();
  const project = await engine.run();
  const seconds = (performance.now() - started) / 1000;
  if (phase) phases[phase] = (phases[phase] || 0) + performance.now() - phaseStarted;
  const performanceRow = await engine.store.get('performance');
  const memory = await engine.store.get('memory-stats');
  const canvases: Array<Record<string, unknown>> = [];
  for await (const { value } of kit.iterate(engine.store, 'canvas/')) canvases.push(value);
  const diagnosticsRows: Array<{ code: string }> = [];
  for await (const { value } of kit.iterate(engine.store, 'diagnostic/')) diagnosticsRows.push(value);
  const info = source.info, conversion = source.conversion?.(), sourceStats = source.stats;
  source.dispose();
  // The system-browser page (benchmarkPage) closes and deletes the database afterwards.
  (globalThis as any).benchmarkDatabase = db;
  if (verify) {
    (globalThis as any).benchmarkStore = engine.store;
    (globalThis as any).benchmarkProject = project;
  }
  return {
    pass: 0,
    core: kit.corePlan ? { variant: kit.corePlan.variant, threads: kit.coreThreads(), reason: kit.corePlan.reason } : undefined,
    crossOriginIsolated: (globalThis as any).crossOriginIsolated,
    status: project.status,
    error: project.error,
    source: {
      name: info.name,
      width: info.width,
      height: info.height,
      duration: info.duration,
      frames: info.frameCount,
      codec: info.codec,
      notices: info.notices,
      conversion,
      lastDecode: sourceStats,
    },
    pipeline: {
      frames: project.frames,
      renderedFrames: project.renderedFrames,
      seconds,
      phases,
      persistedTimings: performanceRow,
    },
    consistency: {
      exactDuplicateFrames: (performanceRow as any)?.exactDuplicateFrames,
      skippedPaints: (performanceRow as any)?.skippedPaints,
      votedLayers: (performanceRow as any)?.consistencyVotedLayers,
      thinLayers: (performanceRow as any)?.consistencyThinLayers,
      diagnostics: Object.fromEntries(
        diagnosticsRows.reduce((counts, row) => counts.set(row.code, (counts.get(row.code) || 0) + 1), new Map<string, number>()),
      ),
    },
    png,
    storage: { ...storage, access },
    memory: { stats: memory, native: {}, page: {} },
    canvases: canvases.map((canvas) => ({
      id: canvas.id as string,
      kind: canvas.kind as string,
      bounds: canvas.bounds,
      tileCount: canvas.tileCount as number,
      observedPixels: canvas.observedPixels as number,
      conflictPixels: canvas.conflictPixels as number,
    })),
    browserErrors: [],
    failedRequests: [],
    externalRequests: [],
  } satisfies PassReport;
};

function recordingURL(base: string, input: string): string {
  return `${base}/recording/${encodeURIComponent(basename(input))}`;
}

/** The page a system browser opens: runs benchmarkInPage once per pass and posts each report (and progress lines and
 *  page errors) back to the benchmark server, deleting the run's database between passes so the browser profile
 *  keeps nothing. */
function benchmarkPage(sourceURL: string, analysis: number, passes: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Long Screen benchmark</title>
<p id="status">Benchmark running. Keep this tab in front until it says it is done.</p>
<script type="module" src="/assets/testkit.js"></script>
<script type="module">
const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
const log = console.log.bind(console);
console.log = (...parts) => {
  log(...parts);
  const message = parts.join(' ');
  if (message.startsWith('BENCHMARK ')) post('/__bench/progress', { message });
};
addEventListener('error', (event) => post('/__bench/error', { message: String(event.message) }));
addEventListener('unhandledrejection', (event) => post('/__bench/error', { message: String(event.reason?.stack || event.reason) }));
const status = document.getElementById('status');
const run = ${benchmarkInPage.toString()};
const drop = () => new Promise((resolve) => {
  const request = indexedDB.deleteDatabase('long-screen-local');
  request.onsuccess = request.onerror = request.onblocked = () => resolve();
});
while (!globalThis.longScreenKit) await new Promise((resolve) => setTimeout(resolve, 50));
await post('/__bench/progress', { message: 'BENCHMARK page ready' });
for (let pass = 1; pass <= ${passes}; pass++) {
  status.textContent = 'Benchmark pass ' + pass + ' of ${passes} running. Keep this tab in front.';
  await drop();
  // A hidden or unfocused tab is throttled, so the report says how much of the run it was in front.
  const focus = { samples: 0, hidden: 0, unfocused: 0 };
  const sampler = setInterval(() => {
    focus.samples++;
    if (document.visibilityState !== 'visible') focus.hidden++;
    if (!document.hasFocus()) focus.unfocused++;
  }, 500);
  try {
    const report = await run(${JSON.stringify([sourceURL, analysis, false])});
    clearInterval(sampler);
    report.userAgent = navigator.userAgent;
    report.focus = focus;
    globalThis.benchmarkDatabase?.close();
    await post('/__bench/report', { pass, report });
  } catch (error) {
    clearInterval(sampler);
    globalThis.benchmarkDatabase?.close();
    // WebKit's stack omits the message, so send both.
    await post('/__bench/report', { pass, error: String(error) + '\\n' + (error?.stack || '') });
  }
  delete globalThis.benchmarkDatabase;
}
await drop();
// Leave nothing running: the test kit's core keeps its helper workers alive for as long as the page is open, and
// enough finished tabs holding them stop the next tab's core from starting.
location.replace('about:blank');
</script>
`;
}

async function runBuild(root: string, skipCoreBuild: boolean): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['task', 'build', ...(skipCoreBuild ? ['--skip-core'] : [])],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const result = await command.output();
  if (!result.success) throw new Error(`Building ${root} failed with exit code ${result.code}.`);
}

/** What a system-browser page posts back (benchmarkPage). */
type PageMessage =
  | { kind: 'report'; pass: number; report?: PassReport; error?: string }
  | { kind: 'progress'; message: string }
  | { kind: 'error'; message: string };

interface Server {
  base: string;
  close: () => Promise<void>;
  /** Serves benchmarkPage at /__bench/page.html; messages it posts arrive here. */
  page?: { html: string; listen: (message: PageMessage) => void };
}

async function startServer(root: string, input: string): Promise<Server> {
  // Import the target root's handler so --baseline-root really runs the old source tree, not the current checkout.
  const moduleURL = `${toFileUrl(join(root, 'main.ts')).href}?benchmark=${Date.now()}-${Math.random()}`;
  const { createHandler } = await import(moduleURL) as typeof import('../main.ts');
  const handler = createHandler({ root: join(root, 'dist'), mounts: { '/recording/': dirname(input) } });
  const state: Server = { base: '', close: async () => {} };
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__bench/') || !state.page) return handler(request);
    if (request.method === 'GET' && path === '/__bench/page.html') {
      // Same isolation headers as the app (main.ts), so the page gets the threaded core.
      return new Response(state.page.html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-resource-policy': 'same-origin',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      const kind = path.slice('/__bench/'.length);
      if (kind === 'report' || kind === 'progress' || kind === 'error') state.page.listen({ kind, ...body });
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  });
  state.base = `http://127.0.0.1:${server.addr.port}`;
  state.close = async () => await server.shutdown();
  return state;
}

/** Runs every pass in the installed Safari or Firefox: one tab on benchmarkPage, reports posted back per pass. */
async function runSystemPasses(options: Options, server: Server, label: string): Promise<PassReport[]> {
  const app = SYSTEM_BROWSERS[options.browser]!, reports: PassReport[] = [], errors: string[] = [];
  let ready = false;
  let progressPath = join(options.output, `${label}-pass-1.progress.jsonl`);
  await Deno.writeTextFile(progressPath, '');
  const done = new Promise<void>((resolve, reject) => {
    server.page = {
      html: benchmarkPage(recordingURL(server.base, options.input), options.analysisSize, options.passes),
      listen: (message) => {
        if (message.kind === 'progress') {
          ready = true;
          console.log(`${label}: ${message.message}`);
          Deno.writeTextFileSync(progressPath, JSON.stringify({ at: new Date().toISOString(), message: message.message }) + '\n', {
            append: true,
          });
        } else if (message.kind === 'error') {
          errors.push(message.message);
        } else if (message.error || !message.report) {
          reject(new Error(`${label} pass ${message.pass} failed in ${app}: ${message.error}`));
        } else {
          reports.push({ ...message.report, pass: message.pass, browserErrors: errors.splice(0) });
          progressPath = join(options.output, `${label}-pass-${message.pass + 1}.progress.jsonl`);
          if (reports.length === options.passes) resolve();
          else Deno.writeTextFileSync(progressPath, '');
        }
      },
    };
  });
  // The page's script is assembled from strings; a syntax slip there would only show as a page that never starts.
  const inline = server.page!.html.match(/<script type="module">([\s\S]*)<\/script>/)?.[1] ?? '';
  try {
    new Function(`return (async () => {\n${inline}\n});`);
  } catch (error) {
    throw new Error(`${label}: the benchmark page's script does not parse: ${error}`);
  }
  const opened = await new Deno.Command('open', { args: ['-a', app, `${server.base}/__bench/page.html`] }).output();
  if (!opened.success) throw new Error(`Could not open ${app}: ${new TextDecoder().decode(opened.stderr)}`);
  let timer: number | undefined, watchdog: number | undefined;
  try {
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        // A page that never loads the test kit (a wrong path, a blocked script) would otherwise wait the full hour.
        watchdog = setTimeout(() => {
          if (!ready) {
            reject(new Error(`${label}: the ${app} page did not start within 2 minutes (errors: ${errors.join('; ') || 'none'})`));
          }
        }, 2 * 60 * 1000);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: no report from ${app} within 60 minutes`)), 60 * 60 * 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
  }
  return reports;
}

function metricMap(metrics: Array<{ name: string; value: number }>): BrowserMetricSet {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

function metricDelta(before: BrowserMetricSet, after: BrowserMetricSet, names: string[]): BrowserMetricSet {
  return Object.fromEntries(names.map((name) => [name, Math.max(0, (after[name] || 0) - (before[name] || 0))]));
}

async function waitForHarness(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/harness.html`, { waitUntil: 'load' });
  // A function, not a string: the page's CSP forbids evaluating strings, which is how Playwright runs a string predicate.
  await page.waitForFunction(() => 'longScreenKit' in globalThis);
}

async function runPass(
  browser: Browser,
  base: string,
  input: string,
  analysisSize: number,
  pass: number,
  output: string,
  label: string,
  verifyTiles: boolean,
  exportCanvases: boolean,
  profile: boolean,
  dumpEvidence?: string,
): Promise<PassReport> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const progressPath = join(output, `${label}-pass-${pass}.progress.jsonl`);
  await Deno.writeTextFile(progressPath, '');
  let lastProgress = '';
  page.on('console', (message) => {
    if (!message.text().startsWith('BENCHMARK ')) return;
    lastProgress = message.text();
    console.log(`${label}: ${lastProgress}`);
    Deno.writeTextFileSync(progressPath, JSON.stringify({ at: new Date().toISOString(), message: lastProgress }) + '\n', { append: true });
  });
  const pageErrors: string[] = [], failedRequests: string[] = [], externalRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on(
    'requestfailed',
    (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.trim()),
  );
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) externalRequests.push(request.url());
  });
  // CDP (metrics, CPU profile) is Chrome's; WebKit runs report empty browser metrics.
  const cdp = page.context().browser()?.browserType().name() === 'chromium'
    ? await context.newCDPSession(page)
    : { send: async (method: string) => method === 'Performance.getMetrics' ? { metrics: [] } : {} };
  await cdp.send('Performance.enable');
  await waitForHarness(page, base);
  const beforeMetrics = metricMap(
    (await cdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> }).metrics,
  );
  let profilerStarted = false;
  let cpuProfile: unknown;
  let failed = false;
  const profilePath = join(output, `${label}-pass-${pass}.cpuprofile`);
  if (profile) {
    try {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      profilerStarted = true;
    } catch (error) {
      console.warn(`CPU profiler unavailable for ${label} pass ${pass}: ${String(error)}`);
    }
  }
  let report: PassReport;
  try {
    report = await page.evaluate(benchmarkInPage, [recordingURL(base, input), analysisSize, verifyTiles || exportCanvases] as [
      string,
      number,
      boolean,
    ]);
  } catch (error) {
    failed = true;
    await Deno.writeTextFile(
      join(output, `${label}-pass-${pass}.failure.json`),
      JSON.stringify(
        {
          pass,
          status: 'error',
          error: String(error),
          lastProgress,
          browserErrors: pageErrors,
          failedRequests,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (profilerStarted) {
      try {
        cpuProfile = (await cdp.send('Profiler.stop') as { profile: unknown }).profile;
      } catch (error) {
        console.warn(`CPU profiler stop failed for ${label} pass ${pass}: ${String(error)}`);
      }
      await cdp.send('Profiler.disable').catch(() => {});
    }
    if (cpuProfile) await Deno.writeTextFile(profilePath, JSON.stringify(cpuProfile));
    if (failed) await context.close();
  }
  const afterMetrics = metricMap((await cdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> }).metrics);
  const nativeNames = [
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
    'RecalcStyleDuration',
    'LayoutCount',
    'RecalcStyleCount',
    'RasterTaskDuration',
    'JSHeapUsedSize',
    'JSHeapTotalSize',
    'ThreadTime',
    'ProcessTime',
  ];
  report.memory.native = metricDelta(beforeMetrics, afterMetrics, nativeNames);
  report.memory.page = {
    jsHeapUsedBytes: afterMetrics.JSHeapUsedSize || 0,
    jsHeapTotalBytes: afterMetrics.JSHeapTotalSize || 0,
  };
  report.pass = pass;
  report.browserErrors = pageErrors;
  report.failedRequests = failedRequests;
  report.externalRequests = externalRequests;
  if (cpuProfile) {
    report.cpuProfile = profilePath;
  }
  if (verifyTiles) {
    report.storedTiles = await page.evaluate(async (dump: string | undefined) => {
      const started = performance.now(), kit = (globalThis as any).longScreenKit;
      const digest = async (bytes: ArrayBuffer): Promise<string> => {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
      };
      const rows: unknown[] = [], tiles: unknown[] = [];
      for await (const { key, value } of kit.iterate((globalThis as any).benchmarkStore, 'tile/')) {
        const png = await value.blob.arrayBuffer();
        const hashes: Record<string, string> = { png: await digest(png) };
        for (const field of ['coverage', 'provisional', 'quality', 'conflicts', 'owner', 'score', 'frozen']) {
          const data = value[field] as ArrayBufferView | undefined;
          if (data) hashes[field] = await digest(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer);
        }
        rows.push({ key, hashes });
        // Decoded pixels too, so a PNG-encoder change can be told apart from a pixel change.
        const image = await kit.decodePNG(new Uint8Array(png));
        const evidence = dump && new RegExp(dump).test(key)
          ? Object.fromEntries(
            ['coverage', 'provisional', 'quality', 'conflicts', 'owner', 'score', 'frozen']
              .filter((f) => value[f])
              .map((f) => [f, Array.from(value[f] as ArrayLike<number>)]),
          )
          : undefined;
        tiles.push({ key, hashes: { ...hashes, pixels: await digest(image.data.slice().buffer) }, evidence });
      }
      const evidenceFields = ['coverage', 'provisional', 'quality', 'conflicts', 'owner', 'score', 'frozen'];
      return {
        count: rows.length,
        sha256: await digest(new TextEncoder().encode(JSON.stringify(rows)).buffer),
        pixelsSha256: await digest(new TextEncoder().encode(JSON.stringify(tiles.map((t: any) => [t.key, t.hashes.pixels]))).buffer),
        // Decoded content only: pixels plus every evidence array, deliberately excluding the PNG's own bytes
        // (hashes.png) so a legitimate codec change (different bytes, identical pixels) does not fail this hash.
        contentSha256: await digest(
          new TextEncoder().encode(
            JSON.stringify(tiles.map((t: any) => [t.key, t.hashes.pixels, ...evidenceFields.map((f) => t.hashes[f] ?? null)])),
          ).buffer,
        ),
        tiles,
        seconds: (performance.now() - started) / 1000,
      };
    }, dumpEvidence);
    const { tiles, ...summary } = report.storedTiles as PassReport['storedTiles'] & { tiles: unknown[] };
    await Deno.writeTextFile(join(output, `${label}-pass-${pass}.tiles.json`), JSON.stringify(tiles));
    report.storedTiles = summary;
  }
  if (exportCanvases) {
    const evidence = await page.evaluate(async () => {
      const kit = (globalThis as any).longScreenKit, store = (globalThis as any).benchmarkStore;
      const rows: Record<string, unknown[]> = {};
      for (const prefix of ['canvas/', 'observation/', 'node/', 'diagnostic/', 'reveal/']) {
        rows[prefix] = [];
        for await (const { key, value } of kit.iterate(store, prefix)) rows[prefix].push(prefix === 'reveal/' ? { key, ...value } : value);
      }
      const regions = (await store.get('regions')) || [];
      return JSON.stringify(
        { regions, rows },
        (_, value) => ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value,
      );
    });
    await Deno.writeTextFile(join(output, `${label}-pass-${pass}.evidence.json`), evidence);
    for (const canvas of report.canvases.filter((c) => c.observedPixels > 0)) {
      const url = await page.evaluate(async (id: string) => {
        const kit = (globalThis as any).longScreenKit, store = (globalThis as any).benchmarkStore;
        const meta = await store.get(`canvas/${id}`);
        const result = await kit.exportCanvas(store, (globalThis as any).benchmarkProject, meta, () => {}, undefined, 'single');
        const blob = result.blob ||
          await (await navigator.storage.getDirectory()).getFileHandle(result.temporary).then((f: FileSystemFileHandle) => f.getFile());
        return URL.createObjectURL(blob);
      }, canvas.id);
      const downloaded = page.waitForEvent('download');
      await page.evaluate((url: string) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'canvas.png';
        a.click();
      }, url);
      await (await downloaded).saveAs(join(output, `${label}-pass-${pass}-${canvas.id}.png`));
      await page.evaluate((url: string) => URL.revokeObjectURL(url), url);
    }
  }
  await page.evaluate(() => {
    delete (globalThis as any).benchmarkStore;
    delete (globalThis as any).benchmarkProject;
  });
  await context.close();
  return report;
}

function stats(values: number[]): { median: number; min: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] || 0, min: sorted[0] || 0, max: sorted[sorted.length - 1] || 0 };
}

function summarize(results: PassReport[]): BenchmarkReport['summary'] {
  const phaseNames = new Set(results.flatMap((result) => Object.keys(result.pipeline.phases)));
  return {
    seconds: stats(results.map((result) => result.pipeline.seconds)),
    phasesMS: Object.fromEntries(
      [...phaseNames].sort().map((name) => [name, stats(results.map((result) => result.pipeline.phases[name] || 0))]),
    ),
    storage: {
      medianPutManyCalls: stats(results.map((result) => result.storage.putManyCalls)).median,
      medianRows: stats(results.map((result) => result.storage.rows)).median,
      medianWriteMS: stats(results.map((result) => result.storage.writeMS)).median,
    },
    png: {
      medianEncodes: stats(results.map((result) => result.png.encodes)).median,
      medianDecodes: stats(results.map((result) => result.png.decodes)).median,
      medianEncodeMS: stats(results.map((result) => result.png.encodeMS)).median,
      medianDecodeMS: stats(results.map((result) => result.png.decodeMS)).median,
    },
  };
}

async function writeReport(options: Options, root: string, label: string, results: PassReport[]): Promise<BenchmarkReport> {
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    root,
    input: options.input,
    browser: options.browser,
    passes: options.passes,
    analysisSize: options.analysisSize,
    results,
    summary: summarize(results),
  };
  await Deno.mkdir(options.output, { recursive: true });
  await Deno.writeTextFile(join(options.output, `${label}.json`), JSON.stringify(report, null, 2));
  return report;
}

async function benchmarkRoot(options: Options, root: string, label: string): Promise<BenchmarkReport> {
  await runBuild(root, options.skipCoreBuild);
  const server = await startServer(root, options.input);
  if (SYSTEM_BROWSERS[options.browser]) {
    try {
      console.log(`\n${label}: ${options.passes} pass(es) in ${SYSTEM_BROWSERS[options.browser]}`);
      const results = await runSystemPasses(options, server, label);
      for (const result of results) {
        await Deno.writeTextFile(join(options.output, `${label}-pass-${result.pass}.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ status: result.status, seconds: Number(result.pipeline.seconds.toFixed(3)), focus: result.focus }));
        const acceptable = result.status === 'complete' || (options.allowPartial && result.status === 'partial');
        if (!acceptable) throw new Error(`${label} pass ${result.pass} ended ${result.status}: ${result.error || 'unknown error'}`);
      }
      return await writeReport(options, root, label, results);
    } finally {
      await server.close();
    }
  }
  const browserOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
  const channel = Deno.env.get('LONGSCREEN_CHANNEL');
  const executablePath = Deno.env.get('LONGSCREEN_CHROME');
  if (options.browser === 'webkit') {
    // Playwright's own WebKit build; the installed Safari is the system browser above.
  } else if (channel) {
    browserOptions.channel = channel;
  } else {
    // Prefer an explicitly supplied system Chrome, then fall back to Playwright's managed browser. This keeps the
    // benchmark runnable without a system Chrome while LONGSCREEN_CHROME still allows testing the platform decoder.
    browserOptions.executablePath = executablePath || chromium.executablePath();
  }
  const browser = await (options.browser === 'webkit' ? webkit : chromium).launch(browserOptions);
  try {
    const results: PassReport[] = [];
    for (let pass = 1; pass <= options.passes; pass++) {
      console.log(`\n${label}: pass ${pass}/${options.passes}`);
      const failurePath = join(options.output, `${label}-pass-${pass}.failure.json`);
      await Deno.remove(failurePath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      let result: PassReport;
      try {
        result = await runPass(
          browser,
          server.base,
          options.input,
          options.analysisSize,
          pass,
          options.output,
          label,
          options.verifyTiles,
          options.exportCanvases,
          !options.noProfile,
          options.dumpEvidence,
        );
      } catch (error) {
        try {
          await Deno.stat(failurePath);
        } catch (missing) {
          if (!(missing instanceof Deno.errors.NotFound)) throw missing;
          await Deno.writeTextFile(failurePath, JSON.stringify({ pass, status: 'error', error: String(error) }, null, 2));
        }
        throw error;
      }
      results.push(result);
      await Deno.writeTextFile(join(options.output, `${label}-pass-${pass}.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({
        status: result.status,
        frames: result.pipeline.frames,
        renderedFrames: result.pipeline.renderedFrames,
        seconds: Number(result.pipeline.seconds.toFixed(3)),
        phasesMS: Object.fromEntries(Object.entries(result.pipeline.phases).map(([name, ms]) => [name, Math.round(ms)])),
        png: result.png,
        storage: result.storage,
        memory: result.memory.stats,
        errors: result.browserErrors.length + result.failedRequests.length,
      }));
      // A stream-copied prefix legitimately ends `partial` (container frame count ≠ decodable frames); only fail on error.
      const acceptable = result.status === 'complete' || (options.allowPartial && result.status === 'partial');
      if (!acceptable) throw new Error(`${label} pass ${pass} ended ${result.status}: ${result.error || 'unknown error'}`);
    }
    return await writeReport(options, root, label, results);
  } finally {
    await browser.close();
    await server.close();
  }
}

const options = parseArgs(Deno.args);
await Deno.mkdir(options.output, { recursive: true });
const benchmarks: Array<[string, string]> = [];
if (options.baselineRoot) benchmarks.push(['baseline', options.baselineRoot]);
benchmarks.push([options.baselineRoot ? 'current' : 'benchmark', options.root]);
let referenceTiles: PassReport['storedTiles'];
const verification: Array<
  { label: string; pass: number; count: number; sha256: string; contentSha256?: string; matches: boolean }
> = [];
for (const [label, root] of benchmarks) {
  const report = await benchmarkRoot(options, root, label);
  if (options.verifyTiles) {
    for (const result of report.results) {
      const tiles = result.storedTiles;
      if (!tiles) throw new Error(`${label} pass ${result.pass} did not produce a tile fingerprint.`);
      referenceTiles ??= tiles;
      // The gate is decoded pixels + evidence arrays (contentSha256), not raw PNG bytes (sha256): a codec change
      // legitimately moves sha256 while reconstruction — the thing this benchmark actually verifies — is
      // unchanged. A byte difference under a matching contentSha256 is reported, never thrown on.
      const matches = tiles.count === referenceTiles.count && tiles.contentSha256 === referenceTiles.contentSha256;
      const byteIdentical = matches && tiles.sha256 === referenceTiles.sha256;
      verification.push({
        label,
        pass: result.pass,
        count: tiles.count,
        sha256: tiles.sha256,
        contentSha256: tiles.contentSha256,
        matches,
      });
      await Deno.writeTextFile(join(options.output, 'verification.json'), JSON.stringify(verification, null, 2));
      if (!matches) {
        throw new Error(`${label} pass ${result.pass}: decoded tile pixels or evidence differ from the first run.`);
      }
      if (!byteIdentical) {
        console.log(
          `(info) ${label} pass ${result.pass}: tile PNG bytes differ from the first run (codec change); decoded pixels and evidence are identical.`,
        );
      }
    }
  }
  console.log(`\n${label} median: ${JSON.stringify(report.summary)}`);
}
