import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { unzipSync } from 'fflate';
import { MemoryKV, Namespace } from '../../src/storage/db.ts';
import { markCovered, TileStore } from '../../src/storage/tiles.ts';
import { exportCanvas, exportProject } from '../../src/export/project.ts';
import { cleanupExport, createTarget } from '../../src/export/target.ts';
import { rasterRows } from '../../src/export/png.ts';
import { decodePNG } from '../../src/codec/png.ts';
import { offlineViewer } from '../../src/export/offline.ts';
import { type CanvasMeta, DEFAULT_SETTINGS, type Project } from '../../src/types.ts';
/** A fake FileSystemFileHandle whose writable collects bytes in memory. */
function fakeHandle() {
  const parts: Uint8Array[] = [];
  let closed = false, aborted: unknown;
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (d: Uint8Array) => {
          parts.push(d.slice());
          return Promise.resolve();
        },
        close: () => {
          closed = true;
          return Promise.resolve();
        },
        abort: (e: unknown) => {
          aborted = e;
          return Promise.resolve();
        },
      }),
  } as unknown as FileSystemFileHandle;
  return {
    handle,
    bytes: () => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    },
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
  };
}
// Verification goes through a real, independent ZIP reader (fflate, MIT, pinned in deno.json) rather than
// hand-decoding client-zip's own record layout — the point of the swap away from the hand-written writer is that
// its bytes are no longer this test's business, only that a standard reader can open them and recover exact content.
function zipEntries(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes));
}
/** Reads one stored entry's exact bytes back out of an archive, via a real unzip implementation, for tests that
 *  need actual file content (or ordering — `Object.keys` preserves the central directory's insertion order for
 *  these non-numeric names), not just names. */
function zipEntryBytes(bytes: Uint8Array, name: string): Uint8Array {
  const entry = unzipSync(bytes)[name];
  if (!entry) {
    throw new Error(`Entry not found: ${name}`);
  }
  return entry;
}
async function project(width = 40, height = 30) {
  const db = new MemoryKV(),
    p: Project = {
      id: 'p1',
      created: '',
      updated: '',
      name: 'x',
      settings: { ...DEFAULT_SETTINGS, tileSize: 64, memoryMB: 64 },
      status: 'complete',
      frames: 1,
      renderedFrames: 1,
      canvasCount: 1,
      tiles: 1,
      observedPixels: 1,
      diagnostics: {},
      regions: [],
    };
  const store = new Namespace(db, `run/${p.id}/`),
    tiles = new TileStore(store, 64, 64),
    meta: CanvasMeta = {
      id: 'c',
      layer: 'l',
      name: 'c',
      kind: 'moving',
      bounds: { x: -3, y: -2, width, height },
      tileCount: 0,
      observedPixels: 0,
      uncertainPixels: 0,
      conflictPixels: 0,
      provisionalPixels: 0,
      maxLevel: 0,
      fragment: 0,
      firstTime: 0,
      lastTime: 1,
    };
  for (let y = -2; y < -2 + height; y++) {
    for (let x = -3; x < -3 + width; x++) {
      if ((x + y) % 5 === 0) {
        continue;
      }
      const t = await tiles.get('c', Math.floor(x / 64), Math.floor(y / 64)),
        lx = x - Math.floor(x / 64) * 64,
        ly = y - Math.floor(y / 64) * 64,
        i = ly * 64 + lx;
      t.pixels.set([(x + 10) & 255, (y + 10) & 255, 7, 255], i * 4);
      markCovered(t, i);
      t.quality[0] = 200;
      t.owner[0] = 1;
      t.dirty = true;
    }
  }
  await tiles.flush();
  meta.tileCount = 2;
  await store.put('canvas/c', meta);
  await store.put('observation/0000000000', { frame: 0, decisions: [] });
  await store.put('diagnostic/0000000000', { code: 'X', severity: 'info', message: 'm' });
  await store.put('node/c/0000000000', { id: 'c/0', x: 0, y: 0 });
  await store.put('graph-summary', { loops: 0 });
  await store.put('memory-stats', { peakResidentTiles: 1, tileCacheLimit: 2 });
  const mask = new Uint8Array([1, 0, 1, 1, 0, 1, 1, 1]);
  await store.put('regions', [{
    id: 'l',
    name: 'l',
    kind: 'moving',
    rect: { x: 0, y: 0, width: 4, height: 2 },
    mask,
    maskWidth: 4,
    maskHeight: 2,
    factor: 1,
  }]);
  return { db, p, store, meta, tiles, mask };
}
Deno.test('export: project ZIP64 contains tiles, coverage, quality, ledgers and an offline viewer', async () => {
  const { p, store, mask } = await project(), target = fakeHandle(), messages: string[] = [];
  const result = await exportProject(store, p, (m) => messages.push(m), target.handle);
  assert(target.closed && result.name.endsWith('.zip'));
  const bytes = target.bytes(), names = zipEntries(bytes);
  for (
    const required of [
      'manifest.json',
      'index.html',
      'README.txt',
      'regions.json',
      'tiles/c/0/0_0.png',
      'tiles/c/0/-1_-1.png',
      'coverage/c/0_0.bin',
      'provisional/c/0_0.bin',
      'quality/c/0_0.json',
      'observations.jsonl',
      'diagnostics.jsonl',
      'poses.jsonl',
      'pose-edges.jsonl',
      'analysis.jsonl',
      'temporal.jsonl',
      'graph-summary.json',
      'memory-stats.json',
    ]
  ) {
    assert(names.includes(required), required);
  }
  assert(messages.length > 0);
  // Entries stream out in the exact order exportProject() calls zip.add(): the four fixed front-matter files
  // first, in the order they were written, then tiles/coverage/provisional/quality per committed tile.
  assertEquals(names.slice(0, 4), ['manifest.json', 'index.html', 'README.txt', 'regions.json']);
  // regions.json: the mask is base64, not a decimal Array.from JSON array, and decodes back losslessly.
  const regions = JSON.parse(new TextDecoder().decode(zipEntryBytes(bytes, 'regions.json')));
  assertEquals(regions.length, 1);
  assertEquals(typeof regions[0].mask, 'string');
  assertEquals([...Uint8Array.from(atob(regions[0].mask), (c) => c.charCodeAt(0))], [...mask]);
  assertEquals(regions[0].maskWidth, 4);
  assertEquals(regions[0].maskHeight, 2);
  // analysis.jsonl no longer carries per-feature descriptors (scan-features/ is separate, scratch, and deleted
  // by solve() once consumed).
  const analysis = new TextDecoder().decode(zipEntryBytes(bytes, 'analysis.jsonl'));
  assert(!analysis.includes('descriptor'), analysis);
  const html = offlineViewer({ canvases: [], tileSize: 64 });
  assert(html.includes('<!doctype html>') && !html.includes('</script><script>'));
  assert(offlineViewer({ x: '</script>' }).includes('\\u003c/script>'));
});
Deno.test('export: missing committed tile aborts the export instead of writing a partial archive silently', async () => {
  const { p, store } = await project();
  await store.delete('tile/c/0/0_0');
  const target = fakeHandle();
  await assertRejects(() => exportProject(store, p, () => {}, target.handle), Error, 'Missing committed tile');
  assert(target.aborted);
  // F28: the ZIP writer (client-zip, streamed straight into the sink) never stages a central-directory row in
  // storage the way the old hand-rolled writer did, so this is now a standing invariant rather than a cleanup this
  // test needs to provoke — kept as a regression guard in case a future writer reintroduces staging.
  assertEquals((await store.scan('export-index/', { limit: 100 })).length, 0, 'a failed export must not leave export-index/ rows behind');
});
Deno.test('export: a sink that fails partway leaves no export-index rows behind (F28)', async () => {
  const { p, store } = await project();
  let calls = 0;
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (_d: Uint8Array) => {
          calls++;
          if (calls > 3) return Promise.reject(new Error('disk full'));
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      }),
  } as unknown as FileSystemFileHandle;
  await assertRejects(() => exportProject(store, p, () => {}, handle), Error, 'disk full');
  assertEquals((await store.scan('export-index/', { limit: 100 })).length, 0);
});
Deno.test('export: a failing sheet export leaves no export-index or sheet-export rows behind (F28)', async () => {
  const { p, store, meta } = await project(5000, 24);
  let calls = 0;
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (_d: Uint8Array) => {
          calls++;
          if (calls > 2) return Promise.reject(new Error('disk full'));
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      }),
  } as unknown as FileSystemFileHandle;
  await assertRejects(() => exportCanvas(store, p, meta, () => {}, handle), Error, 'disk full');
  assertEquals((await store.scan('export-index/', { limit: 100 })).length, 0);
  assertEquals((await store.scan('sheet-export/', { limit: 100 })).length, 0);
});
Deno.test('export: single native PNG keeps holes transparent and negative origins exact', async () => {
  const { p, store, meta } = await project(), target = fakeHandle();
  const result = await exportCanvas(store, p, meta, () => {}, target.handle);
  assert(result.name.endsWith('.png') && result.message.includes('40 × 30'));
  const image = await decodePNG(target.bytes());
  assertEquals([image.width, image.height], [40, 30]);
  let transparent = 0, opaque = 0;
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      const wx = x - 3, wy = y - 2, i = (y * 40 + x) * 4;
      if ((wx + wy) % 5 === 0) {
        assertEquals(image.data[i + 3], 0);
        transparent++;
      } else {
        assertEquals([image.data[i], image.data[i + 1], image.data[i + 3]], [(wx + 10) & 255, (wy + 10) & 255, 255]);
        opaque++;
      }
    }
  }
  assert(transparent > 0 && opaque > 0);
});
Deno.test('export: fractional bounds extent covers the ceil of the absolute right and bottom edges', async () => {
  const { p, store, meta } = await project(41, 31), target = fakeHandle();
  meta.bounds = { x: -2.4, y: -1.6, width: 40, height: 30 };
  const result = await exportCanvas(store, p, meta, () => {}, target.handle);
  assert(result.name.endsWith('.png') && result.message.includes('41 × 31'));
  const image = await decodePNG(target.bytes());
  assertEquals([image.width, image.height], [41, 31]);
  const right = (1 * image.width + 40) * 4, bottom = (30 * image.width + 1) * 4;
  assertEquals([...image.data.subarray(right, right + 2)], [47, 9]);
  assertEquals([...image.data.subarray(bottom, bottom + 2)], [8, 38]);
  assertEquals([image.data[right + 3], image.data[bottom + 3]], [255, 255]);
});
Deno.test('export: canvases beyond the compatible sheet size are split into overlapping native sheets with coordinates', async () => {
  const { p, store, meta } = await project(5000, 24), target = fakeHandle();
  const result = await exportCanvas(store, p, meta, () => {}, target.handle);
  assert(result.name.endsWith('.zip') && result.message.includes('张原尺寸图片'));
  const names = zipEntries(target.bytes());
  assert(
    names.includes('manifest.json') && names.includes('sheet_0_0.png') && names.includes('sheet_1_0.json') &&
      names.includes('sheet_1_0.png'),
    names.join(','),
  );
  assertEquals((await store.scan('sheet-export/', { limit: 10 })).length, 0);
});
// "Download image" must give one PNG of the whole canvas whatever its size: a canvas the automatic layout splits into
// sheets (wider than the sheet width) comes out as a single image with every pixel where the sheets would have put it.
// Failure modes: a ZIP despite the single layout, a wrong size (sheet-sized, or overlap added), shifted rows, lost edges.
Deno.test('export: the single layout writes one PNG of the whole canvas even where the automatic layout splits it', async () => {
  const { p, store, meta } = await project(5000, 24), target = fakeHandle();
  const result = await exportCanvas(store, p, meta, () => {}, target.handle, 'single');
  assert(result.name.endsWith('.png') && result.message.includes('5000 × 24'), `${result.name}: ${result.message}`);
  const image = await decodePNG(target.bytes());
  assertEquals([image.width, image.height], [5000, 24]);
  for (const [x, y] of [[-3, -2], [4996, 21], [2500, 10], [4095, 5], [4096, 6]]) {
    const i = ((y + 2) * image.width + x + 3) * 4, hole = (x + y) % 5 === 0;
    assertEquals([...image.data.subarray(i, i + 4)], hole ? [0, 0, 0, 0] : [(x + 10) & 255, (y + 10) & 255, 7, 255], `pixel ${x},${y}`);
  }
});
// The 'sheets' layout is the explicit UI entry point for the paged ZIP (restored to the UI after b93d2ea made
// "下载长图" always send 'single'): it must always page, even a canvas that would otherwise fit one PNG under
// 'auto' — that canvas still gets a ZIP, just with exactly one sheet plus its manifest, not silently a PNG.
Deno.test('export: the sheets layout always pages, even a canvas that would fit one PNG under auto (one sheet + manifest)', async () => {
  const { p, store, meta } = await project(), target = fakeHandle();
  const result = await exportCanvas(store, p, meta, () => {}, target.handle, 'sheets');
  assert(result.name.endsWith('.zip'));
  // An explicit 'sheets' choice never "exceeded" anything, unlike an 'auto' overflow: the message must say so.
  assertEquals(result.message, '已按分页导出为 1 张原尺寸图片；相邻页最多重叠 32px，坐标见 manifest。');
  const bytes = target.bytes(), names = zipEntries(bytes);
  assertEquals(names.filter((n) => n.endsWith('.png')).length, 1, names.join(','));
  assert(names.includes('manifest.json') && names.includes('sheet_0_0.png') && names.includes('sheet_0_0.json'), names.join(','));
  const image = await decodePNG(zipEntryBytes(bytes, 'sheet_0_0.png'));
  assertEquals([image.width, image.height], [40, 30]);
  let transparent = 0, opaque = 0;
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      const wx = x - 3, wy = y - 2, i = (y * 40 + x) * 4;
      if ((wx + wy) % 5 === 0) {
        assertEquals(image.data[i + 3], 0);
        transparent++;
      } else {
        assertEquals([image.data[i], image.data[i + 1], image.data[i + 3]], [(wx + 10) & 255, (wy + 10) & 255, 255]);
        opaque++;
      }
    }
  }
  assert(transparent > 0 && opaque > 0);
  assertEquals((await store.scan('sheet-export/', { limit: 10 })).length, 0);
});
Deno.test("export: the sheets layout on a canvas needing several sheets matches auto's paging exactly", async () => {
  const { p, store, meta } = await project(5000, 24), target = fakeHandle();
  const result = await exportCanvas(store, p, meta, () => {}, target.handle, 'sheets');
  assert(result.name.endsWith('.zip') && result.message.includes('张原尺寸图片'));
  const names = zipEntries(target.bytes());
  assert(
    names.includes('manifest.json') && names.includes('sheet_0_0.png') && names.includes('sheet_1_0.json') &&
      names.includes('sheet_1_0.png'),
    names.join(','),
  );
  assertEquals((await store.scan('sheet-export/', { limit: 10 })).length, 0);
});
Deno.test('export: fractional sheet bounds preserve absolute edge pixels and overlap coordinates', async () => {
  const { p, store, meta } = await project(5001, 31), target = fakeHandle();
  meta.bounds = { x: -2.4, y: -1.6, width: 5000, height: 30 };
  const result = await exportCanvas(store, p, meta, () => {}, target.handle);
  assert(result.name.endsWith('.zip'));
  const bytes = target.bytes();
  const firstBounds = JSON.parse(new TextDecoder().decode(zipEntryBytes(bytes, 'sheet_0_0.json')));
  const lastBounds = JSON.parse(new TextDecoder().decode(zipEntryBytes(bytes, 'sheet_1_0.json')));
  assertEquals(firstBounds, { x: -3, y: -2, width: 4128, height: 31 });
  assertEquals(lastBounds, { x: 4093, y: -2, width: 905, height: 31 });
  const first = await decodePNG(zipEntryBytes(bytes, 'sheet_0_0.png'));
  const last = await decodePNG(zipEntryBytes(bytes, 'sheet_1_0.png'));
  assertEquals([first.width, first.height, last.width, last.height], [4128, 31, 905, 31]);
  const right = (last.width + last.width - 1) * 4, bottom = (30 * first.width + 1) * 4;
  assertEquals([...last.data.subarray(right, right + 4)], [(4997 + 10) & 255, 9, 7, 255]);
  assertEquals([...first.data.subarray(bottom, bottom + 4)], [8, 38, 7, 255]);
  for (let y = 0; y < first.height; y++) {
    assertEquals(
      first.data.subarray((y * first.width + 4096) * 4, (y * first.width + 4128) * 4),
      last.data.subarray(y * last.width * 4, (y * last.width + 32) * 4),
    );
  }
  assertEquals((await store.scan('sheet-export/', { limit: 10 })).length, 0);
});
Deno.test('export: rasterRows streams rows of exact width from tiles', async () => {
  const { store } = await project(), tiles = new TileStore(store, 64, 64);
  let rows = 0;
  for await (const row of rasterRows(tiles, 'c', { x: -3, y: -2, width: 40, height: 30 }, () => {})) {
    assertEquals(row.length, 160);
    rows++;
  }
  assertEquals(rows, 30);
});
// Without a file handle or OPFS (Safari Private Browsing, and Deno here) the export is assembled in memory up to a
// limit. Failure modes: bytes reordered or aliased when the writer reuses its buffer, a result handed out before the
// export is closed, the limit silently ignored or failing without saying why.
Deno.test('export: without a file handle or OPFS the export is kept in memory up to a limit; cleanup needs OPFS', async () => {
  const memory = await createTarget('x.png', undefined, 8), chunk = new Uint8Array([1, 2, 3]);
  await memory.sink.write(chunk);
  chunk.set([7, 8, 9]);
  await memory.sink.write(chunk);
  await assertRejects(() => memory.result(), Error, 'not committed');
  await memory.sink.close();
  const { blob, name, temporary } = await memory.result();
  assertEquals([name, temporary, blob!.type], ['x.png', undefined, 'image/png']);
  assertEquals([...new Uint8Array(await blob!.arrayBuffer())], [1, 2, 3, 7, 8, 9]);
  const over = await createTarget('x.zip', undefined, 8);
  await over.sink.write(new Uint8Array(5));
  await assertRejects(() => over.sink.write(new Uint8Array(5)), Error, 'DISK_EXPORT_UNAVAILABLE');
  await assertRejects(() => over.sink.close(), Error, 'closed');
  await assertRejects(() => over.result(), Error, 'not committed');
  await assertRejects(() => cleanupExport('key'), Error);
  const target = fakeHandle(), t = await createTarget('name.png', target.handle);
  await t.sink.write(new Uint8Array([1]));
  await t.sink.close();
  assertEquals(await t.result(), { name: 'name.png' });
  await t.sink.abort?.(new Error('x'));
  assert(target.aborted);
});
