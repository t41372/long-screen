import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { core } from '../../src/core/wasm.ts';
import { iterate, type KV, MemoryKV } from '../../src/storage/db.ts';
import {
  countCovered,
  covered,
  markCovered,
  pngTileCodec,
  provisional,
  QUALITY_BLOCK,
  type StoredTile,
  type TileIndex,
  tileKey,
  TileStore,
} from '../../src/storage/tiles.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { Compositor } from '../../src/core/compositor.ts';
import type { CanvasMeta, Diagnostic, Placement, Rect, Region, RGBA } from '../../src/types.ts';
type RGB4 = [number, number, number, number];
/** Former src/core/compositor.ts export with no production caller left: compares
 *  block membership, not only a bounding box or cardinality. Kept here only for this test. */
function sameBlockSet(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(([x, y]) => `${x},${y}`));
  return keys.size === b.length && b.every(([x, y]) => keys.has(`${x},${y}`));
}
function solid(width: number, height: number, color: RGB4): RGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  return { width, height, data };
}
function paintRect(image: RGBA, rect: Rect, color: RGB4): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      image.data.set(color, (y * image.width + x) * 4);
    }
  }
}
function makeRegion(rect: Rect): Region {
  return { id: 'r', name: 'r', kind: 'moving', rect };
}
function makeMeta(): CanvasMeta {
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
function place(x: number, y: number, confidence: number, overrides: Partial<Placement> = {}): Placement {
  return { layer: 'r', canvasId: 'c', node: 'n', x, y, confidence, uncertain: false, time: 0, ...overrides };
}
// atlas (src/core/layers.ts's RegionAtlas) owns a core-resident buffer nothing else frees; callers that want to
// clean it up (test hygiene — no assertion depends on this) can call the returned dispose().
function setup(regions: Region[], width: number, height: number, tileSize = 32, policy: 'stable' | 'latest' = 'stable') {
  const db = new MemoryKV(), tiles = new TileStore(db, tileSize, 8), diagnostics: Diagnostic[] = [];
  const atlas = new RegionAtlas(regions, width, height);
  const compositor = new Compositor(db, tiles, policy, async (d) => {
    diagnostics.push(d);
  }, atlas);
  return { db, tiles, atlas, compositor, diagnostics, dispose: () => atlas.dispose() };
}
const B = QUALITY_BLOCK;
Deno.test('compositor: an 8px-wide pane upgrades pixels/quality/owner on a higher-confidence pass (F8)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 8, height: 16 });
  const { tiles, compositor } = setup([region], 64, 32, 32);
  const meta = makeMeta();
  await compositor.add(solid(64, 32, [100, 100, 100, 255]), region, place(0, 0, 0.5), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 1);
  assertEquals(tile.quality[0], 128);
  const img1 = solid(64, 32, [100, 100, 100, 255]);
  paintRect(img1, { x: 0, y: 0, width: 8, height: 16 }, [110, 110, 110, 255]);
  await compositor.add(img1, region, place(0, 0, 0.9), 1, meta);
  tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 2, 'a narrow pane must not stick a block at first-seen owner forever');
  assertEquals(tile.quality[0], 230);
  assertEquals([...tile.pixels.subarray(0, 4)], [110, 110, 110, 255]);
});
Deno.test('compositor: an unaligned world offset (x=8) upgrades both straddled blocks (F8)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 64, 32, 32);
  const meta = makeMeta();
  await compositor.add(solid(64, 32, [50, 50, 50, 255]), region, place(8, 0, 0.4), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 1);
  assertEquals(tile.owner[1], 1);
  const img1 = solid(64, 32, [50, 50, 50, 255]);
  // Native/source coordinates are world coordinates minus the placement offset: paint region.rect itself.
  paintRect(img1, { x: 0, y: 0, width: 16, height: 16 }, [60, 60, 60, 255]);
  await compositor.add(img1, region, place(8, 0, 0.95), 1, meta);
  tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 2, 'block straddled at the tile-local left edge must upgrade');
  assertEquals(tile.owner[1], 2, 'block straddled at the tile-local right edge must upgrade');
  assertEquals(tile.quality[0], Math.round(0.95 * 255));
  assertEquals(tile.quality[1], Math.round(0.95 * 255));
});
Deno.test('compositor: fractional poses use one rounded raster origin for bounds and pixels', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 32, 32, 32);
  const meta = makeMeta();
  await compositor.add(solid(32, 32, [71, 72, 73, 255]), region, place(0.6, -0.4, 0.8), 0, meta);
  assertEquals(meta.bounds, { x: 1, y: 0, width: 16, height: 16 });
  const tile = await tiles.get('c', 0, 0), offset = (1 * 32 + 1) * 4;
  assertEquals([...tile.pixels.subarray(offset, offset + 4)], [71, 72, 73, 255]);
  assertEquals(countCovered(tile.coverage), 16 * 16);
});
Deno.test('compositor: a viewport edge that occludes the remainder of a block refuses replacement (F8)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 32, 32, 32);
  const meta = makeMeta();
  await compositor.add(solid(32, 32, [80, 80, 80, 255]), region, place(0, 0, 0.5), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 1);
  assertEquals(tile.quality[0], 128);
  const img1 = solid(32, 32, [80, 80, 80, 255]);
  paintRect(img1, { x: 0, y: 0, width: 16, height: 8 }, [90, 90, 90, 255]);
  const occlusions: Rect[] = [{ x: 0, y: 8, width: 32, height: 8 }];
  await compositor.add(img1, region, place(0, 0, 0.95, { occlusions }), 1, meta);
  tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 1, 'partial visibility must not replace an already-owned block');
  assertEquals(tile.quality[0], 128);
  assertEquals([...tile.pixels.subarray(0, 4)], [80, 80, 80, 255], 'unreplaced pixels keep their first-seen color');
});
Deno.test('compositor: an L-shaped conflict leaves the pixel-identical concave-corner block untouched (F9+F12)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 48, height: 48 });
  const { tiles, db, compositor } = setup([region], 64, 64, 64);
  const meta = makeMeta();
  const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
  await compositor.add(solid(64, 64, base), region, place(0, 0, 0.6), 0, meta);
  const img1 = solid(64, 64, base);
  const lShape: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]];
  for (const [bx, by] of lShape) {
    paintRect(img1, { x: bx * B, y: by * B, width: B, height: B }, hot);
  }
  const stats = await compositor.add(img1, region, place(0, 0, 0.6), 1, meta);
  const tile = await tiles.get('c', 0, 0);
  const q = (bx: number, by: number) => by * (64 / B) + bx;
  for (const [bx, by] of lShape) {
    assertEquals(tile.conflicts[q(bx, by)], 1, `L block (${bx},${by}) should be flagged conflicted`);
    assertEquals(tile.frozen[q(bx, by)], 1, `L block (${bx},${by}) should be frozen`);
    assertEquals(tile.owner[q(bx, by)], 2, `L block (${bx},${by}) should now be owned by the second frame`);
  }
  assertEquals(tile.conflicts[q(2, 0)], 0, 'the concave-corner block must not be flagged as conflict');
  assertEquals(tile.frozen[q(2, 0)], 0, 'the concave-corner block must not be frozen');
  assertEquals(tile.owner[q(2, 0)], 1, 'the concave-corner block keeps the first frame as owner');
  await compositor.flush();
  const temporal = await db.scan('temporal/c/', { limit: 10 });
  assertEquals(temporal.length, 1);
  // F8/F12 regression: overwritePatch's conflictPixels must fold into stats.conflicts as PIXELS, not as a BLOCK
  // count. The whole L (5 blocks × 256px) is fully visible in this one call, so it both (a) flags as conflicted
  // inline — 256 mismatching pixels per block — and (b) is immediately resolved by overwritePatch, which then
  // rewrites all 5×256 pixels of those same blocks. Before the fix this second term was a bare block count (5),
  // not 1280; a regression back to counting blocks would report 1285 here instead of 2560.
  assertEquals(stats.conflicts, 2560, 'stats.conflicts must count pixels overwritePatch touched, not blocks');
  assertEquals(meta.conflictPixels, 2560);
});
Deno.test('compositor: disjoint conflict components merge into one record with a full mask when bridged, no orphan (F9+F12)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 112, height: 16 });
  const { db, compositor } = setup([region], 112, 16, 128);
  const meta = makeMeta();
  const base: RGB4 = [40, 40, 40, 255], hot: RGB4 = [220, 20, 20, 255];
  await compositor.add(solid(112, 16, base), region, place(0, 0, 0.5), 0, meta);
  const img1 = solid(112, 16, base);
  paintRect(img1, { x: 0, y: 0, width: 32, height: 16 }, hot);
  paintRect(img1, { x: 80, y: 0, width: 32, height: 16 }, hot);
  await compositor.add(img1, region, place(0, 0, 0.5), 1, meta);
  await compositor.flush();
  const afterFrame1 = await db.scan('temporal/c/', { limit: 10 });
  assertEquals(afterFrame1.length, 2, 'two disjoint components produce two records');
  const img2 = solid(112, 16, base);
  paintRect(img2, { x: 0, y: 0, width: 32, height: 16 }, hot);
  paintRect(img2, { x: 80, y: 0, width: 32, height: 16 }, hot);
  paintRect(img2, { x: 32, y: 0, width: 48, height: 16 }, hot);
  await compositor.add(img2, region, place(0, 0, 0.5), 2, meta);
  await compositor.flush();
  const afterFrame2 = await db.scan<{ blocks: [number, number][]; rect: Rect }>('temporal/c/', { limit: 10 });
  assertEquals(afterFrame2.length, 1, 'the bridging component merges both prior records, leaving no orphan');
  assertEquals(afterFrame2[0].value.blocks.length, 7);
  assertEquals(afterFrame2[0].value.rect, { x: 0, y: 0, width: 112, height: 16 });
});
Deno.test('compositor: a genuine quality-0 block is never raised by a later uncertain, unresolved observation (F11)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 16, 16, 32);
  const meta = makeMeta();
  // NONFINITE_POSE-style placement: confidence 0, not skipped.
  await compositor.add(solid(16, 16, [60, 60, 60, 255]), region, place(0, 0, 0), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[0], 1);
  assertEquals(tile.quality[0], 0);
  const img1 = solid(16, 16, [60, 60, 60, 255]);
  paintRect(img1, { x: 0, y: 0, width: 16, height: 14 }, [250, 5, 5, 255]);
  // Occlude the remainder so the temporal patch can never resolve and overwritePatch cannot touch this block.
  const occlusions: Rect[] = [{ x: 0, y: 14, width: 16, height: 2 }];
  await compositor.add(img1, region, place(0, 0, 0.9, { uncertain: true, occlusions }), 1, meta);
  tile = await tiles.get('c', 0, 0);
  assertEquals(tile.quality[0], 0, 'quality 0 must not be raised by an uncertain observation');
  assertEquals(tile.owner[0], 1);
});
Deno.test('compositor: coverage bits, observedPixels and tileCount stay consistent through a temporal overwrite (F10)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 48, height: 48 });
  const { tiles, db, compositor } = setup([region], 64, 64, 64);
  const meta = makeMeta();
  const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
  await compositor.add(solid(64, 64, base), region, place(0, 0, 0.6), 0, meta);
  const img1 = solid(64, 64, base);
  for (const [bx, by] of [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] as [number, number][]) {
    paintRect(img1, { x: bx * B, y: by * B, width: B, height: B }, hot);
  }
  await compositor.add(img1, region, place(0, 0, 0.6), 1, meta);
  await tiles.flush();
  let observed = 0, tileCount = 0;
  for await (const { value: idx } of iterate<TileIndex>(db, 'tile-index/c/0/')) {
    const stored = await db.get<StoredTile>(`tile/c/0/${idx.x}_${idx.y}`);
    assert(stored);
    observed += countCovered(stored!.coverage);
    tileCount++;
  }
  assertEquals(observed, meta.observedPixels);
  assertEquals(tileCount, meta.tileCount);
});
Deno.test('compositor: TEMPORAL_OR_ALIGNMENT_CONFLICT reports the component bounds, not the whole pane (F12)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 96, height: 16 });
  const { compositor, diagnostics } = setup([region], 96, 16, 32);
  const meta = makeMeta();
  const base: RGB4 = [70, 70, 70, 255], hot: RGB4 = [250, 5, 5, 255];
  await compositor.add(solid(96, 16, base), region, place(0, 0, 0.5), 0, meta);
  const img1 = solid(96, 16, base);
  paintRect(img1, { x: 32, y: 0, width: 32, height: 16 }, hot);
  await compositor.add(img1, region, place(0, 0, 0.5), 1, meta);
  const diag = diagnostics.find((d) => d.code === 'TEMPORAL_OR_ALIGNMENT_CONFLICT');
  assert(diag, 'expected a TEMPORAL_OR_ALIGNMENT_CONFLICT diagnostic');
  assertEquals(diag!.region, { x: 32, y: 0, width: 32, height: 16 });
});
Deno.test('compositor: add() rejects a frame whose dimensions do not match the region atlas (F-guard)', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { compositor } = setup([region], 32, 32, 32);
  const meta = makeMeta();
  await assertRejects(() => compositor.add(solid(16, 16, [1, 2, 3, 255]), region, place(0, 0, 0.5), 0, meta), Error, 'region atlas is');
});
Deno.test('compositor: a region rect larger than the captured frame skips rows/cols the frame never observed, on both axes', async () => {
  // The region rect describes a place on the persistent canvas, which can be far larger than any single captured
  // frame (`image`, always atlas-sized). A block straddling the frame's own edge must count and write only its
  // in-bounds half; a block entirely beyond the frame on both axes must never be touched at all.
  const region = makeRegion({ x: 0, y: 0, width: 56, height: 56 });
  const { tiles, compositor } = setup([region], 40, 40, 64);
  const meta = makeMeta();
  const stats = await compositor.add(solid(40, 40, [80, 80, 80, 255]), region, place(0, 0, 0.5), 0, meta);
  assertEquals(stats.added, 40 * 40, 'only pixels the 40×40 frame actually has must be counted, not the 56×56 region rect');
  const tile = await tiles.get('c', 0, 0);
  assertEquals(tile.owner[2], 1, 'a block straddling the frame width edge must still write its in-bounds half');
  assertEquals(tile.owner[8], 1, 'a block straddling the frame height edge must still write its in-bounds half');
  assertEquals(tile.owner[15], 0, 'a block entirely beyond the frame on both axes must never be touched');
});
// --- World-consistency mask (docs/ARCHITECTURE.md §七): Compositor.add()'s `consistent` argument. ---
Deno.test('compositor: a screen-fixed FAB over three frames of a scrolling page ends with 0 FAB pixels and full page coverage', async () => {
  // Region/atlas exactly match one captured frame (16×48): screen y is native/absolute, so a FAB fixed at screen
  // rows [16,32) never moves, while the placement's pose (0, 16, 32 — one clean-zone step per frame) scrolls the
  // page underneath it. Step size equals the clean-zone height on either side of the FAB, so each new frame's own
  // FAB always lands on the PREVIOUS frame's already-good clean_bottom territory (protected by rule (c)) while
  // its own clean_top zone heals the PREVIOUS frame's FAB band (rule (b)) — closing the loop in exactly 3 frames.
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 48 });
  const { tiles, compositor } = setup([region], 16, 48, 128);
  const meta = makeMeta();
  const page: RGB4 = [80, 80, 80, 255], fab: RGB4 = [255, 0, 255, 255];
  const frame = () => {
    const img = solid(16, 48, page);
    paintRect(img, { x: 0, y: 16, width: 16, height: 16 }, fab);
    return img;
  };
  const consistent = () => {
    const c = new Uint8Array(16 * 48).fill(1);
    for (let y = 16; y < 32; y++) for (let x = 0; x < 16; x++) c[y * 16 + x] = 0;
    return c;
  };
  await compositor.add(frame(), region, place(0, 0, 0.9), 0, meta, consistent());
  await compositor.add(frame(), region, place(0, 16, 0.9), 1, meta, consistent());
  await compositor.add(frame(), region, place(0, 32, 0.9), 2, meta, consistent());
  const tile = await tiles.get('c', 0, 0);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 16; x++) {
      const i = y * 128 + x, p = i * 4;
      assert(!!(tile.coverage[i >> 3] & (1 << (i & 7))), `world (${x},${y}) must be covered`);
      assertEquals(
        [tile.pixels[p], tile.pixels[p + 1], tile.pixels[p + 2]],
        page.slice(0, 3),
        `world (${x},${y}) must be page colour, never the FAB's`,
      );
      assert(!provisional(tile, i), `world (${x},${y}) must not still be flagged provisional`);
    }
  }
});
Deno.test('compositor: a placement with no checkable neighbour (consistent-by-default) paints exactly as omitting the mask does', async () => {
  // "No comparison was possible" must still be painted (the 'glimpse' scenario), not treated as a hole or as
  // provisional — an all-1s mask (every pixel defaulted to consistent) must be indistinguishable from passing no
  // mask at all.
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const img = solid(16, 16, [90, 90, 90, 255]);
  const { tiles: tilesA, compositor: compA } = setup([region], 16, 16, 16);
  await compA.add(img, region, place(0, 0, 0.8), 0, makeMeta());
  const tileA = await tilesA.get('c', 0, 0);
  const { tiles: tilesB, compositor: compB } = setup([region], 16, 16, 16);
  const allDefault = new Uint8Array(16 * 16).fill(1);
  await compB.add(img, region, place(0, 0, 0.8), 0, makeMeta(), allDefault);
  const tileB = await tilesB.get('c', 0, 0);
  assertEquals([...tileA.pixels], [...tileB.pixels]);
  assertEquals([...tileA.coverage], [...tileB.coverage]);
  for (let i = 0; i < 16 * 16; i++) {
    assert(!!(tileB.coverage[i >> 3] & (1 << (i & 7))));
    assert(!provisional(tileB, i), 'no comparison was possible, so nothing is flagged provisional');
  }
});
Deno.test('compositor: a provisional pixel is healed by a later consistent observation even inside a frozen block', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 16, 16, 16);
  const meta = makeMeta();
  // Close enough that this pair alone never trips the compositor's own conflict detector (mean |ΔRGB| ≤ 25): this
  // test isolates the per-pixel provisional-heal path (design point b) from the temporal-conflict/resolveTemporal
  // path (design point e), which is covered separately by the "inconsistent observation never overwrites" test below.
  const bad: RGB4 = [90, 90, 90, 255], good: RGB4 = [100, 100, 100, 255];
  const allBad = new Uint8Array(16 * 16).fill(0);
  await compositor.add(solid(16, 16, bad), region, place(0, 0, 0.5), 0, meta, allBad);
  let tile = await tiles.get('c', 0, 0);
  for (let i = 0; i < 256; i++) {
    assert(provisional(tile, i), 'a fresh, inconsistent pixel must be marked provisional');
  }
  assertEquals(tile.conflicts[0], 0, 'a sub-threshold colour difference alone must not trigger a temporal conflict');
  // Freeze the block directly, simulating an earlier stable-policy temporal-conflict resolution having already
  // chosen and locked this moment — frozen protects against RE-CHOOSING a moment, not against fixing transient
  // screen-chrome garbage a world-consistency check flagged.
  tile.frozen[0] = 1;
  tile.dirty = true;
  await tiles.save(tile);
  const allGood = new Uint8Array(16 * 16).fill(1);
  await compositor.add(solid(16, 16, good), region, place(0, 0, 0.9), 1, meta, allGood);
  tile = await tiles.get('c', 0, 0);
  assertEquals([...tile.pixels.subarray(0, 4)], good, 'a consistent observation must heal a provisional pixel despite the frozen block');
  for (let i = 0; i < 256; i++) {
    assert(!provisional(tile, i), 'healed pixels must have their provisional bit cleared');
  }
  assertEquals(tile.quality[0], 230, 'healing the last provisional bit must restore the corroborated quality');
  assertEquals(
    tile.frozen[0],
    1,
    'frozen stays set: healing a provisional pixel does not unfreeze the block for ordinary replace purposes',
  );
});
Deno.test('compositor: temporal block equality compares membership, not only bbox and count', () => {
  const left: [number, number][] = [[0, 0], [0, 1], [1, 1]];
  const right: [number, number][] = [[0, 0], [1, 0], [1, 1]];
  assert(!sameBlockSet(left, right), 'same cardinality and bounding box can still describe different masks');
  assert(sameBlockSet(left, [...left].reverse()));
});
Deno.test('compositor: an inconsistent observation never overwrites an already-covered consistent pixel, even under a qualifying replace', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 16, 16, 16);
  const meta = makeMeta();
  // Close enough to stay under the conflict threshold, so `replace` is genuinely eligible on confidence alone
  // (0.99 vs 0.90 clears the score > previous + 4 margin) — the only thing standing between the second, higher-
  // confidence observation and an overwrite is that it is flagged inconsistent.
  const good: RGB4 = [100, 100, 100, 255], bad: RGB4 = [120, 100, 100, 255];
  await compositor.add(solid(16, 16, good), region, place(0, 0, 0.9), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  assertEquals([...tile.pixels.subarray(0, 4)], good);
  const allBad = new Uint8Array(16 * 16).fill(0);
  await compositor.add(solid(16, 16, bad), region, place(0, 0, 0.99), 1, meta, allBad);
  tile = await tiles.get('c', 0, 0);
  assertEquals(
    [...tile.pixels.subarray(0, 4)],
    good,
    'an inconsistent observation must never overwrite already-covered consistent content',
  );
  for (let i = 0; i < 256; i++) {
    assert(!provisional(tile, i), 'a rejected inconsistent write must not leave the untouched, already-good pixel flagged provisional');
  }
});
Deno.test('compositor: a rejected observation that is bit-identical to the covered pixel demotes it to provisional', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 16, height: 16 });
  const { tiles, compositor } = setup([region], 16, 16, 16);
  const meta = makeMeta();
  // The burn-in this closes (docs/ARCHITECTURE.md §七): a screen overlay's FIRST look at a world position is often
  // the one that paints it — nothing is covered yet, and the ±1-frame check has nothing to compare against at a
  // leading edge (or agrees, because the neighbour is under the same overlay) — so the pixel lands unflagged. The
  // flag arrives a frame or two later, by which time an inconsistent observation is barred from overwriting covered
  // content. When that rejected observation shows EXACTLY what is stored, the stored pixel is no better evidence
  // than the observation just rejected, so it is demoted (not overwritten) and a later consistent look can heal it.
  // The shape below is the real one: the page scrolls 8px, so the second (flagged) look repeats the overlay over
  // the half of the block already covered and reveals eight fresh rows above it.
  const overlay: RGB4 = [207, 103, 80, 255], page: RGB4 = [251, 250, 246, 255];
  await compositor.add(solid(16, 16, overlay), region, place(0, 8, 0.9), 0, meta);
  let tile = await tiles.get('c', 0, 0);
  for (let i = 0; i < 128; i++) {
    assert(!covered(tile, i), 'the first look only reaches the lower half of this block');
  }
  const allBad = new Uint8Array(16 * 16).fill(0);
  await compositor.add(solid(16, 16, overlay), region, place(0, 0, 0.9), 1, meta, allBad);
  tile = await tiles.get('c', 0, 0);
  assertEquals(
    [...tile.pixels.subarray(128 * 4, 128 * 4 + 4)],
    overlay,
    'the rejected observation must not overwrite what was already covered',
  );
  for (let i = 0; i < 256; i++) {
    assert(
      provisional(tile, i),
      i < 128
        ? 'a fresh pixel written from a rejected observation is provisional'
        : 'a covered pixel identical to a rejected observation is demoted to provisional',
    );
  }
  const allGood = new Uint8Array(16 * 16).fill(1);
  const stats = await compositor.add(solid(16, 16, page), region, place(0, 0, 0.9), 2, meta, allGood);
  tile = await tiles.get('c', 0, 0);
  assertEquals([...tile.pixels.subarray(128 * 4, 128 * 4 + 4)], page, 'a later consistent observation heals the demoted pixel');
  for (let i = 0; i < 256; i++) {
    assert(!provisional(tile, i), 'healed pixels have their provisional bit cleared');
  }
  assertEquals(stats.provisionalPixels, -256, 'the heal is reported as a net decrease');
});
// Evidence must reach storage whenever it changes in memory. An uncertain observation that agrees with the stored
// pixels (no conflict, no replacement, no pixel write) still lowers the block quality; if that alone does not mark
// the tile dirty, whether the lower quality is ever persisted depends on whether some later write happens to dirty
// the tile before a checkpoint flush or eviction — i.e. on timing. (Found as a run-to-run difference in the stored
// quality of the same two e.mov tiles.)
Deno.test('compositor: a quality-only change marks the tile dirty, so flushed evidence always matches memory', async () => {
  const region = makeRegion({ x: 0, y: 0, width: 32, height: 32 });
  const { db, tiles, compositor } = setup([region], 32, 32, 32);
  const meta = makeMeta();
  const page = solid(32, 32, [120, 60, 30, 255]);
  for (let i = 0; i < 32 * 32; i += 3) page.data[i * 4] = 200;
  await compositor.add(page, region, place(0, 0, 0.9), 0, meta);
  await tiles.flush();
  const stored = async () => (await db.get<StoredTile>('tile/c/0/0_0'))!.quality!;
  assertEquals((await stored())[0], Math.round(0.9 * 255));
  // Same content with sub-threshold noise, seen uncertainly and with less confidence: no conflict, no replacement.
  const noisy = { ...page, data: page.data.slice() };
  for (let i = 0; i < 32 * 32; i++) noisy.data[i * 4 + 1] += 4;
  const stats = await compositor.add(noisy, region, place(0, 0, 0.3, { uncertain: true }), 1, meta);
  assertEquals([stats.added, stats.conflicts], [0, 0]);
  const tile = await tiles.get('c', 0, 0);
  assertEquals(tile.quality[0], Math.round(0.3 * 255), 'the uncertain observation lowers quality in memory');
  assertEquals(tile.owner[0], 1, 'and does not take ownership');
  await tiles.flush();
  assertEquals((await stored())[0], tile.quality[0], 'the flushed quality is the in-memory quality');
});
// Moved from cache-traversal.test.ts (misnamed after the mechanism, not the module under test: it's a compositor test).
const CT_SIZE = 16;
const ctFootprint = [0, 1, 2, 3].map((x) => ({ x, y: 0 }));
function ctImage(): RGBA {
  const data = new Uint8ClampedArray(64 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 64; x++) {
      data.set([(x * 17 + y) & 255, (y * 19 + x) & 255, (x + y * 3) & 255, 255], (y * 64 + x) * 4);
    }
  }
  return { width: 64, height: 16, data };
}
function ctRegion(): Region {
  return { id: 'r', name: 'r', kind: 'moving', rect: { x: 0, y: 0, width: 64, height: 16 } };
}
function ctPlacement(frame: number): Placement {
  return { layer: 'r', canvasId: 'c', node: 'n', x: 0, y: 0, confidence: 1, uncertain: false, time: frame };
}
function ctMeta(): CanvasMeta {
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
function ctReferenceDecodeCount(passes: number, capacity: number): { decoded: number; evictions: number } {
  const resident: string[] = [];
  let decoded = 0, evictions = 0;
  for (let pass = 0; pass <= passes; pass++) {
    for (const { x, y } of ctFootprint) {
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
async function ctRasterReferenceFrame(tiles: TileStore, source: RGBA): Promise<void> {
  for (const { x: tx, y: ty } of ctFootprint) {
    const tile = await tiles.get('c', tx, ty);
    for (let y = 0; y < CT_SIZE; y++) {
      for (let x = 0; x < CT_SIZE; x++) {
        const src = ((ty * CT_SIZE + y) * source.width + tx * CT_SIZE + x) * 4;
        const dst = (y * CT_SIZE + x) * 4;
        tile.pixels.set(source.data.subarray(src, src + 4), dst);
        markCovered(tile, dst / 4);
      }
    }
    tile.owner[0] = 1;
    tile.quality[0] = 255;
    tile.dirty = true;
  }
}
async function ctSnapshot(
  db: MemoryKV,
): Promise<{ pixels: number[]; coverage: number[]; owner: number[]; quality: number[]; conflicts: number[]; provisional: number[] }[]> {
  const out: { pixels: number[]; coverage: number[]; owner: number[]; quality: number[]; conflicts: number[]; provisional: number[] }[] =
    [];
  for (const { x, y } of ctFootprint) {
    const stored = await db.get<StoredTile>(`tile/${tileKey('c', 0, x, y)}`);
    assert(stored, `reference and optimized runs should persist tile ${x},${y}`);
    const pixels = await pngTileCodec.decode(stored.blob, CT_SIZE);
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
  const source = ctImage(), r = ctRegion(), atlas = new RegionAtlas([r], source.width, source.height);
  const optimizedDb = new MemoryKV(), optimizedTiles = new TileStore(optimizedDb, CT_SIZE, 1);
  const referenceDb = new MemoryKV(), referenceTiles = new TileStore(referenceDb, CT_SIZE, 1);
  // Keep the production memory formula untouched; this is a deliberately small fixed cache for a deterministic test.
  optimizedTiles.maxTiles = referenceTiles.maxTiles = 3;
  const optimized = new Compositor(optimizedDb, optimizedTiles, 'stable', async () => {}, atlas);
  const optimizedMeta = ctMeta();
  const passes = 5;
  const first = await optimized.add(source, r, ctPlacement(0), 0, optimizedMeta);
  await ctRasterReferenceFrame(referenceTiles, source);
  for (let frame = 1; frame <= passes; frame++) {
    await optimized.add(source, r, ctPlacement(frame), frame, optimizedMeta);
    await ctRasterReferenceFrame(referenceTiles, source);
  }
  await optimizedTiles.flush();
  await referenceTiles.flush();

  const expected = ctReferenceDecodeCount(passes, 3);
  const optimizedSnapshot = await ctSnapshot(optimizedDb);
  const referenceSnapshot = await ctSnapshot(referenceDb);
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
  for (const { x, y } of ctFootprint) {
    const tile = await optimizedTiles.get('c', x, y);
    for (let p = 0; p < CT_SIZE * CT_SIZE; p++) assert(covered(tile, p));
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
    const r: Region = { ...ctRegion(), rect: { x: 0, y: 0, width, height } };
    const atlas = new RegionAtlas([r], width, height);
    const run = (rasterOrder: boolean) => {
      const db = new MemoryKV(), tiles = rasterOrder ? new RasterOrderTiles(db, 32, 1) : new TileStore(db, 32, 1);
      tiles.maxTiles = 3;
      const diagnostics: Diagnostic[] = [], canvas = ctMeta();
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
        ...ctPlacement(frame),
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

// --- Tripwire: pins the exact ORDER flush() persists temporal rows in, across a delete-then-reinsert-shaped
// sequence. JS Map/Set iteration is insertion order; deleting a key never reorders the survivors, and
// re-`.set`-ing an EXISTING key never moves it either (only a delete+fresh-insert of a key would move it to
// the end — and index.records never does that: it always deletes losers with `index.records.delete`, never
// re-adds them under the same key). The Rust index (BTreeMap<seq,Record> + HashMap<id,seq>) must reproduce
// this exactly, not indexmap's swap_remove (which reorders on removal).
/** A KV wrapper that logs every delete()/putMany() call, in call order, so flush()'s row order is directly
 *  observable (db.scan() sorts by key and cannot show call order). */
function spyKV(db: KV): { db: KV; log: string[] } {
  const log: string[] = [];
  const spy: KV = {
    get: (key) => db.get(key),
    put: (key, value) => db.put(key, value),
    putMany: (rowsArg) => {
      log.push(`putMany(${rowsArg.map((r) => r.key).join(',')})`);
      return db.putMany(rowsArg);
    },
    delete: (key) => {
      log.push(`delete(${key})`);
      return db.delete(key);
    },
    deleteMany: (keys) => db.deleteMany(keys),
    scan: (prefix, options) => db.scan(prefix, options),
  };
  return { db: spy, log };
}
Deno.test('compositor: flush() persists temporal rows in exact index insertion/deletion order (tripwire)', async () => {
  // A row of 13 single-block (16px) regions on one 208px-wide tile: blocks 0,4,8,12 each get their own
  // temporal record (A,B,C,D — far enough apart that their ±16px expanded rects never touch each other).
  const width = 13 * B, region = makeRegion({ x: 0, y: 0, width, height: B });
  const raw = new MemoryKV(), { db: spied, log } = spyKV(raw);
  const tiles = new TileStore(spied, width, 8), atlas = new RegionAtlas([region], width, B);
  const compositor = new Compositor(spied, tiles, 'stable', async () => {}, atlas);
  const meta = makeMeta();
  const base: RGB4 = [100, 100, 100, 255], hot1: RGB4 = [250, 10, 10, 255];
  const paintBlocks = (img: RGBA, blocks: number[], color: RGB4) => {
    for (const bx of blocks) paintRect(img, { x: bx * B, y: 0, width: B, height: B }, color);
  };
  const frame = (litBlocks: number[]) => {
    const img = solid(width, B, base);
    paintBlocks(img, litBlocks, hot1);
    return img;
  };
  await compositor.add(frame([]), region, place(0, 0, 0.5), 0, meta); // establishes base coverage, no conflicts
  await compositor.add(frame([0]), region, place(0, 0, 0.5), 1, meta); // record A (id 0000000000)
  await compositor.add(frame([0, 4]), region, place(0, 0, 0.5), 2, meta); // record B (id 0000000001)
  await compositor.add(frame([0, 4, 8]), region, place(0, 0, 0.5), 3, meta); // record C (id 0000000002)
  await compositor.add(frame([0, 4, 8, 12]), region, place(0, 0, 0.5), 4, meta); // record D (id 0000000003)
  await compositor.flush();
  const afterSetup = await raw.scan<{ id: string }>('temporal/c/', { limit: 10 });
  assertEquals(afterSetup.map((r) => r.value.id).sort(), ['0000000000', '0000000001', '0000000002', '0000000003']);
  log.length = 0; // only the frame5/frame6 sequence below is under test
  // Frame 5: a bridge (blocks 4..8, hot3) merges B and C into one record kept at B's id — C is deleted, B is
  // dirty. In the SAME add() call, D's block (12) is repainted (hot4) but — since it neither expands D's
  // geometry nor its membership, and D's existing record is already complete under the 'stable' policy — this
  // does NOT re-choose/overwrite it; D is still marked dirty (index.dirty.add runs unconditionally) even though
  // nothing about its persisted content changes.
  const hot3: RGB4 = [10, 250, 10, 255], hot4: RGB4 = [10, 10, 250, 255];
  const img5 = solid(width, B, base);
  paintBlocks(img5, [0], hot1); // A: unchanged, matches stored — no conflict there
  paintBlocks(img5, [4, 5, 6, 7, 8], hot3); // bridges B (block 4) and C (block 8)
  paintBlocks(img5, [12], hot4); // D: differs, but is frozen/complete and does not expand
  await compositor.add(img5, region, place(0, 0, 0.5), 5, meta);
  // Frame 6: one mega-conflict spanning blocks 0..12 absorbs A, the merged B, and D into a single record kept
  // at A's id. B and D — both still dirty and never flushed — are deleted before ever reaching storage.
  const hot5: RGB4 = [250, 250, 10, 255];
  const img6 = solid(width, B, hot5);
  await compositor.add(img6, region, place(0, 0, 0.5), 6, meta);
  await compositor.flush();
  const ids = { a: '0000000000', b: '0000000001', c: '0000000002', d: '0000000003' };
  assertEquals(
    log,
    [
      `delete(temporal/c/${ids.c})`,
      `delete(temporal/c/${ids.b})`,
      `delete(temporal/c/${ids.d})`,
      `putMany(temporal/c/${ids.a})`,
    ],
    'deletions (C, then B, then D — accumulated across two resolveTemporal calls with no flush between) must ' +
      'precede the single dirty putMany (A only — B and D were deleted before this flush ever saw them dirty)',
  );
  const final = await raw.scan<{ id: string; blocks: [number, number][] }>('temporal/c/', { limit: 10 });
  assertEquals(final.map((r) => r.value.id), [ids.a], 'only the surviving merged record (A) remains persisted');
  assertEquals(final[0].value.blocks.length, 13, 'the final record owns every block 0..12');
});
Deno.test('compositor: a fresh id that collides with a still-loaded KV row overwrites it in place, not append', async () => {
  // temporalSequence always restarts at 0 in a new Compositor instance. If a canvas already has a persisted
  // record at id "0000000000" (typical: the first record any Compositor ever creates) and this Compositor's
  // first-ever new (non-overlapping) temporal record also gets the fresh id pad(0), `index.records.set` clobbers
  // the loaded entry in place (Map.set on an existing key never moves or duplicates it) rather than colliding
  // into a second row.
  const region = makeRegion({ x: 0, y: 0, width: 6 * B, height: B });
  const raw = new MemoryKV();
  const preseeded = {
    id: '0000000000',
    canvasId: 'c',
    rect: { x: 5 * B, y: 0, width: B, height: B }, // far from the conflict below — never overlaps it
    blocks: [[5, 0]],
    chosenFrame: 0,
    chosenTime: 0,
    complete: true,
    revisions: 1,
  };
  await raw.put('temporal/c/0000000000', preseeded);
  const { db: spied, log } = spyKV(raw);
  const tiles = new TileStore(spied, 6 * B, 8), atlas = new RegionAtlas([region], 6 * B, B);
  const compositor = new Compositor(spied, tiles, 'stable', async () => {}, atlas);
  const meta = makeMeta();
  const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
  await compositor.add(solid(6 * B, B, base), region, place(0, 0, 0.5), 0, meta);
  const img1 = solid(6 * B, B, base);
  paintRect(img1, { x: 0, y: 0, width: B, height: B }, hot); // block 0 — far from the preseeded record's block 5
  await compositor.add(img1, region, place(0, 0, 0.5), 1, meta);
  await compositor.flush();
  assertEquals(log, ['putMany(temporal/c/0000000000)'], 'one row rewritten in place — no delete, no second row');
  const rows = await raw.scan<{ rect: Rect }>('temporal/c/', { limit: 10 });
  assertEquals(rows.length, 1, 'the collision overwrites the preseeded row rather than adding a second one');
  assertEquals(rows[0].value.rect, { x: 0, y: 0, width: B, height: B }, "the new record's content replaced the stale preseeded one");
});
Deno.test('compositor: a fresh id that collides with a DELETED id is appended and un-deletes the key, emitting no delete()', async () => {
  // Complements the two tests above: here the fresh id collides with a key that USED to be live but was deleted
  // earlier in the same run (merged away). `index.records.set` on a non-existing key appends at the end of Map
  // iteration order, and `index.deleted.delete(record.id)` removes it from the pending-deletions set — so
  // flush() must never emit a delete() for that key, only a putMany rewriting it with the fresh content.
  const region = makeRegion({ x: 0, y: 0, width: 12 * B, height: B });
  const raw = new MemoryKV();
  // Two adjacent preseeded rows (ids 0 and 1): a conflict spanning both blocks merges them into id 0, deleting id 1.
  await raw.put('temporal/c/0000000000', {
    id: '0000000000',
    canvasId: 'c',
    rect: { x: 0, y: 0, width: B, height: B },
    blocks: [[0, 0]],
    chosenFrame: 0,
    chosenTime: 0,
    complete: true,
    revisions: 1,
  });
  await raw.put('temporal/c/0000000001', {
    id: '0000000001',
    canvasId: 'c',
    rect: { x: B, y: 0, width: B, height: B },
    blocks: [[1, 0]],
    chosenFrame: 0,
    chosenTime: 0,
    complete: true,
    revisions: 1,
  });
  const { db: spied, log } = spyKV(raw);
  const tiles = new TileStore(spied, 12 * B, 8), atlas = new RegionAtlas([region], 12 * B, B);
  const compositor = new Compositor(spied, tiles, 'stable', async () => {}, atlas);
  const meta = makeMeta();
  const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255], hot2: RGB4 = [10, 250, 10, 255], hot3: RGB4 = [10, 10, 250, 255];
  await compositor.add(solid(12 * B, B, base), region, place(0, 0, 0.5), 0, meta);
  // Frame 1: merge blocks 0 and 1 — this deletes id "0000000001" (olds[0] is always id "0000000000").
  const img1 = solid(12 * B, B, base);
  paintRect(img1, { x: 0, y: 0, width: 2 * B, height: B }, hot);
  await compositor.add(img1, region, place(0, 0, 0.5), 1, meta);
  // Frame 2: two disjoint, non-overlapping conflicts (blocks 5 and 9) in one add() call, sorted left-to-right —
  // block 5 gets fresh id pad(0) = "0000000000" (collides with the still-LIVE merged row: in-place clobber,
  // same as the previous test), block 9 gets fresh id pad(1) = "0000000001" (collides with the just-DELETED row).
  const img2 = solid(12 * B, B, base);
  paintRect(img2, { x: 5 * B, y: 0, width: B, height: B }, hot2);
  paintRect(img2, { x: 9 * B, y: 0, width: B, height: B }, hot3);
  await compositor.add(img2, region, place(0, 0, 0.5), 2, meta);
  await compositor.flush();
  assertEquals(
    log,
    ['putMany(temporal/c/0000000000,temporal/c/0000000001)'],
    'no delete() for "0000000001" — the fresh-id collision un-deleted it before this flush ever saw it as pending deletion',
  );
  const rows = await raw.scan<{ id: string; rect: Rect }>('temporal/c/', { limit: 10 });
  assertEquals(rows.map((r) => r.value.id), ['0000000000', '0000000001']);
  assertEquals(rows.find((r) => r.value.id === '0000000001')!.value.rect, { x: 9 * B, y: 0, width: B, height: B });
});
Deno.test("compositor: dispose() before the trailing flush() (render.ts's actual order) persists identical rows to flush() alone", async () => {
  // src/pipeline/render.ts calls `ctx.releaseResidentRenderState()` (-> `Compositor.dispose()`) in its `finally`
  // BEFORE its own trailing `await this.compositor.flush()`. The Rust-resident temporal-index handle is freed by
  // dispose(), so flush() must still produce the exact same persisted rows either way — dispose() drains each
  // canvas's pending dirty/deleted rows into a JS-side stash first (see `Compositor.dispose()`'s doc comment).
  const width = 6 * B, region = makeRegion({ x: 0, y: 0, width, height: B });
  const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
  const run = async (disposeBeforeFlush: boolean) => {
    const db = new MemoryKV(), tiles = new TileStore(db, width, 8), atlas = new RegionAtlas([region], width, B);
    const compositor = new Compositor(db, tiles, 'stable', async () => {}, atlas);
    const meta = makeMeta();
    await compositor.add(solid(width, B, base), region, place(0, 0, 0.5), 0, meta);
    const img1 = solid(width, B, base);
    paintRect(img1, { x: 0, y: 0, width: B, height: B }, hot);
    await compositor.add(img1, region, place(0, 0, 0.5), 1, meta);
    if (disposeBeforeFlush) compositor.dispose();
    await compositor.flush();
    if (!disposeBeforeFlush) compositor.dispose();
    const rows = await db.scan('temporal/c/', { limit: 10 });
    return rows;
  };
  const withDispose = await run(true);
  const withoutDispose = await run(false);
  assertEquals(withDispose, withoutDispose, 'dispose() running before flush() must not change what gets persisted');
  assertEquals(withDispose.length, 1);
});
Deno.test(
  'temporal ABI: ls_temporal_flush_take rejects a wrong count before draining the index',
  async () => {
    // Regression for rust/core/src/abi/temporal.rs::ls_temporal_flush_take, which must check the caller's counts
    // against the index BEFORE calling TemporalIndex::flush_take() (which drains `dirty`/`deleted`): checking
    // after would let a bad count silently lose every dirty/deleted row instead of returning an error with the
    // index unchanged. Reaches Compositor's private per-canvas handle the way this suite already reaches other
    // private state (tests may reach private members through casts).
    const width = B, region = makeRegion({ x: 0, y: 0, width, height: B });
    const db = new MemoryKV(), tiles = new TileStore(db, width, 8), atlas = new RegionAtlas([region], width, B);
    const compositor = new Compositor(db, tiles, 'stable', async () => {}, atlas);
    const meta = makeMeta();
    const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
    await compositor.add(solid(width, B, base), region, place(0, 0, 0.5), 0, meta); // base coverage, no conflict
    const img1 = solid(width, B, base);
    paintRect(img1, { x: 0, y: 0, width: B, height: B }, hot);
    await compositor.add(img1, region, place(0, 0, 0.5), 1, meta); // conflicts with the base -> a dirty record
    const handle = (compositor as unknown as { temporal: Map<string, { handle: number }> }).temporal.get('c')!;
    const exports = core().exports;
    const [sizesOut] = core().scratch([12]);
    assert(exports.ls_temporal_flush_sizes(handle.handle, sizesOut) === 0);
    const sizesView = new DataView(exports.memory.buffer);
    const deletedCount = sizesView.getUint32(sizesOut, true);
    const dirtyCount = sizesView.getUint32(sizesOut + 4, true);
    const dirtyBlockTotal = sizesView.getUint32(sizesOut + 8, true);
    assert(dirtyCount > 0, 'setup should have produced at least one dirty record to flush');
    const [deletedOut, headersOut, blocksOut] = core().scratch([
      Math.max(1, deletedCount) * 10,
      Math.max(1, dirtyCount) * 66,
      Math.max(1, dirtyBlockTotal) * 8,
    ]);
    const badStatus = exports.ls_temporal_flush_take(handle.handle, deletedOut, deletedCount + 1, headersOut, blocksOut, dirtyCount);
    assert(badStatus < 0, 'a wrong deletedCount must be rejected');
    // The index must still hold every dirty/deleted row: a real flush() with the correct counts persists them.
    await compositor.flush();
    const rows = await db.scan('temporal/c/', { limit: 10 });
    assertEquals(rows.length, 1, 'the row the bad call almost dropped is still there after a real flush()');
  },
);
Deno.test(
  'temporal ABI: ls_overwrite_tile returns a status (not a wasm trap) for a block whose pixel footprint falls ' +
    'outside the source frame, tile buffers unchanged',
  () => {
    // Regression for rust/core/src/abi/temporal.rs::ls_overwrite_tile / rust/core/src/temporal.rs::overwrite_tile,
    // which indexed `blocks` into `rgba`/`tile.pixels`/`tile.owner` unchecked -- a bad block made the exported
    // function itself trap (Rust panics on an out-of-bounds slice index; the wasm build aborts on panic), not
    // return `STATUS_BAD_ARGUMENT` as abi/mod.rs's memory contract promises ("an invalid request returns a
    // negative status instead of trapping"). Calling `ls_overwrite_tile` through raw exports (bypassing
    // `core().overwriteTile()`'s `core.check()`, which would turn EITHER a trap or a clean bad status into a
    // caught exception and hide which one actually happened) makes a regression to a trap fail this test with
    // an uncaught `WebAssembly.RuntimeError` instead of quietly passing. Unreachable in production (the caller
    // only ever passes blocks `maskComplete` already proved consistent), but the ABI must not trust that from
    // the wasm boundary.
    const exports = core().exports;
    const tileSize = 2 * B, n = tileSize * tileSize, tileBlocks = (tileSize / B) ** 2;
    const imgWidth = 8, imgHeight = 8; // too small for block (0,0)'s 16x16 footprint at tx=ty=ox=oy=0
    const [tileDesc, tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tFrozen, rgbaScratch, blocksScratch, out] = core()
      .scratch([
        32,
        n * 4,
        Math.ceil(n / 8),
        Math.ceil(n / 8),
        tileBlocks,
        tileBlocks,
        tileBlocks * 4,
        tileBlocks,
        imgWidth * imgHeight * 4,
        8,
        16,
      ]);
    new Uint8Array(exports.memory.buffer).fill(0x42, tPixels, tPixels + n * 4); // a marker to prove it's untouched
    const tileView = new DataView(exports.memory.buffer, tileDesc, 32);
    [tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tFrozen].forEach((p, i) => tileView.setUint32(i * 4, p, true));
    tileView.setUint32(28, tileSize, true);
    new DataView(exports.memory.buffer, blocksScratch, 8).setInt32(0, 0, true); // block (bx=0, by=0)
    const before = new Uint8Array(exports.memory.buffer).slice(tPixels, tPixels + n * 4);
    const status = exports.ls_overwrite_tile(tileDesc, rgbaScratch, imgWidth, imgHeight, blocksScratch, 1, 0, 0, 0, 0, 1, 1, 0, out);
    assert(status < 0, `ls_overwrite_tile must return a negative status for an out-of-frame block, got ${status}`);
    const after = new Uint8Array(exports.memory.buffer).slice(tPixels, tPixels + n * 4);
    assertEquals(after, before, 'tile pixels must be unchanged after a rejected call');
  },
);
Deno.test(
  'compositor: add() on a canvas already dispose()d throws instead of silently losing its stashed rows',
  async () => {
    // Regression: temporalIndex() must not build a fresh Rust-resident index from a plain KV scan whenever
    // this.temporal has no live handle for a canvas — true both for a canvas never touched yet AND for one
    // dispose() already drained into `stashed`. The second case is a bug, not ordinary lazy init: `stashed`
    // holds dirty/deleted rows dispose() pulled out of the freed Rust index specifically because they are NOT
    // in KV yet (flush() hasn't run), so a fresh KV-only reload would silently come up short. Unreachable in
    // the pipeline today (dispose() only ever runs after the render pass's last add(), per dispose()'s own doc
    // comment), but a caller that got the order wrong deserves an error, not quietly wrong persisted rows.
    const width = B, region = makeRegion({ x: 0, y: 0, width, height: B });
    const db = new MemoryKV(), tiles = new TileStore(db, width, 8), atlas = new RegionAtlas([region], width, B);
    const compositor = new Compositor(db, tiles, 'stable', async () => {}, atlas);
    const meta = makeMeta();
    const base: RGB4 = [100, 100, 100, 255], hot: RGB4 = [250, 10, 10, 255];
    await compositor.add(solid(width, B, base), region, place(0, 0, 0.5), 0, meta); // base coverage, no conflict
    const img1 = solid(width, B, base);
    paintRect(img1, { x: 0, y: 0, width: B, height: B }, hot);
    await compositor.add(img1, region, place(0, 0, 0.5), 1, meta); // conflicts with the base -> a dirty record
    compositor.dispose(); // stashes canvas 'c'; flush() has not run, so its dirty row is not in KV yet
    const img2 = solid(width, B, base);
    paintRect(img2, { x: 0, y: 0, width: B, height: B }, [1, 2, 3, 255]);
    await assertRejects(() => compositor.add(img2, region, place(0, 0, 0.5), 2, meta));
  },
);
