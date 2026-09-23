import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { Compositor } from '../../src/core/compositor.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { covered, markCovered, pngTileCodec, type StoredTile, tileKey, TileStore } from '../../src/storage/tiles.ts';
import type { CanvasMeta, Diagnostic, Placement, Region, RGBA } from '../../src/types.ts';

const size = 16;
const footprint = [0, 1, 2, 3].map((x) => ({ x, y: 0 }));

function image(): RGBA {
  const data = new Uint8ClampedArray(64 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 64; x++) {
      data.set([(x * 17 + y) & 255, (y * 19 + x) & 255, (x + y * 3) & 255, 255], (y * 64 + x) * 4);
    }
  }
  return { width: 64, height: 16, data };
}

function region(): Region {
  return { id: 'r', name: 'r', kind: 'moving', rect: { x: 0, y: 0, width: 64, height: 16 } };
}

function placement(frame: number): Placement {
  return { layer: 'r', canvasId: 'c', node: 'n', x: 0, y: 0, confidence: 1, uncertain: false, time: frame };
}

function meta(): CanvasMeta {
  return {
    id: 'c',
    layer: 'r',
    name: 'c',
    kind: 'moving',
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    tileCount: 0,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: 0,
    firstTime: 0,
    lastTime: 0,
  };
}

function referenceDecodeCount(passes: number, capacity: number): { decoded: number; evictions: number } {
  const resident: string[] = [];
  let decoded = 0, evictions = 0;
  for (let pass = 0; pass <= passes; pass++) {
    for (const { x, y } of footprint) {
      const key = `${x},${y}`, hit = resident.indexOf(key);
      if (hit >= 0) {
        resident.splice(hit, 1);
      } else {
        if (resident.length >= capacity) {
          resident.shift();
          evictions++;
        }
        if (pass > 0) decoded++;
      }
      resident.push(key);
    }
  }
  return { decoded, evictions };
}

/** Reference the old raster traversal, including the same bounded LRU admission policy. */
async function rasterReferenceFrame(tiles: TileStore, source: RGBA): Promise<void> {
  for (const { x: tx, y: ty } of footprint) {
    const tile = await tiles.get('c', tx, ty);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = ((ty * size + y) * source.width + tx * size + x) * 4;
        const dst = (y * size + x) * 4;
        tile.pixels.set(source.data.subarray(src, src + 4), dst);
        markCovered(tile, dst / 4);
      }
    }
    tile.owner[0] = 1;
    tile.quality[0] = 255;
    tile.dirty = true;
  }
}

async function snapshot(
  db: MemoryKV,
): Promise<{ pixels: number[]; coverage: number[]; owner: number[]; quality: number[]; conflicts: number[]; provisional: number[] }[]> {
  const out: { pixels: number[]; coverage: number[]; owner: number[]; quality: number[]; conflicts: number[]; provisional: number[] }[] =
    [];
  for (const { x, y } of footprint) {
    const stored = await db.get<StoredTile>(`tile/${tileKey('c', 0, x, y)}`);
    assert(stored, `reference and optimized runs should persist tile ${x},${y}`);
    const pixels = await pngTileCodec.decode(stored.blob, size);
    out.push({
      pixels: [...pixels],
      coverage: [...(stored.coverage || [])],
      owner: [...(stored.owner || [])],
      quality: [...(stored.quality || [])],
      conflicts: [...(stored.conflicts || [])],
      provisional: [...(stored.provisional || [])],
    });
  }
  return out;
}

Deno.test('compositor: resident-first traversal preserves raster pixels while reducing repeated LRU decodes', async () => {
  const source = image(), r = region(), atlas = new RegionAtlas([r], source.width, source.height);
  const optimizedDb = new MemoryKV(), optimizedTiles = new TileStore(optimizedDb, size, 1);
  const referenceDb = new MemoryKV(), referenceTiles = new TileStore(referenceDb, size, 1);
  // Keep the production memory formula untouched; this is a deliberately small fixed cache for a deterministic test.
  optimizedTiles.maxTiles = referenceTiles.maxTiles = 3;
  const optimized = new Compositor(optimizedDb, optimizedTiles, 'stable', async () => {}, atlas);
  const optimizedMeta = meta();
  const passes = 5;
  const first = await optimized.add(source, r, placement(0), 0, optimizedMeta);
  await rasterReferenceFrame(referenceTiles, source);
  for (let frame = 1; frame <= passes; frame++) {
    await optimized.add(source, r, placement(frame), frame, optimizedMeta);
    await rasterReferenceFrame(referenceTiles, source);
  }
  await optimizedTiles.flush();
  await referenceTiles.flush();

  const expected = referenceDecodeCount(passes, 3);
  const optimizedSnapshot = await snapshot(optimizedDb);
  const referenceSnapshot = await snapshot(referenceDb);
  assertEquals(optimizedSnapshot, referenceSnapshot, 'cache scheduling must not change persisted pixels or coverage');
  assertEquals(first.added, 64 * 16);
  assertEquals(first.tiles, 4);
  assertEquals(optimizedMeta.observedPixels, 64 * 16);
  assertEquals(optimizedTiles.maxTiles, 3);
  assertEquals(optimizedTiles.decodedTiles, passes, 'resident-first should reload only one cold tile per repeated pass');
  assertEquals(optimizedTiles.evictions, passes + 1);
  assertEquals(referenceTiles.decodedTiles, expected.decoded, 'the raster-order comparator should miss every tile per repeat');
  assertEquals(referenceTiles.evictions, expected.evictions);
  assert(optimizedTiles.decodedTiles < referenceTiles.decodedTiles);
  assert(optimizedTiles.evictions < referenceTiles.evictions);
  for (const { x, y } of footprint) {
    const tile = await optimizedTiles.get('c', x, y);
    for (let p = 0; p < size * size; p++) assert(covered(tile, p));
  }
});

for (const policy of ['stable', 'latest'] as const) {
  Deno.test(`compositor: cache traversal preserves all evidence and temporal decisions (${policy})`, async () => {
    class RasterOrderTiles extends TileStore {
      override isResident(): boolean {
        return false;
      }
    }
    const width = 128, height = 64;
    const r: Region = { ...region(), rect: { x: 0, y: 0, width, height } };
    const atlas = new RegionAtlas([r], width, height);
    const run = (rasterOrder: boolean) => {
      const db = new MemoryKV(), tiles = rasterOrder ? new RasterOrderTiles(db, 32, 1) : new TileStore(db, 32, 1);
      tiles.maxTiles = 3;
      const diagnostics: Diagnostic[] = [], canvas = meta();
      const compositor = new Compositor(db, tiles, policy, async (d) => {
        diagnostics.push(d);
      }, atlas);
      return { db, tiles, compositor, diagnostics, canvas };
    };
    const cached = run(false), raster = run(true);
    for (let frame = 0; frame < 8; frame++) {
      const data = new Uint8ClampedArray(width * height * 4), consistent = new Uint8Array(width * height).fill(1);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x, changed = frame >= 2 && (x < 48 || x >= 80 || frame >= 4);
          data.set([changed ? 220 : 30, (x * 11 + y * 3) & 255, changed ? 25 : 180, 255], p * 4);
          if (frame === 0 && p % 5 === 0 || frame === 3 && x < 16) consistent[p] = 0;
        }
      }
      const p: Placement = {
        ...placement(frame),
        x: frame >= 6 ? -15.6 : -31.6,
        y: -31.6,
        uncertain: frame === 1,
        occlusions: frame === 3 ? [{ x: 16, y: 16, width: 8, height: 16 }] : undefined,
      };
      const source = { width, height, data };
      const expected = await raster.compositor.add(source, r, p, frame, raster.canvas, consistent);
      const actual = await cached.compositor.add(source, r, p, frame, cached.canvas, consistent);
      assertEquals(actual, expected, `frame ${frame} counters`);
      assertEquals(cached.canvas, raster.canvas, `frame ${frame} canvas`);
      assertEquals(cached.diagnostics, raster.diagnostics, `frame ${frame} temporal decisions`);
    }
    for (const result of [cached, raster]) {
      await result.compositor.flush();
      await result.tiles.flush();
    }
    const rows = async (db: MemoryKV) => {
      const result = [];
      for (const [key, value] of [...db.data].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith('tile/')) {
          const tile = value as StoredTile;
          result.push({ key, value: { ...tile, blob: new Uint8Array(await tile.blob.arrayBuffer()) } });
        } else {
          result.push({ key, value });
        }
      }
      return result;
    };
    assert(cached.diagnostics.length > 0, 'exercise temporal conflicts, not just stable pixel copying');
    assertEquals(await rows(cached.db), await rows(raster.db), 'PNG, evidence, index and temporal records');
  });
}
