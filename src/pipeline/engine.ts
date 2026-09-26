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
//                     Still plain TypeScript, algorithm-awaiting-port (see docs/history/2026-09-rust-migration-log.md "已在 Rust 核心中").
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
import { t } from '../i18n/index.ts';
import { RunContext, StorageError } from './context.ts';
import { presentFraming, presentPyramid } from './presentation.ts';
import { scan } from './scan.ts';
import { render } from './render.ts';
import { resolveSources } from './sources.ts';
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
  /** Orchestrates one run: startup diagnostics, the five stages in order (fingerprint tests depend on this
   *  order), top-level error handling, and resource release — always in that shape, whichever stage a run
   *  stops or fails at. Each piece is a method below so this stays a sequence, not a single long function. */
  async run(): Promise<Project> {
    const ctx = this.ctx;
    try {
      // Inside the try: a failing initial write must still reach the finally below and release the
      // decoder/GPU device, instead of leaking them by throwing before the try is entered.
      await ctx.persist();
      await this.emitStartupDiagnostics();
      await this.runStages();
    } catch (error) {
      await this.handleFailure(error);
    } finally {
      this.releaseRunState();
    }
    return ctx.project;
  }
  /** Diagnostics that describe the run's assumptions and inputs, emitted once before the first stage: the
   *  reconstruction model, the decoder mode, the analysis pyramid (if downsampled), source warnings, and a
   *  memory-pressure estimate. */
  private async emitStartupDiagnostics(): Promise<void> {
    const ctx = this.ctx;
    // The comparison tolerance is a property of the source, not of the algorithm, so the project says which
    // one it ran with: a run that compared exactly and a run that allowed H.264 headroom are not the same
    // evidence, and nothing downstream can tell them apart from the pixels alone.
    await ctx.diagnostics.emit({
      code: 'MODEL_ASSUMPTIONS',
      severity: 'info',
      message: t('diag.MODEL_ASSUMPTIONS.message', {
        noise: ctx.noise,
        margin: ctx.noise ? t('diag.MODEL_ASSUMPTIONS.marginLossy') : t('diag.MODEL_ASSUMPTIONS.marginLossless'),
      }),
      action: t('diag.MODEL_ASSUMPTIONS.action'),
      detail: { noise: ctx.noise, lossless: ctx.noise === 0, source: ctx.source.info.mode, codec: ctx.source.info.codec },
    });
    if (ctx.project.settings.decoder === 'compatibility') {
      await ctx.diagnostics.emit({
        code: 'APPROXIMATE_DECODER',
        severity: 'warning',
        message: t('diag.APPROXIMATE_DECODER.message', { fps: ctx.project.settings.compatibilityFPS }),
        action: t('diag.APPROXIMATE_DECODER.action'),
      });
    }
    if (ctx.source.info.width > ctx.project.settings.analysisSize || ctx.source.info.height > ctx.project.settings.analysisSize) {
      await ctx.diagnostics.emit({
        code: 'ANALYSIS_PYRAMID',
        severity: 'info',
        message: t('diag.ANALYSIS_PYRAMID.message', { size: ctx.project.settings.analysisSize }),
      });
    }
    for (const warning of ctx.source.info.warnings) {
      await ctx.diagnostics.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: warning });
    }
    if (ctx.source.info.width * ctx.source.info.height * 4 * 4 > ctx.project.settings.memoryMB * 1024 * 1024 * .8) {
      await ctx.diagnostics.emit({
        code: 'FRAME_MEMORY_PRESSURE',
        severity: 'warning',
        message: t('diag.FRAME_MEMORY_PRESSURE.message'),
        action: t('diag.FRAME_MEMORY_PRESSURE.action'),
      });
    }
  }
  /** The five stages, in the order the fingerprint oracle depends on: scan, solve, render, framing, pyramid.
   *  Records each stage's wall-clock time and, on success, the final performance row, status and progress
   *  event. Throws straight through to run()'s catch on any stage's failure. */
  private async runStages(): Promise<void> {
    const ctx = this.ctx;
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
    await resolveSources(ctx);
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
      message: ctx.partial ? t('progress.runPartial') : t('progress.runComplete'),
    });
  }
  /** run()'s top-level catch: marks the project partial or errored (never silently discards committed tiles),
   *  journals the failure so it survives into export and a reopened project, and flushes what is already
   *  committed. If that flush itself fails, falls back to an event-only diagnostic rather than risking a
   *  third failed write. */
  private async handleFailure(error: unknown): Promise<void> {
    const ctx = this.ctx;
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
        action: t('diag.RUN_FAILURE.action'),
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
        action: t('diag.PERSISTENCE_ERROR.action'),
      });
    }
  }
  /** run()'s finally: releases every core-resident/decoder/GPU resource the run may have acquired, whichever
   *  stage it stopped or failed at, exactly once. */
  private releaseRunState(): void {
    const ctx = this.ctx;
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
}
