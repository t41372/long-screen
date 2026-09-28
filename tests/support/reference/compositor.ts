// Historical TS oracle, with the RGB/dual-axis quality rule and screen-witness demotion explicitly
// advanced alongside their independent behavioural regressions. All other compositor semantics stay frozen.
/** FROZEN pre-migration Compositor (parity oracle for rust/core/src/compositor.rs). Not used by production code. */
import type { CanvasMeta, Diagnostic, Placement, Rect, Region, RGBA } from '../../../src/types.ts';
import type { KV } from '../../../src/storage/db.ts';
import { iterate } from '../../../src/storage/db.ts';
import { covered, markCovered, provisional, QUALITY_BLOCK, type TileStore } from '../../../src/storage/tiles.ts';
import type { RegionAtlas } from '../../../src/core/layers.ts';
import { intersect, pad, popcount, resolveRasterPose, union } from './math.ts';
import { clearProvisional, markProvisional } from '../tile-bits.ts';
/** Native-screen occluder membership, native-frame coordinates. Occlusions are always full-width bands, so rect containment on (sx, sy) matches the row-rule used before. */
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
export class ReferenceCompositor {
  private temporalSequence = 0;
  private rectangular = new Set<string>();
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
  /** `consistent`, when given, is a per-native-pixel (image-sized, one byte per pixel, indexed like `labels`) world-consistency
   *  mask computed by the render pass's one-frame lookahead: 0 means this pixel's placement here could be checked against a
   *  neighbouring frame and disagreed with every such check (CONSISTENT-BY-DEFAULT and genuinely-consistent pixels are both
   *  1). Omitted for fixed regions and skipped/duplicate frames, where every pixel is treated as consistent (unchanged
   *  behaviour). See docs/ARCHITECTURE.md §七. */
  async add(image: RGBA, region: Region, p: Placement, frame: number, meta: CanvasMeta, consistent?: Uint8Array): Promise<CompositeStats> {
    const size = this.tiles.size, B = QUALITY_BLOCK, blocks = size / B, { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y);
    if (image.width !== this.atlas.width || image.height !== this.atlas.height) {
      throw new Error(`Frame is ${image.width}×${image.height} but the region atlas is ${this.atlas.width}×${this.atlas.height}.`);
    }
    const code = this.atlas.code(region),
      labels = this.atlas.labels,
      W = image.width,
      H = image.height,
      rectangular = this.rectangular.has(region.id);
    const world = { x: region.rect.x + ox, y: region.rect.y + oy, width: region.rect.width, height: region.rect.height };
    const stats: CompositeStats = { added: 0, conflicts: 0, uncertain: 0, tiles: 0, bounds: world, provisionalPixels: 0 };
    const conflictBlocks = new Set<string>();
    const source32 = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
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
    for (const { tx, ty } of resident.concat(cold)) {
      const tile = await this.tiles.get(p.canvasId, tx, ty), wasNew = !tile.existed && !tile.coverage.some((x) => x !== 0);
      let changed = false;
      const pixels32 = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.pixels.length / 4);
      const patch = intersect(world, { x: tx * size, y: ty * size, width: size, height: size });
      const bx0 = Math.floor((patch.x - tx * size) / B),
        by0 = Math.floor((patch.y - ty * size) / B),
        bx1 = Math.ceil((patch.x + patch.width - tx * size) / B),
        by1 = Math.ceil((patch.y + patch.height - ty * size) / B);
      for (let by = by0; by < by1; by++) {
        for (let bx = bx0; bx < bx1; bx++) {
          const q = by * blocks + bx;
          let mismatch = 0, overlap = 0, sharpness = 0, count = 0, identical = 0, screenOccluded = false;
          const sy0 = Math.ceil(Math.max(by * B, world.y - ty * size)),
            sy1 = Math.ceil(Math.min((by + 1) * B, world.y + world.height - ty * size));
          const sx0 = Math.ceil(Math.max(bx * B, world.x - tx * size)),
            sx1 = Math.ceil(Math.min((bx + 1) * B, world.x + world.width - tx * size));
          for (let y = sy0; y < sy1; y++) {
            const sy = ty * size + y - oy;
            if (sy < 0 || sy >= H) {
              continue;
            }
            for (let x = sx0; x < sx1; x++) {
              const sx = tx * size + x - ox;
              if (sx < 0 || sx >= W || occluded(p.occlusions, sx, sy)) {
                continue;
              }
              const src = sy * W + sx;
              if (!rectangular && labels[src] !== code) {
                continue;
              }
              const dst = y * size + x, i = dst * 4, j = src * 4;
              count++;
              screenOccluded ||= consistent?.[src] === 2;
              if (covered(tile, dst)) {
                overlap++;
                if (pixels32[dst] === source32[src]) {
                  identical++;
                  continue;
                }
                const diff = (Math.abs(tile.pixels[i] - image.data[j]) + Math.abs(tile.pixels[i + 1] - image.data[j + 1]) +
                  Math.abs(tile.pixels[i + 2] - image.data[j + 2])) / 3;
                if (diff > 25) {
                  mismatch++;
                }
              }
            }
          }
          if (!count) continue;
          // A block is "complete" once this observation rewrites every pixel of it that was ever covered before —
          // not just when this observation happened to touch all 256 of its pixels. Otherwise any block that is
          // partly outside the region mask, the world rect, a narrow pane, or an occluded row can never replace.
          let coveredInBlock = 0, provisionalInBlock = 0;
          for (let row = 0; row < B; row++) {
            const i = ((by * B + row) * size + bx * B) >> 3;
            coveredInBlock += popcount(tile.coverage[i]) + popcount(tile.coverage[i + 1]);
            provisionalInBlock += popcount(tile.provisional[i]) + popcount(tile.provisional[i + 1]);
          }
          // Exact native-pixel equality, not a similarity threshold. Preserve ownership and skip all writes —
          // UNLESS the block still carries provisional bits. A pixel flagged transient carries the same value a
          // later, better-corroborated observation shows (that is the normal case when the flag was wrong: the
          // content was right all along), so "nothing to write" and "nothing to clear" are different questions.
          // Skipping on identity alone left those flags standing for the rest of the run, which both capped the
          // block's quality score and kept the pixel counted as unhealed for no reason. An observation that
          // reproduces the WHOLE block exactly is corroborating evidence even when the mask rejected it, so
          // the demotion below deliberately does not reach here: it is for blocks this observation genuinely
          // disagrees with somewhere, not for ones it reproduces verbatim.
          if (identical === count && !provisionalInBlock && !screenOccluded) continue;
          const conflict = overlap >= 12 && mismatch / overlap > .16;
          const complete = overlap === coveredInBlock;
          const edge = Math.min(
            (tx * size + bx * B) - world.x,
            (ty * size + by * B) - world.y,
            world.x + world.width - (tx * size + (bx + 1) * B),
            world.y + world.height - (ty * size + (by + 1) * B),
          );
          if ((!conflict && !tile.frozen[q] && complete) || !tile.owner[q]) {
            for (let y = sy0; y < sy1; y++) {
              const sy = ty * size + y - oy;
              if (sy < 0 || sy >= H) {
                continue;
              }
              for (let x = sx0; x < sx1; x++) {
                const sx = tx * size + x - ox;
                if (sx <= 0 || sx >= W - 1 || occluded(p.occlusions, sx, sy)) {
                  continue;
                }
                const src = sy * W + sx, j = src * 4;
                if (rectangular || labels[src] === code) {
                  // Quality rule revision: independently evaluate RGB gradients in both axes.
                  const gradients = [0, 1, 2].flatMap((c) => [
                    Math.abs(image.data[j - 4 + c] - image.data[j + 4 + c]),
                    sy > 0 && sy + 1 < H ? Math.abs(image.data[j - W * 4 + c] - image.data[j + W * 4 + c]) : 0,
                  ]);
                  sharpness += Math.max(...gradients);
                }
              }
            }
          }
          const hadProvisional = provisionalInBlock > 0;
          const score = p.confidence * 100 + Math.min(12, sharpness / count * .15) + Math.min(6, Math.max(0, edge) / 40);
          const replace = complete && !conflict && !tile.frozen[q] && score > tile.score[q] + 4;
          if (conflict) {
            tile.conflicts[q] = 1;
            conflictBlocks.add(`${tx * blocks + bx},${ty * blocks + by}`);
            stats.conflicts += mismatch;
            changed = true;
          }
          // A provisional bit standing in this block is a standing invitation for a consistent observation to
          // heal it, independent of `replace`/`frozen` — frozen protects a chosen moment from being re-picked,
          // not screen-chrome burn-in from being fixed (see docs/ARCHITECTURE.md §七) — so the block must be
          // walked even when neither `replace` nor a fresh pixel would otherwise justify entering it.
          if (replace || overlap < count || provisionalInBlock || screenOccluded) {
            for (let y = sy0; y < sy1; y++) {
              const sy = ty * size + y - oy;
              if (sy < 0 || sy >= H) {
                continue;
              }
              for (let x = sx0; x < sx1; x++) {
                const sx = tx * size + x - ox;
                if (sx < 0 || sx >= W || occluded(p.occlusions, sx, sy)) {
                  continue;
                }
                const dst = y * size + x, src = sy * W + sx;
                if (!rectangular && labels[src] !== code) continue;
                const fresh = !covered(tile, dst), bad = !!consistent && consistent[src] !== 1, wasProvisional = provisional(tile, dst);
                // Priority: a fresh pixel is always written (a hole would be worse than a guess); an
                // inconsistent observation never overwrites already-covered content, provisional or not;
                // a covered provisional pixel is healed by any consistent observation regardless of
                // `replace`; otherwise the ordinary replace gate governs consistent-vs-consistent choices.
                const write = fresh ? true : bad ? false : wasProvisional ? true : replace;
                if (!write) {
                  // A rejected observation that shows what is ALREADY stored condemns the stored pixel
                  // too. A screen overlay's very first look at a world position is often the one that
                  // paints it (nothing is covered yet, and the ±1-frame check has nothing to compare
                  // against at a leading edge, or agrees because the neighbour is under the same
                  // overlay); the flag only arrives one or two frames later, by which time the write is
                  // blocked by the rule above and the artefact is burned in silently. Matching values
                  // mean the covered pixel is no better evidence than the observation just rejected, so
                  // it is demoted to provisional — not overwritten, just marked open for healing by a
                  // later consistent look. Genuine page content is only ever demoted when a clean frame
                  // was itself falsely flagged, and the very next consistent observation clears it again.
                  // BIT-IDENTICAL, deliberately, and not the mask's own tolerance (which is the source's
                  // declared decode noise, MediaInfo.noise): that tolerance also covers "genuinely
                  // different content, but not by much", which is precisely what the block-level
                  // conflict logic above exists to arbitrate.
                  if (bad && !wasProvisional && pixels32[dst] === source32[src]) {
                    markProvisional(tile, dst);
                    stats.provisionalPixels++;
                    provisionalInBlock++;
                    changed = true;
                  }
                  continue;
                }
                pixels32[dst] = source32[src];
                if (fresh) {
                  markCovered(tile, dst);
                  stats.added++;
                  if (p.uncertain) stats.uncertain++;
                }
                if (bad) {
                  if (!wasProvisional) {
                    markProvisional(tile, dst);
                    stats.provisionalPixels++;
                    provisionalInBlock++;
                  }
                } else if (wasProvisional) {
                  clearProvisional(tile, dst);
                  stats.provisionalPixels--;
                  provisionalInBlock--;
                }
                changed = true;
              }
            }
          }
          if (replace || !tile.owner[q]) {
            tile.quality[q] = Math.round(p.confidence * 255);
            tile.owner[q] = frame + 1;
            tile.score[q] = score;
          } else if (p.uncertain) {
            tile.quality[q] = tile.owner[q] ? Math.min(tile.quality[q], Math.round(p.confidence * 255)) : Math.round(p.confidence * 255);
          }
          // The provisional cap is intentionally lossy. Once the last bit is healed by a corroborated,
          // non-uncertain observation, restore the quality evidence instead of leaving the block at 64 forever.
          if (hadProvisional && !provisionalInBlock && !p.uncertain) {
            tile.quality[q] = Math.max(tile.quality[q], Math.round(p.confidence * 255));
          }
          // A block still carrying any unhealed provisional pixel never reports a healthy quality score,
          // so the quality overlay (src/ui/viewer.ts) keeps flagging it until a consistent observation heals it.
          if (provisionalInBlock) {
            tile.quality[q] = Math.min(tile.quality[q], 64);
          }
        }
      }
      if (changed) {
        tile.dirty = true;
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
        const [ax, ay] = a.split(',').map(Number),
          [bx, by] = b.split(',').map(Number),
          atx = Math.floor(ax / blocks),
          btx = Math.floor(bx / blocks),
          aty = Math.floor(ay / blocks),
          bty = Math.floor(by / blocks);
        return aty - bty || atx - btx || (ay - aty * blocks) - (by - bty * blocks) || (ax - atx * blocks) - (bx - btx * blocks);
      });
      const components = this.components(new Set(orderedConflictBlocks), B);
      let patchedPixels = 0, patchedTiles = 0, patchedConflictPixels = 0, patchedProvisional = 0;
      for (const component of components) {
        const result = await this.resolveTemporal(image, region, p, frame, component.bounds, component.blocks, world, consistent);
        patchedPixels += result.added;
        patchedTiles += result.newTiles;
        // A pixel count (F8/F12 fix) — folding in a block count instead understates conflict pixels by roughly
        // a factor of 256 (one QUALITY_BLOCK). Still coarser than a mismatch-pixel count
        // (see PatchResult.conflictPixels): every pixel this patch rewrote, not only the ones that differed.
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
  private components(cells: Set<string>, size: number): { bounds: Rect; blocks: Set<string> }[] {
    const out: { bounds: Rect; blocks: Set<string> }[] = [];
    while (cells.size) {
      const first = cells.values().next().value!, queue = [first], comp = new Set<string>([first]);
      cells.delete(first);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < queue.length; i++) {
        const [x, y] = queue[i].split(',').map(Number);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const key = `${x + dx},${y + dy}`;
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
    compBlocks: Set<string>,
    visible: Rect,
    consistent?: Uint8Array,
  ): Promise<PatchResult> {
    const B = QUALITY_BLOCK;
    const olds: TemporalRegion[] = [];
    for await (const { value: t } of iterate<TemporalRegion>(this.db, `temporal/${p.canvasId}/`)) {
      const expanded = { x: t.rect.x - 16, y: t.rect.y - 16, width: t.rect.width + 32, height: t.rect.height + 32 };
      const ix = intersect(expanded, compBounds);
      if (ix.width > 0 && ix.height > 0) {
        olds.push(t);
      }
    }
    const mask = new Set<string>(compBlocks), previousMask = new Set<string>();
    let rect = compBounds;
    for (const o of olds) {
      rect = union(rect, o.rect);
      for (const [x, y] of o.blocks) {
        const key = `${x},${y}`;
        mask.add(key);
        previousMask.add(key);
      }
    }
    const old = olds[0];
    const maskBlocks: [number, number][] = [...mask].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y] as [number, number];
    }).sort(([ax, ay], [bx, by]) => ay - by || ax - bx);
    const previousBlocks: [number, number][] = [...previousMask].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y] as [number, number];
    });
    const geometryChanged = !old || rect.x !== old.rect.x || rect.y !== old.rect.y || rect.width !== old.rect.width ||
      rect.height !== old.rect.height;
    // `olds` can contain multiple nearby records. Compare against their union, not just `olds[0]`, and compare
    // actual membership so equal bboxes/cardinalities cannot preserve a stale complete=true state.
    const membershipChanged = !old || !sameBlockSet(maskBlocks, previousBlocks);
    const expanded = geometryChanged || membershipChanged;
    const record: TemporalRegion = old ? { ...old, rect, blocks: maskBlocks } : {
      id: pad(this.temporalSequence++),
      canvasId: p.canvasId,
      rect,
      blocks: maskBlocks,
      chosenFrame: frame,
      chosenTime: p.time,
      complete: false,
      revisions: 0,
    };
    if (expanded) {
      record.complete = false;
    }
    // Ensure the entire tracked patch is visible this frame. Evaluated over the block mask, not the bounding rect,
    // so a stable pixel-identical corner block in a concave conflict never gates or gets rewritten.
    let complete = true;
    const writeBlocks: [number, number][] = [];
    for (const [bx, by] of maskBlocks) {
      const ix = intersect({ x: bx * B, y: by * B, width: B, height: B }, visible);
      if (ix.width === B && ix.height === B) {
        writeBlocks.push([bx, by]);
      } else {
        complete = false;
      }
    }
    const choose = complete && (!old || !old.complete || expanded || this.policy === 'latest');
    let result: PatchResult = { added: 0, conflictPixels: 0, newTiles: 0, provisionalPixels: 0 };
    if (choose) {
      // Ensure the entire patch belongs to this pane AND is world-consistent everywhere: an observation
      // containing a cursor/FAB is not a good "complete moment" even when it is the first full view of this
      // region, so a consistency failure here refuses the patch exactly like a mask hole does. A block can
      // also contain an unknown mask hole.
      let maskComplete = true;
      const { rasterX: ox, rasterY: oy } = resolveRasterPose(p.x, p.y), code = this.atlas.code(region);
      for (let k = 0; k < writeBlocks.length && maskComplete; k++) {
        const [bx, by] = writeBlocks[k];
        for (let y = by * B; y < by * B + B && maskComplete; y++) {
          for (let x = bx * B; x < bx * B + B; x++) {
            if (
              !this.atlas.contains(code, x - ox, y - oy) || occluded(p.occlusions, x - ox, y - oy) ||
              (consistent && consistent[(y - oy) * image.width + (x - ox)] !== 1)
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
    await this.db.put(`temporal/${p.canvasId}/${record.id}`, record);
    for (const o of olds) {
      if (o.id !== record.id) {
        await this.db.delete(`temporal/${p.canvasId}/${o.id}`);
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
      // frame's own conflict detection required overlap ≥ 12 to flag it (see add()), or it carries forward an
      // earlier resolveTemporal record, which itself only ever wrote pixels the same way. The tile this block
      // sits on is therefore never new here, so there is no newTiles bookkeeping to do.
      if (changed) {
        tile.dirty = true;
      }
    }
    return { added, conflictPixels, newTiles: 0, provisionalPixels };
  }
}
