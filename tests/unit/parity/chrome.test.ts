/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import type { Point, Rect, Region, RGBA } from '../../../src/types.ts';
import { stationaryBoundary, stickyOcclusions } from '../../../src/core/layers.ts';
import * as chromeReference from '../../support/reference/chrome.ts';

/** Failure modes: axis x vs y index math; first vs last choice; fractional from/cross inputs (the adapter read
 *  `undefined` and found nothing — must stay "nothing", not snap to a pixel); sampling step for spans > 160; carried
 *  bands kept only while every pixel under them is unchanged, dropped when out of bounds; motion < 2 returning the
 *  carry; row thresholds (n ≥ 8, zero < 6, shifted > 18) and the 4-row / 64-sample gate; the 23 % edge distance
 *  cap; wide regions with step > 1; resident vs JS frames. The band's own small shift (new_ip_8): a band sliding
 *  2, 5 or 12 px over a fast page; one sliding down while the page scrolls back; one just outside the window
 *  (|k| > |dy| / 4) and one too close to the page's step (|dy − k| < 8); shifts whose partner row is off the frame; rows
 *  whose page partner is outside the region (scrolling back under a strip) taking no shift. */
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
  // A band with texture in every row (anti-aliased text, icons) sliding at its own speed: `lift` px up from the top.
  const slid = (dy: number, lift: number): RGBA => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const by = y + lift;
      for (let x = 0; x < W; x++) {
        let v: number;
        if (by >= 0 && by < 64) v = by === 63 ? 20 : (((x * 7 + by * 13) % 23) < 9 ? 40 : 225) + ((x * by) % 11);
        else {
          const sy = y + dy;
          v = ((((x * 5) >> 4) + ((sy * 7) >> 5)) * 53 + ((x ^ sy) & 15)) & 255;
        }
        data.set([v, (v * 3) & 255, 255 - v, 255], (y * W + x) * 4);
      }
    }
    return { width: W, height: H, data };
  };
  const base = slid(0, 0);
  const moving: [RGBA, RGBA, number, number][] = [
    [base, slid(48, 2), 48, 62],
    [base, slid(48, 5), 48, 59],
    [base, slid(60, 12), 60, 52],
    [slid(40, -20), slid(0, -23), -40, 87],
    [base, slid(40, 11), 40, 0],
    [base, slid(9, 2), 9, 0],
    [base, slid(10, 2), 10, 62],
    [base, slid(40, -3), 40, 67],
  ];
  // Scrolling back under a strip outside the region: the first rows' page partner is that strip; no shift of their own.
  const strip = (img: RGBA): RGBA => {
    const data = img.data.slice();
    data.fill(30, 0, 40 * W * 4);
    for (let i = 3; i < 40 * W * 4; i += 4) data[i] = 255;
    return { width: W, height: H, data };
  };
  const under: Region = { ...region, rect: { x: 0, y: 40, width: W, height: H - 40 } };
  for (
    const [prev, cur, dy] of [[strip(slid(0, -40)), strip(slid(-37, -49)), -37], [
      strip(make(0, false)),
      strip(make(-37, false)),
      -37,
    ]] as const
  ) {
    assertEquals(stickyOcclusions(prev, cur, under, { x: 0, y: dy }), chromeReference.stickyOcclusions(prev, cur, under, { x: 0, y: dy }));
  }
  for (const [prev, cur, dy, bottom] of moving) {
    const want = chromeReference.stickyOcclusions(prev, cur, region, { x: 0, y: dy });
    assertEquals(want.length ? want[0].y + want[0].height : 0, bottom, `oracle on a band shifted under page step ${dy}`);
    assertEquals(stickyOcclusions(prev, cur, region, { x: 0, y: dy }), want, `sliding band, page step ${dy}`);
  }
  // A code editor (new_mac_4): text scrolling at the region's top, and below it, inside a blank gap of the page, a
  // pointer resting on screen beside a column ruler. The rows the page explains end the band's evidence first.
  const editor = (dy: number): RGBA => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sy = y + dy, still = x === 380 || x === 381 || (x >= 600 && x < 606 && y >= 70 && y < 90);
        const v = still ? 250 : sy >= 60 && sy < 120 ? 20 : ((((x * 5) >> 4) + ((sy * 7) >> 5)) * 53 + ((x ^ sy) & 15)) & 255;
        data.set([v, (v * 3) & 255, 255 - v, 255], (y * W + x) * 4);
      }
    }
    return { width: W, height: H, data };
  };
  {
    const want = chromeReference.stickyOcclusions(editor(0), editor(14), region, { x: 0, y: 14 });
    assertEquals(want, [], 'oracle: a resting pointer below scrolling text is no band');
    assertEquals(stickyOcclusions(editor(0), editor(14), region, { x: 0, y: 14 }), want, 'resting pointer');
  }
  // A table of contents over part of the page (Region.sticky), at an opacity per frame: on screen over a scrolling
  // page, fading, away, and with the page standing still.
  const toc = (dy: number, alpha: number, margin: boolean): RGBA => {
    const img = make(dy, false), data = img.data.slice();
    for (let y = 120; y < 420; y++) {
      for (let x = 30; x < 200; x++) {
        const i = (y * W + x) * 4, under = margin ? 247 : data[i];
        const ink = (y - 120) % 21 < 8 && x > 44 && x < 180 ? (x * 37 + y * 11) % 120 : 247;
        const v = Math.round(under * (1 - alpha) + ink * alpha);
        data.set([v, v, v], i);
      }
    }
    return { width: W, height: H, data };
  };
  const withBlock: Region = { ...region, sticky: [{ x: 30, y: 120, width: 170, height: 300 }] };
  for (
    const [prev, cur, dy, carry] of [
      [toc(0, 1, true), toc(35, 1, true), 35, []],
      [toc(0, .4, false), toc(35, .6, false), 35, []],
      [toc(0, 0, false), toc(35, 0, false), 35, []],
      [toc(0, 0, true), toc(35, 0, true), 35, []],
      [toc(35, .6, true), toc(35, .4, true), 0, []],
      [toc(35, 1, true), toc(35, 1, true), 0, withBlock.sticky!],
      [toc(35, 1, false), toc(35, .8, false), 0, []],
      [toc(35, .2, false), toc(35, .2, false), 0, []],
      [toc(0, 0, true), toc(35, .15, true), 35, []],
    ] as [RGBA, RGBA, number, Rect[]][]
  ) {
    assertEquals(
      stickyOcclusions(prev, cur, withBlock, { x: 0, y: dy }, carry),
      chromeReference.stickyOcclusions(prev, cur, withBlock, { x: 0, y: dy }, carry),
      `sticky block, page step ${dy}`,
    );
  }
  assertEquals(chromeReference.stickyOcclusions(toc(0, 1, true), toc(35, 1, true), withBlock, { x: 0, y: 35 }), withBlock.sticky);
  // A step that came through the anchor: odometry's step is zero, the pose's own step is the page's; or none at all.
  for (
    const [carry, blockMotion] of [[[], { x: 0, y: 35 }], [withBlock.sticky!, { x: 0, y: 35 }], [withBlock.sticky!, null]] as [
      Rect[],
      Point | null,
    ][]
  ) {
    assertEquals(
      stickyOcclusions(toc(0, 1, true), toc(35, 1, true), withBlock, { x: 0, y: 0 }, carry, blockMotion),
      chromeReference.stickyOcclusions(toc(0, 1, true), toc(35, 1, true), withBlock, { x: 0, y: 0 }, carry, blockMotion),
      'anchored step',
    );
  }
  assertEquals(
    chromeReference.stickyOcclusions(toc(0, 1, true), toc(35, 1, true), withBlock, { x: 0, y: 0 }, [], { x: 0, y: 35 }),
    withBlock.sticky,
  );
  // Without a step to weigh, a block is only carried while every pixel under it is unchanged.
  assertEquals(
    chromeReference.stickyOcclusions(toc(0, 1, true), toc(35, 1, true), withBlock, { x: 0, y: 0 }, withBlock.sticky, null),
    withBlock.sticky,
  );
  assertEquals(
    chromeReference.stickyOcclusions(toc(0, 1, false), toc(35, .8, false), withBlock, { x: 0, y: 0 }, withBlock.sticky, null),
    [],
  );
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
