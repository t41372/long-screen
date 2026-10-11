/** The solve pass's session (`long_screen::engine::solve::SolveSession`), mirroring `rust/wasm/src/solve.rs`: encodes
 *  each call's input and decodes the placements, voting records, rows to store and diagnostic events into the same
 *  JS objects the pass has always stored (field order included); diagnostics are `diagnostic.ts`'s structured form. */
import type { Attachment, CanvasMeta, CompactFeatures, Feature, Gray, Placement, Rect, Region } from '../../types.ts';
import type { Keyframe } from '../keyframes.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { VOTING_REGION_BYTES } from './exports.ts';
import { ByteReader, ByteWriter } from './bytes.ts';
import { type EngineDiagnostic, readDiagnostic } from './diagnostic.ts';
import { writeRegionDescriptor } from './marshal.ts';
import { FreeGuard, type Resident, ResidentFrame } from './memory.ts';
import { PoseGraphState, type PoseWrite, readWrites } from './pose-graph.ts';
import type { VotingRecord, VotingVerdict } from './voting.ts';

/** A region the pass tracks, with its code in the atlas label plane. */
export interface SolveRegionInput {
  region: Region;
  code: number;
}
/** Something the pass did that the host carries out, in order. */
export type SolveEffect =
  | { kind: 'canvas'; meta: CanvasMeta; created: boolean }
  | { kind: 'attach'; attachment: Attachment }
  | { kind: 'keyframe'; keyframe: Keyframe }
  | { kind: 'graph'; write: PoseWrite }
  | { kind: 'diagnostic'; diagnostic: EngineDiagnostic };
export type SolvePoll = { keyframes: string[] } | { placements: Placement[]; joinedRing: boolean; voting: VotingRecord[] };
export type SolveBegin = { duplicate: Placement[] } | { gray: boolean };

const STATUS_MESSAGES: Record<number, string> = {
  [-2]: 'Pose graph references a missing previous node.',
  [-3]: 'Pose graph references a missing node.',
  [-4]: 'Missing pose for frame rendering.',
};

function readRect(r: ByteReader): Rect {
  return { x: r.f64(), y: r.f64(), width: r.f64(), height: r.f64() };
}
function readPlacements(r: ByteReader): Placement[] {
  const out: Placement[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const layer = r.str(), canvasId = r.str(), node = r.str(), x = r.f64(), y = r.f64(), confidence = r.f64();
    const uncertain = r.bool(), time = r.f64(), skip = r.bool(), occlusions: Rect[] = [];
    for (let k = r.u32(); k > 0; k--) occlusions.push(readRect(r));
    out.push({
      layer,
      canvasId,
      node,
      x,
      y,
      confidence,
      uncertain,
      time,
      ...(skip ? { skip: true } : {}),
      ...(occlusions.length ? { occlusions } : {}),
    });
  }
  return out;
}
function readVoting(r: ByteReader): VotingRecord[] {
  const out: VotingRecord[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const index = r.u32(), votedLayers = r.u32(), thinLayers = r.u32();
    let record: Record<string, VotingVerdict> | undefined;
    for (let k = r.u32(); k > 0; k--) {
      const region = r.str();
      (record ??= {})[region] = { x0: r.i32(), y0: r.i32(), w: r.i32(), h: r.i32(), bits: r.blob(), clean: r.blob() };
    }
    out.push({ index, record, votedLayers, thinLayers });
  }
  return out;
}
function readPoll(r: ByteReader): SolvePoll {
  if (r.u8() === 0) {
    const keyframes: string[] = [];
    for (let n = r.u32(); n > 0; n--) keyframes.push(r.str());
    return { keyframes };
  }
  const placements = readPlacements(r), joinedRing = r.bool();
  return { placements, joinedRing, voting: readVoting(r) };
}
function readFeature(r: ByteReader): Feature {
  const x = r.i32(), y = r.i32(), score = r.f64(), descriptor = new Uint32Array(8);
  for (let i = 0; i < 8; i++) descriptor[i] = r.u32();
  return { x, y, score, descriptor };
}
function writeFeature(w: ByteWriter, f: Feature): void {
  w.i32(f.x).i32(f.y).f64(f.score);
  for (let i = 0; i < 8; i++) w.u32(f.descriptor[i]);
}
function readKeyframe(r: ByteReader): Keyframe {
  const id = r.str(), node = r.str(), canvasId = r.str(), layer = r.str(), frame = r.u32(), features: Feature[] = [];
  for (let n = r.u32(); n > 0; n--) features.push(readFeature(r));
  const width = r.u32(), height = r.u32(), gray: Gray = { width, height, data: r.blob() };
  const x = r.f64(), y = r.f64(), scaleX = r.f64(), scaleY = r.f64(), patches: Keyframe['patches'] = [];
  for (let n = r.u32(); n > 0; n--) patches.push({ x: r.f64(), y: r.f64(), size: r.u32(), data: r.blob() });
  return { id, node, canvasId, layer, frame, features, gray, x, y, scaleX, scaleY, patches };
}
function writeKeyframe(w: ByteWriter, k: Keyframe): void {
  w.str(k.id).str(k.node).str(k.canvasId).str(k.layer).u32(k.frame).u32(k.features.length);
  for (const f of k.features) writeFeature(w, f);
  w.u32(k.gray.width).u32(k.gray.height).blob(k.gray.data).f64(k.x).f64(k.y).f64(k.scaleX).f64(k.scaleY).u32(k.patches.length);
  for (const p of k.patches) w.f64(p.x).f64(p.y).u32(p.size).blob(p.data);
}
function readAttachment(r: ByteReader): Attachment {
  return { id: r.str(), target: r.str(), dx: r.f64(), dy: r.f64(), frame: r.u32(), confidence: r.f64(), node: r.str() };
}
function readEffect(r: ByteReader): SolveEffect {
  switch (r.u8()) {
    case 0: {
      const created = r.bool();
      const meta: CanvasMeta = {
        id: r.str(),
        layer: r.str(),
        name: r.str(),
        kind: r.str(),
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        tileCount: 0,
        observedPixels: 0,
        uncertainPixels: 0,
        conflictPixels: 0,
        provisionalPixels: 0,
        maxLevel: 0,
        fragment: r.u32(),
        firstTime: r.f64(),
        lastTime: r.f64(),
      };
      if (r.bool()) meta.attachedTo = r.str();
      return { kind: 'canvas', meta, created };
    }
    case 1:
      return { kind: 'attach', attachment: readAttachment(r) };
    case 2:
      return { kind: 'keyframe', keyframe: readKeyframe(r) };
    case 3:
      return { kind: 'graph', write: readWrites(r)[0] };
    default:
      return { kind: 'diagnostic', diagnostic: readDiagnostic(r) };
  }
}

/** One `long_screen::engine::solve::SolveSession` in core memory. Its owner frees it when the pass ends. */
export class SolveSessionState {
  private readonly freeGuard = new FreeGuard();
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly width: number,
    readonly height: number,
  ) {}
  private result(length: number, what: string): ByteReader {
    if (length < -1 && STATUS_MESSAGES[length]) throw new Error(STATUS_MESSAGES[length]);
    this.core.check(length, what);
    const [out] = this.core.scratch([length]);
    this.core.check(this.exports.ls_solve_take(this.handle, out, length), `${what} result`);
    return new ByteReader(this.core.readBytes(out, length));
  }
  /** Starts frame `index`: a duplicate frame's replayed placements, or whether the frame needs an analysis gray. */
  begin(index: number, time: number, scan: { duplicate?: boolean; field: { zoom: number; difference: number } }): SolveBegin {
    const r = this.result(
      this.exports.ls_solve_begin(this.handle, index, time, scan.duplicate ? 1 : 0, scan.field.zoom, scan.field.difference),
      'solve begin',
    );
    return r.u8() === 0 ? { duplicate: readPlacements(r) } : { gray: r.bool() };
  }
  /** The engine's frame slot the frame `begin` asked for goes into; a view, never freed by its holder. */
  frame(): ResidentFrame {
    return new ResidentFrame(this.exports, this.exports.ls_solve_frame(this.handle), this.width, this.height);
  }
  /** Solves the frame written into `frame()`. */
  run(gray: Gray | undefined, features: CompactFeatures | undefined, labels: Resident): SolvePoll {
    const n = features?.score.length ?? 0;
    const [pGray, pFeatures] = this.core.scratch([gray?.data.byteLength ?? 0, features ? n * 40 : 0]);
    if (gray) this.core.writeBytes(pGray, gray.data);
    if (features) {
      this.core.writeBytes(pFeatures, features.xy.subarray(0, n * 2));
      this.core.writeBytes(pFeatures + n * 4, features.score.subarray(0, n));
      this.core.writeBytes(pFeatures + n * 8, features.descriptors.subarray(0, n * 8));
    }
    return readPoll(this.result(
      this.exports.ls_solve_run(
        this.handle,
        gray ? pGray : 0,
        gray?.data.byteLength ?? 0,
        features ? pFeatures : 0,
        n,
        labels.ptr,
      ),
      'solve run',
    ));
  }
  /** Hands in the keyframe rows the last poll asked for (undefined for a row the store did not have). */
  provide(rows: (Keyframe | undefined)[], labels: Resident): SolvePoll {
    const w = new ByteWriter().u32(rows.length);
    for (const row of rows) {
      w.bool(row !== undefined);
      if (row) writeKeyframe(w, row);
    }
    const [ptr, len] = w.place(this.core);
    return readPoll(this.result(this.exports.ls_solve_provide(this.handle, ptr, len, labels.ptr), 'solve provide'));
  }
  /** The effects produced since the last call, in order. */
  effects(): SolveEffect[] {
    const r = this.result(this.exports.ls_solve_effects(this.handle), 'solve effects'), out: SolveEffect[] = [];
    for (let n = r.u32(); n > 0; n--) out.push(readEffect(r));
    return out;
  }
  /** Finalises every frame still in the voting ring. */
  drain(): VotingRecord[] {
    return readVoting(this.result(this.exports.ls_solve_drain(this.handle), 'solve drain'));
  }
  /** Hands the pose graph over; the caller frees it. */
  takeGraph(): PoseGraphState {
    return new PoseGraphState(this.core, this.exports, this.core.check(this.exports.ls_solve_take_graph(this.handle), 'solve graph'));
  }
  free(): void {
    this.freeGuard.once(() => {
      this.exports.ls_solve_free(this.handle);
      this.handle = 0;
    });
  }
}

/** Creates a session over `regions` (the run's non-ignored regions, in order) for frames of `width × height`. */
export function solveSession(
  core: Core,
  exports: CoreExports,
  options: { width: number; height: number; factor: number; radius: number; noise: number; regions: SolveRegionInput[] },
): SolveSessionState {
  const { width, height, factor, radius, noise, regions } = options;
  const w = new ByteWriter().u32(width).u32(height).u32(factor).i32(radius).f64(noise).u32(regions.length);
  for (const { region, code } of regions) {
    w.str(region.id).str(region.name).str(region.kind).bool(region.kind === 'moving').bool(!!region.unassigned).u8(code);
  }
  const sizes: number[] = [regions.length * VOTING_REGION_BYTES];
  for (const { region: r } of regions) {
    sizes.push((r.exclusions?.length || 0) * 32, r.crop ? 32 : 0, r.mask && !r.solid ? r.mask.byteLength : 0);
  }
  const [ptr, len, base, ...rest] = w.place(core, sizes);
  regions.forEach(({ region }, i) => {
    const [exclusions, crop, mask] = rest.slice(i * 3, i * 3 + 3);
    writeRegionDescriptor(exports, base, i * VOTING_REGION_BYTES, region, exclusions, crop, mask);
  });
  const handle = core.check(exports.ls_solve_new(ptr, len, base), 'solve session');
  return new SolveSessionState(core, exports, handle, width, height);
}
