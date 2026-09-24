/** Byte-exact parity between the Rust pose-graph relaxation (rust/core/src/pose_graph.rs) and the frozen TS oracle
 *  it replaces (tests/support/reference/pose-graph.ts). Runs on whichever build `LONGSCREEN_CORE` selects
 *  (scalar/simd/threads — see tests/support/core.ts). */
import { assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import { rng } from '../../../src/core/math.ts';
import { type ReferenceEdge, type ReferenceNode, referencePass, referenceResidual } from '../../support/reference/pose-graph.ts';

interface Fixture {
  nodes: ReferenceNode[];
  offsets: number[];
  edges: ReferenceEdge[];
}

/** A chain of odometry-connected nodes (some pinned) plus a handful of loop-closure edges, similar in shape to
 *  what `PoseGraph.optimize()` builds from a real `revisit` scenario: every node has a "next" odometry edge and
 *  some non-adjacent pair gets a loop edge with deliberately displaced positions, so relaxation actually moves
 *  things instead of starting converged. */
function buildFixture(n: number, seed: number, loopEvery: number): Fixture {
  const rnd = rng(seed);
  const nodes: ReferenceNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ x: i * 12 + (rnd() - 0.5) * 6, y: (rnd() - 0.5) * 6, pinned: i === 0 });
  }
  const adjacency: ReferenceEdge[][] = Array.from({ length: n }, () => []);
  const connect = (a: number, b: number, dx: number, dy: number, weight: number) => {
    adjacency[a].push({ other: b, dx, dy, weight });
    adjacency[b].push({ other: a, dx: -dx, dy: -dy, weight });
  };
  for (let i = 1; i < n; i++) {
    connect(i - 1, i, 12 + (rnd() - 0.5) * 2, (rnd() - 0.5) * 2, 0.5 + rnd());
  }
  for (let i = loopEvery; i < n; i += loopEvery) {
    const j = i - loopEvery;
    connect(j, i, (i - j) * 12 + (rnd() - 0.5) * 20, (rnd() - 0.5) * 10, 0.2 + rnd() * 2);
  }
  // A defensive "missing other" edge (index -1): production code guards this with `if (!other) continue`, and the
  // Rust side must treat the sentinel the same way, not panic or corrupt the accumulation.
  if (n > 2) adjacency[n - 1].push({ other: -1, dx: 1, dy: 1, weight: 1 });
  const offsets = [0];
  const edges: ReferenceEdge[] = [];
  for (const list of adjacency) {
    edges.push(...list);
    offsets.push(edges.length);
  }
  return { nodes, offsets, edges };
}

function cloneNodes(nodes: ReferenceNode[]): ReferenceNode[] {
  return nodes.map((n) => ({ ...n }));
}

async function runRust(core: Awaited<ReturnType<typeof ensureCore>>, fixture: Fixture, passes: number) {
  const n = fixture.nodes.length;
  const xs = Float64Array.from(fixture.nodes.map((v) => v.x)), ys = Float64Array.from(fixture.nodes.map((v) => v.y));
  const pinned = Uint8Array.from(fixture.nodes.map((v) => (v.pinned ? 1 : 0)));
  const handle = core.poseGraphNew(
    { x: xs, y: ys, pinned },
    {
      offsets: Uint32Array.from(fixture.offsets),
      other: Int32Array.from(fixture.edges.map((e) => e.other)),
      dx: Float64Array.from(fixture.edges.map((e) => e.dx)),
      dy: Float64Array.from(fixture.edges.map((e) => e.dy)),
      weight: Float64Array.from(fixture.edges.map((e) => e.weight)),
    },
  );
  try {
    const maxChanges: number[] = [];
    for (let i = 0; i < passes; i++) {
      maxChanges.push(core.poseGraphPass(handle, i % 2 === 1));
    }
    const residual = core.poseGraphResidual(handle);
    const { x, y } = core.poseGraphRead(handle, n);
    return { maxChanges, residual, x: Array.from(x), y: Array.from(y) };
  } finally {
    core.poseGraphFree(handle);
  }
}

function runReference(fixture: Fixture, passes: number) {
  const nodes = cloneNodes(fixture.nodes);
  const maxChanges: number[] = [];
  for (let i = 0; i < passes; i++) {
    maxChanges.push(referencePass(nodes, fixture.offsets, fixture.edges, i % 2 === 1));
  }
  const residual = referenceResidual(nodes, fixture.offsets, fixture.edges);
  return { maxChanges, residual, x: nodes.map((n) => n.x), y: nodes.map((n) => n.y) };
}

Deno.test('core parity: pose-graph relaxation matches the frozen oracle over varied graphs', async () => {
  const core = await ensureCore();
  const fixtures: [number, number, number, number][] = [
    [2, 1, 1, 6],
    [8, 7, 3, 12],
    [40, 11, 5, 30],
    [201, 99, 8, 30],
  ];
  for (const [n, seed, loopEvery, passes] of fixtures) {
    const fixture = buildFixture(n, seed, loopEvery);
    const expected = runReference(fixture, passes), actual = await runRust(core, fixture, passes);
    assertEquals(actual.maxChanges, expected.maxChanges, `n=${n} seed=${seed}: maxChange per pass`);
    assertEquals(actual.x, expected.x, `n=${n} seed=${seed}: x`);
    assertEquals(actual.y, expected.y, `n=${n} seed=${seed}: y`);
    assertEquals(actual.residual, expected.residual, `n=${n} seed=${seed}: residual`);
  }
});

Deno.test('core parity: pose-graph relaxation handles a single unpinned node with no edges (offsets equal)', async () => {
  const core = await ensureCore();
  const fixture: Fixture = { nodes: [{ x: 3, y: 4, pinned: false }], offsets: [0, 0], edges: [] };
  const expected = runReference(fixture, 3), actual = await runRust(core, fixture, 3);
  assertEquals(actual.x, expected.x);
  assertEquals(actual.y, expected.y);
  assertEquals(actual.residual, expected.residual);
});
