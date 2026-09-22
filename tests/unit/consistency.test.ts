import { assert, assertEquals } from '@std/assert';
import { pad } from '../../src/core/math.ts';
import { constantFrames, fillRGBA, World } from '../../src/synthetic/world.ts';
import type { Layer, Overlay, RGB, Scenario } from '../../src/synthetic/world.ts';
import { runScenario } from '../support/run.ts';
import { Engine } from '../../src/pipeline/engine.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { DEFAULT_SETTINGS, type RGBA } from '../../src/types.ts';
import { DECODED_VIDEO_NOISE } from '../../src/media/source.ts';
import {
  consistencyMaskReference,
  type ConsistencyReferenceNeighbour,
  type ConsistencyReferenceVote,
} from '../support/consistency-reference.ts';

function consistencyRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    return ((state ^ state >>> 14) >>> 0) / 4294967296;
  };
}

function consistencyRandomInt(random: () => number, max: number): number {
  return Math.floor(random() * max);
}

function randomConsistencyImage(random: () => number, width: number, height: number): RGBA {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = consistencyRandomInt(random, 256);
    data[i + 1] = consistencyRandomInt(random, 256);
    data[i + 2] = consistencyRandomInt(random, 256);
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function randomConsistencyVote(random: () => number, width: number, height: number, factor: number): ConsistencyReferenceVote {
  const w = Math.max(1, Math.ceil(width / factor) + consistencyRandomInt(random, 3) - 1);
  const h = Math.max(1, Math.ceil(height / factor) + consistencyRandomInt(random, 3) - 1);
  const bytes = Math.ceil(w * h / 8), bits = new Uint8Array(bytes), clean = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    bits[i] = consistencyRandomInt(random, 256);
    clean[i] = consistencyRandomInt(random, 256);
  }
  return {
    x0: consistencyRandomInt(random, 5) - 2,
    y0: consistencyRandomInt(random, 5) - 2,
    w,
    h,
    bits,
    clean,
  };
}

function randomConsistencyNeighbour(
  random: () => number,
  width: number,
  height: number,
  factor: number,
  image: RGBA,
): ConsistencyReferenceNeighbour | undefined {
  if (consistencyRandomInt(random, 4) === 0) return undefined;
  const occlusions = consistencyRandomInt(random, 3) === 0
    ? Array.from({ length: consistencyRandomInt(random, 3) }, () => ({
      x: consistencyRandomInt(random, width + 5) - 2,
      y: consistencyRandomInt(random, height + 5) - 2,
      width: consistencyRandomInt(random, 8),
      height: consistencyRandomInt(random, 8),
    }))
    : undefined;
  return {
    image,
    x: consistencyRandomInt(random, 13) - 6 + (random() < .5 ? -.49 : .49),
    y: consistencyRandomInt(random, 13) - 6 + (random() < .5 ? -.49 : .49),
    canvasId: consistencyRandomInt(random, 3) === 0 ? 'other' : 'canvas',
    occlusions,
    voting: consistencyRandomInt(random, 3) === 0 ? randomConsistencyVote(random, width, height, factor) : undefined,
  };
}

// This intentionally compares the optimized private method with a frozen copy of its former implementation,
// rather than asserting a handful of hand-picked pixels. It exercises raster rounding, atlas boundaries, voting,
// noise, occlusions, fractional analysis factors, and all neighbour/canvas combinations together.
Deno.test('consistency mask: optimized raster loop is byte-exact against the frozen implementation', () => {
  const random = consistencyRandom(0x5eedcafe);
  const source = new ScenarioSource(buildScenario('fixture'));
  source.info.noise = 3;
  const engine = new Engine(new MemoryKV(), source, DEFAULT_SETTINGS, {
    progress: () => {},
    diagnostic: () => {},
    preview: () => {},
    project: () => {},
  });
  const mask = (engine as unknown as { consistencyMask: (...args: unknown[]) => Uint8Array }).consistencyMask.bind(engine);
  for (let trial = 0; trial < 180; trial++) {
    const width = 1 + consistencyRandomInt(random, 72),
      height = 1 + consistencyRandomInt(random, 64),
      factor = 1 + consistencyRandomInt(random, 4);
    const region = {
      id: 'body',
      name: 'body',
      kind: 'moving' as const,
      rect: {
        x: consistencyRandomInt(random, width + 3) - 1,
        y: consistencyRandomInt(random, height + 3) - 1,
        width: 1 + consistencyRandomInt(random, width + 2),
        height: 1 + consistencyRandomInt(random, height + 2),
      },
    };
    const atlas = new RegionAtlas([region], width, height), code = atlas.code(region);
    const current = randomConsistencyImage(random, width, height),
      previousImage = randomConsistencyImage(random, width, height),
      nextImage = randomConsistencyImage(random, width, height);
    const pose = {
      x: consistencyRandomInt(random, 13) - 6 + (random() < .5 ? -.49 : .49),
      y: consistencyRandomInt(random, 13) - 6 + (random() < .5 ? -.49 : .49),
    };
    const prev = randomConsistencyNeighbour(random, width, height, factor, previousImage);
    const next = randomConsistencyNeighbour(random, width, height, factor, nextImage);
    const voting = consistencyRandomInt(random, 3) === 0 ? randomConsistencyVote(random, width, height, factor) : undefined;
    (engine as unknown as { factor: number }).factor = factor;
    const actual = mask(current, atlas, region, code, pose, 'canvas', prev, next, voting);
    const expected = consistencyMaskReference(current, atlas, region, code, pose, 'canvas', prev, next, voting, factor, 3);
    assertEquals(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new Error(`consistency mask diverged in trial ${trial} at pixel ${i} (${actual[i]} !== ${expected[i]})`);
      }
    }
  }
});

// Displacement-spread consistency voting (docs/ARCHITECTURE.md §七, Engine.solve()'s consistencyRing/consistencyCompare/
// consistencyFinalize). Fixture: a scrolling photo-like page under a screen-fixed, uniformly-coloured blob taller
// (40px) than the per-frame scroll displacement (8px) — exactly the geometry a ±1-frame comparison alone cannot
// resolve (docs/ARCHITECTURE.md §七), which the ring's Dmin-qualifying, displacement-spread partners are meant to close.
Deno.test("consistency voting: a screen-fixed blob taller than one frame's displacement is flagged by a middle frame; the page under it never is", async () => {
  const W = 240, VH = 200, WORLD_H = 800, BLOB = { y: 60, height: 40 };
  const world = new World(W, WORLD_H, [40, 40, 40]);
  world.picture({ x: 0, y: 0, width: W, height: WORLD_H }, 777);
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < 24; i++) path.push({ x: 0, y: i * 8 });
  const layer: Layer = { id: 'body', viewport: { x: 0, y: 0, width: W, height: VH }, world, path };
  const blob: Overlay = {
    id: 'blob',
    kind: 'fixed',
    draw: (frame) => {
      const r = { x: 0, y: BLOB.y, width: W, height: BLOB.height };
      fillRGBA(frame, r, [255, 0, 255]);
      return [r];
    },
  };
  const scenario: Scenario = {
    name: 'consistency-voting-fixture',
    description: 'unit test fixture for displacement-spread consistency voting',
    width: W,
    height: VH,
    layers: [layer],
    overlays: [blob],
    frames: constantFrames(path.length),
    background: [40, 40, 40],
    expect: {
      fragments: {},
      diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
      maxError: 0,
      status: 'complete',
    },
  };
  const result = await runScenario(scenario, {});
  assertEquals(result.project.status, 'complete');
  assertEquals(
    result.engine.factor,
    1,
    'this fixture is small enough that analysis stays at native resolution, isolating voting from analysis-resolution quantization',
  );
  // A comfortably middle frame (index 15 of 24): early enough to have plenty of later ring partners, late enough
  // that a wide spread of past displacements is already available.
  const record = await result.store.get<Record<string, { x0: number; y0: number; w: number; h: number; bits: Uint8Array }>>(
    `consistency/${pad(15)}`,
  );
  assert(record, 'a mid-run frame under a persistent screen-fixed overlay must have a consistency record');
  const [regionId] = Object.keys(record);
  const { y0, w, h, bits } = record[regionId];
  let blobFlags = 0, pageFlags = 0;
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const i = ly * w + lx;
      if (!(bits[i >> 3] & (1 << (i & 7)))) {
        continue;
      }
      const ay = y0 + ly;
      if (ay >= BLOB.y && ay < BLOB.y + BLOB.height) {
        blobFlags++;
      } else {
        pageFlags++;
      }
    }
  }
  assert(blobFlags > 0, 'the blob interior must be flagged inconsistent by this frame');
  assertEquals(pageFlags, 0, 'genuine page content outside the blob must never be flagged inconsistent');
});

// Direction A (fair partner sharing, Engine.solve()'s consistencyPartners): a frame whose own arrival can only
// compare it against PAST frames must still accumulate comparisons from the future ones that pick it as a partner,
// or a world position first seen at the leading edge can never be judged. The engine reports this directly:
// `consistencyThinLayers` counts per-frame, per-region voting layers finalised on fewer than the comparisons a
// positive verdict needs. Picking partners by displacement spread alone left a long tail of such layers; picking
// the fairest candidate inside each displacement band removes it.
Deno.test('consistency voting: every frame accumulates comparisons, including ones whose clean counterparts are all in the future', async () => {
  const W = 240, VH = 200, WORLD_H = 900;
  const world = new World(W, WORLD_H, [40, 40, 40]);
  world.picture({ x: 0, y: 0, width: W, height: WORLD_H }, 991);
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < 34; i++) path.push({ x: 0, y: i * 12 });
  const layer: Layer = { id: 'body', viewport: { x: 0, y: 0, width: W, height: VH }, world, path };
  // A screen-fixed band low in the viewport: a world position first enters the view UNDER it, so no past frame
  // ever saw that position at all, let alone clean — only later frames can supply its comparisons.
  const blob: Overlay = {
    id: 'blob',
    kind: 'fixed',
    draw: (frame) => {
      const r = { x: 0, y: VH - 60, width: W, height: 36 };
      fillRGBA(frame, r, [255, 0, 255]);
      return [r];
    },
  };
  const scenario: Scenario = {
    name: 'consistency-fairness-fixture',
    description: 'unit test fixture for fair consistency-voting partner selection',
    width: W,
    height: VH,
    layers: [layer],
    overlays: [blob],
    frames: constantFrames(path.length),
    background: [40, 40, 40],
    expect: {
      fragments: {},
      diagnostics: { present: [], absent: ['PROCESSING_ERROR', 'NONFINITE_POSE'] },
      maxError: 0,
      status: 'complete',
    },
  };
  const result = await runScenario(scenario, {});
  assertEquals(result.project.status, 'complete');
  const performance = await result.store.get<{ consistencyVotedLayers: number; consistencyThinLayers: number }>('performance');
  assert(performance, 'the run must report its voting bookkeeping');
  assertEquals(performance.consistencyVotedLayers, path.length, 'every frame contributes one voting layer for this single moving region');
  assertEquals(performance.consistencyThinLayers, 0, 'no frame may be finalised on too few partner comparisons to hold a verdict');
  // The overlay band is only ever seen at the leading edge on its way in, so catching it at all depends on those
  // later-arriving comparisons; a frame in the middle of the run must still flag it.
  let flagged = 0;
  for (let index = 6; index < path.length - 6; index++) {
    const record = await result.store.get<
      Record<string, { x0: number; y0: number; w: number; h: number; bits: Uint8Array; clean: Uint8Array }>
    >(`consistency/${pad(index)}`);
    const region = record && Object.values(record)[0];
    if (!region) continue;
    for (let ly = 0; ly < region.h; ly++) {
      for (let lx = 0; lx < region.w; lx++) {
        const i = ly * region.w + lx, ay = region.y0 + ly;
        if (region.bits[i >> 3] & (1 << (i & 7)) && ay >= VH - 60 && ay < VH - 24) flagged++;
      }
    }
  }
  assert(
    flagged > 0,
    'the screen-fixed band must be flagged somewhere in the run despite only future frames ever seeing those world positions clean',
  );
});

// Direction B (Engine.consistencyMask()'s truth table): a ±1-frame comparison is a PAIRWISE disagreement — it says
// one of the two frames is wrong, not which. When a pixel has only ONE comparable neighbour and voting independently
// found that neighbour inconsistent at the same world position, the disagreement is the neighbour's, and this frame
// must stay consistent so it can still heal what the neighbour left provisional. The run's last frame is where that
// matters most: nothing comes after it.
Deno.test('consistency mask: a lone neighbour that voting itself found inconsistent does not condemn this frame', async () => {
  const W = 200, H = 160, world = new World(W, H, [250, 250, 246]);
  world.picture({ x: 0, y: 0, width: W, height: H }, 31);
  const atlas = new RegionAtlas([{ id: 'body', name: 'body', kind: 'moving', rect: { x: 0, y: 0, width: W, height: H } }], W, H);
  const region = atlas.regions[0], code = atlas.code(region);
  const frame = (fill?: RGB): RGBA => {
    const image: RGBA = { width: W, height: H, data: world.data.slice() };
    if (fill) fillRGBA(image, { x: 40, y: 40, width: 40, height: 40 }, fill);
    return image;
  };
  const engine = new Engine(new MemoryKV(), new ScenarioSource(buildScenario('fixture')), DEFAULT_SETTINGS, {
    progress: () => {},
    diagnostic: () => {},
    preview: () => {},
    project: () => {},
  });
  const mask = (engine as unknown as { consistencyMask: (...args: unknown[]) => Uint8Array }).consistencyMask.bind(engine);
  (engine as unknown as { factor: number }).factor = 1;
  const clean = frame(), dirty = frame([255, 0, 255]);
  const box = { x0: 0, y0: 0, w: W, h: H, bits: new Uint8Array(Math.ceil(W * H / 8)), clean: new Uint8Array(Math.ceil(W * H / 8)) };
  const cell = 50 * W + 50;
  box.bits[cell >> 3] |= 1 << (cell & 7);
  const pose = { x: 0, y: 0 }, neighbour = { image: dirty, x: 0, y: 0, canvasId: 'c' };
  // Without a verdict for the neighbour, the conservative reading stands and this frame is flagged.
  const blind = mask(clean, atlas, region, code, pose, 'c', neighbour, undefined, undefined);
  assertEquals(blind[cell], 0, 'a lone disagreeing neighbour with no verdict of its own still condemns');
  // With voting saying the neighbour itself is inconsistent there, the disagreement is the neighbour's fault.
  const informed = mask(clean, atlas, region, code, pose, 'c', { ...neighbour, voting: box }, undefined, undefined);
  assertEquals(informed[cell], 1, 'a lone neighbour voting found inconsistent must not condemn this frame');
  // Two comparable neighbours are enough evidence on their own: the excuse is only for the ambiguous lone case.
  const both = mask(clean, atlas, region, code, pose, 'c', { ...neighbour, voting: box }, { ...neighbour, voting: box }, undefined);
  assertEquals(both[cell], 0, 'with two comparable neighbours the conservative reading stands');
});

// The comparison tolerance is a property of the SOURCE (MediaInfo.noise), not a constant. A lossless source is
// compared exactly, which is the only reason contamination whose colour sits within a decoded recording's noise
// floor — a white [255,255,255] overlay glyph over a [251,250,246] page, a mean |ΔRGB| of 6 — can be seen at all.
Deno.test('consistency mask: the ±1 tolerance comes from the source, so a lossless run sees sub-noise-floor contamination', async () => {
  const W = 120, H = 100, world = new World(W, H, [251, 250, 246]);
  world.picture({ x: 0, y: 0, width: W, height: H }, 17);
  const atlas = new RegionAtlas([{ id: 'body', name: 'body', kind: 'moving', rect: { x: 0, y: 0, width: W, height: H } }], W, H);
  const region = atlas.regions[0], code = atlas.code(region);
  const page: RGBA = { width: W, height: H, data: world.data.slice() };
  // The page under the glyph is the scenario background; the overlay paints pure white over it.
  const withGlyph: RGBA = { width: W, height: H, data: world.data.slice() };
  fillRGBA(page, { x: 40, y: 40, width: 20, height: 20 }, [251, 250, 246]);
  fillRGBA(withGlyph, { x: 40, y: 40, width: 20, height: 20 }, [255, 255, 255]);
  const cell = 50 * W + 50;
  const delta = (Math.abs(255 - 251) + Math.abs(255 - 250) + Math.abs(255 - 246)) / 3;
  assert(
    delta > 0 && delta <= 10,
    `this fixture is only meaningful while the glyph sits inside a decoded recording's noise floor (measured ${delta})`,
  );
  const run = async (noise: number): Promise<Uint8Array> => {
    const scenario = buildScenario('fixture'), source = new ScenarioSource(scenario);
    source.info.noise = noise;
    const engine = new Engine(new MemoryKV(), source, DEFAULT_SETTINGS, {
      progress: () => {},
      diagnostic: () => {},
      preview: () => {},
      project: () => {},
    });
    (engine as unknown as { factor: number }).factor = 1;
    const mask = (engine as unknown as { consistencyMask: (...args: unknown[]) => Uint8Array }).consistencyMask.bind(engine);
    return mask(withGlyph, atlas, region, code, { x: 0, y: 0 }, 'c', { image: page, x: 0, y: 0, canvasId: 'c' }, undefined, undefined);
  };
  assertEquals((await run(0))[cell], 0, 'a lossless source compares exactly, so the glyph is flagged');
  assertEquals(
    (await run(DECODED_VIDEO_NOISE))[cell],
    1,
    'a decoded recording must keep its headroom: the same difference is within H.264 noise and carries no information',
  );
  // And the wiring the engine actually uses, rather than the override this test injects.
  assertEquals(new ScenarioSource(buildScenario('fixture')).info.noise, 0, 'a synthetic scenario is lossless');
  assertEquals(
    new Engine(new MemoryKV(), new ScenarioSource(buildScenario('fixture')), DEFAULT_SETTINGS, {
      progress: () => {},
      diagnostic: () => {},
      preview: () => {},
      project: () => {},
    }).noise,
    0,
    'the engine reads it from the source',
  );
});
