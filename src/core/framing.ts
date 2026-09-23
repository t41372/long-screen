import type { CanvasMeta, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import {
  countCovered,
  covered,
  markCovered,
  markProvisional,
  provisional,
  QUALITY_BLOCK,
  type TileIndex,
  type TileStore,
} from '../storage/tiles.ts';
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
/**
 * Composites the framed presentation canvas: native chrome plus decorative background-extension bands wrapped
 * around the live content rect. Cost is O(perimeter tiles + observed source tiles) by construction, never
 * O(bounding-box area / tile²): before touching an output tile a cheap pre-check (grid arithmetic and a Set
 * lookup only, no pixel work, no tile allocation) decides whether it can possibly be non-empty — either it
 * spills outside the content rect (chrome/decorative, always kept so the frame stays visually continuous) or
 * its content overlap lands on at least one source tile that actually exists. Tiles that fail both are skipped
 * with zero allocation. `options.maxTiles` bounds the (cheap) candidate count itself, so a pathological aspect
 * ratio can be rejected before any tile work starts.
 */
export async function buildFramedCanvas(
  store: KV,
  tiles: TileStore,
  sourceCanvas: CanvasMeta,
  region: Region,
  regions: Region[],
  checkpoint: () => Promise<void>,
  options?: { maxTiles?: number; onSkipped?: (reason: string) => void },
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
    // Recount the copied level-zero mask below; the source count includes pixels that may not land in this view.
    provisionalPixels: 0,
    // These counters are aggregate source-run diagnostics rather than tile-local masks. The framed canvas is a
    // presentation of the same reconstructed content, so preserve them instead of claiming that the evidence vanished.
    uncertainPixels: sourceCanvas.uncertainPixels,
    conflictPixels: sourceCanvas.conflictPixels,
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
  const cols = Math.ceil(layout.width / size), rows = Math.ceil(layout.height / size);
  const boundsFor = (tx: number, ty: number): Rect => ({
    x: tx * size,
    y: ty * size,
    width: Math.min(size, layout.width - tx * size),
    height: Math.min(size, layout.height - ty * size),
  });
  const maxTiles = options?.maxTiles ?? 20000;
  // Build a bounded candidate set instead of asking every output grid cell whether it is interesting. The
  // complement of the fully-contained content tiles is a perimeter ring (chrome/decorative pixels), and each
  // observed source tile maps to at most four output tiles because both grids have the same tile size.
  const candidates: Array<[number, number]> = [], candidateKeys = new Set<string>();
  const addCandidate = (tx: number, ty: number): boolean => {
    if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) return true;
    const key = `${tx}_${ty}`;
    if (candidateKeys.has(key)) return true;
    if (candidates.length >= maxTiles) return false;
    candidateKeys.add(key);
    candidates.push([tx, ty]);
    return true;
  };
  let candidateChecks = 0;
  const addRange = async (x0: number, x1: number, y0: number, y1: number): Promise<boolean> => {
    for (let ty = Math.max(0, y0); ty < Math.min(rows, y1); ty++) {
      for (let tx = Math.max(0, x0); tx < Math.min(cols, x1); tx++) {
        if (!addCandidate(tx, ty)) return false;
        if ((++candidateChecks & 255) === 0) await checkpoint();
      }
    }
    return true;
  };
  const bounded = (n: number, upper: number): number => Math.max(0, Math.min(upper, n));
  // A tile is fully inside content only when both of its edges are inside. Everything else belongs to the
  // perimeter candidate set; this also handles content rectangles whose edges cut through a tile.
  const innerX0 = bounded(Math.ceil(content.x / size), cols),
    innerX1 = bounded(Math.floor((content.x + content.width) / size), cols),
    innerY0 = bounded(Math.ceil(content.y / size), rows),
    innerY1 = bounded(Math.floor((content.y + content.height) / size), rows);
  await checkpoint();
  if (
    !await addRange(0, cols, 0, innerY0) || !await addRange(0, cols, innerY1, rows) ||
    !await addRange(0, innerX0, innerY0, innerY1) || !await addRange(innerX1, cols, innerY0, innerY1)
  ) {
    options?.onSkipped?.(`Framed canvas exceeded the ${maxTiles} tile limit; skipped before allocating output tiles.`);
    return undefined;
  }
  // Existing source tiles only: the content rect spans the whole reconstructed world, most of which was never
  // observed. Without this set, every grid cell under the content rect would materialise a phantom all-zero
  // source tile through the shared LRU just to find out it is empty. Read the index only after the perimeter
  // guard so a frame that is already too large never scans source storage or allocates a source tile.
  const existingSourceTiles = new Set<string>();
  let sourceTilesSeen = 0;
  const outputTileRange = (rect: Rect): [number, number, number, number] => [
    Math.floor(rect.x / size),
    Math.ceil((rect.x + rect.width) / size),
    Math.floor(rect.y / size),
    Math.ceil((rect.y + rect.height) / size),
  ];
  for await (const row of iterate<TileIndex>(store, `tile-index/${sourceCanvas.id}/0/`)) {
    if (row.value.observed > 0) existingSourceTiles.add(`${row.value.x}_${row.value.y}`);
  }
  for (const key of existingSourceTiles) {
    const [sx, sy] = key.split('_').map(Number);
    // World tile (sx, sy) is translated into the output content rect by the source canvas origin.
    const mapped = {
      x: content.x + sx * size - sourceCanvas.bounds.x,
      y: content.y + sy * size - sourceCanvas.bounds.y,
      width: size,
      height: size,
    };
    const overlap = intersect(mapped, content);
    if (overlap.width > 0 && overlap.height > 0) {
      const [x0, x1, y0, y1] = outputTileRange(overlap);
      if (!await addRange(x0, x1, y0, y1)) {
        options?.onSkipped?.(`Framed canvas exceeded the ${maxTiles} tile limit; skipped before allocating output tiles.`);
        return undefined;
      }
    }
    sourceTilesSeen++;
    if ((sourceTilesSeen & 255) === 0) await checkpoint();
  }
  // Tilewise traversal: at most four raw input tiles per output tile. Never allocate a giant output canvas or a full output row.
  for (const [tx, ty] of candidates) {
    await checkpoint();
    const bounds = boundsFor(tx, ty),
      tile = await tiles.get(meta.id, tx, ty),
      dst = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.pixels.length / 4);
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
      const evidence = new Map<number, { quality: number; score: number; owners: Set<number>; conflicts: boolean; frozen: boolean }>();
      const wx = Math.floor(sourceCanvas.bounds.x + overlap.x - content.x),
        wy = Math.floor(sourceCanvas.bounds.y + overlap.y - content.y);
      for (let sy = Math.floor(wy / size); sy <= Math.floor((wy + overlap.height - 1) / size); sy++) {
        for (let sx = Math.floor(wx / size); sx <= Math.floor((wx + overlap.width - 1) / size); sx++) {
          if (!existingSourceTiles.has(`${sx}_${sy}`)) continue;
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
            for (let x = 0; x < part.width; x++) {
              const sourcePixel = from + x, destinationPixel = dy * size + dx + x;
              tile.pixels.set(raw.pixels.subarray(sourcePixel * 4, sourcePixel * 4 + 4), destinationPixel * 4);
              if (covered(raw, sourcePixel)) {
                markCovered(tile, destinationPixel);
                const sourceBlock = Math.floor((part.x - sx * size + x) / QUALITY_BLOCK) +
                  Math.floor((y - sy * size) / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
                const destinationBlock = Math.floor((dx + x) / QUALITY_BLOCK) + Math.floor(dy / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
                let block = evidence.get(destinationBlock);
                if (!block) {
                  block = { quality: 255, score: Number.POSITIVE_INFINITY, owners: new Set<number>(), conflicts: false, frozen: false };
                  evidence.set(destinationBlock, block);
                }
                block.quality = Math.min(block.quality, raw.quality[sourceBlock]);
                block.score = Math.min(block.score, raw.score[sourceBlock]);
                block.owners.add(raw.owner[sourceBlock]);
                block.conflicts ||= !!raw.conflicts[sourceBlock];
                block.frozen ||= !!raw.frozen[sourceBlock];
              }
              if (provisional(raw, sourcePixel)) {
                markProvisional(tile, destinationPixel);
              }
            }
          }
        }
      }
      for (const [q, block] of evidence) {
        tile.quality[q] = block.quality;
        tile.score[q] = Number.isFinite(block.score) ? block.score : 0;
        tile.conflicts[q] = block.conflicts ? 1 : 0;
        tile.frozen[q] = block.frozen ? 1 : 0;
        tile.owner[q] = block.owners.size === 1 && !block.owners.has(0) ? [...block.owners][0] : 0;
      }
    }
    if (dst.some((w) => w >>> 24)) {
      tile.dirty = true;
      tile.touched = performance.now();
      meta.tileCount++;
      meta.observedPixels += countCovered(tile.coverage);
      meta.provisionalPixels += countCovered(tile.provisional);
      await tiles.save(tile);
    }
  }
  // The aggregate uncertainty/conflict counters above describe the source run and are preserved in `meta`; coverage
  // and provisional counts are recomputed from the exact pixels copied into this presentation. Decorative pixels are
  // intentionally covered for display provenance but do not inherit source quality or ownership evidence.
  await store.put(`canvas/${meta.id}`, meta);
  return meta;
}
