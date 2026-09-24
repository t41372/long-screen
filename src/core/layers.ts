import type { Gray, Motion, MotionField, Rect, Region, RGBA } from '../types.ts';
import { clamp, contains, norm } from './math.ts';
import { core, type LearnerAccumulators, type LearnerHandle, type Resident, ResidentFrame } from './wasm.ts';
/** A field carries real evidence only once some model moved more than analysis jitter and is reasonably well matched;
 * shared by per-frame and long-baseline (frame t−k vs t) evidence so both are held to the same bar. */
export function informativeField(field: MotionField): boolean {
  return !field.unknown && field.difference >= .2 && field.motions.some((m) => norm(m) > 1 && m.confidence > .3);
}
/** Learns screen-space motion discontinuities across the WHOLE recording. Per-frame accumulation runs in the
 *  Rust core (rust/core/src/layers.rs) through a `LearnerHandle`; `finish()` reads the accumulators back once and
 *  builds the regions in the Rust core too (rust/core/src/regions/), this class keeping only the marshalling.
 *  The last native frame is kept for appearance checks in `finish()`. */
export class LayerLearner {
  readonly cols: number;
  readonly rows: number;
  readonly cell = 24;
  private handle?: LearnerHandle;
  private snapshot?: LearnerAccumulators;
  private reference?: RGBA;
  /** Core-resident copy of the latest reference frame when the scan pass keeps frames in the core. */
  private residentReference?: ResidentFrame;
  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    this.handle = core().learner(width, height);
  }
  /** Accumulators as of the last `add()`; reading them ends accumulation (the snapshot is cached). */
  private get acc(): LearnerAccumulators {
    if (!this.snapshot) {
      if (!this.handle) throw new Error('LayerLearner was disposed before finish().');
      this.snapshot = this.handle.read();
      this.handle.free();
      this.handle = undefined;
    }
    return this.snapshot;
  }
  /** `prevNative`/`currentNative` may be frames already resident in the core (the scan pass keeps a ring). */
  add(field: MotionField, prev: Gray, current: Gray, prevNative?: RGBA | ResidentFrame, currentNative?: RGBA | ResidentFrame): void {
    if (!this.handle) throw new Error('LayerLearner cannot accumulate after finish().');
    const informative = this.handle.add(field, prev, current, prevNative, currentNative);
    if (
      informative && prevNative && currentNative && prevNative.width === currentNative.width && prevNative.height === currentNative.height
    ) {
      // finish() samples the last informative native frame for appearance evidence. A resident frame is copied
      // inside core memory (its ring slot will be reused) and read out once, by finish().
      if (currentNative instanceof ResidentFrame) {
        if (
          this.residentReference &&
          (this.residentReference.width !== currentNative.width || this.residentReference.height !== currentNative.height)
        ) {
          this.residentReference.free();
          this.residentReference = undefined;
        }
        this.residentReference ??= core().frame(currentNative.width, currentNative.height);
        this.residentReference.copyFrom(currentNative);
        this.reference = undefined;
      } else {
        this.residentReference?.free();
        this.residentReference = undefined;
        this.reference = currentNative;
      }
    }
  }
  /** Releases the core-resident accumulators without finishing (a run that stops before regions are built). */
  dispose(): void {
    this.handle?.free();
    this.handle = undefined;
    this.residentReference?.free();
    this.residentReference = undefined;
  }
  /** Builds this run's regions: band detection through sticky-header cleanup runs in the Rust core
   *  (`rust/core/src/regions.rs`) in one call; this method only marshals the accumulators in and, for a
   *  hand-placed layout (`manual`), does the cheap object construction over data already in hand — the one
   *  expensive per-pixel step there (is every native pixel covered?) is also the Rust core's. */
  finish(nativeWidth: number, nativeHeight: number, manual: Region[] = [], factor = 1): Region[] {
    if (this.residentReference) {
      const frame = this.residentReference;
      this.reference = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.bytes().buffer) };
      frame.free();
      this.residentReference = undefined;
    }
    if (manual.length) {
      const regions = manual.map((r, i) => ({
        ...r,
        id: `layer-${i}`,
        manual: true,
        maskWidth: this.width,
        maskHeight: this.height,
        factor,
        exclusions: [...manual.slice(i + 1).map((v) => v.rect), ...manual.filter((v) => v.kind === 'ignore').map((v) => v.rect)],
      }));
      if (core().regionsManualUncovered(manual.map((r) => r.rect), nativeWidth, nativeHeight)) {
        regions.push(
          {
            id: `layer-${regions.length}`,
            name: '未指定区域 · 屏幕坐标观察',
            kind: 'fixed',
            rect: { x: 0, y: 0, width: nativeWidth, height: nativeHeight },
            manual: true,
            unassigned: true,
            maskWidth: this.width,
            maskHeight: this.height,
            factor,
            exclusions: manual.map((r) => r.rect),
          } as Region & {
            exclusions: Rect[];
            maskWidth: number;
            maskHeight: number;
            factor: number;
            manual: boolean;
          },
        );
      }
      return regions;
    }
    return core().finishRegions(this.width, this.height, this.cell, this.acc, nativeWidth, nativeHeight, factor, this.reference);
  }
}
export function regionContains(region: Region, x: number, y: number, nativeWidth: number, nativeHeight: number): boolean {
  if (!contains(region.rect, x, y) || region.exclusions?.some((r) => contains(r, x, y))) {
    return false;
  }
  if (region.crop && !contains(region.crop, x, y)) {
    return false;
  }
  if (region.solid || !region.mask) {
    return true;
  }
  // The downscale truth is floor(x/factor), including the final partial cell; fall back to the ratio only for
  // regions built before `factor` was recorded (e.g. hand-built test masks).
  const xx = region.factor
    ? clamp(Math.floor(x / region.factor), 0, region.maskWidth! - 1)
    : clamp(Math.floor(x * region.maskWidth! / nativeWidth), 0, region.maskWidth! - 1);
  const yy = region.factor
    ? clamp(Math.floor(y / region.factor), 0, region.maskHeight! - 1)
    : clamp(Math.floor(y * region.maskHeight! / nativeHeight), 0, region.maskHeight! - 1);
  return !!region.mask[yy * region.maskWidth! + xx];
}
export function regionMotion(field: MotionField, region: Region, width: number, height: number): Motion {
  if (region.kind === 'fixed') {
    return { x: 0, y: 0, support: 100, unique: 100, confidence: 1, error: 0, ambiguous: false };
  }
  const votes = new Float64Array(field.motions.length);
  let total = 0;
  for (let y = 0; y < field.rows; y++) {
    for (let x = 0; x < field.cols; x++) {
      const px = Math.min(width - 1, (x + .5) * field.cell * width / (field.cols * field.cell)),
        py = Math.min(height - 1, (y + .5) * field.cell * height / (field.rows * field.cell));
      // Map by actual analysis dimensions when available, not by padded grid dimensions.
      const nx = region.maskWidth ? Math.min(width - 1, (x + .5) * field.cell * width / region.maskWidth) : px;
      const ny = region.maskHeight ? Math.min(height - 1, (y + .5) * field.cell * height / region.maskHeight) : py;
      if (!regionContains(region, nx, ny, width, height)) {
        continue;
      }
      const i = y * field.cols + x, w = field.confidence[i] / 255;
      votes[field.labels[i]] += w;
      total += w;
    }
  }
  let best = 0;
  for (let i = 1; i < votes.length; i++) {
    if (votes[i] > votes[best]) {
      best = i;
    }
  }
  const m = field.motions[best];
  return { ...m, confidence: field.difference < .12 ? .98 : m.confidence * clamp(votes[best] / Math.max(.01, total) * 1.3, .25, 1) };
}

/** Native-resolution pixel ownership computed once per run: compositing loops index a byte instead of calling
 *  regionContains per pixel. `resident` is the label plane's ONLY copy in core memory — solve/render/compositor
 *  read it directly (`atlas.resident`) instead of re-uploading `atlas.labels`, so the plane crosses the JS/Wasm
 *  boundary exactly once, at construction. `resident` lives for the whole run; call `dispose()` exactly once
 *  (run()'s finally) when it is no longer needed. */
export class RegionAtlas {
  /** Core-resident label plane (0 = owned by no region, otherwise index + 1 into `regions`; first-containing-
   *  region-wins, matching regionContains semantics). The single source of truth; `labels` below is a cached
   *  copy of it, only materialised the first time a JS-side reader actually needs one. */
  readonly resident: Resident;
  /** Per-code pixel counts computed once in the same Rust call that builds `resident`, so count() is O(1)
   *  without a second scan (in Rust OR in TS) of the label plane. */
  private readonly counts: Uint32Array;
  private cachedLabels?: Uint8Array;
  constructor(readonly regions: Region[], readonly width: number, readonly height: number) {
    // Throws the same message the all-TS constructor used to, whether the Rust core rejects the count itself or
    // this early check catches it first (rust/core/src/abi/regions.rs::ls_regions_label_atlas).
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
