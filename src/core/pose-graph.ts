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
export function relaxPose(node: PoseNode, neighbours: Map<string, PoseNode>): Point {
  if (node.pinned || !node.edges.length) {
    return { x: node.x, y: node.y };
  }
  let x = 0, y = 0, total = 0;
  for (const edge of node.edges) {
    const other = neighbours.get(edge.other);
    if (!other) {
      continue;
    }
    const residual = Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy);
    const weight = edge.weight * Math.min(1, 6 / Math.max(1e-6, residual));
    x += (other.x - edge.dx) * weight;
    y += (other.y - edge.dy) * weight;
    total += weight;
  }
  return total ? { x: x / total, y: y / total } : { x: node.x, y: node.y };
}
export function optimizeSmallGraph(nodes: PoseNode[], iterations = 100): PoseNode[] {
  const map = new Map(nodes.map((n) => [n.id, structuredClone(n)]));
  for (let k = 0; k < iterations; k++) {
    let max = 0;
    for (const node of [...map.values()]) {
      const p = relaxPose(node, map);
      max = Math.max(max, Math.hypot(p.x - node.x, p.y - node.y));
      Object.assign(node, p);
    }
    if (max < 1e-5) {
      break;
    }
  }
  return [...map.values()];
}
/** Persistent graph: the optimizer pages nodes instead of holding all keyframes/edges in memory. */
export class PoseGraph {
  loops = 0;
  constructor(readonly db: KV) {}
  nodeId(canvasId: string, frame: number): string {
    return `${canvasId}/${pad(frame)}`;
  }
  /** `weight` is the confidence of the odometry edge to `previous`: a step measured on a thin overlap must not pull as hard as a well-supported one. */
  async add(canvasId: string, frame: number, p: Point, previous?: PoseNode, weight = 1): Promise<PoseNode> {
    if (previous) {
      previous = (await this.get(previous.id))!;
    }
    const id = this.nodeId(canvasId, frame),
      node: PoseNode = {
        id,
        canvasId,
        frame,
        x: p.x + (previous ? previous.x - previous.originalX : 0),
        y: p.y + (previous ? previous.y - previous.originalY : 0),
        originalX: p.x,
        originalY: p.y,
        pinned: !previous,
        edges: [],
      };
    await this.db.put(`node/${id}`, node);
    if (previous) {
      await this.connect(previous.id, id, p.x - previous.originalX, p.y - previous.originalY, weight, 'odometry');
      previous.next = id;
      await this.db.put(`node/${previous.id}`, { ...(await this.get(previous.id)), next: id });
    }
    return (await this.get(id))!;
  }
  get(id: string): Promise<PoseNode | undefined> {
    return this.db.get<PoseNode>(`node/${id}`);
  }
  async connect(aId: string, bId: string, dx: number, dy: number, weight: number, kind: 'odometry' | 'loop'): Promise<void> {
    const a = await this.get(aId), b = await this.get(bId);
    if (!a || !b) {
      throw new Error('Pose graph references a missing node.');
    }
    if (aId === bId) {
      return;
    }
    const aKey = `edge/${aId}/${bId}/${kind}`, bKey = `edge/${bId}/${aId}/${kind}`;
    if (await this.db.get(aKey)) {
      return;
    }
    // Adjacency is paged as individual disk records: many revisits never grow a node in RAM.
    await this.db.putMany([{ key: aKey, value: { other: bId, dx, dy, weight, kind } }, {
      key: bKey,
      value: { other: aId, dx: -dx, dy: -dy, weight, kind },
    }]);
    if (kind === 'loop') {
      this.loops++;
      const correction = { x: a.x + dx - b.x, y: a.y + dy - b.y };
      // Initialize the long chain with distributed closure error. This also avoids glacial
      // convergence of plain Gauss–Seidel on a many-thousand-keyframe chain.
      if (a.canvasId === b.canvasId && b.frame > a.frame) {
        for await (const row of iterate<PoseNode>(this.db, `node/${a.canvasId}/`)) {
          const n = row.value;
          if (n.frame <= a.frame || n.pinned) {
            continue;
          }
          const t = clamp((n.frame - a.frame) / (b.frame - a.frame), 0, 1);
          n.x += correction.x * t;
          n.y += correction.y * t;
          await this.db.put(row.key, n);
        }
      }
    }
  }
  async optimize(checkpoint: () => Promise<void>): Promise<{
    residual: number;
    iterations: number;
  }> {
    if (!this.loops) {
      return { residual: 0, iterations: 0 };
    }
    let iterations = 0;
    for (; iterations < 12; iterations++) {
      let maxChange = 0;
      for await (const row of iterate<PoseNode>(this.db, 'node/', iterations % 2 === 1)) {
        const node = row.value;
        if (node.pinned) {
          continue;
        }
        let x = 0, y = 0, total = 0;
        for await (const { value: edge } of iterate<PoseEdge>(this.db, `edge/${node.id}/`)) {
          const other = await this.get(edge.other);
          if (!other) {
            continue;
          }
          const residual = Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy),
            weight = edge.weight * Math.min(1, 6 / Math.max(1e-6, residual));
          x += (other.x - edge.dx) * weight;
          y += (other.y - edge.dy) * weight;
          total += weight;
        }
        const p = total ? { x: x / total, y: y / total } : { x: node.x, y: node.y };
        maxChange = Math.max(maxChange, Math.hypot(node.x - p.x, node.y - p.y));
        node.x = p.x;
        node.y = p.y;
        await this.db.put(row.key, node);
        await checkpoint();
      }
      if (maxChange < .04) {
        iterations++;
        break;
      }
    }
    let residual = 0;
    for await (const { value: node } of iterate<PoseNode>(this.db, 'node/')) {
      for await (const { value: edge } of iterate<PoseEdge>(this.db, `edge/${node.id}/`)) {
        const other = await this.get(edge.other);
        if (other) {
          residual = Math.max(residual, Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy));
        }
      }
    }
    return { residual, iterations };
  }
  async correction(id: string, frame: number): Promise<Point> {
    const a = await this.get(id);
    if (!a) {
      throw new Error('Missing pose for frame rendering.');
    }
    let x = a.x - a.originalX, y = a.y - a.originalY;
    if (a.next) {
      const b = await this.get(a.next);
      if (b && b.frame > a.frame) {
        const t = clamp((frame - a.frame) / (b.frame - a.frame), 0, 1);
        x = x * (1 - t) + (b.x - b.originalX) * t;
        y = y * (1 - t) + (b.y - b.originalY) * t;
      }
    }
    return { x, y };
  }
}
