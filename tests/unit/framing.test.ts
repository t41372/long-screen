import { assert, assertEquals } from '@std/assert';
import { buildFramedCanvas, frameCoordinate, frameLayout } from '../../src/core/framing.ts';
import { encodeRGBA } from '../../src/codec/png.ts';
import { iterate, MemoryKV } from '../../src/storage/db.ts';
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
  provisionalPixels: 0,
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
/** Writes a fully opaque, fully covered source tile exactly the way TileStore.save persists one (tile + tile-index rows together). */
async function paintSourceTile(tiles: TileStore, canvasId: string, sx: number, sy: number): Promise<void> {
  const t = await tiles.get(canvasId, sx, sy);
  t.pixels.fill(255);
  for (let i = 0; i < t.pixels.length / 4; i++) markCovered(t, i);
  t.dirty = true;
  await tiles.save(t);
}
async function countPrefix(db: MemoryKV, prefix: string): Promise<number> {
  let n = 0;
  for await (const _row of iterate(db, prefix)) n++;
  return n;
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
  // observedPixels tracks this canvas's OWN coverage bits (72 unique chrome positions copied from the single
  // reference frame, plus the one explicit raw-tile content pixel asserted below) — never the wider claim that
  // every one of those pixels is independently-observed world content; that provenance lives in `presentation`.
  assert(framed?.presentation);
  assertEquals(framed.observedPixels, 73);
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
Deno.test('framing: sparse source content skips content-only tiles with no backing source tile, but never drops a perimeter tile', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 32, 256), source = reference();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  // content is 800×800 against an 8×6 pane; sourceCanvas.bounds.{x,y} equal pane.{x,y} so interior output
  // tile (tx,ty) maps 1:1 onto source tile (tx,ty) with no straddling, keeping the expected count exact.
  const sparse: CanvasMeta = { ...meta, id: 'sparse', bounds: { x: 2, y: 2, width: 800, height: 800 }, tileCount: 4 };
  // Two far-apart observed clusters; everything else under the 800×800 content rect is unobserved.
  await paintSourceTile(tiles, sparse.id, 2, 3);
  await paintSourceTile(tiles, sparse.id, 3, 3);
  await paintSourceTile(tiles, sparse.id, 18, 19);
  await paintSourceTile(tiles, sparse.id, 19, 20);
  assertEquals(await countPrefix(db, `tile/${sparse.id}/0/`), 4);
  const framed = await buildFramedCanvas(db, tiles, sparse, region, [region], async () => {});
  assert(framed);
  const cols = 26, rows = 26, gridCells = cols * rows, ring = 2 * (cols + rows) - 4; // 676 cells total, 100-tile perimeter ring
  assertEquals(framed.tileCount, ring + 4);
  assertEquals(await countPrefix(db, `tile-index/${framed.id}/0/`), ring + 4);
  assert(framed.tileCount < 0.3 * gridCells, `expected far below ${gridCells} grid cells, got ${framed.tileCount}`);
  // Perimeter (chrome/decorative) tiles are always kept, even with no source data anywhere nearby: continuous frame.
  for (const [tx, ty] of [[0, 0], [25, 0], [0, 25], [25, 25], [0, 12]]) {
    assert(await db.get(`tile-index/${framed.id}/0/${tx}_${ty}`), `expected ring tile ${tx}_${ty} to be kept`);
  }
  // A content-only interior tile with no nearby source tile is skipped entirely.
  assertEquals(await db.get(`tile-index/${framed.id}/0/10_10`), undefined);
  // No phantom source tiles were materialised for the untouched interior of the content rect.
  assertEquals(await countPrefix(db, `tile/${sparse.id}/0/`), 4);
});
Deno.test('framing: maxTiles guard rejects an oversized run before any tile is touched', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 32, 256), source = reference();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const sparse: CanvasMeta = { ...meta, id: 'sparse-guard', bounds: { x: 2, y: 2, width: 800, height: 800 }, tileCount: 1 };
  await paintSourceTile(tiles, sparse.id, 2, 3);
  let reason: string | undefined;
  const result = await buildFramedCanvas(db, tiles, sparse, region, [region], async () => {}, {
    maxTiles: 10,
    onSkipped: (r) => {
      reason = r;
    },
  });
  assertEquals(result, undefined);
  assert(reason?.includes('10'), `expected reason to name the 10-tile limit, got: ${reason}`);
  assertEquals(await db.get(`canvas/${sparse.id}-framed`), undefined);
  assertEquals(await countPrefix(db, `tile/${sparse.id}-framed/`), 0);
  assertEquals(await countPrefix(db, `tile-index/${sparse.id}-framed/`), 0);
});
Deno.test('framing: a 12000×12000 sparse bounding box with 8 observed tiles stays far below the grid-cell count and finishes quickly', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 512, 1024), source = reference();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const big: CanvasMeta = { ...meta, id: 'big-sparse', bounds: { x: 2, y: 2, width: 12000, height: 12000 }, tileCount: 8 };
  const positions: [number, number][] = [[2, 2], [3, 3], [5, 8], [10, 2], [15, 15], [20, 4], [4, 20], [22, 22]];
  for (const [sx, sy] of positions) await paintSourceTile(tiles, big.id, sx, sy);
  // Count framed-tile allocations rather than wall-clock time: the O(area) traversal allocated one tile per grid cell,
  // and a timing bound is load-dependent on a shared machine.
  const originalGet = tiles.get.bind(tiles);
  let framedGets = 0;
  tiles.get = ((canvasId: string, x: number, y: number, level?: number) => {
    if (canvasId === `${big.id}-framed`) framedGets++;
    return originalGet(canvasId, x, y, level);
  }) as typeof tiles.get;
  const framed = await buildFramedCanvas(db, tiles, big, region, [region], async () => {});
  assert(framed);
  const cols = Math.ceil((source.width + 12000 - region.rect.width) / tiles.size),
    rows = Math.ceil((source.height + 12000 - region.rect.height) / tiles.size),
    gridCells = cols * rows;
  assertEquals(gridCells, 576);
  assert(framed.tileCount < 0.3 * gridCells, `expected far below ${gridCells} grid cells, got ${framed.tileCount}`);
  assert(framedGets < 0.3 * gridCells, `expected far fewer framed-tile allocations than ${gridCells} grid cells, got ${framedGets}`);
  assert(framedGets >= framed.tileCount, `every stored framed tile was allocated: ${framedGets} allocations for ${framed.tileCount} tiles`);
});
