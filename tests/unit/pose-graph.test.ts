import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { MemoryKV } from '../../src/storage/db.ts';
import type { KV, Row } from '../../src/storage/db.ts';
import { PoseGraph, type PoseNode } from '../../src/core/pose-graph.ts';
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
// The checkpoint is called once per Gauss-Seidel sweep (rust/core/src/pose_graph.rs::Graph::pass), not per node —
// checkpoint() has no persisted side effect (it only awaits a pause and may flip stopRequested), so this changed
// from the pre-port "every 256 node updates" cadence without changing what optimize() computes or persists.
Deno.test('pose graph: optimize() calls the checkpoint at least once during a real multi-node relaxation', async () => {
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
// Moved from core.test.ts (module split): PoseGraph unit test alongside the rest of the module's tests.
Deno.test('pose graph: loop closure keeps the pinned origin, isolated components get no invented relation, edges stay on disk', async () => {
  const db = new MemoryKV(), graph = new PoseGraph(db);
  const a = await graph.add('a', 0, { x: 0, y: 0 }),
    b = await graph.add('a', 10, { x: 100, y: 80 }, a),
    c = await graph.add('a', 20, { x: 4, y: 3 }, b);
  await graph.connect(a.id, c.id, 0, 0, 20, 'loop');
  await graph.connect(a.id, c.id, 0, 0, 20, 'loop');
  await graph.connect(a.id, a.id, 0, 0, 1, 'loop');
  const result = await graph.optimize(async () => {});
  assert(result.iterations > 0 && result.residual < 5);
  const origin = (await graph.get(a.id))!, end = (await graph.get(c.id))!;
  assertEquals([origin.x, origin.y], [0, 0]);
  assert(Math.hypot(end.x, end.y) < .3);
  const mid = await graph.correction(b.id, 15), last = await graph.correction(c.id, 20), first = await graph.correction(a.id, 0);
  assert(Number.isFinite(mid.x) && Number.isFinite(last.y) && first.x === 0);
  const g2 = new PoseGraph(new MemoryKV());
  const p = await g2.add('first', 0, { x: 0, y: 0 }), q = await g2.add('second', 1, { x: 0, y: 0 });
  assertEquals(await g2.optimize(async () => {}), { residual: 0, iterations: 0 });
  assert((await g2.get(p.id))!.pinned && (await g2.get(q.id))!.pinned);
  await assertRejectsAsync(() => g2.connect(p.id, 'missing', 0, 0, 1, 'loop'));
  await assertRejectsAsync(() => g2.correction('missing', 0));
  const g3 = new PoseGraph(new MemoryKV()), origin3 = await g3.add('canvas', 0, { x: 0, y: 0 });
  for (let i = 1; i <= 100; i++) {
    const node = await g3.add('canvas', i, { x: i, y: -i });
    await g3.connect(origin3.id, node.id, i, -i, 1, 'loop');
  }
  assertEquals((await g3.get(origin3.id))!.edges.length, 0);
  assertEquals((await g3.db.scan(`edge/${origin3.id}/`, { limit: 1000 })).length, 100);
});
async function assertRejectsAsync(fn: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, 'expected rejection');
}
