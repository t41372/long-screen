// Shell around the solve pass: frame loop, duplicate-frame shortcut, plan batching, voting ring lifecycle
// and queueing, graph optimise. ALGORITHM-AWAITING-PORT: the per-region tracking decisions inside the frame
// loop below (hypothesis scoring, audit acceptance, native refinement choice, the confidence formula, anchor
// re-acquisition, keyframe/revisit/attachment/loop-closure decisions) are still plain TypeScript, not yet
// ported to Rust (see docs/HANDOFF.md "已在 Rust 核心中"). Splitting that decision logic into
// solve/{track,place,keyframe}.ts as pure functions (plain inputs -> plain result objects, no storage, no
// diagnostics emission, no engine state) is the next step, left for a follow-up round. Everything OUTSIDE
// that decision logic here (storage, diagnostics, progress, batching, failure classification) is orchestration
// shell, unambiguously not awaiting a port.
import type { Attachment, CanvasMeta, Feature, FramePlan, Gray, Placement, Point, Region, RGBA, ScanRecord } from '../../types.ts';
import { deletePrefix } from '../../storage/db.ts';
import { extractFeatures, grayscale, matchFeatures } from '../../core/features.ts';
import {
  auditTranslation,
  detectScale,
  extractPatches,
  type NativeRefinement,
  probeScale,
  refineNative,
  refinePatches,
  translationHypotheses,
} from '../../core/motion.ts';
import { regionContains, stickyOcclusions } from '../../core/layers.ts';
import { PoseGraph, type PoseNode } from '../../core/pose-graph.ts';
import { type Keyframe, KeyframeIndex } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import { core, ResidentFrame, type ResidentGray, type VotingRecord } from '../../core/wasm.ts';
import { attachmentShift, resolveTarget as resolveAttachmentTarget } from '../attachments.ts';
import { type CompactFeatures, decodeFeatures } from '../features-codec.ts';
import type { ConsistencyRecord } from '../consistency.ts';
import { type RunContext, StopRequested, StorageError } from '../context.ts';
/** Per-region odometry/tracking state carried frame to frame through solve()'s loop. */
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
async function newCanvas(ctx: RunContext, state: State, time: number): Promise<void> {
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
  await ctx.store.put(`canvas/${meta.id}`, meta);
  ctx.project.canvasCount++;
}
export async function solve(ctx: RunContext): Promise<void> {
  ctx.phase = 'solving';
  ctx.project.status = 'solving';
  await ctx.persist();
  const graph = new PoseGraph(ctx.store),
    index = new KeyframeIndex(
      ctx.store,
      async (message) => ctx.diagnostics.emit({ code: 'RELOCALIZATION_BUDGET', severity: 'warning', message }),
    );
  const atlas = ctx.atlas!, f = ctx.factor, radius = ctx.refineRadius, attachments = new Map<string, Attachment>();
  const states: State[] = ctx.regions.filter((r) => r.kind !== 'ignore').map((region) => ({
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
  let previous: RGBA | ResidentFrame | undefined,
    previousGray: Gray | undefined,
    previousFeaturesAll: Feature[] | undefined,
    previousPlan: FramePlan | undefined,
    solved = 0;
  // Native frames (previous, current) and the atlas label plane enter core memory once per frame / once per
  // pass; native refinement, sticky-band detection and the downscale all read them there. Released in this
  // pass's finally (run()'s finally covers abnormal exits through the same fields).
  const solveFrames = ctx.frames = core().frameRing(2, ctx.source.info.width, ctx.source.info.height);
  const residentLabels = ctx.residentLabels = core().upload(atlas.labels);
  // Full-resolution luma of the current frame, recomputed in place on first use each frame.
  const nativePlane = ctx.nativePlane = core().gray(ctx.source.info.width, ctx.source.info.height);
  const pending: { key: string; value: FramePlan }[] = [];
  let endedNaturally = false;
  let missingScan = false;
  // Displacement-spread consistency voting (docs/ARCHITECTURE.md §七) runs in the Rust core
  // (rust/core/src/voting.rs): a ring of recent analysis-resolution frames bounded by bytes retained, each
  // moving region's final pose compared against partners whose world displacement clears Dmin. Only the
  // moving regions take part; slot order is the order below. The ring is freed in the finally of this pass.
  const CONSISTENCY_RING_BYTES = 24 * 1024 * 1024;
  const votingRegions = states.filter((s) => s.region.kind === 'moving').map((s) => s.region);
  const votingSlot = new Map(votingRegions.map((r, i) => [r.id, i]));
  const voting = ctx.voting = core().votingRing(votingRegions, {
    factor: f,
    noise: ctx.noise,
    nativeWidth: ctx.source.info.width,
    nativeHeight: ctx.source.info.height,
    analysisWidth: Math.max(1, Math.ceil(ctx.source.info.width / f)),
    analysisHeight: Math.max(1, Math.ceil(ctx.source.info.height / f)),
    budgetBytes: CONSISTENCY_RING_BYTES,
  });
  const pendingConsistency: { key: string; value: ConsistencyRecord }[] = [];
  /** Queues finalised ring records for persistence and folds their layer statistics into the run's counters. */
  const queueVoting = (records: VotingRecord[]): void => {
    for (const record of records) {
      ctx.consistencyVotedLayers += record.votedLayers;
      ctx.consistencyThinLayers += record.thinLayers;
      if (record.record) {
        pendingConsistency.push({ key: `consistency/${pad(record.index)}`, value: record.record });
      }
    }
  };

  const resolveTarget = (id: string): string => resolveAttachmentTarget(attachments, id);
  // A keyframe minted on a fragment before it was attached still carries the fragment's raw canvasId and raw x/y;
  // canonicalCanvas/canonicalPose translate that into the canvas and pose it is actually observed at today, so
  // revisit geometry and rival scoring compare like with like instead of raw-vs-canonical mismatches.
  const canonicalCanvas = (id: string): string => resolveTarget(id);
  const canonicalPose = (k: Point & { canvasId: string }): Point => {
    const shift = attachmentShift(attachments, k.canvasId);
    return { x: k.x + shift.x, y: k.y + shift.y };
  };
  const canonical = (id: string) => {
    const shift = attachmentShift(attachments, id);
    return { canvasId: resolveTarget(id), dx: shift.x, dy: shift.y };
  };
  const it = ctx.source.frames();
  let storageFailed = false;
  try {
    while (true) {
      await ctx.checkpoint();
      // Same decode-step/body split as scan(): a decoder failure here is never blamed on the solver, and a
      // solver/storage failure here is never blamed on the decoder.
      let step: Awaited<ReturnType<typeof it.next>>;
      try {
        step = await it.next();
      } catch (error) {
        if (!solved) {
          throw error;
        }
        ctx.partial = true;
        await ctx.diagnostics.emit({
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
        const scan = await ctx.store.get<ScanRecord>(`scan/${pad(frame.index)}`);
        if (!scan) {
          missingScan = true;
          ctx.partial = true;
          await ctx.diagnostics.emit({
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
          if (pending.length >= 24) await ctx.commitRows(pending);
          previousPlan = plan;
          for (const s of states) s.velocity = { x: 0, y: 0 };
          solved = frame.index + 1;
          await ctx.report(solved, frame.time, '完全相同的观察复用定位；保留源帧与时间记录。', solved / ctx.project.frames);
          if (ctx.stopRequested) {
            ctx.honourStop();
            break;
          }
          if (solved >= ctx.project.frames) break;
          continue;
        }
        const image = frame.image;
        // A frame whose geometry differs from the run's stays in JS; gray() rejects it with the historical message.
        const current = image.width === solveFrames.width && image.height === solveFrames.height
          ? solveFrames.upload(frame.index, image)
          : image;
        const g = scan.duplicate && previousGray ? previousGray : await ctx.gray(current);
        const storedFeatures = scan.duplicate ? undefined : await ctx.store.get<CompactFeatures>(`scan-features/${pad(frame.index)}`);
        const features = (storedFeatures && decodeFeatures(storedFeatures)) || (scan.duplicate ? previousFeaturesAll : undefined) ||
          extractFeatures(g);
        // Full-resolution luma is only needed for keyframe patches, revisit search and anchor re-acquisition,
        // which most frames never reach; it is computed on first use.
        let nativeGray: Gray | ResidentGray | undefined;
        const native = (): Gray | ResidentGray =>
          nativeGray ??= current instanceof ResidentFrame
            ? core().grayscaleInto(current, nativePlane)
            : grayscale(image.data, image.width, image.height);
        const placements: Placement[] = [];
        let votingUploaded = false, votingObserved = false;
        for (const state of states) {
          const r = state.region,
            code = state.code,
            roi = { x: r.rect.x / f, y: r.rect.y / f, width: r.rect.width / f, height: r.rect.height / f };
          const mask = { labels: residentLabels, code };
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
              await newCanvas(ctx, state, frame.time);
            }
          } else if (r.kind !== 'moving') {
            if (frame.index === 0) {
              await newCanvas(ctx, state, frame.time);
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
              const n = refineNative(previous!, current, { x: v.m.x * f, y: v.m.y * f }, r.rect, mask, radius);
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
                await ctx.diagnostics.emit({
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
              n: refinePatches(state.anchor!.patches, native(), r.rect, { x: m.x * f, y: m.y * f }, radius),
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
                  const n = refinePatches(state.anchor.patches, native(), r.rect, expected, radius);
                  if (n.error < 12 && n.runnerUp > n.error + 1.5) {
                    state.pose = { x: state.anchor.x + n.x, y: state.anchor.y + n.y };
                    confidence = Math.max(confidence, .96 * Math.exp(-n.error / 20));
                  }
                }
              }
              uncertain = confidence < .60 || ambiguous || weakStep;
              if (weakStep) {
                await ctx.diagnostics.emit({
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
                await ctx.diagnostics.emit({
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
              await ctx.diagnostics.emit({
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
              await ctx.diagnostics.emit({
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
                const shift = attachmentShift(attachments, match.keyframe.canvasId);
                state.pose = { x: match.keyframe.x + match.offset.x + shift.x, y: match.keyframe.y + match.offset.y + shift.y };
                state.lastNode = undefined;
                state.anchor = match.keyframe;
                state.velocity = { x: 0, y: 0 };
                confidence = match.confidence;
                relocalized = true;
                await ctx.diagnostics.emit({
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
                await newCanvas(ctx, state, frame.time);
                confidence = .20;
                uncertain = true;
                await ctx.diagnostics.emit({
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
            await ctx.diagnostics.emit({
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
            await newCanvas(ctx, state, frame.time);
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
                  shift = attachmentShift(attachments, global.keyframe.canvasId);
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
                await ctx.store.put(`attach/${state.canvasId}`, attachment);
                const meta = await ctx.store.get<CanvasMeta>(`canvas/${state.canvasId}`);
                if (meta) {
                  meta.attachedTo = target;
                  await ctx.store.put(`canvas/${state.canvasId}`, meta);
                }
                await ctx.diagnostics.emit({
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
                  correctedShift = attachmentShift(attachments, global.keyframe.canvasId);
                  odometryWeight = .05;
                  await ctx.diagnostics.emit({
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
                await ctx.store.put(`node/${node.id}`, node);
                const link = attachMatch ? attachMatch.keyframe : oldAnchor!;
                // state.pose is already canonical (target-space); link.{x,y} is raw in link.canvasId's own space.
                // Their difference IS the raw edge delta (it already carries the target's attachment shift plus
                // the revisit offset) — do not subtract the shift a second time.
                await graph.connect(link.node, node.id, state.pose.x - link.x, state.pose.y - link.y, 5, 'loop');
              } else if (global && canonicalCanvas(global.keyframe.canvasId) === state.canvasId) {
                const linkShift = attachmentShift(attachments, global.keyframe.canvasId);
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
                  await ctx.diagnostics.emit({
                    code: 'LOOP_CLOSURE',
                    severity: 'info',
                    canvasId: state.canvasId,
                    time: frame.time,
                    frame: frame.index,
                    confidence: global.confidence,
                    message: '发现可靠的历史重访，已加入全局位置约束；最终合成使用校正后的轨迹。',
                  });
                } else if (discrepancy >= 16) {
                  await ctx.diagnostics.emit({
                    code: 'INCONSISTENT_LOOP_REJECTED',
                    severity: 'warning',
                    time: frame.time,
                    frame: frame.index,
                    canvasId: state.canvasId,
                    message: `历史匹配与连续轨迹相差 ${discrepancy.toFixed(1)}px；证据冲突，未强加为回环。`,
                    confidence: global.confidence,
                  });
                } else if (global.ambiguous) {
                  await ctx.diagnostics.emit({
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
                  ? extractPatches(native(), r.rect, ownFeatures.map((p) => ({ x: p.x - roi.x, y: p.y - roi.y })), f)
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
            voting.observe(votingSlot.get(r.id)!, state.canvasId, state.pose, g, votingUploaded);
            votingUploaded = true;
            votingObserved = true;
          }
          const occlusions = previous && r.kind === 'moving' && (decision === 'tracked' || decision === 'static')
            ? stickyOcclusions(
              previous,
              current,
              r,
              delta,
              previousPlan?.placements.find((p) => p.layer === r.id && p.canvasId === state.canvasId)?.occlusions,
            )
            : [];
          if (occlusions.length) {
            await ctx.diagnostics.emit({
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
        if (votingObserved) {
          queueVoting(voting.pushFrame(frame.index));
          if (pendingConsistency.length >= 24) {
            await ctx.commitRows(pendingConsistency);
          }
        }
        previousPlan = { index: frame.index, time: frame.time, placements, duplicate: scan.duplicate };
        pending.push({ key: `plan/${pad(frame.index)}`, value: previousPlan });
        previousFeaturesAll = features;
        if (pending.length >= 24) {
          await ctx.commitRows(pending);
        }
        previous = current;
        previousGray = g;
        solved = frame.index + 1;
        await ctx.report(solved, frame.time, '原像素精修、历史重定位与二维回环约束。', solved / ctx.project.frames);
        if (ctx.stopRequested) {
          ctx.honourStop();
          break;
        }
        if (solved >= ctx.project.frames) {
          break;
        }
      } catch (error) {
        if (!solved) {
          throw error;
        }
        ctx.partial = true;
        if (error instanceof StorageError) {
          storageFailed = true;
          try {
            await ctx.diagnostics.emit({
              code: 'PERSISTENCE_PREFIX_ONLY',
              severity: 'error',
              message: String(error),
              action: `仅对已经求解的前 ${solved} 帧继续渲染；存储写入已停止。`,
              detail: { pass: 'solve', frames: solved },
            });
          } catch { /* the journal write itself failed too; the run is already marked partial. */ }
          break;
        }
        await ctx.diagnostics.emit({
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
    solveFrames.free();
    residentLabels.free();
    nativePlane.free();
    ctx.frames = ctx.residentLabels = ctx.nativePlane = undefined;
  }
  if (pending.length && !storageFailed) {
    try {
      await ctx.commitRows(pending);
    } catch (error) {
      storageFailed = true;
      ctx.partial = true;
      try {
        await ctx.diagnostics.emit({
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
    await ctx.passMismatch('solve', ctx.project.frames, solved);
  }
  // Every frame still resident in the ring when solve() ends (the tail of the run never got displaced by a
  // later frame's bytes) is finalised here exactly as an evicted one would have been.
  if (!storageFailed) {
    queueVoting(voting.drain());
    if (pendingConsistency.length) {
      try {
        await ctx.commitRows(pendingConsistency);
      } catch (error) {
        storageFailed = true;
        ctx.partial = true;
        try {
          await ctx.diagnostics.emit({
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
  voting.free();
  ctx.voting = undefined;
  ctx.processed = solved;
  ctx.events.progress({ phase: 'optimizing', fraction: 0, frames: solved, time: 0, message: '优化磁盘中的位置图，校正回环漂移。' });
  // pose-graph.ts only persists relaxed positions once optimize() finishes its loop; a stop mid-relaxation
  // unwinds via StopRequested before that, so the unrelaxed (but already-persisted, pre-optimize) node
  // positions are what render() sees — geometrically consistent, just without this pass's loop-closure fix-up.
  let result: { residual: number; iterations: number };
  try {
    result = await graph.optimize(async () => {
      await ctx.checkpoint();
      if (ctx.stopRequested) throw new StopRequested();
    });
  } catch (error) {
    if (!(error instanceof StopRequested)) {
      throw error;
    }
    ctx.honourStop();
    result = { residual: 0, iterations: 0 };
  }
  if (result.residual > 1) {
    await ctx.diagnostics.emit({
      code: 'GRAPH_RESIDUAL',
      severity: 'warning',
      message: `位置图最大残差仍有 ${result.residual.toFixed(2)} 原像素；相关接缝可能存在几何不一致。`,
      detail: result,
      action: '检查回环附近的文字与重复纹理。该残差没有被隐藏。',
    });
  }
  await ctx.store.put('graph-summary', { loops: graph.loops, ...result });
  // scan-features/keyframe/word are scratch this pass alone consumed (relocalization postings and per-frame
  // features); render() never reads them, so they are deleted here rather than carried to export or reopen.
  await deletePrefix(ctx.store, 'scan-features/');
  await deletePrefix(ctx.store, 'keyframe/');
  await deletePrefix(ctx.store, 'word/');
  await ctx.diagnostics.flush();
  await ctx.persist();
}
