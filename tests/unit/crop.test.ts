// Crop (src/export/crop.ts and exportCanvas's `crop`): the ways a crop can go wrong, written before the code.
// A crop is a rectangle in the canvas's world pixels; it must come out as whole pixels inside the canvas, refuse
// anything that leaves nothing to export, and the cropped PNG must be exactly that window of the uncropped one,
// including across tile boundaries.
import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { unzipSync } from 'fflate';
import { MemoryKV, Namespace } from '../../src/storage/db.ts';
import { markCovered, TileStore } from '../../src/storage/tiles.ts';
import { exportCanvas } from '../../src/export/project.ts';
import { canvasRect, clampCrop, coversCanvas } from '../../src/export/crop.ts';
import { decodePNG } from '../../src/codec/png.ts';
import { type CanvasMeta, DEFAULT_SETTINGS, type Project, type Rect } from '../../src/types.ts';

const bounds: Rect = { x: -3, y: -2, width: 40, height: 30 };

Deno.test('crop: a canvas exports as whole pixels covering its fractional bounds', () => {
  assertEquals(canvasRect({ x: -3.5, y: -2, width: 40.2, height: 30 }), { x: -4, y: -2, width: 41, height: 30 });
  assertEquals(canvasRect(bounds), bounds);
});

Deno.test('crop: a rectangle reaching outside the canvas is clamped to it', () => {
  assertEquals(clampCrop({ x: -10, y: 20, width: 20, height: 100 }, bounds), { x: -3, y: 20, width: 13, height: 8 });
  assertEquals(clampCrop({ x: -100, y: -100, width: 1000, height: 1000 }, bounds), bounds);
});

Deno.test('crop: fractional edges round to whole pixels', () => {
  assertEquals(clampCrop({ x: 1.4, y: 2.6, width: 10.2, height: 4.8 }, bounds), { x: 1, y: 3, width: 11, height: 4 });
});

Deno.test('crop: nothing left to export is refused, not exported as an empty or inverted image', () => {
  for (
    const crop of [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -5 },
      { x: 5, y: 5, width: -10, height: -10 },
      { x: 100, y: 0, width: 10, height: 10 },
      { x: 0, y: -50, width: 10, height: 10 },
      { x: 0.2, y: 0, width: 0.2, height: 10 },
      { x: NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: Infinity, height: 10 },
    ]
  ) {
    assertEquals(clampCrop(crop, bounds), undefined, JSON.stringify(crop));
  }
});

Deno.test('crop: a rectangle covering the whole canvas is no crop at all', () => {
  assert(coversCanvas(bounds, bounds));
  assert(coversCanvas(clampCrop({ x: -50, y: -50, width: 500, height: 500 }, bounds)!, bounds));
  assert(!coversCanvas({ ...bounds, width: bounds.width - 1 }, bounds));
});

async function fixture() {
  const db = new MemoryKV(),
    project: Project = {
      id: 'p1',
      created: '',
      updated: '',
      name: 'x',
      settings: { ...DEFAULT_SETTINGS, tileSize: 64, memoryMB: 64 },
      status: 'complete',
      frames: 1,
      renderedFrames: 1,
      canvasCount: 1,
      tiles: 4,
      observedPixels: 1,
      diagnostics: {},
      regions: [],
    };
  const store = new Namespace(db, `run/${project.id}/`), tiles = new TileStore(store, 64, 64);
  const meta: CanvasMeta = {
    id: 'c',
    layer: 'l',
    name: 'c',
    kind: 'moving',
    bounds,
    tileCount: 4,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    provisionalPixels: 0,
    maxLevel: 0,
    fragment: 0,
    firstTime: 0,
    lastTime: 1,
  };
  // Every pixel distinct, spread over four 64-pixel tiles (the canvas straddles x = 0 and y = 0), a few left
  // unobserved so transparency has to survive the crop too.
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      if ((x * 7 + y) % 11 === 0) continue;
      const tx = Math.floor(x / 64), ty = Math.floor(y / 64), i = (y - ty * 64) * 64 + (x - tx * 64), t = await tiles.get('c', tx, ty);
      t.pixels.set([x & 255, y & 255, (x * y) & 255, 255], i * 4);
      markCovered(t, i);
      t.dirty = true;
    }
  }
  await tiles.flush();
  await store.put('canvas/c', meta);
  return { store, project, meta };
}

async function png(result: { blob?: Blob }) {
  return await decodePNG(new Uint8Array(await result.blob!.arrayBuffer()));
}

Deno.test('crop: the cropped PNG is exactly that window of the full PNG, across tile boundaries', async () => {
  const { store, project, meta } = await fixture();
  const full = await png(await exportCanvas(store, project, meta, () => {}, undefined, 'single'));
  assertEquals([full.width, full.height], [40, 30]);
  const crop = { x: -2, y: -1, width: 9, height: 7 }; // world x -2..6, y -1..5: both tile seams inside
  const cut = await png(await exportCanvas(store, project, meta, () => {}, undefined, 'single', crop));
  assertEquals([cut.width, cut.height], [9, 7]);
  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) {
      const i = (y * cut.width + x) * 4, j = ((y + crop.y - bounds.y) * full.width + x + crop.x - bounds.x) * 4;
      assertEquals([...cut.data.subarray(i, i + 4)], [...full.data.subarray(j, j + 4)], `pixel ${x},${y}`);
    }
  }
});

Deno.test('crop: the paged export pages only the crop', async () => {
  const { store, project, meta } = await fixture();
  const crop = { x: 4, y: 3, width: 20, height: 10 };
  const zip = unzipSync(
    new Uint8Array(await (await exportCanvas(store, project, meta, () => {}, undefined, 'sheets', crop)).blob!.arrayBuffer()),
  );
  assertEquals(Object.keys(zip).filter((n) => n.endsWith('.png')), ['sheet_0_0.png']);
  assertEquals(JSON.parse(new TextDecoder().decode(zip['sheet_0_0.json'])), crop);
  const sheet = await decodePNG(zip['sheet_0_0.png']);
  assertEquals([sheet.width, sheet.height], [20, 10]);
});

Deno.test('crop: a crop with nothing left inside the canvas is refused, not exported', async () => {
  const { store, project, meta } = await fixture();
  await assertRejects(
    () => exportCanvas(store, project, meta, () => {}, undefined, 'single', { x: 500, y: 0, width: 10, height: 10 }),
    Error,
    'crop',
  );
});
