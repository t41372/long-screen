/** Byte-exact parity between the Rust core (`rust/core/src/framing.rs`) and the frozen TS oracle it replaces
 *  (`tests/support/reference/framing.ts`). Production calls the core only (`src/core/framing.ts`). */
import { assertEquals } from '@std/assert';
import '../../support/core.ts';
import { frameCoordinate, frameLayout } from '../../../src/core/framing.ts';
import { buildFramedCanvas } from '../../../src/core/framing.ts';
import { referenceBuildFramedCanvas, referenceFrameCoordinate, referenceFrameLayout } from '../../support/reference/framing.ts';
import { encodeRGBA } from '../../../src/codec/png.ts';
import { iterate, MemoryKV } from '../../../src/storage/db.ts';
import { markCovered, TileStore } from '../../../src/storage/tiles.ts';
import type { CanvasMeta, Region, RGBA } from '../../../src/types.ts';
import { rng } from '../../../src/core/math.ts';
import { markProvisional } from '../../support/tile-bits.ts';

function makeSource(width: number, height: number, seed: number): RGBA {
  const data = new Uint8ClampedArray(width * height * 4), rnd = rng(seed);
  for (let i = 0; i < width * height; i++) {
    data.set([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255], i * 4);
  }
  return { width, height, data };
}

Deno.test('parity: frameLayout/frameCoordinate match the frozen TS geometry over randomized panes, including negative-index background extensions', () => {
  const rnd = rng(0x51a7e);
  for (let t = 0; t < 60; t++) {
    const sourceWidth = 20 + Math.floor(rnd() * 40), sourceHeight = 15 + Math.floor(rnd() * 40);
    // A small pane far inside a much larger reconstructed-content bounding box: `dx`/`dy` end up larger than
    // `pane.x`/`pane.y`, which is exactly the case where the TS extension-band lookup indexes `bg.rows`/
    // `bg.columns` with a negative number (JS: undefined -> 0) — the trap the Rust port must reproduce.
    const paneW = 2 + Math.floor(rnd() * 6), paneH = 2 + Math.floor(rnd() * 6);
    const region: Region = {
      id: 'p',
      name: 'p',
      kind: 'moving',
      rect: { x: Math.floor(rnd() * (sourceWidth - paneW)), y: Math.floor(rnd() * (sourceHeight - paneH)), width: paneW, height: paneH },
    };
    const boundsWidth = paneW + Math.floor(rnd() * 400), boundsHeight = paneH + Math.floor(rnd() * 400);
    const canvas: CanvasMeta = {
      id: 'c',
      layer: 'p',
      name: 'c',
      kind: 'moving',
      bounds: { x: 0, y: 0, width: boundsWidth, height: boundsHeight },
      tileCount: 1,
      observedPixels: 0,
      uncertainPixels: 0,
      conflictPixels: 0,
      provisionalPixels: 0,
      maxLevel: 0,
      fragment: 0,
      firstTime: 0,
      lastTime: 1,
    };
    const source = makeSource(sourceWidth, sourceHeight, t + 1);
    const layout = frameLayout(source, region, canvas), expected = referenceFrameLayout(source, region, canvas);
    assertEquals(layout, expected, `layout seed ${t}`);
    for (let s = 0; s < 40; s++) {
      const x = Math.floor(rnd() * layout.width) - Math.floor(rnd() * 3), y = Math.floor(rnd() * layout.height) - Math.floor(rnd() * 3);
      assertEquals(frameCoordinate(layout, x, y), referenceFrameCoordinate(expected, x, y), `coordinate seed ${t} (${x},${y})`);
    }
  }
});

async function countPrefix(db: MemoryKV, prefix: string): Promise<number> {
  let n = 0;
  for await (const _row of iterate(db, prefix)) n++;
  return n;
}
async function snapshotAll(db: MemoryKV, prefix: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for await (const row of iterate(db, prefix)) {
    // deno-lint-ignore no-explicit-any
    const value = row.value as any;
    // `Blob` objects are never structurally equal by identity; compare the PNG bytes it wraps instead.
    out[row.key] = value?.blob instanceof Blob ? { ...value, blob: new Uint8Array(await value.blob.arrayBuffer()) } : value;
  }
  return out;
}
/** Deep-compares two KV snapshots byte-exactly, including typed-array contents (structural equality alone would
 *  pass two different-length or different-byte typed arrays as "objects", which is not what a byte-exact port
 *  needs verified). */
function assertSnapshotsEqual(a: Record<string, unknown>, b: Record<string, unknown>, what: string): void {
  assertEquals(Object.keys(a).sort(), Object.keys(b).sort(), `${what}: same keys`);
  for (const key of Object.keys(a)) {
    assertEquals(normalize(a[key]), normalize(b[key]), `${what}: ${key}`);
  }
}
// deno-lint-ignore no-explicit-any
function normalize(v: any): unknown {
  if (v && ArrayBuffer.isView(v)) return { $typed: v.constructor.name, values: Array.from(v as unknown as ArrayLike<number>) };
  if (v && typeof v === 'object' && !(v instanceof Blob)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (k !== 'touched') out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

/** One realistic run of both the frozen TS oracle and the Rust-backed `buildFramedCanvas` against separate
 *  stores seeded identically, diffing every persisted `tile/`, `tile-index/` and `canvas/` row. Framing is not
 *  exercised by any of the 24 fingerprint scenarios (`settings.framing` never reaches `'context'` there), so
 *  this whole-function diff is this port's end-to-end oracle. */
async function compareRun(
  build: (db: MemoryKV, tiles: TileStore) => Promise<{ sourceMeta: CanvasMeta; region: Region; regions: Region[]; source: RGBA }>,
) {
  const dbA = new MemoryKV(), tilesA = new TileStore(dbA, 32, 64);
  const { sourceMeta, region, regions, source } = await build(dbA, tilesA);
  await dbA.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const framedA = await referenceBuildFramedCanvas(dbA, tilesA, sourceMeta, region, regions, async () => {});

  const dbB = new MemoryKV(), tilesB = new TileStore(dbB, 32, 64);
  await build(dbB, tilesB);
  await dbB.put('frame-reference', { frame: 0, image: new Blob([await encodeRGBA(source)]) });
  const framedB = await buildFramedCanvas(dbB, tilesB, sourceMeta, region, regions, async () => {});

  assertEquals(!!framedA, !!framedB, 'both or neither produce a framed canvas');
  if (!framedA) return;
  assertSnapshotsEqual(
    normalize({ x: framedA }) as Record<string, unknown>,
    normalize({ x: framedB }) as Record<string, unknown>,
    'canvas meta',
  );
  assertSnapshotsEqual(await snapshotAll(dbA, `tile/${framedA.id}/`), await snapshotAll(dbB, `tile/${framedB!.id}/`), 'tile rows');
  assertSnapshotsEqual(
    await snapshotAll(dbA, `tile-index/${framedA.id}/`),
    await snapshotAll(dbB, `tile-index/${framedB!.id}/`),
    'tile-index rows',
  );
  assertEquals(
    await countPrefix(dbA, `tile/${sourceMeta.id}/`),
    await countPrefix(dbB, `tile/${sourceMeta.id}/`),
    'no phantom source tiles on either side',
  );
}

const region: Region = { id: 'pane', name: 'pane', kind: 'moving', rect: { x: 2, y: 2, width: 8, height: 6 }, solid: true };
const baseMeta: CanvasMeta = {
  id: 'world',
  layer: region.id,
  name: 'world',
  kind: 'moving',
  bounds: { x: -3, y: 7, width: 14, height: 12 },
  tileCount: 2,
  observedPixels: 1,
  uncertainPixels: 3,
  conflictPixels: 2,
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

Deno.test('parity: negative-origin content, provisional and block evidence, ignore regions', async () => {
  await compareRun(async (_db, tiles) => {
    const raw = await tiles.get(baseMeta.id, -1, 0), i = 7 * 32 + 13;
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
    const ignored: Region = { id: 'secret', name: 'secret', kind: 'ignore', rect: { x: 0, y: 0, width: 2, height: 2 } };
    return { sourceMeta: baseMeta, region, regions: [region, ignored], source: reference() };
  });
});

Deno.test('parity: a non-tile-aligned offset straddling multiple source tiles carries evidence to the right destination blocks', async () => {
  await compareRun(async (_db, tiles) => {
    const sourceMeta: CanvasMeta = { ...baseMeta, id: 'shifted', bounds: { x: -3, y: 7, width: 96, height: 96 }, tileCount: 2 };
    for (const [sx, sy, px] of [[0, 0, [31, 41, 51]], [1, 0, [61, 71, 81]], [0, 1, [91, 101, 111]]] as [number, number, number[]][]) {
      const raw = await tiles.get(sourceMeta.id, sx, sy), p = 20 * 32 + 20;
      raw.pixels.set([...px, 255], p * 4);
      markCovered(raw, p);
      markProvisional(raw, p);
      raw.quality[3] = 50 + sx + sy;
      raw.score[3] = 0.1 * (sx + sy + 1);
      raw.conflicts[3] = sx;
      raw.owner[3] = 5 + sx + sy;
      raw.frozen[3] = sy;
      raw.dirty = true;
      await tiles.flush();
    }
    return { sourceMeta, region, regions: [region], source: reference() };
  });
});

Deno.test('parity: owner conflict across two contributing source blocks resolves to 0 on both sides', async () => {
  await compareRun(async (_db, tiles) => {
    const sourceMeta: CanvasMeta = { ...baseMeta, id: 'owners', bounds: { x: -3, y: 7, width: 96, height: 96 }, tileCount: 2 };
    for (const [sx, sy, owner] of [[0, 0, 11], [1, 0, 12]] as [number, number, number][]) {
      const raw = await tiles.get(sourceMeta.id, sx, sy), p = 20 * 32 + 31;
      raw.pixels.set([9, 9, 9, 255], p * 4);
      markCovered(raw, p);
      raw.quality[3] = 200;
      raw.score[3] = 1;
      raw.owner[3] = owner;
      raw.dirty = true;
      await tiles.flush();
    }
    return { sourceMeta, region, regions: [region], source: reference() };
  });
});

Deno.test('parity: sparse source content with a large content rect matches tile-for-tile', async () => {
  await compareRun(async (_db, tiles) => {
    const sparse: CanvasMeta = { ...baseMeta, id: 'sparse', bounds: { x: 2, y: 2, width: 800, height: 800 }, tileCount: 2 };
    for (const [sx, sy] of [[2, 3], [18, 19]] as [number, number][]) {
      const t = await tiles.get(sparse.id, sx, sy);
      t.pixels.fill(200);
      for (let i = 0; i < t.pixels.length / 4; i++) markCovered(t, i);
      t.dirty = true;
      await tiles.save(t);
    }
    return { sourceMeta: sparse, region, regions: [region], source: reference() };
  });
});
