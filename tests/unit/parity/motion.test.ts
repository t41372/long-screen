/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import * as reference from '../../support/reference/kernels.ts';
import type { Gray } from '../../../src/types.ts';
import * as motionReference from '../../support/reference/motion.ts';
import { RegionAtlas } from '../../../src/core/layers.ts';
import { extractPatches } from '../../../src/core/motion.ts';
import { rgbaOf, textureGray } from '../../support/parity-fixtures.ts';

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
    try {
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
    } finally {
      atlas.dispose();
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
    // The solve pass keeps the frame and its luma plane in core memory. Ways that path could diverge from the JS
    // plane: a plane computed from the wrong frame or geometry, patch windows read at a wrong offset or stride
    // (the region origin is fractional here), a stale plane, or refinement reading from the wrong pointer.
    const frame = core.frame(w, h), plane = core.gray(w, h);
    try {
      frame.write(rb.data);
      core.grayscaleInto(frame, plane);
      assertEquals(plane.bytes(), native.data);
      const residentPatches = extractPatches(plane, region, fb.slice(0, 40), 1);
      assertEquals(residentPatches, motionReference.extractPatches(native, region, fb.slice(0, 40), 1));
      for (const guess of [{ x: -dx + .2, y: -dy }, { x: 5, y: -5 }]) {
        assertEquals(core.refinePatches(patches, plane, region, guess, 3), core.refinePatches(patches, native, region, guess, 3));
      }
      // Recomputed in place for the next frame, the plane follows it.
      frame.write(ra.data);
      core.grayscaleInto(frame, plane);
      assertEquals(plane.bytes(), reference.grayscale(ra.data, w, h).data);
    } finally {
      frame.free();
      plane.free();
    }
    for (const scale of [1.1, 1 / 1.25, 2, .5]) assertEquals(core.resampleGray(a, scale), motionReference.resampleGray(a, scale));
  }
});
