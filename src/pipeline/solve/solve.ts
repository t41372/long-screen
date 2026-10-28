// Host of the solve pass. The pass itself — per-region tracking, keyframes and revisits, fragment attachment, the
// pose graph's nodes and edges, consistency voting and each frame's placements — is the engine's solve session
// (rust/long-screen/src/engine/solve/). This file drives it frame by frame: the decode loop, the scan record and stored features
// each frame needs, the keyframe rows a revisit search asks for, storing the rows the session hands back (plan and
// consistency rows in batches of 24), the diagnostics' text, progress, pause and stop, the prefix-only failure
// classification, the frame-count check, relaxing the pose graph and deleting the pass's scratch rows.
import type { CompactFeatures, Diagnostic, FramePlan, Rect, Region, RGBA, ScanRecord } from '../../types.ts';
import { deletePrefix, type KV, type Row } from '../../storage/db.ts';
import { PoseGraph } from '../../core/pose-graph.ts';
import type { Keyframe } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import { zh } from '../../i18n/zh/index.ts';
import {
  core,
  type SolveEffect,
  type SolvePoll,
  type SolveRegionInput,
  type SolveSessionState,
  type VotingRecord,
} from '../../core/wasm.ts';
import { releaseUnlessHeld } from '../../media/pool.ts';
import type { ConsistencyRecord } from '../consistency.ts';
import { t } from '../../i18n/index.ts';
import { prefixOnly, type RunContext, StopRequested, StorageError } from '../context.ts';
import { solveDiagnostic } from './diagnostics.ts';

/** A nested run's writes, held back until its containers are confirmed (`Effect::NestedRejected`): reads fall
 *  through to the run's store. Only the writes a solve run makes are supported. */
class HeldStore implements KV {
  readonly rows = new Map<string, unknown>();
  constructor(readonly base: KV) {}
  get<T>(key: string): Promise<T | undefined> {
    return this.rows.has(key) ? Promise.resolve(this.rows.get(key) as T) : this.base.get<T>(key);
  }
  put(key: string, value: unknown): Promise<void> {
    this.rows.set(key, value);
    return Promise.resolve();
  }
  putMany(rows: Row[]): Promise<void> {
    for (const { key, value } of rows) this.rows.set(key, value);
    return Promise.resolve();
  }
  delete(): Promise<void> {
    throw new Error('A held solve run does not delete rows.');
  }
  deleteMany(): Promise<void> {
    throw new Error('A held solve run does not delete rows.');
  }
  scan<T>(): Promise<Row<T>[]> {
    throw new Error('A held solve run does not scan rows.');
  }
}

/** What a nested run held back: its rows, its diagnostics and the canvases it created, in order. */
interface Held {
  store: HeldStore;
  diagnostics: Diagnostic[];
  canvases: number;
}

class SolveRun {
  session!: SolveSessionState;
  solved = 0;
  pending: { key: string; value: FramePlan }[] = [];
  pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
  endedNaturally = false;
  missingScan = false;
  storageFailed = false;
  graph: PoseGraph | undefined;
  /** Containers the pass found scrolling inside its regions (`track::nested`). */
  found: { region: string; canvas: string; footprint: Rect; open: number }[] = [];
  /** On a nested run: per container, the frames its parent's print shows it in (`Moments::choose`). */
  moments: { region: string; frames: { frame: number; clip: Rect }[] }[] = [];
  /** On a nested run: the containers their own run did not confirm. */
  rejected: string[] = [];
  /** On the first run: the containers it would report so far (refreshed every 30 frames), for its progress. */
  candidates = 0;
  /** On a nested run: the frames it solves (`nestedUntil`). */
  until: number | undefined;
  /** `nested`: the containers this run solves, when it is the second run over the frames (`solveNested`); `held`:
   *  where it keeps its rows and diagnostics until they are confirmed, when they are held back. */
  constructor(readonly ctx: RunContext, readonly nested?: SolveRegionInput[], readonly held?: Held) {}
  /** Where the run's rows go (the keyframe scratch always goes to the run's store). */
  get store(): KV {
    return this.held?.store ?? this.ctx.store;
  }
  private async emit(d: Diagnostic): Promise<void> {
    if (this.held) this.held.diagnostics.push(d);
    else await this.ctx.diagnostics.emit(d);
  }
  private async commit(rows: Row[]): Promise<void> {
    if (!this.held) return this.ctx.commitRows(rows);
    await this.held.store.putMany(rows);
    rows.splice(0);
  }
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
      regions: this.nested ?? ctx.regions.filter((r) => r.kind !== 'ignore').map((region) => ({ region, code: atlas.code(region) })),
    });
  }
  /** Stores what the session did, in order. */
  private async apply(effects: SolveEffect[]): Promise<void> {
    const ctx = this.ctx;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'canvas':
          await this.store.put(`canvas/${effect.meta.id}`, effect.meta);
          if (effect.created && this.held) this.held.canvases++;
          else if (effect.created) ctx.project.canvasCount++;
          break;
        case 'canvasDropped':
          // A canvas a held (nested) run created is still only a held row: drop it there.
          if (this.held?.store.rows.delete(`canvas/${effect.id}`)) {
            this.held.canvases = Math.max(0, this.held.canvases - 1);
          } else {
            await ctx.store.delete(`canvas/${effect.id}`);
            ctx.project.canvasCount = Math.max(0, ctx.project.canvasCount - 1);
          }
          break;
        case 'attach':
          await this.store.put(`attach/${effect.attachment.id}`, effect.attachment);
          break;
        case 'keyframe':
          await ctx.store.put(`keyframe/${effect.keyframe.id}`, effect.keyframe);
          break;
        case 'graph':
          if (effect.write.many) await this.store.putMany(effect.write.rows);
          else await this.store.put(effect.write.rows[0].key, effect.write.rows[0].value);
          break;
        case 'diagnostic':
          await this.emit(solveDiagnostic(effect.diagnostic));
          break;
        case 'nested':
          this.found.push(effect.nested);
          break;
        case 'nestedMoment':
          this.moments.push({ region: effect.region, frames: effect.frames });
          break;
        case 'nestedRejected':
          this.rejected.push(effect.region);
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
      this.pending.push({ key: `plan/${pad(frame.index)}`, value: await this.plan(plan) });
      if (this.pending.length >= 24) await this.commit(this.pending);
      this.solved = frame.index + 1;
      await ctx.report(this.solved, frame.time, t('progress.duplicateReuse'), this.progress());
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
      if (this.pendingConsistency.length >= 24) await this.commit(this.pendingConsistency);
    }
    const plan: FramePlan = { index: frame.index, time: frame.time, placements: poll.placements, duplicate: scan.duplicate };
    this.pending.push({ key: `plan/${pad(frame.index)}`, value: await this.plan(plan) });
    if (this.pending.length >= 24) await this.commit(this.pending);
    this.solved = frame.index + 1;
    await ctx.report(this.solved, frame.time, t('progress.solveFrame'), this.progress());
  }
  /** The solve pass's progress, both runs on one scale: each frame of a run costs a decode and a step per region it
   *  solves, so the first run takes `1 + moving regions` of the work and a second run `1 + containers`. Until the
   *  first run has seen every frame its containers are an estimate (`nestedCandidates`); the progress never goes
   *  back. */
  private progress(): number {
    const ctx = this.ctx, done = this.solved / Math.max(1, this.until ?? ctx.project.frames);
    if (!this.nested && this.solved % 30 === 0) this.candidates = this.session.nestedCandidates();
    const first = 1 + Math.max(1, ctx.regions.filter((r) => r.kind === 'moving').length);
    const second = (containers: number) => containers ? 1 + containers : 0;
    const value = this.nested
      ? (first + second(this.nested.length) * done) / (first + second(this.nested.length))
      : first * done / (first + second(this.candidates));
    return ctx.solveProgress = Math.max(ctx.solveProgress, value);
  }
  /** The frame's plan row: the session's own on the first run; on a nested run the first run's row with the containers'
   *  placements added and each container's rectangle left out of its parent's placement. */
  private async plan(plan: FramePlan): Promise<FramePlan> {
    if (!this.nested) return plan;
    const stored = await this.ctx.store.get<FramePlan>(`plan/${pad(plan.index)}`);
    const row: FramePlan = stored ? { ...stored, placements: [...stored.placements] } : { ...plan, placements: [] };
    for (const { clip, ...placement } of plan.placements) {
      if (clip) {
        const parentId = this.nested.find((n) => n.region.id === placement.layer)?.region.parent;
        const at = row.placements.findIndex((p) => p.layer === parentId && !p.skip);
        if (at >= 0) {
          const parent = row.placements[at];
          row.placements[at] = { ...parent, occlusions: [...(parent.occlusions ?? []), clip] };
        }
      }
      row.placements.push(placement);
    }
    return row;
  }
  /** The decode/solve loop: decode-step and per-frame body are two separate try blocks so a decoder failure is
   * never blamed on the solver and vice versa. */
  async runLoop(): Promise<void> {
    const until = this.until = this.nested ? this.session.nestedUntil() : undefined;
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
          // A nested run ends after the last frame in which a container is in sight.
          if (until !== undefined && this.solved >= until) break;
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
        await this.commit(this.pending);
      } catch (error) {
        this.storageFailed = true;
        this.ctx.partial = true;
        try {
          await this.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', this.solved, error));
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
          await this.commit(this.pendingConsistency);
        } catch (error) {
          this.storageFailed = true;
          this.ctx.partial = true;
          try {
            await this.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'solve', this.solved, error));
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        }
      }
    }
    this.graph = PoseGraph.adopt(this.store, this.session.takeGraph());
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
    if (!this.nested) ctx.processed = this.solved;
    // When a second run will follow, the solve progress has not ended yet: the optimizing phase comes after it.
    if (this.nested || !this.found.length) {
      ctx.events.progress({ phase: 'optimizing', fraction: 0, frames: this.solved, time: 0, message: t('progress.optimizing') });
    }
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
      await this.emit({
        code: 'GRAPH_RESIDUAL',
        severity: 'warning',
        message: t('diag.GRAPH_RESIDUAL.message', { residual: result.residual.toFixed(2) }),
        detail: result,
        action: t('diag.GRAPH_RESIDUAL.action'),
      });
    }
    if (!this.nested) await ctx.store.put('graph-summary', { loops: graph.loops, ...result });
  }
  /** Deletes the scan-features/keyframe scratch the pass consumed; render() never reads them. */
  async cleanup(): Promise<void> {
    const ctx = this.ctx;
    await deletePrefix(ctx.store, 'scan-features/');
    await deletePrefix(ctx.store, 'keyframe/');
    await ctx.diagnostics.flush();
    await ctx.persist();
  }
}

/** The containers `found` (each inside one of the run's regions) as regions of their own, each a copy of its parent with `parent` and `nest`, named and
 *  numbered in order after the run's regions, with the parent's pose on the footprint's canvas frame by frame. */
function nestedRegions(ctx: RunContext, found: SolveRun['found'], plans: (FramePlan | undefined)[]): SolveRegionInput[] {
  const atlas = ctx.atlas!, children: SolveRegionInput[] = [];
  for (const f of found) {
    const parent = ctx.regions.find((r) => r.id === f.region)!;
    const region: Region = {
      ...parent,
      id: `${parent.id}-nested-${children.length}`,
      // The closed vocabulary's name for the region at this index (src/i18n/names.ts).
      name: zh.names.contentCanvas.replace('{{n}}', String(ctx.regions.length + children.length + 1)),
      parent: parent.id,
      nest: { canvas: f.canvas, footprint: f.footprint, open: f.open },
    };
    // The parent's ownership epochs and candidate sticky blocks are its own, not the container's.
    delete region.epochs;
    delete region.sticky;
    const parentPoses = plans.map((plan) => {
      const p = plan?.placements.find((q) => q.layer === parent.id && q.canvasId === f.canvas && !q.skip);
      return p ? { x: p.x, y: p.y } : null;
    });
    children.push({ region, code: atlas.code(region), parentPoses });
  }
  return children;
}

async function runNested(ctx: RunContext, children: SolveRegionInput[], held?: Held): Promise<SolveRun> {
  const run = new SolveRun(ctx, children, held);
  try {
    await run.setup();
    await run.runLoop();
    await run.trailingCommitAndMismatch();
    await run.drainVoting();
    await run.optimizeAndCleanup();
  } finally {
    run.free();
  }
  return run;
}

/** Solves the containers the first run found scrolling inside its regions, each as a region of its own clipped
 *  to its footprint (`long_screen::engine::solve::Nest`), in a second run over the frames. The run's rows are held
 *  back until it has confirmed its containers (`Effect::NestedRejected`): when it confirms them all they are
 *  stored; when it confirms some, those are solved again on their own; a container it does not confirm stays part
 *  of its parent, as the first run left it. */
async function solveNested(ctx: RunContext, found: SolveRun['found']): Promise<void> {
  const plans: (FramePlan | undefined)[] = [];
  for (let i = 0; i < ctx.processed; i++) plans.push(await ctx.store.get<FramePlan>(`plan/${pad(i)}`));
  const usable = found.filter((f) => ctx.regions.some((r) => r.id === f.region)), children = nestedRegions(ctx, usable, plans);
  if (!children.length) return;
  const held: Held = { store: new HeldStore(ctx.store), diagnostics: [], canvases: 0 };
  const probe = await runNested(ctx, children, held);
  if (ctx.stopRequested || ctx.partial) return;
  if (!probe.rejected.length) {
    await ctx.store.putMany([...held.store.rows].map(([key, value]) => ({ key, value })));
    for (const d of held.diagnostics) await ctx.diagnostics.emit(d);
    ctx.project.canvasCount += held.canvases;
    await keepNested(ctx, children, probe.moments);
    return;
  }
  const confirmed = usable.filter((_, k) => !probe.rejected.includes(children[k].region.id));
  if (!confirmed.length) return;
  const kept = nestedRegions(ctx, confirmed, plans), run = await runNested(ctx, kept);
  await keepNested(ctx, kept, run.moments);
}

/** Adds the confirmed containers to the run's regions and shows each in its parent's print at its moment. */
async function keepNested(ctx: RunContext, children: SolveRegionInput[], moments: SolveRun['moments']): Promise<void> {
  for (const { region } of children) ctx.regions.push(region);
  await ctx.store.put('regions', ctx.regions);
  await showMoments(ctx, children, moments);
}

/** Takes each moment frame's clip back out of the parent placement's occlusions, so the parent's print holds the
 *  container as it was in one state of its own scroll (`long_screen::kernels::track::nested::Moments`). */
async function showMoments(ctx: RunContext, children: SolveRegionInput[], moments: SolveRun['moments']): Promise<void> {
  for (const { region, frames } of moments) {
    const parentId = children.find((c) => c.region.id === region)?.region.parent;
    for (const { frame, clip } of frames) {
      const key = `plan/${pad(frame)}`, row = await ctx.store.get<FramePlan>(key);
      const at = row?.placements.findIndex((p) => p.layer === parentId && !p.skip) ?? -1;
      if (!row || at < 0) continue;
      const parent = row.placements[at], occlusions = [...(parent.occlusions ?? [])];
      const k = occlusions.findLastIndex((o) => o.x === clip.x && o.y === clip.y && o.width === clip.width && o.height === clip.height);
      if (k < 0) continue;
      occlusions.splice(k, 1);
      const { occlusions: _, ...rest } = parent;
      row.placements[at] = occlusions.length ? { ...rest, occlusions } : rest;
      await ctx.store.put(key, row);
    }
  }
}
export async function solve(ctx: RunContext): Promise<void> {
  ctx.solveProgress = 0;
  const run = new SolveRun(ctx);
  try {
    await run.setup();
    await run.runLoop();
    await run.trailingCommitAndMismatch();
    await run.drainVoting();
    await run.optimizeAndCleanup();
    if (run.found.length && !ctx.stopRequested && !ctx.partial) await solveNested(ctx, run.found);
    await run.cleanup();
  } finally {
    run.free();
  }
}
