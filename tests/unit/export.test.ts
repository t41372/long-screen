import { assert, assertEquals, assertRejects } from '@std/assert';
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
function zipEntries(bytes: Uint8Array): string[] {
  const names: string[] = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = Number(view.getBigUint64(bytes.length - 34, true)),
    cd = Number(view.getBigUint64(at + 48, true)),
    count = Number(view.getBigUint64(at + 32, true));
  let p = cd;
  for (let i = 0; i < count; i++) {
    const n = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
    names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + n)));
    p += 46 + n + extra + comment;
  }
  return names;
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
  return { db, p, store, meta, tiles };
}
Deno.test('export: project ZIP64 contains tiles, coverage, quality, ledgers and an offline viewer', async () => {
  const { p, store } = await project(), target = fakeHandle(), messages: string[] = [];
  const result = await exportProject(store, p, (m) => messages.push(m), target.handle);
  assert(target.closed && result.name.endsWith('.zip'));
  const names = zipEntries(target.bytes());
  for (
    const required of [
      'manifest.json',
      'index.html',
      'README.txt',
      'tiles/c/0/0_0.png',
      'tiles/c/0/-1_-1.png',
      'coverage/c/0_0.bin',
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
Deno.test('export: rasterRows streams rows of exact width from tiles', async () => {
  const { store } = await project(), tiles = new TileStore(store, 64, 64);
  let rows = 0;
  for await (const row of rasterRows(tiles, 'c', { x: -3, y: -2, width: 40, height: 30 }, () => {})) {
    assertEquals(row.length, 160);
    rows++;
  }
  assertEquals(rows, 30);
});
Deno.test('export: targets without a file handle need OPFS and say so; cleanup needs OPFS too', async () => {
  await assertRejects(() => createTarget('x.zip'), Error, 'DISK_EXPORT_UNAVAILABLE');
  await assertRejects(() => cleanupExport('key'), Error);
  const target = fakeHandle(), t = await createTarget('name.png', target.handle);
  await t.sink.write(new Uint8Array([1]));
  await t.sink.close();
  assertEquals(await t.result(), { name: 'name.png' });
  await t.sink.abort?.(new Error('x'));
  assert(target.aborted);
});
