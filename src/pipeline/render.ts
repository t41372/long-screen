// Shell around the render pass: placement resolution, fixed-region duplicate paint detection, consistency mask
// consultation and compositing, observation ledger, periodic flush of tiles/metas/diagnostics. The one-frame
// lookahead loop mirrors scan()'s and solve()'s decode-loop shape but is NOT the same skeleton: on a decode
// failure or natural end it composites the already-buffered frame (with no successor) BEFORE reporting or
// breaking, an ordering specific to this pass's lookahead and preserved exactly here.
import type { Attachment, CanvasMeta, FrameImage, FramePlan, Placement, RGBA } from '../types.ts';
import { iterate } from '../storage/db.ts';
import { PoseGraph } from '../core/pose-graph.ts';
import { Compositor } from '../core/compositor.ts';
import { pad } from '../core/math.ts';
import { core, type Resident } from '../core/wasm.ts';
import { attachedRenderShift, resolveTarget as resolveAttachmentTarget } from './attachments.ts';
import { consistencyMask, type ConsistencyRecord } from './consistency.ts';
import { prefixOnly, type RunContext, StorageError } from './context.ts';
export async function render(ctx: RunContext): Promise<void> {
  ctx.phase = 'rendering';
  ctx.project.status = 'rendering';
  await ctx.persist();
  const graph = new PoseGraph(ctx.store),
    compositor = new Compositor(
      ctx.store,
      ctx.tiles,
      ctx.project.settings.temporalPolicy,
      (d) => ctx.diagnostics.emit(d),
      ctx.atlas!,
    );
  const regionMap = new Map(ctx.regions.map((r) => [r.id, r])), attachments = new Map<string, Attachment>();
  for await (const { value } of iterate<Attachment>(ctx.store, 'attach/')) {
    attachments.set(value.id, value);
  }
  // Core-resident render state: each decoded native frame enters core memory once (three slots: previous,
  // current, lookahead), and the consistency mask is produced and consumed inside the core. Freed in this pass's
  // finally; run()'s finally covers abnormal exits. The atlas label plane is NOT allocated here — it is
  // `ctx.atlas!.resident`, already core-resident since scan() built the atlas, borrowed (not uploaded) below and
  // released once with the atlas itself, in run()'s finally.
  const { width: frameW, height: frameH } = ctx.source.info;
  const frames = ctx.frames = core().frameRing(3, frameW, frameH);
  const residentLabels = ctx.atlas!.resident;
  const residentMask = ctx.residentMask = core().alloc(frameW * frameH);
  const fixedPixels = ctx.fixedPixels, previousPlacements = new Map<string, Placement>();
  const fixedBytes = ctx.regions.filter((r) => r.kind === 'fixed').reduce(
    (n, r) => n + Math.ceil(r.rect.width) * Math.ceil(r.rect.height) * 4,
    0,
  );
  // Render buffers one extra decoded native RGBA frame (the one-frame lookahead consistencyMask() compares
  // against, see docs/ARCHITECTURE.md §七), so the working-memory reservation grows by one more native frame.
  ctx.tiles.configureBudget(
    ctx.project.settings.memoryMB,
    ctx.source.info.width * ctx.source.info.height * 5 + fixedBytes + 8 * 1024 * 1024 +
      ctx.source.info.width * ctx.source.info.height * 4,
  );
  const raisedTiles = ctx.tiles.ensureFootprint(ctx.source.info.width, ctx.source.info.height);
  if (raisedTiles) {
    await ctx.diagnostics.emit({
      code: 'MEMORY_BUDGET_RAISED',
      severity: 'info',
      message: `瓦片缓存从预算允许的 ${ctx.tiles.maxTiles - raisedTiles} 块提高到 ${ctx.tiles.maxTiles} 块（约 ${
        Math.round(ctx.tiles.maxTiles * ctx.tiles.size * ctx.tiles.size * 4.3 / 1024 / 1024)
      } MB），以容纳一帧触及的全部瓦片。`,
      action: '小于单帧覆盖范围的缓存会让每一帧都完整地重新解码与编码所有瓦片；如需更低内存，请降低录屏分辨率。',
      detail: { budgetMB: ctx.project.settings.memoryMB, tiles: ctx.tiles.maxTiles, raisedBy: raisedTiles },
    });
  }
  // Resolves a raw (odometry-space) Placement into its final render-time pose and canvas: pose-graph
  // correction, attachment-shift, and the attachment chain walk. Shared by the current frame's own placements
  // and by the one-frame-lookahead neighbour placements consistencyMask() compares against — both need
  // exactly the resolution render() already does today, just at a different frame index.
  const resolvePlacement = async (raw: Placement, frameIndex: number): Promise<{ x: number; y: number; canvasId: string }> => {
    const correction = await graph.correction(raw.node, frameIndex),
      shift = await attachedRenderShift(attachments, graph, raw.canvasId),
      canvasId = resolveAttachmentTarget(attachments, raw.canvasId);
    // Keep the optimized pose in the graph/render ledger. Compositor and consistencyMask() each resolve
    // this same floating-point pose independently, matching the raster coordinates without discarding subpixel
    // diagnostics or making a rounded placement part of the render-time state.
    return { x: raw.x + correction.x + shift.x, y: raw.y + correction.y + shift.y, canvasId };
  };
  // Rolling window over solve()'s per-frame voting verdicts. Each rendered frame needs its own record plus
  // its two ±1 neighbours', and consecutive frames overlap by two, so a four-slot window turns three reads
  // per frame into one. A missing record (the common case for a frame no region had anything to say about)
  // is cached as `undefined` just like a present one, so it is not re-read either.
  const votingWindow: { index: number; record: ConsistencyRecord | undefined }[] = [];
  const votingFor = async (index: number): Promise<ConsistencyRecord | undefined> => {
    const hit = votingWindow.find((e) => e.index === index);
    if (hit) {
      return hit.record;
    }
    const record = index < 0 ? undefined : await ctx.store.get<ConsistencyRecord>(`consistency/${pad(index)}`);
    votingWindow.push({ index, record });
    if (votingWindow.length > 4) {
      votingWindow.shift();
    }
    return record;
  };
  // CanvasMeta held in RAM for the whole pass instead of `store.put` once per placement per frame: dirtyMetas
  // tracks which ones changed since the last flush, which happens alongside the existing ~1.2s tile flush (and
  // in the finally below), not on every placement. Progress events still carry the live (in-memory) meta, so a
  // caller polling mid-run never sees more than that same ~1.2s of lag.
  const metas = new Map<string, CanvasMeta>(), dirtyMetas = new Set<string>();
  const getMeta = async (canvasId: string): Promise<CanvasMeta | undefined> => {
    let meta = metas.get(canvasId);
    if (meta) return meta;
    meta = await ctx.store.get<CanvasMeta>(`canvas/${canvasId}`);
    if (meta) metas.set(canvasId, meta);
    return meta;
  };
  const flushMetas = async (): Promise<void> => {
    if (!dirtyMetas.size) return;
    const ids = [...dirtyMetas];
    await ctx.storagePutMany(ids.map((id) => ({ key: `canvas/${id}`, value: metas.get(id) })));
    for (const id of ids) dirtyMetas.delete(id);
  };
  // Per-frame observation ledger rows, batched like the scan/plan rows instead of one transaction each.
  const pendingObservations: { key: string; value: unknown }[] = [];
  let lastFlush = performance.now();
  const it = ctx.source.frames();
  let storageFailed = false;
  let endedNaturally = false;
  let missingPlan: number | undefined;
  // `stop` is set by processFrame() once a stop request was honoured or the solved prefix has been fully
  // rendered, so the outer loop below can break WITHOUT decoding one further (wasted) lookahead frame first.
  let stop = false;
  // One-frame lookahead: `pending` is the most recently decoded frame not yet composited, held back so
  // consistencyMask() can compare its content against BOTH the frame before it (`pendingPrev`, already
  // decoded) and the frame after it (decoded one step ahead of compositing — see the loop below). The last
  // buffered frame is flushed with no successor once decoding ends (see memory-stats.json for the extra
  // native RGBA frame this holds).
  let pending: FrameImage | undefined, pendingPrev: RGBA | undefined;
  const processFrame = async (frame: FrameImage, prevImage: RGBA | undefined, nextImage: RGBA | undefined): Promise<void> => {
    try {
      const plan = await ctx.store.get<FramePlan>(`plan/${pad(frame.index)}`);
      if (!plan) {
        ctx.partial = true;
        missingPlan = frame.index;
        await ctx.diagnostics.emit({
          code: 'MISSING_PLAN',
          severity: 'error',
          frame: frame.index,
          message: `渲染阶段缺少 plan/${pad(frame.index)}；已停止在已提交的渲染前缀。`,
          action: '检查本地存储完整性；缺失的求解计划不会被静默当作空观察。',
          detail: { pass: 'render', frame: frame.index },
        });
        stop = true;
        return;
      }
      const image = frame.image;
      const prevPlan = prevImage ? await ctx.store.get<FramePlan>(`plan/${pad(frame.index - 1)}`) : undefined;
      const nextPlan = nextImage ? await ctx.store.get<FramePlan>(`plan/${pad(frame.index + 1)}`) : undefined;
      // solve()'s displacement-spread voting verdicts for this frame AND for the two frames the ±1-frame
      // check compares it against: consistencyMask() asks a disagreeing neighbour whether voting found IT
      // clean at that world position before letting it condemn this frame (see its truth table). Reads go
      // through votingFor, which keeps the last few frames' records so the three lookups per frame cost one
      // store read per frame, not three.
      const votingRecord = await votingFor(frame.index),
        prevVoting = prevImage ? await votingFor(frame.index - 1) : undefined,
        nextVoting = nextImage ? await votingFor(frame.index + 1) : undefined;
      let latest: CanvasMeta | undefined;
      const decisions = [];
      for (const placement of plan.placements) {
        if (placement.skip) {
          decisions.push({
            canvasId: placement.canvasId,
            placement,
            addedPixels: 0,
            conflictPixels: 0,
            uncertainPixels: 0,
            skipped: true,
          });
          continue;
        }
        const resolved = await resolvePlacement(placement, frame.index);
        const p = { ...placement, ...resolved };
        const meta = await getMeta(p.canvasId);
        if (!meta) {
          throw new Error('Canvas metadata is missing.');
        }
        const region = regionMap.get(p.layer)!;
        const last = previousPlacements.get(p.layer);
        let unchanged = !!plan.duplicate && !!last && last.canvasId === p.canvasId && last.x === p.x && last.y === p.y;
        if (region.kind === 'fixed' && !unchanged) {
          // The saved copy lives in the core; pixels the region does not own are never compared or written.
          const rect = region.rect, rw = Math.ceil(rect.width), rh = Math.ceil(rect.height), code = ctx.atlas!.code(region);
          const old = fixedPixels.get(region.id), saved = old || core().alloc(rw * rh * 4);
          fixedPixels.set(region.id, saved);
          const changed = core().fixedUpdate(
            saved,
            frames.upload(frame.index, image),
            residentLabels,
            Math.floor(rect.x),
            Math.floor(rect.y),
            rw,
            rh,
            code,
          );
          unchanged = !!old && !changed;
        }
        previousPlacements.set(p.layer, p);
        if (unchanged) {
          ctx.skippedPaints++;
          meta.lastTime = p.time;
          dirtyMetas.add(p.canvasId);
          latest = region.kind === 'moving' ? meta : latest;
          decisions.push({
            canvasId: p.canvasId,
            placement: p,
            addedPixels: 0,
            conflictPixels: 0,
            uncertainPixels: 0,
            reusedExactObservation: true,
          });
          continue;
        }
        // World-consistency mask (docs/ARCHITECTURE.md §七), fixed regions and duplicate-shortcut placements
        // excepted (see consistencyMask's doc comment): a screen-fixed overlay occupies a different world
        // position every frame, so it never agrees with a neighbour sampled at the SAME world position and
        // ends up provisional instead of burned permanently into the canvas.
        let consistent: Uint8Array | Resident | undefined;
        const current = frames.upload(frame.index, image);
        if (region.kind === 'moving') {
          const code = ctx.atlas!.code(region);
          const prevRaw = prevImage ? prevPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
          const nextRaw = nextImage ? nextPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
          const prevResolved = prevRaw ? await resolvePlacement(prevRaw, frame.index - 1) : undefined;
          const nextResolved = nextRaw ? await resolvePlacement(nextRaw, frame.index + 1) : undefined;
          consistent = consistencyMask(
            current,
            residentLabels,
            region,
            code,
            p,
            p.canvasId,
            {
              prev: prevResolved
                ? {
                  image: frames.upload(frame.index - 1, prevImage!),
                  ...prevResolved,
                  occlusions: prevRaw?.occlusions,
                  voting: prevVoting?.[region.id],
                }
                : undefined,
              next: nextResolved
                ? {
                  image: frames.upload(frame.index + 1, nextImage!),
                  ...nextResolved,
                  occlusions: nextRaw?.occlusions,
                  voting: nextVoting?.[region.id],
                }
                : undefined,
              voting: votingRecord?.[region.id],
              factor: ctx.factor,
              noise: ctx.noise,
              output: residentMask,
            },
          );
        }
        const stats = await compositor.add(image, region, p, frame.index, meta, consistent, current);
        ctx.project.tiles += stats.tiles;
        ctx.project.observedPixels += stats.added;
        dirtyMetas.add(p.canvasId);
        latest = region.kind === 'moving' ? meta : latest;
        decisions.push({
          canvasId: p.canvasId,
          placement: p,
          addedPixels: stats.added,
          conflictPixels: stats.conflicts,
          uncertainPixels: stats.uncertain,
        });
      }
      // Every decoded observation has a durable placement and a pixel contribution ledger.
      pendingObservations.push({ key: `observation/${pad(frame.index)}`, value: { frame: frame.index, time: frame.time, decisions } });
      if (pendingObservations.length >= 32) {
        await ctx.commitRows(pendingObservations);
      }
      ctx.project.renderedFrames = frame.index + 1;
      if (performance.now() - lastFlush >= 1200) {
        // Only tiles untouched since the previous checkpoint: the active footprint is repainted every frame
        // and would otherwise be re-encoded on every checkpoint; it is written when it leaves the footprint.
        const settledBefore = lastFlush;
        lastFlush = performance.now();
        await ctx.tiles.flush(settledBefore);
        await compositor.flush();
        await ctx.diagnostics.flush();
        await flushMetas();
        if (pendingObservations.length) {
          await ctx.commitRows(pendingObservations);
        }
      }
      await ctx.report(
        frame.index + 1,
        frame.time,
        '按观察证据合成原尺寸瓦片；缺口保持透明。',
        (frame.index + 1) / Math.max(1, ctx.processed),
        latest,
      );
      if (ctx.stopRequested) {
        ctx.honourStop();
        stop = true;
        return;
      }
      if (frame.index + 1 >= ctx.processed) {
        stop = true;
      }
    } catch (error) {
      if (!ctx.project.renderedFrames) {
        throw error;
      }
      ctx.partial = true;
      if (error instanceof StorageError) {
        storageFailed = true;
        try {
          await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        stop = true;
        return;
      }
      await ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
      stop = true;
    }
  };
  try {
    while (true) {
      await ctx.checkpoint();
      let step: Awaited<ReturnType<typeof it.next>>;
      try {
        step = await it.next();
      } catch (error) {
        // Decode failed while looking one frame ahead (or on the very first frame). Composite whatever is
        // already buffered as the final frame (no successor) BEFORE reporting/breaking, so a lookahead-only
        // decode failure never drops an already-decoded, not-yet-composited frame.
        if (pending) {
          await processFrame(pending, pendingPrev, undefined);
        }
        pending = undefined;
        if (!ctx.project.renderedFrames) {
          throw error;
        }
        ctx.partial = true;
        await ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
        break;
      }
      if (step.done) {
        endedNaturally = true;
        if (pending) {
          await processFrame(pending, pendingPrev, undefined);
        }
        pending = undefined;
        break;
      }
      const frame = step.value;
      if (pending) {
        await processFrame(pending, pendingPrev, frame.image);
        pendingPrev = pending.image;
      }
      pending = frame;
      if (stop) {
        pending = undefined;
        break;
      }
    }
  } finally {
    try {
      await it.return(undefined);
    } catch { /* already unwinding */ }
    ctx.releaseResidentRenderState(compositor);
    // Best-effort: committed tiles and in-memory metas should not be stranded even when the loop exited through
    // a storage failure; a repeat failure here is swallowed rather than masking the original error.
    try {
      if (pendingObservations.length && !storageFailed) await ctx.commitRows(pendingObservations);
    } catch (error) {
      storageFailed = true;
      ctx.partial = true;
      try {
        await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
      } catch { /* the journal write itself failed too; the run is already marked partial. */ }
    }
    try {
      if (!storageFailed) {
        await compositor.flush();
        await flushMetas();
      }
    } catch (error) {
      storageFailed = true;
      ctx.partial = true;
      try {
        await ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'render', ctx.project.renderedFrames, error));
      } catch { /* the journal write itself failed too; the run is already marked partial. */ }
    }
  }
  if ((endedNaturally || missingPlan !== undefined) && ctx.project.renderedFrames !== ctx.processed) {
    await ctx.passMismatch('render', ctx.processed, ctx.project.renderedFrames);
  }
  await ctx.tiles.flush();
  await ctx.diagnostics.flush();
  await ctx.store.put('memory-stats', {
    peakResidentTiles: ctx.tiles.peakResidentTiles,
    tileCacheLimit: ctx.tiles.maxTiles,
    budgetMB: ctx.project.settings.memoryMB,
    note:
      'Codec/browser/GPU allocations are additional, not a hard process-RSS bound. The render pass also holds one extra decoded native RGBA frame: a one-frame lookahead the world-consistency mask compares against (docs/ARCHITECTURE.md §七).',
  });
  await ctx.persist();
}
