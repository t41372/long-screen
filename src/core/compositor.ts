import type { CanvasMeta, Diagnostic, Placement, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import type { TileStore } from '../storage/tiles.ts';
import {
  COMPOSITOR_DISPOSED,
  COMPOSITOR_OUTSIDE_CANVAS,
  type CompositorEvent,
  type CompositorHandle,
  type CompositorStats,
  core,
  type Resident,
  type ResidentFrame,
  type TemporalRow,
} from './wasm.ts';
import type { RegionAtlas } from './layers.ts';
import { union } from './math.ts';
import { t } from '../i18n/index.ts';
/** Persisted row shape (`temporal/<canvasId>/<id>` — frozen; do not change the key layout or field order): a
 *  `TemporalRow` (rust/core/src/temporal.rs's `TemporalRecord`) plus the canvas it belongs to. */
type TemporalRegion = TemporalRow & { canvasId: string };

export type CompositeStats = CompositorStats;

const releaseCompositor = new FinalizationRegistry((engine: CompositorHandle) => engine.free());

/** Pixel ownership, not alpha blending: the engine's compositor (`long_screen_engine::compositor`, docs/ARCHITECTURE.md
 *  §七) paints each placement into the tile cache and resolves temporal conflicts against the per-canvas temporal
 *  records. This wrapper is its host: it brings in the tiles and stored temporal records a placement asks for,
 *  writes the records it changed, and formats the diagnostics it raises. */
export class Compositor {
  /** The engine's compositor; the render session drives it directly. */
  readonly engine: CompositorHandle;
  constructor(
    private db: KV,
    readonly tiles: TileStore,
    private policy: 'stable' | 'latest',
    private emit: (d: Diagnostic) => Promise<void>,
    private atlas: RegionAtlas,
  ) {
    this.engine = core().compositor(policy === 'latest', atlas.width, atlas.height);
    releaseCompositor.register(this, this.engine, this);
  }
  /** Persists temporal records changed since the last flush: per canvas in the order the canvases were first
   *  loaded, every deleted id, then one batch of every changed row. */
  async flush(): Promise<void> {
    for (const { canvas: canvasId, deleted, dirty } of this.engine.flush()) {
      for (const id of deleted) await this.db.delete(`temporal/${canvasId}/${id}`);
      if (dirty.length) {
        await this.db.putMany(dirty.map((row) => ({
          key: `temporal/${canvasId}/${row.id}`,
          // Field order is part of the frozen persisted shape (fingerprint.ts hashes JSON key order, not just
          // content).
          value: {
            id: row.id,
            canvasId,
            rect: row.rect,
            chosenFrame: row.chosenFrame,
            chosenTime: row.chosenTime,
            complete: row.complete,
            revisions: row.revisions,
            blocks: row.blocks,
          } satisfies TemporalRegion,
        })));
      }
    }
  }
  /** Releases every canvas's temporal index, keeping the rows the next `flush()` still owes storage (the render
   *  pass disposes before its final flush). A later `add()` on a disposed canvas throws. */
  dispose(): void {
    this.engine.dispose();
  }
  /** Releases the engine's compositor (the render pass does after its last `flush()`); safe to call again. */
  free(): void {
    releaseCompositor.unregister(this);
    this.engine.free();
  }
  /** Seeds the engine's temporal index of `canvasId` from its stored `temporal/` rows (the engine asked for them). */
  async loadTemporal(canvasId: string): Promise<void> {
    const rows: TemporalRow[] = [];
    for await (const { value } of iterate<TemporalRegion>(this.db, `temporal/${canvasId}/`)) rows.push(value);
    this.engine.loadTemporal(canvasId, rows);
  }
  /** Formats and emits one diagnostic of the engine's for a placement on `canvasId`. */
  async report(e: CompositorEvent, canvasId: string): Promise<void> {
    if (e.kind === 'incomplete') {
      await this.emit({
        code: 'INCOMPLETE_TEMPORAL_PATCH',
        severity: 'warning',
        canvasId,
        frame: e.frame,
        time: e.time,
        region: e.region,
        message: t('diag.INCOMPLETE_TEMPORAL_PATCH.message'),
        action: t('diag.INCOMPLETE_TEMPORAL_PATCH.action'),
      });
    } else {
      // One journal row per frame and canvas, not per component: `region` is the largest component (so "locate"
      // lands on one conflict), `detail.regions` every component, `count` how many; the message gives the
      // conflicting pixels detected before patching.
      await this.emit({
        code: 'TEMPORAL_OR_ALIGNMENT_CONFLICT',
        severity: 'warning',
        time: e.time,
        frame: e.frame,
        canvasId,
        region: e.region,
        confidence: e.confidence,
        count: e.regions.length,
        detail: { regions: e.regions },
        message: t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.message', { conflicts: e.conflicts.toLocaleString() }),
        action: this.policy === 'stable'
          ? t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionStable')
          : t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionRolling'),
      });
    }
  }
  /** `consistent`, when given, is a per-native-pixel (image-sized, one byte per pixel, indexed like `labels`) world-consistency
   *  mask computed by the render pass's one-frame lookahead: 0 means this pixel's placement here could be checked against a
   *  neighbouring frame and disagreed with every such check (CONSISTENT-BY-DEFAULT and genuinely-consistent pixels are both
   *  1). Omitted for fixed regions and skipped/duplicate frames, where every pixel is treated as consistent. See
   *  docs/ARCHITECTURE.md §七. `residentFrame`, when given, is `image` already in core memory, so the frame is not
   *  copied again for compositing. */
  async add(
    image: RGBA,
    region: Region,
    p: Placement,
    frame: number,
    meta: CanvasMeta,
    consistent?: Uint8Array | Resident,
    residentFrame?: ResidentFrame,
  ): Promise<CompositeStats> {
    if (image.width !== this.atlas.width || image.height !== this.atlas.height) {
      throw new Error(`Frame is ${image.width}×${image.height} but the region atlas is ${this.atlas.width}×${this.atlas.height}.`);
    }
    if (residentFrame && (residentFrame.width !== image.width || residentFrame.height !== image.height)) {
      throw new Error('Resident frame does not match the observation.');
    }
    const code = this.atlas.code(region);
    const status = this.engine.begin(this.tiles.engine, {
      canvas: p.canvasId,
      region: region.rect,
      code,
      ownedPixels: this.atlas.count(code),
      x: p.x,
      y: p.y,
      frame,
      time: p.time,
      confidence: p.confidence,
      uncertain: !!p.uncertain,
      occlusions: p.occlusions,
    }, { image: residentFrame ?? image, labels: this.atlas.resident, consistent });
    // Defense in depth, not the graceful path (that is the render session's own pose check before it gets here).
    if (status === COMPOSITOR_OUTSIDE_CANVAS) {
      throw new Error(`Placement (${p.x}, ${p.y}) puts region ${region.id} outside the addressable canvas.`);
    }
    let stats: CompositeStats, events;
    try {
      for (;;) {
        const step = this.engine.step(this.tiles.engine, performance.now());
        if (step === COMPOSITOR_DISPOSED) {
          throw new Error(`CORE_BAD_ARGUMENT: temporalIndex(${p.canvasId}) called after dispose() already drained and froze its state.`);
        }
        if (step.kind === 'tile') {
          await this.tiles.load(p.canvasId, step.x, step.y);
        } else if (step.kind === 'temporal') {
          await this.loadTemporal(p.canvasId);
        } else {
          ({ stats, diagnostics: events } = step);
          break;
        }
      }
    } catch (error) {
      this.engine.cancel();
      throw error;
    }
    for (const e of events) await this.report(e, p.canvasId);
    meta.bounds = union(meta.bounds, stats!.bounds);
    meta.observedPixels += stats!.added;
    meta.uncertainPixels += stats!.uncertain;
    meta.conflictPixels += stats!.conflicts;
    meta.tileCount += stats!.tiles;
    meta.provisionalPixels += stats!.provisionalPixels;
    meta.lastTime = p.time;
    return stats!;
  }
}
