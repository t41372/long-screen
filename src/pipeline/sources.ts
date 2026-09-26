/** Deferred source-resolution shell: one ordered replay, bounded native candidate lifetimes, KV pages,
 * and tile commits. Motion, visibility, source ranking, components and epochs live in rust/core/sources. */
import { core, type SourceBlockSummary, type SourceObjectState, type SourceRoles, type SourceTracker } from '../core/wasm.ts';
import { iterate, type KV, type Row } from '../storage/db.ts';
import { sourceKey, sourcePages, SourceStore, type SourceTileAddress, type StoredSourceTile } from '../storage/sources.ts';
import type { StoredTile, TileIndex } from '../storage/tiles.ts';
import type { CanvasMeta, Placement } from '../types.ts';
import { pad } from '../core/math.ts';
import { releaseUnlessHeld } from '../media/pool.ts';
import { type RunContext, StorageError } from './context.ts';
import { t } from '../i18n/index.ts';
import { SourceStorage, SourceWrites } from './source-storage.ts';
import { type OptionsPage, SourceEpochs } from './source-epochs.ts';
import { type OpacityStats, refineSourceOpacity } from './source-opacity.ts';

// Candidate shards are independent of PNG tile size; a 4096px output tile must not force all its
// histories into RAM at once. 256px holds at most 256 sparse blocks, each with four active sources.
const SOURCE_SIZE = 256;
interface Index extends SourceTileAddress {
  disputes: Uint8Array;
}
interface Ledger {
  frame: number;
  time: number;
  decisions: { canvasId: string; placement: Placement; skipped?: boolean }[];
}
export interface SourceSummary {
  version: 1;
  completed: boolean;
  stage: 'collecting' | 'analyzing' | 'applying' | 'complete' | 'interrupted';
  failure?: string;
  appliedChunks: number;
  scratchRowsRemoved: number;
  opacity: OpacityStats;
  timings: Record<string, number>;
  replayPasses: number;
  frames: number;
  shards: number;
  candidates: number;
  resolvedBlocks: number;
  changedPixels: number;
  reasons: number[];
  components: number;
  partialComponents: number;
  objectOverflowFrames: number;
  peakResidentBytes: number;
  largestShardBytes: number;
  peakEvidenceCacheBytes: number;
  archivePages: number;
  archiveBytes: number;
  stateWrites: number;
}

class DeferredSources {
  readonly summary: SourceSummary = {
    version: 1,
    completed: false,
    stage: 'collecting',
    appliedChunks: 0,
    scratchRowsRemoved: 0,
    timings: {},
    opacity: {
      fields: 0,
      pixels: 0,
      classified: 0,
      bytes: 0,
      peakCoreBytes: 0,
      peakModelBytes: 0,
      modelWrites: 0,
      peakFitBytes: 0,
      visibilityConflicts: 0,
    },
    replayPasses: 0,
    frames: 0,
    shards: 0,
    candidates: 0,
    resolvedBlocks: 0,
    changedPixels: 0,
    reasons: [0, 0, 0, 0, 0, 0, 0],
    components: 0,
    partialComponents: 0,
    objectOverflowFrames: 0,
    peakResidentBytes: 0,
    largestShardBytes: 0,
    peakEvidenceCacheBytes: 0,
    archivePages: 0,
    archiveBytes: 0,
    stateWrites: 0,
  };
  private indexes = new Map<string, Map<string, Index>>();
  private trackers = new Map<string, SourceTracker>();
  private objects = new Map<number, Uint8Array[]>();
  private objectCache = new Map<number, Uint8Array[]>();
  private objectCacheBytes = 0;
  private states = new Map<string, SourceObjectState>();
  private previousPlacements = new Map<string, Placement>();
  private sourceStore: SourceStore;
  private store: KV;
  constructor(private ctx: RunContext) {
    this.store = new SourceStorage(ctx.store);
    // Replay clears the output tile cache before capture. Give candidates the same phase-local
    // share as opacity learning; the old 45% share caused a viewport-sized LRU cycle on f.mov.
    // Frame buffers, trackers, and serialization scratch remain additional allocations.
    this.sourceStore = new SourceStore(
      this.store,
      SOURCE_SIZE,
      ctx.noise,
      Math.max(2, Math.min(96, ctx.project.settings.memoryMB * .70)) * 1024 * 1024,
    );
  }
  private async checkpoint(): Promise<boolean> {
    await this.ctx.checkpoint();
    if (this.ctx.stopRequested) {
      this.ctx.honourStop();
      return false;
    }
    return !this.ctx.stopped;
  }
  private addIndex(canvasId: string, shard: { x: number; y: number; disputes: Uint8Array }): void {
    let canvas = this.indexes.get(canvasId);
    if (!canvas) {
      canvas = new Map();
      this.indexes.set(canvasId, canvas);
    }
    const key = `${shard.x}_${shard.y}`, old = canvas.get(key);
    if (old) { for (let i = 0; i < shard.disputes.length; i++) old.disputes[i] |= shard.disputes[i]; }
    else canvas.set(key, { ...shard, canvasId });
  }
  async index(): Promise<void> {
    const { ctx } = this;
    const coveredShards = new Set<string>();
    for await (const { value: index } of iterate<TileIndex>(this.store, 'tile-index/')) {
      if (index.level !== 0) continue;
      for (
        let y = Math.floor(index.y * ctx.tiles.size / SOURCE_SIZE);
        y <= Math.floor(((index.y + 1) * ctx.tiles.size - 1) / SOURCE_SIZE);
        y++
      ) {
        for (
          let x = Math.floor(index.x * ctx.tiles.size / SOURCE_SIZE);
          x <= Math.floor(((index.x + 1) * ctx.tiles.size - 1) / SOURCE_SIZE);
          x++
        ) {
          coveredShards.add(`${index.canvasId}/${x}_${y}`);
        }
      }
      const tile = await this.store.get<StoredTile>(`tile/${index.canvasId}/0/${index.x}_${index.y}`);
      if (!tile?.disputes?.some(Boolean)) continue;
      for (const shard of core().sourceShards(ctx.tiles.size, index.x, index.y, SOURCE_SIZE, tile.disputes)) {
        this.addIndex(index.canvasId, shard);
      }
    }
    const parents = ctx.project.settings.regions?.length
      ? undefined
      : core().sourceParentLabels(ctx.atlas!.resident, ctx.regions, (r) => ctx.atlas!.code(r));
    if (parents) {
      try {
        const poses = new Map<string, { code: number; poses: [number, number][] }>();
        for await (const { value: ledger } of iterate<Ledger>(this.store, 'observation/')) {
          for (const d of ledger.decisions) {
            if (d.skipped || d.placement.skip) continue;
            const region = ctx.regions.find((r) => r.id === d.placement.layer);
            if (region?.kind !== 'moving') continue;
            let group = poses.get(d.canvasId);
            if (!group) {
              group = { code: ctx.atlas!.code(region), poses: [] };
              poses.set(d.canvasId, group);
            }
            group.poses.push([Math.round(d.placement.x), Math.round(d.placement.y)]);
          }
        }
        for (const [canvasId, group] of poses) {
          for (
            const shard of core().sourceOwnershipShards(ctx.atlas!.resident, parents, {
              width: ctx.source.info.width,
              height: ctx.source.info.height,
              side: SOURCE_SIZE,
              ...group,
            })
          ) {
            if (coveredShards.has(`${canvasId}/${shard.x}_${shard.y}`)) this.addIndex(canvasId, shard);
          }
        }
      } finally {
        parents.free();
      }
    }
    this.summary.shards = [...this.indexes.values()].reduce((n, m) => n + m.size, 0);
  }
  private async flushObjects(before: number): Promise<void> {
    const rows: Row[] = [];
    for (const [frame, objects] of this.objects) {
      if (frame >= before) continue;
      rows.push({ key: `source-objects/${pad(frame)}`, value: objects });
      this.objects.delete(frame);
    }
    if (rows.length) await this.store.putMany(rows);
  }
  private recordObjects(update: import('../core/wasm.ts').SourceObjectUpdate): void {
    if (update.overflow) this.summary.objectOverflowFrames++;
    for (const chunk of update.evidence) {
      const bucket = this.objects.get(chunk.frame) ?? [];
      bucket.push(chunk.data);
      this.objects.set(chunk.frame, bucket);
    }
    for (const state of update.states) this.states.set([state.region, state.id, state.first].join('/'), state);
  }
  async replay(): Promise<void> {
    // Reassign the render cache's budget to sparse candidates; retaining both causes an LRU miss
    // cycle across every native viewport, repeatedly compressing/reloading the same four sources.
    await this.ctx.tiles.clear();
    const { ctx } = this, { width, height } = ctx.source.info;
    const frames = core().frameRing(2, width, height), mask = core().alloc(width * height);
    this.summary.replayPasses++;
    const parentLabels = ctx.project.settings.regions?.length
      ? undefined
      : core().sourceParentLabels(ctx.atlas!.resident, ctx.regions, (r) => ctx.atlas!.code(r));
    const contextMask = parentLabels ? core().alloc(width * height) : undefined;
    let sourceState = 0;
    try {
      for await (const frame of ctx.source.frames()) {
        try {
          if (frame.index >= ctx.project.renderedFrames || !await this.checkpoint()) break;
          const ledger = await this.store.get<Ledger>(`observation/${pad(frame.index)}`);
          if (!ledger) throw new Error(`Missing canonical observation for source frame ${frame.index}.`);
          const current = frames.upload(frame.index, frame.image), priorFrame = frames.get(frame.index - 1);
          if (!priorFrame || !core().sourceSameFrame(current, priorFrame)) sourceState = frame.index;
          for (const decision of ledger.decisions) {
            if (decision.skipped || decision.placement.skip) continue;
            const p = decision.placement, shards = this.indexes.get(decision.canvasId);
            if (!shards) continue;
            const region = ctx.regions.find((r) => r.id === p.layer);
            if (!region) continue;
            let tracker = this.trackers.get(p.layer);
            if (!tracker) {
              tracker = core().sourceTracker();
              this.trackers.set(p.layer, tracker);
            }
            const previous = this.previousPlacements.get(p.layer);
            const labels = region.kind === 'moving' ? parentLabels ?? ctx.atlas!.resident : ctx.atlas!.resident;
            const update = tracker.observe(
              current,
              previous?.canvasId === p.canvasId ? frames.get(frame.index - 1) : undefined,
              ctx.atlas!.resident,
              mask,
              {
                frame: frame.index,
                code: ctx.atlas!.code(region),
                poseX: p.x,
                poseY: p.y,
                previousX: previous?.x ?? p.x,
                previousY: previous?.y ?? p.y,
                noise: ctx.noise,
              },
            );
            this.previousPlacements.set(p.layer, p);
            this.recordObjects(update);
            if (parentLabels && contextMask && region.kind === 'moving') {
              const key = 'context:' + p.layer;
              let contextTracker = this.trackers.get(key);
              if (!contextTracker) {
                contextTracker = core().sourceTracker();
                this.trackers.set(key, contextTracker);
              }
              this.recordObjects(
                contextTracker.observe(
                  current,
                  previous?.canvasId === p.canvasId ? frames.get(frame.index - 1) : undefined,
                  parentLabels,
                  contextMask,
                  {
                    auxiliary: true,
                    ownership: ctx.atlas!.resident,
                    frame: frame.index,
                    code: ctx.atlas!.code(region),
                    poseX: p.x,
                    poseY: p.y,
                    previousX: previous?.x ?? p.x,
                    previousY: previous?.y ?? p.y,
                    noise: ctx.noise,
                  },
                ),
              );
            }
            // Address traversal is storage scheduling; native capture checks exact atlas membership and pose.
            for (
              let y = Math.floor((region.rect.y + p.y) / SOURCE_SIZE);
              y <= Math.floor((region.rect.y + region.rect.height - 1 + p.y) / SOURCE_SIZE);
              y++
            ) {
              for (
                let x = Math.floor((region.rect.x + p.x) / SOURCE_SIZE);
                x <= Math.floor((region.rect.x + region.rect.width - 1 + p.x) / SOURCE_SIZE);
                x++
              ) {
                const shard = shards.get(`${x}_${y}`);
                if (!shard) continue;
                await this.sourceStore.capture(
                  shard,
                  shard.disputes,
                  current,
                  labels,
                  mask,
                  {
                    frame: frame.index,
                    state: sourceState,
                    occlusions: p.occlusions,
                    time: frame.time,
                    poseX: p.x,
                    poseY: p.y,
                    code: ctx.atlas!.code(region),
                    quality: Math.round(p.confidence * 100),
                  },
                  labels === parentLabels ? ctx.atlas!.resident : undefined,
                  labels === parentLabels ? contextMask : undefined,
                );
              }
            }
          }
          this.summary.frames++;
          if (frame.index % 16 === 0) await this.flushObjects(frame.index - 1);
          await ctx.report(frame.index, frame.time, t('progress.resolveSources'));
        } finally {
          releaseUnlessHeld(frame.image);
        }
      }
      await this.flushObjects(Infinity);
      await this.store.putMany([...this.states].map(([key, value]) => ({ key: `source-object-state/${key}`, value })));
      await this.sourceStore.flush();
      Object.assign(this.summary, {
        peakResidentBytes: this.sourceStore.peakResidentBytes,
        largestShardBytes: this.sourceStore.largestTileBytes,
        archivePages: this.sourceStore.archivePages,
        archiveBytes: this.sourceStore.archiveBytes,
        stateWrites: this.sourceStore.stateWrites,
      });
      if (!ctx.stopped && this.summary.frames !== ctx.project.renderedFrames) {
        throw new Error('Source replay ended before the committed render prefix.');
      }
    } finally {
      frames.free();
      mask.free();
      parentLabels?.free();
      contextMask?.free();
      this.sourceStore.free();
      for (const tracker of this.trackers.values()) tracker.free();
      this.trackers.clear();
    }
  }
  private async frameObjects(frame: number): Promise<Uint8Array[]> {
    const old = this.objectCache.get(frame);
    if (old) {
      this.objectCache.delete(frame);
      this.objectCache.set(frame, old);
      return old;
    }
    const objects = await this.store.get<Uint8Array[]>(`source-objects/${pad(frame)}`) ?? [];
    const bytes = objects.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    while (this.objectCache.size && (this.objectCacheBytes + bytes > 8 * 1024 * 1024 || this.objectCache.size >= 96)) {
      const first = this.objectCache.keys().next().value!;
      this.objectCacheBytes -= this.objectCache.get(first)!.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      this.objectCache.delete(first);
    }
    this.objectCache.set(frame, objects);
    this.objectCacheBytes += bytes;
    this.summary.peakEvidenceCacheBytes = Math.max(this.summary.peakEvidenceCacheBytes, this.objectCacheBytes);
    return objects;
  }
  private pages(row: StoredSourceTile) {
    return sourcePages(this.store, row);
  }
  private async evidence(data: Uint8Array, page: number, states: SourceRoles) {
    const chunks: Uint8Array[] = [];
    for (const frame of core().sourceArchiveFrames(data, page)) {
      chunks.push(...await this.frameObjects(frame));
    }
    return core().sourceEvidence(chunks, states);
  }
  async analyze(): Promise<void> {
    const { ctx } = this;
    for (const [canvasId] of this.indexes) {
      const scene = core().sourceScene();
      // Object identities live in native screen coordinates. A pointer can cross a pane boundary;
      // each candidate still uses its own pane's canonical pose and atlas membership.
      const canvas = await this.store.get<CanvasMeta>('canvas/' + canvasId);
      const region = ctx.regions.find((r) => r.id === canvas?.layer);
      const states = core().sourceRoles([...this.states.values()], region ? ctx.atlas!.code(region) : 0);
      try {
        for await (const { value: row } of iterate<StoredSourceTile>(this.store, `source-state/${canvasId}/`)) {
          if (!await this.checkpoint()) return;
          const analysis = core().sourceAnalysis(SOURCE_SIZE, row.x, row.y, ctx.noise), key = sourceKey(row);
          const writes = new SourceWrites(this.store);
          try {
            for (
              let y = Math.floor(row.y * SOURCE_SIZE / ctx.tiles.size);
              y <= Math.floor(((row.y + 1) * SOURCE_SIZE - 1) / ctx.tiles.size);
              y++
            ) {
              for (
                let x = Math.floor(row.x * SOURCE_SIZE / ctx.tiles.size);
                x <= Math.floor(((row.x + 1) * SOURCE_SIZE - 1) / ctx.tiles.size);
                x++
              ) {
                analysis.baseline(row.state, await ctx.tiles.get(canvasId, x, y), ctx.tiles.size);
              }
            }
            for await (const page of this.pages(row)) {
              const evidence = await this.evidence(page.data, page.page, states);
              let data: Uint8Array;
              try {
                data = analysis.annotate(page.data, page.page, SOURCE_SIZE, row.x, row.y, evidence);
              } finally {
                evidence.free();
              }
              const options = analysis.options();
              await writes.add([
                { key: page.key, value: page.page < 0 ? { ...row, state: data } : data },
                {
                  key: `source-options/${key}/${page.page < 0 ? 'state' : pad(page.page)}`,
                  value: { page: page.page, data: options } satisfies OptionsPage,
                },
              ], data.byteLength + options.byteLength);
            }
            await writes.flush();
            const summary = analysis.summary();
            await this.store.put(`source-analysis/${key}`, analysis.state());
            await this.store.put(`source-blocks/${key}`, summary);
          } finally {
            analysis.free();
          }
        }
        // Baseline pixels are now in the native analysis archives. Reuse the tile cache's budget
        // for model learning instead of retaining decoded output tiles that this phase never reads.
        await ctx.tiles.clear();
        const opacity = await refineSourceOpacity(
          ctx,
          canvasId,
          SOURCE_SIZE,
          (data, page) => this.evidence(data, page, states),
          this.store,
        );
        this.summary.opacity.fields += opacity.fields;
        this.summary.opacity.pixels += opacity.pixels;
        this.summary.opacity.classified += opacity.classified;
        this.summary.opacity.bytes += opacity.bytes;
        this.summary.opacity.peakCoreBytes = Math.max(this.summary.opacity.peakCoreBytes, opacity.peakCoreBytes);
        this.summary.opacity.peakModelBytes = Math.max(this.summary.opacity.peakModelBytes, opacity.peakModelBytes);
        this.summary.opacity.peakFitBytes = Math.max(this.summary.opacity.peakFitBytes, opacity.peakFitBytes);
        this.summary.opacity.modelWrites += opacity.modelWrites;
        this.summary.opacity.visibilityConflicts += opacity.visibilityConflicts;
        if (ctx.stopped) return;
        for await (const { value: row } of iterate<StoredSourceTile>(this.store, `source-state/${canvasId}/`)) {
          const summary = (await this.store.get<SourceBlockSummary[]>(`source-blocks/${sourceKey(row)}`))!;
          this.summary.candidates += summary.reduce((sum, b) => sum + b.candidates, 0);
          this.summary.resolvedBlocks += summary.length;
          scene.add(row.x, row.y, summary);
        }
        const epochs = new SourceEpochs(
          this.store,
          SOURCE_SIZE,
          ctx.noise,
          ctx.project.settings.temporalPolicy === 'latest',
          () => this.checkpoint(),
        );
        await epochs.resolve(canvasId, scene.components());
        this.summary.components += epochs.components;
        this.summary.partialComponents += epochs.partialComponents;
      } finally {
        scene.free();
        states.free();
      }
    }
  }
  async materialize(): Promise<void> {
    const { ctx } = this;
    for (const [canvasId] of this.indexes) {
      const loaded = await this.store.get<CanvasMeta>(`canvas/${canvasId}`);
      if (!loaded) continue;
      let meta: CanvasMeta = loaded;
      for await (const { value: row } of iterate<StoredSourceTile>(this.store, `source-state/${canvasId}/`)) {
        if (!await this.checkpoint()) return;
        const key = sourceKey(row), state = (await this.store.get<Uint8Array>(`source-analysis/${key}`))!;
        const blocks = await this.store.get<SourceBlockSummary[]>(`source-blocks/${key}`) ?? [];
        const analysis = core().sourceAnalysis(SOURCE_SIZE, row.x, row.y, ctx.noise, state);
        try {
          for (
            let y = Math.floor(row.y * SOURCE_SIZE / ctx.tiles.size);
            y <= Math.floor(((row.y + 1) * SOURCE_SIZE - 1) / ctx.tiles.size);
            y++
          ) {
            for (
              let x = Math.floor(row.x * SOURCE_SIZE / ctx.tiles.size);
              x <= Math.floor(((row.x + 1) * SOURCE_SIZE - 1) / ctx.tiles.size);
              x++
            ) {
              if (!await this.checkpoint()) return;
              const included = blocks.filter((b) =>
                Math.floor(b.x * 16 / ctx.tiles.size) === x && Math.floor(b.y * 16 / ctx.tiles.size) === y
              );
              if (!included.length) continue;
              const tile = await ctx.tiles.get(canvasId, x, y), existed = tile.existed, stats = analysis.apply(tile, ctx.tiles.size);
              if (existed || stats.changed || stats.added || stats.provisional) {
                tile.dirty = true;
                tile.touched = performance.now();
              }
              const addedTile = !existed && tile.dirty ? 1 : 0;
              const next: CanvasMeta = {
                ...meta,
                tileCount: meta.tileCount + addedTile,
                observedPixels: meta.observedPixels + stats.added,
                provisionalPixels: meta.provisionalPixels + stats.provisional,
              };
              const provenance = {
                version: 1,
                size: SOURCE_SIZE,
                x: row.x,
                y: row.y,
                canvasId,
                blocks: included.map((b) => {
                  const { frames, reasons } = analysis.block(b.block);
                  return { block: b.block, frames, reasons };
                }),
              };
              try {
                await ctx.tiles.commit(tile, [
                  { key: `source-provenance/${key}/${x}_${y}`, value: provenance },
                  { key: `canvas/${canvasId}`, value: next },
                ]);
              } catch (error) {
                throw new StorageError(error);
              }
              meta = next;
              ctx.project.tiles += addedTile;
              ctx.project.observedPixels += stats.added;
              this.summary.changedPixels += stats.changed;
              this.summary.appliedChunks++;
              stats.reasons.forEach((count, i) => this.summary.reasons[i] += count);
            }
          }
        } finally {
          analysis.free();
        }
        // All physical tile/provenance transactions for this shard succeeded. Keep every raw
        // alternative and final decision, but release the now-recomputable analysis and epoch pages.
        const scratch = [`source-analysis/${key}`, `source-blocks/${key}`, `source-options/${key}/state`];
        for (let page = 0; page < row.pages; page++) scratch.push(`source-options/${key}/${pad(page)}`);
        await this.store.deleteMany(scratch);
        this.summary.scratchRowsRemoved += scratch.length;
      }
    }
  }
  async finish(): Promise<void> {
    const { ctx } = this;
    await this.store.put('source-summary', this.summary);
    if (this.summary.reasons[3] || this.summary.reasons[4] || this.summary.reasons[6]) {
      await ctx.diagnostics.emit({
        code: 'SOURCE_UNRESOLVED',
        severity: 'warning',
        message: t('diag.SOURCE_UNRESOLVED.message', {
          ambiguous: this.summary.reasons[3],
          unverified: this.summary.reasons[4] + this.summary.reasons[6],
        }),
        action: t('diag.SOURCE_UNRESOLVED.action'),
        detail: {
          ambiguous: this.summary.reasons[3],
          noConfirmedCleanSource: this.summary.reasons[4],
          uncertainParent: this.summary.reasons[6],
        },
      });
    }
    if (this.summary.partialComponents) {
      await ctx.diagnostics.emit({
        code: 'SOURCE_DYNAMIC_PARTIAL',
        severity: 'warning',
        message: t('diag.SOURCE_DYNAMIC_PARTIAL.message'),
        action: t('diag.SOURCE_DYNAMIC_PARTIAL.action'),
        detail: { components: this.summary.partialComponents },
      });
    }
    if (this.summary.objectOverflowFrames) {
      await ctx.diagnostics.emit({
        code: 'SOURCE_TRACKING_LIMIT',
        severity: 'warning',
        message: t('diag.SOURCE_TRACKING_LIMIT.message'),
        action: t('diag.SOURCE_TRACKING_LIMIT.action'),
        detail: { frames: this.summary.objectOverflowFrames },
      });
    }
  }
}
export async function resolveSources(ctx: RunContext): Promise<void> {
  if (ctx.stopped || ctx.partial || !ctx.atlas) return;
  const pass = new DeferredSources(ctx);
  const measure = async (name: string, action: () => Promise<void>) => {
    const started = performance.now();
    try {
      await action();
    } finally {
      pass.summary.timings[name] = performance.now() - started;
    }
  };
  await measure('indexMS', () => pass.index());
  if (!pass.summary.shards) return;
  await ctx.store.put('source-summary', pass.summary);
  try {
    await measure('replayMS', () => pass.replay());
    if (!ctx.stopped) {
      pass.summary.stage = 'analyzing';
      await ctx.store.put('source-summary', pass.summary);
      await measure('analysisMS', () => pass.analyze());
      if (!ctx.stopped) {
        pass.summary.stage = 'applying';
        await ctx.store.put('source-summary', pass.summary);
        await measure('materializeMS', () => pass.materialize());
      }
    }
    pass.summary.completed = !ctx.stopped;
    pass.summary.stage = ctx.stopped ? 'interrupted' : 'complete';
    await pass.finish();
  } catch (error) {
    pass.summary.stage = 'interrupted';
    pass.summary.completed = false;
    pass.summary.failure = String(error);
    try {
      await ctx.store.put('source-summary', pass.summary);
    } catch { /* Preserve the original failure and the last committed summary. */ }
    throw error;
  }
}
