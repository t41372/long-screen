/** `Core`: lifecycle (instantiate the Wasm module, optionally with a shared-memory thread pool; dispose) plus
 *  thin delegating methods for every kernel, so `core().x(...)` keeps its shape while the marshalling for each
 *  domain lives in its own module (`raster.ts`, `features.ts`, `motion.ts`, `chrome.ts`, `consistency.ts`,
 *  `composite.ts`, `png.ts`, `learner.ts`, `voting.ts`). */
import type { Feature, Gray, Match, Motion, MotionField, Point, Rect, Region, RGBA } from '../../types.ts';
import { assertLayout, type CoreExports } from './exports.ts';
import { allocOrThrow, Arena, type BytesInput, type FrameInput, FrameRing, Resident, ResidentFrame, ResidentGray } from './memory.ts';
import { placeFrame as placeFrameImpl, writeRect as writeRectImpl } from './marshal.ts';
import { check as checkStatus } from './exports.ts';
import * as raster from './raster.ts';
import * as featuresDomain from './features.ts';
import * as motion from './motion.ts';
import * as chrome from './chrome.ts';
import * as consistency from './consistency.ts';
import type { ConsistencyMaskInput } from './consistency.ts';
import * as png from './png.ts';
import * as composite from './composite.ts';
import type { CompositeObservation, PreparedObservation } from './composite.ts';
import { learner as learnerFactory, type LearnerHandle } from './learner.ts';
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
} from './pose-graph.ts';
import {
  frameCoordinate as frameCoordinateImpl,
  type FrameLayout,
  frameLayout as frameLayoutImpl,
  type FramingSession,
  openFramingSession as openFramingSessionImpl,
} from './framing.ts';

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
  /** Frame arena: holds a prepared observation across the tile loop, during which transient calls
   *  (e.g. PNG encoding on tile eviction) must not clobber it. Only one observation is live at a time. */
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
  scratch(sizes: number[]): number[] {
    return this.arena.plan(sizes);
  }
  /** Frame-wide scratch space that survives across a tile loop (`composite.ts::prepareObservation`). */
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
  /** RGBA of a decoded frame given in its `VideoFrame.copyTo` layout (see rust/core/src/yuv.rs for the codes). */
  frameToRGBA(
    src: Uint8Array,
    format: number,
    layout: { offset: number; stride: number }[],
    width: number,
    height: number,
    matrix: number,
  ): Uint8ClampedArray {
    return raster.frameToRGBA(this, src, format, layout, width, height, matrix);
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
  pngUnfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8ClampedArray {
    return png.pngUnfilter(this, raw, width, height, channels);
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
  /** Incremental CRC32 for a caller streaming bounded chunks (`src/export/zip.ts`, `src/codec/png.ts::chunk()`). */
  crc32Stream(): png.Crc32 {
    return new png.Crc32(this);
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
  refineNative(
    a: FrameInput,
    b: FrameInput,
    guess: { x: number; y: number },
    region: Rect,
    mask: LabelMask | undefined,
    radius: number,
  ): RefinementResult {
    return motion.refineNative(this, a, b, guess, region, mask, radius);
  }
  refinePatches(
    patches: PatchInput[],
    native: Gray | ResidentGray,
    region: Rect,
    guess: { x: number; y: number },
    radius: number,
  ): RefinementResult {
    return motion.refinePatches(this, patches, native, region, guess, radius);
  }
  resampleGray(g: Gray, scale: number): Gray {
    return motion.resampleGray(this, g, scale);
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
