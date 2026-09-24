/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import { LayerLearner, RegionAtlas } from '../../../src/core/layers.ts';
import { type FinishAccumulators, referenceFinish, referenceLabelAtlas, ReferenceLayerLearner } from '../../support/reference/layers.ts';
import type { Gray, MotionField, Rect, Region, RGBA } from '../../../src/types.ts';

/** Strips masks to plain arrays (Uint8Array does not assertEquals-compare by value) and drops `undefined` keys
 *  Deno's structural comparison treats as absent either way, so a byte-exact key-order check happens separately. */
function strip(regions: Region[]): unknown[] {
  return regions.map((r) => ({ ...r, mask: r.mask && [...r.mask] }));
}
function keyOrder(regions: Region[]): string[][] {
  return regions.map((r) => Object.keys(r));
}

/** Failure modes this must catch: `finishRegions`'s wire encoding (id/name synthesis from role + index, the
 *  `bandSide` extra key, `cells` absent for the divider vs `[]` for a band-created fixed region vs the group's
 *  own list, mask/crop/solid), the arena aliasing a second `scratch()` call could silently break, and the
 *  manual-region branch's one Rust step (uncovered-pixel detection) disagreeing with a per-pixel TS scan. */
Deno.test('core parity: finishRegions matches the frozen oracle over real learner accumulators', async () => {
  const core = await ensureCore();
  const rnd = rng(0x9a71);
  for (
    const [nativeW, nativeH, factor] of [[640, 400, 2], [1418, 1590, 3], [321, 97, 1], [3843, 1802, 6]] as number[][]
  ) {
    const aw = Math.ceil(nativeW / factor), ah = Math.ceil(nativeH / factor), cols = Math.ceil(aw / 24), rows = Math.ceil(ah / 24);
    const actual = new LayerLearner(aw, ah), expected = new ReferenceLayerLearner(aw, ah);
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
        support: m === 0 ? 40 : 30 + (m % 2 ? 0 : 10),
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
    for (let frame = 1; frame <= 9; frame++) {
      const image = native(frame * 9, frame === 5), g = gray(image), f = field([0, 1, 0, 2, 0, 3, 0, 4, 0][frame - 1], frame);
      actual.add(f, prevGray, g, prevImage, image);
      expected.add(f, prevGray, g, prevImage, image);
      prevImage = image;
      prevGray = g;
    }
    const acc: FinishAccumulators = {
      width: aw,
      height: ah,
      cell: 24,
      cols,
      rows,
      informativeFrames: expected.informativeFrames,
      nativeFrames: expected.nativeFrames,
      rowChange: expected.rowChange,
      colChange: expected.colChange,
      colMean: expected.colMean,
      colGain: expected.colGain,
      horizontalGain: expected.horizontalGain,
      split: expected.split,
      evidence: expected.evidence,
      activity: expected.activity,
      observations: expected.observations,
      nativeRowChange: expected.nativeRowChange,
      nativeColChange: expected.nativeColChange,
      reference: expected.reference,
    };
    const oracleRegions = referenceFinish(acc, nativeW, nativeH, [], factor);
    const coreRegions = actual.finish(nativeW, nativeH, [], factor);
    assertEquals(strip(coreRegions), strip(oracleRegions), `${nativeW}×${nativeH} f${factor} regions`);
    assertEquals(keyOrder(coreRegions), keyOrder(oracleRegions), `${nativeW}×${nativeH} f${factor} key order (persisted row shape)`);
    assert(oracleRegions.length > 0, 'sanity: the harness must actually exercise some regions');

    const atlasCore = new RegionAtlas(coreRegions, nativeW, nativeH);
    try {
      const atlasOracle = referenceLabelAtlas(oracleRegions, nativeW, nativeH);
      assertEquals([...atlasCore.labels], [...atlasOracle], `${nativeW}×${nativeH} f${factor} atlas labels`);
    } finally {
      atlasCore.dispose();
    }
  }
});

/** Random accumulators directly (bypassing the learner) so the port is exercised on inputs a synthetic scenario
 *  would rarely land on exactly: 1×1 and odd analysis grids, every factor 1..4, a fully blank (zero-frame) run,
 *  and — separately — a run with a reference frame, which exercises `middleMean`/`textured`/`stationaryBoundary`. */
Deno.test('core parity: finishRegions matches the frozen oracle on randomized and edge accumulators', async () => {
  const core = await ensureCore();
  const rnd = rng(0xf00d);
  const rand = (n: number, scale: number) => Float64Array.from({ length: n }, () => rnd() * scale);
  const cases: { width: number; height: number; factor: number; nativeW: number; nativeH: number; frames: number; withRef: boolean }[] = [
    { width: 1, height: 1, factor: 1, nativeW: 1, nativeH: 1, frames: 0, withRef: false },
    { width: 1, height: 1, factor: 3, nativeW: 3, nativeH: 3, frames: 5, withRef: false },
    { width: 7, height: 5, factor: 2, nativeW: 14, nativeH: 10, frames: 0, withRef: false },
    { width: 37, height: 29, factor: 1, nativeW: 37, nativeH: 29, frames: 12, withRef: false },
    { width: 61, height: 40, factor: 4, nativeW: 244, nativeH: 160, frames: 8, withRef: true },
    { width: 100, height: 64, factor: 2, nativeW: 203, nativeH: 129, frames: 6, withRef: true },
  ];
  for (const c of cases) {
    const cell = 24, cols = Math.ceil(c.width / cell), rows = Math.ceil(c.height / cell), n = cols * rows;
    const informativeFrames = c.frames, nativeFrames = c.withRef ? c.frames : 0;
    const reference: RGBA | undefined = c.withRef
      ? {
        width: c.nativeW,
        height: c.nativeH,
        data: Uint8ClampedArray.from({ length: c.nativeW * c.nativeH * 4 }, () => Math.floor(rnd() * 256)),
      }
      : undefined;
    const acc: FinishAccumulators = {
      width: c.width,
      height: c.height,
      cell,
      cols,
      rows,
      informativeFrames,
      nativeFrames,
      rowChange: rand(c.height, informativeFrames + 1),
      colChange: rand(c.width, informativeFrames + 1),
      colMean: rand(c.width, informativeFrames * 255),
      colGain: rand(cols, informativeFrames * .2),
      horizontalGain: rand(rows, informativeFrames * .2),
      split: rand(n * 2, informativeFrames + 1),
      evidence: rand(n * 2, informativeFrames + 1),
      activity: rand(n, informativeFrames * 3),
      observations: rand(n, informativeFrames + 1),
      nativeRowChange: c.withRef ? rand(c.nativeH, nativeFrames + 1) : undefined,
      nativeColChange: c.withRef ? rand(c.nativeW, nativeFrames + 1) : undefined,
      reference,
    };
    const oracleRegions = referenceFinish(acc, c.nativeW, c.nativeH, [], c.factor);
    const coreRegions = core.finishRegions(
      c.width,
      c.height,
      cell,
      acc,
      c.nativeW,
      c.nativeH,
      c.factor,
      reference,
    );
    const label = `${c.width}×${c.height} native ${c.nativeW}×${c.nativeH} f${c.factor} frames=${c.frames} ref=${c.withRef}`;
    assertEquals(strip(coreRegions), strip(oracleRegions), `${label} regions`);
    assertEquals(keyOrder(coreRegions), keyOrder(oracleRegions), `${label} key order`);
    const { resident, counts } = core.labelAtlasResident(coreRegions, c.nativeW, c.nativeH);
    try {
      const atlasOracle = referenceLabelAtlas(oracleRegions, c.nativeW, c.nativeH);
      assertEquals([...resident.bytes()], [...atlasOracle], `${label} atlas labels`);
      const expectedCounts = new Uint32Array(coreRegions.length + 1);
      for (const code of atlasOracle) if (code) expectedCounts[code]++;
      assertEquals([...counts], [...expectedCounts], `${label} atlas counts`);
    } finally {
      resident.free();
    }
  }
});

/** Manual regions (the `finish(..., manual, ...)` branch): plain passthrough, an ignored region excluded from
 *  every sibling, overlapping rects (later ones win per `regionContains`'s first-match order preserved through
 *  `exclusions`), and full coverage vs. a gap that must produce the synthetic "unassigned" region. */
Deno.test('core parity: manual regions (kind combinations, overlap, full coverage) match the frozen oracle', async () => {
  await ensureCore();
  const learner = new LayerLearner(10, 10);
  const nativeW = 40, nativeH = 30;
  const cases: Region[][] = [
    [{ id: 'a', name: 'A', kind: 'moving', rect: { x: 0, y: 0, width: nativeW, height: nativeH } }],
    [
      { id: 'a', name: 'A', kind: 'moving', rect: { x: 0, y: 0, width: 20, height: nativeH } },
      { id: 'b', name: 'B', kind: 'fixed', rect: { x: 20, y: 0, width: 20, height: nativeH } },
    ],
    [
      { id: 'a', name: 'A', kind: 'moving', rect: { x: 0, y: 0, width: 25, height: nativeH } },
      { id: 'b', name: 'B', kind: 'ignore', rect: { x: 15, y: 0, width: 25, height: nativeH } },
    ],
    [
      { id: 'a', name: 'A', kind: 'moving', rect: { x: 0, y: 0, width: 30, height: 20 } },
      { id: 'b', name: 'B', kind: 'moving', rect: { x: 10, y: 5, width: 30, height: 20 } },
    ],
    // A gap nothing covers must synthesize the "未指定区域" fallback region.
    [{ id: 'a', name: 'A', kind: 'moving', rect: { x: 0, y: 0, width: 10, height: 10 } }],
  ];
  for (const manual of cases) {
    const acc: FinishAccumulators = {
      width: 10,
      height: 10,
      cell: 24,
      cols: 1,
      rows: 1,
      informativeFrames: 0,
      nativeFrames: 0,
      rowChange: new Float64Array(10),
      colChange: new Float64Array(10),
      colMean: new Float64Array(10),
      colGain: new Float64Array(1),
      horizontalGain: new Float64Array(1),
      split: new Float64Array(2),
      evidence: new Float64Array(2),
      activity: new Float64Array(1),
      observations: new Float64Array(1),
    };
    const oracleRegions = referenceFinish(acc, nativeW, nativeH, manual, 4);
    const coreRegions = learner.finish(nativeW, nativeH, manual, 4);
    assertEquals(strip(coreRegions), strip(oracleRegions), JSON.stringify(manual));
    assertEquals(keyOrder(coreRegions), keyOrder(oracleRegions), `key order: ${JSON.stringify(manual)}`);
  }
});

/** RegionAtlas labelling in isolation: exclusions, crop, solid, and a non-solid mask looked up at floor(x/factor),
 *  including the final partial analysis cell — every branch `regionContains`/`region::Region::contains` has. */
Deno.test('core parity: labelAtlas matches the frozen oracle for hand-built region sets', async () => {
  const core = await ensureCore();
  const width = 12, height = 9, factor = 3, nativeWidth = width * factor + 2, nativeHeight = height * factor + 1;
  const maskA = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) maskA[y * width + x] = x < width / 2 ? 1 : 0;
  const exclusion: Rect = { x: 2 * factor, y: 2 * factor, width: 3 * factor, height: 3 * factor };
  const regions: Region[] = [
    {
      id: 'moving',
      name: 'moving',
      kind: 'moving',
      rect: { x: 0, y: 0, width: nativeWidth, height: nativeHeight },
      mask: maskA,
      maskWidth: width,
      maskHeight: height,
      factor,
      exclusions: [exclusion],
    },
    {
      id: 'fixed-solid',
      name: 'fixed',
      kind: 'fixed',
      rect: { x: 0, y: 0, width: nativeWidth, height: nativeHeight },
      solid: true,
      crop: { x: nativeWidth - 5, y: 0, width: 5, height: nativeHeight },
    },
    {
      id: 'ignored',
      name: 'ignore',
      kind: 'ignore',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
  ];
  const { resident, counts } = core.labelAtlasResident(regions, nativeWidth, nativeHeight);
  try {
    const atlasOracle = referenceLabelAtlas(regions, nativeWidth, nativeHeight);
    const atlasCore = resident.bytes();
    assertEquals([...atlasCore], [...atlasOracle]);
    // Regenerate the moving region's mask so it never fires (fully excluded); the fixed-solid crop then owns
    // everything the exclusion left over.
    assert(atlasCore.some((v) => v === 2), 'the solid fixed region must own its crop');
    const expectedCounts = new Uint32Array(regions.length + 1);
    for (const code of atlasOracle) if (code) expectedCounts[code]++;
    assertEquals([...counts], [...expectedCounts], 'atlas counts match a fresh scan of the label plane');
  } finally {
    resident.free();
  }
});
