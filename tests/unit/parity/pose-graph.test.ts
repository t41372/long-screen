/** Byte-exact parity between the Rust pose-graph relaxation (rust/core/src/pose_graph.rs, driven through the engine's
 *  pose graph in rust/engine/src/pose_graph.rs) and the frozen TS oracle it replaces (tests/support/reference/pose-graph.ts). Runs on whichever build `LONGSCREEN_CORE` selects
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

/** The fixture as a stored graph handed to the engine's pose graph (`rust/engine/src/pose_graph.rs`), relaxed the
 *  way `PoseGraph.optimize()` relaxes it: one sweep per step until it converges or runs out of sweeps. Every edge is
 *  a loop edge, which relaxes exactly like an odometry one; an index of -1 becomes an id no node has. */
function runRust(core: Awaited<ReturnType<typeof ensureCore>>, fixture: Fixture) {
  const id = (i: number) => (i < 0 ? 'ghost' : `n${String(i).padStart(4, '0')}`);
  const graph = core.poseGraph();
  try {
    graph.hydrate([
      ...fixture.nodes.map((v, i) => ({
        node: { id: id(i), canvasId: 'c', frame: i, x: v.x, y: v.y, originalX: v.x, originalY: v.y, pinned: v.pinned, edges: [] },
      })),
      ...fixture.edges.map((e, k) => {
        const from = fixture.offsets.findIndex((_, i) => k < fixture.offsets[i + 1]);
        return {
          edge: {
            key: `edge/${id(from)}/${id(e.other)}/loop`,
            value: { other: id(e.other), dx: e.dx, dy: e.dy, weight: e.weight, kind: 'loop' as const },
          },
        };
      }),
    ]);
    let iterations = 0, residual = 0;
    if (graph.optimizeBegin()) {
      while (!graph.optimizeStep(1));
      ({ residual, iterations } = graph.optimizeFinish());
    }
    const nodes = fixture.nodes.map((_, i) => graph.get(id(i))!);
    return { iterations, residual, x: nodes.map((n) => n.x), y: nodes.map((n) => n.y) };
  } finally {
    graph.free();
  }
}

/** The oracle's sweeps in `PoseGraph.optimize()`'s loop: until a sweep moves no node 0.04 px, at most 200. */
function runReference(fixture: Fixture) {
  const nodes = cloneNodes(fixture.nodes);
  let iterations = 0;
  if (fixture.edges.length) {
    for (; iterations < 200; iterations++) {
      if (referencePass(nodes, fixture.offsets, fixture.edges, iterations % 2 === 1) < .04) {
        iterations++;
        break;
      }
    }
  }
  const residual = fixture.edges.length ? referenceResidual(nodes, fixture.offsets, fixture.edges) : 0;
  return { iterations, residual, x: nodes.map((n) => n.x), y: nodes.map((n) => n.y) };
}

Deno.test('core parity: pose-graph relaxation matches the frozen oracle over varied graphs', async () => {
  const core = await ensureCore();
  const fixtures: [number, number, number][] = [
    [2, 1, 1],
    [8, 7, 3],
    [40, 11, 5],
    [201, 99, 8],
  ];
  for (const [n, seed, loopEvery] of fixtures) {
    const fixture = buildFixture(n, seed, loopEvery);
    const expected = runReference(fixture), actual = runRust(core, fixture);
    assertEquals(actual.iterations, expected.iterations, `n=${n} seed=${seed}: sweeps`);
    assertEquals(actual.x, expected.x, `n=${n} seed=${seed}: x`);
    assertEquals(actual.y, expected.y, `n=${n} seed=${seed}: y`);
    assertEquals(actual.residual, expected.residual, `n=${n} seed=${seed}: residual`);
  }
});

Deno.test('core parity: pose-graph relaxation handles a single unpinned node with no edges (offsets equal)', async () => {
  const core = await ensureCore();
  const fixture: Fixture = { nodes: [{ x: 3, y: 4, pinned: false }], offsets: [0, 0], edges: [] };
  const expected = runReference(fixture), actual = runRust(core, fixture);
  assertEquals(actual.x, expected.x);
  assertEquals(actual.y, expected.y);
  assertEquals(actual.residual, expected.residual);
});
