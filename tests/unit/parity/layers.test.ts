/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import type { Gray, Region, RGBA } from '../../../src/types.ts';
import { LayerLearner } from '../../../src/core/layers.ts';
import { ReferenceLayerLearner } from '../../support/reference/layers.ts';
import type { MotionField } from '../../../src/types.ts';

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
