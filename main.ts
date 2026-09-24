/** Static file server for the built app. Range requests, correct MIME types, no caching, no upload endpoint. */
import { extname, fromFileUrl, join, normalize, resolve, SEPARATOR } from '@std/path';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};
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
    let base = root, relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    for (const [prefix, dir] of mounts) {
      if (pathname.startsWith(prefix)) {
        base = dir;
        relative = pathname.slice(prefix.length);
        break;
      }
    }
    const filename = normalize(join(base, relative));
    if (filename !== base && !filename.startsWith(base + SEPARATOR)) {
      return new Response('Forbidden', { status: 403 });
    }
    let real: string;
    try {
      real = await Deno.realPath(filename);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const realBase = await realBaseOf(base);
    if (real !== realBase && !real.startsWith(realBase + SEPARATOR)) {
      return new Response('Forbidden', { status: 403 });
    }
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(real);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!info.isFile) {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers({
      'content-type': MIME[extname(filename)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      // Cross-origin isolation grants SharedArrayBuffer, which the threaded core needs (src/core/wasm/loader.ts::planCore).
      // Everything the app loads is same-origin, so these cost nothing; without them the single-thread core runs.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    });
    const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0, end = info.size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
      }
      if (range[2]) {
        end = Math.min(info.size - 1, Number(range[2]));
      }
      if (!range[1] && range[2]) {
        start = Math.max(0, info.size - Number(range[2]));
        end = info.size - 1;
      }
      if (start > end || start >= info.size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
      }
      headers.set('content-range', `bytes ${start}-${end}/${info.size}`);
    }
    const length = info.size ? end - start + 1 : 0;
    headers.set('content-length', String(length));
    const status = range && (range[1] || range[2]) ? 206 : 200;
    if (request.method === 'HEAD' || length === 0) {
      return new Response(null, { status, headers });
    }
    const file = await Deno.open(real, { read: true });
    if (start) {
      await file.seek(start, Deno.SeekMode.Start);
    }
    let remaining = length;
    const body = file.readable.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (remaining <= 0) {
            return;
          }
          const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          remaining -= part.length;
          controller.enqueue(part);
          if (remaining <= 0) {
            controller.terminate();
          }
        },
      }),
    );
    return new Response(body, { status, headers });
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
    args: ['run', '--allow-read', '--allow-write', '--allow-run', '--allow-env', join(root, 'scripts/build.ts')],
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
