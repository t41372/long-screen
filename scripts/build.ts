/** Builds the Rust core to WebAssembly, bundles the browser adapter with `deno bundle` and copies static assets
 *  into dist/. No CDN and no upload endpoint; at runtime the page sends only usage counts, and only on the hosted
 *  site (src/ui/analytics.ts). The Rust core does compile in a handful of
 *  crates (image-rs `png` and its deflate backends, `crc32fast`) and the export path uses the npm package
 *  `client-zip`, and the hosted site's counter bundles `posthog-js` — dist/THIRD_PARTY_NOTICES.txt below is generated from those at build time. Builds into a staging
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
 *  requirements (the 304-response header caveat in particular).
 *
 *  `--out <dir>` (relative to the repo root, default `dist`) builds somewhere else instead: tests/browser builds and
 *  serves dist-test/, and `deno task build:portable` builds its production input into dist-portable/.site, so
 *  neither replaces the dist/ that `deno task start` serves and `deno task build:prod` leaves for a deploy. */
import { copy, ensureDir, walk } from '@std/fs';
import { encodeHex } from '@std/encoding/hex';
import { fromFileUrl, isAbsolute, join, normalize, relative } from '@std/path';
import { generateNotices } from './notices.ts';
const root = fromFileUrl(new URL('..', import.meta.url));
// Test-only artefacts that ship under a default dist/: testkit.js exposes internals for tests/browser's Playwright
// suite to drive directly, and static/harness.html is the page that loads it. Neither is linked from index.html,
// so a production visitor never fetches them anyway, but the default build keeps them because tests/browser drives
// them (it builds its own copy into dist-test/, see tests/browser/support.ts). `--production` (below) is the build
// that actually ships: it drops both, along with every source map.
const production = Deno.args.includes('--production');
const entries: [string, string][] = [
  ['src/ui/main.ts', 'assets/main.js'],
  ['src/worker.ts', 'assets/worker.js'],
  ...(production ? [] : [['src/testkit.ts', 'assets/testkit.js'] as [string, string]]),
  ['src/core/helper.ts', 'assets/core-helper.js'],
  ['src/media/convert-worker.ts', 'assets/convert-worker.js'],
  ['src/device-check.ts', 'assets/device-check.js'],
  // The hosted site's usage counter; src/ui/analytics.ts adds it to the page only there.
  ['src/analytics.ts', 'assets/analytics.js'],
  // At the root, not under assets/: a service worker's scope is the directory it is served from.
  ['src/sw.ts', 'sw.js'],
];
const minify = production || Deno.args.includes('--minify');
const skipCore = Deno.args.includes('--skip-core');
const outFlag = Deno.args.indexOf('--out');
const outName = normalize(outFlag < 0 ? 'dist' : Deno.args[outFlag + 1] ?? '.').replace(/[\\/]+$/, '');
// The output directory is deleted and replaced wholesale, so it has to be inside the repo, and it may only be
// replaced if it is missing, empty, or an earlier build (index.html next to assets/). That is decided from what is
// on disk rather than from the name: a file (`--out main.ts`), a source directory under any spelling a
// case-insensitive file system accepts (`--out Src`), or dist-portable/ with a user's own files in it all refuse.
if (outName === '.' || outName.startsWith('-') || outName.startsWith('..') || isAbsolute(outName)) {
  console.error(`--out needs a directory inside the repo, relative to its root (e.g. dist-portable/.site); got "${outName}".`);
  Deno.exit(1);
}
if (!await replaceable(join(root, outName))) {
  console.error(`--out ${outName} exists and is not an earlier build (no index.html next to assets/); refusing to replace it.`);
  Deno.exit(1);
}
const CORE_WASM: [string, string][] = [
  ['rust/target/scalar/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'assets/core.wasm'],
  ['rust/target/simd/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'assets/core.simd.wasm'],
  ['rust/target/threads/wasm32-unknown-unknown/release/long_screen_wasm.wasm', 'assets/core.threads.wasm'],
];
const outDir = join(root, outName), staging = `${outDir}.build`;
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
    console.log(`rust/wasm → ${outName}/${output} (${((await Deno.stat(from)).size / 1024).toFixed(1)} KB)`);
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
    console.log(`${input} → ${outName}/${output} (${(bytes / 1024).toFixed(1)} KB)`);
  }
  // Every `new URL('./<name>.js'|'./<name>.wasm', ...)` under src/ is a runtime contract with `entries` and
  // CORE_WASM above: a typo in either place fails silently in the browser (a 404 for a bundle nobody bundled).
  // Cheap enough to grep for on every build instead of trusting the two lists never to drift apart. Scans balanced
  // parens rather than a single regex so a ternary first argument (src/core/wasm/loader.ts's
  // `simdSupported() ? './core.simd.wasm' : './core.wasm'`) is still found, not just a bare string literal.
  const emitted = new Set(
    [...entries, ...CORE_WASM].filter(([, output]) => output.startsWith('assets/')).map(([, output]) => output.slice('assets/'.length)),
  );
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
  const commit = await buildCommit(), version = await coreVersion();
  await Deno.writeTextFile(join(staging, 'index.html'), stampBuild(await Deno.readTextFile(join(staging, 'index.html')), version, commit));
  console.log(
    `On the plate: core v${version}, commit ${commit?.label ?? 'unknown (no CF_PAGES_COMMIT_SHA, no git checkout), left hidden'}`,
  );
  const notices = await generateNotices(root, entries.map(([input]) => input));
  await Deno.writeTextFile(join(staging, 'THIRD_PARTY_NOTICES.txt'), notices);
  console.log(`THIRD_PARTY_NOTICES.txt → ${outName}/THIRD_PARTY_NOTICES.txt (${(notices.length / 1024).toFixed(1)} KB)`);
  const precache = await precacheList(staging);
  await Deno.writeTextFile(join(staging, 'sw.js'), injectPrecache(await Deno.readTextFile(join(staging, 'sw.js')), precache));
  console.log(`sw.js precaches ${precache.files.length} file(s) for offline use as build ${precache.version}.`);
  // Swap the finished build in. Everything above ran against `staging`; the output directory keeps serving the
  // previous build until this point, so a bundling failure above never leaves it deleted or half-written.
  await Deno.remove(outDir, { recursive: true }).catch(() => {});
  await Deno.rename(staging, outDir);
  console.log(`Built ${outName}/ — no CDN, no upload endpoint (see THIRD_PARTY_NOTICES.txt).`);
} catch (error) {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  throw error;
}
/** Whether `dir` may be deleted and replaced by a build: it does not exist, is an empty directory, or is an earlier
 *  build, which always holds index.html next to assets/. */
async function replaceable(dir: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  if (!info.isDirectory) return false;
  const names = new Set<string>();
  for await (const entry of Deno.readDir(dir)) names.add(entry.name);
  return names.size === 0 || (names.has('index.html') && names.has('assets'));
}
/** The commit this build is made from, for the printer's plate: Cloudflare Pages' `CF_PAGES_COMMIT_SHA` when
 *  building there, otherwise git's HEAD, labelled `-dirty` when the working tree differs from it (modified, staged or
 *  untracked files, the same test scripts/build-portable.ts names its zip by), so a local build of uncommitted changes
 *  never passes for that commit. Never fails the build: without either source the plate shows no model number. */
async function buildCommit(): Promise<{ label: string; full: string } | undefined> {
  const pages = Deno.env.get('CF_PAGES_COMMIT_SHA')?.trim();
  if (pages && /^[0-9a-f]{7,40}$/i.test(pages)) return { label: pages.slice(0, 7), full: pages };
  const git = async (...args: string[]): Promise<string | undefined> => {
    try {
      const result = await new Deno.Command('git', { args, cwd: root, stdout: 'piped', stderr: 'null' }).output();
      return result.success ? new TextDecoder().decode(result.stdout).trim() : undefined;
    } catch {
      return undefined; // no git on PATH, or no permission to run it
    }
  };
  const full = await git('rev-parse', 'HEAD'), short = await git('rev-parse', '--short', 'HEAD');
  if (!full || !short) return undefined;
  const status = await git('status', '--porcelain');
  return { label: status ? `${short}-dirty` : short, full };
}
/** The core library's version, the `long-screen` crate's (rust/long-screen/Cargo.toml): the readable half of the
 *  plate's model number. Between releases it carries a `-dev` suffix (docs/RELEASING.md). */
async function coreVersion(): Promise<string> {
  const manifest = await Deno.readTextFile(join(root, 'rust', 'long-screen', 'Cargo.toml'));
  const version = manifest.match(/^\[package\][^[]*?^version = "([^"]+)"$/m)?.[1];
  if (!version) throw new Error('rust/long-screen/Cargo.toml: no [package] version for the plate.');
  return version;
}
/** Stamps the core `version` on static/index.html's printer plate and, when known, the `commit`, linked to that
 *  commit on GitHub; without a commit the link stays hidden and only the version shows. */
function stampBuild(page: string, version: string, commit: { label: string; full: string } | undefined): string {
  const line = '<span class="build-id" id="build-id" hidden>',
    label = '<span id="build-version" title="核心算法库版本" data-i18n-attr="title:page.press.core"></span>',
    attrs = 'target="_blank" rel="noopener" title="这一版网页的提交" data-i18n-attr="title:page.press.build"',
    link = `<a id="build-commit" href="https://github.com/t41372/long-screen" ${attrs} hidden></a>`;
  if ([line, label, link].some((part) => page.split(part).length !== 2)) {
    throw new Error(
      "static/index.html: the plate's build stamp (#build-id with an empty #build-version and #build-commit) is missing or duplicated.",
    );
  }
  const stamped = page.replace(line, '<span class="build-id" id="build-id">').replace(
    label,
    label.replace('></span>', `>v${version}</span>`),
  );
  if (!commit) return stamped;
  return stamped.replace(
    link,
    `<a id="build-commit" href="https://github.com/t41372/long-screen/commit/${commit.full}" ${attrs}>${commit.label}</a>`,
  );
}
/** Files the installed app needs offline (src/sw.ts), as paths relative to the build root (the worker's scope), plus a hash of their
 *  contents that names the build's cache. Everything in the build except what a run never loads: the service worker
 *  itself, the host's `_headers`, source maps, the test harness, the device check page, a diagnostic tool that is
 *  opened on purpose, and hidden files such as the `.DS_Store` macOS leaves in static/: main.ts answers them 404,
 *  and one failed fetch fails the worker's whole install. index.html is listed as '', the URL Cloudflare Pages
 *  serves it at. */
async function precacheList(dir: string): Promise<{ version: string; files: string[] }> {
  const skip = new Set(['sw.js', '_headers', 'harness.html', 'assets/testkit.js', 'device-check.html', 'assets/device-check.js']);
  const files: [string, string][] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    const path = relative(dir, entry.path).replaceAll('\\', '/');
    if (skip.has(path) || path.endsWith('.map') || path.split('/').some((part) => part.startsWith('.'))) continue;
    files.push([path === 'index.html' ? '' : path, encodeHex(await crypto.subtle.digest('SHA-256', await Deno.readFile(entry.path)))]);
  }
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const listing = new TextEncoder().encode(files.map(([path, hash]) => `${hash}  ${path}\n`).join(''));
  return { version: encodeHex(await crypto.subtle.digest('SHA-256', listing)).slice(0, 16), files: files.map(([path]) => path) };
}
/** Writes `precache` into the bundled service worker in place of its `'__LONG_SCREEN_PRECACHE__'` placeholder (as a
 *  string literal of the JSON, which `JSON.parse` in src/sw.ts reads back), whichever quotes the bundler gave it. */
function injectPrecache(sw: string, precache: { version: string; files: string[] }): string {
  const placeholder = /(["'])__LONG_SCREEN_PRECACHE__\1/g;
  if ((sw.match(placeholder) ?? []).length !== 1) {
    throw new Error('sw.js: the __LONG_SCREEN_PRECACHE__ placeholder is missing or duplicated.');
  }
  return sw.replace(placeholder, () => JSON.stringify(JSON.stringify(precache)));
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
