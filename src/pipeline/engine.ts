import { createId } from '../core/id.ts';
import type {
  Attachment,
  CanvasMeta,
  Diagnostic,
  Feature,
  FrameImage,
  FramePlan,
  FrameSource,
  Gray,
  MotionField,
  Placement,
  Point,
  Progress,
  Project,
  Rect,
  Region,
  RGBA,
  ScanRecord,
  Settings,
} from '../types.ts';
import type { KV } from '../storage/db.ts';
import { deletePrefix, iterate, Namespace } from '../storage/db.ts';
import { Diagnostics } from '../storage/diagnostics.ts';
import { TileStore } from '../storage/tiles.ts';
import { extractFeatures, grayscale, matchFeatures } from '../core/features.ts';
import {
  auditTranslation,
  detectScale,
  estimateMotion,
  extractPatches,
  type NativeRefinement,
  probeScale,
  refineNative,
  refinePatches,
  translationHypotheses,
} from '../core/motion.ts';
import { informativeField, LayerLearner, RegionAtlas, regionContains, stickyOcclusions } from '../core/layers.ts';
import { PoseGraph, type PoseNode } from '../core/pose-graph.ts';
import { type Keyframe, KeyframeIndex } from '../core/keyframes.ts';
import { Compositor } from '../core/compositor.ts';
import { pad } from '../core/math.ts';
import { analysisFactor, equalRGBA, resolveRasterPose } from '../core/raster.ts';
import { encodeRGBA } from '../codec/png.ts';
import { buildFramedCanvas } from '../core/framing.ts';
import { AnalysisComputer } from '../core/compute.ts';
import { DECODED_VIDEO_NOISE } from '../media/source.ts';
interface State {
  region: Region;
  code: number;
  canvasId: string;
  fragment: number;
  pose: Point;
  /** Last accepted native displacement; a weak constant-velocity prior that breaks ties between period-aliased hypotheses. */
  velocity: Point;
  lastNode?: PoseNode;
  anchor?: Keyframe;
  previousFeatures?: Feature[];
  /** Previous frame carried no usable texture in this pane. */
  blind: boolean;
  /** The last accepted step had little overlap, so its alignment rests on thin evidence and revisits may outrank it. */
  weak: boolean;
  /** A textured frame has been observed, so the canvas origin is defined. */
  started: boolean;
}
type Decision = 'tracked' | 'static' | 'blind' | 'lost';
export interface EngineEvents {
  progress: (p: Progress) => void;
  diagnostic: (d: Diagnostic) => void;
  /** Unused: no caller displays the scan-time thumbnail. Kept optional so existing handlers still compile. */
  preview?: (blob: Blob) => void;
  project: (p: Project) => void;
}
/** Wraps a KV failure so per-frame error handling can tell "storage is failing" apart from an algorithmic error,
 * without every call site re-deriving that distinction from error messages or DOMException names. */
class StorageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StorageError';
  }
}
/** Thrown from the checkpoint callback passed into PoseGraph.optimize() so a mid-relaxation stop request unwinds
 * that call specifically, without pose-graph.ts having to know anything about engine-level stop semantics. */
class StopRequested extends Error {
  constructor() {
    super('Stop requested.');
    this.name = 'StopRequested';
  }
}
/** On-disk form of a frame's Feature[] under scan-features/<frame>: three flat typed arrays instead of n small
 * objects each carrying an 8-element descriptor as a JSON array of decimals. Analysis-resolution coordinates fit
 * an Int16Array; only solve() ever reads this, and it is deleted once solve() has consumed the whole run. */
interface CompactFeatures {
  xy: Int16Array;
  score: Float32Array;
  descriptors: Uint32Array;
}
function encodeFeatures(features: Feature[]): CompactFeatures {
  const n = features.length, xy = new Int16Array(n * 2), score = new Float32Array(n), descriptors = new Uint32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const f = features[i];
    xy[i * 2] = f.x;
    xy[i * 2 + 1] = f.y;
    score[i] = f.score;
    descriptors.set(f.descriptor, i * 8);
  }
  return { xy, score, descriptors };
}
function decodeFeatures(c: CompactFeatures): Feature[] {
  const n = c.score.length, out: Feature[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: c.xy[i * 2], y: c.xy[i * 2 + 1], score: c.score[i], descriptor: c.descriptors.subarray(i * 8, i * 8 + 8) as Uint32Array };
  }
  return out;
}
/** Displacement-spread consistency voting (docs/ARCHITECTURE.md §七): analysis-resolution box, in this region's
 * own local coordinates (box.x0/box.y0 offset, box.w×box.h pixels), that bounds the region's roi with a 1px margin
 * so every point the region's own mask can contain has a home cell — computed once per moving region, reused for
 * every ring frame's score/comparisons arrays (which are therefore all the same size and directly comparable). */
interface ConsistencyBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}
/** One moving region's per-frame voting state, scoped to that region's own ConsistencyBox (not the whole analysis
 * frame) to keep the ring's memory bounded to what voting actually touches. `score`/`comparisons` start at zero and
 * accumulate as this frame is compared — both as the "current" frame against older ring partners, and later as an
 * older partner other frames pick while it is still resident. `pairs` is the same accumulation at FRAME level (how
 * many partner frames this one has been paired with, in either role) and exists only to make partner selection fair:
 * without it, `consistencyPartners` keeps re-picking whichever frames happen to sit on its displacement-spread
 * anchors, and a frame whose only clean counterparts lie in the FUTURE accumulates far too few comparisons to ever
 * be finalised either way. `boxGray` is this region's own box-local, region-masked 3×3-blurred luma (see
 * computeBoxGray in solve()) — never the raw per-pixel analysis value — so the vote is insensitive to
 * downscaleGray's box-filter phase (see the block comment at computeBoxGray) without smoothing across this region's
 * own boundary into a neighbour's unrelated content. */
interface ConsistencyLayer {
  canvasId: string;
  pose: Point;
  score: Int8Array;
  comparisons: Uint8Array;
  pairs: number;
  boxGray: Uint8Array;
}
/** One ring-resident frame: every moving region's own ConsistencyLayer (each already carries its own box-local
 * gray, so nothing frame-wide needs to be kept here beyond the index). */
interface ConsistencyFrame {
  index: number;
  bytes: number;
  layers: Map<string, ConsistencyLayer>;
}
/** Persisted analysis-resolution verdict for one frame: per moving region id, the box it was scored in and TWO
 * plain bitsets (LSB-first, row-major over box.w×box.h) — `bits` for cells solve() finalised as inconsistent,
 * `clean` for cells it finalised as confidently consistent. A cell in neither set has NO verdict (too few
 * comparisons to judge, which is the normal state at a region's leading edge and at the very start/end of a run);
 * that three-way distinction is what consistencyMask() needs, because "not flagged" and "found clean" call for
 * opposite treatment when a ±1-frame neighbour disagrees. Only regions with at least one cell in either set are
 * present, and the whole record is omitted when no region has one. */
type ConsistencyVote = ConsistencyBox & { bits: Uint8Array; clean: Uint8Array };
type ConsistencyRecord = Record<string, ConsistencyVote>;
export class Engine {
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
  private stopped = false;
  private phase = 'scanning';
  private partial = false;
  private lastProgress = 0;
  private lastPersist = 0;
  private historyIndexed = false;
  /** Consistency-voting bookkeeping, reported in `performance` and asserted on by tests/unit/consistency.test.ts:
   *  how many per-frame, per-region voting layers solve() finalised, and how many of those were finalised on
   *  fewer than CONSISTENCY_VERDICT_MIN partner comparisons (a "thin" layer can still flag cells, but never
   *  carries a positive verdict). Only the first and last frames of a run should ever be thin; a larger count
   *  means consistencyPartners has stopped sharing comparisons fairly. */
  private consistencyVotedLayers = 0;
  private consistencyThinLayers = 0;
  private pauseWaiters: (() => void)[] = [];
  private processed = 0;
  private regions: Region[] = [];
  private timings: Record<string, number> = {};
  /** Reused native-to-analysis coordinate maps for consistency verdict lookups. */
  private consistencyAnalysisX = new Int32Array(0);
  private consistencyAnalysisY = new Int32Array(0);
  private consistencyAnalysisWidth = 0;
  private consistencyAnalysisHeight = 0;
  private consistencyAnalysisFactor = 0;
  private duplicates = 0;
  private skippedPaints = 0;
  private atlas?: RegionAtlas;
  private source: FrameSource;
  private computer: AnalysisComputer;
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
  constructor(private db: KV, source: FrameSource, settings: Settings, private events: EngineEvents) {
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
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      for (const resolve of this.pauseWaiters.splice(0)) {
        resolve();
      }
    }
  }
  private async checkpoint(): Promise<void> {
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
  private async gray(image: RGBA): Promise<Gray> {
    if (image.width !== this.source.info.width || image.height !== this.source.info.height) {
      throw new Error(
        `FRAME_GEOMETRY_CHANGED: observation is ${image.width}×${image.height}; the run is ${this.source.info.width}×${this.source.info.height}.`,
      );
    }
    return this.computer.gray(image, this.factor);
  }
  private async persist(): Promise<void> {
    this.project.updated = new Date().toISOString();
    this.project.diagnostics = { ...this.diagnostics.counts };
    this.project.severities = { ...this.diagnostics.severities };
    try {
      await this.db.put(`project/${this.project.id}`, this.project);
      // History index, written once: 'project-index/<created ISO>/<id>' → id, so a reverse scan of the prefix
      // lists runs newest-first without scanning every 'project/<id>' row.
      if (!this.historyIndexed) {
        await this.db.put(`project-index/${this.project.created}/${this.project.id}`, this.project.id);
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
  private async storagePutMany(rows: { key: string; value: unknown }[]): Promise<void> {
    try {
      await this.store.putMany(rows);
    } catch (error) {
      throw new StorageError(error);
    }
  }
  /** Commit a snapshot, then remove exactly that committed prefix from the pending queue. */
  private async commitRows(rows: { key: string; value: unknown }[]): Promise<void> {
    if (!rows.length) return;
    const batch = rows.slice();
    await this.storagePutMany(batch);
    rows.splice(0, batch.length);
  }
  private async passMismatch(pass: string, expected: number, actual: number): Promise<void> {
    if (expected === actual) return;
    this.partial = true;
    await this.diagnostics.emit({
      code: 'PASS_FRAME_COUNT_MISMATCH',
      severity: 'error',
      message: `${pass} 阶段只完成 ${actual}/${expected} 帧；结果被标记为 partial。`,
      action: '已保留成功提交的前缀；缺失的帧不会被静默当作已处理。',
      detail: { pass, expected, actual },
    });
  }
  private async report(frame: number, time: number, message: string, fraction?: number, canvas?: CanvasMeta): Promise<void> {
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
  async run(): Promise<Project> {
    try {
      // Inside the try: a failing initial write must still reach the finally below and release the
      // decoder/GPU device, instead of leaking them by throwing before the try is entered.
      await this.persist();
      // The comparison tolerance is a property of the source, not of the algorithm, so the project says which
      // one it ran with: a run that compared exactly and a run that allowed H.264 headroom are not the same
      // evidence, and nothing downstream can tell them apart from the pixels alone.
      await this.diagnostics.emit({
        code: 'MODEL_ASSUMPTIONS',
        severity: 'info',
        message:
          `重建采用分层平移画布与几何回环约束。自动遮罩和动态区域属于启发式推断；置信分数不是经过校准的正确概率。世界一致性比较按本片源声明的解码噪声 ±${this.noise} 级执行${
            this.noise ? '（压缩视频的振铃/色度重建余量）' : '（无损片源，逐像素精确比较）'
          }。`,
        action: '比例或结构无法共存时会保留独立片段，不把不相容的状态强行拼接。',
        detail: { noise: this.noise, lossless: this.noise === 0, source: this.source.info.mode, codec: this.source.info.codec },
      });
      if (this.project.settings.decoder === 'compatibility') {
        await this.diagnostics.emit({
          code: 'APPROXIMATE_DECODER',
          severity: 'warning',
          message:
            `已明确启用 ${this.project.settings.compatibilityFPS} Hz 原生 seek 兼容模式。不能保证采到视频的每一帧，短暂内容可能缺失。`,
          action: '需要逐帧覆盖保证时，使用 WebCodecs 支持的 H.264、VP9 等输入。',
        });
      }
      if (this.source.info.width > this.project.settings.analysisSize || this.source.info.height > this.project.settings.analysisSize) {
        await this.diagnostics.emit({
          code: 'ANALYSIS_PYRAMID',
          severity: 'info',
          message: `运动分析的长边上限为 ${this.project.settings.analysisSize}px；原分辨率像素用于精修和最终合成，输出没有跟随降采样。`,
        });
      }
      for (const warning of this.source.info.warnings) {
        await this.diagnostics.emit({ code: 'MEDIA_NOTICE', severity: 'warning', message: warning });
      }
      if (this.source.info.width * this.source.info.height * 4 * 4 > this.project.settings.memoryMB * 1024 * 1024 * .8) {
        await this.diagnostics.emit({
          code: 'FRAME_MEMORY_PRESSURE',
          severity: 'warning',
          message: '单帧原始像素及参考帧占用已接近所选缓存预算。解码器/GPU 自身内存不受 JavaScript 缓存预算控制。',
          action: '不会静默降低输出分辨率；内存不足时保留已提交数据并报告失败。',
        });
      }
      let phaseStart = performance.now();
      await this.scan();
      this.timings.scanMS = performance.now() - phaseStart;
      if (!this.project.frames) {
        throw new Error('No observations could be decoded. Nothing has been marked as reconstructed.');
      }
      phaseStart = performance.now();
      await this.solve();
      this.timings.solveMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      await this.render();
      this.timings.renderMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      // Presentation-only: a failure here must never turn a finished level-0 reconstruction into partial/error,
      // so it gets its own try/catch and only ever downgrades to a warning diagnostic. Gated on `stopped`
      // (not `stopRequested`): a stop already honoured inside scan/solve/render resets `stopRequested` to
      // false right after breaking, so by the time run() gets here that flag alone can no longer tell a
      // genuine stop apart from never having been asked to stop at all.
      if (this.project.settings.framing === 'context' && !this.stopped) {
        try {
          this.phase = 'framing';
          const originals: CanvasMeta[] = [];
          for await (const { value } of iterate<CanvasMeta>(this.store, 'canvas/')) {
            if (value.kind === 'moving' && value.tileCount && !value.attachedTo) originals.push(value);
          }
          this.events.progress({
            phase: 'framing',
            fraction: 0,
            frames: this.project.renderedFrames,
            time: 0,
            message: '保留原始外框；只延伸背景，不拉伸侧栏文字或重复图标。',
          });
          for (const meta of originals) {
            const region = this.regions.find((r) => r.id === meta.layer)!;
            const framed = await buildFramedCanvas(this.store, this.tiles, meta, region, this.regions, () => this.checkpoint(), {
              onSkipped: (reason) => {
                void this.diagnostics.emit({
                  code: 'PRESENTATION_TOO_SPARSE',
                  severity: 'warning',
                  message: reason,
                  action: '该画布的带外框呈现被跳过；页面坐标下的核心重建不受影响。',
                });
              },
            });
            if (framed) {
              this.project.canvasCount++;
              this.project.tiles += framed.tileCount;
            }
            if (this.stopRequested) {
              this.stopped = true;
              break;
            }
          }
          if (originals.length) {
            await this.diagnostics.emit({
              code: 'PRESENTATION_FRAME',
              severity: 'info',
              message:
                '带外框视图与原始二维内容分别保留。外框来自参考帧，延长部分仅为装饰背景，不算作已观察内容；不会拉伸或复制工具栏图标。其他 pane 在外框中只是参考快照。',
            });
          }
        } catch (error) {
          await this.diagnostics.emit({
            code: 'PRESENTATION_STAGE_FAILED',
            severity: 'warning',
            message: String(error),
            action: '带外框呈现阶段失败；页面坐标下的核心重建结果和状态不受影响。',
          });
        }
      }
      this.timings.framingMS = performance.now() - phaseStart;
      phaseStart = performance.now();
      this.phase = 'pyramid';
      this.project.status = 'pyramid';
      await this.persist();
      // Stop honoured anywhere up to and including framing means no pyramid: the stage is skipped outright,
      // not entered and cut short. Same `stopped` vs `stopRequested` reasoning as the framing gate above.
      if (!this.stopped) {
        try {
          let built = 0;
          for await (const { value: meta } of iterate<CanvasMeta>(this.store, 'canvas/')) {
            if (meta.tileCount) {
              await this.tiles.buildPyramid(meta, async () => {
                await this.checkpoint();
                await this.report(
                  this.project.renderedFrames,
                  meta.lastTime,
                  '正在建立磁盘预览金字塔；原尺寸瓦片保持不变。',
                  built / Math.max(1, this.project.canvasCount),
                  meta,
                );
              });
            }
            built++;
            if (this.stopRequested) {
              this.stopped = true;
              break;
            }
          }
        } catch (error) {
          await this.diagnostics.emit({
            code: 'PYRAMID_FAILED',
            severity: 'warning',
            message: String(error),
            action: '预览金字塔构建失败；原尺寸瓦片不受影响，仍可正常查看和导出。',
          });
        }
      }
      if (this.stopRequested) {
        this.partial = true;
        this.stopRequested = false;
      }
      this.timings.pyramidMS = performance.now() - phaseStart;
      await this.store.put('performance', {
        ...this.timings,
        exactDuplicateFrames: this.duplicates,
        skippedPaints: this.skippedPaints,
        tileEncodes: this.tiles.encodedTiles,
        tileDecodes: this.tiles.decodedTiles,
        tileEvictions: this.tiles.evictions,
        compute: this.computer.stats,
        consistencyVotedLayers: this.consistencyVotedLayers,
        consistencyThinLayers: this.consistencyThinLayers,
        note: 'Stage timings include decoding, storage and yields; not GPU-only kernel time.',
      });
      this.project.status = this.partial ? 'partial' : 'complete';
      await this.diagnostics.flush();
      await this.persist();
      this.events.progress({
        phase: this.project.status,
        fraction: 1,
        frames: this.project.renderedFrames,
        time: this.source.info.duration,
        message: this.partial ? '已保存明确标记的部分重建。' : '重建已完成；请检查诊断与未观察区域。',
      });
    } catch (error) {
      this.project.status = this.project.renderedFrames ? 'partial' : 'error';
      this.project.error = error instanceof Error ? error.message : String(error);
      // Do not destroy committed work when a later operation, codec, or quota fails.
      try {
        // Journaled (not a bare event) so it survives into export and a reopened project, not just the live UI.
        // A StorageError reaching here is a persistence failure, not an algorithmic one — attribute it as
        // PERSISTENCE_ERROR (mirroring the in-loop PERSISTENCE_PREFIX_ONLY handling) instead of the generic
        // PROCESSING_ERROR, which otherwise misattributes a quota/transaction failure to processing.
        const code = error instanceof StorageError ? 'PERSISTENCE_ERROR' : 'PROCESSING_ERROR';
        await this.diagnostics.emit({
          code,
          severity: 'error',
          message: this.project.error,
          action: '已经提交到本地存储的瓦片仍可查看和导出；没有把失败标记成成功。',
        });
        await this.tiles.flush();
        await this.diagnostics.flush();
        await this.persist();
      } catch (storageError) {
        // Storage is already failing here, so this one stays event-only rather than risking a third failed write.
        this.events.diagnostic({
          code: 'PERSISTENCE_ERROR',
          severity: 'error',
          message: String(storageError),
          action: '存储写入也失败；仅先前成功提交的数据可恢复。',
        });
      }
    } finally {
      this.computer.dispose();
      this.source.dispose();
      // The `stopped` latch (unlike `stopRequested`) is deliberately left set across the whole run, from
      // wherever a stop was first honoured through to the framing/pyramid gates above; only run() itself
      // ever reads it, so it is only ever cleared here, once, at the very end of run().
      this.stopped = false;
    }
    return this.project;
  }
  private async scan(): Promise<void> {
    this.phase = 'scanning';
    let previous: Gray | undefined,
      previousImage: RGBA | undefined,
      previousFeatures: Feature[] | undefined,
      lastField: MotionField | undefined,
      learner: LayerLearner | undefined;
    // A long-baseline reference frame for slow scrolling: sub-analysis-pixel per-frame motion never clears the
    // layer-evidence threshold, but the SAME motion accumulated over several frames does. Only informative
    // (single-step or long-baseline) frames move it forward, so exact duplicates never disturb it.
    let baseline: { gray: Gray; image: RGBA; features: Feature[]; index: number } | undefined;
    // Mixed scan/ (ScanRecord) and scan-features/ (CompactFeatures) rows batched together; both are scratch that
    // solve() consumes once and this run deletes afterwards, so one flush cadence for both is enough.
    const pending: { key: string; value: unknown }[] = [];
    const it = this.source.frames();
    let storageFailed = false;
    let endedNaturally = false;
    try {
      while (true) {
        await this.checkpoint();
        // The decode step (next()) and the per-frame body are two separate try blocks below so a body failure
        // (algorithm or storage) is never blamed on the decoder, and a decoder failure is never misclassified
        // as an analysis or storage error.
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!this.project.frames) {
            throw error;
          }
          this.partial = true;
          await this.diagnostics.emit({
            code: 'DECODE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成。`,
          });
          break;
        }
        if (step.done) {
          endedNaturally = true;
          break;
        }
        const frame = step.value;
        try {
          if (frame.index === 0) {
            // Provisional until now: a CONTAINER_SIZE_MISMATCH notice on this very frame may just have
            // rewritten source.info.width/height, so the factor is derived only after that can no longer change.
            this.factor = analysisFactor(this.source.info.width, this.source.info.height, this.project.settings.analysisSize);
            this.refineRadius = Math.max(3, Math.ceil(this.factor / 2) + 1);
          }
          const duplicate = !!previousImage && equalRGBA(previousImage, frame.image);
          const g = duplicate ? previous! : await this.gray(frame.image), features = duplicate ? previousFeatures! : extractFeatures(g);
          learner ??= new LayerLearner(g.width, g.height);
          let field: MotionField;
          if (duplicate && lastField) {
            this.duplicates++;
            field = {
              ...lastField,
              motions: [{ x: 0, y: 0, support: features.length, unique: features.length, confidence: 1, error: 0, ambiguous: false }],
              labels: new Uint8Array(lastField.labels.length),
              dynamic: new Uint8Array(lastField.labels.length),
              difference: 0,
              unknown: false,
              zoom: 1,
            };
          } else if (previous) {
            field = estimateMotion(previous, g, lastField, previousFeatures, features);
            if (informativeField(field)) {
              learner.add(field, previous, g, previousImage, frame.image);
              baseline = { gray: g, image: frame.image, features, index: frame.index };
            } else if (baseline && frame.index - baseline.index >= 4) {
              // The same displacement measured over more frames crosses the analysis-pixel evidence threshold
              // that a single sub-pixel step cannot; this is the only extra estimateMotion call, and only here.
              const longField = estimateMotion(baseline.gray, g, undefined, baseline.features, features);
              if (informativeField(longField)) {
                learner.add(longField, baseline.gray, g, baseline.image, frame.image);
                baseline = { gray: g, image: frame.image, features, index: frame.index };
              } else if (frame.index - baseline.index > 24) {
                baseline = { gray: g, image: frame.image, features, index: frame.index };
              }
            }
          } else {
            const cols = Math.ceil(g.width / 24), rows = Math.ceil(g.height / 24);
            field = {
              motions: [{ x: 0, y: 0, support: features.length, unique: features.length, confidence: 1, error: 0, ambiguous: false }],
              labels: new Uint8Array(cols * rows),
              confidence: new Uint8Array(cols * rows).fill(255),
              dynamic: new Uint8Array(cols * rows),
              cols,
              rows,
              cell: 24,
              difference: 0,
              featureCount: features.length,
              unknown: false,
              zoom: 1,
            };
            baseline = { gray: g, image: frame.image, features, index: frame.index };
            await this.diagnostics.emit({
              code: 'COMPUTE_BACKEND',
              severity: 'info',
              message: `${this.computer.stats.backend} — ${this.computer.stats.reason}。匹配、位置图与像素合成仍在 CPU。`,
              detail: this.computer.stats,
            });
            if (this.project.settings.framing === 'context') {
              // Presentation-only: buildFramedCanvas already skips framing when this row is missing, so an
              // encode/storage failure here must not abort the run — just demote to a warning.
              try {
                await this.store.put('frame-reference', {
                  frame: frame.index,
                  image: new Blob([await encodeRGBA(frame.image)], { type: 'image/png' }),
                });
              } catch (error) {
                await this.diagnostics.emit({
                  code: 'PRESENTATION_REFERENCE_FAILED',
                  severity: 'warning',
                  message: String(error),
                  action: '带外框呈现将被跳过；页面坐标下的核心重建不受影响。',
                });
              }
            }
          }
          const record: ScanRecord = { index: frame.index, time: frame.time, duration: frame.duration, field, duplicate };
          pending.push({ key: `scan/${pad(frame.index)}`, value: record });
          if (!duplicate) {
            pending.push({ key: `scan-features/${pad(frame.index)}`, value: encodeFeatures(features) });
          }
          if (pending.length >= 24) {
            await this.commitRows(pending);
          }
          this.project.frames = frame.index + 1;
          previous = g;
          previousImage = frame.image;
          previousFeatures = features;
          lastField = field;
          if (features.length < 8 && frame.index === 0) {
            await this.diagnostics.emit({
              code: 'LOW_TEXTURE_UNOBSERVABLE',
              severity: 'warning',
              time: frame.time,
              frame: frame.index,
              message: '画面缺乏可辨认纹理。完全相同的空白帧既可能是暂停，也可能是在空白区域移动；像素本身无法区分。',
              action: '增加有区分度的可见内容或录制更多重叠。零位移只是 best guess。',
            });
          }
          if (field.unknown) {
            await this.diagnostics.emit({
              code: 'UNRESOLVED_MOTION',
              severity: 'warning',
              time: frame.time,
              frame: frame.index,
              message: '这一观察缺少可靠的视觉对齐依据。定位阶段将尝试历史重定位；仍无法定位时保留独立片段。',
              confidence: 0,
            });
          }
          if (field.motions[0]?.ambiguous && field.motions[0].support >= 6) {
            await this.diagnostics.emit({
              code: 'AMBIGUOUS_PATTERN',
              severity: 'warning',
              time: frame.time,
              frame: frame.index,
              message: '检测到具有多种合理匹配的重复纹理；连续性只是定位先验，不是已证实的唯一位置。',
            });
          }
          if (frame.duration > .12) {
            await this.diagnostics.emit({
              code: 'TEMPORAL_UNDERSAMPLING',
              severity: 'info',
              time: frame.time,
              frame: frame.index,
              message: '此帧持续时间较长；高速移动期间可能存在从未被采集到的区域。',
            });
          }
          await this.report(frame.index + 1, frame.time, '逐帧提取几何证据，学习独立运动区域。');
          if (this.stopRequested) {
            this.partial = true;
            this.stopped = true;
            this.stopRequested = false;
            break;
          }
        } catch (error) {
          if (!this.project.frames) {
            throw error;
          }
          this.partial = true;
          if (error instanceof StorageError) {
            storageFailed = true;
            // Storage is failing: mark partial and stop, do not attempt another write. The diagnostic itself
            // goes through the journal only if that journal write succeeds.
            try {
              await this.diagnostics.emit({
                code: 'PERSISTENCE_PREFIX_ONLY',
                severity: 'error',
                message: String(error),
                action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成；存储写入已停止。`,
              });
            } catch { /* the journal write itself failed too; the run is already marked partial. */ }
            break;
          }
          // A frame-geometry mismatch (mid-recording rotation/resolution change) is a source/decoder-level
          // anomaly, not an algorithmic one, even though gray() only notices it once the body already has
          // the frame in hand; it is reported the same way a decode failure is.
          if (error instanceof Error && error.message.startsWith('FRAME_GEOMETRY_CHANGED')) {
            await this.diagnostics.emit({
              code: 'DECODE_PREFIX_ONLY',
              severity: 'error',
              message: String(error),
              action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成。`,
            });
            break;
          }
          await this.diagnostics.emit({
            code: 'ANALYSIS_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成。`,
          });
          break;
        }
      }
    } finally {
      // Switching from for-await-of to manual next() calls lost the implicit return() an early break used to
      // get for free; restore it explicitly so the decoder is released on every exit path.
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
    }
    if (pending.length && !storageFailed) {
      // Routed through storagePutMany (not a bare store.putMany) so a quota/transaction failure on this
      // trailing <24-row batch is classified and handled the same way an in-loop flush failure is — partial
      // and PERSISTENCE_PREFIX_ONLY — instead of escaping scan() entirely as an unclassified top-level error.
      try {
        await this.commitRows(pending);
      } catch (error) {
        this.partial = true;
        storageFailed = true;
        try {
          await this.diagnostics.emit({
            code: 'PERSISTENCE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经解码的前 ${this.project.frames} 帧继续定位和合成；存储写入已停止。`,
          });
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if (endedNaturally && this.source.info.frameCount !== undefined) {
      const preroll = this.source.info.notices?.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')?.count || 0;
      await this.passMismatch('scan', this.source.info.frameCount - preroll, this.project.frames);
    }
    for (const notice of this.source.info.notices || []) {
      await this.diagnostics.emit({
        code: notice.code,
        severity: 'warning',
        message: notice.message,
        count: notice.count,
        detail: { count: notice.count },
      });
    }
    this.regions = learner?.finish(this.source.info.width, this.source.info.height, this.project.settings.regions, this.factor) || [];
    this.atlas = new RegionAtlas(this.regions, this.source.info.width, this.source.info.height);
    this.project.regions = this.regions.map(({ mask: _mask, ...r }) => r);
    await this.store.put('regions', this.regions);
    if (this.regions.some((r) => r.unassigned)) {
      await this.diagnostics.emit({
        code: 'MANUAL_UNASSIGNED',
        severity: 'warning',
        message: '手动区域未覆盖的部分被保留为独立的低置信屏幕坐标观察层，没有宣称这些像素已恢复到页面坐标。',
      });
    }
    if (this.regions.some((r) => r.kind === 'ignore')) {
      await this.diagnostics.emit({
        code: 'EXPLICITLY_EXCLUDED_REGION',
        severity: 'warning',
        message: '按手动设置排除了“忽略”区域。该区域不会贡献到重建结果，这不是自动丢帧。',
      });
    }
    if (this.project.settings.regions.length) {
      await this.diagnostics.emit({
        code: 'MANUAL_REGION_PRIORITY',
        severity: 'info',
        message: '手动区域重叠时，后绘制区域优先；忽略区域始终排除。其余像素保留在未指定观察层。',
      });
    }
    const moving = this.regions.filter((r) => r.kind === 'moving').length, fixed = this.regions.filter((r) => r.kind === 'fixed').length;
    if (!this.project.settings.regions.length) {
      await this.diagnostics.emit({
        code: 'AUTOMATIC_LAYER_MASK',
        severity: 'info',
        message: `自动划分出 ${moving} 个内容区域和 ${fixed} 个固定界面区域。边界来自像素运动统计，而不是 DOM。`,
        action: '若遮罩归属不合理，可在“区域”里画出精确滚动区后重新处理。',
      });
    }
    if (moving > 1) {
      await this.diagnostics.emit({
        code: 'MULTIPLE_SCROLL_LAYERS',
        severity: 'info',
        message: '多个独立滚动区将分别建立画布，不强制共享一个 scroll offset。',
      });
    }
    await this.diagnostics.flush();
    await this.persist();
  }
  private async newCanvas(state: State, time: number): Promise<void> {
    state.canvasId = `${state.region.id}-part-${state.fragment}`;
    const meta: CanvasMeta = {
      id: state.canvasId,
      layer: state.region.id,
      name: state.region.name + (state.fragment ? ` · 未定位片段 ${state.fragment}` : ''),
      kind: state.region.kind,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      tileCount: 0,
      observedPixels: 0,
      uncertainPixels: 0,
      conflictPixels: 0,
      provisionalPixels: 0,
      maxLevel: 0,
      fragment: state.fragment,
      firstTime: time,
      lastTime: time,
    };
    await this.store.put(`canvas/${meta.id}`, meta);
    this.project.canvasCount++;
  }
  private async solve(): Promise<void> {
    this.phase = 'solving';
    this.project.status = 'solving';
    await this.persist();
    const graph = new PoseGraph(this.store),
      index = new KeyframeIndex(
        this.store,
        async (message) => this.diagnostics.emit({ code: 'RELOCALIZATION_BUDGET', severity: 'warning', message }),
      );
    const atlas = this.atlas!, f = this.factor, radius = this.refineRadius, attachments = new Map<string, Attachment>();
    const states: State[] = this.regions.filter((r) => r.kind !== 'ignore').map((region) => ({
      region,
      code: atlas.code(region),
      canvasId: '',
      fragment: 0,
      pose: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      blind: false,
      weak: false,
      started: false,
    }));
    let previous: RGBA | undefined,
      previousGray: Gray | undefined,
      previousFeaturesAll: Feature[] | undefined,
      previousPlan: FramePlan | undefined,
      solved = 0;
    const pending: { key: string; value: FramePlan }[] = [];
    let endedNaturally = false;
    let missingScan = false;
    // Displacement-spread consistency voting (docs/ARCHITECTURE.md §七): a ring of recent analysis-resolution
    // frames per run, bounded by gray bytes retained (native frames are never kept here). For each moving
    // region's placement, pixels are compared against several ring partners whose world displacement clears
    // Dmin — spread across the available range, not just the immediate neighbour — so a screen-fixed overlay
    // whose own screen extent exceeds one frame's scroll velocity (which defeats a pure ±1-frame check, see
    // consistencyMask()) still gets caught once the ring holds a partner displaced far enough that the overlay
    // cannot possibly still be at the same world position in both frames.
    const CONSISTENCY_RING_BYTES = 24 * 1024 * 1024, CONSISTENCY_PARTNERS = 6;
    // Vote agreement threshold, from the SAME knob as the native ±1 check (this.noise) plus one term the native
    // check does not need. `downscaleGray`'s box filter is anchored to screen pixel (0,0), not to world content,
    // so at f>1 the same world pixel lands at a different SUB-CELL PHASE in two frames whenever their pose delta
    // is not a multiple of the factor — true of nearly every partner pair. That is a real, content-dependent
    // difference between two averages of the SAME lossless pixels, so it cannot be charged to decode noise and
    // does not go away on a lossless source; `computeBoxGray`'s 3×3 average suppresses it but does not erase it.
    // CONSISTENCY_PHASE is the residual headroom it needs, measured on `factor4`/`retina` (both lossless), and
    // it applies on exactly the same condition as the blur itself: f>1 only. At f=1 analysis IS native
    // resolution, there is no phase term at all, and a lossless source is therefore compared exactly.
    // `Math.max` rather than a sum so a decoded recording keeps precisely the 26 it has always had.
    const CONSISTENCY_PHASE = 26, CONSISTENCY_TAU = Math.max(f === 1 ? 0 : CONSISTENCY_PHASE, Math.round(this.noise * 2.6));
    // The local-search radius scales with the analysis factor: one analysis cell already averages f×f native
    // pixels, so the fractional-analysis-cell misalignment a given native-pixel pose residual produces grows
    // with f too (see the comment on the local search below). Measured: f=1 needs none beyond the exact cell,
    // f=2 needs ±1, f=4 (factor4, the largest factor any scenario uses) needs the full ±f to stay noise-free
    // on fine "cards"-style text/border content — tests/unit/scenarios_d.test.ts's `factor4` and `retina`
    // scenarios (no overlay, no dynamics) are the actual regression tests for this: provisionalPixels must
    // stay exactly 0 there.
    const consistencyRadius = f, consistencyW = this.source.info.width, consistencyH = this.source.info.height;
    const consistencyRing: ConsistencyFrame[] = [];
    let consistencyRingBytes = 0;
    const consistencyBox = new Map<string, ConsistencyBox>(), consistencyDmin = new Map<string, number>();
    for (const state of states) {
      if (state.region.kind !== 'moving') {
        continue;
      }
      const rect = state.region.rect, x0 = Math.floor(rect.x / f) - 1, y0 = Math.floor(rect.y / f) - 1;
      consistencyBox.set(state.region.id, {
        x0,
        y0,
        w: Math.ceil((rect.x + rect.width) / f) - x0 + 1,
        h: Math.ceil((rect.y + rect.height) / f) - y0 + 1,
      });
      consistencyDmin.set(state.region.id, Math.max(64, .25 * Math.min(rect.width, rect.height)));
    }
    // Which box cells may take part in a vote at all, precomputed once per region (the box and the region mask
    // are both constant for the whole run). A cell qualifies only when it is INTERIOR: the cell itself and all
    // eight of its blur taps are inside this region, and the whole ±consistencyRadius search window around it
    // fits inside the box. Both exclusions are about the same measured failure — a cell at the region's own
    // boundary is compared using values its neighbour never had. computeBoxGray replaces an out-of-region tap
    // with the centre cell's raw value (edge replication, the right call for the blur itself); a partner cell
    // away from ITS own boundary is a plain 9-tap average, so the two differ by a content-dependent bias with
    // nothing to do with an overlay. A clipped search window loses candidates on one side only, which biases
    // the same way. Neither bias cancels over partners, so at a leading edge — where a cell has only two or
    // three comparisons to begin with — they were enough to carry a unanimous false "inconsistent" verdict on
    // `retina`, on ordinary page content with no overlay anywhere near it.
    const consistencyInterior = new Map<string, Uint8Array>();
    for (const state of states) {
      if (state.region.kind !== 'moving') {
        continue;
      }
      const r = state.region, box = consistencyBox.get(r.id)!, mask = new Uint8Array(box.w * box.h);
      for (let ly = 0; ly < box.h; ly++) {
        for (let lx = 0; lx < box.w; lx++) {
          if (lx < consistencyRadius || ly < consistencyRadius || lx >= box.w - consistencyRadius || ly >= box.h - consistencyRadius) {
            continue;
          }
          let ok = true;
          for (let oy = -1; oy <= 1 && ok; oy++) {
            for (let ox = -1; ox <= 1 && ok; ox++) {
              ok = regionContains(r, (box.x0 + lx + ox) * f, (box.y0 + ly + oy) * f, consistencyW, consistencyH);
            }
          }
          mask[ly * box.w + lx] = ok ? 1 : 0;
        }
      }
      consistencyInterior.set(r.id, mask);
    }
    const pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
    /** Picks up to CONSISTENCY_PARTNERS ring frames on the same canvas whose displacement from `pose` clears
     * `dmin`. Candidates are sorted by displacement; the NEAREST TWO and the FARTHEST are always taken, and the
     * remaining slots cut what is left into equal index bands and take one from each. Three properties are being
     * balanced, and all three were measured:
     *  - SPREAD. Every partner already clears `dmin` (chosen larger than any plausible overlay), so any single
     *    one of them is far enough that a screen-fixed overlay cannot still sit at the same world position. The
     *    spread matters for the different reason quantified in the finalisation comment below: a CLEAN pixel at
     *    world position P disagrees with a partner whose displacement happens to land P inside THAT frame's own
     *    overlay footprint — a window exactly as wide as the overlay. Partners bunched into a narrow
     *    displacement range fall into that window together or not at all, which is how a couple of coincidences
     *    turn into a false flag; spreading them makes the coincidences independent.
     *  - THE LEADING EDGE. A world position that has just scrolled into view is visible in NO past frame, so
     *    every partner that can ever judge it is a future frame picking this one — and among those, the nearest
     *    qualifying ones overlap it most. Taking the two nearest is what gives such a cell its two comparisons
     *    at all; without them the whole leading-edge band finalises with no verdict, which is where screen
     *    overlays do most of their damage (they get painted on the very first look at a position).
     *  - FAIRNESS. Inside each band the candidate with the FEWEST comparisons so far wins (ties by the larger
     *    displacement). Picking by displacement alone kept landing on the same few anchor frames, so a frame
     *    whose clean counterparts are all in the future was rarely chosen by any of them. Since a comparison
     *    scores BOTH frames (see consistencyCompare) and a frame is only finalised when it leaves the ring, a
     *    late pick still counts in full; `performance.consistencyThinLayers` is the watchdog for this. */
    const consistencyPartners = (
      regionId: string,
      canvasId: string,
      pose: Point,
      dmin: number,
    ): { entry: ConsistencyFrame; layer: ConsistencyLayer }[] => {
      const candidates: { entry: ConsistencyFrame; layer: ConsistencyLayer; d: number }[] = [];
      for (const entry of consistencyRing) {
        const layer = entry.layers.get(regionId);
        if (!layer || layer.canvasId !== canvasId) {
          continue;
        }
        const d = Math.hypot(pose.x - layer.pose.x, pose.y - layer.pose.y);
        if (d >= dmin) {
          candidates.push({ entry, layer, d });
        }
      }
      if (candidates.length <= CONSISTENCY_PARTNERS) {
        return candidates;
      }
      candidates.sort((a, b) => a.d - b.d);
      const n = candidates.length, seen = new Set<number>(), out: typeof candidates = [];
      const take = (c: typeof candidates[number] | undefined) => {
        if (c && !seen.has(c.entry.index)) {
          seen.add(c.entry.index);
          out.push(c);
        }
      };
      take(candidates[0]);
      take(candidates[1]);
      take(candidates[n - 1]);
      const bands = CONSISTENCY_PARTNERS - out.length, lo = 2, hi = n - 1;
      for (let band = 0; band < bands && hi > lo; band++) {
        const from = lo + Math.floor(band * (hi - lo) / bands), to = lo + Math.floor((band + 1) * (hi - lo) / bands);
        let best: typeof candidates[number] | undefined;
        for (let i = from; i < to; i++) {
          const c = candidates[i];
          if (seen.has(c.entry.index)) {
            continue;
          }
          if (!best || c.layer.pairs < best.layer.pairs || c.layer.pairs === best.layer.pairs && c.d > best.d) {
            best = c;
          }
        }
        take(best);
      }
      return out;
    };
    /** Builds one region's box-local analysis luma for voting. At f=1 (analysis IS native resolution — the
     * common case) this is a plain copy: downscaleGray at factor 1 samples exactly one native pixel per
     * analysis cell, so there is no box-filter phase to suppress and blurring would only ever cost accuracy
     * (measured: it introduces a small but real boundary artifact, below). At f>1 it is a 3×3 box-blur, region-
     * masked like core/features.ts's smooth() but with every tap outside the box or outside THIS region's own
     * mask (a neighbouring region, a fixed overlay just past the boundary, or off-frame) excluded from the
     * average rather than bleeding in. Root cause, measured with a temporary per-comparison diff histogram on
     * `factor4`/`retina`: downscaleGray's box filter grid is fixed to SCREEN pixel 0,0 in every frame, not to
     * world content, so the same world pixel lands in analysis cells at a different SUB-CELL PHASE in frame T
     * vs a ring partner S whenever their pose delta isn't a multiple of the analysis factor — true for nearly
     * every partner pair. Flat content is insensitive to this; a sharp edge (card borders/text — exactly what
     * these scenarios render) genuinely changes the averaged luma by tens of levels even though the underlying
     * world pixels are bit-identical. The ±consistencyRadius local search below already picks the best nearby
     * cell, but "best nearby single raw cell" still can't reconstruct a value the box filter never computed at
     * that phase. Two things were measured and rejected before settling on region-masked-with-edge-replication:
     * a plain (region-unaware) blur leaks a neighbouring fixed region's constant colour into THIS region's own
     * boundary row (regressed `fixture`/`geometry-change`, both f=1 — every flagged cell sat at the box's first
     * real row); simply DROPPING an excluded tap instead of substituting something for it leaves a smaller but
     * still nonzero residual, because at the region's true edge only 4–6 of the 9 taps are ever in-region, so
     * the average is weaker there and doesn't fully suppress the same phase noise. Replacing excluded taps with
     * the CENTRE cell's own raw value (edge replication, the standard box-filter boundary treatment) restores
     * full 9-tap averaging strength everywhere without ever importing a neighbour's content — but this in turn
     * only matters at f>1: gating the whole blur off at f=1 is what finally cleared `fixture`/`geometry-change`,
     * because at f=1 the blur (any variant of it) was solving a problem — box-filter phase — that provably does
     * not exist there, while still paying its edge-asymmetry cost (T's boundary cell uses a centre-weighted
     * value; the partner cell it is compared against, offset by a generally-fractional pose delta, usually
     * lands away from ITS OWN box edge and gets a plain unweighted average — a small but real bias between the
     * two on any content with a local gradient, e.g. right next to a card border). */
    const computeBoxGray = (region: Region, box: ConsistencyBox, g: Gray): Uint8Array => {
      const out = new Uint8Array(box.w * box.h);
      for (let ly = 0; ly < box.h; ly++) {
        const ay = box.y0 + ly;
        for (let lx = 0; lx < box.w; lx++) {
          const ax = box.x0 + lx;
          if (ax < 0 || ay < 0 || ax >= g.width || ay >= g.height) {
            continue;
          }
          const centre = g.data[ay * g.width + ax];
          if (f === 1) {
            out[ly * box.w + lx] = centre;
            continue;
          }
          let sum = 0;
          for (let oy = -1; oy <= 1; oy++) {
            const ty = ay + oy;
            for (let ox = -1; ox <= 1; ox++) {
              const tx = ax + ox;
              sum +=
                tx < 0 || ty < 0 || tx >= g.width || ty >= g.height || !regionContains(region, tx * f, ty * f, consistencyW, consistencyH)
                  ? centre
                  : g.data[ty * g.width + tx];
            }
          }
          out[ly * box.w + lx] = Math.round(sum / 9);
        }
      }
      return out;
    };
    /** Compares region cells of `layerT` (the frame just placed) against ring partner `layerS` at the SAME
     * world position (world = box-local cell + pose/f), updating BOTH layers' score/comparisons — a pair flags
     * the evidence in the past frame too, not only the current one. Both layers share the SAME box (one per
     * region, constant for the whole run), so displacement stays entirely in that box's own local coordinates —
     * no absolute frame coordinates, and no separate region-membership check on the search window's raw
     * candidates (they are only ever used to pick the least-bad match; a candidate outside the region, if nearer
     * in value, would only ever make agreement MORE likely, and a cell whose own (lx,ly) or matched (sx,sy)
     * isn't in the region is skipped up front exactly as before). */
    const consistencyCompare = (
      box: ConsistencyBox,
      interior: Uint8Array,
      layerT: ConsistencyLayer,
      layerS: ConsistencyLayer,
    ): void => {
      const dx = (layerT.pose.x - layerS.pose.x) / f, dy = (layerT.pose.y - layerS.pose.y) / f;
      layerT.pairs++;
      layerS.pairs++;
      for (let ly = 0; ly < box.h; ly++) {
        for (let lx = 0; lx < box.w; lx++) {
          const i = ly * box.w + lx;
          if (!interior[i]) {
            continue;
          }
          const sx = Math.round(lx + dx), sy = Math.round(ly + dy), si = sy * box.w + sx;
          if (sx < 0 || sy < 0 || sx >= box.w || sy >= box.h || !interior[si]) {
            continue;
          }
          // A ±consistencyRadius-cell local search around (sx, sy), not a single rigid point sample: the
          // pose delta between two ring frames is a NATIVE-pixel quantity divided by the integer analysis
          // factor, so it is essentially never an exact multiple of one analysis cell (a 1-native-pixel
          // jitter alone is already a fractional analysis cell at factor 2) — rounding that to the
          // nearest cell lands one or more cells off from the true match on any edge or textured content
          // often enough to swamp real signal with false disagreements. A native ±1-frame comparison
          // doesn't need this (native resolution has no such quantization); analysis resolution does,
          // more so at larger analysis factors (see consistencyRadius above).
          let best = 255;
          for (let oy = -consistencyRadius; oy <= consistencyRadius && best > CONSISTENCY_TAU; oy++) {
            const py = sy + oy;
            if (py < 0 || py >= box.h) {
              continue;
            }
            for (let ox = -consistencyRadius; ox <= consistencyRadius; ox++) {
              const px = sx + ox;
              if (px < 0 || px >= box.w) {
                continue;
              }
              const diff = Math.abs(layerT.boxGray[i] - layerS.boxGray[py * box.w + px]);
              if (diff < best) {
                best = diff;
              }
            }
          }
          const agree = best <= CONSISTENCY_TAU;
          layerT.comparisons[i] = Math.min(255, layerT.comparisons[i] + 1);
          layerT.score[i] = Math.max(-128, Math.min(127, layerT.score[i] + (agree ? 1 : -1)));
          layerS.comparisons[si] = Math.min(255, layerS.comparisons[si] + 1);
          layerS.score[si] = Math.max(-128, Math.min(127, layerS.score[si] + (agree ? 1 : -1)));
        }
      }
    };
    // Finalisation threshold — a deliberate, measured deviation from the literal "≥2 comparisons, net score <
    // 0" wording. A screen-fixed overlay recurs in EVERY frame at the same screen position, so for a genuinely
    // clean pixel at world position P in frame t, a partner s with displacement D disagrees with it whenever P
    // falls inside s's OWN overlay footprint — which happens whenever D lands in a window exactly as wide as
    // the overlay's own extent, positioned by P (proven and measured with a dedicated fixture:
    // tests/unit/consistency.test.ts). Because CONSISTENCY_PARTNERS spreads displacements across the whole
    // available range, it is common for one or more of the ~6 selected partners to land in that window purely
    // by coincidence — a simple majority ("≥2, <0") lets a couple of such coincidences flip a clean pixel.
    // Requiring literal unanimity (comparisons === CONSISTENCY_PARTNERS, score === -CONSISTENCY_PARTNERS) fixed
    // that, but has its own cost: a frame with fewer than 6 qualifying partners (near the start/end of a run,
    // or a canvas with few same-canvas frames) can never flag anything at all, and a single coincidentally-
    // agreeing partner blocks healing even with 5 other partners unanimously disagreeing. A ratio rule keeps
    // both properties that matter — comparisons in {2,3} still require literal unanimity (⌈0.75×2⌉=2,
    // ⌈0.75×3⌉=3), so a thin sample is never trusted on a bare majority — while comparisons ≥4 only need a
    // ≥75% supermajority, which a genuine overlay interior (disagreeing with essentially every partner) clears
    // easily but a single coincidental agreement no longer blocks outright.
    const consistencyThreshold = (comparisons: number): number => comparisons - 2 * Math.ceil(comparisons * .75);
    // A POSITIVE verdict is the exact mirror of the negative one (score ≥ −consistencyThreshold(comparisons):
    // 3/3, 3/4, 4/5, 5/6 agreements), and additionally needs CONSISTENCY_VERDICT_MIN comparisons, because it
    // is trusted for more than flagging — consistencyMask() lets it overrule a disagreeing ±1-frame neighbour,
    // and lets a NEIGHBOUR's own positive verdict decide whether that neighbour may condemn this frame. Two
    // unanimous comparisons are enough to raise suspicion (a flag only ever marks a pixel provisional, which
    // a later clean look can undo); they are not enough to overrule direct native-resolution evidence.
    const CONSISTENCY_VERDICT_MIN = 3;
    /** Finalises one ring frame once it is about to leave the ring (or solve() is ending). A box cell meeting
     * the ratio threshold above (comparisons ≥ 2, net score ≤ consistencyThreshold) is inconsistent; one
     * meeting the mirrored positive threshold on ≥ CONSISTENCY_VERDICT_MIN comparisons is confidently
     * consistent; everything else — including every cell no partner could compare at all — is left with no
     * verdict. Only regions that end up with at least one cell in either set are written into the record. */
    const consistencyFinalize = (entry: ConsistencyFrame): void => {
      const record: ConsistencyRecord = {};
      let any = false;
      for (const [regionId, layer] of entry.layers) {
        const box = consistencyBox.get(regionId)!;
        const bits = new Uint8Array(Math.ceil(box.w * box.h / 8)), clean = new Uint8Array(bits.length);
        let regionAny = false;
        this.consistencyVotedLayers++;
        if (layer.pairs < CONSISTENCY_VERDICT_MIN) {
          this.consistencyThinLayers++;
        }
        for (let i = 0; i < layer.score.length; i++) {
          const comparisons = layer.comparisons[i];
          if (comparisons >= 2 && layer.score[i] <= consistencyThreshold(comparisons)) {
            bits[i >> 3] |= 1 << (i & 7);
            regionAny = true;
          } else if (comparisons >= CONSISTENCY_VERDICT_MIN && layer.score[i] >= -consistencyThreshold(comparisons)) {
            clean[i >> 3] |= 1 << (i & 7);
            regionAny = true;
          }
        }
        if (regionAny) {
          record[regionId] = { ...box, bits, clean };
          any = true;
        }
      }
      if (any) {
        pendingConsistency.push({ key: `consistency/${pad(entry.index)}`, value: record });
      }
    };
    const resolveTarget = (id: string): string => {
      const seen = new Set<string>();
      while (attachments.has(id) && !seen.has(id)) {
        seen.add(id);
        id = attachments.get(id)!.target;
      }
      return id;
    };
    // A keyframe minted on a fragment before it was attached still carries the fragment's raw canvasId and raw x/y;
    // canonicalCanvas/canonicalPose translate that into the canvas and pose it is actually observed at today, so
    // revisit geometry and rival scoring compare like with like instead of raw-vs-canonical mismatches.
    const canonicalCanvas = (id: string): string => resolveTarget(id);
    const canonicalPose = (k: Point & { canvasId: string }): Point => {
      const shift = this.attachmentShift(attachments, k.canvasId);
      return { x: k.x + shift.x, y: k.y + shift.y };
    };
    const canonical = (id: string) => {
      const shift = this.attachmentShift(attachments, id);
      return { canvasId: resolveTarget(id), dx: shift.x, dy: shift.y };
    };
    const it = this.source.frames();
    let storageFailed = false;
    try {
      while (true) {
        await this.checkpoint();
        // Same decode-step/body split as scan(): a decoder failure here is never blamed on the solver, and a
        // solver/storage failure here is never blamed on the decoder.
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!solved) {
            throw error;
          }
          this.partial = true;
          await this.diagnostics.emit({
            code: 'DECODE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经求解的前 ${solved} 帧继续渲染。`,
            detail: { pass: 'solve', frames: solved },
          });
          break;
        }
        if (step.done) {
          endedNaturally = true;
          break;
        }
        const frame = step.value;
        try {
          const scan = await this.store.get<ScanRecord>(`scan/${pad(frame.index)}`);
          if (!scan) {
            missingScan = true;
            this.partial = true;
            await this.diagnostics.emit({
              code: 'MISSING_SCAN_RECORD',
              severity: 'error',
              frame: frame.index,
              message: `求解阶段缺少 scan/${pad(frame.index)}；已停止在已提交的求解前缀。`,
              action: '检查本地存储完整性；缺失的扫描记录不会被当作零位移。',
              detail: { pass: 'solve', frame: frame.index },
            });
            break;
          }
          if (scan.duplicate && previousPlan && states.every((s) => !s.blind)) {
            const plan: FramePlan = {
              index: frame.index,
              time: frame.time,
              duplicate: true,
              placements: previousPlan.placements.map((p) => ({ ...p, time: frame.time })),
            };
            pending.push({ key: `plan/${pad(frame.index)}`, value: plan });
            if (pending.length >= 24) await this.commitRows(pending);
            previousPlan = plan;
            for (const s of states) s.velocity = { x: 0, y: 0 };
            solved = frame.index + 1;
            await this.report(solved, frame.time, '完全相同的观察复用定位；保留源帧与时间记录。', solved / this.project.frames);
            if (this.stopRequested) {
              this.partial = true;
              this.stopped = true;
              this.stopRequested = false;
              break;
            }
            if (solved >= this.project.frames) break;
            continue;
          }
          const image = frame.image, g = scan.duplicate && previousGray ? previousGray : await this.gray(image);
          const storedFeatures = scan.duplicate ? undefined : await this.store.get<CompactFeatures>(`scan-features/${pad(frame.index)}`);
          const features = (storedFeatures && decodeFeatures(storedFeatures)) || (scan.duplicate ? previousFeaturesAll : undefined) ||
            extractFeatures(g);
          const native = grayscale(image.data, image.width, image.height);
          const placements: Placement[] = [];
          const consistencyLayers = new Map<string, ConsistencyLayer>();
          for (const state of states) {
            const r = state.region,
              code = state.code,
              roi = { x: r.rect.x / f, y: r.rect.y / f, width: r.rect.width / f, height: r.rect.height / f };
            const mask = (x: number, y: number) => atlas.contains(code, x, y);
            const ownFeatures = features.filter((p) => regionContains(r, p.x * f, p.y * f, image.width, image.height));
            const textured = ownFeatures.length >= 8;
            // A frame-global zoom gate fires for every pane at once, so one pane's pinch fragments every other pane too.
            // Measure this pane's own scale evidence against its own previous frame instead; fall back to the
            // frame-global diagnostic value only when there is too little of this pane's own history to judge from.
            const priorMatches = r.kind === 'moving' ? matchFeatures(state.previousFeatures || [], ownFeatures) : [];
            // detectScale() itself returns exactly 1 (indistinguishable from "no zoom") once it has fewer than
            // 8 unique matches to work with; gating on that same threshold here (not on the raw previous-frame
            // feature count, which says nothing about how many of THIS pair's matches were usable) is what
            // makes regionZoom's "undefined" branch — the frame-global fallback — reachable at all.
            const regionZoom = r.kind === 'moving' && priorMatches.filter((m) => m.unique).length >= 8
              ? detectScale(priorMatches)
              : undefined;
            const zoomChange = regionZoom !== undefined ? Math.abs(regionZoom - 1) > .04 : Math.abs(scan.field.zoom - 1) > .04;
            let confidence = r.unassigned ? .2 : 1,
              uncertain = !!r.unassigned,
              relocalized = false,
              skip = false,
              ambiguous = false,
              lost = false;
            let decision: Decision = 'tracked',
              delta: Point = { x: 0, y: 0 },
              viaAnchor: NativeRefinement | undefined,
              weakStep = false,
              stepError = Infinity;
            if (r.kind === 'moving' && !state.started) {
              // No canvas origin exists until a textured observation defines one; blank leading frames are counted, not placed.
              if (!textured) {
                decision = 'blind';
              } else {
                state.started = true;
                state.canvasId = '';
                await this.newCanvas(state, frame.time);
              }
            } else if (r.kind !== 'moving') {
              if (frame.index === 0) {
                await this.newCanvas(state, frame.time);
              }
            } else if (!textured) {
              decision = 'blind';
            } else if (state.blind || zoomChange || !previous || !previousGray) {
              decision = 'lost';
            } else {
              // 1. Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision.
              const matches = priorMatches, models = translationHypotheses(matches, 16).filter((m) => m.support >= 4);
              // Period-aliased hypotheses on repeated content audit equally well; the constant-velocity prior orders them before the
              // native decision so the true small step is never dropped in favour of a one-row-off alias with more (arbitrary) matches.
              const prior = (m: Point) => .02 * Math.hypot(m.x * f - state.velocity.x, m.y * f - state.velocity.y);
              const scored = models.map((m) => ({ m, audit: auditTranslation(previousGray!, g, m.x, m.y, roi, f > 1) }))
                .filter((v) =>
                  v.audit.overlap > .10 && Number.isFinite(v.audit.error) &&
                  ((v.audit.error < 14 && v.audit.mismatch < .2) ||
                    (v.audit.agreement >= .4 && v.audit.agreeing >= 3 && v.audit.agreeingError < 8))
                )
                .sort((a, b) =>
                  Math.min(a.audit.error, a.audit.agreeingError) + prior(a.m) - Math.min(b.audit.error, b.audit.agreeingError) - prior(b.m)
                );
              const refined = scored.slice(0, 6).map((v) => {
                const n = refineNative(previous!, image, { x: v.m.x * f, y: v.m.y * f }, r.rect, mask, radius);
                return { ...v, n, key: n.error + .02 * Math.hypot(n.x - state.velocity.x, n.y - state.velocity.y) };
              }).filter((v) => Number.isFinite(v.n.error)).sort((a, b) => a.key - b.key);
              const best = refined[0];
              if (best && best.n.error < 14) {
                decision = 'tracked';
                delta = { x: best.n.x, y: best.n.y };
                const rival = refined.find((v) =>
                  v !== best && Math.hypot(v.n.x - best.n.x, v.n.y - best.n.y) > 2 && v.n.error < best.n.error + 2
                );
                ambiguous = !!rival || (best.m.ambiguous && refined.length > 1);
                // A fast jump leaves a thin strip of shared content. Periodic layouts align just as well one period
                // away, so such a step is a best guess to be re-examined by revisit evidence, not a settled fact.
                weakStep = best.audit.overlap < .25;
                confidence = Math.max(.05, best.m.confidence) * Math.exp(-best.n.error / 20) * (ambiguous ? .6 : 1) * (weakStep ? .5 : 1);
                stepError = best.n.error;
                if (best.audit.agreement < .85 && best.audit.blocks >= 4) {
                  await this.diagnostics.emit({
                    code: 'PARTIAL_CONTENT_CHANGE',
                    severity: 'info',
                    time: frame.time,
                    frame: frame.index,
                    canvasId: state.canvasId,
                    message: `约 ${
                      Math.round((1 - best.audit.agreement) * 100)
                    }% 的纹理区块与整体位移不一致（动画、视频、懒加载或重排）；位移由一致区块决定，冲突区域在合成时单独处理。`,
                  });
                }
              } else {
                let difference = 0, samples = 0;
                for (let y = Math.ceil(roi.y); y < roi.y + roi.height; y += 7) {
                  for (let x = Math.ceil(roi.x); x < roi.x + roi.width; x += 7) {
                    if (!regionContains(r, x * f, y * f, image.width, image.height)) {
                      continue;
                    }
                    difference += Math.abs(previousGray!.data[y * g.width + x] - g.data[y * g.width + x]);
                    samples++;
                  }
                }
                decision = difference / Math.max(1, samples) > 5 ? 'lost' : 'static';
              }
            }
            // 2. Re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with overlap).
            if (decision === 'lost' && state.anchor && !zoomChange && r.kind === 'moving') {
              const matches = matchFeatures(state.anchor.features, ownFeatures),
                models = translationHypotheses(matches, 8).filter((m) => m.support >= 6);
              const options = models.slice(0, 4).map((m) => ({
                m,
                n: refinePatches(state.anchor!.patches, native, r.rect, { x: m.x * f, y: m.y * f }, radius),
              })).filter((v) => v.n.error < 12).sort((a, b) => a.n.error - b.n.error);
              const top = options[0];
              if (
                top && !options.some((v) => v !== top && Math.hypot(v.n.x - top.n.x, v.n.y - top.n.y) > 2 && v.n.error < top.n.error + 2)
              ) {
                decision = 'tracked';
                viaAnchor = top.n;
                ambiguous = top.m.ambiguous;
                confidence = Math.max(.05, top.m.confidence) * Math.exp(-top.n.error / 20) * (ambiguous ? .6 : 1);
              }
            }
            // 3. Apply the decision.
            if (r.kind === 'moving') {
              if (decision === 'tracked') {
                if (viaAnchor) {
                  state.pose = { x: state.anchor!.x + viaAnchor.x, y: state.anchor!.y + viaAnchor.y };
                  state.velocity = { x: 0, y: 0 };
                } else if (frame.index > 0 && previous) {
                  state.pose = { x: state.pose.x + delta.x, y: state.pose.y + delta.y };
                  state.velocity = delta;
                  // Drift control: re-measure the pose against the anchor keyframe's native patches whenever they are still in view.
                  if (state.anchor && scan.field.difference >= .12) {
                    const expected = { x: state.pose.x - state.anchor.x, y: state.pose.y - state.anchor.y };
                    const n = refinePatches(state.anchor.patches, native, r.rect, expected, radius);
                    if (n.error < 12 && n.runnerUp > n.error + 1.5) {
                      state.pose = { x: state.anchor.x + n.x, y: state.anchor.y + n.y };
                      confidence = Math.max(confidence, .96 * Math.exp(-n.error / 20));
                    }
                  }
                }
                uncertain = confidence < .60 || ambiguous || weakStep;
                if (weakStep) {
                  await this.diagnostics.emit({
                    code: 'THIN_OVERLAP_STEP',
                    severity: 'warning',
                    time: frame.time,
                    frame: frame.index,
                    canvasId: state.canvasId,
                    confidence,
                    message: '两帧之间移动很快，只剩很小的重叠可供对齐。位移取自这一小块证据；在周期性排版中，相邻周期同样能解释这些像素。',
                    action: '若之后的回访给出更强的证据，这段轨迹会被整体改正并记录。',
                  });
                }
                if (uncertain) {
                  await this.diagnostics.emit({
                    code: 'LOW_CONFIDENCE_PLACEMENT',
                    severity: 'warning',
                    time: frame.time,
                    frame: frame.index,
                    canvasId: state.canvasId,
                    confidence,
                    region: { x: state.pose.x + r.rect.x, y: state.pose.y + r.rect.y, width: r.rect.width, height: r.rect.height },
                    message: ambiguous
                      ? '重复纹理使多个位移都能解释像素；采用与运动连续性最一致的解，这是 best guess 而非唯一正确对齐。'
                      : '这一区域采用了低置信度的位置推断；相关像素会在质量遮罩中标记。',
                    action: '连续轨迹和已有锚点用于 best guess，不代表唯一正确对齐。',
                  });
                }
              } else if (decision === 'static') {
                state.velocity = { x: 0, y: 0 };
                confidence = .3;
                uncertain = true;
                await this.diagnostics.emit({
                  code: 'LOW_CONFIDENCE_PLACEMENT',
                  severity: 'warning',
                  time: frame.time,
                  frame: frame.index,
                  canvasId: state.canvasId,
                  confidence,
                  message: '两帧几乎相同但缺少可验证的特征对应；按暂停（零位移）处理，这是 best guess。',
                });
              } else if (decision === 'blind') {
                skip = true;
                confidence = 0;
                uncertain = true;
                state.velocity = { x: 0, y: 0 };
                await this.diagnostics.emit({
                  code: 'UNOBSERVABLE_FRAME',
                  severity: 'warning',
                  time: frame.time,
                  frame: frame.index,
                  canvasId: state.canvasId || undefined,
                  message:
                    '这一帧在该区域没有可辨认纹理：空白帧既可能是暂停，也可能是在空白区域移动，像素本身无法区分。它不会被画到任何位置。',
                  action: '若空白之后的内容无法与之前的观察重叠，将保留为独立片段，而不是猜测中间距离。',
                });
              } else {
                lost = true;
                const match = await index.find({
                  features: ownFeatures,
                  gray: g,
                  native,
                  layer: r.id,
                  frame: frame.index,
                  roi,
                  region: r.rect,
                  factor: f,
                  radius,
                  exclude: state.anchor?.id,
                  canonical,
                });
                if (match && !match.ambiguous && match.confidence > .6 && !zoomChange) {
                  state.canvasId = resolveTarget(match.keyframe.canvasId);
                  const shift = this.attachmentShift(attachments, match.keyframe.canvasId);
                  state.pose = { x: match.keyframe.x + match.offset.x + shift.x, y: match.keyframe.y + match.offset.y + shift.y };
                  state.lastNode = undefined;
                  state.anchor = match.keyframe;
                  state.velocity = { x: 0, y: 0 };
                  confidence = match.confidence;
                  relocalized = true;
                  await this.diagnostics.emit({
                    code: 'RELOCALIZED',
                    severity: 'info',
                    canvasId: state.canvasId,
                    time: frame.time,
                    frame: frame.index,
                    confidence,
                    detail: {
                      anchorFrame: match.keyframe.frame,
                      support: match.support,
                      unique: match.unique,
                      error: match.error,
                      offset: match.offset,
                    },
                    message: '通过历史视觉锚点重新定位到已观察画布，未把回访内容追加成长图。',
                  });
                } else {
                  // Name the cause: a magnification change is a different pixel grid, not a lost trajectory.
                  const scale = zoomChange
                    ? { scale: scan.field.zoom, error: 0 }
                    : previousGray && !state.blind
                    ? probeScale(previousGray, g, ownFeatures, roi)
                    : undefined;
                  state.fragment++;
                  state.pose = { x: 0, y: 0 };
                  state.lastNode = undefined;
                  state.anchor = undefined;
                  state.velocity = { x: 0, y: 0 };
                  await this.newCanvas(state, frame.time);
                  confidence = .20;
                  uncertain = true;
                  await this.diagnostics.emit({
                    code: scale ? 'SCALE_CHANGE_FRAGMENT' : 'UNPLACED_FRAGMENT',
                    severity: 'warning',
                    canvasId: state.canvasId,
                    time: frame.time,
                    frame: frame.index,
                    confidence,
                    detail: scale,
                    message: scale
                      ? `检测到约 ${scale.scale.toFixed(2)}× 的比例/布局变换，已按原像素保留独立片段；没有偷偷缩放混合。`
                      : '无法确认与原画布的相对位置，已保留独立可导出片段。两个片段之间可能重叠，也可能存在真实缺口。',
                    action: '跨片段关系尚未证实；后续回访若能可靠匹配，片段会被整体接回。重新录制时增加重叠，或用区域设置隔离变化组件。',
                  });
                }
              }
            }
            if (!Number.isFinite(state.pose.x) || !Number.isFinite(state.pose.y)) {
              await this.diagnostics.emit({
                code: 'NONFINITE_POSE',
                severity: 'error',
                time: frame.time,
                frame: frame.index,
                message: '定位计算产生无效数值。已隔离此观察，未将无效坐标写入画布。',
              });
              state.fragment++;
              state.pose = { x: 0, y: 0 };
              state.lastNode = undefined;
              state.anchor = undefined;
              confidence = 0;
              uncertain = true;
              await this.newCanvas(state, frame.time);
            }
            if (!skip) {
              const anchorDistance = state.anchor ? Math.hypot(state.pose.x - state.anchor.x, state.pose.y - state.anchor.y) : Infinity;
              const needsKey = !state.lastNode ||
                r.kind === 'moving' &&
                  (anchorDistance > Math.max(48, Math.min(r.rect.width, r.rect.height) * .30) ||
                    (frame.index - state.lastNode.frame > 90 && scan.field.difference > .2));
              if (needsKey) {
                const oldAnchor = state.anchor;
                let attachedFrom: string | undefined, attachMatch: Awaited<ReturnType<KeyframeIndex['find']>> | undefined;
                // Revisit search at every keyframe: same canvas → loop closure; another canvas → this fragment is tied back rigidly.
                const global = !lost && !skip && r.kind === 'moving' && frame.index > 3
                  ? await index.find({
                    features: ownFeatures,
                    gray: g,
                    native,
                    layer: r.id,
                    frame: frame.index,
                    roi,
                    region: r.rect,
                    factor: f,
                    radius,
                    exclude: oldAnchor?.id,
                    canonical,
                  })
                  : undefined;
                if (global && resolveTarget(global.keyframe.canvasId) !== state.canvasId && !global.ambiguous && global.confidence > .72) {
                  const target = resolveTarget(global.keyframe.canvasId),
                    shift = this.attachmentShift(attachments, global.keyframe.canvasId);
                  const targetPose = { x: global.keyframe.x + global.offset.x + shift.x, y: global.keyframe.y + global.offset.y + shift.y };
                  const attachment: Attachment = {
                    id: state.canvasId,
                    target,
                    dx: targetPose.x - state.pose.x,
                    dy: targetPose.y - state.pose.y,
                    frame: frame.index,
                    confidence: global.confidence,
                    node: global.keyframe.node,
                  };
                  attachments.set(state.canvasId, attachment);
                  await this.store.put(`attach/${state.canvasId}`, attachment);
                  const meta = await this.store.get<CanvasMeta>(`canvas/${state.canvasId}`);
                  if (meta) {
                    meta.attachedTo = target;
                    await this.store.put(`canvas/${state.canvasId}`, meta);
                  }
                  await this.diagnostics.emit({
                    code: 'FRAGMENT_ATTACHED',
                    severity: 'info',
                    canvasId: target,
                    time: frame.time,
                    frame: frame.index,
                    confidence: global.confidence,
                    detail: attachment,
                    message: '回访证据把一个独立片段整体接回了已有画布；片段内的相对轨迹保持不变。',
                  });
                  attachedFrom = state.canvasId;
                  attachMatch = global;
                  state.canvasId = target;
                  state.pose = targetPose;
                  state.lastNode = undefined;
                  state.velocity = { x: 0, y: 0 };
                }
                // Decide a thin-overlap correction before the node exists, so the odometry edge records the corrected
                // geometry and a weight that matches how little evidence the step actually had.
                let corrected: Point | undefined, odometryWeight = weakStep ? .05 : 1, correctedShift: Point | undefined;
                if (
                  global && !attachedFrom && resolveTarget(global.keyframe.canvasId) === state.canvasId && (weakStep || state.weak) &&
                  !global.ambiguous && global.confidence > .72 && global.error < 8
                ) {
                  // The keyframe used for this correction may itself sit on a fragment attached onto state.canvasId;
                  // its raw x/y must be translated into state.canvasId's coordinates before comparing to state.pose.
                  const kp = canonicalPose(global.keyframe), target = { x: kp.x + global.offset.x, y: kp.y + global.offset.y };
                  const discrepancy = Math.hypot(target.x - state.pose.x, target.y - state.pose.y);
                  if (discrepancy >= 16) {
                    corrected = target;
                    correctedShift = this.attachmentShift(attachments, global.keyframe.canvasId);
                    odometryWeight = .05;
                    await this.diagnostics.emit({
                      code: 'TRAJECTORY_CORRECTED',
                      severity: 'warning',
                      time: frame.time,
                      frame: frame.index,
                      canvasId: state.canvasId,
                      confidence: global.confidence,
                      detail: {
                        discrepancy,
                        from: { x: state.pose.x, y: state.pose.y },
                        to: target,
                        revisitError: global.error,
                        stepError,
                        weakStep,
                      },
                      message: `上一步只有很小的重叠，本帧与已观察内容的匹配相差 ${
                        discrepancy.toFixed(1)
                      }px 且证据更强；已按这一匹配改正当前位置。`,
                      action: '被改正的是本帧及之后的轨迹；此前写入的像素保持原样，可能与改正后的坐标存在接缝。',
                    });
                    state.pose = target;
                    state.weak = false;
                  }
                }
                const node = await graph.add(state.canvasId, frame.index, state.pose, state.lastNode, odometryWeight);
                if (corrected) {
                  await graph.connect(
                    global!.keyframe.node,
                    node.id,
                    global!.offset.x + correctedShift!.x,
                    global!.offset.y + correctedShift!.y,
                    6,
                    'loop',
                  );
                }
                if ((relocalized && oldAnchor) || attachedFrom) {
                  node.pinned = false;
                  await this.store.put(`node/${node.id}`, node);
                  const link = attachMatch ? attachMatch.keyframe : oldAnchor!;
                  // state.pose is already canonical (target-space); link.{x,y} is raw in link.canvasId's own space.
                  // Their difference IS the raw edge delta (it already carries the target's attachment shift plus
                  // the revisit offset) — do not subtract the shift a second time.
                  await graph.connect(link.node, node.id, state.pose.x - link.x, state.pose.y - link.y, 5, 'loop');
                } else if (global && canonicalCanvas(global.keyframe.canvasId) === state.canvasId) {
                  const linkShift = this.attachmentShift(attachments, global.keyframe.canvasId);
                  const discrepancy = Math.hypot(
                    global.keyframe.x + linkShift.x + global.offset.x - state.pose.x,
                    global.keyframe.y + linkShift.y + global.offset.y - state.pose.y,
                  );
                  if (!global.ambiguous && global.confidence > .72 && discrepancy < 16) {
                    await graph.connect(
                      global.keyframe.node,
                      node.id,
                      global.offset.x + linkShift.x,
                      global.offset.y + linkShift.y,
                      4,
                      'loop',
                    );
                    await this.diagnostics.emit({
                      code: 'LOOP_CLOSURE',
                      severity: 'info',
                      canvasId: state.canvasId,
                      time: frame.time,
                      frame: frame.index,
                      confidence: global.confidence,
                      message: '发现可靠的历史重访，已加入全局位置约束；最终合成使用校正后的轨迹。',
                    });
                  } else if (discrepancy >= 16) {
                    await this.diagnostics.emit({
                      code: 'INCONSISTENT_LOOP_REJECTED',
                      severity: 'warning',
                      time: frame.time,
                      frame: frame.index,
                      canvasId: state.canvasId,
                      message: `历史匹配与连续轨迹相差 ${discrepancy.toFixed(1)}px；证据冲突，未强加为回环。`,
                      confidence: global.confidence,
                    });
                  } else if (global.ambiguous) {
                    await this.diagnostics.emit({
                      code: 'AMBIGUOUS_LOOP',
                      severity: 'warning',
                      time: frame.time,
                      frame: frame.index,
                      canvasId: state.canvasId,
                      message: '历史检索有多个接近的合理位置；没有把不确定回环当作硬约束。',
                    });
                  }
                }
                state.lastNode = (await graph.get(node.id))!;
                const k: Keyframe = {
                  id: `${r.id}/${pad(frame.index)}`,
                  node: node.id,
                  canvasId: state.canvasId,
                  layer: r.id,
                  frame: frame.index,
                  features: ownFeatures,
                  gray: g,
                  x: state.pose.x,
                  y: state.pose.y,
                  scaleX: f,
                  scaleY: f,
                  patches: r.kind === 'moving'
                    ? extractPatches(native, r.rect, ownFeatures.map((p) => ({ x: p.x - roi.x, y: p.y - roi.y })), f)
                    : [],
                };
                state.anchor = k;
                if (r.kind === 'moving') {
                  await index.add(k);
                }
              }
            }
            // Displacement-spread consistency voting against the ring (see the block comment above `states`):
            // done with this frame's FINAL pose/canvasId for this region, after every branch above that could
            // still move it (attachment, thin-overlap correction, NONFINITE_POSE recovery).
            if (r.kind === 'moving' && !skip) {
              const box = consistencyBox.get(r.id)!, dmin = consistencyDmin.get(r.id)!;
              const layer: ConsistencyLayer = {
                canvasId: state.canvasId,
                pose: { x: state.pose.x, y: state.pose.y },
                score: new Int8Array(box.w * box.h),
                comparisons: new Uint8Array(box.w * box.h),
                pairs: 0,
                boxGray: computeBoxGray(r, box, g),
              };
              for (const partner of consistencyPartners(r.id, state.canvasId, state.pose, dmin)) {
                consistencyCompare(box, consistencyInterior.get(r.id)!, layer, partner.layer);
              }
              consistencyLayers.set(r.id, layer);
            }
            const occlusions = previous && r.kind === 'moving' && (decision === 'tracked' || decision === 'static')
              ? stickyOcclusions(
                previous,
                image,
                r,
                delta,
                previousPlan?.placements.find((p) => p.layer === r.id && p.canvasId === state.canvasId)?.occlusions,
              )
              : [];
            if (occlusions.length) {
              await this.diagnostics.emit({
                code: 'STICKY_OCCLUSION',
                severity: 'info',
                frame: frame.index,
                time: frame.time,
                canvasId: state.canvasId,
                region: occlusions[0],
                message: '顶端纹理支持屏幕固定而非页面位移；本次观察的固定遮挡不写入移动画布。原始参考界面保留在外框呈现中。',
              });
            }
            placements.push({
              layer: r.id,
              canvasId: state.canvasId,
              node: state.lastNode?.id || '',
              x: state.pose.x,
              y: state.pose.y,
              confidence,
              uncertain,
              time: frame.time,
              ...(skip ? { skip: true } : {}),
              ...(occlusions.length ? { occlusions } : {}),
            });
            if (r.kind === 'moving') {
              state.blind = !textured;
              state.weak = decision === 'tracked' ? weakStep : false;
            }
            state.previousFeatures = ownFeatures;
          }
          // This frame joins the ring (unless it had no moving-region evidence at all) only after every state's
          // voting comparisons above have already used it as a "current" frame against older partners; eviction
          // below then finalises whichever frame the new one's bytes just pushed out, oldest first.
          if (consistencyLayers.size) {
            let bytes = 0;
            for (const layer of consistencyLayers.values()) {
              bytes += layer.boxGray.byteLength + layer.score.byteLength + layer.comparisons.byteLength;
            }
            consistencyRing.push({ index: frame.index, bytes, layers: consistencyLayers });
            consistencyRingBytes += bytes;
            while (consistencyRingBytes > CONSISTENCY_RING_BYTES && consistencyRing.length > 1) {
              const evicted = consistencyRing.shift()!;
              consistencyRingBytes -= evicted.bytes;
              consistencyFinalize(evicted);
            }
            if (pendingConsistency.length >= 24) {
              await this.commitRows(pendingConsistency);
            }
          }
          previousPlan = { index: frame.index, time: frame.time, placements, duplicate: scan.duplicate };
          pending.push({ key: `plan/${pad(frame.index)}`, value: previousPlan });
          previousFeaturesAll = features;
          if (pending.length >= 24) {
            await this.commitRows(pending);
          }
          previous = image;
          previousGray = g;
          solved = frame.index + 1;
          await this.report(solved, frame.time, '原像素精修、历史重定位与二维回环约束。', solved / this.project.frames);
          if (this.stopRequested) {
            this.partial = true;
            this.stopped = true;
            this.stopRequested = false;
            break;
          }
          if (solved >= this.project.frames) {
            break;
          }
        } catch (error) {
          if (!solved) {
            throw error;
          }
          this.partial = true;
          if (error instanceof StorageError) {
            storageFailed = true;
            try {
              await this.diagnostics.emit({
                code: 'PERSISTENCE_PREFIX_ONLY',
                severity: 'error',
                message: String(error),
                action: `仅对已经求解的前 ${solved} 帧继续渲染；存储写入已停止。`,
                detail: { pass: 'solve', frames: solved },
              });
            } catch { /* the journal write itself failed too; the run is already marked partial. */ }
            break;
          }
          await this.diagnostics.emit({
            code: 'ANALYSIS_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经求解的前 ${solved} 帧继续渲染。`,
            detail: { pass: 'solve', frames: solved },
          });
          break;
        }
      }
    } finally {
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
    }
    if (pending.length && !storageFailed) {
      try {
        await this.commitRows(pending);
      } catch (error) {
        storageFailed = true;
        this.partial = true;
        try {
          await this.diagnostics.emit({
            code: 'PERSISTENCE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经求解的前 ${solved} 帧继续渲染；存储写入已停止。`,
            detail: { pass: 'solve', frames: solved },
          });
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if (endedNaturally || missingScan) {
      await this.passMismatch('solve', this.project.frames, solved);
    }
    // Every frame still resident in the ring when solve() ends (the tail of the run never got displaced by a
    // later frame's bytes) is finalised here exactly as an evicted one would have been.
    if (!storageFailed) {
      for (const entry of consistencyRing.splice(0)) {
        consistencyFinalize(entry);
      }
      if (pendingConsistency.length) {
        try {
          await this.commitRows(pendingConsistency);
        } catch (error) {
          storageFailed = true;
          this.partial = true;
          try {
            await this.diagnostics.emit({
              code: 'PERSISTENCE_PREFIX_ONLY',
              severity: 'error',
              message: String(error),
              action: `仅对已经求解的前 ${solved} 帧继续渲染；存储写入已停止。`,
              detail: { pass: 'solve', frames: solved },
            });
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        }
      }
    }
    this.processed = solved;
    this.events.progress({ phase: 'optimizing', fraction: 0, frames: solved, time: 0, message: '优化磁盘中的位置图，校正回环漂移。' });
    // pose-graph.ts only persists relaxed positions once optimize() finishes its loop; a stop mid-relaxation
    // unwinds via StopRequested before that, so the unrelaxed (but already-persisted, pre-optimize) node
    // positions are what render() sees — geometrically consistent, just without this pass's loop-closure fix-up.
    let result: { residual: number; iterations: number };
    try {
      result = await graph.optimize(async () => {
        await this.checkpoint();
        if (this.stopRequested) throw new StopRequested();
      });
    } catch (error) {
      if (!(error instanceof StopRequested)) {
        throw error;
      }
      this.partial = true;
      this.stopped = true;
      this.stopRequested = false;
      result = { residual: 0, iterations: 0 };
    }
    if (result.residual > 1) {
      await this.diagnostics.emit({
        code: 'GRAPH_RESIDUAL',
        severity: 'warning',
        message: `位置图最大残差仍有 ${result.residual.toFixed(2)} 原像素；相关接缝可能存在几何不一致。`,
        detail: result,
        action: '检查回环附近的文字与重复纹理。该残差没有被隐藏。',
      });
    }
    await this.store.put('graph-summary', { loops: graph.loops, ...result });
    // scan-features/keyframe/word are scratch this pass alone consumed (relocalization postings and per-frame
    // features); render() never reads them, so they are deleted here rather than carried to export or reopen.
    await deletePrefix(this.store, 'scan-features/');
    await deletePrefix(this.store, 'keyframe/');
    await deletePrefix(this.store, 'word/');
    await this.diagnostics.flush();
    await this.persist();
  }
  /** Total rigid shift from a canvas through its attachment chain to the canvas it finally resolves to. */
  private attachmentShift(attachments: Map<string, Attachment>, id: string): Point {
    const shift = { x: 0, y: 0 }, seen = new Set<string>();
    while (attachments.has(id) && !seen.has(id)) {
      seen.add(id);
      const a = attachments.get(id)!;
      shift.x += a.dx;
      shift.y += a.dy;
      id = a.target;
    }
    return shift;
  }
  /** Render-time variant of attachmentShift: a fragment's dx/dy was measured once, against the target keyframe node it
   * matched at attach time. If that node has since moved under graph optimization (its own canvas absorbed a later
   * loop closure), the frozen dx/dy alone would leave the attached fragment's pixels behind. Add how much that anchor
   * node has moved (as of the attach frame) on top of the fixed offset; this does not double count against the A2
   * odometry/loop edge, which only governs the chain of nodes minted after the attachment. */
  private async attachedRenderShift(attachments: Map<string, Attachment>, graph: PoseGraph, id: string): Promise<Point> {
    const shift = { x: 0, y: 0 }, seen = new Set<string>();
    while (attachments.has(id) && !seen.has(id)) {
      seen.add(id);
      const a = attachments.get(id)!;
      const c = await graph.correction(a.node, a.frame);
      shift.x += a.dx + c.x;
      shift.y += a.dy + c.y;
      id = a.target;
    }
    return shift;
  }
  private consistencyAnalysisCoordinates(width: number, height: number): { x: Int32Array; y: Int32Array } {
    if (
      this.consistencyAnalysisWidth !== width || this.consistencyAnalysisHeight !== height ||
      this.consistencyAnalysisFactor !== this.factor
    ) {
      const x = new Int32Array(width), y = new Int32Array(height), f = this.factor;
      for (let i = 0; i < width; i++) x[i] = Math.floor(i / f);
      for (let i = 0; i < height; i++) y[i] = Math.floor(i / f);
      this.consistencyAnalysisX = x;
      this.consistencyAnalysisY = y;
      this.consistencyAnalysisWidth = width;
      this.consistencyAnalysisHeight = height;
      this.consistencyAnalysisFactor = f;
    }
    return { x: this.consistencyAnalysisX, y: this.consistencyAnalysisY };
  }
  /** World-consistency mask for one moving-region placement (docs/ARCHITECTURE.md §七): per screen pixel inside
   *  `region.rect`, decides whether the content this observation shows there can be trusted as page content at
   *  the world position it is about to be written to (screen pixel + this frame's resolved `pose`). Two kinds of
   *  evidence exist, and they are NOT symmetric in strength:
   *
   *  - solve()'s displacement-spread voting (`voting`, upsampled from analysis resolution — see ConsistencyVote
   *    and the block comment above `states` in solve()) is a MULTI-frame verdict over partners displaced far
   *    enough that a screen-fixed overlay cannot occupy the same world position in both. It says WHICH frame is
   *    wrong, and gets the last word wherever it reached a verdict at all.
   *  - the ±1-frame native check is a PAIRWISE DISAGREEMENT signal. When this frame and its neighbour show
   *    different content at the same world position, one of the two is wrong — the comparison itself cannot say
   *    which. Treating both as wrong is what used to condemn a run's genuinely-clean last frame because its only
   *    neighbour happened to be under a floating button, and with it the chance to heal that neighbour's
   *    provisional pixel (docs/ARCHITECTURE.md §七, world pixel (314, 3198) on `phone`). So a disagreement now
   *    only condemns this frame when the evidence is symmetric: every available neighbour disagrees, or the one
   *    that does carries its own positive voting verdict at that world position and is therefore trustworthy.
   *
   *  Truth table for one pixel, first matching row wins (`own verdict` is THIS frame's voting verdict at this
   *  world position; a neighbour's verdict is that NEIGHBOUR's, read at its own screen position in the same box):
   *
   *    own verdict  | comparable ±1 neighbours                                    | result
   *    -------------|------------------------------------------------------------|--------------
   *    inconsistent | not consulted                                               | inconsistent
   *    anything else| 0 (no prev/next, other canvas, or outside the atlas mask)    | consistent
   *                 | 1, it agrees                                                | consistent
   *                 | 1, it disagrees, voting found THAT neighbour inconsistent    | consistent
   *                 | 1, it disagrees, voting has no such verdict for it           | inconsistent
   *                 | 2, both agree                                               | consistent
   *                 | 2, either disagrees (excused or not)                        | inconsistent
   *
   *  Two things that look arbitrary in that table are not, and both were measured. The excuse is limited to the
   *  LONE-neighbour row because with two comparable neighbours the evidence is already two-sided: an overlay
   *  taller than one frame's scroll routinely covers a world position in frames t and t−1 while t+1 is clean, and
   *  the plain any-disagreement reading is what catches it — extending the excuse to two neighbours was measured
   *  taking `chrome-everything` from 4.2k unhealed overlay pixels to 27k. And a POSITIVE voting verdict never
   *  overrules a ±1 disagreement on its own: `consistencyCompare` agrees when the MINIMUM difference over a
   *  ±`consistencyRadius` window is within tolerance, which is the right bias for flagging but makes "agrees"
   *  weak evidence on textured content, where a window that size nearly always holds something close enough.
   *  Trusting it flipped overlay pixels to "consistent" wholesale (provisionalPixels collapsed to 0 on
   *  `chrome-everything`, recoverable rose to 27k). It is trusted only for the narrow question the lone-neighbour
   *  row asks, where the alternative is no evidence at all.
   *
   *  The "0 comparable" row is the long-standing consistent-by-default rule and must stay: content glimpsed in
   *  only one frame still has to be painted (the 'glimpse' scenario) — no evidence is not evidence of a fault.
   *  A neighbour comparison counts only when that neighbour's own placement for this layer resolved to the same
   *  `canvasId` and the corresponding neighbour screen position lies inside both the frame and this region's
   *  atlas membership; agreement is exact RGB equality, else mean |ΔRGB| ≤ `this.noise` — the decode noise the
   *  SOURCE declares (`MediaInfo.noise`), not a constant. A lossless source is therefore compared exactly, which
   *  is what lets a white floating-button glyph over a near-white page (mean |ΔRGB| 6 — under the 10 levels a
   *  decoded recording needs) be seen at all; a real recording keeps exactly the headroom it always had. Returned array is image-sized
   *  (one byte per native pixel, indexed like RegionAtlas.labels); pixels outside the region are left at the
   *  default 1 and are never read by the compositor (it already gates on region membership before consulting
   *  this mask). */
  private consistencyMask(
    image: RGBA,
    atlas: RegionAtlas,
    region: Region,
    code: number,
    pose: Point,
    canvasId: string,
    prev?: { image: RGBA; x: number; y: number; canvasId: string; occlusions?: Rect[]; voting?: ConsistencyVote },
    next?: { image: RGBA; x: number; y: number; canvasId: string; occlusions?: Rect[]; voting?: ConsistencyVote },
    voting?: ConsistencyVote,
  ): Uint8Array {
    const W = image.width,
      H = image.height,
      out = new Uint8Array(W * H).fill(1),
      currentRaster = resolveRasterPose(pose.x, pose.y);
    const labels = atlas.labels, imageData = image.data;
    const rx0 = Math.max(0, Math.floor(region.rect.x)), ry0 = Math.max(0, Math.floor(region.rect.y));
    const rx1 = Math.min(W, Math.ceil(region.rect.x + region.rect.width)), ry1 = Math.min(H, Math.ceil(region.rect.y + region.rect.height));
    const coordinates = this.consistencyAnalysisCoordinates(W, H), analysisX = coordinates.x, analysisY = coordinates.y;
    // −1 inconsistent, +1 confidently consistent, 0 no verdict. The box is the region's own, identical for
    // every frame of the run, so a neighbour's verdict is read at the NEIGHBOUR's screen position in the very
    // same box — which is the same world position, by construction of the lookup below.
    const verdict = (v: ConsistencyVote | undefined, x: number, y: number): number => {
      if (!v) {
        return 0;
      }
      const lx = analysisX[x] - v.x0, ly = analysisY[y] - v.y0;
      if (lx < 0 || ly < 0 || lx >= v.w || ly >= v.h) {
        return 0;
      }
      const i = ly * v.w + lx, bit = 1 << (i & 7);
      return v.bits[i >> 3] & bit ? -1 : v.clean[i >> 3] & bit ? 1 : 0;
    };
    const neighbours: {
      data: Uint8ClampedArray;
      rasterX: number;
      rasterY: number;
      occlusions?: Rect[];
      voting?: ConsistencyVote;
    }[] = [];
    for (const neighbour of [prev, next]) {
      if (neighbour && neighbour.canvasId === canvasId) {
        const raster = resolveRasterPose(neighbour.x, neighbour.y);
        neighbours.push({
          data: neighbour.image.data,
          rasterX: raster.rasterX,
          rasterY: raster.rasterY,
          occlusions: neighbour.occlusions,
          voting: neighbour.voting,
        });
      }
    }
    const currentRasterX = currentRaster.rasterX, currentRasterY = currentRaster.rasterY;
    for (let sy = ry0; sy < ry1; sy++) {
      let src = sy * W + rx0;
      for (let sx = rx0; sx < rx1; sx++) {
        if (labels[src] !== code) {
          src++;
          continue;
        }
        const k = src * 4;
        if (verdict(voting, sx, sy) < 0) {
          out[src] = 0;
          src++;
          continue;
        }
        let checked = 0, condemned = 0, excused = 0;
        const r = imageData[k], g = imageData[k + 1], b = imageData[k + 2];
        for (let n = 0; n < neighbours.length; n++) {
          const neighbour = neighbours[n];
          // The compositor rasterizes each placement before writing it. Match that exact integer pose here;
          // rounding the combined difference would disagree around opposing fractional corrections.
          const ix = sx + currentRasterX - neighbour.rasterX, iy = sy + currentRasterY - neighbour.rasterY;
          if (ix < 0 || iy < 0 || ix >= W || iy >= H || labels[iy * W + ix] !== code) {
            continue;
          }
          const occlusions = neighbour.occlusions;
          if (occlusions) {
            let occluded = false;
            for (let i = 0; i < occlusions.length; i++) {
              const occlusion = occlusions[i];
              if (ix >= occlusion.x && iy >= occlusion.y && ix < occlusion.x + occlusion.width && iy < occlusion.y + occlusion.height) {
                occluded = true;
                break;
              }
            }
            if (occluded) continue;
          }
          checked++;
          const j = (iy * W + ix) * 4, neighbourData = neighbour.data;
          if (
            r === neighbourData[j] && g === neighbourData[j + 1] && b === neighbourData[j + 2]
          ) continue;
          const diff = (Math.abs(r - neighbourData[j]) + Math.abs(g - neighbourData[j + 1]) + Math.abs(b - neighbourData[j + 2])) / 3;
          if (diff <= this.noise) {
            continue;
          }
          if (verdict(neighbour.voting, ix, iy) < 0) {
            excused++;
          } else {
            condemned++;
            break;
          }
        }
        if (condemned || excused && checked >= 2) {
          out[src] = 0;
        }
        src++;
      }
    }
    return out;
  }
  private async render(): Promise<void> {
    this.phase = 'rendering';
    this.project.status = 'rendering';
    await this.persist();
    const graph = new PoseGraph(this.store),
      compositor = new Compositor(
        this.store,
        this.tiles,
        this.project.settings.temporalPolicy,
        (d) => this.diagnostics.emit(d),
        this.atlas!,
      );
    const regionMap = new Map(this.regions.map((r) => [r.id, r])), attachments = new Map<string, Attachment>();
    for await (const { value } of iterate<Attachment>(this.store, 'attach/')) {
      attachments.set(value.id, value);
    }
    const fixedPixels = new Map<string, Uint32Array>(), previousPlacements = new Map<string, Placement>();
    const fixedBytes = this.regions.filter((r) => r.kind === 'fixed').reduce(
      (n, r) => n + Math.ceil(r.rect.width) * Math.ceil(r.rect.height) * 4,
      0,
    );
    // Render buffers one extra decoded native RGBA frame (the one-frame lookahead consistencyMask() compares
    // against, see docs/ARCHITECTURE.md §七), so the working-memory reservation grows by one more native frame.
    this.tiles.configureBudget(
      this.project.settings.memoryMB,
      this.source.info.width * this.source.info.height * 5 + fixedBytes + 8 * 1024 * 1024 +
        this.source.info.width * this.source.info.height * 4,
    );
    // Resolves a raw (odometry-space) Placement into its final render-time pose and canvas: pose-graph
    // correction, attachment-shift, and the attachment chain walk. Shared by the current frame's own placements
    // and by the one-frame-lookahead neighbour placements consistencyMask() compares against — both need
    // exactly the resolution render() already does today, just at a different frame index.
    const resolvePlacement = async (raw: Placement, frameIndex: number): Promise<{ x: number; y: number; canvasId: string }> => {
      const correction = await graph.correction(raw.node, frameIndex),
        shift = await this.attachedRenderShift(attachments, graph, raw.canvasId);
      let canvasId = raw.canvasId;
      const seen = new Set<string>();
      while (attachments.has(canvasId) && !seen.has(canvasId)) {
        seen.add(canvasId);
        canvasId = attachments.get(canvasId)!.target;
      }
      // Keep the optimized pose in the graph/render ledger. Compositor and consistencyMask() each resolve
      // this same floating-point pose independently, matching the raster coordinates without discarding subpixel
      // diagnostics or making a rounded placement part of the render-time state.
      return { x: raw.x + correction.x + shift.x, y: raw.y + correction.y + shift.y, canvasId };
    };
    // Rolling window over solve()'s per-frame voting verdicts. Each rendered frame needs its own record plus
    // its two ±1 neighbours', and consecutive frames overlap by two, so a four-slot window turns three reads
    // per frame into one. A missing record (the common case for a frame no region had anything to say about)
    // is cached as `undefined` just like a present one, so it is not re-read either.
    const votingWindow: { index: number; record: ConsistencyRecord | undefined }[] = [];
    const votingFor = async (index: number): Promise<ConsistencyRecord | undefined> => {
      const hit = votingWindow.find((e) => e.index === index);
      if (hit) {
        return hit.record;
      }
      const record = index < 0 ? undefined : await this.store.get<ConsistencyRecord>(`consistency/${pad(index)}`);
      votingWindow.push({ index, record });
      if (votingWindow.length > 4) {
        votingWindow.shift();
      }
      return record;
    };
    // CanvasMeta held in RAM for the whole pass instead of `store.put` once per placement per frame: dirtyMetas
    // tracks which ones changed since the last flush, which happens alongside the existing ~1.2s tile flush (and
    // in the finally below), not on every placement. Progress events still carry the live (in-memory) meta, so a
    // caller polling mid-run never sees more than that same ~1.2s of lag.
    const metas = new Map<string, CanvasMeta>(), dirtyMetas = new Set<string>();
    const getMeta = async (canvasId: string): Promise<CanvasMeta | undefined> => {
      let meta = metas.get(canvasId);
      if (meta) return meta;
      meta = await this.store.get<CanvasMeta>(`canvas/${canvasId}`);
      if (meta) metas.set(canvasId, meta);
      return meta;
    };
    const flushMetas = async (): Promise<void> => {
      if (!dirtyMetas.size) return;
      const ids = [...dirtyMetas];
      await this.storagePutMany(ids.map((id) => ({ key: `canvas/${id}`, value: metas.get(id) })));
      for (const id of ids) dirtyMetas.delete(id);
    };
    // Per-frame observation ledger rows, batched like the scan/plan rows instead of one transaction each.
    const pendingObservations: { key: string; value: unknown }[] = [];
    let lastFlush = performance.now();
    const it = this.source.frames();
    let storageFailed = false;
    let endedNaturally = false;
    let missingPlan: number | undefined;
    // `stop` is set by processFrame() once a stop request was honoured or the solved prefix has been fully
    // rendered, so the outer loop below can break WITHOUT decoding one further (wasted) lookahead frame first.
    let stop = false;
    // One-frame lookahead: `pending` is the most recently decoded frame not yet composited, held back so
    // consistencyMask() can compare its content against BOTH the frame before it (`pendingPrev`, already
    // decoded) and the frame after it (decoded one step ahead of compositing — see the loop below). The last
    // buffered frame is flushed with no successor once decoding ends (see memory-stats.json for the extra
    // native RGBA frame this holds).
    let pending: FrameImage | undefined, pendingPrev: RGBA | undefined;
    const processFrame = async (frame: FrameImage, prevImage: RGBA | undefined, nextImage: RGBA | undefined): Promise<void> => {
      try {
        const plan = await this.store.get<FramePlan>(`plan/${pad(frame.index)}`);
        if (!plan) {
          this.partial = true;
          missingPlan = frame.index;
          await this.diagnostics.emit({
            code: 'MISSING_PLAN',
            severity: 'error',
            frame: frame.index,
            message: `渲染阶段缺少 plan/${pad(frame.index)}；已停止在已提交的渲染前缀。`,
            action: '检查本地存储完整性；缺失的求解计划不会被静默当作空观察。',
            detail: { pass: 'render', frame: frame.index },
          });
          stop = true;
          return;
        }
        const image = frame.image;
        const prevPlan = prevImage ? await this.store.get<FramePlan>(`plan/${pad(frame.index - 1)}`) : undefined;
        const nextPlan = nextImage ? await this.store.get<FramePlan>(`plan/${pad(frame.index + 1)}`) : undefined;
        // solve()'s displacement-spread voting verdicts for this frame AND for the two frames the ±1-frame
        // check compares it against: consistencyMask() asks a disagreeing neighbour whether voting found IT
        // clean at that world position before letting it condemn this frame (see its truth table). Reads go
        // through votingFor, which keeps the last few frames' records so the three lookups per frame cost one
        // store read per frame, not three.
        const votingRecord = await votingFor(frame.index),
          prevVoting = prevImage ? await votingFor(frame.index - 1) : undefined,
          nextVoting = nextImage ? await votingFor(frame.index + 1) : undefined;
        let latest: CanvasMeta | undefined;
        const decisions = [];
        for (const placement of plan.placements) {
          if (placement.skip) {
            decisions.push({
              canvasId: placement.canvasId,
              placement,
              addedPixels: 0,
              conflictPixels: 0,
              uncertainPixels: 0,
              skipped: true,
            });
            continue;
          }
          const resolved = await resolvePlacement(placement, frame.index);
          const p = { ...placement, ...resolved };
          const meta = await getMeta(p.canvasId);
          if (!meta) {
            throw new Error('Canvas metadata is missing.');
          }
          const region = regionMap.get(p.layer)!;
          const last = previousPlacements.get(p.layer);
          let unchanged = !!plan.duplicate && !!last && last.canvasId === p.canvasId && last.x === p.x && last.y === p.y;
          if (region.kind === 'fixed' && !unchanged) {
            const rect = region.rect, rw = Math.ceil(rect.width), rh = Math.ceil(rect.height), code = this.atlas!.code(region);
            const old = fixedPixels.get(region.id), saved = old || new Uint32Array(rw * rh);
            const src = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
            unchanged = !!old;
            for (let y = 0; y < rh; y++) {
              for (let x = 0; x < rw; x++) {
                const nx = Math.floor(rect.x) + x, ny = Math.floor(rect.y) + y;
                if (!this.atlas!.contains(code, nx, ny)) continue;
                const i = ny * image.width + nx, j = y * rw + x;
                if (saved[j] !== src[i]) {
                  saved[j] = src[i];
                  unchanged = false;
                }
              }
            }
            fixedPixels.set(region.id, saved);
          }
          previousPlacements.set(p.layer, p);
          if (unchanged) {
            this.skippedPaints++;
            meta.lastTime = p.time;
            dirtyMetas.add(p.canvasId);
            latest = region.kind === 'moving' ? meta : latest;
            decisions.push({
              canvasId: p.canvasId,
              placement: p,
              addedPixels: 0,
              conflictPixels: 0,
              uncertainPixels: 0,
              reusedExactObservation: true,
            });
            continue;
          }
          // World-consistency mask (docs/ARCHITECTURE.md §七), fixed regions and duplicate-shortcut placements
          // excepted (see consistencyMask's doc comment): a screen-fixed overlay occupies a different world
          // position every frame, so it never agrees with a neighbour sampled at the SAME world position and
          // ends up provisional instead of burned permanently into the canvas.
          let consistent: Uint8Array | undefined;
          if (region.kind === 'moving') {
            const code = this.atlas!.code(region);
            const prevRaw = prevImage ? prevPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
            const nextRaw = nextImage ? nextPlan?.placements.find((pl) => pl.layer === p.layer && !pl.skip) : undefined;
            const prevResolved = prevRaw ? await resolvePlacement(prevRaw, frame.index - 1) : undefined;
            const nextResolved = nextRaw ? await resolvePlacement(nextRaw, frame.index + 1) : undefined;
            consistent = this.consistencyMask(
              image,
              this.atlas!,
              region,
              code,
              p,
              p.canvasId,
              prevResolved
                ? { image: prevImage!, ...prevResolved, occlusions: prevRaw?.occlusions, voting: prevVoting?.[region.id] }
                : undefined,
              nextResolved
                ? { image: nextImage!, ...nextResolved, occlusions: nextRaw?.occlusions, voting: nextVoting?.[region.id] }
                : undefined,
              votingRecord?.[region.id],
            );
          }
          const stats = await compositor.add(image, region, p, frame.index, meta, consistent);
          this.project.tiles += stats.tiles;
          this.project.observedPixels += stats.added;
          dirtyMetas.add(p.canvasId);
          latest = region.kind === 'moving' ? meta : latest;
          decisions.push({
            canvasId: p.canvasId,
            placement: p,
            addedPixels: stats.added,
            conflictPixels: stats.conflicts,
            uncertainPixels: stats.uncertain,
          });
        }
        // Every decoded observation has a durable placement and a pixel contribution ledger.
        pendingObservations.push({ key: `observation/${pad(frame.index)}`, value: { frame: frame.index, time: frame.time, decisions } });
        if (pendingObservations.length >= 32) {
          await this.commitRows(pendingObservations);
        }
        this.project.renderedFrames = frame.index + 1;
        if (performance.now() - lastFlush >= 1200) {
          lastFlush = performance.now();
          await this.tiles.flush();
          await this.diagnostics.flush();
          await flushMetas();
          if (pendingObservations.length) {
            await this.commitRows(pendingObservations);
          }
        }
        await this.report(
          frame.index + 1,
          frame.time,
          '按观察证据合成原尺寸瓦片；缺口保持透明。',
          (frame.index + 1) / Math.max(1, this.processed),
          latest,
        );
        if (this.stopRequested) {
          this.partial = true;
          this.stopped = true;
          this.stopRequested = false;
          stop = true;
          return;
        }
        if (frame.index + 1 >= this.processed) {
          stop = true;
        }
      } catch (error) {
        if (!this.project.renderedFrames) {
          throw error;
        }
        this.partial = true;
        if (error instanceof StorageError) {
          storageFailed = true;
          try {
            await this.diagnostics.emit({
              code: 'PERSISTENCE_PREFIX_ONLY',
              severity: 'error',
              message: String(error),
              action: `仅对已经渲染的前 ${this.project.renderedFrames} 帧保留结果；存储写入已停止。`,
              detail: { pass: 'render', frames: this.project.renderedFrames },
            });
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
          stop = true;
          return;
        }
        await this.diagnostics.emit({
          code: 'ANALYSIS_PREFIX_ONLY',
          severity: 'error',
          message: String(error),
          action: `仅对已经渲染的前 ${this.project.renderedFrames} 帧保留结果。`,
          detail: { pass: 'render', frames: this.project.renderedFrames },
        });
        stop = true;
      }
    };
    try {
      while (true) {
        await this.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          // Decode failed while looking one frame ahead (or on the very first frame). Composite whatever is
          // already buffered as the final frame (no successor) BEFORE reporting/breaking, so a lookahead-only
          // decode failure never drops an already-decoded, not-yet-composited frame.
          if (pending) {
            await processFrame(pending, pendingPrev, undefined);
          }
          pending = undefined;
          if (!this.project.renderedFrames) {
            throw error;
          }
          this.partial = true;
          await this.diagnostics.emit({
            code: 'DECODE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经渲染的前 ${this.project.renderedFrames} 帧保留结果。`,
            detail: { pass: 'render', frames: this.project.renderedFrames },
          });
          break;
        }
        if (step.done) {
          endedNaturally = true;
          if (pending) {
            await processFrame(pending, pendingPrev, undefined);
          }
          pending = undefined;
          break;
        }
        const frame = step.value;
        if (pending) {
          await processFrame(pending, pendingPrev, frame.image);
          pendingPrev = pending.image;
        }
        pending = frame;
        if (stop) {
          pending = undefined;
          break;
        }
      }
    } finally {
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
      // Best-effort: committed tiles and in-memory metas should not be stranded even when the loop exited through
      // a storage failure; a repeat failure here is swallowed rather than masking the original error.
      try {
        if (pendingObservations.length && !storageFailed) await this.commitRows(pendingObservations);
      } catch (error) {
        storageFailed = true;
        this.partial = true;
        try {
          await this.diagnostics.emit({
            code: 'PERSISTENCE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经渲染的前 ${this.project.renderedFrames} 帧保留结果；存储写入已停止。`,
            detail: { pass: 'render', frames: this.project.renderedFrames },
          });
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
      try {
        if (!storageFailed) await flushMetas();
      } catch (error) {
        storageFailed = true;
        this.partial = true;
        try {
          await this.diagnostics.emit({
            code: 'PERSISTENCE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经渲染的前 ${this.project.renderedFrames} 帧保留结果；存储写入已停止。`,
            detail: { pass: 'render', frames: this.project.renderedFrames },
          });
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if ((endedNaturally || missingPlan !== undefined) && this.project.renderedFrames !== this.processed) {
      await this.passMismatch('render', this.processed, this.project.renderedFrames);
    }
    await this.tiles.flush();
    await this.diagnostics.flush();
    await this.store.put('memory-stats', {
      peakResidentTiles: this.tiles.peakResidentTiles,
      tileCacheLimit: this.tiles.maxTiles,
      budgetMB: this.project.settings.memoryMB,
      note:
        'Codec/browser/GPU allocations are additional, not a hard process-RSS bound. The render pass also holds one extra decoded native RGBA frame: a one-frame lookahead the world-consistency mask compares against (docs/ARCHITECTURE.md §七).',
    });
    await this.persist();
  }
}
