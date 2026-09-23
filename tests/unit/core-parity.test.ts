/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../support/core.ts';
import * as reference from '../support/reference/kernels.ts';
import { rng } from '../../src/core/math.ts';
import type { Feature, Gray, RGBA } from '../../src/types.ts';

const random = rng(0x5eed);
function randomRGBA(width: number, height: number, smooth = false): RGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const v = smooth ? ((x * 7 + y * 13) ^ (x >> 3)) & 255 : Math.floor(random() * 256);
      data[o] = v;
      data[o + 1] = smooth ? (v * 3) & 255 : Math.floor(random() * 256);
      data[o + 2] = smooth ? (255 - v) & 255 : Math.floor(random() * 256);
      data[o + 3] = random() < .2 ? Math.floor(random() * 256) : 255;
    }
  }
  return { width, height, data };
}
function randomGray(width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  // Blocky texture with noise: gives many corners while keeping realistic flat areas.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = (((x >> 4) + (y >> 4)) & 1 ? 200 : 40) + Math.floor(random() * 30);
    }
  }
  return { width, height, data };
}
const sameFeatures = (a: Feature[], b: Feature[]) => {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals([a[i].x, a[i].y], [b[i].x, b[i].y], `feature ${i} position`);
    assert(Math.abs(a[i].score - b[i].score) <= Math.abs(a[i].score) * 1e-6, `feature ${i} score ${a[i].score} vs ${b[i].score}`);
    assertEquals([...a[i].descriptor], [...b[i].descriptor], `feature ${i} descriptor`);
  }
};

Deno.test('core parity: grayscale, box downscale (partial cells) and alpha-weighted halving are byte-exact', async () => {
  const core = await ensureCore();
  for (const [w, h, factor] of [[1, 1, 1], [7, 5, 2], [641, 449, 2], [1082, 1920, 4], [1919, 1079, 4], [3, 9, 8], [64, 64, 1]]) {
    const image = randomRGBA(w, h);
    assertEquals(core.grayscale(image.data, w, h), reference.grayscale(image.data, w, h));
    assertEquals(core.downscaleGray(image, factor), reference.downscaleGray(image, factor));
    assertEquals(core.halveRGBA(image), reference.halveRGBA(image));
  }
});

Deno.test('core parity: features, descriptors, matches and visual words agree with the frozen TS kernels', async () => {
  const core = await ensureCore();
  for (const [w, h] of [[23, 23], [22, 40], [160, 120], [640, 360], [320, 240]]) {
    const g = randomGray(w, h);
    const expected = reference.extractFeatures(g), actual = core.extractFeatures(g, 480);
    sameFeatures(actual, expected);
    const roi = { x: w / 4, y: h / 3, width: w / 2, height: h / 2 };
    sameFeatures(core.extractFeatures(g, 120, roi), reference.extractFeatures(g, 120, roi));
    const shifted: Gray = { width: w, height: h, data: new Uint8Array(w * h) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) shifted.data[y * w + x] = g.data[Math.min(h - 1, y + 3) * w + Math.min(w - 1, x + 2)];
    }
    const other = reference.extractFeatures(shifted);
    for (const ambiguous of [true, false]) {
      const matches = core.matchFeatures(expected, other, ambiguous), ref = reference.matchFeatures(expected, other, ambiguous);
      assertEquals(matches.length, ref.length);
      for (let i = 0; i < ref.length; i++) {
        assert(matches[i].a === ref[i].a && matches[i].b === ref[i].b, `match ${i} identity`);
        assertEquals([matches[i].distance, matches[i].unique], [ref[i].distance, ref[i].unique]);
      }
    }
    assertEquals(core.featureWords(expected), reference.featureWords(expected));
    assertEquals(core.featureWords(expected.filter((_, i) => i % 2 === 0)), reference.featureWords(expected.filter((_, i) => i % 2 === 0)));
  }
  assertEquals(core.extractFeatures({ width: 5, height: 5, data: new Uint8Array(25) }, 10), []);
  assertEquals(core.matchFeatures([], [], true), []);
  assertEquals(core.featureWords([]), []);
});

Deno.test('core parity: PNG scanline reconstruction and Sub filtering are byte-exact for every filter and colour type', async () => {
  const core = await ensureCore();
  for (const channels of [1, 2, 3, 4]) {
    for (const [w, h] of [[1, 1], [5, 3], [64, 17], [512, 4]]) {
      const stride = w * channels, raw = new Uint8Array((stride + 1) * h);
      for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = y % 5;
        for (let i = 1; i <= stride; i++) raw[y * (stride + 1) + i] = Math.floor(random() * 256);
      }
      assertEquals(core.pngUnfilter(raw, w, h, channels), reference.unfilterPNG(raw, w, h, channels));
    }
  }
  const image = randomRGBA(37, 11);
  const filtered = core.pngFilterSub(new Uint8Array(image.data.buffer), 37, 11);
  assertEquals(filtered, reference.filterSub(image.data, 37, 11));
  assertEquals(core.pngUnfilter(filtered, 37, 11, 4), image.data);
  let threw = false;
  try {
    core.pngUnfilter(new Uint8Array([7, 0, 0, 0, 0]), 1, 1, 4);
  } catch (error) {
    threw = String(error).includes('Invalid PNG filter 7');
  }
  assert(threw, 'invalid filter byte must be reported explicitly');
});

import * as motionReference from '../support/reference/motion.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { rgbaOf, textureGray } from '../support/parity-fixtures.ts';

const sameNumber = (a: number, b: number, what: string) => {
  if (Number.isFinite(a) || Number.isFinite(b)) {
    assert(Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9), `${what}: ${a} vs ${b}`);
  } else assertEquals(a, b, what);
};

Deno.test('core parity: motion hypotheses, audits, refinement and per-cell fields match the frozen TS module', async () => {
  const core = await ensureCore();
  for (const [w, h, dx, dy] of [[320, 240, 17, 23], [640, 360, -41, 8], [200, 320, 0, 0], [256, 256, 3, -37]]) {
    const world = textureGray(w + 200, h + 200, w * 31 + h);
    const crop = (x: number, y: number): Gray => {
      const data = new Uint8Array(w * h);
      for (let row = 0; row < h; row++) {
        data.set(world.data.subarray((y + row) * world.width + x, (y + row) * world.width + x + w), row * w);
      }
      return { width: w, height: h, data };
    };
    const a = crop(100, 100), b = crop(100 + dx, 100 + dy);
    const fa = reference.extractFeatures(a), fb = reference.extractFeatures(b), matches = reference.matchFeatures(fa, fb);
    const hyp = core.translationHypotheses(matches, 6), refHyp = motionReference.translationHypotheses(matches, 6);
    assertEquals(hyp.length, refHyp.length);
    hyp.forEach((m, i) => {
      assertEquals([m.x, m.y, m.support, m.unique, m.ambiguous], [
        refHyp[i].x,
        refHyp[i].y,
        refHyp[i].support,
        refHyp[i].unique,
        refHyp[i].ambiguous,
      ]);
      sameNumber(m.confidence, refHyp[i].confidence, `hypothesis ${i} confidence`);
    });
    sameNumber(core.detectScale(matches), motionReference.detectScale(matches), 'scale');
    for (const roi of [undefined, { x: 10.5, y: 7, width: w / 2, height: h / 2 }]) {
      for (const [tx, ty] of [[dx, dy], [dx + 1, dy - 2], [0, 0]]) {
        sameNumber(core.verifyTranslation(a, b, tx, ty, roi), motionReference.verifyTranslation(a, b, tx, ty, roi), 'verify');
        for (const tolerant of [false, true]) {
          const audit = core.auditTranslation(a, b, tx, ty, roi, tolerant),
            ref = motionReference.auditTranslation(a, b, tx, ty, roi, tolerant);
          for (const key of Object.keys(ref) as (keyof typeof ref)[]) sameNumber(audit[key], ref[key], `audit.${key} at ${tx},${ty}`);
        }
        assertEquals(
          core.refineTranslation(a, b, { x: tx + .4, y: ty - .4 }, roi, 2),
          motionReference.refineTranslation(a, b, { x: tx + .4, y: ty - .4 }, roi),
        );
      }
    }
    const field = core.estimateMotion(a, b, matches, fb.length), refField = motionReference.estimateMotion(a, b, undefined, fa, fb);
    assertEquals([field.cols, field.rows, field.cell, field.featureCount, field.unknown], [
      refField.cols,
      refField.rows,
      refField.cell,
      refField.featureCount,
      refField.unknown,
    ]);
    sameNumber(field.difference, refField.difference, 'difference');
    sameNumber(field.zoom, refField.zoom, 'zoom');
    assertEquals(field.motions.length, refField.motions.length);
    field.motions.forEach((m, i) => {
      assertEquals([m.x, m.y, m.support, m.unique, m.ambiguous], [
        refField.motions[i].x,
        refField.motions[i].y,
        refField.motions[i].support,
        refField.motions[i].unique,
        refField.motions[i].ambiguous,
      ]);
      sameNumber(m.confidence, refField.motions[i].confidence, `motion ${i} confidence`);
      sameNumber(m.error, refField.motions[i].error, `motion ${i} error`);
    });
    assertEquals(field.labels, refField.labels);
    assertEquals(field.confidence, refField.confidence);
    assertEquals(field.dynamic, refField.dynamic);
    const same = core.estimateMotion(a, a, [], 0), refSame = motionReference.estimateMotion(a, a);
    assertEquals(same.motions, refSame.motions);
    assertEquals(same.confidence, refSame.confidence);
    // Native refinement on RGBA with and without an atlas mask, including the fractional guess tie rule.
    const ra = rgbaOf(a), rb = rgbaOf(b), region = { x: 4.5, y: 3, width: w - 20, height: h - 9 };
    const atlas = new RegionAtlas([{ id: 'r', name: 'r', kind: 'moving', rect: { x: 0, y: 0, width: w * .6, height: h } }], w, h);
    for (const guess of [{ x: dx + .3, y: dy - .6 }, { x: dx - 2.5, y: dy + 2.5 }, { x: 0, y: 40 }]) {
      const plain = core.refineNative(ra, rb, guess, region, undefined, 3),
        refPlain = motionReference.refineNative(ra, rb, guess, region, undefined, 3);
      assertEquals([plain.x, plain.y, plain.samples], [refPlain.x, refPlain.y, refPlain.samples]);
      sameNumber(plain.error, refPlain.error, 'refine error');
      sameNumber(plain.runnerUp, refPlain.runnerUp, 'runner-up');
      const masked = core.refineNative(ra, rb, guess, region, { labels: atlas.labels, code: 1 }, 3);
      const refMasked = motionReference.refineNative(ra, rb, guess, region, (x, y) => atlas.contains(1, x, y), 3);
      assertEquals([masked.x, masked.y, masked.samples], [refMasked.x, refMasked.y, refMasked.samples]);
      sameNumber(masked.error, refMasked.error, 'masked refine error');
      sameNumber(masked.runnerUp, refMasked.runnerUp, 'masked runner-up');
    }
    const native = reference.grayscale(rb.data, w, h), patches = motionReference.extractPatches(native, region, fb.slice(0, 40), 1);
    for (const guess of [{ x: -dx + .2, y: -dy }, { x: 5, y: -5 }]) {
      const r1 = core.refinePatches(patches, native, region, guess, 3),
        r2 = motionReference.refinePatches(patches, native, region, guess, 3);
      assertEquals([r1.x, r1.y, r1.samples], [r2.x, r2.y, r2.samples]);
      sameNumber(r1.error, r2.error, 'patch error');
      sameNumber(r1.runnerUp, r2.runnerUp, 'patch runner-up');
    }
    assertEquals(
      core.refinePatches([], native, region, { x: 1.6, y: -1.6 }, 3),
      motionReference.refinePatches([], native, region, { x: 1.6, y: -1.6 }, 3),
    );
    for (const scale of [1.1, 1 / 1.25, 2, .5]) assertEquals(core.resampleGray(a, scale), motionReference.resampleGray(a, scale));
  }
});

import { Compositor } from '../../src/core/compositor.ts';
import { ReferenceCompositor } from '../support/reference/compositor.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { TileStore } from '../../src/storage/tiles.ts';
import type { CanvasMeta, Diagnostic, Placement, Region } from '../../src/types.ts';

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
      const { RegionAtlas } = await import('../../src/core/layers.ts');
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

import { ReferenceVotingRing } from '../support/reference/voting.ts';

/** Failure modes the voting-ring parity must catch: `Math.hypot` vs libm hypot changing the dmin gate or the
 *  displacement sort; `Math.round` on negative half-cells; box-gray rounding (`Math.round(sum / 9)`); region masks
 *  looked up at floor(x/factor) vs ratio; exclusions/crop/solid; partner selection ties (equal pairs, equal d);
 *  saturating i8/u8 counters; eviction order under a byte budget; multi-canvas gating; slots with no evidence in a
 *  frame; and drain at the end of the pass. */
Deno.test('core parity: the voting ring matches the frozen TS ring record-for-record, including evictions and drain', async () => {
  const core = await ensureCore();
  const toRecord = (
    r: {
      index: number;
      record: Record<string, { x0: number; y0: number; w: number; h: number; bits: Uint8Array; clean: Uint8Array }> | undefined;
    },
  ) => ({
    index: r.index,
    record: r.record &&
      Object.fromEntries(
        Object.entries(r.record).map(([id, v]) => [id, { x0: v.x0, y0: v.y0, w: v.w, h: v.h, bits: [...v.bits], clean: [...v.clean] }]),
      ),
  });
  // Regions must be taller than dmin (64 native px) or no partner can ever overlap; that is a property of the
  // algorithm, not something the fixture should paper over.
  for (
    const [factor, noise, nativeW, nativeH] of [[1, 0, 96, 130], [2, 10, 190, 121], [4, 10, 257, 200], [1, 10, 128, 200]] as number[][]
  ) {
    const aw = Math.ceil(nativeW / factor), ah = Math.ceil(nativeH / factor);
    // Two moving regions: a masked one with an exclusion, and a cropped rectangular one; plus a fixed region that must be ignored.
    const mask = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) mask[y * aw + x] = x < aw * .6 && !(x < 4 && y < 6) ? 1 : 0;
    const regions: Region[] = [
      {
        id: 'a',
        name: 'a',
        kind: 'moving',
        rect: { x: 0, y: 8, width: Math.floor(nativeW * .6), height: nativeH - 8 },
        mask,
        maskWidth: aw,
        maskHeight: ah,
        factor,
        exclusions: [{ x: 10, y: 60, width: 30, height: 20 }],
      },
      {
        id: 'b',
        name: 'b',
        kind: 'moving',
        rect: { x: Math.floor(nativeW * .6), y: 8, width: nativeW - Math.floor(nativeW * .6), height: nativeH - 8 },
        crop: { x: Math.floor(nativeW * .6) + 2, y: 10, width: nativeW - Math.floor(nativeW * .6) - 4, height: nativeH - 20 },
        solid: true,
      },
    ];
    // Roughly ten frames resident (two regions × three planes each): partners clear dmin, and evictions still happen mid-run.
    const budget = 10 * (2 * 3 * aw * ah);
    const ring = core.votingRing(regions, {
      factor,
      noise,
      nativeWidth: nativeW,
      nativeHeight: nativeH,
      analysisWidth: aw,
      analysisHeight: ah,
      budgetBytes: budget,
    });
    const reference = new ReferenceVotingRing(factor, noise, nativeW, nativeH, regions, budget);
    try {
      for (let slot = 0; slot < regions.length; slot++) {
        assertEquals(ring.boxes[slot], reference.box.get(regions[slot].id));
        assertEquals(ring.interior(slot), reference.interior.get(regions[slot].id));
      }
      // Scrolling content: a textured world sampled at a drifting pose, with a screen-fixed overlay band and noise.
      const world = (x: number, y: number) => ((((x * 7) >> 3) + ((y * 5) >> 4)) * 37 + (x ^ y)) & 255;
      const got: unknown[] = [], want: unknown[] = [];
      let pose = { x: 0, y: 0 };
      for (let frame = 0; frame < 40; frame++) {
        pose = { x: pose.x + (frame % 7 === 3 ? -13.5 : 2.25), y: pose.y + (frame < 20 ? 31.5 : -47.25) + (frame % 5 === 0 ? .5 : 0) };
        const g: Gray = { width: aw, height: ah, data: new Uint8Array(aw * ah) };
        for (let y = 0; y < ah; y++) {
          for (let x = 0; x < aw; x++) {
            const overlay = y > ah * .4 && y < ah * .4 + 3 && x > aw * .1 && x < aw * .5;
            g.data[y * aw + x] = overlay
              ? 20
              : (world(Math.round(x + pose.x / factor), Math.round(y + pose.y / factor)) + ((x * y + frame) % 7 === 0 ? 30 : 0)) & 255;
          }
        }
        // Region b jumps canvases mid-run; region a skips some frames entirely.
        const canvasB = frame < 25 ? 'c0' : 'c1';
        let uploaded = false;
        if (frame % 9 !== 4) {
          ring.observe(0, 'c0', pose, g, uploaded);
          uploaded = true;
          reference.observe(regions[0], 'c0', pose, g);
        }
        if (frame % 11 !== 6) {
          ring.observe(1, canvasB, { x: -pose.x, y: pose.y * .5 }, g, uploaded);
          reference.observe(regions[1], canvasB, { x: -pose.x, y: pose.y * .5 }, g);
        }
        got.push(...ring.pushFrame(frame).map(toRecord));
        want.push(...reference.pushFrame(frame).map(toRecord));
      }
      got.push(...ring.drain().map(toRecord));
      want.push(...reference.drain().map(toRecord));
      assert(want.length >= 20, `expected evictions and drain to finalise frames (got ${want.length})`);
      assert(want.some((r: any) => r.record), 'the fixture should produce at least one verdict');
      assertEquals(got, want, `factor ${factor} noise ${noise}`);
    } finally {
      ring.free();
    }
  }
});

import { LayerLearner } from '../../src/core/layers.ts';
import { ReferenceLayerLearner } from '../support/reference/layers.ts';
import type { MotionField, Rect } from '../../src/types.ts';

/** Failure modes this must catch: the informative gate (unknown / low difference / slow or weak motions) accumulating
 *  anyway; f64 sums in a different order; Math.hypot vs libm hypot on the disagreement and norm gates; the row-change
 *  gate reading the CURRENT frame's informativeFrames; gain() with weight < 10, one model, many models, and its
 *  Math.max spread; the strongest-support tie (stable sort keeps motion order); native sampling steps for sizes that
 *  are not multiples of 480/300; a native size change being ignored; resident vs JS native frames; and finish()
 *  producing identical regions from the read-back accumulators. */
Deno.test('core parity: LayerLearner accumulators and regions match the frozen TS learner', async () => {
  const core = await ensureCore();
  const rnd = rng(0x1ea7);
  for (const [nativeW, nativeH, factor] of [[640, 400, 2], [1418, 1590, 3], [321, 97, 1]] as number[][]) {
    const aw = Math.ceil(nativeW / factor), ah = Math.ceil(nativeH / factor), cols = Math.ceil(aw / 24), rows = Math.ceil(ah / 24);
    const actual = new LayerLearner(aw, ah), expected = new ReferenceLayerLearner(aw, ah);
    const ring = core.frameRing(2, nativeW, nativeH);
    // A page scrolling under a fixed 60px header with a 40px footer; some frames are blank, unknown or paused.
    const native = (shift: number, blank: boolean): RGBA => {
      const data = new Uint8ClampedArray(nativeW * nativeH * 4);
      for (let y = 0; y < nativeH; y++) {
        const fixed = y < 60 || y >= nativeH - 40, sy = fixed ? y : y + shift;
        for (let x = 0; x < nativeW; x++) {
          const v = blank && !fixed
            ? 240
            : fixed
            ? (x % 37 < 5 ? 20 : 200)
            : ((((x * 5) >> 4) + ((sy * 7) >> 5)) * 53 + ((x ^ sy) & 15)) & 255;
          data.set([v, (v * 3) & 255, 255 - v, 255], (y * nativeW + x) * 4);
        }
      }
      return { width: nativeW, height: nativeH, data };
    };
    const gray = (img: RGBA): Gray => core.downscaleGray(img, factor);
    const field = (kind: number, frame: number): MotionField => {
      const n = cols * rows, labels = new Uint8Array(n), confidence = new Uint8Array(n), dynamic = new Uint8Array(n);
      const models = kind === 3 ? 1 : 2 + (frame % 3);
      for (let i = 0; i < n; i++) {
        const y = Math.floor(i / cols);
        labels[i] = y < 3 ? 0 : (i % models);
        confidence[i] = 60 + Math.floor(rnd() * 196);
        dynamic[i] = rnd() < .05 ? 1 : 0;
      }
      const motions = Array.from({ length: models }, (_, m) => ({
        x: m === 0 ? 0 : (m % 2 ? 0.3 : 0) + rnd() * .2,
        y: m === 0 ? 0 : 6 + m * 1.5 + rnd(),
        support: m === 0 ? 40 : 30 + (m % 2 ? 0 : 10), // a support tie between two moving models
        unique: 10,
        confidence: kind === 2 ? .2 : .9,
        error: 1,
        ambiguous: false,
      }));
      return {
        motions,
        labels,
        confidence,
        dynamic,
        cols,
        rows,
        cell: 24,
        difference: kind === 1 ? .1 : .6,
        featureCount: 100,
        unknown: kind === 4,
        zoom: 1,
      };
    };
    let prevImage = native(0, false), prevGray = gray(prevImage);
    ring.upload(0, prevImage);
    for (let frame = 1; frame <= 9; frame++) {
      // Informative fields interleaved with every rejected kind (low difference, weak, motionless, unknown).
      const image = native(frame * 7, frame === 5), g = gray(image), f = field([0, 1, 0, 2, 0, 3, 0, 4, 0][frame - 1], frame);
      const resident = ring.upload(frame, image), prevResident = ring.get(frame - 1)!;
      // Alternate resident and JS-side natives; frame 4 passes a mismatched native size that must be ignored.
      const odd = frame % 2 === 1;
      const mismatched = frame === 4 ? { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } : undefined;
      actual.add(f, prevGray, g, mismatched ?? (odd ? prevResident : prevImage), odd ? resident : image);
      expected.add(f, prevGray, g, mismatched ?? prevImage, image);
      prevImage = image;
      prevGray = g;
    }
    const acc = (actual as unknown as { acc: Record<string, Float64Array | number> }).acc;
    for (
      const name of [
        'split',
        'evidence',
        'activity',
        'observations',
        'rowFixed',
        'rowMoving',
        'rowChange',
        'colChange',
        'colMean',
        'colGain',
        'horizontalGain',
        'nativeRowChange',
        'nativeColChange',
        'nativeColMean',
      ] as const
    ) {
      const want = (expected as unknown as Record<string, Float64Array | undefined>)[name];
      assertEquals(
        acc[name] === undefined ? undefined : [...(acc[name] as Float64Array)],
        want && [...want],
        `${nativeW}×${nativeH} f${factor} ${name}`,
      );
    }
    assertEquals(acc.informativeFrames, expected.informativeFrames);
    assertEquals(acc.nativeFrames, expected.nativeFrames);
    assert(
      (acc.informativeFrames as number) >= 3 && (acc.informativeFrames as number) < 9,
      `the gate must reject some frames and accept others (${acc.informativeFrames})`,
    );
    ring.free();
    // finish() is unchanged TS, but it now runs on read-back accumulators: the regions must be identical to those a
    // learner with the frozen accumulation (and the same reference frame) would build.
    const frozen = new LayerLearner(aw, ah) as unknown as { snapshot: unknown; reference: RGBA; handle?: { free(): void } };
    frozen.handle?.free();
    frozen.handle = undefined;
    frozen.snapshot = {
      split: expected.split,
      evidence: expected.evidence,
      activity: expected.activity,
      observations: expected.observations,
      rowFixed: expected.rowFixed,
      rowMoving: expected.rowMoving,
      rowChange: expected.rowChange,
      colChange: expected.colChange,
      colMean: expected.colMean,
      colGain: expected.colGain,
      horizontalGain: expected.horizontalGain,
      nativeRowChange: expected.nativeRowChange,
      nativeColChange: expected.nativeColChange,
      nativeColMean: expected.nativeColMean,
      informativeFrames: expected.informativeFrames,
      nativeFrames: expected.nativeFrames,
    };
    frozen.reference = expected.reference!;
    const strip = (regions: Region[]) => regions.map((r) => ({ ...r, mask: r.mask && [...r.mask] }));
    assertEquals(
      strip(actual.finish(nativeW, nativeH, [], factor)),
      strip((frozen as unknown as LayerLearner).finish(nativeW, nativeH, [], factor)),
      `${nativeW}×${nativeH} f${factor} regions`,
    );
  }
});

import { stationaryBoundary, stickyOcclusions } from '../../src/core/layers.ts';
import * as chromeReference from '../support/reference/chrome.ts';

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
