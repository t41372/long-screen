/** Builds the Rust core to WebAssembly, bundles the browser adapter with `deno bundle` and copies static assets
 *  into dist/. No CDN, no upload endpoint, no network at runtime; the Rust core does compile in a handful of
 *  crates (image-rs `png` and its deflate backends, `crc32fast`) and the export path uses the npm package
 *  `client-zip` — dist/THIRD_PARTY_NOTICES.txt below is generated from those at build time. Builds into a staging
 *  directory and swaps it in on success, so a failed build never deletes a working dist/.
 *
 *  Every path below is resolved from this script's own location (not the process's current working directory), so
 *  `deno task build` from the repo root and `deno run -A <path>/scripts/build.ts` from anywhere else produce the
 *  same dist/ next to the repo.
 *
 *  Deploying dist/: it is a static site — upload it as-is to any static host that serves a `_headers` file
 *  (Cloudflare Pages, Netlify; static/_headers is copied in verbatim and sets the COOP/COEP/CORP headers the
 *  threaded Wasm core needs, plus caching). `--production` (deno task build:prod) drops the test-only harness and
 *  source maps and minifies; use that build for a real deploy. See README.md's deployment section for hosting
 *  requirements (the 304-response header caveat in particular). */
import { copy, ensureDir } from '@std/fs';
import { fromFileUrl, join } from '@std/path';
import { generateNotices } from './notices.ts';
const root = fromFileUrl(new URL('..', import.meta.url));
// Test-only artefacts that ship under a default dist/: testkit.js exposes internals for tests/browser's Playwright
// suite to drive directly, and static/harness.html is the page that loads it. Neither is linked from index.html,
// so a production visitor never fetches them anyway, but the default build keeps them because tests/browser reads
// them out of dist/ (not out of a separate test build) — see tests/browser/support.ts. `--production` (below) is
// the build that actually ships: it drops both, along with every source map.
const production = Deno.args.includes('--production');
const entries: [string, string][] = [
  ['src/ui/main.ts', 'assets/main.js'],
  ['src/worker.ts', 'assets/worker.js'],
  ...(production ? [] : [['src/testkit.ts', 'assets/testkit.js'] as [string, string]]),
  ['src/core/helper.ts', 'assets/core-helper.js'],
  ['src/media/convert-worker.ts', 'assets/convert-worker.js'],
  ['src/device-check.ts', 'assets/device-check.js'],
];
const minify = production || Deno.args.includes('--minify');
const skipCore = Deno.args.includes('--skip-core');
const CORE_WASM: [string, string][] = [
  ['rust/target/scalar/wasm32-unknown-unknown/release/long_screen_core.wasm', 'assets/core.wasm'],
  ['rust/target/simd/wasm32-unknown-unknown/release/long_screen_core.wasm', 'assets/core.simd.wasm'],
  ['rust/target/threads/wasm32-unknown-unknown/release/long_screen_core.wasm', 'assets/core.threads.wasm'],
];
const staging = join(root, 'dist.build');
await Deno.remove(staging, { recursive: true }).catch(() => {});
await ensureDir(join(staging, 'assets'));
try {
  if (!skipCore) {
    const core = await new Deno.Command('bash', {
      args: [join(root, 'scripts/build-core.sh')],
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
      .output();
    if (!core.success) {
      console.error('Building the Rust core failed. Install rustup (see README.md); rust/rust-toolchain.toml pins the toolchain.');
      await Deno.remove(staging, { recursive: true }).catch(() => {});
      Deno.exit(core.code);
    }
  }
  for (const [source, output] of CORE_WASM) {
    const from = join(root, source);
    try {
      await Deno.copyFile(from, join(staging, output));
    } catch (error) {
      if (skipCore && error instanceof Deno.errors.NotFound) {
        console.error(
          `--skip-core was given but ${source} does not exist. Build the Rust core first: deno task build:core (or drop --skip-core).`,
        );
        await Deno.remove(staging, { recursive: true }).catch(() => {});
        Deno.exit(1);
      }
      throw error;
    }
    console.log(`rust/core → dist/${output} (${((await Deno.stat(from)).size / 1024).toFixed(1)} KB)`);
  }
  for (const [input, output] of entries) {
    const target = join(staging, output);
    const args = [
      'bundle',
      '--platform',
      'browser',
      ...(production ? [] : ['--sourcemap=linked']),
      '--quiet',
      ...(minify ? ['--minify'] : []),
      '-o',
      target,
      join(root, input),
    ];
    const result = await new Deno.Command(Deno.execPath(), { args, cwd: root, stdout: 'inherit', stderr: 'piped' }).output();
    const stderr = new TextDecoder().decode(result.stderr).split('\n').filter((l) => l && !l.includes('experimental')).join('\n');
    if (stderr) {
      console.error(stderr);
    }
    if (!result.success) {
      console.error(`Bundling ${input} failed.`);
      await Deno.remove(staging, { recursive: true }).catch(() => {});
      Deno.exit(result.code);
    }
    const bytes = (await Deno.stat(target)).size;
    console.log(`${input} → dist/${output} (${(bytes / 1024).toFixed(1)} KB)`);
  }
  // Every `new URL('./<name>.js'|'./<name>.wasm', ...)` under src/ is a runtime contract with `entries` and
  // CORE_WASM above: a typo in either place fails silently in the browser (a 404 for a bundle nobody bundled).
  // Cheap enough to grep for on every build instead of trusting the two lists never to drift apart. Scans balanced
  // parens rather than a single regex so a ternary first argument (src/core/wasm/loader.ts's
  // `simdSupported() ? './core.simd.wasm' : './core.wasm'`) is still found, not just a bare string literal.
  const emitted = new Set([...entries, ...CORE_WASM].map(([, output]) => output.slice('assets/'.length)));
  const missing: string[] = [];
  let checked = 0;
  for await (const entry of walkTs(join(root, 'src'))) {
    const text = await Deno.readTextFile(entry);
    for (const name of urlLiteralRefs(text)) {
      checked++;
      if (!emitted.has(name)) missing.push(`${entry}: ./${name}`);
    }
  }
  // static/*.html loads its bundles by <script src>/<link href>, not `new URL(...)` — the same drift risk (a typo'd
  // filename 404s silently in the browser), so it gets the same check against the emitted asset list.
  for await (const entry of Deno.readDir(join(root, 'static'))) {
    if (!entry.isFile || !entry.name.endsWith('.html')) continue;
    // harness.html only exists to load testkit.js (see the comment above `production`); a production build omits
    // both, so it is not a real dangling reference — checking it here would fail every production build.
    if (production && entry.name === 'harness.html') continue;
    const path = join(root, 'static', entry.name);
    const text = await Deno.readTextFile(path);
    for (const m of text.matchAll(/(?:src|href)="\.\/assets\/([\w.-]+)"/g)) {
      checked++;
      if (!emitted.has(m[1])) missing.push(`${path}: ./assets/${m[1]}`);
    }
  }
  if (missing.length) {
    console.error(
      `Bundle name(s) referenced by src/**/*.ts or static/*.html do not match any emitted asset:\n${
        missing.map((m) => `  ${m}`).join('\n')
      }`,
    );
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    Deno.exit(1);
  }
  console.log(
    `Checked ${checked} new URL('./<name>.js'|'.wasm', ...) / static/*.html asset reference(s) against the ${emitted.size} emitted asset(s).`,
  );
  await copy(join(root, 'static'), staging, { overwrite: true });
  if (production) {
    await Deno.remove(join(staging, 'harness.html')).catch(() => {});
  }
  const notices = await generateNotices(root, entries.map(([input]) => input));
  await Deno.writeTextFile(join(staging, 'THIRD_PARTY_NOTICES.txt'), notices);
  console.log(`THIRD_PARTY_NOTICES.txt → dist/THIRD_PARTY_NOTICES.txt (${(notices.length / 1024).toFixed(1)} KB)`);
  // Swap the finished build in. Everything above ran against `staging`; dist/ keeps serving the previous build
  // until this point, so a bundling failure above never leaves dist/ deleted or half-written.
  const dist = join(root, 'dist');
  await Deno.remove(dist, { recursive: true }).catch(() => {});
  await Deno.rename(staging, dist);
  console.log('Built dist/ — no CDN, no upload endpoint, no network at runtime (see THIRD_PARTY_NOTICES.txt).');
} catch (error) {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  throw error;
}
/** Every `./<name>.js`/`./<name>.wasm` string literal inside each `new URL(...)` call in `text`, wherever it sits
 *  in the argument list (a bare second argument, or one arm of a ternary first argument). Scans balanced parens
 *  from each `new URL(` rather than a single regex, since the ternary case has its own nested parens. */
function urlLiteralRefs(text: string): string[] {
  const refs: string[] = [], marker = 'new URL(';
  let i = 0;
  while ((i = text.indexOf(marker, i)) !== -1) {
    let depth = 1, j = i + marker.length;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
    for (const m of text.slice(i + marker.length, j - 1).matchAll(/'\.\/([\w.-]+\.(?:js|wasm))'/g)) {
      refs.push(m[1]);
    }
    i = j;
  }
  return refs;
}
async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      yield* walkTs(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}
