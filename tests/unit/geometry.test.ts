import { assert, assertEquals, assertRejects } from '@std/assert';
import { constantFrames, fillRGBA, makeWorld, type Overlay, type Scenario } from '../../src/synthetic/world.ts';
import { fixedBand } from '../../src/synthetic/scenarios.ts';
import { runScenario, verifyLayer } from '../support/run.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import type { KV, Row } from '../../src/storage/db.ts';
import { PoseGraph, type PoseNode } from '../../src/core/pose-graph.ts';
import type { Point } from '../../src/types.ts';
// Points strictly between `from` and `to` at `step` spacing, then `to` itself — used to build a continuous scroll leg
// without duplicating the previous leg's endpoint (which would insert a spurious zero-motion frame at the seam).
function ramp(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  if (to > from) {
    for (let y = from + step; y < to; y += step) out.push(y);
  } else {
    for (let y = from - step; y > to; y -= step) out.push(y);
  }
  out.push(to);
  return out;
}
function attachLoopScenario(): Scenario {
  const W = 640, H = 448, HEADER = 48, viewport = { x: 0, y: HEADER, width: W, height: H - HEADER };
  const world = makeWorld(900, 3400, 331, 'article');
  // 1) continuous scroll 0→960 (keyframes minted every ~120px of travel on a 640×400 pane).
  // 2) a single no-overlap jump to y=2400 (UNPLACED_FRAGMENT: a brand new, unlocated fragment).
  // 3) continuous scroll back UP 2400→840, still tracked frame-to-frame the whole way (never lost), so the fragment
  //    re-enters the main canvas's observed territory and a keyframe-mint's global search finds a main-canvas keyframe
  //    (FRAGMENT_ATTACHED).
  // 4) continue up to 180: pure revisits of the main canvas's own territory (LOOP_CLOSURE).
  // 5) scroll back DOWN to 2580: passes back through the territory the fragment observed in (2)/(3) before it was
  //    attached — those keyframes still carry the fragment's raw (pre-attach) canvasId, exercising the canonical-space
  //    fixes (A1/A3/A4/A6).
  const ys = [0, ...ramp(0, 960, 60), 2400, ...ramp(2400, 840, 60), ...ramp(840, 180, 60), ...ramp(180, 2580, 60)];
  const path = ys.map((y) => ({ x: 0, y }));
  return {
    name: 'attach-then-loop',
    description: '独立滚动片段先无重叠跳转，再连续回滚重新接回主画布，随后继续回访主画布及已接回片段各自的历史区域。',
    width: W,
    height: H,
    background: [251, 250, 246],
    layers: [{ id: 'body', viewport, world, path }],
    overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 41)],
    frames: constantFrames(path.length, 30),
    expect: { fragments: {}, diagnostics: { present: [], absent: [] }, maxError: 0, status: 'complete' },
  };
}
Deno.test('geometry: a no-overlap jump that tracks back into view attaches to the main canvas, then closes loops on both sides of the seam', async () => {
  const scenario = attachLoopScenario(), run = await runScenario(scenario), layer = scenario.layers[0];
  assertEquals(run.project.status, 'complete', run.project.error);
  if (!run.codes.has('UNPLACED_FRAGMENT') || !run.codes.has('FRAGMENT_ATTACHED')) {
    console.log(
      'geometry/attach-then-loop diagnostics:',
      run.diagnostics.map((d) => ({ code: d.code, frame: d.frame, canvasId: d.canvasId })),
    );
  }
  assert(run.codes.has('UNPLACED_FRAGMENT'), `expected UNPLACED_FRAGMENT; got ${[...run.codes].join(',')}`);
  assert(run.codes.has('FRAGMENT_ATTACHED'), `expected FRAGMENT_ATTACHED; got ${[...run.codes].join(',')}`);
  const attach = run.diagnostics.find((d) => d.code === 'FRAGMENT_ATTACHED')!;
  const loopsAfterAttach = run.diagnostics.filter((d) => d.code === 'LOOP_CLOSURE' && (d.frame ?? -1) > (attach.frame ?? Infinity));
  assert(
    loopsAfterAttach.length > 0,
    `expected a LOOP_CLOSURE after the attach frame (${attach.frame}); loop closures at: ${
      run.diagnostics.filter((d) => d.code === 'LOOP_CLOSURE').map((d) => d.frame).join(',')
    }`,
  );
  const result = await verifyLayer(run, layer);
  if (result.maxError !== 0 || result.missing !== 0 || result.invented !== 0 || result.mismatched !== 0) {
    console.log('geometry/attach-then-loop verifyLayer:', result);
    console.log(
      'geometry/attach-then-loop diagnostics:',
      run.diagnostics.map((d) => ({ code: d.code, frame: d.frame, canvasId: d.canvasId, detail: d.detail })),
    );
  }
  assertEquals(result.maxError, 0);
  assertEquals(result.missing, 0);
  assertEquals(result.invented, 0);
  assertEquals(result.mismatched, 0);
  const fragment = run.canvases.find((c) => c.layer === result.regionId && c.fragment > 0);
  assert(fragment, 'no fragment canvas was ever created');
  assertEquals(fragment!.attachedTo, result.mainCanvas.id);
  assertEquals(fragment!.tileCount, 0, 'an attached fragment must hold no tiles of its own');
  for (const o of run.observations) {
    const d = o.decisions.find((x) => x.placement.layer === result.regionId);
    assert(d, `frame ${o.frame}: no decision recorded for layer ${result.regionId}`);
    if (d!.skipped) {
      continue;
    }
    assertEquals(
      d!.canvasId,
      result.mainCanvas.id,
      `frame ${o.frame}: resolved to ${d!.canvasId}, expected the main canvas ${result.mainCanvas.id}`,
    );
  }
  const summary = await run.store.get<{ residual: number }>('graph-summary');
  assert(summary, 'no graph-summary was written');
  assert(summary!.residual < 1, `graph residual ${summary!.residual} is too high`);
});
function paneZoomScenario(): Scenario {
  const W = 640, H = 448, HEADER = 48;
  // Same two-pane geometry as the 'panes' scenario (proven to split into independent moving regions): reusing its
  // exact path shape and seeds avoids reproducing the region-learner's split heuristics from scratch.
  const left = makeWorld(318, 2400, 71, 'cards'), right = makeWorld(318, 2600, 72, 'article');
  const n = 75, lp: Point[] = [], rp: Point[] = [];
  for (let i = 0; i < n; i++) {
    lp.push({ x: 0, y: i < 35 ? i * 8 : 280 - (i - 35) * 5 });
    rp.push({ x: 0, y: i < 20 ? 0 : (i - 20) * 7 });
  }
  // Gradual zoom on the right pane only, well after both panes are established: four measurable steps (6/6/6/5%) so
  // per-frame scale evidence is real, then holds.
  const zoom = Array.from({ length: n }, (_, i) => i < 60 ? 1 : i === 60 ? 1.06 : i === 61 ? 1.12 : i === 62 ? 1.19 : 1.25);
  const divider: Overlay = {
    id: 'divider',
    kind: 'fixed',
    draw: (frame) => {
      const r = { x: 318, y: HEADER, width: 4, height: H - HEADER };
      fillRGBA(frame, r, [57, 67, 55]);
      return [r];
    },
  };
  return {
    name: 'pane-zoom',
    description: '右侧 pane 渐进式缩放，左侧 pane 继续独立滚动，互不影响。',
    width: W,
    height: H,
    background: [251, 250, 246],
    layers: [
      { id: 'left', viewport: { x: 0, y: HEADER, width: 318, height: H - HEADER }, world: left, path: lp },
      { id: 'right', viewport: { x: 322, y: HEADER, width: 318, height: H - HEADER }, world: right, path: rp, zoom },
    ],
    overlays: [fixedBand('header', { x: 0, y: 0, width: W, height: HEADER }, 42), divider],
    frames: constantFrames(n, 30),
    expect: { fragments: {}, diagnostics: { present: [], absent: [] }, maxError: 0, status: 'complete' },
  };
}
Deno.test('geometry: a per-pane zoom fragments only the zooming pane, not its co-scrolling sibling', async () => {
  const scenario = paneZoomScenario(), run = await runScenario(scenario);
  assertEquals(run.project.status, 'complete', run.project.error);
  const leftResult = await verifyLayer(run, scenario.layers[0]), rightResult = await verifyLayer(run, scenario.layers[1]);
  if (leftResult.fragments.length || leftResult.maxError || leftResult.missing || leftResult.invented || leftResult.mismatched) {
    console.log(
      'geometry/pane-zoom left:',
      leftResult,
      run.diagnostics.filter((d) => d.canvasId?.startsWith(`${leftResult.regionId}-part-`)),
    );
  }
  assertEquals(leftResult.fragments.length, 0, `left pane fragmented: ${leftResult.fragments.map((c) => c.id).join(',')}`);
  assertEquals(leftResult.maxError, 0);
  assertEquals(leftResult.missing, 0);
  assertEquals(leftResult.invented, 0);
  assertEquals(leftResult.mismatched, 0);
  const leftBad = run.diagnostics.filter((d) =>
    (d.code === 'SCALE_CHANGE_FRAGMENT' || d.code === 'UNPLACED_FRAGMENT') && d.canvasId?.startsWith(`${leftResult.regionId}-part-`)
  );
  assertEquals(leftBad.length, 0, `left pane got a fragmentation diagnostic meant for the zooming pane: ${JSON.stringify(leftBad)}`);
  assert(rightResult.fragments.length >= 1, 'right pane did not fragment when it zoomed');
  assert(run.codes.has('SCALE_CHANGE_FRAGMENT'), `expected SCALE_CHANGE_FRAGMENT for the zooming pane; got ${[...run.codes].join(',')}`);
});
/** Counts KV write CALLS (not rows): the concern is IndexedDB transaction count, one per put/putMany. */
class CountingKV implements KV {
  calls = 0;
  constructor(private inner: KV) {}
  get<T>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(key);
  }
  put(key: string, value: unknown): Promise<void> {
    this.calls++;
    return this.inner.put(key, value);
  }
  putMany(rows: Row[]): Promise<void> {
    this.calls++;
    return this.inner.putMany(rows);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
  deleteMany(keys: string[]): Promise<void> {
    return this.inner.deleteMany(keys);
  }
  scan<T>(prefix: string, options?: { after?: string; limit?: number; reverse?: boolean }): Promise<Row<T>[]> {
    return this.inner.scan<T>(prefix, options);
  }
}
Deno.test('pose graph: a cross-canvas loop edge carrying the correct raw delta (offset+shift) converges to zero residual', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  // The numeric repro behind fix A2: a keyframe minted on a fragment F at raw x=60; the current frame's canonical pose
  // is 1085 = 60 (link.x) + 25 (revisit offset) + 1000 (the fragment's attachment shift into the target canvas T).
  const anchor = await graph.add('F', 0, { x: 60, y: 0 });
  const node = await graph.add('T', 1, { x: 1085, y: 0 });
  node.pinned = false; // engine.ts unpins the relocalized/attached node before wiring its loop edge
  await graph.connect(anchor.id, node.id, node.x - anchor.x, node.y - anchor.y, 5, 'loop'); // raw delta = 1025 = offset + shift
  let previous = node;
  for (let i = 0; i < 3; i++) previous = await graph.add('T', 2 + i, { x: 1085 + (i + 1) * 20, y: 0 }, previous); // chain of 3 odometry nodes after
  const result = await graph.optimize(async () => {});
  assert(result.residual < 1e-6, `residual ${result.residual}`);
});
Deno.test('pose graph: loop-closure distribution issues O(nodes+loops) KV write calls, not O(nodes×loops)', async () => {
  const inner = new MemoryKV(), counted = new CountingKV(inner), graph = new PoseGraph(counted);
  const nodes: PoseNode[] = [];
  let previous: PoseNode | undefined;
  for (let i = 0; i <= 120; i++) {
    const n = await graph.add('star', i, { x: i * 10, y: 0 }, previous);
    nodes.push(n);
    previous = n;
  }
  const before = counted.calls;
  for (let i = 1; i <= 100; i++) {
    await graph.connect(nodes[0].id, nodes[i].id, i * 10, 0, 1, 'loop');
  }
  const loopCalls = counted.calls - before;
  // O(nodes×loops) here would be tens of thousands of individual node writes (up to 121 nodes touched × 100 loops);
  // O(nodes+loops) is at most a small constant number of chunked putMany calls per loop closure.
  assert(loopCalls < 400, `100 loop closures over 121 nodes issued ${loopCalls} KV write calls; expected O(nodes+loops)`);
});
Deno.test('pose graph: a loop closure on one odometry chain leaves a disjoint chain sharing the same canvasId untouched', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  const a0 = await graph.add('C', 0, { x: 0, y: 0 });
  const a1 = await graph.add('C', 1, { x: 10, y: 0 }, a0);
  const a2 = await graph.add('C', 2, { x: 20, y: 0 }, a1);
  const a3 = await graph.add('C', 3, { x: 30, y: 0 }, a2);
  // A second chain on the same canvasId, disjoint from the first (as relocalization leaves behind: state.lastNode is
  // reset to undefined, so the next graph.add starts a fresh, unlinked chain on the same canvasId).
  const b0 = await graph.add('C', 100, { x: 500, y: 0 });
  const b1 = await graph.add('C', 101, { x: 510, y: 0 }, b0);
  const b2 = await graph.add('C', 102, { x: 520, y: 0 }, b1);
  // Deliberately inconsistent with a3's raw x (30), so a real, nonzero correction gets distributed along chain 1.
  await graph.connect(a0.id, a3.id, 50, 0, 1, 'loop');
  assertEquals(b0.x, 500);
  assertEquals(b1.x, 510);
  assertEquals(b2.x, 520);
  assert(Math.abs(a3.x - 50) < 1e-9, `a3.x ${a3.x}`);
});
Deno.test('pose graph: add() rejects a previous node this instance does not know about', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  const ghost: PoseNode = { id: 'ghost', canvasId: 'c', frame: 0, x: 0, y: 0, originalX: 0, originalY: 0, pinned: true, edges: [] };
  await assertRejects(() => graph.add('c', 1, { x: 1, y: 1 }, ghost), Error, 'missing previous node');
});
Deno.test('pose graph: connect() walks a broken next-chain defensively and treats an unreachable revisit as isolated', async () => {
  const db = new MemoryKV();
  // Hand-crafted store: 'a' claims next='ghost', but no node/ghost record was ever written — a corrupted/partial chain,
  // as could follow a crash between writing a node and linking its predecessor's `next`.
  const a: PoseNode = { id: 'a', canvasId: 'c', frame: 0, x: 0, y: 0, originalX: 0, originalY: 0, pinned: true, edges: [], next: 'ghost' };
  const b: PoseNode = { id: 'b', canvasId: 'c', frame: 5, x: 50, y: 0, originalX: 50, originalY: 0, pinned: false, edges: [] };
  await db.put('node/a', a);
  await db.put('node/b', b);
  const graph = new PoseGraph(db);
  await graph.connect('a', 'b', 40, 0, 1, 'loop'); // raw delta 40, inconsistent with b's raw x=50, but b is unreachable so no correction happens
  assertEquals((await graph.get('b'))!.x, 50, 'an unreachable chain must not be corrected');
  assertEquals(graph.loops, 1);
});
Deno.test('pose graph: a loop-closure correction skips a pinned node inside the chain it walks', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  const a0 = await graph.add('c', 0, { x: 0, y: 0 });
  const a1 = await graph.add('c', 1, { x: 10, y: 0 }, a0);
  const a2 = await graph.add('c', 2, { x: 20, y: 0 }, a1);
  a2.pinned = true; // simulates a node independently pinned elsewhere (e.g. another canvas's origin merged in)
  const a3 = await graph.add('c', 3, { x: 30, y: 0 }, a2);
  await graph.connect(a0.id, a3.id, 50, 0, 1, 'loop'); // inconsistent with a3's raw x=30: forces a nonzero correction
  assertEquals(a2.x, 20, 'a pinned node inside the chain must not be corrected');
  assert(Math.abs(a1.x) > 1e-9, 'an unpinned node before the pinned one must still be corrected');
  assert(Math.abs(a3.x - 50) < 1e-9, `a3.x ${a3.x}`);
});
Deno.test('pose graph: optimize() skips a node with no adjacency and an edge pointing at a missing node, without crashing', async () => {
  const db = new MemoryKV();
  const a: PoseNode = { id: 'a', canvasId: 'c', frame: 0, x: 0, y: 0, originalX: 0, originalY: 0, pinned: false, edges: [] };
  const lonely: PoseNode = { id: 'lonely', canvasId: 'd', frame: 0, x: 3, y: 4, originalX: 3, originalY: 4, pinned: false, edges: [] };
  await db.put('node/a', a);
  await db.put('node/lonely', lonely);
  // 'a' carries one edge to a node that was never persisted — the same kind of partial write as above.
  await db.put('edge/a/ghost/loop', { other: 'ghost', dx: 5, dy: 0, weight: 1, kind: 'loop' });
  const graph = new PoseGraph(db);
  const result = await graph.optimize(async () => {});
  assertEquals(graph.loops, 1);
  assert(Number.isFinite(result.residual));
  assertEquals((await graph.get('lonely'))!.x, 3, 'a node with no adjacency at all must never move');
  assertEquals((await graph.get('a'))!.x, 0, 'an edge to a missing node must be skipped, not crash optimize()');
});
Deno.test('pose graph: optimize() calls the checkpoint mid-pass, not only at the end, once 256 nodes have relaxed', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  let previous: PoseNode | undefined;
  const nodes: PoseNode[] = [];
  for (let i = 0; i <= 300; i++) {
    const n = await graph.add('chain', i, { x: i * 10, y: 0 }, previous);
    nodes.push(n);
    previous = n;
  }
  // Inconsistent with the raw chain (node 300's raw x is 3000): forces at least one real relaxation pass over all 300 nodes.
  await graph.connect(nodes[0].id, nodes[300].id, 3200, 0, 1, 'loop');
  let checkpoints = 0;
  await graph.optimize(async () => {
    checkpoints++;
  });
  assert(checkpoints > 0, 'expected at least one mid-pass checkpoint over 300 relaxed nodes');
});
Deno.test('pose graph: a fresh instance on the same store hydrates and returns the same correction', async () => {
  const db = new MemoryKV(), graphA = new PoseGraph(db);
  const p0 = await graphA.add('X', 0, { x: 0, y: 0 });
  const p1 = await graphA.add('X', 10, { x: 100, y: 0 }, p0);
  const p2 = await graphA.add('X', 20, { x: 200, y: 0 }, p1);
  await graphA.connect(p0.id, p2.id, 210, 0, 1, 'loop'); // inconsistent with p2's raw 200, forces a real optimize() move
  await graphA.optimize(async () => {});
  const c1 = await graphA.correction(p1.id, 10), c2 = await graphA.correction(p2.id, 20);
  const graphB = new PoseGraph(db); // fresh instance, same underlying store — must hydrate solve()'s graph, not start empty
  const d1 = await graphB.correction(p1.id, 10), d2 = await graphB.correction(p2.id, 20);
  assertEquals(d1, c1);
  assertEquals(d2, c2);
  assert(Math.abs(c2.x) > 1, `expected optimize() to have actually moved p2 (correction ${c2.x}), otherwise this test proves nothing`);
});
