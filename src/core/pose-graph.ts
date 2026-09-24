import type { Point } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { clamp, pad } from './math.ts';
import { core } from './wasm.ts';
export interface PoseEdge {
  other: string;
  dx: number;
  dy: number;
  weight: number;
  kind: 'odometry' | 'loop';
}
export interface PoseNode extends Point {
  id: string;
  canvasId: string;
  frame: number;
  originalX: number;
  originalY: number;
  pinned: boolean;
  edges: PoseEdge[];
  next?: string;
}
const CHUNK = 256;
/** In-memory graph, hydrated once from disk and written through. Persisted node records keep `edges: []` — adjacency
 * lives only in `this.adjacency`, keyed by node id, and is rebuilt by every fresh instance from the `edge/` records. */
export class PoseGraph {
  loops = 0;
  private nodes = new Map<string, PoseNode>();
  private adjacency = new Map<string, PoseEdge[]>();
  private hydrated: Promise<void> | undefined;
  constructor(readonly db: KV) {}
  nodeId(canvasId: string, frame: number): string {
    return `${canvasId}/${pad(frame)}`;
  }
  private hydrate(): Promise<void> {
    return this.hydrated ??= (async () => {
      for await (const row of iterate<PoseNode>(this.db, 'node/')) {
        this.nodes.set(row.value.id, row.value);
      }
      for await (const row of iterate<PoseEdge>(this.db, 'edge/')) {
        const edge = row.value, suffix = `/${edge.other}/${edge.kind}`, aId = row.key.slice('edge/'.length, row.key.length - suffix.length);
        let list = this.adjacency.get(aId);
        if (!list) {
          this.adjacency.set(aId, list = []);
        }
        list.push(edge);
        if (edge.kind === 'loop' && aId < edge.other) {
          this.loops++;
        }
      }
    })();
  }
  private async flush(nodes: PoseNode[]): Promise<void> {
    for (let i = 0; i < nodes.length; i += CHUNK) {
      await this.db.putMany(nodes.slice(i, i + CHUNK).map((n) => ({ key: `node/${n.id}`, value: n })));
    }
  }
  /** `weight` is the confidence of the odometry edge to `previous`: a step measured on a thin overlap must not pull as hard as a well-supported one. */
  async add(canvasId: string, frame: number, p: Point, previous?: PoseNode, weight = 1): Promise<PoseNode> {
    await this.hydrate();
    let prev: PoseNode | undefined;
    if (previous) {
      prev = this.nodes.get(previous.id);
      if (!prev) {
        throw new Error('Pose graph references a missing previous node.');
      }
    }
    const id = this.nodeId(canvasId, frame),
      node: PoseNode = {
        id,
        canvasId,
        frame,
        x: p.x + (prev ? prev.x - prev.originalX : 0),
        y: p.y + (prev ? prev.y - prev.originalY : 0),
        originalX: p.x,
        originalY: p.y,
        pinned: !prev,
        edges: [],
      };
    this.nodes.set(id, node);
    await this.db.put(`node/${id}`, node);
    if (prev) {
      await this.connect(prev.id, id, p.x - prev.originalX, p.y - prev.originalY, weight, 'odometry');
      prev.next = id;
      await this.db.put(`node/${prev.id}`, prev);
    }
    return node;
  }
  async get(id: string): Promise<PoseNode | undefined> {
    await this.hydrate();
    return this.nodes.get(id);
  }
  async connect(aId: string, bId: string, dx: number, dy: number, weight: number, kind: 'odometry' | 'loop'): Promise<void> {
    await this.hydrate();
    const a = this.nodes.get(aId), b = this.nodes.get(bId);
    if (!a || !b) {
      throw new Error('Pose graph references a missing node.');
    }
    if (aId === bId) {
      return;
    }
    const aKey = `edge/${aId}/${bId}/${kind}`, bKey = `edge/${bId}/${aId}/${kind}`;
    if ((this.adjacency.get(aId) || []).some((e) => e.other === bId && e.kind === kind)) {
      return;
    }
    const aEdge: PoseEdge = { other: bId, dx, dy, weight, kind }, bEdge: PoseEdge = { other: aId, dx: -dx, dy: -dy, weight, kind };
    let aList = this.adjacency.get(aId);
    if (!aList) this.adjacency.set(aId, aList = []);
    aList.push(aEdge);
    let bList = this.adjacency.get(bId);
    if (!bList) this.adjacency.set(bId, bList = []);
    bList.push(bEdge);
    // Adjacency is paged as individual disk records: many revisits never grow a node in RAM beyond this pair.
    await this.db.putMany([{ key: aKey, value: aEdge }, { key: bKey, value: bEdge }]);
    if (kind === 'loop') {
      this.loops++;
      // Initialize the long chain with distributed closure error. This also avoids glacial convergence of plain
      // Gauss–Seidel on a many-thousand-keyframe chain. Walk the actual odometry chain (`next` pointers) rather than
      // scanning every node that shares a canvasId: relocalization can leave several disjoint chains on one canvas,
      // and a frame-number scan would move nodes that belong to a chain the loop edge never touched.
      if (a.canvasId === b.canvasId && b.frame > a.frame) {
        const chain: PoseNode[] = [];
        for (let cur = a.next; cur;) {
          const n = this.nodes.get(cur);
          if (!n) {
            break;
          }
          chain.push(n);
          cur = n.next;
        }
        if (chain.some((n) => n.id === bId)) {
          const correction = { x: a.x + dx - b.x, y: a.y + dy - b.y }, touched: PoseNode[] = [];
          for (const n of chain) {
            if (n.pinned) {
              continue;
            }
            const t = clamp((n.frame - a.frame) / (b.frame - a.frame), 0, 1);
            n.x += correction.x * t;
            n.y += correction.y * t;
            touched.push(n);
          }
          await this.flush(touched);
        }
      }
    }
  }
  async optimize(checkpoint: () => Promise<void>): Promise<{
    residual: number;
    iterations: number;
  }> {
    await this.hydrate();
    if (!this.loops) {
      return { residual: 0, iterations: 0 };
    }
    // Hand the whole graph to the Rust core as plain arrays (rust/core/src/pose_graph.rs): `all` fixes the node
    // order (this Map's iteration/hydration order) that both the CSR adjacency below and the write-back after the
    // loop rely on; `index` resolves each edge's string id to that same order once, so the core never sees ids.
    const all = [...this.nodes.values()], index = new Map<string, number>();
    all.forEach((n, i) => index.set(n.id, i));
    const xs = new Float64Array(all.length), ys = new Float64Array(all.length), pinned = new Uint8Array(all.length);
    const offsets = new Uint32Array(all.length + 1);
    const other: number[] = [], dx: number[] = [], dy: number[] = [], weight: number[] = [];
    all.forEach((n, i) => {
      xs[i] = n.x;
      ys[i] = n.y;
      pinned[i] = n.pinned ? 1 : 0;
      offsets[i] = other.length;
      // `this.adjacency.get(n.id)` returns the same array `connect()` builds (hydration order, then any
      // in-session pushes appended after): the CSR below preserves that order edge-for-edge.
      for (const edge of this.adjacency.get(n.id) || []) {
        other.push(index.get(edge.other) ?? -1);
        dx.push(edge.dx);
        dy.push(edge.dy);
        weight.push(edge.weight);
      }
    });
    offsets[all.length] = other.length;
    const handle = core().poseGraphNew(
      { x: xs, y: ys, pinned },
      { offsets, other: Int32Array.from(other), dx: Float64Array.from(dx), dy: Float64Array.from(dy), weight: Float64Array.from(weight) },
    );
    let iterations = 0;
    try {
      // One core call per Gauss-Seidel sweep (not per iteration budget of 200, nor per node): `checkpoint()` has
      // no persisted side effect of its own (it only awaits a pause and may flip `stopRequested`), so calling it
      // once per sweep — rather than the original's "every 256 node updates" — changes only how finely a real
      // stop/pause is observed mid-relaxation, never what gets computed or (on a normal finish) persisted.
      for (; iterations < 200; iterations++) {
        const maxChange = core().poseGraphPass(handle, iterations % 2 === 1);
        await checkpoint();
        if (maxChange < .04) {
          iterations++;
          break;
        }
      }
      const residual = core().poseGraphResidual(handle);
      const { x: outX, y: outY } = core().poseGraphRead(handle, all.length);
      const moved: PoseNode[] = [];
      all.forEach((n, i) => {
        if (!n.pinned && (this.adjacency.get(n.id) || []).length) {
          n.x = outX[i];
          n.y = outY[i];
          moved.push(n);
        }
      });
      await this.flush(moved);
      return { residual, iterations };
    } finally {
      core().poseGraphFree(handle);
    }
  }
  async correction(id: string, frame: number): Promise<Point> {
    await this.hydrate();
    const a = this.nodes.get(id);
    if (!a) {
      throw new Error('Missing pose for frame rendering.');
    }
    let x = a.x - a.originalX, y = a.y - a.originalY;
    if (a.next) {
      const b = this.nodes.get(a.next);
      if (b && b.frame > a.frame) {
        const t = clamp((frame - a.frame) / (b.frame - a.frame), 0, 1);
        x = x * (1 - t) + (b.x - b.originalX) * t;
        y = y * (1 - t) + (b.y - b.originalY) * t;
      }
    }
    return { x, y };
  }
}
