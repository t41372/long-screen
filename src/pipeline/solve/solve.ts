// Shell around the solve pass: setup (pose graph, keyframe index, per-region states, frame ring, atlas label
// plane, native luma plane, voting ring), the frame loop (duplicate-frame shortcut, per-frame preparation, one
// stepRegion() call per region), plan/consistency batching, voting push/drain, trailing commits, pass-mismatch
// accounting, graph optimise, scratch deletion. The per-region tracking DECISIONS this loop used to compute inline
// (hypothesis scoring, audit acceptance, native refinement choice, the confidence formula, anchor re-acquisition,
// keyframe/revisit/attachment/loop-closure decisions) now live in track.ts as pure functions (ALGORITHM-AWAITING-
// PORT to Rust, see its header and docs/HANDOFF.md "已在 Rust 核心中"); region-step.ts's stepRegion() applies them
// in the original order. Everything in this file is orchestration shell, unambiguously not awaiting a port.
import type { Attachment, Feature, FramePlan, Gray, Placement, Point, RGBA, ScanRecord } from '../../types.ts';
import { deletePrefix } from '../../storage/db.ts';
import { extractFeatures, grayscale } from '../../core/features.ts';
import { PoseGraph } from '../../core/pose-graph.ts';
import { KeyframeIndex } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import { core, ResidentFrame, type ResidentGray, type VotingRecord } from '../../core/wasm.ts';
import { attachmentShift, resolveTarget as resolveAttachmentTarget } from '../attachments.ts';
import { type CompactFeatures, decodeFeatures } from '../features-codec.ts';
import type { ConsistencyRecord } from '../consistency.ts';
import { prefixOnly, type RunContext, StopRequested, StorageError } from '../context.ts';
import { initialState } from './state.ts';
import { type FrameInput, type SolvePass, stepRegion } from './region-step.ts';
export async function solve(ctx: RunContext): Promise<void> {
  ctx.phase = 'solving';
  ctx.project.status = 'solving';
  await ctx.persist();
  const graph = new PoseGraph(ctx.store),
    index = new KeyframeIndex(
      ctx.store,
      async (message) => ctx.diagnostics.emit({ code: 'RELOCALIZATION_BUDGET', severity: 'warning', message }),
    );
  const atlas = ctx.atlas!, f = ctx.factor, radius = ctx.refineRadius, attachments = new Map<string, Attachment>();
  const states = ctx.regions.filter((r) => r.kind !== 'ignore').map((region) => initialState(region, atlas.code(region)));
  let previous: RGBA | ResidentFrame | undefined,
    previousGray: Gray | undefined,
    previousFeaturesAll: Feature[] | undefined,
    previousPlan: FramePlan | undefined,
    solved = 0;
  // Native frames (previous, current) and the atlas label plane enter core memory once per frame / once per
  // pass; native refinement, sticky-band detection and the downscale all read them there. Released in this
  // pass's finally (run()'s finally covers abnormal exits through the same fields).
  const solveFrames = ctx.frames = core().frameRing(2, ctx.source.info.width, ctx.source.info.height);
  const residentLabels = ctx.residentLabels = core().upload(atlas.labels);
  // Full-resolution luma of the current frame, recomputed in place on first use each frame.
  const nativePlane = ctx.nativePlane = core().gray(ctx.source.info.width, ctx.source.info.height);
  const pending: { key: string; value: FramePlan }[] = [];
  let endedNaturally = false;
  let missingScan = false;
  // Displacement-spread consistency voting (docs/ARCHITECTURE.md §七) runs in the Rust core
  // (rust/core/src/voting.rs): a ring of recent analysis-resolution frames bounded by bytes retained, each
  // moving region's final pose compared against partners whose world displacement clears Dmin. Only the
  // moving regions take part; slot order is the order below. The ring is freed in the finally of this pass.
  const CONSISTENCY_RING_BYTES = 24 * 1024 * 1024;
  const votingRegions = states.filter((s) => s.region.kind === 'moving').map((s) => s.region);
  const votingSlot = new Map(votingRegions.map((r, i) => [r.id, i]));
  const voting = ctx.voting = core().votingRing(votingRegions, {
    factor: f,
    noise: ctx.noise,
    nativeWidth: ctx.source.info.width,
    nativeHeight: ctx.source.info.height,
    analysisWidth: Math.max(1, Math.ceil(ctx.source.info.width / f)),
    analysisHeight: Math.max(1, Math.ceil(ctx.source.info.height / f)),
    budgetBytes: CONSISTENCY_RING_BYTES,
  });
  const pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
  /** Queues finalised ring records for persistence and folds their layer statistics into the run's counters. */
  const queueVoting = (records: VotingRecord[]): void => {
    for (const record of records) {
      ctx.consistencyVotedLayers += record.votedLayers;
      ctx.consistencyThinLayers += record.thinLayers;
      if (record.record) {
        pendingConsistency.push({ key: `consistency/${pad(record.index)}`, value: record.record });
      }
    }
  };
  const resolveTarget = (id: string): string => resolveAttachmentTarget(attachments, id);
  // A keyframe minted on a fragment before it was attached still carries the fragment's raw canvasId and raw x/y;
  // canonicalCanvas/canonicalPose translate that into the canvas and pose it is actually observed at today, so
  // revisit geometry and rival scoring compare like with like instead of raw-vs-canonical mismatches.
  const canonicalCanvas = (id: string): string => resolveTarget(id);
  const canonicalPose = (k: Point & { canvasId: string }): Point => {
    const shift = attachmentShift(attachments, k.canvasId);
    return { x: k.x + shift.x, y: k.y + shift.y };
  };
  const canonical = (id: string) => {
    const shift = attachmentShift(attachments, id);
    return { canvasId: resolveTarget(id), dx: shift.x, dy: shift.y };
  };
  const pass: SolvePass = {
    ctx,
    graph,
    index,
    attachments,
    f,
    radius,
    residentLabels,
    voting,
    votingSlot,
    resolveTarget,
    canonicalCanvas,
    canonicalPose,
    canonical,
  };
  const it = ctx.source.frames();
  let storageFailed = false;
  try {
    while (true) {
      await ctx.checkpoint();
      // Same decode-step/body split as scan(): a decoder failure here is never blamed on the solver, and a
      // solver/storage failure here is never blamed on the decoder.
      let step: Awaited<ReturnType<typeof it.next>>;
      try {
        step = await it.next();
      } catch (error) {
        if (!solved) {
          throw error;
        }
        ctx.partial = true;
        await ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'solve', solved, error));
        break;
      }
      if (step.done) {
        endedNaturally = true;
        break;
      }
      const frame = step.value;
      try {
        const scan = await ctx.store.get<ScanRecord>(`scan/${pad(frame.index)}`);
        if (!scan) {
          missingScan = true;
          ctx.partial = true;
          await ctx.diagnostics.emit({
            code: 'MISSING_SCAN_RECORD',
            severity: 'error',
            frame: frame.index,
            message: `求解阶段缺少 scan/${pad(frame.index)}；已停止在已提交的求解前缀。`,
            action: '检查本地存储完整性；缺失的扫描记录不会被当作零位移。',
            detail: { pass: 'solve', frame: frame.index },
          });
          break;
        }
        if (scan.duplicate && previousPlan && states.every((s) => !s.blind)) {
          const plan: FramePlan = {
            index: frame.index,
            time: frame.time,
            duplicate: true,
            placements: previousPlan.placements.map((p) => ({ ...p, time: frame.time })),
          };
          pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
          if (pending.length >= 24) await ctx.commitRows(pending);
          previousPlan = plan;
          for (const s of states) s.velocity = { x: 0, y: 0 };
          solved = frame.index + 1;
          await ctx.report(solved, frame.time, '完全相同的观察复用定位；保留源帧与时间记录。', solved / ctx.project.frames);
          if (ctx.stopRequested) {
            ctx.honourStop();
            break;
          }
          if (solved >= ctx.project.frames) break;
          continue;
        }
        const image = frame.image;
        // A frame whose geometry differs from the run's stays in JS; gray() rejects it with the historical message.
        const current = image.width === solveFrames.width && image.height === solveFrames.height
          ? solveFrames.upload(frame.index, image)
          : image;
        const g = scan.duplicate && previousGray ? previousGray : await ctx.gray(current);
        const storedFeatures = scan.duplicate ? undefined : await ctx.store.get<CompactFeatures>(`scan-features/${pad(frame.index)}`);
        const features = (storedFeatures && decodeFeatures(storedFeatures)) || (scan.duplicate ? previousFeaturesAll : undefined) ||
          extractFeatures(g);
        // Full-resolution luma is only needed for keyframe patches, revisit search and anchor re-acquisition,
        // which most frames never reach; it is computed on first use, once per FRAME (shared by every region and
        // both tracking steps within it — not recomputed per region).
        let nativeGray: Gray | ResidentGray | undefined;
        const native = (): Gray | ResidentGray =>
          nativeGray ??= current instanceof ResidentFrame
            ? core().grayscaleInto(current, nativePlane)
            : grayscale(image.data, image.width, image.height);
        const placements: Placement[] = [];
        const votingState = { uploaded: false, observed: false };
        const input: FrameInput = {
          frame: { index: frame.index, time: frame.time },
          image,
          scan,
          current,
          previous,
          g,
          previousGray,
          features,
          native,
          previousPlan,
          voting: votingState,
        };
        for (const state of states) {
          placements.push(await stepRegion(pass, state, input));
        }
        // This frame joins the ring (unless it had no moving-region evidence at all) only after every state's
        // voting comparisons above have already used it as a "current" frame against older partners; eviction
        // below then finalises whichever frame the new one's bytes just pushed out, oldest first.
        if (votingState.observed) {
          queueVoting(voting.pushFrame(frame.index));
          if (pendingConsistency.length >= 24) {
            await ctx.commitRows(pendingConsistency);
          }
        }
        previousPlan = { index: frame.index, time: frame.time, placements, duplicate: scan.duplicate };
        pending.push({ key: `plan/${pad(frame.index)}`, value: previousPlan });
        previousFeaturesAll = features;
        if (pending.length >= 24) {
          await ctx.commitRows(pending);
        }
        previous = current;
        previousGray = g;
        solved = frame.index + 1;
        await ctx.report(solved, frame.time, '原像素精修、历史重定位与二维回环约束。', solved / ctx.project.frames);
        if (ctx.stopRequested) {
          ctx.honourStop();
          break;
        }
        if (solved >= ctx.project.frames) {
          break;
        }
      } catch (error) {
        if (!solved) {
          throw error;
        }
        ctx.partial = true;
        if (error instanceof StorageError) {
          storageFailed = true;
          try {
            await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', solved, error));
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
          break;
        }
        await ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'solve', solved, error));
        break;
      }
    }
  } finally {
    try {
      await it.return(undefined);
    } catch { /* already unwinding */ }
    solveFrames.free();
    residentLabels.free();
    nativePlane.free();
    ctx.frames = ctx.residentLabels = ctx.nativePlane = undefined;
  }
  if (pending.length && !storageFailed) {
    try {
      await ctx.commitRows(pending);
    } catch (error) {
      storageFailed = true;
      ctx.partial = true;
      try {
        await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', solved, error));
      } catch { /* the journal write itself failed too; the run is already marked partial. */ }
    }
  }
  if (endedNaturally || missingScan) {
    await ctx.passMismatch('solve', ctx.project.frames, solved);
  }
  // Every frame still resident in the ring when solve() ends (the tail of the run never got displaced by a
  // later frame's bytes) is finalised here exactly as an evicted one would have been.
  if (!storageFailed) {
    queueVoting(voting.drain());
    if (pendingConsistency.length) {
      try {
        await ctx.commitRows(pendingConsistency);
      } catch (error) {
        storageFailed = true;
        ctx.partial = true;
        try {
          await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', solved, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
  }
  voting.free();
  ctx.voting = undefined;
  ctx.processed = solved;
  ctx.events.progress({ phase: 'optimizing', fraction: 0, frames: solved, time: 0, message: '优化磁盘中的位置图，校正回环漂移。' });
  // pose-graph.ts only persists relaxed positions once optimize() finishes its loop; a stop mid-relaxation
  // unwinds via StopRequested before that, so the unrelaxed (but already-persisted, pre-optimize) node
  // positions are what render() sees — geometrically consistent, just without this pass's loop-closure fix-up.
  let result: { residual: number; iterations: number };
  try {
    result = await graph.optimize(async () => {
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
  await ctx.store.put('graph-summary', { loops: graph.loops, ...result });
  // scan-features/keyframe/word are scratch this pass alone consumed (relocalization postings and per-frame
  // features); render() never reads them, so they are deleted here rather than carried to export or reopen.
  await deletePrefix(ctx.store, 'scan-features/');
  await deletePrefix(ctx.store, 'keyframe/');
  await deletePrefix(ctx.store, 'word/');
  await ctx.diagnostics.flush();
  await ctx.persist();
}
