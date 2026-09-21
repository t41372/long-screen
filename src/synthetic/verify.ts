import type { CanvasMeta, Placement, Region } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import type { RegionAtlas } from '../core/layers.ts';
import { countCovered, pngTileCodec, type StoredTile, type TileIndex } from '../storage/tiles.ts';
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
export interface FragmentReport {
  canvasId: string;
  /** Frames whose resolved observation ledger entry points at this canvas. */
  frames: number;
  /** Placement error per frame, relative to this fragment's own local origin (Infinity for magnified frames). */
  maxError: number;
  missing: number;
  invented: number;
  mismatched: number;
  /** Equal to contaminatedOverlay + contaminatedDynamic; a pixel under both counts as overlay only. */
  contaminated: number;
  /** The `contaminated` subset explained by a screen-space overlay (never moves with the page): FAB, scrollbar,
   *  cursor, toast. The world-consistency mask targets this at 0. */
  contaminatedOverlay: number;
  /** contaminatedOverlay pixels whose world position was NEVER observed clean (on screen and outside every
   *  overlay/dynamic rect at once) in any frame this canvas recorded — a genuine source-material limitation, not
   *  a detection gap. Bounded by `analyticUnobservable`. */
  contaminatedOverlayUnobservable: number;
  /** contaminatedOverlay pixels whose world position WAS observed clean at least once — a real miss the engine
   *  should have healed. The target is 0. */
  contaminatedOverlayRecoverable: number;
  /** Of `contaminatedOverlayUnobservable`, how many carry the tile's provisional bit — report-only (not a target
   *  yet): a permanently-unobservable pixel being at least flagged provisional is honest, even though it can
   *  never be healed outright. */
  unobservableProvisional: number;
  /** Property of the scenario alone (every ever-visible pixel of this canvas's region, not just the contaminated
   *  ones) that were never observed clean: the analytic ceiling `contaminatedOverlayUnobservable` must not exceed. */
  analyticUnobservable: number;
  /** The `contaminated` subset explained only by a page-space dynamic (animated widget, live counter, caret,
   *  playing video). Legitimately allowed to keep one moment (docs/ARCHITECTURE.md §七). */
  contaminatedDynamic: number;
  covered: number;
  /** False when the fragment contains a magnified (zoom ≠ 1) frame: content is resampled, so only frame accounting
   *  and `CanvasMeta.observedPixels > 0` are meaningful; pixel-set/value checks are not attempted. */
  pixelChecked: boolean;
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
  /** Covered pixels that differ from the page but were under an overlay or dynamic region in some observing frame.
   *  Equal to contaminatedOverlay + contaminatedDynamic; a pixel under both counts as overlay only. */
  contaminated: number;
  /** The `contaminated` subset explained by a screen-space overlay (`rendered.overlayRects`): a FAB, scrollbar,
   *  cursor or toast, which never moves with the page. The world-consistency mask targets this at 0. */
  contaminatedOverlay: number;
  /** See CanvasCheck: contaminatedOverlay pixels never observed clean on the main canvas — a source-material
   *  limitation. Bounded by `analyticUnobservable`. */
  contaminatedOverlayUnobservable: number;
  /** See CanvasCheck: contaminatedOverlay pixels observed clean at least once — the target is 0. */
  contaminatedOverlayRecoverable: number;
  /** Report-only: of `contaminatedOverlayUnobservable`, how many carry the provisional bit. */
  unobservableProvisional: number;
  /** The scenario-level ceiling `contaminatedOverlayUnobservable` must not exceed. */
  analyticUnobservable: number;
  /** The `contaminated` subset explained only by a page-space dynamic (`rendered.dynamicRects[layer.id]`): an
   *  animated widget, a live counter, a blinking caret, a playing video. Legitimately allowed to keep one moment. */
  contaminatedDynamic: number;
  covered: number;
  expected: number;
  /** Body pixels the atlas assigned to this region (per frame). */
  regionPixels: number;
  /** Per-fragment ground-truth verification (every non-attached fragment of this layer's region). */
  fragmentReports: FragmentReport[];
}
interface CanvasCheck {
  errors: number[];
  missing: number;
  invented: number;
  mismatched: number;
  contaminated: number;
  contaminatedOverlay: number;
  contaminatedDynamic: number;
  contaminatedOverlayUnobservable: number;
  contaminatedOverlayRecoverable: number;
  unobservableProvisional: number;
  analyticUnobservable: number;
  covered: number;
  expected: number;
  pixelChecked: boolean;
}
/** Verifies one canvas (main or fragment) of a layer's region against the generating world.
 *  `entries` are the resolved (post pose-graph-correction, post attachment-shift) placements of every frame that ended up on this
 *  canvas, in frame order. `originFrame` names the frame whose ACTUAL recorded placement defines this canvas's local origin — for
 *  the main canvas that is frame 0 of the layer (matching the engine's initial pose); for a fragment it is the fragment's first
 *  frame. The world position corresponding to local pose (0,0) is therefore `truePath[originFrame] - placement[originFrame]`, so the
 *  expected pose of any other frame f is `(truePath[f] - truePath[originFrame]) + placement[originFrame]` — exactly what the reviewer
 *  specified, generalised so a main canvas whose frame 0 was not placed at (0,0) is still checked correctly. */
async function verifyCanvas(
  result: VerifiableRun,
  layer: Layer,
  code: number,
  canvas: CanvasMeta,
  entries: { frame: number; placement: Placement }[],
  originFrame: number,
  tolerance: number,
): Promise<CanvasCheck> {
  const { scenario, atlas, store } = result, v = layer.viewport, W = scenario.width, worldW = layer.world.width;
  const origin = entries.find((e) => e.frame === originFrame);
  const originWorld = origin
    ? { x: layer.path[originFrame].x - origin.placement.x, y: layer.path[originFrame].y - origin.placement.y }
    : layer.path[originFrame];
  const errors: number[] = [];
  for (const e of entries) {
    const zoom = layer.zoom?.[e.frame] ?? 1;
    errors.push(
      zoom !== 1
        ? Infinity
        : Math.hypot(e.placement.x - (layer.path[e.frame].x - originWorld.x), e.placement.y - (layer.path[e.frame].y - originWorld.y)),
    );
  }
  // A magnified frame resamples the page onto a different pixel grid; pixel identity against the lossless world is not
  // meaningful for a canvas that contains one, so only geometry (errors, above) and frame accounting are checked.
  if (entries.some((e) => (layer.zoom?.[e.frame] ?? 1) !== 1)) {
    return {
      errors,
      missing: 0,
      invented: 0,
      mismatched: 0,
      contaminated: 0,
      contaminatedOverlay: 0,
      contaminatedDynamic: 0,
      contaminatedOverlayUnobservable: 0,
      contaminatedOverlayRecoverable: 0,
      unobservableProvisional: 0,
      analyticUnobservable: 0,
      covered: 0,
      expected: 0,
      pixelChecked: false,
    };
  }
  const b = canvas.bounds,
    bw = Math.max(1, Math.ceil(b.width) + 2),
    bh = Math.max(1, Math.ceil(b.height) + 2),
    bx = Math.floor(b.x) - 1,
    by = Math.floor(b.y) - 1;
  // Attribution is by VALUE, not merely by presence: a world pixel that ever sat under an overlay/dynamic rect in
  // some observing frame is not automatically "contamination" from that overlay/dynamic — a screen overlay's
  // path can incidentally sweep across a page-space dynamic's world footprint (or vice versa) without either one
  // being the actual source of a later mismatch there. So instead of two boolean sets, these record, per world
  // pixel, the packed RGB colour(s) the overlay/dynamic actually painted there across every observing frame; a
  // mismatched pixel is only attributed to one when the canvas's stored value equals a colour recorded for it —
  // otherwise it is a genuine `mismatched` pixel, not contamination from either. A pixel matching both records
  // counts as overlay only (kept in the same field for compatibility with the old "under both" wording).
  const expected = new Uint8Array(bw * bh), overlayColors = new Map<number, Set<number>>(), dynamicColors = new Map<number, Set<number>>();
  const record = (map: Map<number, Set<number>>, wi: number, packed: number) => {
    let set = map.get(wi);
    if (!set) map.set(wi, set = new Set());
    set.add(packed);
  };
  // Ever-clean tracking (docs/ARCHITECTURE.md §七, issue #2): a world pixel this region ever painted is "unobservable" only if
  // it was NEVER, in any frame this canvas actually recorded, both on screen and outside every overlay/dynamic
  // rect at once — i.e. no clean look at it exists anywhere in the recording to heal from. `everVisible` is every
  // such pixel regardless of cleanliness (the analytic denominator: a property of the whole layer/scenario, not
  // just the pixels that ended up contaminated); `everClean` is the subset that had at least one clean look.
  const everVisible = new Set<number>(), everClean = new Set<number>();
  const inRect = (x: number, y: number, rects: { x: number; y: number; width: number; height: number }[]): boolean =>
    rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  for (const e of entries) {
    const p = layer.path[e.frame],
      px = p.x - originWorld.x,
      py = p.y - originWorld.y,
      rendered = renderFrame(scenario, e.frame),
      img = rendered.image;
    const dynamicRects = rendered.dynamicRects[layer.id] || [];
    for (let y = v.y; y < v.y + v.height; y++) {
      for (let x = v.x; x < v.x + v.width; x++) {
        if (atlas.labels[y * W + x] !== code) {
          continue;
        }
        const cx = x + px - bx, cy = y + py - by;
        if (cx >= 0 && cy >= 0 && cx < bw && cy < bh) {
          expected[cy * bw + cx] = 1;
        }
        const wi = (y - v.y + p.y) * worldW + (x - v.x + p.x);
        everVisible.add(wi);
        if (!inRect(x, y, rendered.overlayRects) && !inRect(x, y, dynamicRects)) {
          everClean.add(wi);
        }
      }
    }
    for (const r of rendered.overlayRects) {
      for (let y = Math.max(r.y, v.y); y < Math.min(r.y + r.height, v.y + v.height); y++) {
        for (let x = Math.max(r.x, v.x); x < Math.min(r.x + r.width, v.x + v.width); x++) {
          const j = (y * img.width + x) * 4;
          // Only where the overlay actually CHANGED the pixel (see RenderedFrame.beneath). An overlay rect
          // is a bounding box; a mouse pointer paints an arrow inside a 10×16 one and leaves the rest of it
          // showing the page or a page-space dynamic. Recording those untouched colours here made a widget's
          // own animated background count as "screen-overlay contamination" at every world position the
          // pointer's box ever swept across, which is neither what the overlay drew nor what the
          // world-consistency mask is meant to remove.
          if (
            img.data[j] === rendered.beneath[j] && img.data[j + 1] === rendered.beneath[j + 1] &&
            img.data[j + 2] === rendered.beneath[j + 2]
          ) {
            continue;
          }
          record(overlayColors, (y - v.y + p.y) * worldW + (x - v.x + p.x), (img.data[j] << 16) | (img.data[j + 1] << 8) | img.data[j + 2]);
        }
      }
    }
    for (const r of rendered.dynamicRects[layer.id] || []) {
      for (let wy = r.y; wy < r.y + r.height; wy++) {
        for (let wx = r.x; wx < r.x + r.width; wx++) {
          // World → screen for THIS frame: v is the layer's viewport, p its world offset. Not every
          // world pixel of a dynamic's rect is necessarily on screen every frame (a dynamic rect is
          // fixed in world space; the viewport scrolls past it), so out-of-view samples are skipped.
          const sx = v.x + (wx - p.x), sy = v.y + (wy - p.y);
          if (
            sx < v.x || sy < v.y || sx >= v.x + v.width || sy >= v.y + v.height || sx < 0 || sy < 0 || sx >= img.width || sy >= img.height
          ) {
            continue;
          }
          const j = (sy * img.width + sx) * 4;
          record(dynamicColors, wy * worldW + wx, (img.data[j] << 16) | (img.data[j + 1] << 8) | img.data[j + 2]);
        }
      }
    }
  }
  let missing = 0,
    invented = 0,
    mismatched = 0,
    contaminatedOverlay = 0,
    contaminatedDynamic = 0,
    contaminatedOverlayUnobservable = 0,
    contaminatedOverlayRecoverable = 0,
    unobservableProvisional = 0,
    covered = 0,
    expectedCount = 0;
  for (let i = 0; i < expected.length; i++) {
    expectedCount += expected[i];
  }
  const size = result.tileSize;
  for await (const { value: t } of iterate<TileIndex>(store, `tile-index/${canvas.id}/0/`)) {
    const stored = await store.get<StoredTile>(`tile/${canvas.id}/0/${t.x}_${t.y}`);
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
      const wx = cx + originWorld.x - v.x, wy = cy + originWorld.y - v.y;
      const versions = wx >= 0 && wy >= 0 && wx < layer.world.width && wy < layer.world.height
        ? layer.world.versions(wx, wy)
        : [scenario.background];
      const r = pixels[i * 4], g = pixels[i * 4 + 1], bl = pixels[i * 4 + 2];
      const ok = pixels[i * 4 + 3] === 255 &&
        versions.some((c) => Math.abs(c[0] - r) <= tolerance && Math.abs(c[1] - g) <= tolerance && Math.abs(c[2] - bl) <= tolerance);
      if (ok) {
        continue;
      }
      const wi = wy * worldW + wx, packed = (r << 16) | (g << 8) | bl;
      if (overlayColors.get(wi)?.has(packed)) {
        contaminatedOverlay++;
        // Unobservable: this world position was never, in any frame this canvas recorded, both on screen
        // and clear of every overlay/dynamic rect at once — there is no clean observation anywhere in the
        // recording for the world-consistency mask/voting to heal it from, so this is a genuine, permanent
        // limitation of the SOURCE MATERIAL, not a detection gap. Recoverable: the opposite — a clean look
        // existed somewhere, so a pixel still contaminated here is a real miss the engine should fix.
        if (everClean.has(wi)) {
          contaminatedOverlayRecoverable++;
        } else {
          contaminatedOverlayUnobservable++;
          if ((stored.provisional?.[i >> 3] ?? 0) & (1 << (i & 7))) {
            unobservableProvisional++;
          }
        }
      } else if (dynamicColors.get(wi)?.has(packed)) {
        contaminatedDynamic++;
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
  let analyticUnobservable = 0;
  for (const wi of everVisible) {
    if (!everClean.has(wi)) {
      analyticUnobservable++;
    }
  }
  return {
    errors,
    missing,
    invented,
    mismatched,
    contaminated: contaminatedOverlay + contaminatedDynamic,
    contaminatedOverlay,
    contaminatedDynamic,
    contaminatedOverlayUnobservable,
    contaminatedOverlayRecoverable,
    unobservableProvisional,
    analyticUnobservable,
    covered,
    expected: expectedCount,
    pixelChecked: true,
  };
}
export async function verifyLayer(result: VerifiableRun, layer: Layer, options: { tolerance?: number } = {}): Promise<LayerReport> {
  const { atlas, scenario } = result, region = matchRegion(result, layer), code = atlas.code(region), tolerance = options.tolerance ?? 0;
  const mainId = `${region.id}-part-0`, mainCanvas = result.canvases.find((c) => c.id === mainId);
  if (!mainCanvas) {
    throw new Error(`Main canvas ${mainId} missing.`);
  }
  // A framed presentation canvas (CanvasMeta.kind === 'presentation') spreads its source fragment's own layer/fragment
  // fields verbatim (see buildFramedCanvas), so without this exclusion it would be double-counted here as a second,
  // ground-truth-less "fragment" of the very layer its source fragment already accounts for.
  const fragments = result.canvases.filter((c) => c.layer === region.id && c.fragment > 0 && c.kind !== 'presentation');
  const W = scenario.width;
  // A single pass over the observation ledger, grouped by each frame's RESOLVED canvas: `decisions[].canvasId` already
  // reflects attachment resolution (render() walks the attachment chain), so frames originally observed on a fragment that
  // was later tied back to another canvas are grouped under that target, exactly where their pixels actually live.
  const canvasFrames = new Map<string, { frame: number; placement: Placement }[]>();
  let framesOnMain = 0, framesOnFragments = 0, skipped = 0;
  for (const o of result.observations) {
    const d = o.decisions.find((x) => x.placement.layer === region.id);
    if (!d) {
      continue;
    }
    if (d.placement.skip) {
      skipped++;
      continue;
    }
    if (d.canvasId === mainId) {
      framesOnMain++;
    } else {
      framesOnFragments++;
    }
    const list = canvasFrames.get(d.canvasId);
    if (list) {
      list.push({ frame: o.frame, placement: d.placement });
    } else {
      canvasFrames.set(d.canvasId, [{ frame: o.frame, placement: d.placement }]);
    }
  }
  let regionPixels = 0;
  for (let y = 0; y < scenario.height; y++) {
    for (let x = 0; x < scenario.width; x++) {
      if (atlas.labels[y * W + x] === code) {
        regionPixels++;
      }
    }
  }
  const main = await verifyCanvas(result, layer, code, mainCanvas, canvasFrames.get(mainId) ?? [], 0, tolerance);
  const fragmentReports: FragmentReport[] = [];
  for (const c of fragments) {
    // An attached fragment (CanvasMeta.attachedTo set) holds no tiles of its own: render() redirected every one of its
    // frames onto the resolved target canvas, so its frames are already counted above under that target's entries.
    if (c.attachedTo) {
      continue;
    }
    const entries = (canvasFrames.get(c.id) ?? []).slice().sort((a, b) => a.frame - b.frame);
    const originFrame = entries.length ? entries[0].frame : 0;
    const check = await verifyCanvas(result, layer, code, c, entries, originFrame, tolerance);
    const finite = check.errors.filter(Number.isFinite);
    fragmentReports.push({
      canvasId: c.id,
      frames: entries.length,
      maxError: finite.length ? Math.max(...finite) : 0,
      missing: check.missing,
      invented: check.invented,
      mismatched: check.mismatched,
      contaminated: check.contaminated,
      contaminatedOverlay: check.contaminatedOverlay,
      contaminatedOverlayUnobservable: check.contaminatedOverlayUnobservable,
      contaminatedOverlayRecoverable: check.contaminatedOverlayRecoverable,
      unobservableProvisional: check.unobservableProvisional,
      analyticUnobservable: check.analyticUnobservable,
      contaminatedDynamic: check.contaminatedDynamic,
      covered: check.covered,
      pixelChecked: check.pixelChecked,
    });
  }
  const finite = main.errors.filter(Number.isFinite);
  return {
    regionId: region.id,
    mainCanvas,
    fragments,
    framesOnMain,
    framesOnFragments,
    skipped,
    errors: main.errors,
    maxError: finite.length ? Math.max(...finite) : 0,
    meanError: finite.length ? finite.reduce((s, x) => s + x, 0) / finite.length : 0,
    missing: main.missing,
    invented: main.invented,
    mismatched: main.mismatched,
    contaminated: main.contaminated,
    contaminatedOverlay: main.contaminatedOverlay,
    contaminatedOverlayUnobservable: main.contaminatedOverlayUnobservable,
    contaminatedOverlayRecoverable: main.contaminatedOverlayRecoverable,
    unobservableProvisional: main.unobservableProvisional,
    analyticUnobservable: main.analyticUnobservable,
    contaminatedDynamic: main.contaminatedDynamic,
    covered: main.covered,
    expected: main.expected,
    regionPixels,
    fragmentReports,
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
/** Reads back a canvas's stored level-0 tiles and checks the coverage bitmap against the canvas's own bookkeeping: the number of
 *  indexed tile rows must equal `CanvasMeta.tileCount`, and the covered-bit count recomputed from every stored tile's coverage
 *  bitmap must equal `CanvasMeta.observedPixels`. This is content-agnostic (it never decodes pixel colour) and applies to any
 *  canvas with tiles — moving, fixed or presentation — so it catches drift between what a canvas believes it holds and what its
 *  tiles actually contain, independent of the per-layer world-truth checks above. */
export async function verifyCanvasAccounting(
  result: VerifiableRun,
  canvas: CanvasMeta,
): Promise<{ canvasId: string; tileRows: number; countedPixels: number; tileCountOk: boolean; observedPixelsOk: boolean }> {
  const { store } = result;
  let tileRows = 0, countedPixels = 0;
  for await (const { value: t } of iterate<TileIndex>(store, `tile-index/${canvas.id}/0/`)) {
    tileRows++;
    const stored = await store.get<StoredTile>(`tile/${canvas.id}/0/${t.x}_${t.y}`);
    if (!stored) {
      throw new Error(`Indexed tile ${canvas.id}/0/${t.x}_${t.y} is missing.`);
    }
    countedPixels += countCovered(stored.coverage);
  }
  return {
    canvasId: canvas.id,
    tileRows,
    countedPixels,
    tileCountOk: tileRows === canvas.tileCount,
    observedPixelsOk: countedPixels === canvas.observedPixels,
  };
}
