import { assert, assertEquals } from '@std/assert';
import { buildFramedCanvas, frameCoordinate, frameLayout } from '../../src/core/framing.ts';
import { encodeRGBA } from '../../src/codec/png.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { covered, markCovered, TileStore } from '../../src/storage/tiles.ts';
import type { CanvasMeta, Region, RGBA } from '../../src/types.ts';
const region: Region = { id: 'pane', name: 'pane', kind: 'moving', rect: { x: 2, y: 2, width: 8, height: 6 }, solid: true };
const meta: CanvasMeta = {
  id: 'world',
  layer: region.id,
  name: 'world',
  kind: 'moving',
  bounds: { x: -3, y: 7, width: 14, height: 12 },
  tileCount: 2,
  observedPixels: 1,
  uncertainPixels: 0,
  conflictPixels: 0,
  maxLevel: 0,
  fragment: 0,
  firstTime: 0,
  lastTime: 1,
};
function reference(): RGBA {
  const data = new Uint8ClampedArray(12 * 10 * 4);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 12; x++) data.set([x * 10, y * 10, 77, 255], (y * 12 + x) * 4);
  return { width: 12, height: 10, data };
}
Deno.test('framing: all four sides are shown once at native scale; extensions never repeat UI glyphs', () => {
  const source = reference(), layout = frameLayout(source, region, meta), copied = new Map<string, number>();
  assertEquals([layout.width, layout.height], [18, 16]);
  let content = 0, extensions = 0;
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const p = frameCoordinate(layout, x, y);
      if (p === null) content++;
      else if (p === undefined) extensions++;
      else {
        const key = `${p.x},${p.y}`;
        copied.set(key, (copied.get(key) || 0) + 1);
      }
    }
  }
  assertEquals(content, 14 * 12);
  assert(extensions > 0);
  assertEquals(copied.size, 12 * 10 - 8 * 6);
  assert([...copied.values()].every((n) => n === 1));
});
Deno.test('framing: pane geometry is never shrunk to a tiny observed content box', () => {
  const layout = frameLayout(reference(), region, { ...meta, bounds: { x: 0, y: 0, width: 3, height: 3 } });
  assertEquals(layout.content.width, 8);
  assertEquals(layout.content.height, 6);
  assertEquals([layout.width, layout.height], [12, 10]);
});
Deno.test('framing: raw pixels and holes survive negative origins; decorated pixels have no evidence coverage', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 16, 64), source = reference();
  const raw = await tiles.get(meta.id, -1, 0), i = 7 * 16 + 13;
  raw.pixels.set([19, 29, 39, 255], i * 4);
  markCovered(raw, i);
  raw.dirty = true;
  await tiles.flush();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const framed = await buildFramedCanvas(db, tiles, meta, region, [region], async () => {});
  assert(framed?.presentation);
  assertEquals(framed.observedPixels, 0);
  const t = await tiles.get(framed.id, 0, 0);
  assertEquals([...t.pixels.subarray((2 * 16 + 2) * 4, (2 * 16 + 2) * 4 + 4)], [19, 29, 39, 255]);
  assert(covered(t, 2 * 16 + 2));
  assertEquals(t.pixels[(3 * 16 + 3) * 4 + 3], 0);
  assert(!covered(t, 6));
  assertEquals(t.pixels[6 * 4 + 3], 255);
  assertEquals([...t.pixels.subarray(0, 4)], [...source.data.subarray(0, 4)]);
  assert(covered(t, 0));
  assertEquals((await tiles.get(meta.id, -1, 0)).pixels[i * 4], 19);
});
Deno.test('framing: missing references, empty/attached canvases and full-frame panes do not fabricate a frame', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 16, 64);
  assertEquals(await buildFramedCanvas(db, tiles, meta, region, [region], async () => {}), undefined);
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(reference())]) });
  for (const m of [{ ...meta, tileCount: 0 }, { ...meta, attachedTo: 'elsewhere' }]) {
    assertEquals(await buildFramedCanvas(db, tiles, m, region, [region], async () => {}), undefined);
  }
  const full = { ...region, rect: { x: 0, y: 0, width: 12, height: 10 } };
  assertEquals(await buildFramedCanvas(db, tiles, meta, full, [full], async () => {}), undefined);
});
Deno.test('framing: explicit ignore regions are not reintroduced as reference chrome', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 16, 64);
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(reference())]) });
  const ignored: Region = { id: 'secret', name: 'secret', kind: 'ignore', rect: { x: 0, y: 0, width: 2, height: 2 } };
  const framed = await buildFramedCanvas(db, tiles, meta, region, [region, ignored], async () => {});
  assert(framed);
  assertEquals((await tiles.get(framed.id, 0, 0)).pixels[3], 0);
});
