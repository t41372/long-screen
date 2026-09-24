import type { CanvasMeta, Diagnostic, Placement, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { clearProvisional, covered, markCovered, provisional, QUALITY_BLOCK, type TileStore } from '../storage/tiles.ts';
import { core, Resident, type ResidentFrame } from './wasm.ts';
import type { RegionAtlas } from './layers.ts';
import { intersect, pad, union } from './math.ts';
import { resolveRasterPose } from './raster.ts';
/** Native-screen occluder membership, native-frame coordinates. Occlusions are always full-width bands, so rect containment on (sx, sy) is exact. */
function occluded(occlusions: Rect[] | undefined, sx: number, sy: number): boolean {
  return !!occlusions && occlusions.some((o) => sx >= o.x && sx < o.x + o.width && sy >= o.y && sy < o.y + o.height);
}
interface TemporalRegion {
  id: string;
  canvasId: string;
  rect: Rect;
  /** Absolute [bx,by] block coordinates (16px units) actually part of this temporal patch; never the dense bounding rect. */
  blocks: [number, number][];
  chosenFrame: number;
  chosenTime: number;
  complete: boolean;
  revisions: number;
}

/** Compare block membership, not only a bounding box or cardinality. */
export function sameBlockSet(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(([x, y]) => `${x},${y}`));
  return keys.size === b.length && b.every(([x, y]) => keys.has(`${x},${y}`));
}
/** Integer key for an absolute 16px block: row-major, so ascending keys are (by, bx) order. Blocks within
 *  ±2^25 (±537 M native pixels) pack exactly into a double. */
const BLOCK_OFFSET = 1 << 25, BLOCK_STRIDE = 1 << 26;
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
/** In-memory form of a temporal record: the block membership is a resident integer-key set (records on a
 *  long-scrolling canvas grow to tens of thousands of blocks and are touched by every conflict component that
 *  overlaps them), and the persisted `blocks` array is derived from it only when a record is written. */
type ResidentTemporal = Omit<TemporalRegion, 'blocks'> & { keys: Set<number> };
/** Temporal records of one canvas, resident for the pass. Persisted rows are written by flush(), so a run that is
 *  interrupted mid-pass leaves rows as of the last flush — the same durability the tile cache already has. */
interface TemporalIndex {
  records: Map<string, ResidentTemporal>;
  dirty: Set<string>;
  deleted: Set<string>;
}
/** Persisted block order: ascending integer keys are (by, bx) row-major. */
function persistedBlocks(keys: Set<number>): [number, number][] {
  return [...keys].sort((a, b) => a - b).map(blockOf);
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
  private temporalSequence = 0;
  private rectangular = new Set<string>();
  private temporal = new Map<string, TemporalIndex>();
  constructor(
    private db: KV,
    readonly tiles: TileStore,
    private policy: 'stable' | 'latest',
    private emit: (d: Diagnostic) => Promise<void>,
    private atlas: RegionAtlas,
  ) {
    for (const region of atlas.regions) {
      if (
        Number.isInteger(region.rect.x) && Number.isInteger(region.rect.y) && Number.isInteger(region.rect.width) &&
        Number.isInteger(region.rect.height) && atlas.count(atlas.code(region)) === region.rect.width * region.rect.height
      ) this.rectangular.add(region.id);
    }
  }
  /** Persists temporal records changed since the last flush (one batch, deletions first). */
  async flush(): Promise<void> {
    for (const [canvasId, index] of this.temporal) {
      for (const id of index.deleted) await this.db.delete(`temporal/${canvasId}/${id}`);
      index.deleted.clear();
      if (index.dirty.size) {
        await this.db.putMany([...index.dirty].map((id) => {
          const { keys, ...record } = index.records.get(id)!;
          return { key: `temporal/${canvasId}/${id}`, value: { ...record, blocks: persistedBlocks(keys) } satisfies TemporalRegion };
        }));
        index.dirty.clear();
      }
    }
  }
  /** Loads a canvas's persisted temporal records once; afterwards the in-memory index is authoritative. */
  private async temporalIndex(canvasId: string): Promise<TemporalIndex> {
    let index = this.temporal.get(canvasId);
    if (!index) {
      index = { records: new Map(), dirty: new Set(), deleted: new Set() };
      for await (const { value } of iterate<TemporalRegion>(this.db, `temporal/${canvasId}/`)) {
        const { blocks, ...record } = value;
        index.records.set(value.id, { ...record, keys: new Set(blocks.map(([x, y]) => blockKey(x, y))) });
      }
      this.temporal.set(canvasId, index);
    }
    return index;
  }
  /** No-op: the compositor no longer owns any core-resident state (the atlas's label plane is shared, owned by
   *  the atlas itself — `RegionAtlas.dispose()`, called once from run()'s finally). Kept so callers (`context.ts`'s
   *  `releaseResidentRenderState`) can keep treating a compositor as disposable without a special case. */
  dispose(): void {}
  /** `consistent`, when given, is a per-native-pixel (image-sized, one byte per pixel, indexed like `labels`) world-consistency
   *  mask computed by the render pass's one-frame lookahead: 0 means this pixel's placement here could be checked against a
   *  neighbouring frame and disagreed with every such check (CONSISTENT-BY-DEFAULT and genuinely-consistent pixels are both
   *  1). Omitted for fixed regions and skipped/duplicate frames, where every pixel is treated as consistent (unchanged
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
      // Only the pixel-level completeness walk in resolveTemporal reads the mask, and only for a component it may
      // rewrite; it takes a view of a resident mask right before that synchronous walk instead of a per-frame copy.
      const mask = consistent instanceof Resident ? () => consistent.view() : consistent && (() => consistent);
      for (const component of components) {
        const result = await this.resolveTemporal(image, region, p, frame, component.bounds, component.blocks, world, mask);
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
          message:
            `本帧对齐后的重叠区域共有 ${stats.conflicts.toLocaleString()} 个明显不同的像素；此区域是其中一个冲突分量。可能是动画、内容更新、重排或配准残差。`,
          action: this.policy === 'stable'
            ? '已尽量冻结单一时刻的完整冲突区域；查看橙色诊断和原视频时间点。'
            : '仅在完整可见时用同一帧更新整块冲突区域；并非全页面同一时刻。',
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
  /** 8-connected components of conflicting 16px blocks. Each component keeps its own block set, never just a bounding rect — a
   * concave (e.g. L-shaped) conflict must not drag pixel-identical blocks in its bounding box into the patch. */
  private components(cells: Set<number>, size: number): { bounds: Rect; blocks: Set<number> }[] {
    const out: { bounds: Rect; blocks: Set<number> }[] = [];
    while (cells.size) {
      const first = cells.values().next().value!, queue = [first], comp = new Set<number>([first]);
      cells.delete(first);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < queue.length; i++) {
        const [x, y] = blockOf(queue[i]);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const key = queue[i] + dy * BLOCK_STRIDE + dx;
            if (cells.delete(key)) {
              queue.push(key);
              comp.add(key);
            }
          }
        }
      }
      out.push({ bounds: { x: x0 * size, y: y0 * size, width: (x1 - x0 + 1) * size, height: (y1 - y0 + 1) * size }, blocks: comp });
    }
    return out;
  }
  private async resolveTemporal(
    image: RGBA,
    region: Region,
    p: Placement,
    frame: number,
    compBounds: Rect,
    compBlocks: Set<number>,
    visible: Rect,
    consistentMask?: () => Uint8Array,
  ): Promise<PatchResult> {
    const B = QUALITY_BLOCK;
    const index = await this.temporalIndex(p.canvasId), olds: ResidentTemporal[] = [];
    for (const t of index.records.values()) {
      const expanded = { x: t.rect.x - 16, y: t.rect.y - 16, width: t.rect.width + 32, height: t.rect.height + 32 };
      const ix = intersect(expanded, compBounds);
      if (ix.width > 0 && ix.height > 0) {
        olds.push(t);
      }
    }
    // Records never share a block (a record's blocks lie inside its rect, and a record is only ever created from a
    // component that misses every existing record's expanded rect), so the previous membership is the plain sum
    // of the overlapping records' sizes and the union grows by exactly the component blocks none of them holds.
    // The union is built in the LARGEST overlapping set to avoid re-hashing tens of thousands of keys per component.
    const old = olds[0];
    let rect = compBounds, previousSize = 0, largest: ResidentTemporal | undefined;
    for (const o of olds) {
      rect = union(rect, o.rect);
      previousSize += o.keys.size;
      if (!largest || o.keys.size > largest.keys.size) largest = o;
    }
    const mask = largest ? largest.keys : new Set<number>();
    for (const o of olds) {
      if (o !== largest) { for (const key of o.keys) mask.add(key); }
    }
    for (const key of compBlocks) mask.add(key);
    const geometryChanged = !old || rect.x !== old.rect.x || rect.y !== old.rect.y || rect.width !== old.rect.width ||
      rect.height !== old.rect.height;
    // `olds` can contain multiple nearby records. Compare against their union, not just `olds[0]`, and compare
    // actual membership so equal bboxes/cardinalities cannot preserve a stale complete=true state. The union
    // contains every previous block by construction, so membership differs exactly when the size grew.
    const membershipChanged = !old || mask.size !== previousSize;
    const expanded = geometryChanged || membershipChanged;
    const record: ResidentTemporal = old ? { ...old, rect, keys: mask } : {
      id: pad(this.temporalSequence++),
      canvasId: p.canvasId,
      rect,
      keys: mask,
      chosenFrame: frame,
      chosenTime: p.time,
      complete: false,
      revisions: 0,
    };
    if (expanded) {
      record.complete = false;
    }
    // Ensure the entire tracked patch is visible this frame. `rect` is exactly the bounding box of the mask blocks
    // (component bounds and record rects are block bounding boxes, and union preserves that), and every block
    // lies inside `visible` iff their bounding box does, so this is the per-block test in O(1). The write set is
    // still the block MASK, not the rect, so a stable pixel-identical corner block in a concave conflict is never
    // rewritten.
    const complete = intersect(rect, visible).width === rect.width && intersect(rect, visible).height === rect.height;
    const writeBlocks: [number, number][] = complete ? persistedBlocks(mask) : [];
    const choose = complete && (!old || !old.complete || expanded || this.policy === 'latest');
    let result: PatchResult = { added: 0, conflictPixels: 0, newTiles: 0, provisionalPixels: 0 };
    if (choose) {
      // Ensure the entire patch belongs to this pane AND is world-consistent everywhere: an observation
      // containing a cursor/FAB is not a good "complete moment" even when it is the first full view of this
      // region, so a consistency failure here refuses the patch exactly like a mask hole does. A block can
      // also contain an unknown mask hole.
      let maskComplete = true;
      // No core call happens between taking the view and the end of this synchronous walk.
      const { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y), code = this.atlas.code(region), consistent = consistentMask?.();
      for (let k = 0; k < writeBlocks.length && maskComplete; k++) {
        const [bx, by] = writeBlocks[k];
        for (let y = by * B; y < by * B + B && maskComplete; y++) {
          for (let x = bx * B; x < bx * B + B; x++) {
            if (
              !this.atlas.contains(code, x - ox, y - oy) || occluded(p.occlusions, x - ox, y - oy) ||
              (consistent && !consistent[(y - oy) * image.width + (x - ox)])
            ) {
              maskComplete = false;
              break;
            }
          }
        }
      }
      if (maskComplete) {
        result = await this.overwritePatch(image, p, writeBlocks, frame);
        record.chosenFrame = frame;
        record.chosenTime = p.time;
        record.complete = true;
        record.revisions++;
      }
    }
    index.records.set(record.id, record);
    index.dirty.add(record.id);
    index.deleted.delete(record.id);
    for (const o of olds) {
      if (o.id !== record.id) {
        index.records.delete(o.id);
        index.dirty.delete(o.id);
        index.deleted.add(o.id);
      }
    }
    if (!record.complete && (!old || expanded)) {
      await this.emit({
        code: 'INCOMPLETE_TEMPORAL_PATCH',
        severity: 'warning',
        canvasId: p.canvasId,
        frame,
        time: p.time,
        region: rect,
        message: '这个变化区域从未完整地出现在一个可用视口中；无法保证其所有像素来自同一时刻。',
        action: '保留已观察内容和明确冲突标记，没有填造未观察部分。',
      });
    }
    return result;
  }
  private async overwritePatch(image: RGBA, p: Placement, mask: [number, number][], frame: number): Promise<PatchResult> {
    const size = this.tiles.size, { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y), B = QUALITY_BLOCK, perTile = size / B;
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
      let changed = false;
      for (const [bx, by] of tileBlocks) {
        for (let y = by * B; y < by * B + B; y++) {
          for (let x = bx * B; x < bx * B + B; x++) {
            // resolveTemporal's maskComplete walk already tested this exact (x, y) set against the same
            // atlas.contains/occluded/consistent conditions before choosing to call overwritePatch, so
            // every pixel here is guaranteed in-bounds, unoccluded and world-consistent — an occluded()
            // or out-of-range src here would mean that walk and this one disagree about the same pixel.
            const src = ((y - oy) * image.width + (x - ox)) * 4, dst = ((y - ty * size) * size + (x - tx * size)) * 4;
            tile.pixels[dst] = image.data[src];
            tile.pixels[dst + 1] = image.data[src + 1];
            tile.pixels[dst + 2] = image.data[src + 2];
            tile.pixels[dst + 3] = image.data[src + 3];
            const px = dst / 4;
            if (!covered(tile, px)) {
              markCovered(tile, px);
              added++;
            }
            // This observation was proven consistent over the whole masked component (maskComplete,
            // above) before overwritePatch was ever called, so any provisional bit here is healed, never set.
            if (provisional(tile, px)) {
              clearProvisional(tile, px);
              provisionalPixels--;
            }
            changed = true;
            conflictPixels++;
          }
        }
        const localBx = bx - tx * perTile, localBy = by - ty * perTile, q = localBy * perTile + localBx;
        tile.owner[q] = frame + 1;
        tile.quality[q] = Math.round(p.confidence * 255);
        tile.conflicts[q] = 1;
        if (this.policy === 'stable') {
          tile.frozen[q] = 1;
        }
      }
      // A masked block only ever reaches overwritePatch already holding ≥12 covered pixels — either this
      // frame's own conflict detection required overlap ≥ 12 to flag it (rust/core/src/compositor.rs), or it
      // carries forward an earlier resolveTemporal record, which itself only ever wrote pixels the same way. The
      // tile this block sits on is therefore never new here, so there is no newTiles bookkeeping to do.
      if (changed) {
        tile.dirty = true;
        tile.touched = performance.now();
      }
    }
    return { added, conflictPixels, newTiles: 0, provisionalPixels };
  }
}
