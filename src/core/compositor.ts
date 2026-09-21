import type { CanvasMeta, Diagnostic, Placement, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { covered, markCovered, QUALITY_BLOCK, type TileStore } from '../storage/tiles.ts';
import type { RegionAtlas } from './layers.ts';
import { intersect, pad, union } from './math.ts';
interface TemporalRegion {
  id: string;
  canvasId: string;
  rect: Rect;
  chosenFrame: number;
  chosenTime: number;
  complete: boolean;
  revisions: number;
}
export interface CompositeStats {
  added: number;
  conflicts: number;
  uncertain: number;
  tiles: number;
  bounds: Rect;
}
/** Pixel ownership, not alpha blending. Conflicting moving objects are selected as whole observed patches. */
export class Compositor {
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
  async add(image: RGBA, region: Region, p: Placement, frame: number, meta: CanvasMeta): Promise<CompositeStats> {
    const size = this.tiles.size, B = QUALITY_BLOCK, blocks = size / B, ox = Math.round(p.x), oy = Math.round(p.y);
    if (image.width !== this.atlas.width || image.height !== this.atlas.height) {
      throw new Error(`Frame is ${image.width}×${image.height} but the region atlas is ${this.atlas.width}×${this.atlas.height}.`);
    }
    const code = this.atlas.code(region),
      labels = this.atlas.labels,
      W = image.width,
      H = image.height,
      rectangular = this.rectangular.has(region.id);
    const world = { x: region.rect.x + ox, y: region.rect.y + oy, width: region.rect.width, height: region.rect.height };
    const stats: CompositeStats = { added: 0, conflicts: 0, uncertain: 0, tiles: 0, bounds: world };
    const conflictBlocks = new Set<string>();
    const source32 = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
    const x0 = Math.floor(world.x / size),
      x1 = Math.floor((world.x + world.width - 1) / size),
      y0 = Math.floor(world.y / size),
      y1 = Math.floor((world.y + world.height - 1) / size);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
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
            let mismatch = 0, overlap = 0, sharpness = 0, count = 0, identical = 0;
            const sy0 = Math.ceil(Math.max(by * B, world.y - ty * size)),
              sy1 = Math.ceil(Math.min((by + 1) * B, world.y + world.height - ty * size));
            const sx0 = Math.ceil(Math.max(bx * B, world.x - tx * size)),
              sx1 = Math.ceil(Math.min((bx + 1) * B, world.x + world.width - tx * size));
            for (let y = sy0; y < sy1; y++) {
              const sy = ty * size + y - oy;
              if (
                p.occlusions?.some((r) =>
                  sy >= r.y && sy < r.y + r.height && r.x <= region.rect.x && r.x + r.width >= region.rect.x + region.rect.width
                )
              ) continue;
              if (sy < 0 || sy >= H) {
                continue;
              }
              for (let x = sx0; x < sx1; x++) {
                const sx = tx * size + x - ox;
                if (sx < 0 || sx >= W) {
                  continue;
                }
                const src = sy * W + sx;
                if (!rectangular && labels[src] !== code) {
                  continue;
                }
                const dst = y * size + x, i = dst * 4, j = src * 4;
                count++;
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
            // Exact native-pixel equality, not a similarity threshold. Preserve ownership and skip all writes.
            if (identical === count) continue;
            const conflict = overlap >= 12 && mismatch / overlap > .16;
            const complete = count === B * B;
            const edge = Math.min(
              (tx * size + bx * B) - world.x,
              (ty * size + by * B) - world.y,
              world.x + world.width - (tx * size + (bx + 1) * B),
              world.y + world.height - (ty * size + (by + 1) * B),
            );
            if ((!conflict && !tile.frozen[q] && complete) || !tile.owner[q]) {
              for (let y = sy0; y < sy1; y++) {
                const sy = ty * size + y - oy;
                if (
                  p.occlusions?.some((r) =>
                    sy >= r.y && sy < r.y + r.height && r.x <= region.rect.x && r.x + r.width >= region.rect.x + region.rect.width
                  )
                ) continue;
                for (let x = sx0; x < sx1; x++) {
                  const sx = tx * size + x - ox, src = sy * W + sx, j = src * 4;
                  if (sx > 0 && sx < W - 1 && (rectangular || labels[src] === code)) {
                    sharpness += Math.abs(image.data[j - 4] - image.data[j + 4]);
                  }
                }
              }
            }
            const score = p.confidence * 100 + Math.min(12, sharpness / count * .15) + Math.min(6, Math.max(0, edge) / 40);
            const replace = complete && !conflict && !tile.frozen[q] && score > tile.score[q] + 4;
            if (conflict) {
              tile.conflicts[q] = 1;
              conflictBlocks.add(`${tx * blocks + bx},${ty * blocks + by}`);
              stats.conflicts += mismatch;
              changed = true;
            }
            if (replace || overlap < count) {
              for (let y = sy0; y < sy1; y++) {
                const sy = ty * size + y - oy;
                if (
                  p.occlusions?.some((r) =>
                    sy >= r.y && sy < r.y + r.height && r.x <= region.rect.x && r.x + r.width >= region.rect.x + region.rect.width
                  )
                ) continue;
                const srcRow = sy * W + tx * size - ox, dstRow = y * size;
                for (let x = sx0; x < sx1; x++) {
                  const dst = dstRow + x, src = srcRow + x;
                  if (!rectangular && labels[src] !== code) continue;
                  const fresh = !covered(tile, dst);
                  if (!fresh && !replace) continue;
                  pixels32[dst] = source32[src];
                  if (fresh) {
                    markCovered(tile, dst);
                    stats.added++;
                    if (p.uncertain) stats.uncertain++;
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
              tile.quality[q] = Math.min(tile.quality[q] || 255, Math.round(p.confidence * 255));
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
    }
    if (conflictBlocks.size) {
      const components = this.components(conflictBlocks, B);
      for (const rect of components) {
        if (rect.width * rect.height < 256) {
          continue;
        }
        await this.resolveTemporal(image, region, p, frame, rect, world);
      }
      await this.emit({
        code: 'TEMPORAL_OR_ALIGNMENT_CONFLICT',
        severity: 'warning',
        time: p.time,
        frame,
        canvasId: p.canvasId,
        region: world,
        confidence: p.confidence,
        message: `对齐后的重叠区域有 ${stats.conflicts.toLocaleString()} 个明显不同的像素。可能是动画、内容更新、重排或配准残差。`,
        action: this.policy === 'stable'
          ? '已尽量冻结单一时刻的完整冲突区域；查看橙色诊断和原视频时间点。'
          : '仅在完整可见时用同一帧更新整块冲突区域；并非全页面同一时刻。',
      });
    }
    meta.bounds = union(meta.bounds, world);
    meta.observedPixels += stats.added;
    meta.uncertainPixels += stats.uncertain;
    meta.conflictPixels += stats.conflicts;
    meta.tileCount += stats.tiles;
    meta.lastTime = p.time;
    return stats;
  }
  private components(blocks: Set<string>, size: number): Rect[] {
    const out: Rect[] = [];
    while (blocks.size) {
      const first = blocks.values().next().value!, queue = [first];
      blocks.delete(first);
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
            if (blocks.delete(key)) {
              queue.push(key);
            }
          }
        }
      }
      out.push({ x: x0 * size, y: y0 * size, width: (x1 - x0 + 1) * size, height: (y1 - y0 + 1) * size });
    }
    return out;
  }
  private async resolveTemporal(image: RGBA, region: Region, p: Placement, frame: number, rect: Rect, visible: Rect): Promise<void> {
    let old: TemporalRegion | undefined;
    for await (const { value: t } of iterate<TemporalRegion>(this.db, `temporal/${p.canvasId}/`)) {
      const expanded = { x: t.rect.x - 16, y: t.rect.y - 16, width: t.rect.width + 32, height: t.rect.height + 32 };
      if (intersect(expanded, rect).width > 0 && intersect(expanded, rect).height > 0) {
        old = t;
        break;
      }
    }
    const merged = old ? union(old.rect, rect) : rect, r = intersect(merged, visible);
    const complete = r.width === merged.width && r.height === merged.height;
    const expanded = !old || merged.x !== old.rect.x || merged.y !== old.rect.y || merged.width !== old.rect.width ||
      merged.height !== old.rect.height;
    const choose = complete && (!old || !old.complete || expanded || this.policy === 'latest');
    const record: TemporalRegion = old ||
      {
        id: pad(this.temporalSequence++),
        canvasId: p.canvasId,
        rect: merged,
        chosenFrame: frame,
        chosenTime: p.time,
        complete: false,
        revisions: 0,
      };
    record.rect = merged;
    if (expanded) {
      record.complete = false;
    }
    if (choose) {
      // Ensure the entire patch belongs to this pane. A bounding rectangle can contain an unknown mask hole.
      let maskComplete = true;
      const ox = Math.round(p.x), oy = Math.round(p.y), code = this.atlas.code(region);
      for (let y = r.y; y < r.y + r.height && maskComplete; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          if (
            !this.atlas.contains(code, x - ox, y - oy) ||
            p.occlusions?.some((o) => x - ox >= o.x && x - ox < o.x + o.width && y - oy >= o.y && y - oy < o.y + o.height)
          ) {
            maskComplete = false;
            break;
          }
        }
      }
      if (maskComplete) {
        await this.overwritePatch(image, p, r, frame);
        record.chosenFrame = frame;
        record.chosenTime = p.time;
        record.complete = true;
        record.revisions++;
      }
    }
    await this.db.put(`temporal/${p.canvasId}/${record.id}`, record);
    if (!record.complete && (!old || expanded)) {
      await this.emit({
        code: 'INCOMPLETE_TEMPORAL_PATCH',
        severity: 'warning',
        canvasId: p.canvasId,
        frame,
        time: p.time,
        region: merged,
        message: '这个变化区域从未完整地出现在一个可用视口中；无法保证其所有像素来自同一时刻。',
        action: '保留已观察内容和明确冲突标记，没有填造未观察部分。',
      });
    }
  }
  private async overwritePatch(image: RGBA, p: Placement, r: Rect, frame: number): Promise<void> {
    const size = this.tiles.size, ox = Math.round(p.x), oy = Math.round(p.y), B = QUALITY_BLOCK;
    for (let ty = Math.floor(r.y / size); ty <= Math.floor((r.y + r.height - 1) / size); ty++) {
      for (let tx = Math.floor(r.x / size); tx <= Math.floor((r.x + r.width - 1) / size); tx++) {
        const tile = await this.tiles.get(p.canvasId, tx, ty),
          part = intersect(r, { x: tx * size, y: ty * size, width: size, height: size });
        for (let y = part.y; y < part.y + part.height; y++) {
          for (let x = part.x; x < part.x + part.width; x++) {
            if (p.occlusions?.some((o) => x - ox >= o.x && x - ox < o.x + o.width && y - oy >= o.y && y - oy < o.y + o.height)) continue;
            const src = ((y - oy) * image.width + x - ox) * 4, dst = ((y - ty * size) * size + x - tx * size) * 4;
            if (src < 0 || src + 3 >= image.data.length) {
              continue;
            }
            tile.pixels[dst] = image.data[src];
            tile.pixels[dst + 1] = image.data[src + 1];
            tile.pixels[dst + 2] = image.data[src + 2];
            tile.pixels[dst + 3] = image.data[src + 3];
            markCovered(tile, dst / 4);
            const q = Math.floor((y - ty * size) / B) * (size / B) + Math.floor((x - tx * size) / B);
            tile.owner[q] = frame + 1;
            tile.quality[q] = Math.round(p.confidence * 255);
            tile.conflicts[q] = 1;
            if (this.policy === 'stable') {
              tile.frozen[q] = 1;
            }
          }
        }
        tile.dirty = true;
      }
    }
  }
}
