import type { CanvasMeta, Rect, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import { countCovered, type TileIndex, type TileStore } from '../storage/tiles.ts';
import { decodePNG } from '../codec/png.ts';
import { intersect } from './math.ts';
import { core, type FrameLayout, type SourceFramingTile } from './wasm.ts';

export type { FrameLayout } from './wasm.ts';

/** Presentation is deliberately separate from reconstruction. No toolbar is translated into world coordinates,
 * no sidebar icons are stretched or repeated, and background extensions never count as observed evidence.
 * Layout/coordinate mapping, background statistics and per-tile pixel synthesis are Rust (rust/core/src/framing.rs,
 * docs/ARCHITECTURE.md §十 "呈现画布"); this module keeps the orchestration — tile-index/candidate traversal,
 * TileStore get/save, KV writes, checkpoint/progress and the PRESENTATION_TOO_SPARSE skip. */
export function frameLayout(source: RGBA, region: Region, canvas: CanvasMeta): FrameLayout {
  return core().frameLayout(source, region.crop || region.rect, canvas.bounds.width, canvas.bounds.height);
}
/** Native source coordinate for a context pixel; undefined is a decorative extension, null is reconstructed
 * content. Test/diagnostic use only — `buildFramedCanvas`'s per-tile loop classifies pixels inline in Rust. */
export function frameCoordinate(layout: FrameLayout, x: number, y: number): { x: number; y: number } | undefined | null {
  return core().frameCoordinate(layout, x, y);
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
  const size = tiles.size;
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
  // One resident copy of the reference frame and its background statistics for the whole canvas (never a
  // per-tile upload); disposed in `finally` on every exit path, including the maxTiles/error paths above.
  const session = core().openFramingSession(source, layout, ignored, size);
  try {
    // Tilewise traversal: at most four raw input tiles per output tile. Never allocate a giant output canvas or a full output row.
    for (const [tx, ty] of candidates) {
      await checkpoint();
      const bounds = boundsFor(tx, ty), tile = await tiles.get(meta.id, tx, ty);
      session.paintTile(tile, bounds);
      const overlap = intersect(bounds, content);
      if (overlap.width > 0 && overlap.height > 0) {
        const wx = Math.floor(sourceCanvas.bounds.x + overlap.x - content.x),
          wy = Math.floor(sourceCanvas.bounds.y + overlap.y - content.y);
        // TS still decides WHICH ≤4 source tiles overlap this output tile (same grid arithmetic the pre-check
        // above uses to decide candidacy) and fetches them through the shared LRU, preserving its hit/eviction
        // order; Rust re-derives the same per-pixel `part` rects from `wx`/`wy` and folds them in one call.
        const sources: SourceFramingTile[] = [];
        for (let sy = Math.floor(wy / size); sy <= Math.floor((wy + overlap.height - 1) / size); sy++) {
          for (let sx = Math.floor(wx / size); sx <= Math.floor((wx + overlap.width - 1) / size); sx++) {
            if (!existingSourceTiles.has(`${sx}_${sy}`)) continue;
            const raw = await tiles.get(sourceCanvas.id, sx, sy);
            sources.push({ sx, sy, ...raw });
          }
        }
        if (sources.length) session.foldEvidence(tile, bounds, sourceCanvas.bounds.x, sourceCanvas.bounds.y, sources);
      }
      const dst = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.pixels.length / 4);
      if (dst.some((w) => w >>> 24)) {
        tile.dirty = true;
        tile.touched = performance.now();
        meta.tileCount++;
        meta.observedPixels += countCovered(tile.coverage);
        meta.provisionalPixels += countCovered(tile.provisional);
        await tiles.save(tile);
      }
    }
  } finally {
    session.dispose();
  }
  // The aggregate uncertainty/conflict counters above describe the source run and are preserved in `meta`; coverage
  // and provisional counts are recomputed from the exact pixels copied into this presentation. Decorative pixels are
  // intentionally covered for display provenance but do not inherit source quality or ownership evidence.
  await store.put(`canvas/${meta.id}`, meta);
  return meta;
}
