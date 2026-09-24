/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import type { Rect, Region, RGBA } from '../../../src/types.ts';
import { stationaryBoundary, stickyOcclusions } from '../../../src/core/layers.ts';
import * as chromeReference from '../../support/reference/chrome.ts';

/** Failure modes: axis x vs y index math; first vs last choice; fractional from/cross inputs (the adapter read
 *  `undefined` and found nothing — must stay "nothing", not snap to a pixel); sampling step for spans > 160; carried
 *  bands kept only while every pixel under them is unchanged, dropped when out of bounds; motion < 2 returning the
 *  carry; row thresholds (n ≥ 8, zero < 6, shifted > 18) and the 4-row / 64-sample gate; the 23 % edge distance
 *  cap; wide regions with step > 1; resident vs JS frames. */
Deno.test('core parity: stationaryBoundary and stickyOcclusions match the frozen TS chrome evidence', async () => {
  const core = await ensureCore();
  const rnd = rng(0xc4a0);
  const W = 760, H = 520;
  // Page texture with a 64px toolbar (glyphs + 1px rule) that stays fixed while the page scrolls by `dy`.
  const make = (dy: number, toolbar: boolean, jitter = 0): RGBA => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v: number;
        if (toolbar && y < 64) v = y === 63 ? 20 : y > 17 && y < 39 && x > 40 && x < 700 && x % 17 < 8 ? 50 : 230;
        else {
          const sy = y + dy;
          v = ((((x * 5) >> 4) + ((sy * 7) >> 5)) * 53 + ((x ^ sy) & 15) + (jitter && (x * sy) % 97 === 0 ? jitter : 0)) & 255;
        }
        data.set([v, (v * 3) & 255, 255 - v, 255], (y * W + x) * 4);
      }
    }
    return { width: W, height: H, data };
  };
  const a = make(0, true), b = make(35, true), c = make(70, true, 40), plain = make(0, false);
  const ring = core.frameRing(2, W, H), ra = ring.upload(0, a), rb = ring.upload(1, b);
  for (
    const [img, axis, from, to, cf, ct, choose] of [
      [a, 'y', 40, 95, 20, 740, 'first'],
      [a, 'y', 40, 95, 20, 740, 'last'],
      [a, 'y', 0, 200, 0, W, 'last'],
      [a, 'x', 30, 720, 100, 500, 'first'],
      [plain, 'y', 40, 95, 20, 740, 'first'],
      [a, 'y', 40.5, 95, 20, 740, 'first'],
      [a, 'y', 40, 95, 20.25, 740, 'last'],
      [a, 'y', 0.5, 95, -5, 740, 'first'],
      [a, 'x', H - 3, H + 40, 0, W, 'last'],
      [ra, 'y', 40, 95, 20, 740, 'first'],
    ] as [RGBA, 'x' | 'y', number, number, number, number, 'first' | 'last'][]
  ) {
    const bytes = img instanceof Object && 'ptr' in img ? a : img;
    assertEquals(
      stationaryBoundary(img, axis, from, to, cf, ct, choose),
      chromeReference.stationaryBoundary(bytes as RGBA, axis, from, to, cf, ct, choose),
      `boundary ${axis} ${from}..${to} × ${cf}..${ct} ${choose}`,
    );
  }
  const region: Region = { id: 'p', name: 'p', kind: 'moving', rect: { x: 0, y: 0, width: W, height: H } };
  const cropped: Region = { ...region, crop: { x: 20, y: 10, width: W - 40, height: H - 20 } };
  const bands = chromeReference.stickyOcclusions(a, b, region, { x: 0, y: 35 });
  assert(bands.length === 1, 'fixture must yield a sticky band');
  const shiftedBand = [{ x: bands[0].x, y: bands[0].y, width: bands[0].width, height: bands[0].height - 3 }];
  const cases: [RGBA | typeof ra, RGBA | typeof ra, Region, { x: number; y: number }, Rect[] | undefined][] = [
    [a, b, region, { x: 0, y: 35 }, undefined],
    [ra, rb, region, { x: 0, y: 35 }, undefined],
    [a, b, cropped, { x: 0.4, y: 35.6 }, undefined],
    [b, c, region, { x: 0, y: 35 }, bands],
    [b, b, region, { x: 0, y: 0 }, bands],
    [b, make(35, true, 9), region, { x: 0, y: 0 }, bands],
    [b, b, region, { x: 0, y: 0 }, [{ x: -1, y: 0, width: W + 1, height: 64 }]],
    [b, b, region, { x: 1, y: 1 }, shiftedBand],
    [a, b, { ...region, rect: { x: 0, y: 0, width: W, height: 120 } }, { x: 0, y: 35 }, undefined],
    [a, plain, region, { x: 0, y: 35 }, undefined],
    [a, b, region, { x: 12, y: 3 }, undefined],
  ];
  for (const [prev, cur, r, motion, carry] of cases) {
    const p = prev === ra ? a : prev === rb ? b : prev as RGBA, q = cur === ra ? a : cur === rb ? b : cur as RGBA;
    assertEquals(
      stickyOcclusions(prev, cur, r, motion, carry),
      chromeReference.stickyOcclusions(p, q, r, motion, carry),
      `sticky ${JSON.stringify(motion)} carry ${carry?.length ?? 'none'}`,
    );
  }
  // Random small frames: every threshold branch against arbitrary content.
  for (let trial = 0; trial < 40; trial++) {
    const w = 700 + Math.floor(rnd() * 800), h = 40 + Math.floor(rnd() * 200);
    const frame = () => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : Math.floor(rnd() * 256);
      return { width: w, height: h, data };
    };
    const p = frame(),
      q = frame(),
      r: Region = {
        id: 'r',
        name: 'r',
        kind: 'moving',
        rect: { x: Math.floor(rnd() * 20), y: Math.floor(rnd() * 10), width: w - 30, height: h - 12 },
      };
    const motion = { x: rnd() * 6 - 3, y: rnd() * 60 - 20 };
    const carry = rnd() < .5 ? [{ x: r.rect.x, y: r.rect.y, width: r.rect.width, height: 8 + Math.floor(rnd() * 8) }] : undefined;
    assertEquals(
      stickyOcclusions(p, q, r, motion, carry),
      chromeReference.stickyOcclusions(p, q, r, motion, carry),
      `random trial ${trial}`,
    );
    assertEquals(
      stationaryBoundary(q, 'y', 1, h, 0, w, 'first'),
      chromeReference.stationaryBoundary(q, 'y', 1, h, 0, w, 'first'),
      `random boundary ${trial}`,
    );
  }
  ring.free();
});
