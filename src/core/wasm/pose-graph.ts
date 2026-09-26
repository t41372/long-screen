/** Pose-graph relaxation (`src/core/pose-graph.ts::PoseGraph.optimize`), mirroring `rust/core/src/abi/pose_graph.rs`.
 *  One handle per `optimize()` call: `poseGraphNew` copies the node/edge arrays the caller built from its `Map`
 *  iteration order into a Rust-owned graph; `poseGraphPass` runs one Gauss-Seidel sweep (so the caller can await
 *  its stop-checkpoint between sweeps — the loop itself stays in pose-graph.ts, not here); `poseGraphResidual`/
 *  `poseGraphRead` drain the final state before `poseGraphFree`. */
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';

/** Plain-array input built by `pose-graph.ts::optimize()`: `nodes` in the same order the caller will write results
 *  back in, `edges` a CSR adjacency over that same node order (`offsets[i]..offsets[i + 1]` into the edge arrays). */
export interface PoseGraphNodes {
  x: Float64Array;
  y: Float64Array;
  pinned: Uint8Array;
}
export interface PoseGraphEdges {
  offsets: Uint32Array;
  other: Int32Array;
  dx: Float64Array;
  dy: Float64Array;
  weight: Float64Array;
}

export function poseGraphNew(core: Core, exports: CoreExports, nodes: PoseGraphNodes, edges: PoseGraphEdges): number {
  const n = nodes.x.length, m = edges.other.length;
  const [xsPtr, ysPtr, pinnedPtr, offsetsPtr, otherPtr, dxPtr, dyPtr, weightPtr] = core.scratch([
    n * 8,
    n * 8,
    n,
    (n + 1) * 4,
    m * 4,
    m * 8,
    m * 8,
    m * 8,
  ]);
  core.writeBytes(xsPtr, nodes.x);
  core.writeBytes(ysPtr, nodes.y);
  core.writeBytes(pinnedPtr, nodes.pinned);
  core.writeBytes(offsetsPtr, edges.offsets);
  core.writeBytes(otherPtr, edges.other);
  core.writeBytes(dxPtr, edges.dx);
  core.writeBytes(dyPtr, edges.dy);
  core.writeBytes(weightPtr, edges.weight);
  return core.check(
    exports.ls_pose_graph_new(xsPtr, ysPtr, pinnedPtr, n, offsetsPtr, otherPtr, dxPtr, dyPtr, weightPtr, m),
    'pose graph new',
  );
}

/** Solves one anchored simple cycle exactly when every residual stays in Huber's quadratic region. */
export function poseGraphSolveCycle(core: Core, exports: CoreExports, handle: number): boolean {
  return core.check(exports.ls_pose_graph_solve_cycle(handle), 'pose graph cycle') === 1;
}

/** One Gauss-Seidel sweep; returns the largest single-node displacement (`maxChange`). */
export function poseGraphPass(exports: CoreExports, handle: number, reverse: boolean): number {
  const result = exports.ls_pose_graph_pass(handle, reverse ? 1 : 0);
  if (result === -Number.MAX_VALUE) {
    throw new Error('CORE_BAD_ARGUMENT: pose graph pass on an invalid handle.');
  }
  return result;
}

export function poseGraphResidual(exports: CoreExports, handle: number): number {
  const result = exports.ls_pose_graph_residual(handle);
  if (result === -Number.MAX_VALUE) {
    throw new Error('CORE_BAD_ARGUMENT: pose graph residual on an invalid handle.');
  }
  return result;
}

/** Reads back every node's current `x`/`y`, in the same order `poseGraphNew` was given them. */
export function poseGraphRead(core: Core, exports: CoreExports, handle: number, count: number): { x: Float64Array; y: Float64Array } {
  const [xsPtr, ysPtr] = core.scratch([count * 8, count * 8]);
  core.check(exports.ls_pose_graph_read(handle, xsPtr, ysPtr), 'pose graph read');
  // `readBytes` already copies out of core memory (a fresh, independent ArrayBuffer), so wrapping it in a
  // Float64Array view here needs no further copy.
  return {
    x: new Float64Array(core.readBytes(xsPtr, count * 8).buffer as ArrayBuffer, 0, count),
    y: new Float64Array(core.readBytes(ysPtr, count * 8).buffer as ArrayBuffer, 0, count),
  };
}

export function poseGraphFree(exports: CoreExports, handle: number): void {
  exports.ls_pose_graph_free(handle);
}
