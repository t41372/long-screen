// Shell around the scan pass: decode-loop orchestration (storage, diagnostics, progress, batching, failure
// classification) plus algorithm-awaiting-port motion evidence extraction (estimateMotion/LayerLearner, still
// TypeScript today). The decode-loop skeleton mirrors solve()'s and render()'s — see frame-loop-shaped comments
// throughout — but is not yet factored into a shared helper (see engine.ts's header for why: the three loops
// differ enough in their failure wording and one-frame lookahead that forcing a shared skeleton risked obscuring
// the ordering each one guarantees).
import type { Feature, Gray, MotionField, RGBA, ScanRecord } from '../types.ts';
import { informativeField, LayerLearner, RegionAtlas } from '../core/layers.ts';
import { estimateMotion } from '../core/motion.ts';
import { extractFeatures } from '../core/features.ts';
import { core, coreBuild, type FrameRing } from '../core/wasm.ts';
import { analysisFactor, equalRGBA } from '../core/raster.ts';
import { encodeRGBA } from '../codec/png.ts';
import { pad } from '../core/math.ts';
import { encodeFeatures } from './features-codec.ts';
import { type RunContext, StorageError } from './context.ts';
export async function scan(ctx: RunContext): Promise<void> {
  ctx.phase = 'scanning';
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
  // Two resident native frames (previous, current) so each decoded frame is copied into the core once. Sized on
  // the first frame, like `factor`: a CONTAINER_SIZE_MISMATCH notice on that frame may rewrite source.info.
  let scanFrames: FrameRing | undefined;
  const it = ctx.source.frames();
  let storageFailed = false;
  let endedNaturally = false;
  try {
    while (true) {
      await ctx.checkpoint();
      // The decode step (next()) and the per-frame body are two separate try blocks below so a body failure
      // (algorithm or storage) is never blamed on the decoder, and a decoder failure is never misclassified
      // as an analysis or storage error.
      let step: Awaited<ReturnType<typeof it.next>>;
      try {
        step = await it.next();
      } catch (error) {
        if (!ctx.project.frames) {
          throw error;
        }
        ctx.partial = true;
        await ctx.diagnostics.emit({
          code: 'DECODE_PREFIX_ONLY',
          severity: 'error',
          message: String(error),
          action: `仅对已经解码的前 ${ctx.project.frames} 帧继续定位和合成。`,
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
          ctx.factor = analysisFactor(ctx.source.info.width, ctx.source.info.height, ctx.project.settings.analysisSize);
          ctx.refineRadius = Math.max(3, Math.ceil(ctx.factor / 2) + 1);
          scanFrames = ctx.frames = core().frameRing(2, ctx.source.info.width, ctx.source.info.height);
        }
        const duplicate = !!previousImage && equalRGBA(previousImage, frame.image);
        // The native frame enters core memory once here; the downscale and the layer learner both read it there.
        // A frame whose geometry differs from the run's is rejected by gray() below with the historical message.
        const current = frame.image.width === scanFrames!.width && frame.image.height === scanFrames!.height
          ? scanFrames!.upload(frame.index, frame.image)
          : frame.image;
        const g = duplicate ? previous! : await ctx.gray(current), features = duplicate ? previousFeatures! : extractFeatures(g);
        learner ??= ctx.learner = new LayerLearner(g.width, g.height);
        let field: MotionField;
        if (duplicate && lastField) {
          ctx.duplicates++;
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
            learner.add(field, previous, g, scanFrames!.get(frame.index - 1) ?? previousImage, current);
            baseline = { gray: g, image: frame.image, features, index: frame.index };
          } else if (baseline && frame.index - baseline.index >= 4) {
            // The same displacement measured over more frames crosses the analysis-pixel evidence threshold
            // that a single sub-pixel step cannot; this is the only extra estimateMotion call, and only here.
            const longField = estimateMotion(baseline.gray, g, undefined, baseline.features, features);
            if (informativeField(longField)) {
              learner.add(longField, baseline.gray, g, scanFrames!.get(baseline.index) ?? baseline.image, current);
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
          await ctx.diagnostics.emit({
            code: 'COMPUTE_BACKEND',
            severity: 'info',
            message:
              `${ctx.computer.stats.backend} — ${ctx.computer.stats.reason}。Rust 核心：${coreBuild().variant} 构建，${coreBuild().threads} 个计算线程（${coreBuild().reason}）。`,
            detail: { ...ctx.computer.stats, core: coreBuild() },
          });
          if (ctx.project.settings.framing === 'context') {
            // Presentation-only: buildFramedCanvas already skips framing when this row is missing, so an
            // encode/storage failure here must not abort the run — just demote to a warning.
            try {
              await ctx.store.put('frame-reference', {
                frame: frame.index,
                image: new Blob([await encodeRGBA(frame.image)], { type: 'image/png' }),
              });
            } catch (error) {
              await ctx.diagnostics.emit({
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
          await ctx.commitRows(pending);
        }
        ctx.project.frames = frame.index + 1;
        previous = g;
        previousImage = frame.image;
        previousFeatures = features;
        lastField = field;
        if (features.length < 8 && frame.index === 0) {
          await ctx.diagnostics.emit({
            code: 'LOW_TEXTURE_UNOBSERVABLE',
            severity: 'warning',
            time: frame.time,
            frame: frame.index,
            message: '画面缺乏可辨认纹理。完全相同的空白帧既可能是暂停，也可能是在空白区域移动；像素本身无法区分。',
            action: '增加有区分度的可见内容或录制更多重叠。零位移只是 best guess。',
          });
        }
        if (field.unknown) {
          await ctx.diagnostics.emit({
            code: 'UNRESOLVED_MOTION',
            severity: 'warning',
            time: frame.time,
            frame: frame.index,
            message: '这一观察缺少可靠的视觉对齐依据。定位阶段将尝试历史重定位；仍无法定位时保留独立片段。',
            confidence: 0,
          });
        }
        if (field.motions[0]?.ambiguous && field.motions[0].support >= 6) {
          await ctx.diagnostics.emit({
            code: 'AMBIGUOUS_PATTERN',
            severity: 'warning',
            time: frame.time,
            frame: frame.index,
            message: '检测到具有多种合理匹配的重复纹理；连续性只是定位先验，不是已证实的唯一位置。',
          });
        }
        if (frame.duration > .12) {
          await ctx.diagnostics.emit({
            code: 'TEMPORAL_UNDERSAMPLING',
            severity: 'info',
            time: frame.time,
            frame: frame.index,
            message: '此帧持续时间较长；高速移动期间可能存在从未被采集到的区域。',
          });
        }
        await ctx.report(frame.index + 1, frame.time, '逐帧提取几何证据，学习独立运动区域。');
        if (ctx.stopRequested) {
          ctx.honourStop();
          break;
        }
      } catch (error) {
        if (!ctx.project.frames) {
          throw error;
        }
        ctx.partial = true;
        if (error instanceof StorageError) {
          storageFailed = true;
          // Storage is failing: mark partial and stop, do not attempt another write. The diagnostic itself
          // goes through the journal only if that journal write succeeds.
          try {
            await ctx.diagnostics.emit({
              code: 'PERSISTENCE_PREFIX_ONLY',
              severity: 'error',
              message: String(error),
              action: `仅对已经解码的前 ${ctx.project.frames} 帧继续定位和合成；存储写入已停止。`,
            });
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
          break;
        }
        // A frame-geometry mismatch (mid-recording rotation/resolution change) is a source/decoder-level
        // anomaly, not an algorithmic one, even though gray() only notices it once the body already has
        // the frame in hand; it is reported the same way a decode failure is.
        if (error instanceof Error && error.message.startsWith('FRAME_GEOMETRY_CHANGED')) {
          await ctx.diagnostics.emit({
            code: 'DECODE_PREFIX_ONLY',
            severity: 'error',
            message: String(error),
            action: `仅对已经解码的前 ${ctx.project.frames} 帧继续定位和合成。`,
          });
          break;
        }
        await ctx.diagnostics.emit({
          code: 'ANALYSIS_PREFIX_ONLY',
          severity: 'error',
          message: String(error),
          action: `仅对已经解码的前 ${ctx.project.frames} 帧继续定位和合成。`,
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
    scanFrames?.free();
    ctx.frames = undefined;
  }
  if (pending.length && !storageFailed) {
    // Routed through storagePutMany (not a bare store.putMany) so a quota/transaction failure on this
    // trailing <24-row batch is classified and handled the same way an in-loop flush failure is — partial
    // and PERSISTENCE_PREFIX_ONLY — instead of escaping scan() entirely as an unclassified top-level error.
    try {
      await ctx.commitRows(pending);
    } catch (error) {
      ctx.partial = true;
      storageFailed = true;
      try {
        await ctx.diagnostics.emit({
          code: 'PERSISTENCE_PREFIX_ONLY',
          severity: 'error',
          message: String(error),
          action: `仅对已经解码的前 ${ctx.project.frames} 帧继续定位和合成；存储写入已停止。`,
        });
      } catch { /* the journal write itself failed too; the run is already marked partial. */ }
    }
  }
  if (endedNaturally && ctx.source.info.frameCount !== undefined) {
    const preroll = ctx.source.info.notices?.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')?.count || 0;
    await ctx.passMismatch('scan', ctx.source.info.frameCount - preroll, ctx.project.frames);
  }
  for (const notice of ctx.source.info.notices || []) {
    await ctx.diagnostics.emit({
      code: notice.code,
      severity: 'warning',
      message: notice.message,
      count: notice.count,
      detail: { count: notice.count },
    });
  }
  ctx.regions = learner?.finish(ctx.source.info.width, ctx.source.info.height, ctx.project.settings.regions, ctx.factor) || [];
  ctx.atlas = new RegionAtlas(ctx.regions, ctx.source.info.width, ctx.source.info.height);
  ctx.project.regions = ctx.regions.map(({ mask: _mask, ...r }) => r);
  await ctx.store.put('regions', ctx.regions);
  if (ctx.regions.some((r) => r.unassigned)) {
    await ctx.diagnostics.emit({
      code: 'MANUAL_UNASSIGNED',
      severity: 'warning',
      message: '手动区域未覆盖的部分被保留为独立的低置信屏幕坐标观察层，没有宣称这些像素已恢复到页面坐标。',
    });
  }
  if (ctx.regions.some((r) => r.kind === 'ignore')) {
    await ctx.diagnostics.emit({
      code: 'EXPLICITLY_EXCLUDED_REGION',
      severity: 'warning',
      message: '按手动设置排除了“忽略”区域。该区域不会贡献到重建结果，这不是自动丢帧。',
    });
  }
  if (ctx.project.settings.regions.length) {
    await ctx.diagnostics.emit({
      code: 'MANUAL_REGION_PRIORITY',
      severity: 'info',
      message: '手动区域重叠时，后绘制区域优先；忽略区域始终排除。其余像素保留在未指定观察层。',
    });
  }
  const moving = ctx.regions.filter((r) => r.kind === 'moving').length, fixed = ctx.regions.filter((r) => r.kind === 'fixed').length;
  if (!ctx.project.settings.regions.length) {
    await ctx.diagnostics.emit({
      code: 'AUTOMATIC_LAYER_MASK',
      severity: 'info',
      message: `自动划分出 ${moving} 个内容区域和 ${fixed} 个固定界面区域。边界来自像素运动统计，而不是 DOM。`,
      action: '若遮罩归属不合理，可在“区域”里画出精确滚动区后重新处理。',
    });
  }
  if (moving > 1) {
    await ctx.diagnostics.emit({
      code: 'MULTIPLE_SCROLL_LAYERS',
      severity: 'info',
      message: '多个独立滚动区将分别建立画布，不强制共享一个 scroll offset。',
    });
  }
  await ctx.diagnostics.flush();
  await ctx.persist();
}
