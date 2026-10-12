// Host of the render pass. The pass itself — placement resolution through the pose graph and the attachment chain,
// the duplicate and fixed-region shortcuts, the world-consistency mask against the ±1 frames and solve's voting
// records, compositing, the observation ledger and the canvas metadata it updates — is the engine's
// `RenderSession` (rust/long-screen/src/engine/render.rs). This file decodes, reads what the session asks for from storage
// (plans, voting records, canvas rows, tiles, temporal rows), writes what it produces on the same cadence as
// before, formats its diagnostics, and reports progress. The one-frame lookahead loop mirrors scan()'s and
// solve()'s decode-loop shape but is NOT the same skeleton: on a decode failure or natural end it composites the
// already-buffered frame (with no successor) BEFORE reporting or breaking, an ordering specific to this pass's
// lookahead and preserved exactly here.
import type { Attachment, CanvasMeta, FrameImage, FramePlan, Rect, RGBA } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { PoseGraph } from '../core/pose-graph.ts';
import { Compositor } from '../core/compositor.ts';
import { pad } from '../core/math.ts';
import { core, type EngineDiagnostic, type RenderMeta, type RenderNeed, type RenderSessionHandle } from '../core/wasm.ts';
import { releaseUnlessHeld } from '../media/pool.ts';
import type { ConsistencyRecord } from './consistency.ts';
import { t } from '../i18n/index.ts';
import { prefixOnly, type RunContext, StorageError } from './context.ts';

/** The CanvasMeta fields the session changes, as it takes them in. */
function renderMeta(meta: CanvasMeta): RenderMeta {
  const { bounds, tileCount, observedPixels, uncertainPixels, conflictPixels, provisionalPixels, lastTime } = meta;
  return { bounds, tileCount, observedPixels, uncertainPixels, conflictPixels, provisionalPixels, lastTime };
}

/** Per-pass state, as fields rather than closed-over locals; the small methods below are the pass's sub-steps.
 * See the file header for the one-frame-lookahead ordering `run()` must preserve exactly. */
export class RenderPass {
  private graph!: PoseGraph;
  private compositor!: Compositor;
  private session!: RenderSessionHandle;
  /** Stored canvas rows the session asked for. The session holds the fields it changes; they are written back into
   * these objects for the progress event's canvas each frame and for every changed canvas at each flush, so the
   * rest of each row (and its key order) is what solve stored. */
  private readonly metas = new Map<string, CanvasMeta>();
  /** The run's counters as they stood when the pass began; the session reports its own cumulative ones. */
  private base!: { skippedPaints: number; tiles: number; observedPixels: number };
  // Per-frame observation ledger rows, batched like the scan/plan rows instead of one transaction each.
  private readonly pendingObservations: { key: string; value: unknown }[] = [];
  private lastFlush!: number;
  private storageFailed = false;
  private endedNaturally = false;
  private missingPlan: number | undefined;
  // Set by processFrame() once a stop request was honoured or the solved prefix has been fully rendered, so
  // run()'s loop can break WITHOUT decoding one further (wasted) lookahead frame first.
  private stop = false;
  // One-frame lookahead: `pending` is the most recently decoded frame not yet composited, held back so the
  // session's consistency mask can compare its content against BOTH the frame before it (`pendingPrev`, already
  // decoded) and the frame after it (decoded one step ahead of compositing — see run()). The last buffered frame
  // is flushed with no successor once decoding ends (see memory-stats.json for the extra native RGBA frame this
  // holds).
  private pending: FrameImage | undefined;
  private pendingPrev: RGBA | undefined;
  // Defaults to the real clock in production; a test supplies a fake so checkpointFlush()'s 1200 ms gate is a
  // deterministic branch instead of a wall-clock race under `deno test --parallel`.
  constructor(private readonly ctx: RunContext, private readonly now: () => number = () => performance.now()) {
    // No ctx-mutating or fallible work here: `render()` runs phase/status/persist() BEFORE constructing this
    // pass, so a persist() failure at the very start of the run never leaves a compositor or session allocated
    // that nothing would go on to free (see setup(), which does the rest in the original order).
  }
  /** Builds the graph, the compositor and the session (with the run's regions and attachments), and has the session
   * configure the tile-cache memory budget (render buffers one extra decoded native RGBA frame — the one-frame
   * lookahead the consistency mask compares against, see docs/ARCHITECTURE.md §七 — so the working-memory
   * reservation grows by one more native frame than scan()'s), raising it if the tiles one frame paints would not
   * otherwise fit. */
  private async setup(): Promise<void> {
    const ctx = this.ctx, atlas = ctx.atlas!;
    this.graph = new PoseGraph(ctx.store);
    this.compositor = new Compositor(ctx.store, ctx.tiles, ctx.project.settings.temporalPolicy, (d) => ctx.diagnostics.emit(d), atlas);
    const attachments: Attachment[] = [];
    for await (const { value } of iterate<Attachment>(ctx.store, 'attach/')) attachments.push(value);
    this.session = core().renderSession({
      width: ctx.source.info.width,
      height: ctx.source.info.height,
      factor: ctx.factor,
      noise: ctx.noise,
      regions: ctx.regions.map((r) => {
        const code = atlas.code(r);
        return { id: r.id, kind: r.kind, rect: r.rect, code, ownedPixels: atlas.count(code) };
      }),
      attachments,
    });
    this.base = { skippedPaints: ctx.skippedPaints, tiles: ctx.project.tiles, observedPixels: ctx.project.observedPixels };
    this.lastFlush = this.now();
    const raised = this.session.configureTiles(ctx.tiles.engine, ctx.project.settings.memoryMB);
    if (raised) {
      const { from, to, mb } = raised.params;
      await ctx.diagnostics.emit({
        code: 'MEMORY_BUDGET_RAISED',
        severity: 'info',
        message: t('diag.MEMORY_BUDGET_RAISED.message', { from, to, mb }),
        action: t('diag.MEMORY_BUDGET_RAISED.action'),
        detail: raised.detail as Record<string, number>,
      });
    }
  }
  /** Formats one of the session's diagnostics as the journal row the pass has always written. */
  private async report(d: EngineDiagnostic): Promise<void> {
    const { frame, time, region, canvasId: canvas } = d as Required<EngineDiagnostic>;
    if (d.code === 'NONFINITE_POSE') {
      await this.ctx.diagnostics.emit({
        code: 'NONFINITE_POSE',
        severity: 'error',
        time,
        frame,
        canvasId: canvas,
        message: t('diag.NONFINITE_POSE.message'),
      });
    } else if (d.code === 'INCOMPLETE_TEMPORAL_PATCH') {
      await this.compositor.report({ kind: 'incomplete', frame, time, region }, canvas);
    } else {
      const { confidence } = d as Required<EngineDiagnostic>, { regions } = d.detail as { regions: Rect[] };
      await this.compositor.report({ kind: 'conflict', frame, time, region, confidence, regions, conflicts: d.params.conflicts }, canvas);
    }
  }
  /** The stored canvas row with the session's current values written into it. */
  private liveMeta(canvasId: string, values = this.session.meta(canvasId)): CanvasMeta | undefined {
    const meta = this.metas.get(canvasId);
    if (meta && values) Object.assign(meta, values);
    return meta;
  }
  /** Stores every canvas row the session changed since the last flush, in first-changed order. */
  private async flushMetas(): Promise<void> {
    const dirty = this.session.dirtyMetas();
    if (!dirty.length) return;
    await this.ctx.storagePutMany(dirty.map(({ canvas, meta }) => ({ key: `canvas/${canvas}`, value: this.liveMeta(canvas, meta) })));
  }
  /** Periodic checkpoint: tiles/compositor/diagnostics/metas flush together every ~1.2s (plus once more at the
   * very end of the pass), not per placement — only tiles untouched since the previous checkpoint are written,
   * since the active footprint is repainted every frame and would otherwise be re-encoded on every checkpoint. */
  private async checkpointFlush(): Promise<void> {
    if (this.now() - this.lastFlush >= 1200) {
      const settledBefore = this.lastFlush;
      this.lastFlush = this.now();
      await this.ctx.tiles.flush(settledBefore);
      await this.compositor.flush();
      await this.ctx.diagnostics.flush();
      await this.flushMetas();
      if (this.pendingObservations.length) {
        await this.ctx.commitRows(this.pendingObservations);
      }
    }
  }
  /** Runs one frame through the session, answering what it asks for, until it hands back the frame's observation
   * row; returns that row and the canvas of the frame's last moving-region placement. */
  private async composite(
    frame: FrameImage,
    plan: FramePlan,
    prevImage: RGBA | undefined,
    nextImage: RGBA | undefined,
  ): Promise<{ observation: unknown; latest: CanvasMeta | undefined }> {
    const ctx = this.ctx, session = this.session;
    const prevPlan = prevImage ? await ctx.store.get<FramePlan>(`plan/${pad(frame.index - 1)}`) : undefined;
    const nextPlan = nextImage ? await ctx.store.get<FramePlan>(`plan/${pad(frame.index + 1)}`) : undefined;
    // solve()'s displacement-spread voting verdicts for this frame AND for the two frames the ±1-frame check
    // compares it against: the mask asks a disagreeing neighbour whether voting found IT clean at that world
    // position before letting it condemn this frame. The session keeps the last few frames' records, so it asks
    // for one new row per frame, not three.
    const votes = [];
    for (const index of session.wantedVotes(frame.index, !!prevImage, !!nextImage)) {
      votes.push({ index, record: await ctx.store.get<ConsistencyRecord>(`consistency/${pad(index)}`) });
    }
    session.begin({ index: frame.index, time: frame.time, plan, hasPrev: !!prevImage, prevPlan, hasNext: !!nextImage, nextPlan, votes });
    const need = await this.drive((index) => {
      const image = index === frame.index ? frame.image : index < frame.index ? prevImage! : nextImage!;
      const { width, height } = ctx.source.info;
      if (image.width !== width || image.height !== height) {
        throw new Error(`CORE_BAD_ARGUMENT: frame ${image.width}×${image.height} does not fit a ${width}×${height} ring.`);
      }
      return image;
    });
    return { observation: need.observation, latest: need.latest === undefined ? undefined : this.liveMeta(need.latest) };
  }
  /** Steps the session until its job is done, answering what it asks for; `frameFor` supplies the ring's frames, and
   * without it (the finishing job) a frame request is an error and the session's counters are left out, as the
   * native host leaves them. */
  private async drive(frameFor?: (index: number) => RGBA): Promise<Extract<RenderNeed, { kind: 'done' }>> {
    const ctx = this.ctx, session = this.session;
    const graph = await this.graph.engine();
    for (;;) {
      const { events, counters, need } = session.step(
        this.compositor.engine,
        ctx.tiles.engine,
        graph,
        ctx.atlas!.resident,
        performance.now(),
      );
      if (frameFor) {
        ctx.skippedPaints = this.base.skippedPaints + counters.skippedPaints;
        ctx.project.tiles = this.base.tiles + counters.tiles;
        ctx.project.observedPixels = this.base.observedPixels + counters.observedPixels;
      }
      for (const e of events) await this.report(e);
      switch (need.kind) {
        case 'done':
          return need;
        case 'error':
          throw new Error(need.message);
        case 'meta': {
          const meta = await ctx.store.get<CanvasMeta>(`canvas/${need.canvas}`);
          if (meta) this.metas.set(need.canvas, meta);
          session.provideMeta(need.canvas, meta && renderMeta(meta));
          break;
        }
        case 'frame':
          if (!frameFor) throw new Error('CORE_BAD_ARGUMENT: the finishing job asked for a frame.');
          session.provideFrame(need.index, frameFor(need.index).data);
          break;
        case 'tile':
          await ctx.tiles.load(need.canvas, need.x, need.y);
          break;
        case 'temporal':
          await this.compositor.loadTemporal(need.canvas);
          break;
      }
    }
  }
  /** After the last frame: the session's finishing job for the fixed regions (`RenderSession::begin_finish`), answered
   * like a frame. A failure keeps the frames already rendered and marks the run partial, as a failed frame does. */
  private async finishFixed(): Promise<void> {
    const ctx = this.ctx, session = this.session;
    try {
      if (session.beginFinish()) await this.drive();
    } catch (error) {
      session.cancel(this.compositor.engine);
      ctx.partial = true;
      if (error instanceof StorageError) this.storageFailed = true;
      await ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
    }
  }
  /** One decoded frame's worth of work: composite its plan's placements through the session, persist the ledger
   * row, and report progress. Sets `this.stop` (never breaks itself — run()'s loop owns the decode order) once a
   * stop was honoured or the solved prefix is fully rendered. */
  private async processFrame(frame: FrameImage, prevImage: RGBA | undefined, nextImage: RGBA | undefined): Promise<void> {
    try {
      const plan = await this.ctx.store.get<FramePlan>(`plan/${pad(frame.index)}`);
      if (!plan) {
        this.ctx.partial = true;
        this.missingPlan = frame.index;
        await this.ctx.diagnostics.emit({
          code: 'MISSING_PLAN',
          severity: 'error',
          frame: frame.index,
          message: t('diag.MISSING_PLAN.message', { index: pad(frame.index) }),
          action: t('diag.MISSING_PLAN.action'),
          detail: { pass: 'render', frame: frame.index },
        });
        this.stop = true;
        return;
      }
      const { observation, latest } = await this.composite(frame, plan, prevImage, nextImage);
      // Every decoded observation has a durable placement and a pixel contribution ledger.
      this.pendingObservations.push({ key: `observation/${pad(frame.index)}`, value: observation });
      if (this.pendingObservations.length >= 32) {
        await this.ctx.commitRows(this.pendingObservations);
      }
      this.ctx.project.renderedFrames = frame.index + 1;
      await this.checkpointFlush();
      await this.ctx.report(
        frame.index + 1,
        frame.time,
        t('progress.render'),
        (frame.index + 1) / Math.max(1, this.ctx.processed),
        latest,
      );
      if (this.ctx.stopRequested) {
        this.ctx.honourStop();
        this.stop = true;
        return;
      }
      if (frame.index + 1 >= this.ctx.processed) {
        this.stop = true;
      }
    } catch (error) {
      this.session.cancel(this.compositor.engine);
      if (!this.ctx.project.renderedFrames) {
        throw error;
      }
      this.ctx.partial = true;
      if (error instanceof StorageError) {
        this.storageFailed = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        this.stop = true;
        return;
      }
      await this.ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
      this.stop = true;
    }
  }
  /** The one-frame-lookahead decode loop. See the file header: on a decode failure or natural end, the already
   * buffered frame is composited (with no successor) BEFORE reporting or breaking — preserved exactly here. */
  private async run(): Promise<void> {
    const it = this.ctx.source.frames();
    try {
      while (true) {
        await this.ctx.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          // Decode failed while looking one frame ahead (or on the very first frame). Composite whatever is
          // already buffered as the final frame (no successor) BEFORE reporting/breaking, so a lookahead-only
          // decode failure never drops an already-decoded, not-yet-composited frame.
          if (this.pending) {
            await this.processFrame(this.pending, this.pendingPrev, undefined);
            // `pending`/`pendingPrev` are this pass's only holders of these two pool buffers; both are done now.
            releaseUnlessHeld(this.pendingPrev, this.pending.image);
            releaseUnlessHeld(this.pending.image);
          }
          this.pending = undefined;
          this.pendingPrev = undefined;
          if (!this.ctx.project.renderedFrames) {
            throw error;
          }
          this.ctx.partial = true;
          await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
          break;
        }
        if (step.done) {
          this.endedNaturally = true;
          if (this.pending) {
            await this.processFrame(this.pending, this.pendingPrev, undefined);
            releaseUnlessHeld(this.pendingPrev, this.pending.image);
            releaseUnlessHeld(this.pending.image);
          }
          this.pending = undefined;
          this.pendingPrev = undefined;
          break;
        }
        const frame = step.value;
        if (this.pending) {
          const oldPendingPrev = this.pendingPrev;
          await this.processFrame(this.pending, this.pendingPrev, frame.image);
          this.pendingPrev = this.pending.image;
          // `oldPendingPrev` (frame N-2's image) was this call's `prevImage`, its last use anywhere in this pass —
          // once `pendingPrev` has moved on to frame N-1's image, nothing still points at it.
          releaseUnlessHeld(oldPendingPrev, this.pendingPrev, frame.image);
        }
        this.pending = frame;
        if (this.stop) {
          // The lookahead frame just buffered was only ever used as `nextImage` in the call above (a read that
          // does not keep the JS object); stopping here drops it without ever compositing it, so it is this
          // pass's last chance to give its buffer back.
          releaseUnlessHeld(this.pending.image, this.pendingPrev);
          this.pending = undefined;
          break;
        }
      }
      if (this.ctx.project.renderedFrames && !this.storageFailed) await this.finishFixed();
    } finally {
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
      this.compositor.dispose();
      // Best-effort: committed tiles and in-memory metas should not be stranded even when the loop exited through
      // a storage failure; a repeat failure here is swallowed rather than masking the original error.
      try {
        if (this.pendingObservations.length && !this.storageFailed) await this.ctx.commitRows(this.pendingObservations);
      } catch (error) {
        this.storageFailed = true;
        this.ctx.partial = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
      try {
        if (!this.storageFailed) {
          await this.compositor.flush();
          await this.flushMetas();
        }
      } catch (error) {
        this.storageFailed = true;
        this.ctx.partial = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      } finally {
        // The engine's compositor, pose graph and render session end with the pass, after the last flushes.
        this.compositor?.free();
        this.graph?.free();
        this.session?.free();
      }
    }
  }
  /** Trailing commits: pass-mismatch diagnostic, final tile/diagnostics flush, memory-stats row and project
   * persist. */
  private async finish(): Promise<void> {
    if ((this.endedNaturally || this.missingPlan !== undefined) && this.ctx.project.renderedFrames !== this.ctx.processed) {
      await this.ctx.passMismatch('render', this.ctx.processed, this.ctx.project.renderedFrames);
    }
    await this.ctx.tiles.flush();
    await this.ctx.diagnostics.flush();
    await this.ctx.store.put('memory-stats', {
      peakResidentTiles: this.ctx.tiles.peakResidentTiles,
      tileCacheLimit: this.ctx.tiles.maxTiles,
      budgetMB: this.ctx.project.settings.memoryMB,
      note:
        'Codec/browser/GPU allocations are additional, not a hard process-RSS bound. The render pass also holds one extra decoded native RGBA frame: a one-frame lookahead the world-consistency mask compares against (docs/ARCHITECTURE.md §七).',
    });
    await this.ctx.persist();
  }
  /** Runs the rest of the pass: setup (graph/compositor/attachments/budget), the lookahead decode loop, then
   * the trailing commits. Phase/status/persist already happened in `render()`, before this pass was built. */
  async execute(): Promise<void> {
    try {
      await this.setup();
    } catch (error) {
      // run()'s finally never runs: release what setup() already built.
      this.compositor?.free();
      this.graph?.free();
      this.session?.free();
      throw error;
    }
    await this.run();
    await this.finish();
  }
}
export async function render(ctx: RunContext): Promise<void> {
  // Phase/status/persist happen BEFORE the pass is constructed: if persist() fails here, nothing (compositor,
  // render session) has been allocated yet for RenderPass's own finally to free — Engine's own
  // cleanup is enough, exactly as it was before this pass had a constructor at all.
  ctx.phase = 'rendering';
  ctx.project.status = 'rendering';
  await ctx.persist();
  await new RenderPass(ctx).execute();
}
