/** The engine's render session (mirrors the `ls_render_*` exports in `rust/wasm/src/render.rs`; record layouts are
 *  described there). Decoded rows are built field by field in the persisted order, so an `observation/` row and the
 *  placements inside it are the same JS objects the pass wrote before it moved into the engine. */
import type { Attachment, FramePlan, Placement, Rect } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { type ByteReader, ByteWriter, takeResult } from './bytes.ts';
import { type EngineDiagnostic, readDiagnostics } from './diagnostic.ts';
import { FreeGuard, type Resident } from './memory.ts';
import type { CompositorHandle } from './compositor.ts';
import type { TileCacheHandle } from './tiles.ts';
import type { PoseGraphState } from './pose-graph.ts';

export interface RenderRegionInput {
  id: string;
  kind: 'moving' | 'fixed' | 'ignore';
  rect: Rect;
  /** The region's code in the atlas label plane, and how many pixels the atlas gives it. */
  code: number;
  ownedPixels: number;
}
export interface RenderSessionConfig {
  width: number;
  height: number;
  factor: number;
  noise: number;
  regions: RenderRegionInput[];
  attachments: Attachment[];
}
/** One region's verdict in a `consistency/<frame>` row (see `pipeline/consistency.ts`'s `ConsistencyVote`). */
interface VoteRow {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  clean: Uint8Array;
}
export interface RenderFrameInput {
  index: number;
  time: number;
  plan: FramePlan;
  hasPrev: boolean;
  prevPlan?: FramePlan;
  hasNext: boolean;
  nextPlan?: FramePlan;
  /** The `consistency/<frame>` rows `wantedVotes` named, `undefined` where none is stored. */
  votes: { index: number; record: Record<string, VoteRow> | undefined }[];
}
/** The CanvasMeta fields the render pass changes. */
export interface RenderMeta {
  bounds: Rect;
  tileCount: number;
  observedPixels: number;
  uncertainPixels: number;
  conflictPixels: number;
  provisionalPixels: number;
  lastTime: number;
}
export interface RenderDecision {
  canvasId: string;
  placement: Placement;
  addedPixels: number;
  conflictPixels: number;
  uncertainPixels: number;
  skipped?: boolean;
  reusedExactObservation?: boolean;
}
export interface RenderObservation {
  frame: number;
  time: number;
  decisions: RenderDecision[];
}
export type RenderNeed =
  | { kind: 'done'; observation: RenderObservation; latest?: string }
  | { kind: 'meta'; canvas: string }
  | { kind: 'frame'; index: number }
  | { kind: 'tile'; canvas: string; x: number; y: number }
  | { kind: 'temporal'; canvas: string }
  | { kind: 'error'; message: string };
export interface RenderStepResult {
  /** Diagnostics raised by this step, in emission order. */
  events: EngineDiagnostic[];
  /** Cumulative over the session. */
  counters: { skippedPaints: number; tiles: number; observedPixels: number };
  need: RenderNeed;
}
const KINDS = { moving: 0, fixed: 1, ignore: 2 } as const;

function writeRect(w: ByteWriter, r: Rect): ByteWriter {
  return w.f64(r.x).f64(r.y).f64(r.width).f64(r.height);
}
function readRect(r: ByteReader): Rect {
  return { x: r.f64(), y: r.f64(), width: r.f64(), height: r.f64() };
}
function writePlacement(w: ByteWriter, p: Placement): void {
  w.str(p.layer).str(p.canvasId).str(p.node).f64(p.x).f64(p.y).f64(p.confidence).bool(!!p.uncertain).f64(p.time);
  w.u8(p.skip === undefined ? 0 : p.skip ? 2 : 1).bool(p.occlusions !== undefined);
  if (p.occlusions) {
    w.u32(p.occlusions.length);
    for (const r of p.occlusions) writeRect(w, r);
  }
}
/** A plan row's placement, keys in the order solve writes them; `skip`/`occlusions` only when the row had them. */
function readPlacement(r: ByteReader): Placement {
  const p: Placement = {
    layer: r.str(),
    canvasId: r.str(),
    node: r.str(),
    x: r.f64(),
    y: r.f64(),
    confidence: r.f64(),
    uncertain: r.bool(),
    time: r.f64(),
  };
  const skip = r.u8();
  if (skip) p.skip = skip === 2;
  if (r.bool()) p.occlusions = Array.from({ length: r.u32() }, () => readRect(r));
  return p;
}
function writePlan(w: ByteWriter, plan: FramePlan): void {
  w.bool(!!plan.duplicate).u32(plan.placements.length);
  for (const p of plan.placements) writePlacement(w, p);
}
function writeOptionalPlan(w: ByteWriter, plan: FramePlan | undefined): void {
  w.bool(plan !== undefined);
  if (plan) writePlan(w, plan);
}
function writeBytes(w: ByteWriter, bytes: Uint8Array): void {
  w.u32(bytes.length).raw(bytes);
}
function readMeta(r: ByteReader): RenderMeta {
  return {
    bounds: readRect(r),
    tileCount: r.f64(),
    observedPixels: r.f64(),
    uncertainPixels: r.f64(),
    conflictPixels: r.f64(),
    provisionalPixels: r.f64(),
    lastTime: r.f64(),
  };
}
function writeMeta(w: ByteWriter, m: RenderMeta): void {
  writeRect(w, m.bounds).f64(m.tileCount).f64(m.observedPixels).f64(m.uncertainPixels).f64(m.conflictPixels)
    .f64(m.provisionalPixels).f64(m.lastTime);
}
function readDecision(r: ByteReader): RenderDecision {
  const d: RenderDecision = {
    canvasId: r.str(),
    placement: readPlacement(r),
    addedPixels: r.f64(),
    conflictPixels: r.f64(),
    uncertainPixels: r.f64(),
  };
  if (r.bool()) d.skipped = true;
  if (r.bool()) d.reusedExactObservation = true;
  return d;
}

export class RenderSessionHandle {
  private readonly freeGuard = new FreeGuard();
  constructor(private readonly core: Core, private readonly exports: CoreExports, readonly handle: number) {}
  /** Reads the result a call left in the session (its length, or a negative status). */
  private result(length: number, what: string): ByteReader {
    this.core.check(length, what);
    return takeResult(this.core, length, (out, n) => this.exports.ls_render_take(this.handle, out, n), `${what} result`);
  }
  /** Sizes the tile cache for the pass; returns the `MEMORY_BUDGET_RAISED` diagnostic when it had to raise the
   *  limit. */
  configureTiles(tiles: TileCacheHandle, memoryMB: number): EngineDiagnostic | undefined {
    return readDiagnostics(
      this.result(this.exports.ls_render_configure_tiles(this.handle, tiles.handle, memoryMB), 'renderConfigureTiles'),
    )[0];
  }
  /** The `consistency/<frame>` rows to read before `begin`, in order. */
  wantedVotes(index: number, hasPrev: boolean, hasNext: boolean): number[] {
    const r = this.result(this.exports.ls_render_wanted_votes(this.handle, index, hasPrev ? 1 : 0, hasNext ? 1 : 0), 'renderWantedVotes');
    return Array.from({ length: r.u32() }, () => r.f64());
  }
  begin(input: RenderFrameInput): void {
    const w = new ByteWriter().u32(input.index).f64(input.time);
    writePlan(w, input.plan);
    writeOptionalPlan(w.bool(input.hasPrev), input.prevPlan);
    writeOptionalPlan(w.bool(input.hasNext), input.nextPlan);
    w.u32(input.votes.length);
    for (const { index, record } of input.votes) {
      w.f64(index).bool(record !== undefined);
      if (!record) continue;
      const entries = Object.entries(record);
      w.u32(entries.length);
      for (const [id, v] of entries) {
        w.str(id).u32(v.x0).u32(v.y0).u32(v.w).u32(v.h);
        writeBytes(w, v.bits);
        writeBytes(w, v.clean);
      }
    }
    const [ptr, len] = w.place(this.core);
    this.core.check(this.exports.ls_render_begin(this.handle, ptr, len), 'renderBegin');
  }
  step(compositor: CompositorHandle, tiles: TileCacheHandle, graph: PoseGraphState, labels: Resident, now: number): RenderStepResult {
    const length = this.exports.ls_render_step(this.handle, compositor.handle, tiles.handle, graph.handle, labels.ptr, labels.length, now);
    const r = this.result(length, 'renderStep');
    const events = readDiagnostics(r);
    const counters = { skippedPaints: r.f64(), tiles: r.f64(), observedPixels: r.f64() };
    const kind = r.u8();
    let need: RenderNeed;
    if (kind === 0) {
      const observation: RenderObservation = { frame: r.u32(), time: r.f64(), decisions: [] };
      const count = r.u32();
      for (let i = 0; i < count; i++) observation.decisions.push(readDecision(r));
      need = { kind: 'done', observation, latest: r.bool() ? r.str() : undefined };
    } else if (kind === 1) need = { kind: 'meta', canvas: r.str() };
    else if (kind === 2) need = { kind: 'frame', index: r.u32() };
    else if (kind === 3) {
      const canvas = r.str(), x = r.u32() | 0, y = r.u32() | 0;
      need = { kind: 'tile', canvas, x, y };
    } else if (kind === 4) need = { kind: 'temporal', canvas: r.str() };
    else need = { kind: 'error', message: r.str() };
    return { events, counters, need };
  }
  provideMeta(canvas: string, meta: RenderMeta | undefined): void {
    const w = new ByteWriter().str(canvas).bool(meta !== undefined);
    if (meta) writeMeta(w, meta);
    const [ptr, len] = w.place(this.core);
    this.core.check(this.exports.ls_render_provide_meta(this.handle, ptr, len), 'renderProvideMeta');
  }
  /** Writes frame `index`'s RGBA into the ring slot the session gives it. */
  provideFrame(index: number, rgba: ArrayLike<number> & ArrayBufferView): void {
    const [out] = this.core.scratch([4]);
    this.core.check(this.exports.ls_render_frame_slot(this.handle, index, out), 'renderFrameSlot');
    const ptr = new DataView(this.exports.memory.buffer).getUint32(out, true);
    this.core.writeBytes(ptr, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  }
  cancel(compositor: CompositorHandle): void {
    this.exports.ls_render_cancel(this.handle, compositor.handle);
  }
  /** After the last frame: whether the session has a finishing job to step like a frame (`begin_finish`). */
  beginFinish(): boolean {
    return this.core.check(this.exports.ls_render_begin_finish(this.handle), 'renderBeginFinish') === 1;
  }
  /** Paints the fixed regions' first frame without transients into the reference frame `frame`, in place; whether
   *  any pixel changed (`patch_reference`). */
  patchReference(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, frame: number): boolean {
    const buffer = this.core.alloc(rgba.byteLength);
    try {
      this.core.writeBytes(buffer.ptr, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
      const changed = this.core.check(
        this.exports.ls_render_patch_reference(this.handle, buffer.ptr, width, height, frame),
        'renderPatchReference',
      ) === 1;
      if (changed) rgba.set(new Uint8Array(this.exports.memory.buffer, buffer.ptr, rgba.byteLength));
      return changed;
    } finally {
      buffer.free();
    }
  }
  meta(canvas: string): RenderMeta | undefined {
    const [ptr, len] = new ByteWriter().str(canvas).place(this.core);
    const r = this.result(this.exports.ls_render_meta(this.handle, ptr, len), 'renderMeta');
    return r.bool() ? readMeta(r) : undefined;
  }
  /** Canvases whose metadata changed since the last call, in first-changed order. */
  dirtyMetas(): { canvas: string; meta: RenderMeta }[] {
    const r = this.result(this.exports.ls_render_dirty_metas(this.handle), 'renderDirtyMetas');
    return Array.from({ length: r.u32() }, () => ({ canvas: r.str(), meta: readMeta(r) }));
  }
  free(): void {
    this.freeGuard.once(() => this.exports.ls_render_free(this.handle));
  }
}

export function renderSession(core: Core, exports: CoreExports, config: RenderSessionConfig): RenderSessionHandle {
  const w = new ByteWriter().u32(config.width).u32(config.height).u32(config.factor).f64(config.noise).u32(config.regions.length);
  for (const r of config.regions) writeRect(w.str(r.id).u8(KINDS[r.kind]), r.rect).u8(r.code).f64(r.ownedPixels);
  w.u32(config.attachments.length);
  for (const a of config.attachments) w.str(a.id).str(a.target).f64(a.dx).f64(a.dy).f64(a.frame).f64(a.confidence).str(a.node);
  const [ptr, len] = w.place(core);
  return new RenderSessionHandle(core, exports, core.check(exports.ls_render_new(ptr, len), 'renderNew'));
}
