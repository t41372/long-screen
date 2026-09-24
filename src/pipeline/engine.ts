// Engine is the public facade over a reconstruction run: run() orchestration (stage sequencing, timings,
// performance row, final status, top-level error handling, resource release) plus the getters/delegates other
// modules and tests import by name. Everything else lives in sibling modules, all sharing one RunContext
// (context.ts) for the run's lifetime:
//   context.ts       RunContext: state and services every pass shares, plus checkpoint/report/persist/
//                     putMany/commitRows/passMismatch and StorageError/StopRequested. Shell, not algorithm.
//   scan.ts          the scan pass (motion evidence, layer learning, region finalisation). Shell.
//   solve/solve.ts   the solve pass shell (setup, frame loop, duplicate-frame shortcut, plan/consistency
//                     batching, voting ring lifecycle, graph optimise, scratch deletion). Shell.
//   solve/state.ts   RegionState, Decision, initialState(), newCanvas() — the per-region tracking state
//                     solve.ts and region-step.ts share. Shell.
//   solve/track.ts   the per-region tracking DECISIONS (hypothesis scoring, audit acceptance, native
//                     refinement, confidence, anchor re-acquisition, keyframe/revisit/attachment/loop-closure
//                     verdicts) as pure functions — plain inputs, plain results, no storage or diagnostics.
//                     Still plain TypeScript, algorithm-awaiting-port (see docs/HANDOFF.md "已在 Rust 核心中").
//   solve/region-step.ts, solve/keyframe-step.ts  the per-region shell that applies track.ts's decisions, in
//                     the original order, to storage/diagnostics/the pose graph/keyframe index. Shell.
//   render.ts        the render pass (placement resolution, consistency-mask consultation, compositing,
//                     observation ledger). Shell.
//   presentation.ts  run()'s framing and pyramid stages. Shell.
//   consistency.ts   the exported pure consistencyMask() and its ConsistencyBox/Vote/Record types. Shell
//                     around a Rust-core call (rust/core/src/consistency.rs).
//   attachments.ts   the fragment-attachment chain walk (resolveTarget/attachmentShift/attachedRenderShift),
//                     shared by solve() and render(). Shell.
//   features-codec.ts CompactFeatures encode/decode (scan writes, solve reads). Shell.
// Public surface kept importable from this file: `Engine` (constructor signature, run(), setPaused(), stop(),
// `stopRequested` (tests set it), `project`, `store`, `tiles`, `diagnostics`, `factor`, `refineRadius`, `noise`)
// and `EngineEvents`.
import type { Diagnostic, FrameSource, Progress, Project, Settings } from '../types.ts';
import type { KV } from '../storage/db.ts';
import type { Diagnostics } from '../storage/diagnostics.ts';
import type { TileStore } from '../storage/tiles.ts';
import { RunContext, StorageError } from './context.ts';
import { presentFraming, presentPyramid } from './presentation.ts';
import { scan } from './scan.ts';
import { render } from './render.ts';
import { solve } from './solve/solve.ts';
export interface EngineEvents {
  progress: (p: Progress) => void;
  diagnostic: (d: Diagnostic) => void;
  project: (p: Project) => void;
}
export class Engine {
  private readonly ctx: RunContext;
  constructor(db: KV, source: FrameSource, settings: Settings, events: EngineEvents) {
    this.ctx = new RunContext(db, source, settings, events);
  }
  get project(): Project {
    return this.ctx.project;
  }
  get store(): KV {
    return this.ctx.store;
  }
  get diagnostics(): Diagnostics {
    return this.ctx.diagnostics;
  }
  get tiles(): TileStore {
    return this.ctx.tiles;
  }
  get factor(): number {
    return this.ctx.factor;
  }
  get refineRadius(): number {
    return this.ctx.refineRadius;
  }
  get noise(): number {
    return this.ctx.noise;
  }
  get paused(): boolean {
    return this.ctx.paused;
  }
  get stopRequested(): boolean {
    return this.ctx.stopRequested;
  }
  set stopRequested(value: boolean) {
    this.ctx.stopRequested = value;
  }
  /** Reached only through casts (`engine as any).events`) by tests that poke the live progress handler; not part
   * of the documented public surface (see this file's header comment). */
  private get events(): EngineEvents {
    return this.ctx.events;
  }
  /** Requests that the run stop at the next checkpoint and, if paused, wakes it so the request is actually seen
   * (a paused run never reaches a checkpoint on its own). Mirrors what src/worker.ts's 'stop' handler does today. */
  stop(): void {
    this.ctx.stop();
  }
  setPaused(paused: boolean): void {
    this.ctx.setPaused(paused);
  }
  async run(): Promise<Project> {
    const ctx = this.ctx;
    try {
      // Inside the try: a failing initial write must still reach the finally below and release the
      // decoder/GPU device, instead of leaking them by throwing before the try is entered.
      await ctx.persist();
      // The comparison tolerance is a property of the source, not of the algorithm, so the project says which
      // one it ran with: a run that compared exactly and a run that allowed H.264 headroom are not the same
      // evidence, and nothing downstream can tell them apart from the pixels alone.
      await ctx.diagnostics.emit({
        code: 'MODEL_ASSUMPTIONS',
        severity: 'info',
        message:
          `重建采用分层平移画布与几何回环约束。自动遮罩和动态区域属于启发式推断；置信分数不是经过校准的正确概率。世界一致性比较按本片源声明的解码噪声 ±${ctx.noise} 级执行${
            ctx.noise ? '（压缩视频的振铃/色度重建余量）' : '（无损片源，逐像素精确比较）'
          }。`,
        action: '比例或结构无法共存时会保留独立片段，不把不相容的状态强行拼接。',
        detail: { noise: ctx.noise, lossless: ctx.noise === 0, source: ctx.source.info.mode, codec: ctx.source.info.codec },
      });
      if (ctx.project.settings.decoder === 'compatibility') {
        await ctx.diagnostics.emit({
          code: 'APPROXIMATE_DECODER',
          severity: 'warning',
          message:
            `已明确启用 ${ctx.project.settings.compatibilityFPS} Hz 原生 seek 兼容模式。不能保证采到视频的每一帧，短暂内容可能缺失。`,
          action: '需要逐帧覆盖保证时，使用 WebCodecs 支持的 H.264、VP9 等输入。',
        });
      }
      if (ctx.source.info.width > ctx.project.settings.analysisSize || ctx.source.info.height > ctx.project.settings.analysisSize) {
        await ctx.diagnostics.emit({
          code: 'ANALYSIS_PYRAMID',
          severity: 'info',
          message: `运动分析的长边上限为 ${ctx.project.settings.analysisSize}px；原分辨率像素用于精修和最终合成，输出没有跟随降采样。`,
        });
      }
      for (const warning of ctx.source.info.warnings) {
        await ctx.diagnostics.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: warning });
      }
      if (ctx.source.info.width * ctx.source.info.height * 4 * 4 > ctx.project.settings.memoryMB * 1024 * 1024 * .8) {
        await ctx.diagnostics.emit({
          code: 'FRAME_MEMORY_PRESSURE',
          severity: 'warning',
          message: '单帧原始像素及参考帧占用已接近所选缓存预算。解码器/GPU 自身内存不受 JavaScript 缓存预算控制。',
          action: '不会静默降低输出分辨率；内存不足时保留已提交数据并报告失败。',
        });
      }
      let phaseStart = performance.now();
      await scan(ctx);
      ctx.timings.scanMS = performance.now() - phaseStart;
      if (!ctx.project.frames) {
        throw new Error('No observations could be decoded. Nothing has been marked as reconstructed.');
      }
      phaseStart = performance.now();
      await solve(ctx);
      ctx.timings.solveMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      await render(ctx);
      ctx.timings.renderMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      await presentFraming(ctx);
      ctx.timings.framingMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      ctx.phase = 'pyramid';
      ctx.project.status = 'pyramid';
      await ctx.persist();
      await presentPyramid(ctx);
      if (ctx.stopRequested) {
        ctx.partial = true;
        ctx.stopRequested = false;
      }
      ctx.timings.pyramidMS = performance.now() - phaseStart;
      await ctx.store.put('performance', {
        ...ctx.timings,
        exactDuplicateFrames: ctx.duplicates,
        skippedPaints: ctx.skippedPaints,
        tileEncodes: ctx.tiles.encodedTiles,
        tileDecodes: ctx.tiles.decodedTiles,
        tileEvictions: ctx.tiles.evictions,
        compute: ctx.computer.stats,
        consistencyVotedLayers: ctx.consistencyVotedLayers,
        consistencyThinLayers: ctx.consistencyThinLayers,
        note: 'Stage timings include decoding, storage and yields; not GPU-only kernel time.',
      });
      ctx.project.status = ctx.partial ? 'partial' : 'complete';
      await ctx.diagnostics.flush();
      await ctx.persist();
      ctx.events.progress({
        phase: ctx.project.status,
        fraction: 1,
        frames: ctx.project.renderedFrames,
        time: ctx.source.info.duration,
        message: ctx.partial ? '已保存明确标记的部分重建。' : '重建已完成；请检查诊断与未观察区域。',
      });
    } catch (error) {
      ctx.project.status = ctx.project.renderedFrames ? 'partial' : 'error';
      ctx.project.error = error instanceof Error ? error.message : String(error);
      // Do not destroy committed work when a later operation, codec, or quota fails.
      try {
        // Journaled (not a bare event) so it survives into export and a reopened project, not just the live UI.
        // A StorageError reaching here is a persistence failure, not an algorithmic one — attribute it as
        // PERSISTENCE_ERROR (mirroring the in-loop PERSISTENCE_PREFIX_ONLY handling) instead of the generic
        // PROCESSING_ERROR, which otherwise misattributes a quota/transaction failure to processing.
        const code = error instanceof StorageError ? 'PERSISTENCE_ERROR' : 'PROCESSING_ERROR';
        await ctx.diagnostics.emit({
          code,
          severity: 'error',
          message: ctx.project.error,
          action: '已经提交到本地存储的瓦片仍可查看和导出；没有把失败标记成成功。',
        });
        await ctx.tiles.flush();
        await ctx.diagnostics.flush();
        await ctx.persist();
      } catch (storageError) {
        // Storage is already failing here, so this one stays event-only rather than risking a third failed write.
        ctx.events.diagnostic({
          code: 'PERSISTENCE_ERROR',
          severity: 'error',
          message: String(storageError),
          action: '存储写入也失败；仅先前成功提交的数据可恢复。',
        });
      }
    } finally {
      ctx.voting?.free();
      ctx.voting = undefined;
      ctx.learner?.dispose();
      ctx.learner = undefined;
      // The atlas's label plane is read (never re-uploaded) by solve()/render()/Compositor, so it is released
      // here exactly once, not per-pass — freeing it earlier would be a use-after-free the moment any later
      // pass touched `atlas.resident`.
      ctx.atlas?.dispose();
      ctx.atlas = undefined;
      ctx.releaseResidentRenderState();
      ctx.computer.dispose();
      ctx.source.dispose();
      // The `stopped` latch (unlike `stopRequested`) is deliberately left set across the whole run, from
      // wherever a stop was first honoured through to the framing/pyramid gates above; only run() itself
      // ever reads it, so it is only ever cleared here, once, at the very end of run().
      ctx.stopped = false;
    }
    return ctx.project;
  }
}
