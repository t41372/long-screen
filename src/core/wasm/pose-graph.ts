/** The pose graph state object (`long_screen_engine::pose_graph`), mirroring `rust/wasm/src/pose_graph.rs`: encodes
 *  each call's input, and decodes the node and the rows to store into the same JS objects the store has always
 *  held (field order included — `next` only once set, and last). */
import type { Point } from '../../types.ts';
import type { Row } from '../../storage/db.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { ByteReader, ByteWriter } from './bytes.ts';
import { FreeGuard } from './memory.ts';

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
  /** Always empty: adjacency is stored as `edge/` rows of its own. */
  edges: PoseEdge[];
  next?: string;
}
/** One storage call, in order: a single `put` (`many` false, one row) or one `putMany`. */
export interface PoseWrite {
  many: boolean;
  rows: Row[];
}

const STATUS_MESSAGES: Record<number, string> = {
  [-2]: 'Pose graph references a missing previous node.',
  [-3]: 'Pose graph references a missing node.',
  [-4]: 'Missing pose for frame rendering.',
};

function writeNode(w: ByteWriter, n: PoseNode): void {
  w.str(n.id).str(n.canvasId).u32(n.frame).f64(n.x).f64(n.y).f64(n.originalX).f64(n.originalY).bool(n.pinned).bool(n.next !== undefined);
  if (n.next !== undefined) w.str(n.next);
}
function writeEdge(w: ByteWriter, e: PoseEdge): void {
  w.str(e.other).f64(e.dx).f64(e.dy).f64(e.weight).u8(e.kind === 'loop' ? 1 : 0);
}
function readNode(r: ByteReader): PoseNode {
  const node: PoseNode = {
    id: r.str(),
    canvasId: r.str(),
    frame: r.u32(),
    x: r.f64(),
    y: r.f64(),
    originalX: r.f64(),
    originalY: r.f64(),
    pinned: r.bool(),
    edges: [],
  };
  if (r.bool()) node.next = r.str();
  return node;
}
export function readWrites(r: ByteReader): PoseWrite[] {
  const writes: PoseWrite[] = [];
  for (let i = r.u32(); i > 0; i--) {
    const many = r.bool(), rows: Row[] = [];
    for (let j = r.u32(); j > 0; j--) {
      if (r.u8() === 0) {
        const node = readNode(r);
        rows.push({ key: `node/${node.id}`, value: node });
      } else {
        const from = r.str(),
          edge: PoseEdge = { other: r.str(), dx: r.f64(), dy: r.f64(), weight: r.f64(), kind: r.u8() === 1 ? 'loop' : 'odometry' };
        rows.push({ key: `edge/${from}/${edge.other}/${edge.kind}`, value: edge });
      }
    }
    writes.push({ many, rows });
  }
  return writes;
}

/** One `long_screen_engine::pose_graph::PoseGraph` in core memory. `free()` releases it; a graph nobody frees is
 *  released when it is garbage collected. */
export class PoseGraphState {
  private static readonly registry = new FinalizationRegistry<{ exports: CoreExports; handle: number }>(({ exports, handle }) =>
    exports.ls_pose_graph_free(handle)
  );
  private readonly freeGuard = new FreeGuard();
  private readonly token = {};
  constructor(private readonly core: Core, private readonly exports: CoreExports, readonly handle: number) {
    PoseGraphState.registry.register(this, { exports, handle }, this.token);
  }
  private check(status: number, what: string): number {
    if (status < -1 && STATUS_MESSAGES[status]) throw new Error(STATUS_MESSAGES[status]);
    return this.core.check(status, what);
  }
  /** Calls a result-returning export with `input` and reads its result. */
  private call(what: string, call: (ptr: number, len: number) => number, input: ByteWriter): ByteReader {
    const [ptr, len] = input.place(this.core);
    const length = this.check(call(ptr, len), what);
    const [out] = this.core.scratch([length]);
    this.check(this.exports.ls_pose_graph_take(this.handle, out, length), `${what} result`);
    return new ByteReader(this.core.readBytes(out, length));
  }
  /** Takes back stored `node/` and `edge/` rows (with their keys), in the order the store returned them. */
  hydrate(rows: { node?: PoseNode; edge?: { key: string; value: PoseEdge } }[]): void {
    const w = new ByteWriter().u32(rows.length);
    for (const row of rows) {
      if (row.node) {
        writeNode(w.u8(0), row.node);
      } else {
        writeEdge(w.u8(1).str(row.edge!.key), row.edge!.value);
      }
    }
    const [ptr, len] = w.place(this.core);
    this.check(this.exports.ls_pose_graph_hydrate(this.handle, ptr, len), 'pose graph hydrate');
  }
  add(canvasId: string, frame: number, p: Point, previous: string | undefined, weight: number): { node: PoseNode; writes: PoseWrite[] } {
    const w = new ByteWriter().str(canvasId).u32(frame).f64(p.x).f64(p.y).f64(weight).bool(previous !== undefined);
    if (previous !== undefined) w.str(previous);
    const r = this.call('pose graph add', (ptr, len) => this.exports.ls_pose_graph_add(this.handle, ptr, len), w);
    return { node: readNode(r), writes: readWrites(r) };
  }
  connect(aId: string, bId: string, dx: number, dy: number, weight: number, kind: 'odometry' | 'loop'): PoseWrite[] {
    const w = new ByteWriter().str(aId).str(bId).f64(dx).f64(dy).f64(weight).u8(kind === 'loop' ? 1 : 0);
    return readWrites(this.call('pose graph connect', (ptr, len) => this.exports.ls_pose_graph_connect(this.handle, ptr, len), w));
  }
  unpin(id: string): PoseWrite[] {
    const w = new ByteWriter().str(id);
    return readWrites(this.call('pose graph unpin', (ptr, len) => this.exports.ls_pose_graph_unpin(this.handle, ptr, len), w));
  }
  get(id: string): PoseNode | undefined {
    const r = this.call('pose graph get', (ptr, len) => this.exports.ls_pose_graph_get(this.handle, ptr, len), new ByteWriter().str(id));
    return r.done ? undefined : readNode(r);
  }
  correction(id: string, frame: number): Point {
    const [ptr, len, out] = new ByteWriter().str(id).place(this.core, [16]);
    this.check(this.exports.ls_pose_graph_correction(this.handle, ptr, len, frame, out), 'pose graph correction');
    const view = new DataView(this.exports.memory.buffer, out, 16);
    return { x: view.getFloat64(0, true), y: view.getFloat64(8, true) };
  }
  get loops(): number {
    return this.check(this.exports.ls_pose_graph_loops(this.handle), 'pose graph loops');
  }
  /** Starts a relaxation; false when the graph holds no loop edge. */
  optimizeBegin(): boolean {
    return this.check(this.exports.ls_pose_graph_optimize_begin(this.handle), 'pose graph optimize') === 1;
  }
  /** Up to `sweeps` sweeps; true once the relaxation is done. */
  optimizeStep(sweeps: number): boolean {
    return this.check(this.exports.ls_pose_graph_optimize_step(this.handle, sweeps), 'pose graph optimize step') === 1;
  }
  /** Writes the finished relaxation back into the graph and returns its outcome and the rows to store. */
  optimizeFinish(): { residual: number; iterations: number; writes: PoseWrite[] } {
    const length = this.check(this.exports.ls_pose_graph_optimize_finish(this.handle), 'pose graph optimize finish');
    const [out] = this.core.scratch([length]);
    this.check(this.exports.ls_pose_graph_take(this.handle, out, length), 'pose graph optimize result');
    const r = new ByteReader(this.core.readBytes(out, length));
    return { residual: r.f64(), iterations: r.u32(), writes: readWrites(r) };
  }
  /** Drops a running relaxation without changing the graph. */
  optimizeCancel(): void {
    this.exports.ls_pose_graph_optimize_cancel(this.handle);
  }
  free(): void {
    this.freeGuard.once(() => {
      PoseGraphState.registry.unregister(this.token);
      this.exports.ls_pose_graph_free(this.handle);
    });
  }
}

export function poseGraph(core: Core, exports: CoreExports): PoseGraphState {
  return new PoseGraphState(core, exports, core.check(exports.ls_pose_graph_new(), 'pose graph new'));
}
