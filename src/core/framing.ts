import type { CanvasMeta, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { covered, markCovered, TileStore } from '../storage/tiles.ts';
import { decodePNG } from '../codec/png.ts';
import { intersect } from './math.ts';
import { regionContains } from './layers.ts';

/** Presentation is deliberately separate from reconstruction. No toolbar is translated into world coordinates,
 * no sidebar icons are stretched or repeated, and background extensions never count as observed evidence. */
export interface FrameLayout {
  width: number;
  height: number;
  pane: Rect;
  content: Rect;
  dx: number;
  dy: number;
  seamX: number;
}
export function frameLayout(source: RGBA, region: Region, canvas: CanvasMeta): FrameLayout {
  const pane = region.crop || region.rect;
  const content = {
    x: pane.x,
    y: pane.y,
    width: Math.max(pane.width, Math.ceil(canvas.bounds.width)),
    height: Math.max(pane.height, Math.ceil(canvas.bounds.height)),
  };
  return {
    width: source.width + content.width - pane.width,
    height: source.height + content.height - pane.height,
    pane,
    content,
    dx: content.width - pane.width,
    dy: content.height - pane.height,
    seamX: Math.floor(pane.x + pane.width / 2),
  };
}
/** Native source coordinate for a context pixel; undefined is a decorative extension, null is reconstructed content. */
export function frameCoordinate(layout: FrameLayout, x: number, y: number): { x: number; y: number } | undefined | null {
  const { pane: p, content: c, dx, dy, seamX } = layout;
  if (x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height) return null;
  if (y < p.y || y >= c.y + c.height) {
    const sy = y < p.y ? y : y - dy;
    if (x >= seamX && x < seamX + dx) return undefined;
    return { x: x < seamX ? x : x - dx, y: sy };
  }
  if (y >= p.y + p.height) return undefined;
  return { x: x < p.x ? x : x - dx, y };
}
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0] || 0, count = 0;
  for (const v of values) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > count) {
      count = n;
      best = v;
    }
  }
  return best;
}
function backgrounds(image: RGBA, pane: Rect): { rows: Uint32Array; columns: Uint32Array } {
  const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  const rows = new Uint32Array(image.height), columns = new Uint32Array(image.width);
  const xs = Math.max(1, Math.floor(pane.width / 128)), ys = Math.max(1, Math.floor(pane.height / 128));
  for (let y = 0; y < image.height; y++) {
    const samples: number[] = [];
    for (let x = pane.x; x < pane.x + pane.width; x += xs) samples.push(pixels[y * image.width + x]);
    rows[y] = mode(samples);
  }
  for (let x = 0; x < image.width; x++) {
    const samples: number[] = [];
    for (let y = pane.y; y < pane.y + pane.height; y += ys) samples.push(pixels[y * image.width + x]);
    columns[x] = mode(samples);
  }
  return { rows, columns };
}
export async function buildFramedCanvas(
  store: KV,
  tiles: TileStore,
  sourceCanvas: CanvasMeta,
  region: Region,
  regions: Region[],
  checkpoint: () => Promise<void>,
): Promise<CanvasMeta | undefined> {
  const reference = await store.get<{ frame: number; image: Blob }>('frame-reference');
  if (!reference || !sourceCanvas.tileCount || sourceCanvas.attachedTo) return;
  const source = await decodePNG(new Uint8Array(await reference.image.arrayBuffer()));
  const layout = frameLayout(source, region, sourceCanvas), { content, pane } = layout;
  if (pane.x === 0 && pane.y === 0 && pane.width === source.width && pane.height === source.height) return;
  const meta: CanvasMeta = {
    ...sourceCanvas,
    id: `${sourceCanvas.id}-framed`,
    name: `${sourceCanvas.name} · 保留外框`,
    kind: 'presentation',
    bounds: { x: 0, y: 0, width: layout.width, height: layout.height },
    tileCount: 0,
    maxLevel: 0,
    observedPixels: 0,
    uncertainPixels: 0,
    conflictPixels: 0,
    presentation: {
      sourceCanvas: sourceCanvas.id,
      sourceRegion: pane,
      referenceFrame: reference.frame,
      offset: { x: content.x - sourceCanvas.bounds.x, y: content.y - sourceCanvas.bounds.y },
      extension:
        'Native-scale reference chrome shown once; flat background-only extensions are presentation, NOT observed world content. Other panes in the frame are reference snapshots, NOT merged trajectories. Coverage bits mark copied evidence; opaque extension pixels are deliberately not covered.',
    },
  };
  const bg = backgrounds(source, pane),
    sourcePixels = new Uint32Array(source.data.buffer, source.data.byteOffset, source.data.length / 4),
    size = tiles.size;
  const ignored = regions.filter((r) => r.kind === 'ignore');
  // Tilewise traversal: at most four raw input tiles per output tile. Never allocate a giant output canvas or a full output row.
  for (let ty = 0; ty < Math.ceil(layout.height / size); ty++) {
    for (let tx = 0; tx < Math.ceil(layout.width / size); tx++) {
      await checkpoint();
      const tile = await tiles.get(meta.id, tx, ty),
        dst = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.pixels.length / 4);
      const bounds = {
        x: tx * size,
        y: ty * size,
        width: Math.min(size, layout.width - tx * size),
        height: Math.min(size, layout.height - ty * size),
      };
      for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
          const ox = bounds.x + x, oy = bounds.y + y, p = frameCoordinate(layout, ox, oy), at = y * size + x;
          if (p === null) continue;
          if (p) {
            if (ignored.some((r) => regionContains(r, p.x, p.y, source.width, source.height))) continue;
            dst[at] = sourcePixels[p.y * source.width + p.x];
            if (tile.pixels[at * 4 + 3]) markCovered(tile, at);
          } else if (oy < pane.y || oy >= content.y + content.height) {
            dst[at] = bg.rows[oy < pane.y ? oy : oy - layout.dy];
          } else {
            dst[at] = bg.columns[ox < pane.x ? ox : ox - layout.dx];
          }
        }
      }
      const overlap = intersect(bounds, content);
      if (overlap.width > 0 && overlap.height > 0) {
        const wx = Math.floor(sourceCanvas.bounds.x + overlap.x - content.x),
          wy = Math.floor(sourceCanvas.bounds.y + overlap.y - content.y);
        for (let sy = Math.floor(wy / size); sy <= Math.floor((wy + overlap.height - 1) / size); sy++) {
          for (let sx = Math.floor(wx / size); sx <= Math.floor((wx + overlap.width - 1) / size); sx++) {
            const raw = await tiles.get(sourceCanvas.id, sx, sy);
            const part = intersect({ x: wx, y: wy, width: overlap.width, height: overlap.height }, {
              x: sx * size,
              y: sy * size,
              width: size,
              height: size,
            });
            for (let y = part.y; y < part.y + part.height; y++) {
              const dy = overlap.y - bounds.y + y - wy, dx = overlap.x - bounds.x + part.x - wx;
              const from = (y - sy * size) * size + part.x - sx * size;
              tile.pixels.set(raw.pixels.subarray(from * 4, (from + part.width) * 4), (dy * size + dx) * 4);
              for (let x = 0; x < part.width; x++) if (covered(raw, from + x)) markCovered(tile, dy * size + dx + x);
            }
          }
        }
      }
      if (
        tile.pixels.some((a, i) => i % 4 === 3 && a !== 0)
      ) {
        tile.dirty = true;
        meta.tileCount++;
        await tiles.save(tile);
      }
    }
  }
  // Presentation evidence must not inflate reconstructed-pixel totals; provenance lives in presentation + coverage.
  await store.put(`canvas/${meta.id}`, meta);
  return meta;
}
