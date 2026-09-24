/** FROZEN copy of `PoseGraph.optimize()`'s/residual's Gauss-Seidel relaxation math (pre-Rust-port pose-graph.ts,
 *  commit 6f838af), lifted to operate on plain arrays + CSR adjacency instead of the KV-backed `Map<string,
 *  PoseNode>` graph — the exact shape `pose-graph.ts::optimize()` now builds before handing it to
 *  `rust/core/src/pose_graph.rs`. Parity oracle for tests/unit/parity/pose-graph.test.ts. Not used by production
 *  code. Do not "fix": if this drifts from what the original TS computed, the port it is checking against is no
 *  longer verified. */
export interface ReferenceNode {
  x: number;
  y: number;
  pinned: boolean;
}
export interface ReferenceEdge {
  /** Node index, or -1 for "not found" (mirrors `this.nodes.get(edge.other)` returning `undefined`). */
  other: number;
  dx: number;
  dy: number;
  weight: number;
}

/** One Gauss-Seidel sweep (`optimize()`'s per-node loop body, forward on even iterations, reversed on odd ones);
 *  mutates `nodes` in place and returns the largest single-node displacement. */
export function referencePass(nodes: ReferenceNode[], offsets: number[], edges: ReferenceEdge[], reverse: boolean): number {
  let maxChange = 0;
  const n = nodes.length, order: number[] = [];
  if (reverse) {
    for (let i = n - 1; i >= 0; i--) order.push(i);
  } else {
    for (let i = 0; i < n; i++) order.push(i);
  }
  for (const i of order) {
    const node = nodes[i];
    if (node.pinned) {
      continue;
    }
    const start = offsets[i], end = offsets[i + 1];
    if (start === end) {
      continue;
    }
    let x = 0, y = 0, total = 0;
    for (let k = start; k < end; k++) {
      const edge = edges[k];
      if (edge.other < 0) {
        continue;
      }
      const other = nodes[edge.other];
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
  }
  return maxChange;
}

/** `optimize()`'s trailing residual loop: the largest edge residual over the current positions. */
export function referenceResidual(nodes: ReferenceNode[], offsets: number[], edges: ReferenceEdge[]): number {
  let residual = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    for (let k = offsets[i]; k < offsets[i + 1]; k++) {
      const edge = edges[k];
      if (edge.other < 0) {
        continue;
      }
      const other = nodes[edge.other];
      residual = Math.max(residual, Math.hypot(other.x - node.x - edge.dx, other.y - node.y - edge.dy));
    }
  }
  return residual;
}
