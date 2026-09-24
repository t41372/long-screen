/** Guards against final-review item 6's bug class: on the threads build, `exports.memory.buffer` is a
 *  `SharedArrayBuffer`, and `ArrayBuffer.prototype.slice`/`SharedArrayBuffer.prototype.slice` return the SAME
 *  buffer type as their receiver — a "copy" of a `SharedArrayBuffer` is still shared, unlike `core.readBytes()`
 *  (a `TypedArray.slice()`, which always allocates a plain `ArrayBuffer`). `wasm/regions.ts` shipped two call
 *  sites doing exactly the wrong thing (`exports.memory.buffer.slice(...)`), producing a shared view that lived
 *  for the whole run (`RegionAtlas.counts`, src/core/layers.ts) with nothing to catch it under Deno, where a
 *  shared view behaves like any other TypedArray. Two static checks below keep the bug class from coming back,
 *  plus a runtime check on `MemoryKV.put` (the same shared-memory blind spot `structuredClone` has). */
import { assert, assertRejects } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { MemoryKV } from '../../src/storage/db.ts';

const srcRoot = fromFileUrl(new URL('../../src/', import.meta.url));

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

/** True for a line that is only a comment (a doc-comment body line, a `//` line, or a `/** ` opener) — skipped
 *  so this test's own explanation of the anti-pattern (which necessarily quotes it) does not trip itself. */
function isCommentOnlyLine(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*\*)/.test(line);
}

Deno.test('shared-memory guard: no src file re-introduces exports.memory.buffer.slice(', async () => {
  const offenders: string[] = [];
  for await (const path of walk(srcRoot.replace(/\/$/, ''))) {
    const text = await Deno.readTextFile(path);
    for (const line of text.split('\n')) {
      if (!isCommentOnlyLine(line) && line.includes('memory.buffer.slice(')) offenders.push(`${path}: ${line.trim()}`);
    }
  }
  assert(
    offenders.length === 0,
    `memory.buffer.slice( returns a SharedArrayBuffer on the threads build, not a copy — use core.readBytes() instead. Found in:\n${
      offenders.join('\n')
    }`,
  );
});

Deno.test('shared-memory guard: TextDecoder/Blob/digest are never applied directly to a raw core memory view', async () => {
  // A precise, not exhaustive, check: every current safe call site (temporal.ts's decodeId, mp4.ts/webm.ts's
  // TextDecoder, device-check.ts's digest, tiles.ts/scan.ts's Blob…) first copies core bytes into a plain local
  // — `mem.slice(...)`, `core.readBytes(...)`, a plain function parameter — on its own statement, so none of
  // them mention `.memory.buffer` on the same line as the risky API. A regression that inlines
  // `new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ...))` (or the Blob/digest equivalent)
  // would put both on one line and trip this.
  const risky = /TextDecoder|new Blob\(|\.digest\(/;
  const offenders: string[] = [];
  for await (const path of walk(srcRoot.replace(/\/$/, ''))) {
    const text = await Deno.readTextFile(path);
    for (const line of text.split('\n')) {
      if (!isCommentOnlyLine(line) && line.includes('.memory.buffer') && risky.test(line)) offenders.push(`${path}: ${line.trim()}`);
    }
  }
  assert(
    offenders.length === 0,
    `TextDecoder/Blob/digest applied directly to a live core memory view (copy it first, e.g. core.readBytes()):\n${offenders.join('\n')}`,
  );
});

Deno.test('shared-memory guard: MemoryKV.put rejects a value backed by a SharedArrayBuffer, as IndexedDB would', async () => {
  const db = new MemoryKV();
  const sharedView = new Uint8Array(new SharedArrayBuffer(4));
  await assertRejects(() => db.put('k', sharedView));
  await assertRejects(() => db.put('k', { blocks: sharedView }));
  await assertRejects(() => db.put('k', [1, sharedView]));
  // A plain (non-shared) typed array, and structures around it, are unaffected.
  await db.put('k2', new Uint8Array(4));
  await db.put('k3', { blocks: new Uint8Array(4), n: 1 });
});
