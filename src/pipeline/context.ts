// Shell: the state and services every pass (scan/solve/render, and run()'s own framing/pyramid stages) shares,
// plus the storage/progress/pause/stop plumbing around them. Nothing here is an algorithm awaiting a Rust port —
// it is orchestration (storage, diagnostics, progress, batching, failure classification) that stays in TypeScript
// per the project's thin-shell-over-Rust-core architecture (see docs/ARCHITECTURE.md and Engine's own header).
import { createId } from '../core/id.ts';
import type { CanvasMeta, Diagnostic, FrameSource, Gray, Project, Region, RGBA, Settings } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { Namespace } from '../storage/db.ts';
import { Diagnostics } from '../storage/diagnostics.ts';
import { TileStore } from '../storage/tiles.ts';
import { projectIndexKey, projectKey } from '../storage/projects.ts';
import type { LayerLearner, RegionAtlas } from '../core/layers.ts';
import { analysisFactor } from '../core/raster.ts';
import type { FrameRing, Resident, ResidentFrame, ResidentGray, VotingRing } from '../core/wasm.ts';
import { AnalysisComputer } from '../core/compute.ts';
import { DECODED_VIDEO_NOISE } from '../media/source.ts';
import { t } from '../i18n/index.ts';
import type { EngineEvents } from './engine.ts';
/** Every pass, on hitting a decode/analysis/storage failure it cannot recover from, keeps whatever prefix of frames
 * it already committed and reports that instead of failing the whole run. The three passes' wording and detail
 * shape differ only in the pass name and its frame-count noun ("解码"/"求解"/"渲染" — decode/solve/render), and
 * whether a PERSISTENCE failure appends "；存储写入已停止。"; scan's message carries no `detail` (see spec), solve's
 * and render's carry `{ pass, frames }`. Building the event here keeps that repeated shape in one place instead of
 * re-typed at each of the 15 emission sites across scan.ts/solve.ts/render.ts. */
export function prefixOnly(
  code: 'DECODE_PREFIX_ONLY' | 'ANALYSIS_PREFIX_ONLY' | 'PERSISTENCE_PREFIX_ONLY',
  pass: 'scan' | 'solve' | 'render',
  frames: number,
  error: unknown,
): Diagnostic {
  const base = t(`diag.prefixOnly.base.${pass}`, { frames });
  return {
    code,
    severity: 'error',
    message: String(error),
    action: base + (code === 'PERSISTENCE_PREFIX_ONLY' ? t('diag.prefixOnly.suffixPersistence') : t('diag.prefixOnly.suffixDefault')),
    ...(pass === 'scan' ? {} : { detail: { pass, frames } }),
  };
}
/** Wraps a KV failure so per-frame error handling can tell "storage is failing" apart from an algorithmic error,
 * without every call site re-deriving that distinction from error messages or DOMException names. */
export class StorageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StorageError';
  }
}
/** Thrown from the checkpoint callback passed into PoseGraph.optimize() so a mid-relaxation stop request unwinds
 * that call specifically, without pose-graph.ts having to know anything about engine-level stop semantics. */
export class StopRequested extends Error {
  constructor() {
    super('Stop requested.');
    this.name = 'StopRequested';
  }
}
/** Everything scan()/solve()/render() and run()'s own framing/pyramid stages share: project/store/diagnostics/tiles,
 * the decode source and its derived geometry (factor/refineRadius/noise), pause/stop/phase/partial bookkeeping,
 * per-run counters, and the core-resident buffers each pass allocates and the next pass (or run()'s finally) frees.
 * Engine keeps one RunContext for the run's lifetime and exposes the public surface other modules import through
 * thin getters/delegates; run()/scan()/newCanvas()/solve()/render() each take `ctx: RunContext` as their state. */
export class RunContext {
  readonly project: Project;
  readonly store: KV;
  readonly diagnostics: Diagnostics;
  readonly tiles: TileStore;
  paused = false;
  stopRequested = false;
  /** Set (and left set) once a stop request has actually been honoured anywhere in scan/solve/render, unlike
   * `stopRequested` which each of those loops resets to false right after breaking on it. run() reads this —
   * not `stopRequested` — to decide whether the framing and pyramid stages still get to run, so a stop deep
   * inside an earlier stage cannot be forgotten by the time those later stages are reached. Cleared only once,
   * at the very end of run(). */
  stopped = false;
  phase = 'scanning';
  partial = false;
  lastProgress = 0;
  lastPersist = 0;
  historyIndexed = false;
  /** Consistency-voting bookkeeping, reported in `performance` and asserted on by tests/unit/consistency.test.ts:
   *  how many per-frame, per-region voting layers solve() finalised, and how many of those were finalised on
   *  fewer than CONSISTENCY_VERDICT_MIN partner comparisons (a "thin" layer can still flag cells, but never
   *  carries a positive verdict). Only the first and last frames of a run should ever be thin; a larger count
   *  means the voting ring's partner selection (rust/core/src/voting.rs `Ring::partners`) has stopped sharing comparisons fairly. */
  consistencyVotedLayers = 0;
  consistencyThinLayers = 0;
  /** Core-resident voting ring of the running solve pass; released in run()'s finally on every exit path. */
  voting?: VotingRing;
  /** Core-resident render state (frame ring, consistency mask); released with the render pass. The atlas label
   *  plane is NOT here: it is `atlas.resident`, shared read-only by solve/render/compositor, owned by the atlas
   *  itself and released once with it (see `atlas` below), not per-pass. */
  frames?: FrameRing;
  residentMask?: Resident;
  /** Core-resident layer-learning accumulators of the scan pass; finish() releases them, run()'s finally otherwise. */
  learner?: LayerLearner;
  /** Core-resident full-resolution luma plane of the solve pass. */
  nativePlane?: ResidentGray;
  /** Core-resident last-seen pixels of each fixed region during rendering (duplicate-paint detection). */
  fixedPixels = new Map<string, Resident>();
  releaseResidentRenderState(compositor?: { dispose(): void }): void {
    compositor?.dispose();
    this.frames?.free();
    this.residentMask?.free();
    this.nativePlane?.free();
    this.frames = this.residentMask = this.nativePlane = undefined;
    for (const saved of this.fixedPixels.values()) saved.free();
    this.fixedPixels.clear();
  }
  pauseWaiters: (() => void)[] = [];
  processed = 0;
  regions: Region[] = [];
  timings: Record<string, number> = {};
  duplicates = 0;
  skippedPaints = 0;
  /** Built once at the end of scan(), read by solve()/render()/Compositor for the rest of the run. Owns a
   *  core-resident label plane (`atlas.resident`); disposed exactly once, in run()'s finally. */
  atlas?: RegionAtlas;
  source: FrameSource;
  computer: AnalysisComputer;
  /** Integer analysis factor: analysis pixels × factor = native pixels, exactly. Provisional until scan() sees the
   * first decoded frame — a CONTAINER_SIZE_MISMATCH on frame 0 can still rewrite source.info.width/height. */
  factor: number;
  /** Native refinement radius must cover the ±factor/2 quantisation of an integer analysis estimate. */
  refineRadius: number;
  /** Per-channel decode noise this source declares (`MediaInfo.noise`), read once at construction. Every
   * "is this the same content?" comparison in the world-consistency mask is derived from it, so a lossless
   * source (synthetic scenarios, built-in demos) is compared EXACTLY and a decoded recording keeps the
   * H.264/VP9 headroom it has always had. An unknown source is treated as decoded video, the safe reading. */
  readonly noise: number;
  constructor(private db: KV, source: FrameSource, settings: Settings, readonly events: EngineEvents) {
    this.source = source;
    this.computer = new AnalysisComputer(settings.compute || 'cpu');
    const id = createId(), now = new Date().toISOString();
    this.project = {
      id,
      created: now,
      updated: now,
      name: source.info.name,
      settings,
      media: source.info,
      status: 'scanning',
      frames: 0,
      renderedFrames: 0,
      canvasCount: 0,
      tiles: 0,
      observedPixels: 0,
      diagnostics: {},
      regions: [],
      schema: 2,
    };
    this.store = new Namespace(db, `run/${id}/`);
    this.diagnostics = new Diagnostics(this.store, (d) => events.diagnostic(d));
    this.tiles = new TileStore(this.store, settings.tileSize, settings.memoryMB);
    this.factor = analysisFactor(source.info.width, source.info.height, settings.analysisSize);
    this.refineRadius = Math.max(3, Math.ceil(this.factor / 2) + 1);
    this.noise = source.info.noise ?? DECODED_VIDEO_NOISE;
  }
  /** Requests that the run stop at the next checkpoint and, if paused, wakes it so the request is actually seen
   * (a paused run never reaches a checkpoint on its own). Mirrors what src/worker.ts's 'stop' handler does today. */
  stop(): void {
    this.stopRequested = true;
    this.setPaused(false);
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      for (const resolve of this.pauseWaiters.splice(0)) {
        resolve();
      }
    }
  }
  /** The `partial=true; stopped=true; stopRequested=false` dance repeated at every point scan/solve/render honour
   * a stop request mid-pass — folded here so each call site is one line instead of three identical ones. */
  honourStop(): void {
    this.partial = true;
    this.stopped = true;
    this.stopRequested = false;
  }
  async checkpoint(): Promise<void> {
    if (this.paused) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
    }
    // A stop request is recorded here too, not just at each loop's own tail check, so phases that only checkpoint
    // deep inside a helper (framing, pyramid) still end up 'partial' instead of silently finishing 'complete'.
    if (this.stopRequested) {
      this.partial = true;
    }
    // Yield CPU ownership so message handling, cancellation, and pause remain responsive.
    if (performance.now() - this.lastProgress > 100) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  async gray(image: RGBA | ResidentFrame): Promise<Gray> {
    if (image.width !== this.source.info.width || image.height !== this.source.info.height) {
      throw new Error(
        `FRAME_GEOMETRY_CHANGED: observation is ${image.width}×${image.height}; the run is ${this.source.info.width}×${this.source.info.height}.`,
      );
    }
    return this.computer.gray(image, this.factor);
  }
  async persist(): Promise<void> {
    this.project.updated = new Date().toISOString();
    this.project.diagnostics = { ...this.diagnostics.counts };
    this.project.severities = { ...this.diagnostics.severities };
    try {
      await this.db.put(projectKey(this.project.id), this.project);
      // History index, written once: 'project-index/<created ISO>/<id>' → id, so a reverse scan of the prefix
      // lists runs newest-first without scanning every 'project/<id>' row.
      if (!this.historyIndexed) {
        await this.db.put(projectIndexKey(this.project.created, this.project.id), this.project.id);
        this.historyIndexed = true;
      }
    } catch (error) {
      throw new StorageError(error);
    }
    this.events.project(this.project);
    this.lastPersist = performance.now();
  }
  /** Routes a batched scan-phase KV write through the same failure classification as persist(), so a quota or
   * transaction failure there is recognised as a storage failure rather than blamed on the decoder or the analysis. */
  async storagePutMany(rows: { key: string; value: unknown }[]): Promise<void> {
    try {
      await this.store.putMany(rows);
    } catch (error) {
      throw new StorageError(error);
    }
  }
  /** Commit a snapshot, then remove exactly that committed prefix from the pending queue. */
  async commitRows(rows: { key: string; value: unknown }[]): Promise<void> {
    if (!rows.length) return;
    const batch = rows.slice();
    await this.storagePutMany(batch);
    rows.splice(0, batch.length);
  }
  async passMismatch(pass: string, expected: number, actual: number): Promise<void> {
    if (expected === actual) return;
    this.partial = true;
    await this.diagnostics.emit({
      code: 'PASS_FRAME_COUNT_MISMATCH',
      severity: 'error',
      message: t('diag.PASS_FRAME_COUNT_MISMATCH.message', { pass, actual, expected }),
      action: t('diag.PASS_FRAME_COUNT_MISMATCH.action'),
      detail: { pass, expected, actual },
    });
  }
  async report(frame: number, time: number, message: string, fraction?: number, canvas?: CanvasMeta): Promise<void> {
    const now = performance.now();
    if (now - this.lastProgress < 100) {
      return;
    }
    this.lastProgress = now;
    this.events.progress({
      phase: this.phase,
      frames: frame,
      total: this.source.info.frameCount,
      time,
      message,
      fraction: fraction ?? Math.min(1, time / Math.max(.001, this.source.info.duration)),
      canvas,
    });
    if (now - this.lastPersist > 1200) {
      await this.persist();
    }
    await this.checkpoint();
  }
}
