// Host of the solve pass. The pass itself — per-region tracking, keyframes and revisits, fragment attachment, the
// pose graph's nodes and edges, consistency voting and each frame's placements — is the engine's solve session
// (rust/long-screen/src/engine/solve/). This file drives it frame by frame: the decode loop, the scan record and stored features
// each frame needs, the keyframe rows a revisit search asks for, storing the rows the session hands back (plan and
// consistency rows in batches of 24), the diagnostics' text, progress, pause and stop, the prefix-only failure
// classification, the frame-count check, relaxing the pose graph and deleting the pass's scratch rows.
import type { CompactFeatures, FramePlan, RGBA, ScanRecord } from '../../types.ts';
import { deletePrefix } from '../../storage/db.ts';
import { PoseGraph } from '../../core/pose-graph.ts';
import type { Keyframe } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import { core, type SolveEffect, type SolvePoll, type SolveSessionState, type VotingRecord } from '../../core/wasm.ts';
import { releaseUnlessHeld } from '../../media/pool.ts';
import type { ConsistencyRecord } from '../consistency.ts';
import { t } from '../../i18n/index.ts';
import { prefixOnly, type RunContext, StopRequested, StorageError } from '../context.ts';
import { solveDiagnostic } from './diagnostics.ts';

class SolveRun {
  session!: SolveSessionState;
  solved = 0;
  pending: { key: string; value: FramePlan }[] = [];
  pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
  endedNaturally = false;
  missingScan = false;
  storageFailed = false;
  graph: PoseGraph | undefined;
  constructor(readonly ctx: RunContext) {}
  async setup(): Promise<void> {
    const ctx = this.ctx;
    ctx.phase = 'solving';
    ctx.project.status = 'solving';
    await ctx.persist();
    const atlas = ctx.atlas!;
    this.session = core().solveSession({
      width: ctx.source.info.width,
      height: ctx.source.info.height,
      factor: ctx.factor,
      radius: ctx.refineRadius,
      noise: ctx.noise,
      regions: ctx.regions.filter((r) => r.kind !== 'ignore').map((region) => ({ region, code: atlas.code(region) })),
    });
  }
  /** Stores what the session did, in order. */
  private async apply(effects: SolveEffect[]): Promise<void> {
    const ctx = this.ctx;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'canvas':
          await ctx.store.put(`canvas/${effect.meta.id}`, effect.meta);
          if (effect.created) ctx.project.canvasCount++;
          break;
        case 'canvasDropped':
          await ctx.store.delete(`canvas/${effect.id}`);
          ctx.project.canvasCount = Math.max(0, ctx.project.canvasCount - 1);
          break;
        case 'attach':
          await ctx.store.put(`attach/${effect.attachment.id}`, effect.attachment);
          break;
        case 'keyframe':
          await ctx.store.put(`keyframe/${effect.keyframe.id}`, effect.keyframe);
          break;
        case 'graph':
          if (effect.write.many) await ctx.store.putMany(effect.write.rows);
          else await ctx.store.put(effect.write.rows[0].key, effect.write.rows[0].value);
          break;
        case 'diagnostic':
          await ctx.diagnostics.emit(solveDiagnostic(effect.diagnostic));
          break;
      }
    }
  }
  /** Runs one session call, then stores its effects — also when the call failed, since they happened first. */
  private async step(call: () => SolvePoll): Promise<SolvePoll> {
    try {
      return call();
    } finally {
      await this.apply(this.session.effects());
    }
  }
  private queueVoting(records: VotingRecord[]): void {
    for (const record of records) {
      this.ctx.consistencyVotedLayers += record.votedLayers;
      this.ctx.consistencyThinLayers += record.thinLayers;
      if (record.record) {
        this.pendingConsistency.push({ key: `consistency/${pad(record.index)}`, value: record.record });
      }
    }
  }
  /** One decoded frame: the duplicate shortcut, or the frame's pixels, gray and features into the session, the
   * keyframe rows it asks for, and its plan and voting rows. */
  private async frame(frame: { index: number; time: number; image: RGBA }, scan: ScanRecord): Promise<void> {
    const ctx = this.ctx, session = this.session;
    const begin = session.begin(frame.index, frame.time, scan);
    if ('duplicate' in begin) {
      releaseUnlessHeld(frame.image);
      const plan: FramePlan = { index: frame.index, time: frame.time, duplicate: true, placements: begin.duplicate };
      this.pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
      if (this.pending.length >= 24) await ctx.commitRows(this.pending);
      this.solved = frame.index + 1;
      await ctx.report(this.solved, frame.time, t('progress.duplicateReuse'), this.solved / ctx.project.frames);
      return;
    }
    const image = frame.image;
    if (image.width !== session.width || image.height !== session.height) {
      throw new Error(
        `FRAME_GEOMETRY_CHANGED: observation is ${image.width}×${image.height}; the run is ${ctx.source.info.width}×${ctx.source.info.height}.`,
      );
    }
    const current = session.frame();
    current.write(image.data);
    releaseUnlessHeld(image);
    const gray = begin.gray ? await ctx.gray(current) : undefined;
    const stored = scan.duplicate ? undefined : await ctx.store.get<CompactFeatures>(`scan-features/${pad(frame.index)}`);
    const labels = ctx.atlas!.residentAt(frame.index);
    let poll = await this.step(() => session.run(gray, stored, labels));
    while ('keyframes' in poll) {
      const rows: (Keyframe | undefined)[] = [];
      for (const id of poll.keyframes) rows.push(await ctx.store.get<Keyframe>(`keyframe/${id}`));
      poll = await this.step(() => session.provide(rows, labels));
    }
    if (poll.joinedRing) {
      this.queueVoting(poll.voting);
      if (this.pendingConsistency.length >= 24) await ctx.commitRows(this.pendingConsistency);
    }
    const plan: FramePlan = { index: frame.index, time: frame.time, placements: poll.placements, duplicate: scan.duplicate };
    this.pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
    if (this.pending.length >= 24) await ctx.commitRows(this.pending);
    this.solved = frame.index + 1;
    await ctx.report(this.solved, frame.time, t('progress.solveFrame'), this.solved / ctx.project.frames);
  }
  /** The decode/solve loop: decode-step and per-frame body are two separate try blocks so a decoder failure is
   * never blamed on the solver and vice versa. */
  async runLoop(): Promise<void> {
    const it = this.ctx.source.frames();
    try {
      while (true) {
        await this.ctx.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!this.solved) throw error;
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
              message: t('diag.MISSING_SCAN_RECORD.message', { index: pad(frame.index) }),
              action: t('diag.MISSING_SCAN_RECORD.action'),
              detail: { pass: 'solve', frame: frame.index },
            });
            break;
          }
          await this.frame(frame, scan);
          if (this.ctx.stopRequested) {
            this.ctx.honourStop();
            break;
          }
          if (this.solved >= this.ctx.project.frames) break;
        } catch (error) {
          releaseUnlessHeld(frame.image);
          if (!this.solved) throw error;
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
    }
  }
  /** Trailing commit of whatever plan rows never reached a 24-row batch, then the frame-count check. */
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
  /** Finalises every frame still in the voting ring, stores its rows, and hands the pose graph over. */
  async drainVoting(): Promise<void> {
    if (!this.storageFailed) {
      this.queueVoting(this.session.drain());
      // Draining also reports what the pass found once it had seen every frame (nested containers).
      await this.apply(this.session.effects());
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
    this.graph = PoseGraph.adopt(this.ctx.store, this.session.takeGraph());
    this.session.free();
  }
  /** Releases the session and the pose graph; the pass is over, however it ended. */
  free(): void {
    this.session?.free();
    this.graph?.free();
  }
  /** Relaxes the pose graph (honouring a mid-relaxation stop), warns on a large residual, then deletes the
   * scan-features/keyframe scratch this pass alone consumed. */
  async optimizeAndCleanup(): Promise<void> {
    const ctx = this.ctx, graph = this.graph!;
    ctx.processed = this.solved;
    ctx.events.progress({ phase: 'optimizing', fraction: 0, frames: this.solved, time: 0, message: t('progress.optimizing') });
    // The relaxed positions are only stored once the relaxation finishes; a stop mid-relaxation leaves the
    // already-stored, unrelaxed node positions for render() — consistent, just without the loop-closure fix-up.
    let result: { residual: number; iterations: number };
    try {
      result = await graph.optimize(async () => {
        await ctx.checkpoint();
        if (ctx.stopRequested) throw new StopRequested();
      });
    } catch (error) {
      if (!(error instanceof StopRequested)) throw error;
      ctx.honourStop();
      result = { residual: 0, iterations: 0 };
    }
    if (result.residual > 1) {
      await ctx.diagnostics.emit({
        code: 'GRAPH_RESIDUAL',
        severity: 'warning',
        message: t('diag.GRAPH_RESIDUAL.message', { residual: result.residual.toFixed(2) }),
        detail: result,
        action: t('diag.GRAPH_RESIDUAL.action'),
      });
    }
    await ctx.store.put('graph-summary', { loops: graph.loops, ...result });
    // scan-features/ and keyframe/ are scratch this pass alone consumed; render() never reads them.
    await deletePrefix(ctx.store, 'scan-features/');
    await deletePrefix(ctx.store, 'keyframe/');
    await ctx.diagnostics.flush();
    await ctx.persist();
  }
}
export async function solve(ctx: RunContext): Promise<void> {
  const run = new SolveRun(ctx);
  try {
    await run.setup();
    await run.runLoop();
    await run.trailingCommitAndMismatch();
    await run.drainVoting();
    await run.optimizeAndCleanup();
  } finally {
    run.free();
  }
}
