/** Static file server for the built app. Range requests, correct MIME types, no caching, no upload endpoint. */
import { extname, join, normalize, resolve, SEPARATOR } from '@std/path';
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
/** Newest mtime under a directory; mirrors the check tests/browser/support.ts runs before the browser suite, so
 *  `deno task start` cannot quietly keep serving a bundle that predates the last source edit. */
export async function newestSource(dir: string): Promise<number> {
  let latest = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      latest = Math.max(latest, await newestSource(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.html') || entry.name.endsWith('.css')) {
      latest = Math.max(latest, (await Deno.stat(path)).mtime?.getTime() ?? 0);
    }
  }
  return latest;
}
if (import.meta.main) {
  const port = Number(Deno.env.get('PORT') || 4173), root = Deno.env.get('LONGSCREEN_DIST') || 'dist';
  let built = 0;
  try {
    built = (await Deno.stat(join(root, 'index.html'))).mtime?.getTime() ?? 0;
  } catch {
    built = 0;
  }
  let stale = built === 0;
  if (!stale) {
    try {
      stale = built < Math.max(await newestSource('src'), await newestSource('static'));
    } catch {
      // src/ or static/ absent (e.g. a standalone dist/ deployed without the source tree): trust the existing build.
    }
  }
  if (stale) {
    console.log(built ? 'dist/ is older than src/ or static/; rebuilding.' : 'dist/ is missing; building first.');
    const build = await new Deno.Command(Deno.execPath(), {
      args: ['run', '--allow-read', '--allow-write', '--allow-run', '--allow-env', 'scripts/build.ts'],
      stdout: 'inherit',
      stderr: 'inherit',
    }).output();
    if (!build.success) {
      Deno.exit(build.code);
    }
  }
  Deno.serve({
    port,
    hostname: Deno.env.get('HOST') || '0.0.0.0',
    onListen: ({ port }) =>
      console.log(`Long Screen: http://localhost:${port}  (serving ${root}; HTTPS is required for non-localhost devices)`),
  }, createHandler({ root }));
}
