/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import { Compositor } from '../../../src/core/compositor.ts';
import { ReferenceCompositor } from '../../support/reference/compositor.ts';
import { MemoryKV } from '../../../src/storage/db.ts';
import { TileStore } from '../../../src/storage/tiles.ts';
import type { CanvasMeta, Diagnostic, Placement, Region } from '../../../src/types.ts';

Deno.test('core parity: Compositor.add matches the frozen TS compositor across masks, occlusions, consistency and temporal conflicts', async () => {
  await ensureCore();
  for (const policy of ['stable', 'latest'] as const) {
    for (const [width, height, rectangular] of [[160, 96, true], [150, 90, false]] as [number, number, boolean][]) {
      // Region: either the whole frame (rectangular fast path) or an L-shaped mask via an exclusion.
      const region: Region = {
        id: 'r',
        name: 'r',
        kind: 'moving',
        rect: rectangular ? { x: 0, y: 0, width, height } : { x: 8, y: 4, width: width - 16, height: height - 8 },
        exclusions: rectangular ? undefined : [{ x: 8, y: 4, width: 40, height: 30 }],
      };
      const { RegionAtlas } = await import('../../../src/core/layers.ts');
      const atlas = new RegionAtlas([region], width, height);
      const make = (Ctor: typeof Compositor | typeof ReferenceCompositor) => {
        const db = new MemoryKV(), tiles = new TileStore(db, 64, 1), diagnostics: Diagnostic[] = [];
        tiles.maxTiles = 3;
        const meta: CanvasMeta = {
          id: 'c',
          kind: 'moving',
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          tileCount: 0,
          observedPixels: 0,
          conflictPixels: 0,
          uncertainPixels: 0,
          provisionalPixels: 0,
          frames: 0,
          regionId: 'r',
        } as unknown as CanvasMeta;
        return {
          db,
          tiles,
          meta,
          diagnostics,
          compositor: new Ctor(db, tiles, policy, async (d) => {
            diagnostics.push(d);
          }, atlas),
        };
      };
      const actual = make(Compositor), expected = make(ReferenceCompositor);
      const seed = rng(width * 7 + height);
      for (let frame = 0; frame < 10; frame++) {
        const data = new Uint8ClampedArray(width * height * 4), consistent = new Uint8Array(width * height).fill(1);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const p = y * width + x;
            // Static page with a widget that changes at frames 3 and 6, noise below/above the conflict threshold.
            const widget = x >= 60 && x < 100 && y >= 30 && y < 60;
            const base = ((x >> 3) + (y >> 3)) & 1 ? 200 : 40;
            const value = widget && frame >= 3 ? (frame >= 6 ? 250 : 120) : base;
            data.set([value, (x * 5 + y) & 255, frame < 2 ? 90 : 90 + Math.floor(seed() * 30), 255], p * 4);
            if ((frame === 1 && p % 7 === 0) || (frame === 4 && x < 24)) consistent[p] = 0;
          }
        }
        const placement: Placement = {
          x: frame >= 5 ? -20.5 : -33.4 + frame,
          y: -17.6 + (frame % 3),
          confidence: .55 + .04 * frame,
          time: frame / 30,
          canvasId: 'c',
          node: frame,
          uncertain: frame === 2,
          occlusions: frame === 4 ? [{ x: 10, y: 10, width: 30, height: 12 }] : undefined,
        } as unknown as Placement;
        const image = { width, height, data };
        const useMask = frame !== 7;
        const a = await actual.compositor.add(image, region, placement, frame, actual.meta, useMask ? consistent : undefined);
        const e = await expected.compositor.add(image, region, placement, frame, expected.meta, useMask ? consistent : undefined);
        assertEquals(a, e, `${policy} ${width}×${height} frame ${frame} stats`);
        assertEquals(actual.meta, expected.meta, `${policy} frame ${frame} meta`);
        assertEquals(actual.diagnostics, expected.diagnostics, `${policy} frame ${frame} diagnostics`);
      }
      // Temporal records are persisted on flush (like tiles); the frozen compositor wrote them per frame.
      await (actual.compositor as Compositor).flush();
      await actual.tiles.flush();
      await expected.tiles.flush();
      const dump = async (db: MemoryKV) => {
        const rows: unknown[] = [];
        for (const [key, value] of [...db.data].sort(([a], [b]) => a.localeCompare(b))) {
          const v = value as { blob?: Blob };
          rows.push({ key, value: v.blob ? { ...v, blob: [...new Uint8Array(await v.blob.arrayBuffer())] } : value });
        }
        return rows;
      };
      assertEquals(
        await dump(actual.db),
        await dump(expected.db),
        `${policy} ${width}×${height} persisted tiles, evidence and temporal records`,
      );
    }
  }
});

Deno.test('core parity: Compositor.add on large tiles with threshold-exact colour sums matches the frozen TS compositor', async () => {
  await ensureCore();
  const { RegionAtlas } = await import('../../../src/core/layers.ts');
  const [width, height] = [420, 300];
  const region: Region = {
    id: 'r',
    name: 'r',
    kind: 'moving',
    rect: { x: 2, y: 3, width: width - 4, height: height - 6 },
    exclusions: [{ x: 200, y: 100, width: 37, height: 21 }],
  };
  const atlas = new RegionAtlas([region], width, height);
  const make = (Ctor: typeof Compositor | typeof ReferenceCompositor) => {
    const db = new MemoryKV(), tiles = new TileStore(db, 256, 64), diagnostics: Diagnostic[] = [];
    const meta = {
      id: 'c',
      kind: 'moving',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      tileCount: 0,
      observedPixels: 0,
      conflictPixels: 0,
      uncertainPixels: 0,
      provisionalPixels: 0,
      frames: 0,
      regionId: 'r',
    } as unknown as CanvasMeta;
    return { db, tiles, meta, diagnostics, compositor: new Ctor(db, tiles, 'stable', async (d) => void diagnostics.push(d), atlas) };
  };
  const actual = make(Compositor), expected = make(ReferenceCompositor);
  const seed = rng(0xb10c);
  const page = (x: number, y: number) => [(x * 3 + y * 7) & 255, (x ^ y) & 255, (x * y) & 255];
  for (let frame = 0; frame < 8; frame++) {
    const px = frame < 4 ? 40 - 13 * frame : -3 + frame, py = 20 - 9 * frame + (frame & 1) * .6;
    const data = new Uint8ClampedArray(width * height * 4), consistent = new Uint8Array(width * height).fill(1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, rgb = page(x + Math.round(px), y + Math.round(py)), roll = seed();
        let alpha = 255;
        if (frame > 0 && roll < .05) {
          // Spread exactly 75 or 76 over the channels, away from saturation.
          let budget = seed() < .5 ? 75 : 76;
          for (let c = 0; c < 3; c++) {
            const step = Math.min(budget, rgb[c] < 128 ? 255 - rgb[c] : rgb[c]);
            rgb[c] += rgb[c] < 128 ? step : -step;
            budget -= step;
          }
        } else if (roll < .08) {
          alpha = Math.floor(seed() * 256);
        } else if (frame >= 5 && x > 250 && y > 150 && roll < .7) {
          rgb[0] ^= 0x80;
        }
        data.set([rgb[0], rgb[1], rgb[2], alpha], p * 4);
        if (frame === 3 && (x + y) % 11 === 0) consistent[p] = 0;
      }
    }
    const placement = {
      x: px,
      y: py,
      confidence: .5 + .06 * frame,
      time: frame / 30,
      canvasId: 'c',
      node: frame,
      uncertain: frame === 6,
      occlusions: frame === 2 ? [{ x: 0, y: 40, width, height: 10 }, { x: 100.5, y: 70, width: 60, height: 5 }] : undefined,
    } as unknown as Placement;
    const image = { width, height, data };
    const a = await actual.compositor.add(image, region, placement, frame, actual.meta, frame === 7 ? undefined : consistent);
    const e = await expected.compositor.add(image, region, placement, frame, expected.meta, frame === 7 ? undefined : consistent);
    assertEquals(a, e, `frame ${frame} stats`);
    assertEquals(actual.meta, expected.meta, `frame ${frame} meta`);
    assertEquals(actual.diagnostics, expected.diagnostics, `frame ${frame} diagnostics`);
  }
  await (actual.compositor as Compositor).flush();
  await actual.tiles.flush();
  await expected.tiles.flush();
  const dump = async (db: MemoryKV) => {
    const rows: unknown[] = [];
    for (const [key, value] of [...db.data].sort(([a], [b]) => a.localeCompare(b))) {
      const v = value as { blob?: Blob };
      rows.push({ key, value: v.blob ? { ...v, blob: [...new Uint8Array(await v.blob.arrayBuffer())] } : value });
    }
    return rows;
  };
  assertEquals(await dump(actual.db), await dump(expected.db), 'persisted tiles, evidence and temporal records');
});
