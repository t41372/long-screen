/** `Core`: lifecycle (instantiate the Wasm module, optionally with a shared-memory thread pool; dispose) plus
 *  thin delegating methods for every kernel, so `core().x(...)` keeps its shape while the marshalling for each
 *  of the 16 domains lives in its own module (`raster.ts`, `features.ts`, `motion.ts`, `chrome.ts`,
 *  `consistency.ts`, `compositor.ts`, `png.ts`, `layers.ts`, `voting.ts`, `framing.ts`, `pyramid.ts`,
 *  `regions.ts`, `temporal.ts`, `track.ts` (+ its `track-odometry`/`track-reacquire`/`track-keyframes` split),
 *  `pose-graph.ts`, `yuv.ts`). */
import type { Feature, Gray, Match, Motion, MotionField, Point, Rect, Region, RGBA } from '../../types.ts';
import { assertLayout, type CoreExports } from './exports.ts';
import { allocOrThrow, Arena, type BytesInput, type FrameInput, FrameRing, Resident, ResidentFrame, ResidentGray } from './memory.ts';
import { placeFrame as placeFrameImpl, writeRect as writeRectImpl } from './marshal.ts';
import { check as checkStatus } from './exports.ts';
import * as raster from './raster.ts';
import * as sources from './sources.ts';
import * as opacity from './sources-opacity.ts';
import * as yuv from './yuv.ts';
import * as pyramid from './pyramid.ts';
import * as temporal from './temporal.ts';
import type { OverwriteStats, OverwriteTile, TemporalComponent, TemporalIndexHandle } from './temporal.ts';
import * as featuresDomain from './features.ts';
import * as motion from './motion.ts';
import * as chrome from './chrome.ts';
import * as consistency from './consistency.ts';
import type { ConsistencyMaskInput } from './consistency.ts';
import * as png from './png.ts';
import * as composite from './compositor.ts';
import type { CompositeObservation, PreparedObservation } from './compositor.ts';
import { learner as learnerFactory, type LearnerHandle } from './layers.ts';
import { type VotingRing, votingRing as votingRingFactory } from './voting.ts';
import {
  type FinishAccumulators,
  finishRegions as finishRegionsImpl,
  labelAtlasResident as labelAtlasResidentImpl,
  manualUncovered,
} from './regions.ts';
import {
  type PoseGraphEdges,
  poseGraphFree as poseGraphFreeImpl,
  poseGraphNew as poseGraphNewImpl,
  type PoseGraphNodes,
  poseGraphPass as poseGraphPassImpl,
  poseGraphRead as poseGraphReadImpl,
  poseGraphResidual as poseGraphResidualImpl,
  poseGraphSolveCycle as poseGraphSolveCycleImpl,
} from './pose-graph.ts';
import {
  frameCoordinate as frameCoordinateImpl,
  type FrameLayout,
  frameLayout as frameLayoutImpl,
  type FramingSession,
  openFramingSession as openFramingSessionImpl,
} from './framing.ts';
import * as track from './track.ts';
import type { FragmentCauseGate, LoopVerdict, OcclusionDecision } from './track.ts';

export interface RefinementResult {
  x: number;
  y: number;
  error: number;
  samples: number;
  runnerUp: number;
}
export interface AuditResult {
  error: number;
  mismatch: number;
  overlap: number;
  samples: number;
  blocks: number;
  agreeing: number;
  agreement: number;
  agreeingError: number;
}
export interface PatchInput {
  x: number;
  y: number;
  size: number;
  data: Uint8Array;
}
/** Region-membership mask for native refinement: a pixel counts when `labels[y*w+x] === code`. The labels may
 *  already be resident in the core (the solve pass uploads the atlas plane once). */
export interface LabelMask {
  labels: BytesInput;
  code: number;
}
/** Coarse-to-fine guide for `refineNative`: `b`'s own analysis-scale gray at integer downscale `factor` (see
 *  `select_native_points`'s doc comment in rust/core/src/motion.rs). Omitted, refinement falls back to a
 *  full-resolution native scan. */
export interface NativePointGuide {
  g: Gray;
  factor: number;
}

export interface CoreThreads {
  /** Pool helper workers to start next to the calling thread. */
  helpers: number;
  /** The helper entry: `assets/core-helper.js` in the bundle, `src/core/helper.ts` under Deno. */
  helperURL: URL;
}
/** Linked into core.threads.wasm by scripts/build-core.sh (`--initial-memory` / `--max-memory`, 64 KiB pages). */
const THREADS_INITIAL_PAGES = 512, THREADS_MAX_PAGES = 32768;
const HELPER_STACK_BYTES = 1024 * 1024;

export class Core {
  /** Transient arena: every kernel call replans it. */
  private readonly arena: Arena;
  /** Frame arena: holds state that must survive a whole per-canvas tile loop, during which transient calls
   *  (e.g. PNG encoding on tile eviction) must not clobber it — either one `prepareObservation()` result
   *  (compositor.ts, the render pass's compositing) or one `FramingSession` (framing.ts, the presentation
   *  pass's `paintTile`/`foldEvidence` loop). Only one of the two is ever live at a time: `Engine.run()`
   *  (src/pipeline/engine.ts) awaits the whole render pass to finish before starting the presentation pass, so
   *  their frame-arena users never interleave — a future concurrent-canvas render would need a second arena
   *  (or to serialise on this one) before that invariant could break. */
  private readonly frameArena: Arena;
  readonly featureBytes: number;
  readonly matchBytes: number;
  /** Pool helper workers sharing this instance's memory (threaded build only); see rust/core/src/pool.rs. */
  private helpers: Worker[] = [];
  private constructor(readonly exports: CoreExports) {
    assertLayout(exports);
    this.arena = new Arena(exports);
    this.frameArena = new Arena(exports);
    this.featureBytes = exports.ls_feature_bytes();
    this.matchBytes = exports.ls_match_bytes();
  }
  /** Current size of the core's linear memory (it only grows), for diagnostics. */
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }
  /** Threads computing inside kernels: the calling thread plus parked pool helpers. */
  get threads(): number {
    return this.exports.ls_pool_helpers() + 1;
  }
  static async instantiate(bytes: BufferSource | Response | Promise<Response>, threads?: CoreThreads): Promise<Core> {
    const source = bytes instanceof Promise ? await bytes : bytes;
    if (threads) return await Core.instantiateShared(source, threads);
    const result = source instanceof Response
      ? await WebAssembly.instantiateStreaming(source, {}).catch(async () => WebAssembly.instantiate(await source.arrayBuffer(), {}))
      : await WebAssembly.instantiate(source, {});
    return new Core(result.instance.exports as unknown as CoreExports);
  }
  /** Threaded build: one shared memory, this instance plus `helpers` workers parked in the pool. Throws (and
   *  terminates any helper already started) when the engine refuses shared memory or a helper fails. */
  private static async instantiateShared(source: BufferSource | Response, threads: CoreThreads): Promise<Core> {
    const module = source instanceof Response ? await WebAssembly.compile(await source.arrayBuffer()) : await WebAssembly.compile(source);
    let memory: WebAssembly.Memory | undefined, failure: unknown;
    // Mobile engines may refuse to reserve a large shared maximum up front; smaller reservations still fit a run.
    for (const maximum of [THREADS_MAX_PAGES, THREADS_MAX_PAGES / 2, THREADS_MAX_PAGES / 4]) {
      try {
        memory = new WebAssembly.Memory({ initial: THREADS_INITIAL_PAGES, maximum, shared: true } as WebAssembly.MemoryDescriptor);
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (!memory) throw new Error(`shared memory unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
    const instance = await WebAssembly.instantiate(module, { env: { memory } });
    // The threaded build imports its memory instead of exporting it; the adapter reads it from `exports`.
    const core = new Core({ ...instance.exports, memory } as unknown as CoreExports);
    try {
      const exports = core.exports,
        tlsSize = Number(exports.__tls_size?.value ?? 0),
        tlsAlign = Math.max(8, Number(exports.__tls_align?.value ?? 8));
      const started = [];
      for (let i = 0; i < threads.helpers; i++) {
        const stack = exports.ls_alloc(HELPER_STACK_BYTES), tls = tlsSize ? exports.ls_alloc(tlsSize + tlsAlign) : 0;
        if (!stack || (tlsSize && !tls)) throw new Error('CORE_OUT_OF_MEMORY: pool helper stack.');
        const worker = new Worker(threads.helperURL, { type: 'module' });
        core.helpers.push(worker);
        started.push(
          new Promise<void>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent<{ ready: boolean; error?: string }>) =>
              e.data.ready ? resolve() : reject(new Error(`pool helper failed: ${e.data.error}`));
            worker.onerror = (e) => {
              e.preventDefault();
              reject(new Error(`pool helper failed to start: ${e.message}`));
            };
          }),
        );
        worker.postMessage({
          module,
          memory,
          stackTop: (stack + HELPER_STACK_BYTES) & ~15,
          tls: tls ? Math.ceil(tls / tlsAlign) * tlsAlign : 0,
        });
      }
      await Promise.all(started);
      // `ready` is posted just before a helper enters ls_pool_worker; wait until every one is actually parked.
      const deadline = performance.now() + 5000;
      while (exports.ls_pool_helpers() < threads.helpers) {
        if (performance.now() > deadline) throw new Error(`only ${exports.ls_pool_helpers()} of ${threads.helpers} pool helpers parked.`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } catch (error) {
      core.dispose();
      throw error;
    }
    return core;
  }
  /** Stops the pool helpers. The instance itself is garbage once unreferenced. */
  dispose(): void {
    for (const worker of this.helpers.splice(0)) worker.terminate();
  }
  /** Transient scratch space for stateful-object wrappers (planned like any kernel call). */
  sourceAnalysis(size: number, tx: number, ty: number, noise: number, state?: Uint8Array): sources.SourceAnalysis {
    return sources.sourceAnalysis(this, size, tx, ty, noise, state);
  }
  sourceScene(): sources.SourceScene {
    return new sources.SourceScene(this);
  }
  sourceEpochSweep(): sources.SourceEpochSweep {
    return new sources.SourceEpochSweep(this);
  }
  sourceSameFrame(a: ResidentFrame, b: ResidentFrame): boolean {
    if (a.width !== b.width || a.height !== b.height) return false;
    return this.check(this.exports.ls_sources_same_frame(a.ptr, b.ptr, a.length), 'source frame identity') === 1;
  }
  sourceOwnershipShards(labels: Resident, parents: Resident, input: Parameters<typeof sources.ownershipShards>[3]) {
    return sources.ownershipShards(this, labels, parents, input);
  }
  sourceParentLabels(
    labels: Resident,
    regions: import('../../types.ts').Region[],
    code: (region: import('../../types.ts').Region) => number,
  ): Resident | undefined {
    return sources.parentLabels(this, labels, regions, code);
  }
  sourceRoles(states: sources.SourceObjectState[], region = 0): sources.SourceRoles {
    return new sources.SourceRoles(this, states, region);
  }
  sourceEvidence(chunks: Uint8Array[], states: sources.SourceRoles): sources.SourceEvidence {
    return new sources.SourceEvidence(this, chunks, states);
  }
  sourceFittedOpacityField(data: Uint8Array, noise: number): opacity.FittedOpacityField {
    return new opacity.FittedOpacityField(this, data, noise);
  }
  sourceOpacityField(data?: Uint8Array): opacity.OpacityField {
    return new opacity.OpacityField(this, data);
  }
  sourceOpacityAnnotation(data: Uint8Array, page: number, desc: opacity.OpacityDescriptor): opacity.OpacityAnnotation {
    return new opacity.OpacityAnnotation(this, data, page, desc);
  }
  sourceOpacityValid(data: Uint8Array, noise: number): number {
    return opacity.opacityValid(this, data, noise);
  }
  sourceOpacityExport(data: Uint8Array): Uint8Array<ArrayBuffer> {
    return opacity.opacityExport(this, data);
  }
  sourceArchiveExport(data: Uint8Array, page: number, png: boolean): Uint8Array<ArrayBuffer> {
    return sources.sourceArchiveExport(this, data, page, png);
  }
  sourceTracker(): sources.SourceTracker {
    return new sources.SourceTracker(this);
  }
  sourceShards(size: number, tx: number, ty: number, side: number, disputes: Uint8Array): sources.SourceShard[] {
    return sources.sourceShards(this, size, tx, ty, side, disputes);
  }
  sourceArchiveFrames(data: Uint8Array, page: number): number[] {
    return sources.sourceArchiveFrames(this, data, page);
  }
  sourceArchiveAnnotate(
    data: Uint8Array,
    page: number,
    size: number,
    tx: number,
    ty: number,
    evidence: sources.SourceEvidence,
  ): Uint8Array<ArrayBuffer> {
    return sources.sourceArchiveAnnotate(this, data, page, size, tx, ty, evidence);
  }
  sourceTile(size: number, tx: number, ty: number, noise: number, disputes: Uint8Array, state?: Uint8Array): sources.SourceTile {
    return sources.sourceTile(this, size, tx, ty, noise, disputes, state);
  }
  scratch(sizes: number[]): number[] {
    return this.arena.plan(sizes);
  }
  /** Frame-wide scratch space that survives across a tile loop (`compositor.ts::prepareObservation`). */
  scratchFrame(sizes: number[]): number[] {
    return this.frameArena.plan(sizes);
  }
  readBytes(ptr: number, length: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.exports.memory.buffer).slice(ptr, ptr + length) as Uint8Array<ArrayBuffer>;
  }
  writeBytes(ptr: number, bytes: ArrayBufferView): void {
    new Uint8Array(this.exports.memory.buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), ptr);
  }
  check(status: number, what: string): number {
    return checkStatus(status, what);
  }
  writeRect(ptr: number, r: Rect): void {
    writeRectImpl(this.exports, ptr, r);
  }
  /** Pointer to `frame`'s pixels: its own resident pointer, or `scratch` after copying it there. */
  placeFrame(frame: FrameInput, scratch: number): number {
    return placeFrameImpl(this.exports, frame, scratch);
  }

  votingRing(
    regions: Region[],
    options: {
      factor: number;
      noise: number;
      nativeWidth: number;
      nativeHeight: number;
      analysisWidth: number;
      analysisHeight: number;
      budgetBytes: number;
    },
  ): VotingRing {
    return votingRingFactory(this, this.exports, regions, options);
  }

  grayscale(rgba: Uint8ClampedArray, width: number, height: number): Gray {
    return raster.grayscale(this, rgba, width, height);
  }
  /** Resident luma plane for resident frames of `width × height` (uninitialised until `grayscaleInto`). */
  gray(width: number, height: number): ResidentGray {
    return new ResidentGray(this.exports, allocOrThrow(this.exports, width * height, 'resident luma plane'), width, height);
  }
  /** Full-resolution luma of a resident frame, written into a resident plane without leaving core memory. */
  grayscaleInto(frame: ResidentFrame, out: ResidentGray): ResidentGray {
    return raster.grayscaleInto(this, frame, out);
  }
  downscaleGray(image: FrameInput, factor: number): Gray {
    return raster.downscaleGray(this, image, factor);
  }
  halveRGBA(image: RGBA): RGBA {
    return raster.halveRGBA(this, image);
  }
  assemblePyramidParent(children: (Uint8ClampedArray | undefined)[], size: number): RGBA {
    return pyramid.assemblePyramidParent(this, children, size);
  }
  temporalComponents(cells: [number, number][], size: number): TemporalComponent[] {
    return temporal.temporalComponents(this, cells, size);
  }
  /** A fresh, empty in-memory temporal index (one per canvas — `Compositor.temporalIndex()`, src/core/compositor.ts). */
  newTemporalIndex(): TemporalIndexHandle {
    return temporal.newTemporalIndex(this, this.exports);
  }
  overwriteTile(
    tile: OverwriteTile,
    tileSize: number,
    image: FrameInput,
    blocks: [number, number][],
    ox: number,
    oy: number,
    tx: number,
    ty: number,
    frame: number,
    confidence: number,
    stable: boolean,
  ): OverwriteStats {
    return temporal.overwriteTile(this, tile, tileSize, image, blocks, ox, oy, tx, ty, frame, confidence, stable);
  }
  /** RGBA of a decoded frame given in its `VideoFrame.copyTo` layout (see rust/core/src/yuv.rs for the codes).
   *  `dest`, when given and the right length, is filled in place instead of allocating a fresh output buffer. */
  frameToRGBA(
    src: Uint8Array,
    format: number,
    layout: { offset: number; stride: number }[],
    width: number,
    height: number,
    matrix: number,
    dest?: Uint8ClampedArray,
  ): Uint8ClampedArray {
    return yuv.frameToRGBA(this, src, format, layout, width, height, matrix, dest);
  }
  extractFeatures(image: Gray, maxFeatures: number, roi?: Rect): Feature[] {
    return featuresDomain.extractFeatures(this, image, maxFeatures, roi);
  }
  matchFeatures(a: Feature[], b: Feature[], includeAmbiguous: boolean): Match[] {
    return featuresDomain.matchFeatures(this, a, b, includeAmbiguous);
  }
  featureWords(features: Feature[]): number[] {
    return featuresDomain.featureWords(this, features);
  }
  /** Persistent core buffer of `length` bytes (zeroed by the allocator only on first growth; write before read). */
  alloc(length: number): Resident {
    return new Resident(
      this.exports,
      allocOrThrow(this.exports, length, `the reconstruction core could not reserve ${length} resident bytes`),
      length,
    );
  }
  /** Copies `bytes` into a new persistent core buffer. */
  upload(bytes: ArrayBufferView): Resident {
    const resident = this.alloc(bytes.byteLength);
    resident.write(bytes);
    return resident;
  }
  /** Refreshes a fixed region's resident saved pixels (`rw × rh` RGBA from `(x0, y0)`) from a resident frame and
   *  labels; true when a pixel the region owns changed. */
  fixedUpdate(
    saved: Resident,
    frame: ResidentFrame,
    labels: Resident,
    x0: number,
    y0: number,
    rw: number,
    rh: number,
    code: number,
  ): boolean {
    return raster.fixedUpdate(this, saved, frame, labels, x0, y0, rw, rh, code);
  }
  /** One resident native frame buffer (uninitialised), e.g. a reference copy another slot is copied into. */
  frame(width: number, height: number): ResidentFrame {
    return new ResidentFrame(this.exports, allocOrThrow(this.exports, width * height * 4, 'resident frame'), width, height);
  }
  frameRing(capacity: number, width: number, height: number): FrameRing {
    return new FrameRing(this.exports, capacity, width, height);
  }
  learner(width: number, height: number): LearnerHandle {
    return learnerFactory(this, this.exports, width, height);
  }
  stationaryBoundary(
    image: FrameInput,
    axis: 'x' | 'y',
    from: number,
    to: number,
    crossFrom: number,
    crossTo: number,
    choose: 'first' | 'last',
  ): number | undefined {
    return chrome.stationaryBoundary(this, image, axis, from, to, crossFrom, crossTo, choose);
  }
  stickyOcclusions(previous: FrameInput, current: FrameInput, region: Rect, motion: Point, carry: Rect[]): Rect[] {
    return chrome.stickyOcclusions(this, previous, current, region, motion, carry);
  }

  consistencyMask(input: ConsistencyMaskInput): Uint8Array<ArrayBuffer> {
    return consistency.consistencyMask(this, input);
  }
  /** Same kernel, written into a resident buffer so the compositor can consume it without a round trip. */
  consistencyMaskInto(input: ConsistencyMaskInput, output: Resident): void {
    consistency.consistencyMaskInto(this, input, output);
  }
  pngFilterSub(rgba: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
    return png.pngFilterSub(this, rgba, width, height);
  }
  pngEncode(rgba: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
    return png.pngEncode(this, rgba, width, height);
  }
  pngDecode(bytes: Uint8Array, width: number, height: number): Uint8ClampedArray {
    return png.pngDecode(this, bytes, width, height);
  }
  crc32(bytes: Uint8Array): number {
    return png.crc32(this, bytes);
  }

  meanDifference(a: Gray, b: Gray): number {
    return raster.meanDifference(this, a, b);
  }
  translationHypotheses(matches: Match[], max: number): Motion[] {
    return motion.translationHypotheses(this, matches, max);
  }
  detectScale(matches: Match[]): number {
    return motion.detectScale(this, matches);
  }
  verifyTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect): number {
    return motion.verifyTranslation(this, a, b, dx, dy, roi);
  }
  auditTranslation(a: Gray, b: Gray, dx: number, dy: number, roi: Rect | undefined, tolerant: boolean): AuditResult {
    return motion.auditTranslation(this, a, b, dx, dy, roi, tolerant);
  }
  refineTranslation(a: Gray, b: Gray, p: { x: number; y: number }, roi: Rect | undefined, radius: number): { x: number; y: number } {
    return motion.refineTranslation(this, a, b, p, roi, radius);
  }
  estimateMotion(a: Gray, b: Gray, matches: Match[], featureCount: number): MotionField {
    return motion.estimateMotion(this, a, b, matches, featureCount);
  }
  /** No frame resizing and no averaging of text at the seam. `mask` restricts both frames to one region's atlas
   *  membership. `guide` selects the coarse-to-fine point pick instead of a full-resolution native scan. */
  refineNative(
    a: FrameInput,
    b: FrameInput,
    guess: { x: number; y: number },
    region: Rect,
    mask?: LabelMask,
    radius = 3,
    guide?: NativePointGuide,
  ): RefinementResult {
    return motion.refineNative(this, a, b, guess, region, mask, radius, guide);
  }
  /** Measures how well keyframe patches (region-local, in the keyframe's frame) align in the current native
   *  frame at `guess` (current → keyframe), refining on the native raster. */
  refinePatches(
    patches: PatchInput[],
    native: Gray | ResidentGray,
    region: Rect,
    guess: { x: number; y: number },
    radius = 3,
  ): RefinementResult {
    return motion.refinePatches(this, patches, native, region, guess, radius);
  }
  resampleGray(g: Gray, scale: number): Gray {
    return motion.resampleGray(this, g, scale);
  }
  extractPatches(native: Gray | ResidentGray, region: Rect, features: Point[], factor: number, count = 24, size = 32): PatchInput[] {
    return motion.extractPatches(this, native, region, features, factor, count, size);
  }
  probeScale(
    previous: Gray,
    current: Gray,
    currentFeatures: Feature[],
    roi?: Rect,
    scales?: number[],
  ): { scale: number; error: number } | undefined {
    return motion.probeScale(this, previous, current, currentFeatures, roi, scales);
  }
  /** Plans the frame-wide observation buffers once; each `compositeTile` call then only moves one tile. */
  prepareObservation(obs: CompositeObservation, tileSize: number): PreparedObservation {
    return composite.prepareObservation(this, obs, tileSize);
  }

  /** Every algorithmic-path region of `LayerLearner.finish()` (band detection through sticky-header cleanup),
   *  built in one call. */
  finishRegions(
    width: number,
    height: number,
    cell: number,
    acc: FinishAccumulators,
    nativeWidth: number,
    nativeHeight: number,
    factor: number,
    reference?: FrameInput,
  ): Region[] {
    return finishRegionsImpl(this, this.exports, width, height, cell, acc, nativeWidth, nativeHeight, factor, reference);
  }
  /** The expensive step of `finish()`'s manual-region branch: is every native pixel left uncovered by `manual`? */
  regionsManualUncovered(manual: Rect[], nativeWidth: number, nativeHeight: number): boolean {
    return manualUncovered(this, this.exports, manual, nativeWidth, nativeHeight);
  }
  /** `RegionAtlas`'s pixel labelling for `regions` in one call, written directly into a new core-resident label
   *  plane (never copied out and back), plus the per-code pixel counts. Caller owns the returned `resident`. */
  labelAtlasResident(regions: Region[], width: number, height: number): { resident: Resident; counts: Uint32Array } {
    return labelAtlasResidentImpl(this, this.exports, regions, width, height);
  }
  /** Pose-graph relaxation (`src/core/pose-graph.ts::PoseGraph.optimize`): a handle per call, one Gauss-Seidel
   *  sweep per `poseGraphPass`. */
  poseGraphNew(nodes: PoseGraphNodes, edges: PoseGraphEdges): number {
    return poseGraphNewImpl(this, this.exports, nodes, edges);
  }
  poseGraphSolveCycle(handle: number): boolean {
    return poseGraphSolveCycleImpl(this, this.exports, handle);
  }
  poseGraphPass(handle: number, reverse: boolean): number {
    return poseGraphPassImpl(this.exports, handle, reverse);
  }
  poseGraphResidual(handle: number): number {
    return poseGraphResidualImpl(this.exports, handle);
  }
  poseGraphRead(handle: number, count: number): { x: Float64Array; y: Float64Array } {
    return poseGraphReadImpl(this, this.exports, handle, count);
  }
  poseGraphFree(handle: number): void {
    poseGraphFreeImpl(this.exports, handle);
  }

  /** Per-region, per-frame tracking verdicts for `src/pipeline/solve/track.ts`: stateless, one small call each. */
  trackUncertainty(confidence: number, ambiguous: boolean, weakStep: boolean): boolean {
    return track.uncertainty(this.exports, confidence, ambiguous, weakStep);
  }
  trackRelocalizeVerdict(match: { ambiguous: boolean; confidence: number } | undefined, zoomChange: boolean): boolean {
    return track.relocalizeVerdict(this.exports, match, zoomChange);
  }
  trackFragmentCauseGate(zoomChange: boolean, hasPreviousGray: boolean, blind: boolean): FragmentCauseGate {
    return track.fragmentCauseGate(this.exports, zoomChange, hasPreviousGray, blind);
  }
  trackOcclusionEligible(hasPrevious: boolean, kindMoving: boolean, decision: OcclusionDecision): boolean {
    return track.occlusionEligible(this.exports, hasPrevious, kindMoving, decision);
  }
  trackTargetPose(keyframe: Point, offset: Point, shift: Point): Point {
    return track.targetPose(this, this.exports, keyframe, offset, shift);
  }
  trackAttachVerdict(
    global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number } | undefined,
    resolvedTargetEqCanvas: boolean,
    shift: Point,
  ): Point | undefined {
    return track.attachVerdict(this, this.exports, global, resolvedTargetEqCanvas, shift);
  }
  trackOdometryWeight(weakStep: boolean): number {
    return track.odometryWeight(this.exports, weakStep);
  }
  trackThinOverlapEligible(weakStep: boolean, weak: boolean, ambiguous: boolean, confidence: number, error: number): boolean {
    return track.thinOverlapEligible(this.exports, weakStep, weak, ambiguous, confidence, error);
  }
  trackThinOverlapCorrection(canonicalKeyframe: Point, offset: Point, pose: Point): { target: Point; discrepancy: number } | undefined {
    return track.thinOverlapCorrection(this, this.exports, canonicalKeyframe, offset, pose);
  }
  trackLoopClosureVerdict(
    global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number },
    shift: Point,
    pose: Point,
  ): { verdict: LoopVerdict; discrepancy: number } {
    return track.loopClosureVerdict(this, this.exports, global, shift, pose);
  }
  trackNeedsKeyframe(
    kindMoving: boolean,
    anchor: Point | undefined,
    pose: Point,
    lastNodeFrame: number | undefined,
    rect: { width: number; height: number },
    frameIndex: number,
    fieldDifference: number,
  ): boolean {
    return track.needsKeyframe(this.exports, kindMoving, anchor, pose, lastNodeFrame, rect, frameIndex, fieldDifference);
  }
  trackZoomChanged(regionZoom: number | undefined, fieldZoom: number): boolean {
    return track.zoomChanged(this.exports, regionZoom, fieldZoom);
  }
  trackRegionZoom(kindMoving: boolean, priorMatches: Match[]): number | undefined {
    return track.regionZoom(this, this.exports, kindMoving, priorMatches);
  }
  /** `track.ts::odometry` fused into one call. */
  trackOdometry(inputs: track.OdometryInputs): track.OdometryEstimate {
    return track.odometry(this, this.exports, inputs);
  }
  /** `track.ts::reacquire` fused into one call. */
  trackReacquire(inputs: track.ReacquireInputs): { result: track.ReacquireEstimate | undefined; filledNative: boolean } {
    return track.reacquire(this, this.exports, inputs);
  }
  /** `track.ts::driftCorrection` fused into one call. */
  trackDriftCorrection(
    inputs: track.DriftCorrectionInputs,
  ): { pose: Point | undefined; error: number; filledNative: boolean; confidenceFloor: number } {
    return track.driftCorrection(this, this.exports, inputs);
  }
  /** `keyframes.ts::evaluateCandidates` fused into one call, including its confidence formula and
   *  score/sort/strong-best/rival-ambiguity selection. */
  keyframesEvaluateCandidates(
    keyframes: track.EvaluateCandidatesKeyframe[],
    q: track.EvaluateCandidatesQuery,
  ): { result: track.EvaluateCandidatesResult | undefined; filledNative: boolean } {
    return track.evaluateCandidates(this, this.exports, keyframes, q);
  }
  /** `solve/track.ts::ownFeaturesOf`'s region-membership feature filter, moved out of TS. */
  filterFeatures(features: Feature[], region: Region, factor: number, nativeWidth: number, nativeHeight: number): Feature[] {
    return track.filterFeatures(this, this.exports, features, region, factor, nativeWidth, nativeHeight);
  }

  /** `buildFramedCanvas`'s `frameLayout()`. */
  frameLayout(source: { width: number; height: number }, pane: Rect, boundsWidth: number, boundsHeight: number): FrameLayout {
    return frameLayoutImpl(this, this.exports, source, pane, boundsWidth, boundsHeight);
  }
  /** `buildFramedCanvas`'s `frameCoordinate()` (test/diagnostic use; the per-tile kernels classify inline). */
  frameCoordinate(layout: FrameLayout, x: number, y: number): { x: number; y: number } | undefined | null {
    return frameCoordinateImpl(this, this.exports, layout, x, y);
  }
  /** Opens a `buildFramedCanvas` session for one presentation canvas: uploads the reference frame, computes
   *  background statistics once, and returns the per-output-tile `paintTile`/`foldEvidence` calls. */
  openFramingSession(source: RGBA, layout: FrameLayout, ignoreRegions: Region[], tileSize: number): FramingSession {
    return openFramingSessionImpl(this, this.exports, source, layout, ignoreRegions, tileSize);
  }
}
