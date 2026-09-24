import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { extractFeatures, grayscale } from '../../src/core/features.ts';
import { extractPatches } from '../../src/core/motion.ts';
import { KeyframeIndex } from '../../src/core/keyframes.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import type { Gray } from '../../src/types.ts';
import { makeWorld } from '../../src/synthetic/world.ts';
Deno.test('keyframes: relocalization finds a revisit at native precision and refuses ambiguous repeats', async () => {
  const db = new MemoryKV(),
    warnings: string[] = [],
    index = new KeyframeIndex(db, async (m) => {
      warnings.push(m);
    });
  const page = makeWorld(900, 1400, 77, 'article'), g = grayscale(page.data, 900, 1400);
  const view = (x: number, y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) {
      data.set(g.data.subarray((y + row) * 900 + x, (y + row) * 900 + x + 640), row * 640);
    }
    return { width: 640, height: 400, data };
  };
  const region = { x: 0, y: 0, width: 640, height: 400 }, roi = region;
  for (const [frame, x, y] of [[0, 0, 0], [10, 0, 300], [20, 100, 700]] as [number, number, number][]) {
    const gray = view(x, y), features = extractFeatures(gray);
    await index.add({
      id: `body/${frame}`,
      node: `body-part-0/${frame}`,
      canvasId: 'body-part-0',
      layer: 'body',
      frame,
      features,
      gray,
      x,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  const current = view(37, 323), features = extractFeatures(current);
  const found = await index.find({ features, gray: current, native: current, layer: 'body', frame: 60, roi, region, factor: 1, radius: 3 });
  assert(found && !found.ambiguous, JSON.stringify(found && { ...found, keyframe: found.keyframe.id }));
  assertEquals([found!.keyframe.x + found!.offset.x, found!.keyframe.y + found!.offset.y], [37, 323]);
  assertEquals(
    await index.find({
      features: features.slice(0, 4),
      gray: current,
      native: current,
      layer: 'body',
      frame: 60,
      roi,
      region,
      factor: 1,
      radius: 3,
    }),
    undefined,
  );
  assertEquals(
    await index.find({ features, gray: current, native: current, layer: 'other', frame: 60, roi, region, factor: 1, radius: 3 }),
    undefined,
  );
  assertEquals(
    await index.find({
      features,
      gray: current,
      native: current,
      layer: 'body',
      frame: 11,
      roi,
      region,
      factor: 1,
      radius: 3,
      exclude: 'body/0',
      minGap: 20,
    }),
    undefined,
  );
  // Identical repeated rows: two keyframes one period apart both explain the observation.
  const list = makeWorld(900, 1400, 131, 'list'), lg = grayscale(list.data, 900, 1400);
  const lview = (y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) data.set(lg.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
    return { width: 640, height: 400, data };
  };
  const repeated = new KeyframeIndex(db, async () => {});
  for (const [frame, y] of [[0, 200], [30, 244], [60, 288]] as [number, number][]) {
    const gray = lview(y), f = extractFeatures(gray);
    await repeated.add({
      id: `list/${frame}`,
      node: `list-part-0/${frame}`,
      canvasId: 'list-part-0',
      layer: 'list',
      frame,
      features: f,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, f, 1),
    });
  }
  const probe = lview(222),
    match = await repeated.find({
      features: extractFeatures(probe),
      gray: probe,
      native: probe,
      layer: 'list',
      frame: 100,
      roi,
      region,
      factor: 1,
      radius: 3,
    });
  assert(!match || match.ambiguous, JSON.stringify(match && { ...match, keyframe: match.keyframe.id }));
});
Deno.test('keyframes: a densely keyframed long scroll spreads candidate retrieval across a 100+ posting and warns once per layer', async () => {
  const db = new MemoryKV(),
    warnings: string[] = [],
    index = new KeyframeIndex(db, async (m) => {
      warnings.push(m);
    });
  const region = { x: 0, y: 0, width: 640, height: 400 }, COUNT = 150, STEP = 3, BASE = 200;
  function sliding(seed: number): (y: number) => Gray {
    const page = makeWorld(900, 1400, seed, 'article'), g = grayscale(page.data, 900, 1400);
    return (y: number): Gray => {
      const data = new Uint8Array(640 * 400);
      for (let row = 0; row < 400; row++) {
        data.set(g.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
      }
      return { width: 640, height: 400, data };
    };
  }
  // A 3px-per-keyframe scroll over 150 keyframes: any word anchored to a stable piece of page content stays inside
  // the 400px-tall viewport (and so keeps appearing in that word's posting) for up to ~130 consecutive keyframes —
  // comfortably past both the 48-candidate forward budget and the 96-entry retrieval budget, on a single layer.
  const view = sliding(555);
  for (let i = 0; i < COUNT; i++) {
    const y = BASE + i * STEP, gray = view(y), features = extractFeatures(gray);
    await index.add({
      id: `body/${i}`,
      node: `body-part-0/${i}`,
      canvasId: 'body-part-0',
      layer: 'body',
      frame: i,
      features,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  // Revisit precisely where the LATE keyframe (index 120) was minted. A forward-only scan of an over-full posting
  // can only ever surface the earliest-indexed keyframes on a word this repetitive, so without the reverse "spread"
  // scan this revisit could never be matched against its true, late-indexed keyframe.
  const targetY = BASE + 120 * STEP, query = view(targetY), qf = extractFeatures(query);
  const found = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 1000,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(found && !found.ambiguous, JSON.stringify(found && { ...found, keyframe: found.keyframe.id }));
  assert(found!.keyframe.frame >= 60, `expected the late keyframe to be reachable as a candidate, got frame ${found!.keyframe.frame}`);
  assertEquals(warnings.length, 1, 'the repetitive-posting budget warning must fire exactly once');
  const found2 = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 1001,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(found2);
  assertEquals(warnings.length, 1, 'a second find() call on the same layer must not warn again');
  // A second layer, equally repetitive, gets its own independent single warning.
  const view2 = sliding(556);
  for (let i = 0; i < COUNT; i++) {
    const y = BASE + i * STEP, gray = view2(y), features = extractFeatures(gray);
    await index.add({
      id: `other/${i}`,
      node: `other-part-0/${i}`,
      canvasId: 'other-part-0',
      layer: 'other',
      frame: i,
      features,
      gray,
      x: 0,
      y,
      scaleX: 1,
      scaleY: 1,
      patches: extractPatches(gray, region, features, 1),
    });
  }
  const query2 = view2(targetY), qf2 = extractFeatures(query2);
  const foundOther = await index.find({
    features: qf2,
    gray: query2,
    native: query2,
    layer: 'other',
    frame: 1000,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
  });
  assert(foundOther);
  assertEquals(warnings.length, 2, 'a different layer must get its own single warning, independent of the first');
});
Deno.test('keyframes: canonical resolves a fragment-space rival to the same place as its attachment target (not ambiguous), and stays ambiguous when they genuinely differ', async () => {
  const db = new MemoryKV(), index = new KeyframeIndex(db, async () => {});
  const region = { x: 0, y: 0, width: 640, height: 400 };
  const page = makeWorld(900, 1400, 900, 'article'), g = grayscale(page.data, 900, 1400);
  const view = (y: number): Gray => {
    const data = new Uint8Array(640 * 400);
    for (let row = 0; row < 400; row++) data.set(g.data.subarray((y + row) * 900, (y + row) * 900 + 640), row * 640);
    return { width: 640, height: 400, data };
  };
  const shared = view(300), features = extractFeatures(shared), patches = extractPatches(shared, region, features, 1);
  // Same physical content, recorded twice: once under a fragment's own raw canvasId/coordinates (as first observed,
  // before it was attached), once under the main canvas it was later attached to. A raw-coordinate comparison would
  // see these as two different places; `canonical` maps the fragment into the main canvas's coordinate space.
  await index.add({
    id: 'frag/0',
    node: 'frag-part-0/0',
    canvasId: 'frag-part-0',
    layer: 'body',
    frame: 0,
    features,
    gray: shared,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    patches,
  });
  await index.add({
    id: 'main/50',
    node: 'main-part-0/50',
    canvasId: 'main-part-0',
    layer: 'body',
    frame: 50,
    features,
    gray: shared,
    x: 500,
    y: 300,
    scaleX: 1,
    scaleY: 1,
    patches,
  });
  const query = view(300), qf = extractFeatures(query);
  const samePlace = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 200,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
    canonical: (canvasId: string) =>
      canvasId === 'frag-part-0' ? { canvasId: 'main-part-0', dx: 500, dy: 300 } : { canvasId, dx: 0, dy: 0 },
  });
  assert(samePlace, 'expected a relocalization');
  assert(!samePlace!.ambiguous, 'a rival that canonicalizes to the same place must not be ambiguous');
  const differentPlace = await index.find({
    features: qf,
    gray: query,
    native: query,
    layer: 'body',
    frame: 201,
    roi: region,
    region,
    factor: 1,
    radius: 3,
    minGap: 0,
    canonical: (canvasId: string) => canvasId === 'frag-part-0' ? { canvasId: 'main-part-0', dx: 0, dy: 0 } : { canvasId, dx: 0, dy: 0 },
  });
  assert(differentPlace, 'expected a relocalization');
  assert(differentPlace!.ambiguous, 'a rival that canonicalizes to a genuinely different place must stay ambiguous');
});
