import { assert, assertEquals } from '@std/assert';
import { createHandler, newestSource } from '../../main.ts';
const root = await Deno.makeTempDir();
await Deno.writeTextFile(`${root}/index.html`, '<!doctype html><title>t</title>');
await Deno.writeFile(`${root}/data.bin`, Uint8Array.from({ length: 1000 }, (_, i) => i & 255));
await Deno.mkdir(`${root}/assets`);
await Deno.writeTextFile(`${root}/assets/main.js`, 'export {}');
await Deno.writeFile(`${root}/empty.txt`, new Uint8Array());
const mount = await Deno.makeTempDir();
await Deno.writeTextFile(`${mount}/f.json`, '{}');
const handler = createHandler({ root, mounts: { '/fixtures/': mount } });
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  handler(new Request(`http://localhost${path}`, { headers, method }));
Deno.test('server: index, mime types, no-cache and nosniff headers', async () => {
  const index = await get('/');
  assertEquals(index.status, 200);
  assertEquals(index.headers.get('content-type'), 'text/html; charset=utf-8');
  assertEquals(index.headers.get('cache-control'), 'no-cache');
  assertEquals(index.headers.get('x-content-type-options'), 'nosniff');
  assert((await index.text()).includes('<title>'));
  const js = await get('/assets/main.js');
  assertEquals(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  await js.body?.cancel();
  const bin = await get('/data.bin');
  assertEquals(bin.headers.get('content-type'), 'application/octet-stream');
  assertEquals(bin.headers.get('content-length'), '1000');
  await bin.body?.cancel();
  const empty = await get('/empty.txt');
  assertEquals(empty.status, 200);
  assertEquals(empty.headers.get('content-length'), '0');
});
Deno.test('server: byte ranges for large video files, including suffix and open-ended ranges', async () => {
  const part = await get('/data.bin', { range: 'bytes=10-19' });
  assertEquals(part.status, 206);
  assertEquals(part.headers.get('content-range'), 'bytes 10-19/1000');
  assertEquals([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const open = await get('/data.bin', { range: 'bytes=990-' });
  assertEquals(open.status, 206);
  assertEquals((await open.arrayBuffer()).byteLength, 10);
  const suffix = await get('/data.bin', { range: 'bytes=-5' });
  assertEquals(suffix.headers.get('content-range'), 'bytes 995-999/1000');
  assertEquals((await suffix.arrayBuffer()).byteLength, 5);
  const clipped = await get('/data.bin', { range: 'bytes=0-5000' });
  assertEquals(clipped.headers.get('content-range'), 'bytes 0-999/1000');
  await clipped.body?.cancel();
  const bad = await get('/data.bin', { range: 'bytes=2000-3000' });
  assertEquals(bad.status, 416);
  const head = await get('/data.bin', { range: 'bytes=0-1' }, 'HEAD');
  assertEquals(head.status, 206);
  assertEquals(head.body, null);
});
Deno.test('server: traversal, missing files, directories, methods, bad encoding and mounts', async () => {
  assertEquals((await get('/../deno.json')).status, 404);
  assertEquals((await get('/%2e%2e/%2e%2e/etc/passwd')).status, 404);
  assertEquals((await handler(new Request('http://localhost/x', { headers: { range: 'bytes=0-1' } }))).status, 404);
  assertEquals((await get('/missing.txt')).status, 404);
  assertEquals((await get('/assets')).status, 404);
  assertEquals((await get('/assets/')).status, 404);
  assertEquals((await get('/', {}, 'POST')).status, 405);
  assertEquals((await get('/%zz')).status, 400);
  const mounted = await get('/fixtures/f.json');
  assertEquals(mounted.status, 200);
  assertEquals(mounted.headers.get('content-type'), 'application/json');
  await mounted.body?.cancel();
  assertEquals((await get('/fixtures/../index.html')).status, 200);
});
Deno.test('server: a symlink inside the root that resolves outside it is rejected, not served', async () => {
  const outside = await Deno.makeTempDir();
  await Deno.writeTextFile(`${outside}/secret.txt`, 'not servable');
  const escapeRoot = await Deno.makeTempDir();
  await Deno.writeTextFile(`${escapeRoot}/index.html`, '<!doctype html><title>t</title>');
  try {
    await Deno.symlink(`${outside}/secret.txt`, `${escapeRoot}/escape.txt`);
  } catch (error) {
    if (error instanceof Deno.errors.NotSupported || error instanceof Deno.errors.PermissionDenied) {
      return; // symlink creation unavailable in this environment; nothing to assert
    }
    throw error;
  }
  const escapeHandler = createHandler({ root: escapeRoot });
  const res = await escapeHandler(new Request('http://localhost/escape.txt'));
  assertEquals(res.status, 403);
  await res.body?.cancel();
});
Deno.test('server: a small range on a large multi-chunk file still streams exactly the requested bytes (transform tail)', async () => {
  const big = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => i & 255);
  await Deno.writeFile(`${root}/big.bin`, big);
  const res = await get('/big.bin', { range: 'bytes=0-9' });
  assertEquals(res.status, 206);
  assertEquals(res.headers.get('content-range'), `bytes 0-9/${big.length}`);
  const body = new Uint8Array(await res.arrayBuffer());
  assertEquals([...body], [...big.subarray(0, 10)]);
});
Deno.test('server: newestSource finds the newest .ts/.html/.css mtime recursively, ignoring other extensions', async () => {
  const dir = await Deno.makeTempDir();
  const t1 = new Date('2020-01-01T00:00:00Z'),
    t2 = new Date('2022-06-15T00:00:00Z'),
    t3 = new Date('2023-09-01T00:00:00Z'),
    t4 = new Date('2030-01-01T00:00:00Z');
  await Deno.writeTextFile(`${dir}/a.ts`, 'export {}');
  await Deno.utime(`${dir}/a.ts`, t1, t1);
  await Deno.writeTextFile(`${dir}/style.css`, 'body{}');
  await Deno.utime(`${dir}/style.css`, t2, t2);
  // A far-future mtime on a non-source extension must never win.
  await Deno.writeTextFile(`${dir}/ignored.png`, 'not source');
  await Deno.utime(`${dir}/ignored.png`, t4, t4);
  await Deno.mkdir(`${dir}/nested`);
  await Deno.writeTextFile(`${dir}/nested/index.html`, '<html></html>');
  await Deno.utime(`${dir}/nested/index.html`, t3, t3);
  assertEquals(
    await newestSource(dir),
    t3.getTime(),
    'the newest source file, including one found recursively, must win; non-source extensions must be ignored',
  );
});
Deno.test('server: newestSource on a directory with no source files is zero', async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/empty-nested`);
  await Deno.writeTextFile(`${dir}/data.json`, '{}');
  assertEquals(await newestSource(dir), 0);
});
