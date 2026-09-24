// Shell around the solve pass: setup (pose graph, keyframe index, per-region states, frame ring, atlas label
// plane, native luma plane, voting ring), the frame loop (duplicate-frame shortcut, per-frame preparation, one
// stepRegion() call per region), plan/consistency batching, voting push/drain, trailing commits, pass-mismatch
// accounting, graph optimise, scratch deletion. The per-region tracking DECISIONS this loop used to compute inline
// (hypothesis scoring, audit acceptance, native refinement choice, the confidence formula, anchor re-acquisition,
// keyframe/revisit/attachment/loop-closure decisions) now live in track.ts, most of them thin calls into the Rust
// core (see its header and docs/history/2026-09-rust-migration-log.md "已在 Rust 核心中"); region-step.ts's
// stepRegion() applies them in the original order. Everything in this file is orchestration shell, unambiguously
// not awaiting a port.
import type { Attachment, Feature, FramePlan, Gray, Placement, RGBA, ScanRecord } from '../../types.ts';
import { deletePrefix } from '../../storage/db.ts';
import type { RegionAtlas } from '../../core/layers.ts';
import { PoseGraph } from '../../core/pose-graph.ts';
import { KeyframeIndex } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import {
  core,
  type FrameRing,
  type LabelMask,
  ResidentFrame,
  type ResidentGray,
  type VotingRecord,
  type VotingRing,
} from '../../core/wasm.ts';
import { releaseUnlessHeld } from '../../media/pool.ts';
import { type CompactFeatures, decodeFeatures } from '../features-codec.ts';
import type { ConsistencyRecord } from '../consistency.ts';
import { prefixOnly, type RunContext, StopRequested, StorageError } from '../context.ts';
import { initialState, type RegionState } from './state.ts';
import { type FrameInput, SolvePass } from './region-step.ts';
// Displacement-spread consistency voting (docs/ARCHITECTURE.md §七) runs in the Rust core (rust/core/src/voting.rs):
// a ring of recent analysis-resolution frames bounded by bytes retained, each moving region's final pose compared
// against partners whose world displacement clears Dmin. Only the moving regions take part. The ring is freed in
// the finally of this pass.
const CONSISTENCY_RING_BYTES = 24 * 1024 * 1024;
/** All per-pass state solve() used to close over, now fields; the small methods below are exactly the sub-steps
 * solve()'s single ~320-line body used to inline. Mirrors scan.ts's ScanPass / render.ts's RenderPass shape. */
class SolveRun {
  graph!: PoseGraph;
  index!: KeyframeIndex;
  atlas!: RegionAtlas;
  f!: number;
  radius!: number;
  attachments!: Map<string, Attachment>;
  states!: RegionState[];
  previous: RGBA | ResidentFrame | undefined;
  previousGray: Gray | undefined;
  previousFeaturesAll: Feature[] | undefined;
  previousPlan: FramePlan | undefined;
  solved = 0;
  solveFrames!: FrameRing;
  residentLabels!: LabelMask['labels'];
  nativePlane!: ResidentGray;
  pending: { key: string; value: FramePlan }[] = [];
  endedNaturally = false;
  missingScan = false;
  votingSlot!: Map<string, number>;
  voting!: VotingRing;
  pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
  pass!: SolvePass;
  storageFailed = false;
  constructor(readonly ctx: RunContext) {}
  /** Pose graph, keyframe index, per-region states, the frame ring and native-luma plane, the voting ring, and
   * the SolvePass instance that carries them across the whole loop. */
  async setup(): Promise<void> {
    const ctx = this.ctx;
    ctx.phase = 'solving';
    ctx.project.status = 'solving';
    await ctx.persist();
    this.graph = new PoseGraph(ctx.store);
    this.index = new KeyframeIndex(
      ctx.store,
      async (message) => ctx.diagnostics.emit({ code: 'RELOCALIZATION_BUDGET', severity: 'warning', message }),
    );
    this.atlas = ctx.atlas!;
    this.f = ctx.factor;
    this.radius = ctx.refineRadius;
    this.attachments = new Map<string, Attachment>();
    this.states = ctx.regions.filter((r) => r.kind !== 'ignore').map((region) => initialState(region, this.atlas.code(region)));
    // Native frames (previous, current) enter core memory once per frame; native refinement, sticky-band detection
    // and the downscale all read them there. Released in this pass's finally (run()'s finally covers abnormal
    // exits through the same field).
    this.solveFrames = ctx.frames = core().frameRing(2, ctx.source.info.width, ctx.source.info.height);
    // The atlas label plane is already core-resident (built once by scan(), owned by `atlas`) — read it directly
    // instead of uploading another copy; freed once with the atlas itself, not here.
    this.residentLabels = this.atlas.resident;
    // Full-resolution luma of the current frame, recomputed in place on first use each frame.
    this.nativePlane = ctx.nativePlane = core().gray(ctx.source.info.width, ctx.source.info.height);
    const votingRegions = this.states.filter((s) => s.region.kind === 'moving').map((s) => s.region);
    this.votingSlot = new Map(votingRegions.map((r, i) => [r.id, i]));
    this.voting = ctx.voting = core().votingRing(votingRegions, {
      factor: this.f,
      noise: ctx.noise,
      nativeWidth: ctx.source.info.width,
      nativeHeight: ctx.source.info.height,
      analysisWidth: Math.max(1, Math.ceil(ctx.source.info.width / this.f)),
      analysisHeight: Math.max(1, Math.ceil(ctx.source.info.height / this.f)),
      budgetBytes: CONSISTENCY_RING_BYTES,
    });
    // A keyframe minted on a fragment before it was attached still carries the fragment's raw canvasId and raw x/y;
    // SolvePass's canonicalCanvas/canonicalPose translate that into the canvas and pose it is actually observed at
    // today, so revisit geometry and rival scoring compare like with like instead of raw-vs-canonical mismatches.
    this.pass = new SolvePass(
      ctx,
      this.graph,
      this.index,
      this.attachments,
      this.f,
      this.radius,
      this.residentLabels,
      this.voting,
      this.votingSlot,
    );
  }
  /** Queues finalised ring records for persistence and folds their layer statistics into the run's counters. */
  private queueVoting(records: VotingRecord[]): void {
    for (const record of records) {
      this.ctx.consistencyVotedLayers += record.votedLayers;
      this.ctx.consistencyThinLayers += record.thinLayers;
      if (record.record) {
        this.pendingConsistency.push({ key: `consistency/${pad(record.index)}`, value: record.record });
      }
    }
  }
  /** The duplicate-frame shortcut: replays the previous plan instead of re-solving pixels this frame never
   * changed. Returns true when the caller's loop should `continue` straight to the next decode without falling
   * through to the full per-frame body. */
  private async duplicateShortcut(frame: { index: number; time: number; image: RGBA }, scan: ScanRecord): Promise<boolean> {
    if (!(scan.duplicate && this.previousPlan && this.states.every((s) => !s.blind))) {
      return false;
    }
    // The duplicate-frame shortcut never looks at this frame's own decoded pixels (it just replays the previous
    // plan) — this is the only use `frame.image` would otherwise get, so it is done right now.
    releaseUnlessHeld(frame.image, this.previous as RGBA | undefined);
    const plan: FramePlan = {
      index: frame.index,
      time: frame.time,
      duplicate: true,
      placements: this.previousPlan.placements.map((p) => ({ ...p, time: frame.time })),
    };
    this.pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
    if (this.pending.length >= 24) await this.ctx.commitRows(this.pending);
    this.previousPlan = plan;
    for (const s of this.states) s.velocity = { x: 0, y: 0 };
    this.solved = frame.index + 1;
    await this.ctx.report(this.solved, frame.time, '完全相同的观察复用定位；保留源帧与时间记录。', this.solved / this.ctx.project.frames);
    return true;
  }
  /** One decoded frame's full per-region pass: prepares the shared FrameInput (current native upload, gray,
   * features, the lazily-filled native-luma memo), runs stepRegion() once per region in order, then joins the
   * voting ring and persists the frame's plan. */
  private async regionLoop(frame: { index: number; time: number; image: RGBA }, scan: ScanRecord): Promise<void> {
    const image = frame.image, oldPrevious = this.previous;
    // A frame whose geometry differs from the run's stays in JS; gray() rejects it with the historical message.
    const current = image.width === this.solveFrames.width && image.height === this.solveFrames.height
      ? this.solveFrames.upload(frame.index, image)
      : image;
    const g = scan.duplicate && this.previousGray ? this.previousGray : await this.ctx.gray(current);
    const storedFeatures = scan.duplicate ? undefined : await this.ctx.store.get<CompactFeatures>(`scan-features/${pad(frame.index)}`);
    const features = (storedFeatures && decodeFeatures(storedFeatures)) || (scan.duplicate ? this.previousFeaturesAll : undefined) ||
      core().extractFeatures(g, 480);
    // Full-resolution luma is only needed for keyframe patches, revisit search and anchor re-acquisition, which
    // most frames never reach; it is computed on first use, once per FRAME (shared by every region and both
    // tracking steps within it — not recomputed per region).
    let nativeGray: Gray | ResidentGray | undefined;
    const native = (): Gray | ResidentGray =>
      nativeGray ??= current instanceof ResidentFrame
        ? core().grayscaleInto(current, this.nativePlane)
        : core().grayscale(image.data, image.width, image.height);
    const placements: Placement[] = [];
    const votingState = { uploaded: false, observed: false };
    const input: FrameInput = {
      frame: { index: frame.index, time: frame.time },
      image,
      scan,
      current,
      previous: this.previous,
      g,
      previousGray: this.previousGray,
      features,
      native,
      // reacquire()/driftCorrection() fill `nativePlane` themselves, core-side, lazily — this shares the SAME
      // per-frame memo `native()` above uses (`nativeGray ??= ...`), not a separate one, so whichever call (a
      // fused Rust call or a later `native()` caller, e.g. keyframe-step.ts) fills the plane first, every other
      // consumer this frame sees it already filled.
      nativePlane: current instanceof ResidentFrame ? this.nativePlane : undefined,
      nativeFilled: () => nativeGray !== undefined,
      markNativeFilled: () => {
        nativeGray = this.nativePlane;
      },
      previousPlan: this.previousPlan,
      voting: votingState,
    };
    for (const state of this.states) {
      placements.push(await this.pass.stepRegion(state, input));
    }
    // This frame joins the ring (unless it had no moving-region evidence at all) only after every state's voting
    // comparisons above have already used it as a "current" frame against older partners; eviction below then
    // finalises whichever frame the new one's bytes just pushed out, oldest first.
    if (votingState.observed) {
      this.queueVoting(this.voting.pushFrame(frame.index));
      if (this.pendingConsistency.length >= 24) {
        await this.ctx.commitRows(this.pendingConsistency);
      }
    }
    this.previousPlan = { index: frame.index, time: frame.time, placements, duplicate: scan.duplicate };
    this.pending.push({ key: `plan/${pad(frame.index)}`, value: this.previousPlan });
    this.previousFeaturesAll = features;
    if (this.pending.length >= 24) {
      await this.ctx.commitRows(this.pending);
    }
    this.previous = current;
    this.previousGray = g;
    // `current` is `image` itself only on a geometry mismatch (the FrameRing branch above copies into core memory
    // and returns a ResidentFrame, which never aliases a JS RGBA, so this is a safe no-op then); either way,
    // whatever `previous` held before this frame is no longer referenced by anything once `previous` has moved
    // on. `releaseUnlessHeld` is a no-op on a plain `ResidentFrame` (no `release()`), so this call is correct
    // regardless of which branch `oldPrevious`/`current` took.
    releaseUnlessHeld(oldPrevious as RGBA | undefined, this.previous as RGBA | undefined);
    releaseUnlessHeld(image, this.previous as RGBA | undefined);
    this.solved = frame.index + 1;
    await this.ctx.report(this.solved, frame.time, '原像素精修、历史重定位与二维回环约束。', this.solved / this.ctx.project.frames);
  }
  /** The decode/solve loop: mirrors scan()'s and render()'s shape (see this file's header) — decode-step and
   * per-frame body are two separate try blocks so a decoder failure is never blamed on the solver and vice versa.
   * Kept as one method (just over the usual size) because its three nested try/catch/finally blocks share loop
   * control flow (`break`/`continue` on stop/EOF/failure) that a further split would have to thread back out. */
  async runLoop(): Promise<void> {
    const it = this.ctx.source.frames();
    try {
      while (true) {
        await this.ctx.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!this.solved) {
            throw error;
          }
          this.ctx.partial = true;
          await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'solve', this.solved, error));
          break;
        }
        if (step.done) {
          this.endedNaturally = true;
          break;
        }
        const frame = step.value;
        try {
          const scan = await this.ctx.store.get<ScanRecord>(`scan/${pad(frame.index)}`);
          if (!scan) {
            this.missingScan = true;
            this.ctx.partial = true;
            await this.ctx.diagnostics.emit({
              code: 'MISSING_SCAN_RECORD',
              severity: 'error',
              frame: frame.index,
              message: `求解阶段缺少 scan/${pad(frame.index)}；已停止在已提交的求解前缀。`,
              action: '检查本地存储完整性；缺失的扫描记录不会被当作零位移。',
              detail: { pass: 'solve', frame: frame.index },
            });
            break;
          }
          if (await this.duplicateShortcut(frame, scan)) {
            if (this.ctx.stopRequested) {
              this.ctx.honourStop();
              break;
            }
            if (this.solved >= this.ctx.project.frames) break;
            continue;
          }
          await this.regionLoop(frame, scan);
          if (this.ctx.stopRequested) {
            this.ctx.honourStop();
            break;
          }
          if (this.solved >= this.ctx.project.frames) {
            break;
          }
        } catch (error) {
          // `previous` was never reassigned on this (failing) iteration, so whatever it already held is still
          // exactly what it was — release() is idempotent, so this is safe even if the failure happened after
          // this frame's own release call already ran (the duplicate-shortcut branch, or a commitRows() throw
          // after `previous = current` below already executed).
          releaseUnlessHeld(frame.image, this.previous as RGBA | undefined);
          if (!this.solved) {
            throw error;
          }
          this.ctx.partial = true;
          if (error instanceof StorageError) {
            this.storageFailed = true;
            try {
              await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', this.solved, error));
            } catch { /* the journal write itself failed too; the run is already marked partial. */ }
            break;
          }
          await this.ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'solve', this.solved, error));
          break;
        }
      }
    } finally {
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
      this.solveFrames.free();
      // residentLabels (atlas.resident) is NOT freed here: this pass borrowed it, it did not upload it. It is
      // released exactly once, with the atlas, in run()'s finally.
      this.nativePlane.free();
      this.ctx.frames = this.ctx.nativePlane = undefined;
    }
  }
  /** Trailing commit of whatever plan rows never reached a 24-row batch, then the solve-vs-source frame-count
   * mismatch check. */
  async trailingCommitAndMismatch(): Promise<void> {
    if (this.pending.length && !this.storageFailed) {
      try {
        await this.ctx.commitRows(this.pending);
      } catch (error) {
        this.storageFailed = true;
        this.ctx.partial = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', this.solved, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if (this.endedNaturally || this.missingScan) {
      await this.ctx.passMismatch('solve', this.ctx.project.frames, this.solved);
    }
  }
  /** Every frame still resident in the ring when the loop ended (the tail of the run never got displaced by a
   * later frame's bytes) is finalised here exactly as an evicted one would have been, then the ring itself and
   * its `ctx.voting` handle are released. */
  async drainVotingAndFree(): Promise<void> {
    if (!this.storageFailed) {
      this.queueVoting(this.voting.drain());
      if (this.pendingConsistency.length) {
        try {
          await this.ctx.commitRows(this.pendingConsistency);
        } catch (error) {
          this.storageFailed = true;
          this.ctx.partial = true;
          try {
            await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', this.solved, error));
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        }
      }
    }
    this.voting.free();
    this.ctx.voting = undefined;
  }
  /** Relaxes the pose graph (honouring a mid-relaxation stop), warns on a large residual, then deletes the
   * scan-features/keyframe/word scratch this pass alone consumed. */
  async optimizeAndCleanup(): Promise<void> {
    const ctx = this.ctx;
    ctx.processed = this.solved;
    ctx.events.progress({ phase: 'optimizing', fraction: 0, frames: this.solved, time: 0, message: '优化磁盘中的位置图，校正回环漂移。' });
    // pose-graph.ts only persists relaxed positions once optimize() finishes its loop; a stop mid-relaxation
    // unwinds via StopRequested before that, so the unrelaxed (but already-persisted, pre-optimize) node
    // positions are what render() sees — geometrically consistent, just without this pass's loop-closure fix-up.
    let result: { residual: number; iterations: number };
    try {
      result = await this.graph.optimize(async () => {
        await ctx.checkpoint();
        if (ctx.stopRequested) throw new StopRequested();
      });
    } catch (error) {
      if (!(error instanceof StopRequested)) {
        throw error;
      }
      ctx.honourStop();
      result = { residual: 0, iterations: 0 };
    }
    if (result.residual > 1) {
      await ctx.diagnostics.emit({
        code: 'GRAPH_RESIDUAL',
        severity: 'warning',
        message: `位置图最大残差仍有 ${result.residual.toFixed(2)} 原像素；相关接缝可能存在几何不一致。`,
        detail: result,
        action: '检查回环附近的文字与重复纹理。该残差没有被隐藏。',
      });
    }
    await ctx.store.put('graph-summary', { loops: this.graph.loops, ...result });
    // scan-features/keyframe/word are scratch this pass alone consumed (relocalization postings and per-frame
    // features); render() never reads them, so they are deleted here rather than carried to export or reopen.
    await deletePrefix(ctx.store, 'scan-features/');
    await deletePrefix(ctx.store, 'keyframe/');
    await deletePrefix(ctx.store, 'word/');
    await ctx.diagnostics.flush();
    await ctx.persist();
  }
}
export async function solve(ctx: RunContext): Promise<void> {
  const run = new SolveRun(ctx);
  await run.setup();
  await run.runLoop();
  await run.trailingCommitAndMismatch();
  await run.drainVotingAndFree();
  await run.optimizeAndCleanup();
}
