import type { CanvasMeta, Placement, Region } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import type { RegionAtlas } from '../core/layers.ts';
import { pngTileCodec, type StoredTile, type TileIndex } from '../storage/tiles.ts';
import { type Layer, renderFrame, type Scenario } from './world.ts';
export interface Observation {
  frame: number;
  time: number;
  decisions: {
    canvasId: string;
    placement: Placement;
    addedPixels: number;
    conflictPixels: number;
    uncertainPixels: number;
    skipped?: boolean;
  }[];
}
/** What the verifier needs from a finished run, whether it ran in Deno (MemoryKV) or in a browser (IndexedDB). */
export interface VerifiableRun {
  scenario: Scenario;
  store: KV;
  canvases: CanvasMeta[];
  observations: Observation[];
  regions: Region[];
  atlas: RegionAtlas;
  tileSize: number;
}
function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
/** The engine region that best matches a scenario layer's viewport. */
export function matchRegion(result: VerifiableRun, layer: Layer, kind: Region['kind'] = 'moving'): Region {
  const candidates = result.regions.filter((r) => r.kind === kind).map((r) => ({ r, overlap: overlapArea(r.rect, layer.viewport) })).sort((
    a,
    b,
  ) => b.overlap - a.overlap);
  if (!candidates.length || candidates[0].overlap <= 0) {
    throw new Error(
      `No ${kind} region overlaps layer ${layer.id}. Regions: ${
        JSON.stringify(result.regions.map((r) => ({ id: r.id, kind: r.kind, rect: r.rect })))
      }`,
    );
  }
  return candidates[0].r;
}
export interface LayerReport {
  regionId: string;
  mainCanvas: CanvasMeta;
  fragments: CanvasMeta[];
  framesOnMain: number;
  framesOnFragments: number;
  /** Textureless observations that were counted but not painted anywhere. */
  skipped: number;
  maxError: number;
  meanError: number;
  /** Placement error per frame placed on the main canvas (Infinity for magnified frames). */
  errors: number[];
  /** Pixels expected from geometry but absent from the canvas. */
  missing: number;
  /** Covered pixels outside any observed viewport. */
  invented: number;
  /** Covered pixels whose value matches no content version and that no overlay could explain. */
  mismatched: number;
  /** Covered pixels that differ from the page but were under an overlay or dynamic region in some observing frame. */
  contaminated: number;
  covered: number;
  expected: number;
  /** Body pixels the atlas assigned to this region (per frame). */
  regionPixels: number;
}
export async function verifyLayer(result: VerifiableRun, layer: Layer, options: { tolerance?: number } = {}): Promise<LayerReport> {
  const { scenario, atlas, store } = result,
    region = matchRegion(result, layer),
    code = atlas.code(region),
    tolerance = options.tolerance ?? 0;
  const mainId = `${region.id}-part-0`, mainCanvas = result.canvases.find((c) => c.id === mainId);
  if (!mainCanvas) {
    throw new Error(`Main canvas ${mainId} missing.`);
  }
  const fragments = result.canvases.filter((c) => c.layer === region.id && c.fragment > 0);
  const path0 = layer.path[0], v = layer.viewport, W = scenario.width;
  const errors: number[] = [];
  let framesOnMain = 0, framesOnFragments = 0, skipped = 0;
  const onMain = new Set<number>();
  for (const o of result.observations) {
    const d = o.decisions.find((x) => x.placement.layer === region.id);
    if (!d) {
      continue;
    }
    if (d.placement.skip) {
      skipped++;
      continue;
    }
    if (d.canvasId !== mainId) {
      framesOnFragments++;
      continue;
    }
    framesOnMain++;
    onMain.add(o.frame);
    const zoom = layer.zoom?.[o.frame] ?? 1;
    if (zoom !== 1) {
      errors.push(Infinity);
    } else {
      errors.push(Math.hypot(d.placement.x - (layer.path[o.frame].x - path0.x), d.placement.y - (layer.path[o.frame].y - path0.y)));
    }
  }
  // Expected coverage: every atlas pixel of this region, shifted by the true pose of each frame placed on the main canvas.
  const b = mainCanvas.bounds,
    bw = Math.max(1, Math.ceil(b.width) + 2),
    bh = Math.max(1, Math.ceil(b.height) + 2),
    bx = Math.floor(b.x) - 1,
    by = Math.floor(b.y) - 1;
  const expected = new Uint8Array(bw * bh), contaminatedWorld = new Set<number>();
  const worldW = layer.world.width;
  let regionPixels = 0;
  for (let y = 0; y < scenario.height; y++) {
    for (let x = 0; x < scenario.width; x++) {
      if (atlas.labels[y * W + x] === code) {
        regionPixels++;
      }
    }
  }
  for (const frame of onMain) {
    const p = layer.path[frame], px = p.x - path0.x, py = p.y - path0.y, rendered = renderFrame(scenario, frame);
    for (let y = v.y; y < v.y + v.height; y++) {
      for (let x = v.x; x < v.x + v.width; x++) {
        if (atlas.labels[y * W + x] !== code) {
          continue;
        }
        const cx = x + px - bx, cy = y + py - by;
        if (cx >= 0 && cy >= 0 && cx < bw && cy < bh) {
          expected[cy * bw + cx] = 1;
        }
      }
    }
    for (const r of rendered.overlayRects) {
      for (let y = Math.max(r.y, v.y); y < Math.min(r.y + r.height, v.y + v.height); y++) {
        for (let x = Math.max(r.x, v.x); x < Math.min(r.x + r.width, v.x + v.width); x++) {
          contaminatedWorld.add((y - v.y + p.y) * worldW + (x - v.x + p.x));
        }
      }
    }
    for (const r of rendered.dynamicRects[layer.id] || []) {
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          contaminatedWorld.add(y * worldW + x);
        }
      }
    }
  }
  let missing = 0, invented = 0, mismatched = 0, contaminated = 0, covered = 0, expectedCount = 0;
  for (let i = 0; i < expected.length; i++) {
    expectedCount += expected[i];
  }
  const size = result.tileSize;
  for await (const { value: t } of iterate<TileIndex>(store, `tile-index/${mainId}/0/`)) {
    const stored = await store.get<StoredTile>(`tile/${mainId}/0/${t.x}_${t.y}`);
    if (!stored) {
      throw new Error('Indexed tile is missing.');
    }
    const pixels = await pngTileCodec.decode(stored.blob, size);
    for (let i = 0; i < size * size; i++) {
      if (!(stored.coverage[i >> 3] & (1 << (i & 7)))) {
        continue;
      }
      covered++;
      const cx = t.x * size + (i % size), cy = t.y * size + Math.floor(i / size), ex = cx - bx, ey = cy - by;
      const isExpected = ex >= 0 && ey >= 0 && ex < bw && ey < bh && expected[ey * bw + ex];
      if (!isExpected) {
        invented++;
        continue;
      }
      expected[ey * bw + ex] = 2;
      const wx = cx + path0.x - v.x, wy = cy + path0.y - v.y;
      const versions = wx >= 0 && wy >= 0 && wx < layer.world.width && wy < layer.world.height
        ? layer.world.versions(wx, wy)
        : [scenario.background];
      const r = pixels[i * 4], g = pixels[i * 4 + 1], bl = pixels[i * 4 + 2];
      const ok = pixels[i * 4 + 3] === 255 &&
        versions.some((c) => Math.abs(c[0] - r) <= tolerance && Math.abs(c[1] - g) <= tolerance && Math.abs(c[2] - bl) <= tolerance);
      if (ok) {
        continue;
      }
      if (contaminatedWorld.has(wy * worldW + wx)) {
        contaminated++;
      } else {
        mismatched++;
      }
    }
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === 1) {
      missing++;
    }
  }
  const finite = errors.filter(Number.isFinite);
  return {
    regionId: region.id,
    mainCanvas,
    fragments,
    framesOnMain,
    framesOnFragments,
    skipped,
    errors,
    maxError: finite.length ? Math.max(...finite) : 0,
    meanError: finite.length ? finite.reduce((s, x) => s + x, 0) / finite.length : 0,
    missing,
    invented,
    mismatched,
    contaminated,
    covered,
    expected: expectedCount,
    regionPixels,
  };
}
/** Static overlays must land in fixed canvases with identical pixels and zero conflicts. */
export async function verifyFixed(
  result: VerifiableRun,
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ canvas: CanvasMeta; mismatched: number; covered: number; conflicts: number }> {
  const { scenario, atlas, store } = result;
  const regions = result.regions.filter((r) => r.kind === 'fixed');
  const first = renderFrame(scenario, 0).image;
  let mismatched = 0, covered = 0, conflicts = 0, best: CanvasMeta | undefined, bestOverlap = 0;
  for (const region of regions) {
    const canvas = result.canvases.find((c) => c.layer === region.id && c.fragment === 0);
    if (!canvas) {
      continue;
    }
    const overlap = overlapArea(region.rect, rect);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = canvas;
    }
  }
  if (!best) {
    throw new Error('No fixed canvas overlaps the overlay.');
  }
  const code = atlas.code(result.regions.find((r) => r.id === best!.layer)!), size = result.tileSize;
  for await (const { value: t } of iterate<TileIndex>(store, `tile-index/${best.id}/0/`)) {
    const stored = (await store.get<StoredTile>(`tile/${best.id}/0/${t.x}_${t.y}`))!, pixels = await pngTileCodec.decode(stored.blob, size);
    for (let i = 0; i < size * size; i++) {
      if (!(stored.coverage[i >> 3] & (1 << (i & 7)))) {
        continue;
      }
      const x = t.x * size + (i % size), y = t.y * size + Math.floor(i / size);
      if (
        x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height || atlas.labels[y * scenario.width + x] !== code
      ) {
        continue;
      }
      covered++;
      const j = (y * scenario.width + x) * 4;
      if (pixels[i * 4] !== first.data[j] || pixels[i * 4 + 1] !== first.data[j + 1] || pixels[i * 4 + 2] !== first.data[j + 2]) {
        mismatched++;
      }
    }
    for (const c of stored.conflicts || []) {
      conflicts += c;
    }
  }
  return { canvas: best, mismatched, covered, conflicts };
}
