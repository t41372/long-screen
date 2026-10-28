import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { buildFramedCanvas, frameCoordinate, frameLayout } from '../../src/core/framing.ts';
import { encodeRGBA } from '../../src/codec/png.ts';
import { iterate, MemoryKV } from '../../src/storage/db.ts';
import { covered, markCovered, provisional, TileStore } from '../../src/storage/tiles.ts';
import type { CanvasMeta, Region, RGBA } from '../../src/types.ts';
import { markProvisional } from '../support/tile-bits.ts';
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
/** A 12×10 reference frame: a gradient inside the 8×6 pane at (2, 2), and flat chrome around it, so every chrome row
 *  and column has a background colour to extend (a row with none stays transparent, kernels/framing.rs). */
function reference(): RGBA {
  const data = new Uint8ClampedArray(12 * 10 * 4);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 12; x++) {
      const inPane = x >= 2 && x < 10 && y >= 2 && y < 8;
      data.set(inPane ? [x * 10, y * 10, 77, 255] : [90, 100, 110, 255], (y * 12 + x) * 4);
    }
  }
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
Deno.test('framing: a two-tile cache that evicts the output tile mid-fold stores exactly what a large cache does', async () => {
  // Output tile (0,0) sits over four source tiles; with room for two tiles, bringing in the second source tile
  // evicts the output tile, and the session must finish and store it from the copy it kept.
  const run = async (maxTiles?: number) => {
    const db = new MemoryKV(), tiles = new TileStore(db, 16, 64);
    for (const [sx, sy] of [[-1, 0], [0, 0], [-1, 1], [0, 1]]) {
      const t = await tiles.get(meta.id, sx, sy);
      for (let i = 0; i < 16 * 16; i++) {
        t.pixels.set([40 + sx * 30, 60 + sy * 50, i & 255, 255], i * 4);
        markCovered(t, i);
      }
      markProvisional(t, sx + 2 + sy * 16);
      t.quality[0] = 10 + sy;
      t.owner[0] = 5 + sx;
      t.dirty = true;
    }
    await tiles.clear();
    if (maxTiles) tiles.maxTiles = maxTiles;
    await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(reference())]) });
    const framed = await buildFramedCanvas(db, tiles, meta, region, [region], async () => {});
    await tiles.flush();
    const rows: Record<string, unknown> = {};
    for await (const { key, value } of iterate<Record<string, unknown>>(db, `tile/${meta.id}-framed/`)) {
      rows[key] = await Promise.all(
        Object.entries(value).map(async ([k, v]) => [k, v instanceof Blob ? [...new Uint8Array(await v.arrayBuffer())] : v]),
      );
    }
    return { framed, rows, evictions: tiles.evictions };
  };
  const large = await run(), small = await run(2);
  assert(small.evictions > large.evictions, 'the two-tile cache never evicted');
  assertEquals(small.framed, large.framed);
  assertEquals(Object.keys(small.rows).length, 2);
  assertEquals(small.rows, large.rows);
});
Deno.test('framing: copied content preserves provisional and block evidence conservatively across the presentation offset', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 16, 64), source = reference();
  const sourceMeta: CanvasMeta = { ...meta, id: 'evidence', uncertainPixels: 7, conflictPixels: 11, provisionalPixels: 1 };
  const raw = await tiles.get(sourceMeta.id, -1, 0), i = 7 * 16 + 13;
  raw.pixels.set([19, 29, 39, 255], i * 4);
  markCovered(raw, i);
  markProvisional(raw, i);
  raw.quality[0] = 37;
  raw.score[0] = 0.42;
  raw.conflicts[0] = 1;
  raw.owner[0] = 23;
  raw.frozen[0] = 1;
  raw.dirty = true;
  await tiles.flush();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });

  const framed = await buildFramedCanvas(db, tiles, sourceMeta, region, [region], async () => {});
  assert(framed);
  assertEquals(framed.uncertainPixels, sourceMeta.uncertainPixels);
  assertEquals(framed.conflictPixels, sourceMeta.conflictPixels);
  assertEquals(framed.provisionalPixels, 1);
  const tile = await tiles.get(framed.id, 0, 0), destination = 2 * 16 + 2;
  assertEquals([...tile.pixels.subarray(destination * 4, destination * 4 + 4)], [19, 29, 39, 255]);
  assert(covered(tile, destination));
  assert(provisional(tile, destination));
  assertEquals(tile.quality[0], 37);
  assert(Math.abs(tile.score[0] - 0.42) < 0.001);
  assertEquals(tile.conflicts[0], 1);
  assertEquals(tile.owner[0], 23);
  assertEquals(tile.frozen[0], 1);
});
Deno.test('framing: a non-tile-aligned offset carries block evidence to the correct destination block', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 32, 64), source = reference();
  const sourceMeta: CanvasMeta = {
    ...meta,
    id: 'evidence-shifted',
    bounds: { x: -3, y: 7, width: 64, height: 64 },
    tileCount: 1,
    uncertainPixels: 4,
    conflictPixels: 9,
    provisionalPixels: 1,
  };
  const raw = await tiles.get(sourceMeta.id, 0, 0), sourcePixel = 7 * 32 + 11;
  raw.pixels.set([31, 41, 51, 255], sourcePixel * 4);
  markCovered(raw, sourcePixel);
  markProvisional(raw, sourcePixel);
  raw.quality[0] = 37;
  raw.score[0] = 0.42;
  raw.conflicts[0] = 1;
  raw.owner[0] = 23;
  raw.frozen[0] = 1;
  raw.dirty = true;
  await tiles.flush();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });

  const framed = await buildFramedCanvas(db, tiles, sourceMeta, region, [region], async () => {});
  assert(framed);
  assertEquals(framed.uncertainPixels, sourceMeta.uncertainPixels);
  assertEquals(framed.conflictPixels, sourceMeta.conflictPixels);
  assertEquals(framed.provisionalPixels, 1);
  // The source origin (-3, 7) and pane origin (2, 2) produce a +5px presentation offset. The source pixel
  // lands at output (16, 2): tile (0, 0), block 1, not source block 0's local destination by coincidence.
  const tile = await tiles.get(framed.id, 0, 0), destination = 2 * 32 + 16;
  assertEquals([...tile.pixels.subarray(destination * 4, destination * 4 + 4)], [31, 41, 51, 255]);
  assert(covered(tile, destination));
  assert(provisional(tile, destination));
  assertEquals(tile.quality[1], 37);
  assert(Math.abs(tile.score[1] - 0.42) < 0.001);
  assertEquals(tile.conflicts[1], 1);
  assertEquals(tile.owner[1], 23);
  assertEquals(tile.frozen[1], 1);
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
  // Content is 800×800 against an 8×6 pane; sourceCanvas.bounds.{x,y} equal pane.{x,y}, so the interior
  // output tile (tx,ty) maps onto source tile (tx,ty) with no straddling, keeping the expected count exact.
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
  // and a timing bound is load-dependent on a shared machine. Every framed tile is new, so the framing session asks
  // the host to bring each one into the cache exactly once.
  const originalLoad = tiles.load.bind(tiles);
  let framedGets = 0;
  tiles.load = ((canvasId: string, x: number, y: number, level?: number) => {
    if (canvasId === `${big.id}-framed`) framedGets++;
    return originalLoad(canvasId, x, y, level);
  }) as typeof tiles.load;
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
Deno.test('framing: giant sparse bounds stop at the candidate limit without traversing the full grid', async () => {
  const db = new MemoryKV(), tiles = new TileStore(db, 512, 1024), source = reference();
  await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const giant: CanvasMeta = {
    ...meta,
    id: 'giant-sparse',
    bounds: { x: 2, y: 2, width: 52_000_000, height: 52_000_000 },
    tileCount: 1,
  };
  let reason: string | undefined;
  let checkpoints = 0;
  const result = await buildFramedCanvas(db, tiles, giant, region, [region], async () => {
    checkpoints++;
  }, {
    maxTiles: 64,
    onSkipped: (r) => {
      reason = r;
    },
  });
  assertEquals(result, undefined);
  assert(reason?.includes('64'), `expected reason to name the 64-tile limit, got: ${reason}`);
  // The plan is bounded by maxTiles and made in one engine step; the skip comes before any output tile starts, so no
  // per-tile checkpoint runs.
  assertEquals(checkpoints, 0, `expected the skip before any output tile, got ${checkpoints} checkpoints`);
  assertEquals(await countPrefix(db, `tile/${giant.id}-framed/`), 0);
  assertEquals(await countPrefix(db, `tile-index/${giant.id}-framed/`), 0);
});

Deno.test('framing: a crop constrains the pane without swallowing fixed chrome on its other axis', async () => {
  const source = reference();
  // Cropping one axis is independent of the fixed toolbar/sidebar boundary on the other axis.
  for (
    const crop of [
      { x: 3, y: 0, width: 6, height: 10 },
      { x: 0, y: 3, width: 12, height: 4 },
    ]
  ) {
    const cropped = { ...region, crop };
    const expected = crop.x === 0 ? { x: 2, y: 3, width: 8, height: 4 } : { x: 3, y: 2, width: 6, height: 6 };
    assertEquals(frameLayout(source, cropped, meta).pane, expected);
    const db = new MemoryKV(), tiles = new TileStore(db, 16, 64);
    await paintSourceTile(tiles, meta.id, 0, 0);
    await db.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
    const content = { ...meta, bounds: { ...meta.bounds, width: expected.width } };
    const framed = await buildFramedCanvas(db, tiles, content, cropped, [cropped], async () => {});
    assertEquals(framed?.presentation?.sourceRegion, expected);
    const tile = await tiles.get(framed!.id, 0, 0);
    // The complete header comes from the reference, including the part above the moving pane.
    for (let y = 0; y < expected.y; y++) {
      for (let x = 0; x < source.width; x++) {
        assertEquals([...tile.pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)], [
          ...source.data.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4),
        ]);
      }
    }
    tiles.free();
  }
});
