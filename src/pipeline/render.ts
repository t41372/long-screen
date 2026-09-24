// Shell around the render pass: placement resolution, fixed-region duplicate paint detection, consistency mask
// consultation and compositing, observation ledger, periodic flush of tiles/metas/diagnostics. The one-frame
// lookahead loop mirrors scan()'s and solve()'s decode-loop shape but is NOT the same skeleton: on a decode
// failure or natural end it composites the already-buffered frame (with no successor) BEFORE reporting or
// breaking, an ordering specific to this pass's lookahead and preserved exactly here.
import type { Attachment, CanvasMeta, FrameImage, FramePlan, Placement, Region, RGBA } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { PoseGraph } from '../core/pose-graph.ts';
import { Compositor } from '../core/compositor.ts';
import { pad } from '../core/math.ts';
import { core, type FrameRing, type Resident, type ResidentFrame } from '../core/wasm.ts';
import { attachedRenderShift, resolveTarget as resolveAttachmentTarget } from './attachments.ts';
import { consistencyMask, type ConsistencyRecord } from './consistency.ts';
import { prefixOnly, type RunContext, StorageError } from './context.ts';
/** One placement's ledger row: what canvas it targeted, its final render-time placement, and either its pixel
 * contribution (addedPixels/conflictPixels/uncertainPixels) or which shortcut skipped painting it. */
interface RenderDecision {
  canvasId: string;
  placement: Placement;
  addedPixels: number;
  conflictPixels: number;
  uncertainPixels: number;
  skipped?: boolean;
  reusedExactObservation?: boolean;
}
/** Rolling window over solve()'s per-frame voting verdicts. Each rendered frame needs its own record plus its two
 * ±1 neighbours', and consecutive frames overlap by two, so a four-slot window turns three reads per frame into
 * one. A missing record (the common case for a frame no region had anything to say about) is cached as
 * `undefined` just like a present one, so it is not re-read either. */
class VotingWindow {
  private readonly window: { index: number; record: ConsistencyRecord | undefined }[] = [];
  constructor(private readonly ctx: RunContext) {}
  async get(index: number): Promise<ConsistencyRecord | undefined> {
    const hit = this.window.find((e) => e.index === index);
    if (hit) {
      return hit.record;
    }
    const record = index < 0 ? undefined : await this.ctx.store.get<ConsistencyRecord>(`consistency/${pad(index)}`);
    this.window.push({ index, record });
    if (this.window.length > 4) {
      this.window.shift();
    }
    return record;
  }
}
/** CanvasMeta held in RAM for the whole pass instead of `store.put` once per placement per frame: `dirty` tracks
 * which ones changed since the last flush, which happens alongside the existing ~1.2s tile flush (and once more
 * at the end of the pass), not on every placement. Progress events still carry the live (in-memory) meta, so a
 * caller polling mid-run never sees more than that same ~1.2s of lag. */
class CanvasMetaCache {
  private readonly metas = new Map<string, CanvasMeta>();
  private readonly dirty = new Set<string>();
  constructor(private readonly ctx: RunContext) {}
  async get(canvasId: string): Promise<CanvasMeta | undefined> {
    let meta = this.metas.get(canvasId);
    if (meta) return meta;
    meta = await this.ctx.store.get<CanvasMeta>(`canvas/${canvasId}`);
    if (meta) this.metas.set(canvasId, meta);
    return meta;
  }
  markDirty(canvasId: string): void {
    this.dirty.add(canvasId);
  }
  async flush(): Promise<void> {
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    await this.ctx.storagePutMany(ids.map((id) => ({ key: `canvas/${id}`, value: this.metas.get(id) })));
    for (const id of ids) this.dirty.delete(id);
  }
}
/** All per-pass state `render()` used to close over, now fields; the small methods below are exactly the
 * sub-steps `render()`'s single 385-line body used to inline. See the file header for the one-frame-lookahead
 * ordering `run()` must preserve exactly. */
class RenderPass {
  private graph!: PoseGraph;
  private compositor!: Compositor;
  private regionMap!: Map<string, Region>;
  private readonly attachments = new Map<string, Attachment>();
  // Core-resident render state: each decoded native frame enters core memory once (three slots: previous,
  // current, lookahead), and the consistency mask is produced and consumed inside the core. Freed in this pass's
  // `run()` finally; Engine `run()`'s finally covers exits before that (a `setup()` throw) and the atlas itself.
  // The atlas label plane is NOT allocated here — it is `ctx.atlas!.resident`, already core-resident since
  // scan() built the atlas, borrowed (not uploaded) below and released once with the atlas, by Engine.
  private frames!: FrameRing;
  private residentLabels!: Resident;
  private residentMask!: Resident;
  private fixedPixels!: Map<string, Resident>;
  private readonly previousPlacements = new Map<string, Placement>();
  private readonly votingWindow: VotingWindow;
  private readonly metaCache: CanvasMetaCache;
  // Per-frame observation ledger rows, batched like the scan/plan rows instead of one transaction each.
  private readonly pendingObservations: { key: string; value: unknown }[] = [];
  private lastFlush!: number;
  private storageFailed = false;
  private endedNaturally = false;
  private missingPlan: number | undefined;
  // Set by processFrame() once a stop request was honoured or the solved prefix has been fully rendered, so
  // run()'s loop can break WITHOUT decoding one further (wasted) lookahead frame first.
  private stop = false;
  // One-frame lookahead: `pending` is the most recently decoded frame not yet composited, held back so
  // consistencyMask() can compare its content against BOTH the frame before it (`pendingPrev`, already decoded)
  // and the frame after it (decoded one step ahead of compositing — see run()). The last buffered frame is
  // flushed with no successor once decoding ends (see memory-stats.json for the extra native RGBA frame this
  // holds).
  private pending: FrameImage | undefined;
  private pendingPrev: RGBA | undefined;
  constructor(private readonly ctx: RunContext) {
    // No ctx-mutating or fallible work here: `render()` runs phase/status/persist() BEFORE constructing this
    // pass, so a persist() failure at the very start of the run never leaves a compositor/frame-ring/mask
    // allocated that nothing would go on to free (see setup(), which does the rest in the original order).
    this.votingWindow = new VotingWindow(ctx);
    this.metaCache = new CanvasMetaCache(ctx);
  }
  /** Builds the graph/compositor/region-map and core-resident render state, loads attachments, and configures the
   * tile-cache memory budget (render buffers one extra decoded native RGBA frame — the one-frame lookahead
   * consistencyMask() compares against, see docs/ARCHITECTURE.md §七 — so the working-memory reservation grows by
   * one more native frame than scan()'s), raising it if a single frame's footprint would not otherwise fit. */
  private async setup(): Promise<void> {
    this.graph = new PoseGraph(this.ctx.store);
    this.compositor = new Compositor(
      this.ctx.store,
      this.ctx.tiles,
      this.ctx.project.settings.temporalPolicy,
      (d) => this.ctx.diagnostics.emit(d),
      this.ctx.atlas!,
    );
    this.regionMap = new Map(this.ctx.regions.map((r) => [r.id, r]));
    for await (const { value } of iterate<Attachment>(this.ctx.store, 'attach/')) {
      this.attachments.set(value.id, value);
    }
    const { width: frameW, height: frameH } = this.ctx.source.info;
    this.frames = this.ctx.frames = core().frameRing(3, frameW, frameH);
    this.residentLabels = this.ctx.atlas!.resident;
    this.residentMask = this.ctx.residentMask = core().alloc(frameW * frameH);
    this.fixedPixels = this.ctx.fixedPixels;
    this.lastFlush = performance.now();
    const fixedBytes = this.ctx.regions.filter((r) => r.kind === 'fixed').reduce(
      (n, r) => n + Math.ceil(r.rect.width) * Math.ceil(r.rect.height) * 4,
      0,
    );
    this.ctx.tiles.configureBudget(
      this.ctx.project.settings.memoryMB,
      this.ctx.source.info.width * this.ctx.source.info.height * 5 + fixedBytes + 8 * 1024 * 1024 +
        this.ctx.source.info.width * this.ctx.source.info.height * 4,
    );
    const raisedTiles = this.ctx.tiles.ensureFootprint(this.ctx.source.info.width, this.ctx.source.info.height);
    if (raisedTiles) {
      await this.ctx.diagnostics.emit({
        code: 'MEMORY_BUDGET_RAISED',
        severity: 'info',
        message: `瓦片缓存从预算允许的 ${this.ctx.tiles.maxTiles - raisedTiles} 块提高到 ${this.ctx.tiles.maxTiles} 块（约 ${
          Math.round(this.ctx.tiles.maxTiles * this.ctx.tiles.size * this.ctx.tiles.size * 4.3 / 1024 / 1024)
        } MB），以容纳一帧触及的全部瓦片。`,
        action: '小于单帧覆盖范围的缓存会让每一帧都完整地重新解码与编码所有瓦片；如需更低内存，请降低录屏分辨率。',
        detail: { budgetMB: this.ctx.project.settings.memoryMB, tiles: this.ctx.tiles.maxTiles, raisedBy: raisedTiles },
      });
    }
  }
  /** Resolves a raw (odometry-space) Placement into its final render-time pose and canvas: pose-graph correction,
   * attachment-shift, and the attachment chain walk. Shared by the current frame's own placements and by the
   * one-frame-lookahead neighbour placements consistencyMask() compares against — both need exactly the
   * resolution render() already does, just at a different frame index. */
  private async resolvePlacement(raw: Placement, frameIndex: number): Promise<{ x: number; y: number; canvasId: string }> {
    const correction = await this.graph.correction(raw.node, frameIndex),
      shift = await attachedRenderShift(this.attachments, this.graph, raw.canvasId),
      canvasId = resolveAttachmentTarget(this.attachments, raw.canvasId);
    // Keep the optimized pose in the graph/render ledger. Compositor and consistencyMask() each resolve this
    // same floating-point pose independently, matching the raster coordinates without discarding subpixel
    // diagnostics or making a rounded placement part of the render-time state.
    return { x: raw.x + correction.x + shift.x, y: raw.y + correction.y + shift.y, canvasId };
  }
  /** Fixed-region duplicate-paint detection: compares this frame's pixels within the region's rect against the
   * core-resident copy saved from the last time this region actually painted, replacing that copy in place.
   * Called only when the plan-level duplicate shortcut did not already establish `unchanged`. */
  private paintFixedRegion(region: Region, image: RGBA, frameIndex: number): boolean {
    const rect = region.rect, rw = Math.ceil(rect.width), rh = Math.ceil(rect.height), code = this.ctx.atlas!.code(region);
    const old = this.fixedPixels.get(region.id), saved = old || core().alloc(rw * rh * 4);
    this.fixedPixels.set(region.id, saved);
    const changed = core().fixedUpdate(
      saved,
      this.frames.upload(frameIndex, image),
      this.residentLabels,
      Math.floor(rect.x),
      Math.floor(rect.y),
      rw,
      rh,
      code,
    );
    return !!old && !changed;
  }
  /** World-consistency mask (docs/ARCHITECTURE.md §七) neighbour assembly for a `moving` region: resolves the
   * ±1-frame neighbour placements for this same layer (when the neighbour frame exists and had a non-skipped
   * placement for it) and hands consistencyMask() their images, poses, occlusions and voting verdicts alongside
   * this frame's own. Fixed regions and duplicate-shortcut placements never reach here (see consistencyMask's doc
   * comment): a screen-fixed overlay occupies a different world position every frame, so it never agrees with a
   * neighbour sampled at the SAME world position and ends up provisional instead of burned permanently in. */
  private async maskFor(
    frame: FrameImage,
    prevImage: RGBA | undefined,
    nextImage: RGBA | undefined,
    prevPlan: FramePlan | undefined,
    nextPlan: FramePlan | undefined,
    votingRecord: ConsistencyRecord | undefined,
    prevVoting: ConsistencyRecord | undefined,
    nextVoting: ConsistencyRecord | undefined,
    region: Region,
    code: number,
    p: Placement & { canvasId: string },
    current: ResidentFrame,
  ): Promise<Uint8Array | Resident | undefined> {
    const prevRaw = prevImage ? prevPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
    const nextRaw = nextImage ? nextPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
    const prevResolved = prevRaw ? await this.resolvePlacement(prevRaw, frame.index - 1) : undefined;
    const nextResolved = nextRaw ? await this.resolvePlacement(nextRaw, frame.index + 1) : undefined;
    return consistencyMask(
      current,
      this.residentLabels,
      region,
      code,
      p,
      p.canvasId,
      {
        prev: prevResolved
          ? {
            image: this.frames.upload(frame.index - 1, prevImage!),
            ...prevResolved,
            occlusions: prevRaw?.occlusions,
            voting: prevVoting?.[region.id],
          }
          : undefined,
        next: nextResolved
          ? {
            image: this.frames.upload(frame.index + 1, nextImage!),
            ...nextResolved,
            occlusions: nextRaw?.occlusions,
            voting: nextVoting?.[region.id],
          }
          : undefined,
        voting: votingRecord?.[region.id],
        factor: this.ctx.factor,
        noise: this.ctx.noise,
        output: this.residentMask,
      },
    );
  }
  /** Periodic checkpoint: tiles/compositor/diagnostics/metas flush together every ~1.2s (plus once more at the
   * very end of the pass), not per placement — only tiles untouched since the previous checkpoint are written,
   * since the active footprint is repainted every frame and would otherwise be re-encoded on every checkpoint. */
  private async checkpointFlush(): Promise<void> {
    if (performance.now() - this.lastFlush >= 1200) {
      const settledBefore = this.lastFlush;
      this.lastFlush = performance.now();
      await this.ctx.tiles.flush(settledBefore);
      await this.compositor.flush();
      await this.ctx.diagnostics.flush();
      await this.metaCache.flush();
      if (this.pendingObservations.length) {
        await this.ctx.commitRows(this.pendingObservations);
      }
    }
  }
  /** One plan placement: the duplicate/fixed-region-unchanged shortcut, or a full consistency-mask-and-composite
   * paint. Returns its ledger row and, when it painted (or shortcut-skipped) a `moving` region, that region's
   * meta — the candidate for `processFrame`'s `latest` (the progress event's canvas), which `moving`-check mirrors
   * the original inline `latest = region.kind === 'moving' ? meta : latest` exactly: a non-moving placement
   * leaves whatever `latest` already was untouched, never clears it. */
  private async applyPlacement(
    placement: Placement,
    frame: FrameImage,
    image: RGBA,
    prevImage: RGBA | undefined,
    nextImage: RGBA | undefined,
    prevPlan: FramePlan | undefined,
    nextPlan: FramePlan | undefined,
    votingRecord: ConsistencyRecord | undefined,
    prevVoting: ConsistencyRecord | undefined,
    nextVoting: ConsistencyRecord | undefined,
    planDuplicate: boolean,
  ): Promise<{ decision: RenderDecision; movingMeta: CanvasMeta | undefined }> {
    if (placement.skip) {
      return {
        decision: { canvasId: placement.canvasId, placement, addedPixels: 0, conflictPixels: 0, uncertainPixels: 0, skipped: true },
        movingMeta: undefined,
      };
    }
    const resolved = await this.resolvePlacement(placement, frame.index);
    const p = { ...placement, ...resolved };
    const meta = await this.metaCache.get(p.canvasId);
    if (!meta) {
      throw new Error('Canvas metadata is missing.');
    }
    const region = this.regionMap.get(p.layer)!;
    const last = this.previousPlacements.get(p.layer);
    let unchanged = planDuplicate && !!last && last.canvasId === p.canvasId && last.x === p.x && last.y === p.y;
    if (region.kind === 'fixed' && !unchanged) {
      // The saved copy lives in the core; pixels the region does not own are never compared or written.
      unchanged = this.paintFixedRegion(region, image, frame.index);
    }
    this.previousPlacements.set(p.layer, p);
    if (unchanged) {
      this.ctx.skippedPaints++;
      meta.lastTime = p.time;
      this.metaCache.markDirty(p.canvasId);
      return {
        decision: {
          canvasId: p.canvasId,
          placement: p,
          addedPixels: 0,
          conflictPixels: 0,
          uncertainPixels: 0,
          reusedExactObservation: true,
        },
        movingMeta: region.kind === 'moving' ? meta : undefined,
      };
    }
    let consistent: Uint8Array | Resident | undefined;
    const current = this.frames.upload(frame.index, image);
    if (region.kind === 'moving') {
      const code = this.ctx.atlas!.code(region);
      consistent = await this.maskFor(
        frame,
        prevImage,
        nextImage,
        prevPlan,
        nextPlan,
        votingRecord,
        prevVoting,
        nextVoting,
        region,
        code,
        p,
        current,
      );
    }
    const stats = await this.compositor.add(image, region, p, frame.index, meta, consistent, current);
    this.ctx.project.tiles += stats.tiles;
    this.ctx.project.observedPixels += stats.added;
    this.metaCache.markDirty(p.canvasId);
    return {
      decision: {
        canvasId: p.canvasId,
        placement: p,
        addedPixels: stats.added,
        conflictPixels: stats.conflicts,
        uncertainPixels: stats.uncertain,
      },
      movingMeta: region.kind === 'moving' ? meta : undefined,
    };
  }
  /** One decoded frame's worth of work: resolve its plan's placements, paint or skip each, composite the
   * observation, persist the ledger row, and report progress. Sets `this.stop` (never breaks itself — run()'s
   * loop owns the decode order) once a stop was honoured or the solved prefix is fully rendered. */
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
          message: `渲染阶段缺少 plan/${pad(frame.index)}；已停止在已提交的渲染前缀。`,
          action: '检查本地存储完整性；缺失的求解计划不会被静默当作空观察。',
          detail: { pass: 'render', frame: frame.index },
        });
        this.stop = true;
        return;
      }
      const image = frame.image;
      const prevPlan = prevImage ? await this.ctx.store.get<FramePlan>(`plan/${pad(frame.index - 1)}`) : undefined;
      const nextPlan = nextImage ? await this.ctx.store.get<FramePlan>(`plan/${pad(frame.index + 1)}`) : undefined;
      // solve()'s displacement-spread voting verdicts for this frame AND for the two frames the ±1-frame check
      // compares it against: consistencyMask() asks a disagreeing neighbour whether voting found IT clean at
      // that world position before letting it condemn this frame (see its truth table). Reads go through
      // votingWindow, which keeps the last few frames' records so the three lookups per frame cost one store
      // read per frame, not three.
      const votingRecord = await this.votingWindow.get(frame.index),
        prevVoting = prevImage ? await this.votingWindow.get(frame.index - 1) : undefined,
        nextVoting = nextImage ? await this.votingWindow.get(frame.index + 1) : undefined;
      let latest: CanvasMeta | undefined;
      const decisions: RenderDecision[] = [];
      for (const placement of plan.placements) {
        const { decision, movingMeta } = await this.applyPlacement(
          placement,
          frame,
          image,
          prevImage,
          nextImage,
          prevPlan,
          nextPlan,
          votingRecord,
          prevVoting,
          nextVoting,
          !!plan.duplicate,
        );
        decisions.push(decision);
        if (movingMeta) {
          latest = movingMeta;
        }
      }
      // Every decoded observation has a durable placement and a pixel contribution ledger.
      this.pendingObservations.push({ key: `observation/${pad(frame.index)}`, value: { frame: frame.index, time: frame.time, decisions } });
      if (this.pendingObservations.length >= 32) {
        await this.ctx.commitRows(this.pendingObservations);
      }
      this.ctx.project.renderedFrames = frame.index + 1;
      await this.checkpointFlush();
      await this.ctx.report(
        frame.index + 1,
        frame.time,
        '按观察证据合成原尺寸瓦片；缺口保持透明。',
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
          }
          this.pending = undefined;
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
          }
          this.pending = undefined;
          break;
        }
        const frame = step.value;
        if (this.pending) {
          await this.processFrame(this.pending, this.pendingPrev, frame.image);
          this.pendingPrev = this.pending.image;
        }
        this.pending = frame;
        if (this.stop) {
          this.pending = undefined;
          break;
        }
      }
    } finally {
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
      this.ctx.releaseResidentRenderState(this.compositor);
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
          await this.metaCache.flush();
        }
      } catch (error) {
        this.storageFailed = true;
        this.ctx.partial = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', this.ctx.project.renderedFrames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
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
    await this.setup();
    await this.run();
    await this.finish();
  }
}
export async function render(ctx: RunContext): Promise<void> {
  // Phase/status/persist happen BEFORE the pass is constructed: if persist() fails here, nothing (compositor,
  // frame ring, resident mask) has been allocated yet for RenderPass's own finally to free — Engine's own
  // cleanup is enough, exactly as it was before this pass had a constructor at all.
  ctx.phase = 'rendering';
  ctx.project.status = 'rendering';
  await ctx.persist();
  await new RenderPass(ctx).execute();
}
