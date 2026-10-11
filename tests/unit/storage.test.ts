import '../support/core.ts';
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { deletePrefix, iterate, type KV, MemoryKV, Namespace } from '../../src/storage/db.ts';
import {
  countCovered,
  covered,
  markCovered,
  pngTileCodec,
  QUALITY_BLOCK,
  type StoredTile,
  type TileCodec,
  type TileIndex,
  tileKey,
  TileStore,
} from '../../src/storage/tiles.ts';
import { Diagnostics } from '../../src/storage/diagnostics.ts';
import { encodeRGBA } from '../../src/codec/png.ts';
import { core } from '../../src/core/wasm.ts';
import type { CanvasMeta, Diagnostic } from '../../src/types.ts';
Deno.test('MemoryKV: sorted scans with prefix, after, limit and reverse; namespaces isolate prefixes; deletePrefix is scoped', async () => {
  const base = new MemoryKV(), a = new Namespace(base, 'a/'), b = new Namespace(base, 'b/');
  for (let i = 0; i < 75; i++) {
    await a.put('item/' + String(i).padStart(3, '0'), i);
  }
  await b.put('item/1', 'keep');
  await a.putMany([{ key: 'item/x', value: 'x' }]);
  await a.put('item/x', 'x2');
  assertEquals(await a.get('item/x'), 'x2');
  assertEquals(await a.get('missing'), undefined);
  const rows = [];
  for await (const row of iterate(a, 'item/', false, 7)) {
    rows.push(row);
  }
  assertEquals(rows.length, 76);
  assertEquals(rows[74].value, 74);
  const reverse = await a.scan('item/', { reverse: true, limit: 3 });
  assertEquals(reverse.map((r) => r.key), ['item/x', 'item/074', 'item/073']);
  const reverseAfter = await a.scan('item/', { reverse: true, limit: 2, after: 'item/010' });
  assertEquals(reverseAfter.map((r) => r.key), ['item/009', 'item/008']);
  const forwardAfter = await a.scan('item/', { after: 'item/072', limit: 10 });
  assertEquals(forwardAfter.map((r) => r.key), ['item/073', 'item/074', 'item/x']);
  assertEquals((await a.scan('nothing/')).length, 0);
  assertEquals((await base.scan('a/item/07', { limit: 100 })).length, 5);
  await a.delete('item/x');
  await a.delete('item/x');
  assertEquals(await a.get('item/x'), undefined);
  await deletePrefix(a, 'item/');
  assertEquals((await a.scan('item/')).length, 0);
  assertEquals(await b.get('item/1'), 'keep');
  await b.putMany([]);
  const empty = [];
  for await (const row of iterate(b, 'zzz/')) {
    empty.push(row);
  }
  assertEquals(empty.length, 0);
});
Deno.test('MemoryKV: a reverse scan that exhausts every matching key stops at the prefix boundary instead of spilling into a neighboring prefix', async () => {
  const base = new MemoryKV();
  await base.put('a/1', 'a1');
  await base.put('b/1', 'b1');
  await base.put('b/2', 'b2');
  // limit comfortably exceeds the number of 'b/' rows, so the reverse walk must stop itself at the prefix edge.
  const rows = await base.scan('b/', { reverse: true, limit: 100 });
  assertEquals(rows.map((r) => r.key), ['b/2', 'b/1']);
});
Deno.test('MemoryKV/Namespace: deleteMany removes exactly the given keys, and deletePrefix pages through more than one 256-row scan', async () => {
  const base = new MemoryKV(), ns = new Namespace(base, 'p/');
  for (let i = 0; i < 600; i++) {
    await ns.put('row/' + String(i).padStart(3, '0'), i);
  }
  await ns.put('other/keep', 'x');
  await ns.deleteMany(['row/000', 'row/001', 'missing-key']);
  assertEquals(await ns.get('row/000'), undefined);
  assertEquals(await ns.get('row/002'), 2);
  assertEquals((await ns.scan('row/', { limit: 1000 })).length, 598);
  await deletePrefix(ns, 'row/');
  assertEquals((await ns.scan('row/', { limit: 1000 })).length, 0, 'deletePrefix must clear a prefix spanning more than one scan page');
  assertEquals(await ns.get('other/keep'), 'x', 'deletePrefix must not touch keys outside its own prefix');
});
Deno.test('deletePrefix: a store range delete and the paged fallback remove exactly the same keys', async () => {
  const keys = ['row', 'row/', 'row/1', 'row/2/x', 'row0', 'rowx/1', 'ro', 'zz'];
  const ranged = new MemoryKV();
  // The same store with deletePrefix hidden, so the free function takes its scan + deleteMany path.
  const paged = new MemoryKV();
  const plain: KV = {
    get: (k) => paged.get(k),
    put: (k, v) => paged.put(k, v),
    putMany: (r) => paged.putMany(r),
    delete: (k) => paged.delete(k),
    deleteMany: (k) => paged.deleteMany(k),
    scan: (p, o) => paged.scan(p, o),
  };
  for (const key of keys) {
    await ranged.put(key, key);
    await paged.put(key, key);
  }
  await deletePrefix(ranged, 'row/');
  await deletePrefix(plain, 'row/');
  const left = ['ro', 'row', 'row0', 'rowx/1', 'zz'];
  assertEquals((await ranged.scan('', { limit: 100 })).map((r) => r.key), left);
  assertEquals((await paged.scan('', { limit: 100 })).map((r) => r.key), left);
  await deletePrefix(ranged, 'nothing/');
  assertEquals((await ranged.scan('', { limit: 100 })).length, left.length, 'an empty prefix match is a no-op');
});
Deno.test('tiles: LRU eviction persists dirty tiles, huge sparse coordinates round-trip losslessly through PNG', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 256, 8);
  assertEquals(tiles.maxTiles, 8);
  assertThrows(() => new TileStore(db, 100));
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const x = (i % 2 ? 1 : -1) * (100000 + i * 37), y = (i % 3 ? 1 : -1) * (100000 + i * 23);
    positions.push({ x, y });
    const t = await tiles.get('huge', x, y);
    t.pixels.set([i, 77, 123, 255], 0);
    markCovered(t, 0);
    t.dirty = true;
  }
  assert(tiles.peakResidentTiles <= tiles.maxTiles);
  await tiles.flush();
  for (let i = 0; i < positions.length; i++) {
    const t = await tiles.get('huge', positions[i].x, positions[i].y);
    assert(covered(t, 0) && t.pixels[0] === i && t.pixels[3] === 255 && t.existed);
    assert(!covered(t, 1));
  }
  let count = 0;
  for await (const _ of iterate<TileIndex>(db, 'tile-index/huge/0/')) {
    count++;
  }
  assertEquals(count, 12);
  const payload = await tiles.payload('huge', 0, positions[0].x, positions[0].y);
  assert(payload && payload.blob.size > 0);
  assertEquals(await tiles.payload('huge', 0, 5, 5), undefined);
  assertEquals(tileKey('c', 1, 2, 3), 'c/1/2_3');
  assertEquals(countCovered(new Uint8Array([0xff, 0x01])), 9);
  await tiles.clear();
});
Deno.test('tiles: codec rejects mismatched stored sizes; pyramid halves observed tiles into previews', async () => {
  const wrong = new Blob([await encodeRGBA({ width: 4, height: 4, data: new Uint8ClampedArray(64) })]);
  await assertRejects(() => pngTileCodec.decode(wrong, 8), Error, 'expected 8×8');
  const db = new MemoryKV(), tiles = new TileStore(db, 64, 64);
  for (const [x, y] of [[0, 0], [1, 1], [3, 0]]) {
    const t = await tiles.get('c', x, y);
    for (let i = 0; i < 64 * 64; i++) {
      t.pixels.set([200, 100, 50, 255], i * 4);
      markCovered(t, i);
    }
    t.dirty = true;
  }
  await tiles.flush();
  const meta: CanvasMeta = {
    id: 'c',
    layer: 'l',
    name: 'c',
    kind: 'moving',
    bounds: { x: 0, y: 0, width: 256, height: 128 },
    tileCount: 3,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: 0,
    firstTime: 0,
    lastTime: 0,
  };
  let progress = 0;
  await tiles.buildPyramid(meta, async () => {
    progress++;
  });
  assertEquals(meta.maxLevel, 2);
  assert(progress >= 3);
  const parent = await db.get<StoredTile>(`tile/${tileKey('c', 1, 0, 0)}`);
  assert(parent);
  const decoded = await pngTileCodec.decode(parent.blob, 64);
  assertEquals([...decoded.subarray(0, 4)], [200, 100, 50, 255]);
  assertEquals(decoded[(40 * 64 + 40) * 4 + 3], 255);
  assertEquals(decoded[(10 * 64 + 40) * 4 + 3], 0);
  const top = await db.get<StoredTile>(`tile/${tileKey('c', 2, 0, 0)}`);
  assert(top);
  assertEquals((await db.scan('pyramid-todo/', { limit: 10 })).length, 0);
  const flat: CanvasMeta = { ...meta, id: 'small', maxLevel: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } };
  await tiles.buildPyramid(flat, async () => {});
  assertEquals(flat.maxLevel, 0);
  assertEquals(QUALITY_BLOCK, 16);
});
// buildPyramid's level count is `ceil(log2(maxDimension / size))` clamped to 0, computed by repeated doubling
// instead of `Math.log2` (a floating-point log/exp implementation is not guaranteed bit-identical across
// engines). These pin the boundary cases a doubling loop could get off-by-one on: exactly at `size`, one pixel
// under and over each power-of-two multiple of `size`.
Deno.test('tiles: buildPyramid level count at exact and near power-of-two boundaries of the tile size', async () => {
  const size = 64;
  const metaWithWidth = (width: number): CanvasMeta => ({
    id: `w${width}`,
    layer: 'l',
    name: 'w',
    kind: 'moving',
    bounds: { x: 0, y: 0, width, height: 1 },
    tileCount: 0,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: 0,
    firstTime: 0,
    lastTime: 0,
  });
  for (
    const [width, expectedLevel] of [
      [1, 0],
      [size - 1, 0],
      [size, 0], // ratio exactly 1: log2(1) = 0, no ceiling needed
      [size + 1, 1], // one pixel over: must round UP to the next level, not stay at 0
      [size * 2, 1], // ratio exactly 2: log2(2) = 1 exactly
      [size * 2 + 1, 2],
      [size * 4, 2],
      [size * 4 + 1, 3],
    ] as const
  ) {
    const db = new MemoryKV(), tiles = new TileStore(db, size, 64), meta = metaWithWidth(width);
    await tiles.buildPyramid(meta, async () => {});
    assertEquals(meta.maxLevel, expectedLevel, `width=${width}`);
  }
});
Deno.test('tiles: buildPyramid clears its pyramid-todo/ work queue at start and even when it fails partway (F28)', async () => {
  let fail = false;
  const flaky: TileCodec = {
    encode: (image) => {
      if (fail) return Promise.reject(new Error('encode failed'));
      return pngTileCodec.encode(image);
    },
    decode: pngTileCodec.decode,
  };
  const db = new MemoryKV(), tiles = new TileStore(db, 64, 64, flaky);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const t = await tiles.get('c', x, y);
    for (let i = 0; i < 64 * 64; i++) {
      t.pixels.set([1, 2, 3, 255], i * 4);
      markCovered(t, i);
    }
    t.dirty = true;
  }
  await tiles.flush();
  const meta: CanvasMeta = {
    id: 'c',
    layer: 'l',
    name: 'c',
    kind: 'moving',
    bounds: { x: 0, y: 0, width: 128, height: 128 },
    tileCount: 4,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: 0,
    firstTime: 0,
    lastTime: 0,
  };
  fail = true;
  await assertRejects(() => tiles.buildPyramid(meta, async () => {}), Error, 'encode failed');
  assertEquals((await db.scan('pyramid-todo/', { limit: 100 })).length, 0, 'a thrown encode must not leave pyramid-todo/ rows behind');
  // A stale queue from a previous (crashed) attempt on the same canvas must also be cleared before this run starts.
  await db.put('pyramid-todo/c/1/9_9', { x: 9, y: 9 });
  fail = false;
  await tiles.buildPyramid(meta, async () => {});
  assertEquals((await db.scan('pyramid-todo/', { limit: 100 })).length, 0);
});
Deno.test('diagnostics: every event is journaled, callbacks are throttled per code, counts and flush are exact', async () => {
  const db = new MemoryKV(), sent: Diagnostic[] = [], d = new Diagnostics(db, (e) => sent.push(e));
  for (let i = 0; i < 30; i++) {
    await d.emit({ code: 'A', severity: 'info', message: 'a' });
  }
  await d.emit({ code: 'B', severity: 'warning', message: 'b' });
  assertEquals(d.counts, { A: 30, B: 1 });
  assertEquals(sent.filter((e) => e.code === 'A').length, 1);
  // The running per-code total lives in `occurrences`, never overwriting an explicit `count` the caller supplied.
  assertEquals(sent[0].occurrences, 1);
  assertEquals(sent[0].count, undefined);
  await d.flush();
  await d.flush();
  assertEquals((await db.scan('diagnostic/', { limit: 100 })).length, 31);
});
Deno.test('diagnostics: an explicit event.count (e.g. a pre-aggregated decoder notice) survives untouched next to occurrences', async () => {
  const db = new MemoryKV(), sent: Diagnostic[] = [], d = new Diagnostics(db, (e) => sent.push(e));
  await d.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: 'skipped frames', count: 12 });
  await d.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: 'skipped frames again', count: 12 });
  // Both the live callback and the journaled row keep the caller's own count; the cumulative tally is separate.
  assertEquals(sent[0].count, 12);
  assertEquals(sent[0].occurrences, 1);
  await d.flush();
  const rows = await db.scan<Diagnostic>('diagnostic/', { limit: 10 });
  assertEquals(rows.map((r) => r.value.count), [12, 12]);
});
Deno.test('diagnostics: flush() keeps pending rows queued (not lost) when the underlying write fails', async () => {
  let fail = true;
  const inner = new MemoryKV();
  const flaky: KV = {
    get: (key) => inner.get(key),
    put: (key, value) => inner.put(key, value),
    delete: (key) => inner.delete(key),
    deleteMany: (keys) => inner.deleteMany(keys),
    scan: (prefix, options) => inner.scan(prefix, options),
    putMany: (rows) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('write failed'));
      }
      return inner.putMany(rows);
    },
  };
  const d = new Diagnostics(flaky, () => {});
  await d.emit({ code: 'A', severity: 'info', message: 'a' });
  await d.emit({ code: 'B', severity: 'info', message: 'b' });
  await assertRejects(() => d.flush());
  assertEquals((await inner.scan('diagnostic/', { limit: 10 })).length, 0, 'a failed write must not have silently dropped the queued rows');
  await d.flush();
  assertEquals(
    (await inner.scan('diagnostic/', { limit: 10 })).length,
    2,
    'the retried flush must still carry the rows the failed attempt lost from the journal',
  );
});
// Moved from takeover.test.ts (redistributed by subject: TileStore budget/eviction belongs with storage).
Deno.test('takeover: render cache rebalance avoids a viewport-sized cyclic eviction trap without an unbounded cache', async () => {
  // The render session sizes the cache: a 3456×2234 pass leaves only a few tiles of a 64 MB budget, so the limit is
  // raised to the 8 × 6 tiles (+ 2) one frame-sized region paints, and no further.
  const tiles = new TileStore(new MemoryKV(), 512, 64);
  const session = core().renderSession({
    width: 3456,
    height: 2234,
    factor: 1,
    noise: 0,
    regions: [{ id: 'page', kind: 'moving', rect: { x: 0, y: 0, width: 3456, height: 2234 }, code: 1, ownedPixels: 3456 * 2234 }],
    attachments: [],
  });
  try {
    const raised = session.configureTiles(tiles.engine, 64);
    assertEquals(raised?.code, 'MEMORY_BUDGET_RAISED');
  } finally {
    session.free();
  }
  assertEquals(tiles.maxTiles, 8 * 6 + 2);
  for (let i = 0; i < tiles.maxTiles + 3; i++) await tiles.get('c', i, 0);
  assertEquals(tiles.peakResidentTiles, tiles.maxTiles);
  assertEquals(tiles.evictions, 3);
});
Deno.test('tiles: a tile evicted while a caller holds it keeps its planes, and an explicit save() of it still lands', async () => {
  // The engine's cache owns resident planes; a caller that holds a tile across another get() (framing holds its
  // output tile while fetching sources) must still be able to finish writing it and save it, as with the plain
  // objects the cache handed out before.
  const db = new MemoryKV(), tiles = new TileStore(db, 16, 128);
  tiles.maxTiles = 1;
  const held = await tiles.get('c', 0, 0);
  held.pixels[0] = 7;
  held.coverage[0] = 1;
  held.dirty = true;
  await tiles.get('c', 1, 0); // evicts (and stores) the held tile
  assertEquals(tiles.evictions, 1);
  held.pixels[4] = 9;
  held.dirty = true;
  held.touched = 5;
  assertEquals(held.touched, 5);
  await tiles.save(held);
  assert(!held.dirty && held.existed);
  const reloaded = await tiles.get('c', 0, 0);
  assert(reloaded !== held, 'a reload is a new tile');
  assertEquals([reloaded.pixels[0], reloaded.pixels[4], reloaded.coverage[0]], [7, 9, 1]);
  // payload() stores a resident dirty tile first, so it reads back what the cache holds.
  reloaded.pixels[8] = 3;
  reloaded.dirty = true;
  reloaded.touched = 6;
  assertEquals(reloaded.touched, 6);
  assert(await tiles.payload('c', 0, 0, 0));
  assert(!reloaded.dirty);
  await tiles.clear();
  assertThrows(() => reloaded.pixels, Error, 'dropped by TileStore.clear()');
  // free() releases the engine's cache once; the counters stay readable and a second free() does nothing.
  const evictions = tiles.evictions, limit = tiles.maxTiles;
  tiles.free();
  tiles.free();
  assertEquals([tiles.evictions, tiles.maxTiles], [evictions, limit]);
  await assertRejects(() => tiles.get('c', 0, 0));
});
Deno.test('tiles: a failed eviction write keeps the tile cached and dirty, and a later flush stores its latest pixels', async () => {
  // Failure cases: the cache lets the tile go before its write succeeds (the pixels are lost, and the final flush
  // a failed run makes has nothing to retry), counts an eviction that did not happen, or brings the new tile in
  // anyway and grows past its limit.
  let fail = false;
  const inner = new MemoryKV();
  const flaky: KV = {
    get: (key) => inner.get(key),
    put: (key, value) => inner.put(key, value),
    delete: (key) => inner.delete(key),
    deleteMany: (keys) => inner.deleteMany(keys),
    scan: (prefix, options) => inner.scan(prefix, options),
    putMany: (rows) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('write failed'));
      }
      return inner.putMany(rows);
    },
  };
  const tiles = new TileStore(flaky, 16, 128);
  tiles.maxTiles = 1;
  const held = await tiles.get('c', 0, 0);
  held.pixels[0] = 7;
  held.coverage[0] = 1;
  held.dirty = true;
  fail = true;
  await assertRejects(() => tiles.get('c', 1, 0), Error, 'write failed');
  assert(tiles.isResident('c', 0, 0), 'the tile whose write failed is still cached');
  assert(!tiles.isResident('c', 1, 0));
  assertEquals(tiles.evictions, 0);
  assertEquals(tiles.peakResidentTiles, 1);
  assertEquals(await inner.get('tile/c/0/0_0'), undefined);
  assert(held.dirty);
  // The caller still holds the tile and keeps writing; the flush a failed run ends with stores what it holds now.
  held.pixels[4] = 9;
  held.dirty = true;
  await tiles.flush();
  assert(!held.dirty && held.existed);
  const stored = (await inner.get<StoredTile>('tile/c/0/0_0'))!;
  const pixels = await pngTileCodec.decode(stored.blob, 16);
  assertEquals([pixels[0], pixels[4], stored.coverage[0]], [7, 9, 1]);
  // With the write through, eviction goes ahead as before.
  await tiles.get('c', 1, 0);
  assertEquals(tiles.evictions, 1);
  assert(!tiles.isResident('c', 0, 0));
  await tiles.clear();
});
