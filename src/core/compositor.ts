import type { CanvasMeta, Diagnostic, Placement, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { QUALITY_BLOCK, type TileStore } from '../storage/tiles.ts';
import { core, type Resident, type ResidentFrame, type TemporalIndexHandle, type TemporalRow } from './wasm.ts';
import type { RegionAtlas } from './layers.ts';
import { union } from './math.ts';
import { resolveRasterPose } from './raster.ts';
import { t } from '../i18n/index.ts';
/** Persisted row shape (`temporal/<canvasId>/<id>` — frozen; do not change the key layout or field order): a
 *  `TemporalRow` (rust/core/src/temporal.rs's `TemporalRecord`, via `TemporalIndexHandle`,
 *  src/core/wasm/temporal.ts) plus the canvas it belongs to. */
type TemporalRegion = TemporalRow & { canvasId: string };

/** Integer key for an absolute 16px block: row-major, so ascending keys are (by, bx) order. Blocks within
 *  ±2^25 (±537 M native pixels) pack exactly into a double. Only used for the per-frame `conflictBlocks`
 *  bookkeeping below (a JS `Set<number>` of blocks touched this call, fed to `components()`) — the temporal
 *  index itself (rust/core/src/temporal.rs) keeps block membership as plain (bx, by) pairs. */
const BLOCK_OFFSET = 1 << 25, BLOCK_STRIDE = 1 << 26;
/** The single source of truth for how far a placed (world-space) rect can reach before `blockKey` throws:
 *  `BLOCK_OFFSET` blocks of `QUALITY_BLOCK` native pixels each, on either side of the origin. `solve/track.ts`'s
 *  `isValidPose`/`POSE_BOUND` and `render.ts`'s own guard both derive their bound from this constant rather than
 *  each picking their own — see `POSE_BOUND`'s doc comment for why theirs is smaller than this one. */
export const CANVAS_PIXEL_BOUND = BLOCK_OFFSET * QUALITY_BLOCK;
export function blockKey(bx: number, by: number): number {
  if (bx < -BLOCK_OFFSET || bx >= BLOCK_OFFSET || by < -BLOCK_OFFSET || by >= BLOCK_OFFSET) {
    throw new Error(`Block (${bx}, ${by}) is outside the addressable canvas.`);
  }
  return (by + BLOCK_OFFSET) * BLOCK_STRIDE + (bx + BLOCK_OFFSET);
}
export function blockOf(key: number): [number, number] {
  const by = Math.floor(key / BLOCK_STRIDE);
  return [key - by * BLOCK_STRIDE - BLOCK_OFFSET, by - BLOCK_OFFSET];
}
export interface CompositeStats {
  added: number;
  conflicts: number;
  uncertain: number;
  tiles: number;
  bounds: Rect;
  /** Net change in provisional pixels this call contributed (set minus healed); can be negative. */
  provisionalPixels: number;
}
interface PatchResult {
  added: number;
  /** Every pixel overwritePatch actually rewrote inside the resolved conflict-block mask — a pixel count, never
   * a block count. This is NOT restricted to pixels whose value actually differed from what was there before
   * (that narrower differing-pixel tally is `mismatch`, computed separately where a block is first flagged
   * conflicting); it folds into stats.conflicts as this patch's contribution, a coarser "pixels touched while
   * resolving the conflict" count, not a mismatch-pixel count. */
  conflictPixels: number;
  newTiles: number;
  /** Always ≤ 0: overwritePatch only ever runs on a fully world-consistent candidate (resolveTemporal's `choose`
   *  now requires consistency over the whole masked component), so it only ever heals pre-existing provisional
   *  pixels it overwrites, never creates new ones. */
  provisionalPixels: number;
}
/** Pixel ownership, not alpha blending. Conflicting moving objects are selected as whole observed patches. */
export class Compositor {
  /** Fresh-id sequence: shared across every canvas this Compositor ever touches (never reset per canvas), so it
   *  is threaded through `TemporalIndexHandle.decide()` explicitly rather than living in the Rust index itself
   *  (rust/core/src/temporal.rs's `TemporalIndex` is otherwise entirely per-canvas). */
  private temporalSequence = 0;
  private rectangular = new Set<string>();
  /** Live per-canvas temporal-index handles (rust/core/src/temporal.rs via `TemporalIndexHandle`) plus, once
   *  `dispose()` has drained and freed a handle, its stash — `deleted`/`dirty` rows `flush()` still owes the KV
   *  store, kept in JS since the Rust side is gone (see `dispose()`). `canvasOrder` mirrors the exact order a
   *  plain `Map<string, …>` would have iterated canvases in (first-touched order), across both maps. */
  private temporal = new Map<string, TemporalIndexHandle>();
  private stashed = new Map<string, { deleted: string[]; dirty: TemporalRow[] }>();
  private canvasOrder: string[] = [];
  constructor(
    private db: KV,
    readonly tiles: TileStore,
    private policy: 'stable' | 'latest',
    private emit: (d: Diagnostic) => Promise<void>,
    private atlas: RegionAtlas,
    private noise = 0,
  ) {
    for (const region of atlas.regions) {
      if (
        Number.isInteger(region.rect.x) && Number.isInteger(region.rect.y) && Number.isInteger(region.rect.width) &&
        Number.isInteger(region.rect.height) && atlas.count(atlas.code(region)) === region.rect.width * region.rect.height
      ) this.rectangular.add(region.id);
    }
  }
  /** Persists temporal records changed since the last flush (one batch per canvas, deletions first) — reads a
   *  still-live handle's own dirty/deleted state, or (after `dispose()`) the stash it drained into. Either way
   *  the row order matches `TemporalIndexHandle.flush()`'s exactly: every deleted id, then every dirty row. */
  async flush(): Promise<void> {
    for (const canvasId of this.canvasOrder) {
      const live = this.temporal.get(canvasId);
      const { deleted, dirty } = live ? live.flush() : this.stashed.get(canvasId) ?? { deleted: [], dirty: [] };
      this.stashed.delete(canvasId);
      for (const id of deleted) await this.db.delete(`temporal/${canvasId}/${id}`);
      if (dirty.length) {
        await this.db.putMany(dirty.map((row) => ({
          key: `temporal/${canvasId}/${row.id}`,
          // Field order is part of the frozen persisted shape (fingerprint.ts hashes JSON key order, not just
          // content) — matches the original TemporalRegion literal order exactly, not TemporalRow's.
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
  /** Loads a canvas's persisted temporal records once, into a fresh Rust-resident index; afterwards that index
   *  is authoritative. Rows are handed over in KV scan (ascending id) order, the same order an in-memory index
   *  would build itself in. Throws if `canvasId` was already `dispose()`d: silently building a new
   *  Rust-resident index from KV alone would leave out the still-unflushed rows `dispose()` drained into
   *  `stashed` (a fresh KV scan cannot see them — they are not persisted yet), producing an index that looks
   *  authoritative but has quietly lost pending edits instead of surfacing the "add() after dispose()" bug
   *  that got it here. Unreachable in the pipeline today: `dispose()` runs after the render pass's last `add()`
   *  (see `dispose()`'s own doc comment). */
  private async temporalIndex(canvasId: string): Promise<TemporalIndexHandle> {
    if (this.stashed.has(canvasId)) {
      throw new Error(`CORE_BAD_ARGUMENT: temporalIndex(${canvasId}) called after dispose() already drained and froze its state.`);
    }
    let handle = this.temporal.get(canvasId);
    if (!handle) {
      handle = core().newTemporalIndex();
      for await (const { value } of iterate<TemporalRegion>(this.db, `temporal/${canvasId}/`)) {
        handle.load(value);
      }
      this.temporal.set(canvasId, handle);
      this.canvasOrder.push(canvasId);
    }
    return handle;
  }
  /** Drains every canvas's dirty/deleted rows into `stashed` (in the exact order `flush()` would have asked the
   *  live handle for) and frees its Rust-resident handle. This runs BEFORE the pipeline's final `flush()`
   *  (`releaseResidentRenderState`, src/pipeline/context.ts, is called from render.ts's `finally` ahead of its
   *  own trailing `compositor.flush()`), so the handle cannot simply be freed here — `flush()` falls back to
   *  `stashed` for any canvas whose handle is gone, so the persisted rows and their order are unaffected by
   *  when exactly this runs relative to `flush()`. Idempotent (a canvas already stashed, or never touched, is
   *  skipped) and safe to call more than once, though the pipeline only ever does so once. */
  dispose(): void {
    for (const canvasId of this.canvasOrder) {
      const handle = this.temporal.get(canvasId);
      if (!handle) continue;
      this.stashed.set(canvasId, handle.flush());
      handle.free();
      this.temporal.delete(canvasId);
    }
  }
  /** `consistent`, when given, is a per-native-pixel (image-sized, one byte per pixel, indexed like `labels`) world-consistency
   *  mask computed by the render pass's one-frame lookahead: 0 means this pixel's placement here could be checked against a
   *  neighbouring frame and disagreed with every such check (CONSISTENT-BY-DEFAULT and genuinely-consistent pixels are both
   *  1); 2 identifies a screen occluder independently of ordinary pairwise disagreement. Omitted for fixed regions and skipped/duplicate frames, where every pixel is treated as consistent (unchanged
   *  behaviour). See docs/ARCHITECTURE.md §七. A mask already resident in the core is consumed in place and only read
   *  back when a temporal conflict needs the pixel-level check. `residentFrame`, when given, is `image` already in core
   *  memory, so the frame is not copied again for compositing. */
  async add(
    image: RGBA,
    region: Region,
    p: Placement,
    frame: number,
    meta: CanvasMeta,
    consistent?: Uint8Array | Resident,
    residentFrame?: ResidentFrame,
  ): Promise<CompositeStats> {
    const size = this.tiles.size, B = QUALITY_BLOCK, blocks = size / B, { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y);
    if (image.width !== this.atlas.width || image.height !== this.atlas.height) {
      throw new Error(`Frame is ${image.width}×${image.height} but the region atlas is ${this.atlas.width}×${this.atlas.height}.`);
    }
    if (residentFrame && (residentFrame.width !== image.width || residentFrame.height !== image.height)) {
      throw new Error('Resident frame does not match the observation.');
    }
    const code = this.atlas.code(region), labels = this.atlas.resident, rectangular = this.rectangular.has(region.id);
    const world = { x: region.rect.x + ox, y: region.rect.y + oy, width: region.rect.width, height: region.rect.height };
    // Defense in depth, not the graceful path (that is render.ts's own isValidPose check before this call ever
    // happens): a world rect outside the addressable range would make the tile-index loop below unbounded (its
    // extent is sized directly from `world`, e.g. `Infinity` makes `ty <= y1` never false) — a clean thrown
    // Error here, instead of an unbounded loop that exhausts memory, no matter how this call was reached.
    if (
      !Number.isFinite(world.x) || !Number.isFinite(world.y) || Math.abs(world.x) >= CANVAS_PIXEL_BOUND ||
      Math.abs(world.y) >= CANVAS_PIXEL_BOUND || Math.abs(world.x + world.width) >= CANVAS_PIXEL_BOUND ||
      Math.abs(world.y + world.height) >= CANVAS_PIXEL_BOUND
    ) {
      throw new Error(`Placement (${p.x}, ${p.y}) puts region ${region.id} outside the addressable canvas.`);
    }
    const stats: CompositeStats = { added: 0, conflicts: 0, uncertain: 0, tiles: 0, bounds: world, provisionalPixels: 0 };
    const conflictBlocks = new Set<number>();
    const x0 = Math.floor(world.x / size),
      x1 = Math.floor((world.x + world.width - 1) / size),
      y0 = Math.floor(world.y / size),
      y1 = Math.floor((world.y + world.height - 1) / size);
    const tileOrder: { tx: number; ty: number }[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        tileOrder.push({ tx, ty });
      }
    }
    const resident = tileOrder.filter(({ tx, ty }) => this.tiles.isResident(p.canvasId, tx, ty));
    const cold = tileOrder.filter(({ tx, ty }) => !this.tiles.isResident(p.canvasId, tx, ty));
    // A footprint just larger than the cache otherwise turns every frame into a full cyclic scan. Touching the
    // resident set first keeps those tiles together while the few cold loads evict only the oldest residents.
    // One frame copy into the core per placement; each tile then round-trips its own buffers only.
    const prepared = core().prepareObservation({
      noise: this.noise,
      image: residentFrame ?? image,
      mask: rectangular ? undefined : { labels, code },
      occlusions: p.occlusions,
      consistent,
      confidence: p.confidence,
      uncertain: !!p.uncertain,
      frame,
    }, size);
    for (const { tx, ty } of resident.concat(cold)) {
      const tile = await this.tiles.get(p.canvasId, tx, ty), wasNew = !tile.existed && !tile.coverage.some((x) => x !== 0);
      const result = prepared.compositeTile(tile, world, ox, oy, tx, ty);
      stats.added += result.added;
      stats.conflicts += result.conflicts;
      stats.uncertain += result.uncertain;
      stats.provisionalPixels += result.provisionalPixels;
      for (const [bx, by] of result.conflictBlocks) conflictBlocks.add(blockKey(tx * blocks + bx, ty * blocks + by));
      if (result.changed) {
        tile.dirty = true;
        tile.touched = performance.now();
        if (wasNew) {
          stats.tiles++;
        }
      }
    }
    if (conflictBlocks.size) {
      // Every component comes from components(conflictBlocks, B): it always holds at least one B×B=256px block
      // (components() only ever splits a non-empty cell set), so its bounds area is never below 256 — no
      // "too small to bother" case exists here to skip.
      // Keep the temporal component order identical to the former raster traversal. Tile loading order is now
      // cache-aware, but component order must not become an accidental cross-tile temporal mutation.
      const orderedConflictBlocks = [...conflictBlocks].sort((a, b) => {
        const [ax, ay] = blockOf(a),
          [bx, by] = blockOf(b),
          atx = Math.floor(ax / blocks),
          btx = Math.floor(bx / blocks),
          aty = Math.floor(ay / blocks),
          bty = Math.floor(by / blocks);
        return aty - bty || atx - btx || (ay - aty * blocks) - (by - bty * blocks) || (ax - atx * blocks) - (bx - btx * blocks);
      });
      const components = this.components(new Set(orderedConflictBlocks), B);
      let patchedPixels = 0, patchedTiles = 0, patchedConflictPixels = 0, patchedProvisional = 0;
      for (const component of components) {
        // `consistent` is passed straight through to the one Rust call that reads it (`maskCompleteAndCommit`,
        // via `resolveTemporal`): a `Resident`'s own pointer is growth-stable (no view-staleness concern, unlike
        // the old TS walk), and a plain `Uint8Array` is copied into scratch fresh inside that same call.
        const result = await this.resolveTemporal(
          image,
          region,
          p,
          frame,
          component.bounds,
          component.blocks,
          world,
          consistent,
          residentFrame,
        );
        patchedPixels += result.added;
        patchedTiles += result.newTiles;
        // A pixel count, not a block count — a block count would understate conflict pixels by roughly a factor
        // of 256 (one QUALITY_BLOCK). Still coarser than a mismatch-pixel count (see PatchResult.conflictPixels):
        // every pixel this patch rewrote, not only the ones that differed.
        patchedConflictPixels += result.conflictPixels;
        patchedProvisional += result.provisionalPixels;
        // stats.conflicts is the running frame-wide total (accumulated across every conflicting component
        // this frame, not just this one), so the message says so explicitly instead of implying it is this
        // component's own count; `region` below still names this one component.
        await this.emit({
          code: 'TEMPORAL_OR_ALIGNMENT_CONFLICT',
          severity: 'warning',
          time: p.time,
          frame,
          canvasId: p.canvasId,
          region: component.bounds,
          confidence: p.confidence,
          message: t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.message', { conflicts: stats.conflicts.toLocaleString() }),
          action: this.policy === 'stable'
            ? t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionStable')
            : t('diag.TEMPORAL_OR_ALIGNMENT_CONFLICT.actionRolling'),
        });
      }
      stats.added += patchedPixels;
      stats.tiles += patchedTiles;
      stats.conflicts += patchedConflictPixels;
      stats.provisionalPixels += patchedProvisional;
    }
    meta.bounds = union(meta.bounds, world);
    meta.observedPixels += stats.added;
    meta.uncertainPixels += stats.uncertain;
    meta.conflictPixels += stats.conflicts;
    meta.tileCount += stats.tiles;
    meta.provisionalPixels += stats.provisionalPixels;
    meta.lastTime = p.time;
    return stats;
  }
  /** 8-connected components of conflicting `size`-px blocks (rust/core/src/temporal.rs). Each component keeps its own
   * block set, never just a bounding rect — a concave (e.g. L-shaped) conflict must not drag pixel-identical blocks
   * in its bounding box into the patch. `cells` must already be in seed order (Compositor.add sorts conflict blocks
   * into tile-then-local-block order before calling, matching the old `Set` iteration this replaces). */
  private components(cells: Set<number>, size: number): { bounds: Rect; blocks: Set<number> }[] {
    return core().temporalComponents([...cells].map(blockOf), size).map(({ bounds, blocks }) => ({
      bounds,
      blocks: new Set(blocks.map(([bx, by]) => blockKey(bx, by))),
    }));
  }
  /** resolveTemporal's decision (rust/core/src/temporal.rs's `TemporalIndex::decide`/`mask_complete`/`commit`,
   *  via `TemporalIndexHandle`): two Rust calls — `decide` (the olds/union/expanded/choose bookkeeping, which
   *  needs no atlas/occlusion/consistency pixels) sizes the write-block buffer for `maskCompleteAndCommit` (the
   *  pixel-level completeness walk plus the index commit) to fill. `consistent` is handed straight to the
   *  second call: a `Resident`'s pointer is growth-stable, so unlike the old TS walk there is no "no core call
   *  in between" requirement to preserve here — the whole walk already happens inside that one call.
   *  `residentFrame`, when given, is `image` already uploaded to the `FrameRing` for this observation — passed
   *  through to `overwritePatch` so a chosen patch reuses that pointer instead of re-copying the whole frame
   *  once per tile (see `overwriteTile`'s doc comment, src/core/wasm/temporal.ts). */
  private async resolveTemporal(
    image: RGBA,
    region: Region,
    p: Placement,
    frame: number,
    compBounds: Rect,
    compBlocks: Set<number>,
    visible: Rect,
    consistent?: Uint8Array | Resident,
    residentFrame?: ResidentFrame,
  ): Promise<PatchResult> {
    const index = await this.temporalIndex(p.canvasId);
    const [writeBlockCount, nextSeq] = index.decide(
      compBounds,
      [...compBlocks].map(blockOf),
      frame,
      p.time,
      visible,
      this.policy === 'latest',
      this.temporalSequence,
    );
    this.temporalSequence = nextSeq;
    const { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y), code = this.atlas.code(region);
    const decision = index.maskCompleteAndCommit({
      labelsPtr: this.atlas.resident.ptr,
      atlasWidth: this.atlas.width,
      atlasHeight: this.atlas.height,
      code,
      occlusions: p.occlusions,
      consistent,
      ox,
      oy,
      writeBlockCount,
    });
    let result: PatchResult = { added: 0, conflictPixels: 0, newTiles: 0, provisionalPixels: 0 };
    if (decision.chosen) {
      result = await this.overwritePatch(image, p, decision.writeBlocks, frame, residentFrame);
    }
    if (decision.emitIncomplete) {
      await this.emit({
        code: 'INCOMPLETE_TEMPORAL_PATCH',
        severity: 'warning',
        canvasId: p.canvasId,
        frame,
        time: p.time,
        region: decision.rect,
        message: t('diag.INCOMPLETE_TEMPORAL_PATCH.message'),
        action: t('diag.INCOMPLETE_TEMPORAL_PATCH.action'),
      });
    }
    return result;
  }
  private async overwritePatch(
    image: RGBA,
    p: Placement,
    mask: [number, number][],
    frame: number,
    residentFrame?: ResidentFrame,
  ): Promise<PatchResult> {
    const size = this.tiles.size, { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y), B = QUALITY_BLOCK;
    const byTile = new Map<string, { tx: number; ty: number; blocks: [number, number][] }>();
    for (const [bx, by] of mask) {
      const tx = Math.floor(bx * B / size), ty = Math.floor(by * B / size), key = `${tx},${ty}`;
      let g = byTile.get(key);
      if (!g) {
        g = { tx, ty, blocks: [] };
        byTile.set(key, g);
      }
      g.blocks.push([bx, by]);
    }
    let added = 0, conflictPixels = 0, provisionalPixels = 0;
    for (const { tx, ty, blocks: tileBlocks } of byTile.values()) {
      const tile = await this.tiles.get(p.canvasId, tx, ty);
      // resolveTemporal's maskComplete walk already tested this exact block set against the same
      // atlas.contains/occluded/consistent conditions before choosing to call overwritePatch, so every pixel
      // here is guaranteed in-bounds, unoccluded and world-consistent, and any standing provisional bit is
      // healed, never set (rust/core/src/temporal.rs::overwrite_tile mirrors this loop exactly). `residentFrame`,
      // when given, is `image` already uploaded for this observation — `overwriteTile` uses its pointer in
      // place instead of copying the whole frame again for every tile this patch touches.
      const result = core().overwriteTile(
        tile,
        size,
        residentFrame ?? image,
        tileBlocks,
        ox,
        oy,
        tx,
        ty,
        frame,
        p.confidence,
        this.policy === 'stable',
      );
      added += result.added;
      conflictPixels += result.conflictPixels;
      provisionalPixels += result.provisionalPixels;
      // A masked block only ever reaches overwritePatch already holding ≥12 covered pixels — either this
      // frame's own conflict detection required overlap ≥ 12 to flag it (rust/core/src/compositor.rs), or it
      // carries forward an earlier resolveTemporal record, which itself only ever wrote pixels the same way. The
      // tile this block sits on is therefore never new here, so there is no newTiles bookkeeping to do.
      if (result.changed) {
        tile.dirty = true;
        tile.touched = performance.now();
      }
    }
    return { added, conflictPixels, newTiles: 0, provisionalPixels };
  }
}
