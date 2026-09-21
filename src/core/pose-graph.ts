import type { Point } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { clamp, pad } from './math.ts';
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
    const all = [...this.nodes.values()];
    let iterations = 0, updates = 0;
    for (; iterations < 200; iterations++) {
      let maxChange = 0;
      const order = iterations % 2 === 1 ? [...all].reverse() : all;
      for (const node of order) {
        if (node.pinned) {
          continue;
        }
        const edges = this.adjacency.get(node.id);
        if (!edges || !edges.length) {
          continue;
        }
        let x = 0, y = 0, total = 0;
        for (const edge of edges) {
          const other = this.nodes.get(edge.other);
          if (!other) {
            continue;
          }
          const residual = Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy),
            weight = edge.weight * Math.min(1, 6 / Math.max(1e-6, residual));
          x += (other.x - edge.dx) * weight;
          y += (other.y - edge.dy) * weight;
          total += weight;
        }
        if (!total) {
          continue;
        }
        const px = x / total, py = y / total;
        maxChange = Math.max(maxChange, Math.hypot(node.x - px, node.y - py));
        node.x = px;
        node.y = py;
        if (++updates % 256 === 0) {
          await checkpoint();
        }
      }
      if (maxChange < .04) {
        iterations++;
        break;
      }
    }
    const moved = all.filter((n) => !n.pinned && (this.adjacency.get(n.id) || []).length);
    await this.flush(moved);
    let residual = 0;
    for (const node of all) {
      const edges = this.adjacency.get(node.id);
      if (!edges) {
        continue;
      }
      for (const edge of edges) {
        const other = this.nodes.get(edge.other);
        if (other) {
          residual = Math.max(residual, Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy));
        }
      }
    }
    return { residual, iterations };
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
