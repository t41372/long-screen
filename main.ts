/** Static file server for the built app: delegates to @std/http's `serveDir` for MIME types, range requests and
 *  directory-index handling (one well-known implementation instead of a hand-rolled one), but keeps its own
 *  realpath containment pre-check in front of it — `serveDir`'s own traversal guard is string-based, so a symlink
 *  that sits inside `root`/a mount but resolves outside it would otherwise be served (see tests/unit/server.test.ts's
 *  symlink test, which this preserves). No caching, no upload endpoint. */
import { serveDir } from '@std/http/file-server';
import { fromFileUrl, join, normalize, resolve, SEPARATOR } from '@std/path';
// Cross-origin isolation grants SharedArrayBuffer, which the threaded core needs (src/core/wasm/loader.ts::planCore).
// Everything the app loads is same-origin, so these cost nothing; without them the single-thread core runs. Mirrored
// exactly in static/_headers for hosted deploys (Cloudflare Pages / Netlify).
const RESPONSE_HEADERS = [
  'cross-origin-opener-policy: same-origin',
  'cross-origin-embedder-policy: require-corp',
  'cross-origin-resource-policy: same-origin',
  'cache-control: no-cache',
  'x-content-type-options: nosniff',
];
export interface ServerOptions {
  /** Directory to serve. */
  root: string;
  /** Additional directories exposed under a URL prefix, e.g. { '/fixtures/': 'tests/fixtures' } for browser tests. */
  mounts?: Record<string, string>;
}
export function createHandler(options: ServerOptions): (request: Request) => Promise<Response> {
  const root = resolve(options.root), mounts = Object.entries(options.mounts || {}).map(([prefix, dir]) => [prefix, resolve(dir)] as const);
  // Resolved once per distinct root/mount directory (not per request): a symlink can sit inside `base` and still
  // point outside it, so containment has to be checked against realpath, not the literal joined string. Cached
  // because realpath also collapses OS-level symlinks in the directory itself (e.g. macOS /var → /private/var),
  // which would otherwise make every legitimate request pay a mismatch unless both sides go through it.
  const realBaseCache = new Map<string, Promise<string>>();
  const realBaseOf = (base: string): Promise<string> => {
    let p = realBaseCache.get(base);
    if (!p) {
      p = Deno.realPath(base).catch(() => base);
      realBaseCache.set(base, p);
    }
    return p;
  };
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    let base = root, relative = pathname === '/' ? '' : pathname.slice(1), urlRoot = '';
    for (const [prefix, dir] of mounts) {
      if (pathname.startsWith(prefix)) {
        base = dir;
        relative = pathname.slice(prefix.length);
        urlRoot = prefix.replace(/^\/|\/$/g, '');
        break;
      }
    }
    // Containment pre-check: resolve symlinks before comparing, so a symlink inside `base` that points outside it
    // is rejected here rather than followed by `serveDir` below (see the module comment). A target that doesn't
    // exist yet (typo'd path, genuinely missing file) isn't a containment problem — let `serveDir` report the 404.
    const target = relative === '' ? base : normalize(join(base, relative));
    if (target !== base && !target.startsWith(base + SEPARATOR)) {
      return new Response('Forbidden', { status: 403 });
    }
    const real = await Deno.realPath(target).catch(() => undefined);
    if (real !== undefined) {
      const realBase = await realBaseOf(base);
      if (real !== realBase && !real.startsWith(realBase + SEPARATOR)) {
        return new Response('Forbidden', { status: 403 });
      }
    }
    const response = await serveDir(request, {
      fsRoot: base,
      urlRoot,
      showDirListing: false,
      showDotfiles: false,
      showIndex: true,
      quiet: true,
      headers: RESPONSE_HEADERS,
    });
    // `serveDir`'s own `headers` option is only applied to a fresh (200/206) response body — a conditional GET it
    // answers with 304 Not Modified carries none of them (and that response's Headers object, like a redirect's,
    // is immutable — it must be rebuilt, not patched in place). A worker script (or any COEP subresource)
    // revalidated by the browser then arrives without cross-origin-resource-policy, which WebKit's `require-corp`
    // document policy treats as an absent CORP header and refuses to load: this is exactly what happens when a page
    // reloads (e.g. WebKit's Private Browsing download flow reloads the page after a blob: download) and re-fetches
    // an already-cached `assets/worker.js` — the reload's Worker constructor throws "blocked by
    // Cross-Origin-Embedder-Policy" although the identical resource loaded fine moments earlier. Reattaching the
    // headers here, unconditionally, covers every status `serveDir` can return (304, 301, 404... included).
    const headers = new Headers(response.headers);
    for (const header of RESPONSE_HEADERS) {
      const i = header.indexOf(':');
      headers.set(header.slice(0, i).trim(), header.slice(i + 1).trim());
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
/** Newest mtime of a file under `dir` whose name ends in one of `extensions`, recursively (default: the TS/HTML/CSS
 *  app layer). Shared by `newestBuildInput` below and by tests/browser/support.ts's `rebuildIfStale` (which imports
 *  it from here), so there is exactly one definition of "what counts as a build input". */
export async function newestSource(dir: string, extensions: readonly string[] = ['.ts', '.html', '.css']): Promise<number> {
  let latest = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      latest = Math.max(latest, await newestSource(path, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      latest = Math.max(latest, (await Deno.stat(path)).mtime?.getTime() ?? 0);
    }
  }
  return latest;
}
/** Newest mtime among everything that should invalidate a built dist/: the TS/HTML/CSS layer (src/, static/) and
 *  the Rust core (rust/core/src/**\/*.rs, both Cargo.toml, rust-toolchain.toml, Cargo.lock, .cargo/config.toml),
 *  plus the build scripts themselves. Without the Rust half, editing a .rs file and running `deno task start` kept
 *  serving the old core.wasm forever — nothing under src/ or static/ ever changes when only the core changes.
 *  Throws if `root` has no source tree at all (e.g. a standalone dist/ deployed without one); callers that want to
 *  tolerate that catch it themselves. */
export async function newestBuildInput(root: string): Promise<number> {
  let latest = Math.max(
    await newestSource(join(root, 'src')),
    await newestSource(join(root, 'static')),
    await newestSource(join(root, 'rust', 'core', 'src'), ['.rs']),
  );
  for (
    const rel of [
      'rust/Cargo.toml',
      'rust/core/Cargo.toml',
      'rust/Cargo.lock',
      'rust/.cargo/config.toml',
      'rust/rust-toolchain.toml',
      'scripts/build.ts',
      'scripts/build-core.sh',
    ]
  ) {
    try {
      latest = Math.max(latest, (await Deno.stat(join(root, rel))).mtime?.getTime() ?? 0);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      // Optional on their own (e.g. a rust/ checkout without rust-toolchain.toml); newestSource above already
      // throws for the tree as a whole when the source checkout is genuinely absent.
    }
  }
  return latest;
}
/** Whether the dist/ built at `distRoot` predates `newestBuildInput(root)` — the one "is dist stale" decision
 *  `deno task start` and tests/browser/support.ts's browser-suite harness both make, against the same file
 *  (dist/index.html, the last file `scripts/build.ts` writes before swapping the build in). */
export async function isDistStale(root: string, distRoot: string): Promise<{ stale: boolean; built: number }> {
  let built = 0;
  try {
    built = (await Deno.stat(join(distRoot, 'index.html'))).mtime?.getTime() ?? 0;
  } catch {
    built = 0;
  }
  let stale = built === 0;
  if (!stale) {
    try {
      stale = built < await newestBuildInput(root);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      // src/, static/ or rust/ absent (e.g. a standalone dist/ deployed without the source tree): trust the
      // existing build rather than fail the server.
    }
  }
  return { stale, built };
}
/** Spawns `scripts/build.ts` under `root` with an explicit cwd, so it behaves the same regardless of the caller's
 *  own working directory. Returns the child process's exit code (0 on success). The command line mirrors deno.json's
 *  `build` task (kept in sync by hand — deno.json is out of scope for this change). */
export async function runBuild(root: string): Promise<number> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-run',
      '--allow-env',
      '--allow-net=jsr.io,api.jsr.io',
      join(root, 'scripts/build.ts'),
    ],
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  return result.code;
}
if (import.meta.main) {
  const repoRoot = fromFileUrl(new URL('.', import.meta.url));
  const port = Number(Deno.env.get('PORT') || 4173);
  const distRoot = resolve(repoRoot, Deno.env.get('LONGSCREEN_DIST') || 'dist');
  const { stale, built } = await isDistStale(repoRoot, distRoot);
  if (stale) {
    console.log(built ? 'dist/ is older than src/, static/ or the Rust core; rebuilding.' : 'dist/ is missing; building first.');
    const code = await runBuild(repoRoot);
    if (code !== 0) {
      Deno.exit(code);
    }
  }
  Deno.serve({
    port,
    hostname: Deno.env.get('HOST') || '0.0.0.0',
    onListen: ({ port }) =>
      console.log(`Long Screen: http://localhost:${port}  (serving ${distRoot}; HTTPS is required for non-localhost devices)`),
  }, createHandler({ root: distRoot }));
}
