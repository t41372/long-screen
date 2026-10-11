import type { Point } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { core, type PoseEdge, type PoseGraphState, type PoseNode, type PoseWrite } from './wasm.ts';
export type { PoseEdge, PoseNode } from './wasm.ts';
/** Sweeps per relaxation step: the host checks for pause and stop after each one. */
const SWEEPS_PER_STEP = 1;
/** Host for the pose graph state object (`rust/engine/src/pose_graph.rs`): the graph itself lives in core memory;
 * this class reads it back from the store once (all `node/` rows, then all `edge/` rows) and stores every row the
 * engine hands back, with the same `put`/`putMany` calls in the same order. Nodes it returns are copies: a change
 * goes through a method (`unpin`), not through the object. */
export class PoseGraph {
  private state: PoseGraphState | undefined;
  private hydrated: Promise<PoseGraphState> | undefined;
  constructor(readonly db: KV) {}
  /** Loop edges in the graph, each counted once (valid once any other method has run). */
  get loops(): number {
    return this.state?.loops ?? 0;
  }
  private hydrate(): Promise<PoseGraphState> {
    return this.hydrated ??= (async () => {
      const state = this.state = core().poseGraph();
      const rows: Parameters<PoseGraphState['hydrate']>[0] = [];
      for await (const row of iterate<PoseNode>(this.db, 'node/')) {
        rows.push({ node: row.value });
      }
      for await (const row of iterate<PoseEdge>(this.db, 'edge/')) {
        rows.push({ edge: row });
      }
      state.hydrate(rows);
      return state;
    })();
  }
  private async store(writes: PoseWrite[]): Promise<void> {
    for (const { many, rows } of writes) {
      if (many) {
        await this.db.putMany(rows);
      } else {
        await this.db.put(rows[0].key, rows[0].value);
      }
    }
  }
  /** `weight` is the confidence of the odometry edge to `previous`: a step measured on a thin overlap must not pull as hard as a well-supported one. */
  async add(canvasId: string, frame: number, p: Point, previous?: PoseNode, weight = 1): Promise<PoseNode> {
    const { node, writes } = (await this.hydrate()).add(canvasId, frame, p, previous?.id, weight);
    await this.store(writes);
    return node;
  }
  async get(id: string): Promise<PoseNode | undefined> {
    return (await this.hydrate()).get(id);
  }
  async connect(aId: string, bId: string, dx: number, dy: number, weight: number, kind: 'odometry' | 'loop'): Promise<void> {
    await this.store((await this.hydrate()).connect(aId, bId, dx, dy, weight, kind));
  }
  /** Lets a relocalized or attached node move under relaxation, and stores it. */
  async unpin(id: string): Promise<void> {
    await this.store((await this.hydrate()).unpin(id));
  }
  /** Relaxes the graph a sweep at a time, awaiting `checkpoint` after each step; a throw from `checkpoint` (a stop)
   * leaves the graph and the store as they were. */
  async optimize(checkpoint: () => Promise<void>): Promise<{
    residual: number;
    iterations: number;
  }> {
    const state = await this.hydrate();
    if (!state.optimizeBegin()) {
      return { residual: 0, iterations: 0 };
    }
    let finished = false;
    try {
      for (let done = false; !done;) {
        done = state.optimizeStep(SWEEPS_PER_STEP);
        await checkpoint();
      }
      const { residual, iterations, writes } = state.optimizeFinish();
      finished = true;
      await this.store(writes);
      return { residual, iterations };
    } finally {
      if (!finished) state.optimizeCancel();
    }
  }
  async correction(id: string, frame: number): Promise<Point> {
    return (await this.hydrate()).correction(id, frame);
  }
  /** Releases the engine's graph (the pass that built this one calls it at its end); safe to call again. */
  free(): void {
    this.state?.free();
  }
}
