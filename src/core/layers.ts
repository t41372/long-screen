import type { Gray, MotionField, Rect, Region, RGBA } from '../types.ts';
import { core, type LearnerAccumulators, type LearnerHandle, type Resident, type ResidentFrame } from './wasm.ts';
/** Learns screen-space motion discontinuities across a whole recording and builds the regions from them. The
 *  learner, its appearance reference and both region layouts (automatic, hand-placed) are the engine's
 *  (rust/engine/src/layers.rs `RegionLearner`); this class only holds the handle. The scan pass keeps its own learner
 *  inside its session (rust/engine/src/scan.rs); this one serves the layer-learning tests. */
export class LayerLearner {
  readonly cols: number;
  readonly rows: number;
  readonly cell = 24;
  private handle?: LearnerHandle;
  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    this.handle = core().learner(width, height);
  }
  private get live(): LearnerHandle {
    if (!this.handle) throw new Error('LayerLearner was disposed.');
    return this.handle;
  }
  /** The accumulators as of the last `add()`. */
  get acc(): LearnerAccumulators {
    return this.live.read();
  }
  /** `prevNative`/`currentNative` may be frames already resident in the core. */
  add(field: MotionField, prev: Gray, current: Gray, prevNative?: RGBA | ResidentFrame, currentNative?: RGBA | ResidentFrame): void {
    this.live.add(field, prev, current, prevNative, currentNative);
  }
  /** Releases the core-resident learner. */
  dispose(): void {
    this.handle?.free();
    this.handle = undefined;
  }
  /** This recording's regions: the hand-placed `manual` layout when given, else the automatic one. */
  finish(nativeWidth: number, nativeHeight: number, manual: Region[] = [], factor = 1): Region[] {
    return this.live.finish(nativeWidth, nativeHeight, manual, factor);
  }
}
/** Native-resolution pixel ownership computed once per run: compositing loops index a byte instead of testing
 *  region membership per pixel (`rust/core/src/region.rs::Region::contains`, via `filter_features` and the
 *  atlas label plane below). `resident` is the label plane's ONLY copy in core memory — solve/render/compositor
 *  read it directly (`atlas.resident`) instead of re-uploading `atlas.labels`, so the plane crosses the JS/Wasm
 *  boundary exactly once, at construction. `resident` lives for the whole run; call `dispose()` exactly once
 *  (run()'s finally) when it is no longer needed. */
export class RegionAtlas {
  /** Core-resident label plane (0 = owned by no region, otherwise index + 1 into `regions`; first-containing-
   *  region wins). The single source of truth; `labels` below is a cached copy of it, only materialised the
   *  first time a JS-side reader actually needs one. */
  readonly resident: Resident;
  /** Per-code pixel counts computed once in the same Rust call that builds `resident`, so count() is O(1)
   *  without a second scan (in Rust OR in TS) of the label plane. */
  private readonly counts: Uint32Array;
  private cachedLabels?: Uint8Array;
  constructor(readonly regions: Region[], readonly width: number, readonly height: number) {
    // Throws this exact message regardless of whether the Rust core rejects the count itself or this early
    // check catches it first (rust/wasm/src/regions.rs::ls_regions_label_atlas): one message, two paths.
    if (regions.length > 254) {
      throw new Error('Too many regions for the pixel atlas.');
    }
    const { resident, counts } = core().labelAtlasResident(regions, width, height);
    this.resident = resident;
    this.counts = counts;
  }
  /** Plain-array view of the label plane, for the few JS-side readers (tests, synthetic verify, the
   *  Uint8Array/Resident overload of consistencyMask's `atlas` parameter): copied out of `resident` and cached on
   *  first access, so a caller that never reads it pays nothing and one that does pays once, not per frame. */
  get labels(): Uint8Array {
    return this.cachedLabels ??= this.resident.bytes();
  }
  code(region: Region): number {
    const index = this.regions.indexOf(region);
    if (index < 0) {
      throw new Error(`Region ${region.id} is not part of this atlas.`);
    }
    return index + 1;
  }
  contains(code: number, x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.labels[y * this.width + x] === code;
  }
  /** Pixel count owned by a region (used for coverage accounting and tests). */
  count(code: number): number {
    return this.counts[code] || 0;
  }
  /** Releases the core-resident label plane; the atlas is unusable afterwards. Idempotent (`Resident.free()`
   *  already guards repeat calls), so it is safe to call from both a pass's own cleanup and run()'s finally. */
  dispose(): void {
    this.resident.free();
  }
}

/** Strong persistent appearance boundary within a stationary run (Rust core, rust/core/src/chrome.rs). Never infer a
 * pane edge from its first glyph. Returns the boundary coordinate in native pixels, or undefined if the image offers no
 * boundary evidence. */
export function stationaryBoundary(
  image: RGBA | ResidentFrame,
  axis: 'x' | 'y',
  from: number,
  to: number,
  crossFrom: number,
  crossTo: number,
  choose: 'first' | 'last',
): number | undefined {
  return core().stationaryBoundary(image, axis, from, to, crossFrom, crossTo, choose);
}

/** A sticky navigation band can move initially and become screen-fixed later. Its geometry is per-observation,
 * not a second scroll world. Only exclude an edge band when native texture agrees with zero motion and clearly
 * disagrees with the accepted page translation; uniform gutters alone never provide this evidence. (Rust core.) */
export function stickyOcclusions(
  previous: RGBA | ResidentFrame,
  current: RGBA | ResidentFrame,
  region: Region,
  motion: { x: number; y: number },
  previousOcclusions: Rect[] = [],
): Rect[] {
  if (previous.width !== current.width || previous.height !== current.height) return [];
  return core().stickyOcclusions(previous, current, region.crop || region.rect, motion, previousOcclusions);
}
