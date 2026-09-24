// Shell around the scan pass: decode-loop orchestration (storage, diagnostics, progress, batching, failure
// classification) plus algorithm-awaiting-port motion evidence extraction (estimateMotion/LayerLearner, still
// TypeScript today). The decode-loop skeleton mirrors solve()'s and render()'s — see frame-loop-shaped comments
// throughout — but each pass keeps its own loop: the three differ enough in their failure wording and, for
// render(), its one-frame lookahead, that a shared skeleton would obscure the ordering each one guarantees. prefixOnly()
// (context.ts) already factors out the one piece that WAS identical across all three — the PREFIX_ONLY
// diagnostic shape — so there is no further sharing left to do here.
import type { Feature, Gray, MotionField, RGBA, ScanRecord } from '../types.ts';
import { informativeField, LayerLearner, RegionAtlas } from '../core/layers.ts';
import { estimateMotion } from '../core/motion.ts';
import { extractFeatures } from '../core/features.ts';
import { core, coreBuild, type FrameRing, type ResidentFrame } from '../core/wasm.ts';
import { analysisFactor, equalRGBA } from '../core/raster.ts';
import { encodeRGBA } from '../codec/png.ts';
import { pad } from '../core/math.ts';
import { encodeFeatures } from './features-codec.ts';
import { prefixOnly, type RunContext, StorageError } from './context.ts';
/** A long-baseline reference frame for slow scrolling, plus the fields it and the current frame carry, as
 * `ScanPass` tracks it: sub-analysis-pixel per-frame motion never clears the layer-evidence threshold, but the
 * SAME motion accumulated over several frames does. Only informative (single-step or long-baseline) frames move
 * it forward, so exact duplicates never disturb it. */
interface Baseline {
  gray: Gray;
  image: RGBA;
  features: Feature[];
  index: number;
}
/** All per-pass state `scan()` used to close over, now fields; the small methods below are exactly the sub-steps
 * `scan()`'s single 287-line body used to inline. */
class ScanPass {
  private previous: Gray | undefined;
  private previousImage: RGBA | undefined;
  private previousFeatures: Feature[] | undefined;
  private lastField: MotionField | undefined;
  private learner: LayerLearner | undefined;
  private baseline: Baseline | undefined;
  // Mixed scan/ (ScanRecord) and scan-features/ (CompactFeatures) rows batched together; both are scratch that
  // solve() consumes once and this run deletes afterwards, so one flush cadence for both is enough.
  private readonly pending: { key: string; value: unknown }[] = [];
  // Two resident native frames (previous, current) so each decoded frame is copied into the core once. Sized on
  // the first frame, like `ctx.factor`: a CONTAINER_SIZE_MISMATCH notice on that frame may rewrite source.info.
  private scanFrames: FrameRing | undefined;
  private storageFailed = false;
  private endedNaturally = false;
  // Set by analyzeFrame() once a stop request was honoured or a per-frame failure ended the pass, so run()'s
  // loop can break right after the call that set it, exactly where the inlined body used to `break` itself.
  private stop = false;
  constructor(private readonly ctx: RunContext) {}
  /** The first-frame branch (no `previous` gray frame yet): a zero-motion field standing in until frame 1 has
   * something to compare against, the COMPUTE_BACKEND diagnostic (compute backend and core build, known only once
   * an actual frame has been analysed), and — presentation-only — the frame-reference PNG a "context" framing
   * mode needs later. An encode/storage failure on the reference must not abort the run, just demote to a
   * warning: buildFramedCanvas already skips framing when this row is missing. */
  private async firstFrameField(frame: { index: number; image: RGBA }, g: Gray, features: Feature[]): Promise<MotionField> {
    const cols = Math.ceil(g.width / 24), rows = Math.ceil(g.height / 24);
    const field: MotionField = {
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
    this.baseline = { gray: g, image: frame.image, features, index: frame.index };
    await this.ctx.diagnostics.emit({
      code: 'COMPUTE_BACKEND',
      severity: 'info',
      message:
        `${this.ctx.computer.stats.backend} — ${this.ctx.computer.stats.reason}。Rust 核心：${coreBuild().variant} 构建，${coreBuild().threads} 个计算线程（${coreBuild().reason}）。`,
      detail: { ...this.ctx.computer.stats, core: coreBuild() },
    });
    if (this.ctx.project.settings.framing === 'context') {
      // Presentation-only: buildFramedCanvas already skips framing when this row is missing, so an
      // encode/storage failure here must not abort the run — just demote to a warning.
      try {
        await this.ctx.store.put('frame-reference', {
          frame: frame.index,
          image: new Blob([await encodeRGBA(frame.image)], { type: 'image/png' }),
        });
      } catch (error) {
        await this.ctx.diagnostics.emit({
          code: 'PRESENTATION_REFERENCE_FAILED',
          severity: 'warning',
          message: String(error),
          action: '带外框呈现将被跳过；页面坐标下的核心重建不受影响。',
        });
      }
    }
    return field;
  }
  /** The steady-state branch (a `previous` gray frame exists): estimates motion against it, feeds an informative
   * field to the layer learner, and — when a single step never clears the evidence threshold — retries against
   * the long-baseline reference frame, whose own displacement accumulated over several frames can. */
  private stepMotion(frame: { index: number; image: RGBA }, g: Gray, features: Feature[], current: RGBA | ResidentFrame): MotionField {
    const field = estimateMotion(this.previous!, g, this.lastField, this.previousFeatures, features);
    if (informativeField(field)) {
      this.learner!.add(field, this.previous!, g, this.scanFrames!.get(frame.index - 1) ?? this.previousImage, current);
      this.baseline = { gray: g, image: frame.image, features, index: frame.index };
    } else if (this.baseline && frame.index - this.baseline.index >= 4) {
      // The same displacement measured over more frames crosses the analysis-pixel evidence threshold that a
      // single sub-pixel step cannot; this is the only extra estimateMotion call, and only here.
      const longField = estimateMotion(this.baseline.gray, g, undefined, this.baseline.features, features);
      if (informativeField(longField)) {
        this.learner!.add(longField, this.baseline.gray, g, this.scanFrames!.get(this.baseline.index) ?? this.baseline.image, current);
        this.baseline = { gray: g, image: frame.image, features, index: frame.index };
      } else if (frame.index - this.baseline.index > 24) {
        this.baseline = { gray: g, image: frame.image, features, index: frame.index };
      }
    }
    return field;
  }
  /** The duplicate-frame shortcut: a zero-motion field carrying the previous field's cell layout (labels/dynamic
   * reset, since a duplicate frame contributes no new evidence about which cells moved). */
  private duplicateField(lastField: MotionField, features: Feature[]): MotionField {
    this.ctx.duplicates++;
    return {
      ...lastField,
      motions: [{ x: 0, y: 0, support: features.length, unique: features.length, confidence: 1, error: 0, ambiguous: false }],
      labels: new Uint8Array(lastField.labels.length),
      dynamic: new Uint8Array(lastField.labels.length),
      difference: 0,
      unknown: false,
      zoom: 1,
    };
  }
  /** The four per-frame warning/info diagnostics this pass can raise once a field is known: low texture (frame 0
   * only), unresolved motion, an ambiguous repeating pattern, and temporal undersampling. */
  private async emitFrameDiagnostics(
    frame: { index: number; time: number; duration: number },
    features: Feature[],
    field: MotionField,
  ): Promise<void> {
    if (features.length < 8 && frame.index === 0) {
      await this.ctx.diagnostics.emit({
        code: 'LOW_TEXTURE_UNOBSERVABLE',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        message: '画面缺乏可辨认纹理。完全相同的空白帧既可能是暂停，也可能是在空白区域移动；像素本身无法区分。',
        action: '增加有区分度的可见内容或录制更多重叠。零位移只是 best guess。',
      });
    }
    if (field.unknown) {
      await this.ctx.diagnostics.emit({
        code: 'UNRESOLVED_MOTION',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        message: '这一观察缺少可靠的视觉对齐依据。定位阶段将尝试历史重定位；仍无法定位时保留独立片段。',
        confidence: 0,
      });
    }
    if (field.motions[0]?.ambiguous && field.motions[0].support >= 6) {
      await this.ctx.diagnostics.emit({
        code: 'AMBIGUOUS_PATTERN',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        message: '检测到具有多种合理匹配的重复纹理；连续性只是定位先验，不是已证实的唯一位置。',
      });
    }
    if (frame.duration > .12) {
      await this.ctx.diagnostics.emit({
        code: 'TEMPORAL_UNDERSAMPLING',
        severity: 'info',
        time: frame.time,
        frame: frame.index,
        message: '此帧持续时间较长；高速移动期间可能存在从未被采集到的区域。',
      });
    }
  }
  /** One decoded frame's worth of work: size the run on frame 0, take the duplicate/steady-state/first-frame
   * motion branch, persist the scan/features rows, and report progress. Sets `this.stop` (never breaks itself —
   * run()'s loop owns the decode order) on a stop request, an unrecoverable per-frame failure, or a rethrow. */
  private async analyzeFrame(frame: { index: number; time: number; duration: number; image: RGBA }): Promise<void> {
    // The decode step (next()) and this per-frame body are two separate try blocks — this one and run()'s
    // around it — so a body failure (algorithm or storage) is never blamed on the decoder, and a decoder
    // failure is never misclassified as an analysis or storage error.
    try {
      if (frame.index === 0) {
        // Provisional until now: a CONTAINER_SIZE_MISMATCH notice on this very frame may just have rewritten
        // source.info.width/height, so the factor is derived only after that can no longer change.
        this.ctx.factor = analysisFactor(this.ctx.source.info.width, this.ctx.source.info.height, this.ctx.project.settings.analysisSize);
        this.ctx.refineRadius = Math.max(3, Math.ceil(this.ctx.factor / 2) + 1);
        this.scanFrames = this.ctx.frames = core().frameRing(2, this.ctx.source.info.width, this.ctx.source.info.height);
      }
      const duplicate = !!this.previousImage && equalRGBA(this.previousImage, frame.image);
      // The native frame enters core memory once here; the downscale and the layer learner both read it there. A
      // frame whose geometry differs from the run's is rejected by gray() below with the historical message.
      const current = frame.image.width === this.scanFrames!.width && frame.image.height === this.scanFrames!.height
        ? this.scanFrames!.upload(frame.index, frame.image)
        : frame.image;
      const g = duplicate ? this.previous! : await this.ctx.gray(current),
        features = duplicate ? this.previousFeatures! : extractFeatures(g);
      this.learner ??= this.ctx.learner = new LayerLearner(g.width, g.height);
      const field: MotionField = duplicate && this.lastField
        ? this.duplicateField(this.lastField, features)
        : this.previous
        ? this.stepMotion(frame, g, features, current)
        : await this.firstFrameField(frame, g, features);
      const record: ScanRecord = { index: frame.index, time: frame.time, duration: frame.duration, field, duplicate };
      this.pending.push({ key: `scan/${pad(frame.index)}`, value: record });
      if (!duplicate) {
        this.pending.push({ key: `scan-features/${pad(frame.index)}`, value: encodeFeatures(features) });
      }
      if (this.pending.length >= 24) {
        await this.ctx.commitRows(this.pending);
      }
      this.ctx.project.frames = frame.index + 1;
      this.previous = g;
      this.previousImage = frame.image;
      this.previousFeatures = features;
      this.lastField = field;
      await this.emitFrameDiagnostics(frame, features, field);
      await this.ctx.report(frame.index + 1, frame.time, '逐帧提取几何证据，学习独立运动区域。');
      if (this.ctx.stopRequested) {
        this.ctx.honourStop();
        this.stop = true;
      }
    } catch (error) {
      if (!this.ctx.project.frames) {
        throw error;
      }
      this.ctx.partial = true;
      if (error instanceof StorageError) {
        this.storageFailed = true;
        // Storage is failing: mark partial and stop, do not attempt another write. The diagnostic itself goes
        // through the journal only if that journal write succeeds.
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
        this.stop = true;
        return;
      }
      // A frame-geometry mismatch (mid-recording rotation/resolution change) is a source/decoder-level anomaly,
      // not an algorithmic one, even though gray() only notices it once the body already has the frame in hand;
      // it is reported the same way a decode failure is.
      if (error instanceof Error && error.message.startsWith('FRAME_GEOMETRY_CHANGED')) {
        await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        this.stop = true;
        return;
      }
      await this.ctx.diagnostics.emit(prefixOnly('ANALYSIS_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
      this.stop = true;
    }
  }
  /** The decode loop: mirrors solve()'s and render()'s shape (see the file header), but no lookahead — each
   * decoded frame is analysed immediately. */
  private async run(): Promise<void> {
    const it = this.ctx.source.frames();
    try {
      while (true) {
        await this.ctx.checkpoint();
        let step: Awaited<ReturnType<typeof it.next>>;
        try {
          step = await it.next();
        } catch (error) {
          if (!this.ctx.project.frames) {
            throw error;
          }
          this.ctx.partial = true;
          await this.ctx.diagnostics.emit(prefixOnly('DECODE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
          break;
        }
        if (step.done) {
          this.endedNaturally = true;
          break;
        }
        await this.analyzeFrame(step.value);
        if (this.stop) {
          break;
        }
      }
    } finally {
      // Switching from for-await-of to manual next() calls lost the implicit return() an early break used to
      // get for free; restore it explicitly so the decoder is released on every exit path.
      try {
        await it.return(undefined);
      } catch { /* already unwinding */ }
      this.scanFrames?.free();
      this.ctx.frames = undefined;
    }
  }
  /** Trailing commit of whatever scan/scan-features rows never reached a 24-row batch, the scan-vs-source
   * frame-count mismatch check, and the source's own decode notices (each re-emitted as a diagnostic). */
  private async trailingCommit(): Promise<void> {
    if (this.pending.length && !this.storageFailed) {
      // Routed through commitRows (not a bare store.putMany) so a quota/transaction failure on this trailing
      // <24-row batch is classified and handled the same way an in-loop flush failure is — partial and
      // PERSISTENCE_PREFIX_ONLY — instead of escaping scan() entirely as an unclassified top-level error.
      try {
        await this.ctx.commitRows(this.pending);
      } catch (error) {
        this.ctx.partial = true;
        this.storageFailed = true;
        try {
          await this.ctx.diagnostics.emit(prefixOnly('PERSISTENCE_PREFIX_ONLY', 'scan', this.ctx.project.frames, error));
        } catch { /* the journal write itself failed too; the run is already marked partial. */ }
      }
    }
    if (this.endedNaturally && this.ctx.source.info.frameCount !== undefined) {
      const preroll = this.ctx.source.info.notices?.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')?.count || 0;
      await this.ctx.passMismatch('scan', this.ctx.source.info.frameCount - preroll, this.ctx.project.frames);
    }
    for (const notice of this.ctx.source.info.notices || []) {
      await this.ctx.diagnostics.emit({
        code: notice.code,
        severity: 'warning',
        message: notice.message,
        count: notice.count,
        detail: { count: notice.count },
      });
    }
  }
  /** Region finalisation: hands the layer learner's accumulated evidence to `finish()`, builds the region atlas,
   * persists the regions row, and raises the region-shape diagnostics (manual-unassigned, explicitly-excluded,
   * manual-priority, automatic-layer-mask, multiple-scroll-layers) that depend on the final region set. */
  private async finalizeRegions(): Promise<void> {
    this.ctx.regions =
      this.learner?.finish(this.ctx.source.info.width, this.ctx.source.info.height, this.ctx.project.settings.regions, this.ctx.factor) ||
      [];
    this.ctx.atlas = new RegionAtlas(this.ctx.regions, this.ctx.source.info.width, this.ctx.source.info.height);
    this.ctx.project.regions = this.ctx.regions.map(({ mask: _mask, ...r }) => r);
    await this.ctx.store.put('regions', this.ctx.regions);
    if (this.ctx.regions.some((r) => r.unassigned)) {
      await this.ctx.diagnostics.emit({
        code: 'MANUAL_UNASSIGNED',
        severity: 'warning',
        message: '手动区域未覆盖的部分被保留为独立的低置信屏幕坐标观察层，没有宣称这些像素已恢复到页面坐标。',
      });
    }
    if (this.ctx.regions.some((r) => r.kind === 'ignore')) {
      await this.ctx.diagnostics.emit({
        code: 'EXPLICITLY_EXCLUDED_REGION',
        severity: 'warning',
        message: '按手动设置排除了“忽略”区域。该区域不会贡献到重建结果，这不是自动丢帧。',
      });
    }
    if (this.ctx.project.settings.regions.length) {
      await this.ctx.diagnostics.emit({
        code: 'MANUAL_REGION_PRIORITY',
        severity: 'info',
        message: '手动区域重叠时，后绘制区域优先；忽略区域始终排除。其余像素保留在未指定观察层。',
      });
    }
    const moving = this.ctx.regions.filter((r) => r.kind === 'moving').length,
      fixed = this.ctx.regions.filter((r) => r.kind === 'fixed').length;
    if (!this.ctx.project.settings.regions.length) {
      await this.ctx.diagnostics.emit({
        code: 'AUTOMATIC_LAYER_MASK',
        severity: 'info',
        message: `自动划分出 ${moving} 个内容区域和 ${fixed} 个固定界面区域。边界来自像素运动统计，而不是 DOM。`,
        action: '若遮罩归属不合理，可在“区域”里画出精确滚动区后重新处理。',
      });
    }
    if (moving > 1) {
      await this.ctx.diagnostics.emit({
        code: 'MULTIPLE_SCROLL_LAYERS',
        severity: 'info',
        message: '多个独立滚动区将分别建立画布，不强制共享一个 scroll offset。',
      });
    }
    await this.ctx.diagnostics.flush();
    await this.ctx.persist();
  }
  /** Runs the whole pass: the decode loop, the trailing commit, then region finalisation. */
  async execute(): Promise<void> {
    this.ctx.phase = 'scanning';
    await this.run();
    await this.trailingCommit();
    await this.finalizeRegions();
  }
}
export async function scan(ctx: RunContext): Promise<void> {
  await new ScanPass(ctx).execute();
}
