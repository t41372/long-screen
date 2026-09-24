// The per-region shell inside solve()'s frame loop: calls track.ts's pure tracking decisions and applies their
// results IN THE ORIGINAL ORDER — diagnostics, KeyframeIndex/PoseGraph I/O, new canvases, voting, occlusion
// detection, placement construction. Not an algorithm awaiting a Rust port itself; see track.ts's header for what
// is.
import type { Attachment, Feature, Gray, Placement, Point, RGBA, ScanRecord } from '../../types.ts';
import { stickyOcclusions } from '../../core/layers.ts';
import type { NativeRefinement } from '../../core/motion.ts';
import type { PoseGraph } from '../../core/pose-graph.ts';
import type { KeyframeIndex } from '../../core/keyframes.ts';
import type { LabelMask, ResidentFrame, ResidentGray, VotingRing } from '../../core/wasm.ts';
import { attachmentShift, resolveTarget as resolveAttachmentTarget } from '../attachments.ts';
import type { RunContext } from '../context.ts';
import { type Decision, newCanvas, type RegionState } from './state.ts';
import {
  BLIND_CONFIDENCE,
  driftCorrection,
  FRAGMENT_CONFIDENCE,
  fragmentCause,
  gate,
  isTextured,
  NONFINITE_CONFIDENCE,
  occlusionEligible,
  odometry,
  ownFeaturesOf,
  priorMatchesOf,
  reacquire,
  regionZoom as computeRegionZoom,
  relocalizeVerdict,
  STATIC_CONFIDENCE,
  targetPose,
  uncertainty,
  zoomChanged,
} from './track.ts';
import { keyframeStep } from './keyframe-step.ts';
/** One decoded frame's shared inputs, the same for every region stepped against it. `native` is memoized once per
 * FRAME (not per region) by solve.ts, exactly as the original single-function body computed it lazily on first
 * use and reused it across every region and both tracking steps within the frame. `voting` carries the
 * frame-level "has any region already uploaded this frame into the ring" flag, written by the first moving
 * region and read by the rest — solve.ts owns its lifetime across the whole frame's regions. */
export interface FrameInput {
  frame: { index: number; time: number };
  image: { width: number; height: number };
  scan: ScanRecord;
  current: RGBA | ResidentFrame;
  previous: RGBA | ResidentFrame | undefined;
  g: Gray;
  previousGray: Gray | undefined;
  features: Feature[];
  native: () => Gray | ResidentGray;
  /** R4c 3b-ii: the shared resident native-luma plane `native()` above also fills, only when `current` is a
   * `ResidentFrame` (undefined otherwise — the geometry-mismatch fallback `native()` still handles unfused, in
   * TS, exactly as before). `reacquire`/`driftCorrection` pass this straight to Rust so the fused call can fill
   * it lazily, core-side, itself; `nativeFilled`/`markNativeFilled` share `native()`'s own per-frame memo, so
   * whichever caller fills it first (a fused call or a later `native()` call) is the only fill this frame. */
  nativePlane: ResidentGray | undefined;
  nativeFilled(): boolean;
  markNativeFilled(): void;
  previousPlan: { placements: Placement[] } | undefined;
  voting: { uploaded: boolean; observed: boolean };
}
/** Everything region-step.ts's stepRegion() needs that lives for the whole solve() pass, not just one frame:
 * services, the pose graph and keyframe index, the fragment-attachment map and its three canonicalisation
 * methods (they close over `this.attachments`, which grows during the pass), and the analysis-geometry constants.
 * R6-B (final-verify-report.md item 10): was a plain object literal built in solve.ts plus the free functions
 * `stepRegion`/`keyframeStep`; solve.ts now does `new SolvePass(...)` and calls `pass.stepRegion(...)`.
 * `resolveTarget`/`canonicalCanvas`/`canonicalPose`/`canonical` are arrow-function fields, not prototype methods,
 * so a bare reference to one (e.g. `const { canonical } = this;`, unchanged from the pre-class destructure) stays
 * bound to this instance — exactly like the closures they replace. */
export class SolvePass {
  constructor(
    readonly ctx: RunContext,
    readonly graph: PoseGraph,
    readonly index: KeyframeIndex,
    readonly attachments: Map<string, Attachment>,
    readonly f: number,
    readonly radius: number,
    readonly residentLabels: LabelMask['labels'],
    readonly voting: VotingRing,
    readonly votingSlot: Map<string, number>,
  ) {}
  resolveTarget = (id: string): string => resolveAttachmentTarget(this.attachments, id);
  canonicalCanvas = (id: string): string => this.resolveTarget(id);
  canonicalPose = (k: Point & { canvasId: string }): Point => {
    const shift = attachmentShift(this.attachments, k.canvasId);
    return { x: k.x + shift.x, y: k.y + shift.y };
  };
  canonical = (id: string): { canvasId: string; dx: number; dy: number } => {
    const shift = attachmentShift(this.attachments, id);
    return { canvasId: this.resolveTarget(id), dx: shift.x, dy: shift.y };
  };
  /** The per-region shell for one frame: applies track.ts's pure decisions in the original order and returns this
   * region's Placement, calling keyframe-step.ts's keyframeStep() for the keyframe/revisit half. Mutates `state`
   * and `this.attachments`/`this.ctx`/`this.index` exactly as the original inline loop body did. */
  async stepRegion(state: RegionState, input: FrameInput): Promise<Placement> {
    const { ctx, index, attachments, f, radius, voting, votingSlot, resolveTarget, canonical } = this;
    const {
      frame,
      image,
      scan,
      current,
      previous,
      g,
      previousGray,
      features,
      native,
      nativePlane,
      nativeFilled,
      markNativeFilled,
      previousPlan,
      voting: votingState,
    } = input;
    const r = state.region,
      code = state.code,
      roi = { x: r.rect.x / f, y: r.rect.y / f, width: r.rect.width / f, height: r.rect.height / f };
    const mask = { labels: this.residentLabels, code };
    const ownFeatures = ownFeaturesOf(features, r, f, image);
    const textured = isTextured(ownFeatures);
    const priorMatches = priorMatchesOf(r.kind, state.previousFeatures, ownFeatures);
    const zoom = computeRegionZoom(r.kind, priorMatches);
    const zoomChange = zoomChanged(zoom, scan.field.zoom);
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
    // 0. Which branch this frame takes before any tracking math runs (track.ts's gate — R1).
    const tag = gate(r.kind, state.started, textured, frame.index, state.blind, zoomChange, !!previous, !!previousGray);
    if (tag === 'start') {
      state.started = true;
      state.canvasId = '';
      await newCanvas(ctx, state, frame.time);
    } else if (tag === 'fixed-init') {
      await newCanvas(ctx, state, frame.time);
    } else if (tag === 'fixed') {
      // No-op: fixed-kind region, already initialised.
    } else if (tag === 'blind') {
      // No canvas origin exists until a textured observation defines one; blank leading frames are counted, not placed.
      decision = 'blind';
    } else if (tag === 'lost') {
      decision = 'lost';
    } else {
      // 1. Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision.
      // gate() only returns 'odometry' when hasPrevious && hasPreviousGray both held, so these are defined here.
      const est = odometry({
        f,
        radius,
        mask,
        roi,
        rect: r.rect,
        region: r,
        image,
        previous: previous!,
        current,
        previousGray: previousGray!,
        g,
        velocity: state.velocity,
        previousFeatures: state.previousFeatures || [],
        ownFeatures,
        confidence,
      });
      decision = est.decision;
      delta = est.delta;
      ambiguous = est.ambiguous;
      weakStep = est.weakStep;
      confidence = est.confidence;
      stepError = est.stepError;
      if (est.contentChange) {
        await ctx.diagnostics.emit({
          code: 'PARTIAL_CONTENT_CHANGE',
          severity: 'info',
          time: frame.time,
          frame: frame.index,
          canvasId: state.canvasId,
          message: `约 ${
            Math.round((1 - est.contentChange.agreement) * 100)
          }% 的纹理区块与整体位移不一致（动画、视频、懒加载或重排）；位移由一致区块决定，冲突区域在合成时单独处理。`,
        });
      }
    }
    // 2. Re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with overlap).
    if (decision === 'lost' && state.anchor && !zoomChange && r.kind === 'moving') {
      const top = reacquire({
        anchorFeatures: state.anchor.features,
        ownFeatures,
        anchorPatches: state.anchor.patches,
        current,
        nativePlane,
        nativeFilled: nativeFilled(),
        markNativeFilled,
        native,
        rect: r.rect,
        f,
        radius,
      });
      if (top) {
        decision = 'tracked';
        viaAnchor = top.n;
        ambiguous = top.ambiguous;
        confidence = top.confidence;
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
          // Intentional TS, not an unported kernel (final-verify-report.md item 14): `.12` gates the call on the
          // frame carrying enough field-level content difference to make a native re-measurement worthwhile; it is
          // the shell's own decision of WHETHER to call `driftCorrection` (see track.ts's header), not tracking math
          // itself, so it stays beside the call it gates rather than moving into the Rust verdict.
          if (state.anchor && scan.field.difference >= .12) {
            const drift = driftCorrection({
              anchor: state.anchor,
              pose: state.pose,
              current,
              nativePlane,
              nativeFilled: nativeFilled(),
              markNativeFilled,
              native,
              rect: r.rect,
              radius,
              confidence,
            });
            if (drift) {
              state.pose = drift.pose;
              confidence = drift.confidence;
            }
          }
        }
        uncertain = uncertainty(confidence, ambiguous, weakStep);
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
        confidence = STATIC_CONFIDENCE;
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
        confidence = BLIND_CONFIDENCE;
        uncertain = true;
        state.velocity = { x: 0, y: 0 };
        await ctx.diagnostics.emit({
          code: 'UNOBSERVABLE_FRAME',
          severity: 'warning',
          time: frame.time,
          frame: frame.index,
          canvasId: state.canvasId || undefined,
          message: '这一帧在该区域没有可辨认纹理：空白帧既可能是暂停，也可能是在空白区域移动，像素本身无法区分。它不会被画到任何位置。',
          action: '若空白之后的内容无法与之前的观察重叠，将保留为独立片段，而不是猜测中间距离。',
        });
      } else {
        lost = true;
        const match = await index.find({
          features: ownFeatures,
          gray: g,
          native,
          current,
          nativePlane,
          nativeFilled: nativeFilled(),
          markNativeFilled,
          layer: r.id,
          frame: frame.index,
          roi,
          region: r.rect,
          factor: f,
          radius,
          exclude: state.anchor?.id,
          canonical,
        });
        if (match && relocalizeVerdict(match, zoomChange)) {
          state.canvasId = resolveTarget(match.keyframe.canvasId);
          const shift = attachmentShift(attachments, match.keyframe.canvasId);
          state.pose = targetPose(match.keyframe, match.offset, shift);
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
          const scale = fragmentCause(zoomChange, scan.field.zoom, previousGray, state.blind, g, ownFeatures, roi);
          state.fragment++;
          state.pose = { x: 0, y: 0 };
          state.lastNode = undefined;
          state.anchor = undefined;
          state.velocity = { x: 0, y: 0 };
          await newCanvas(ctx, state, frame.time);
          confidence = FRAGMENT_CONFIDENCE;
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
      confidence = NONFINITE_CONFIDENCE;
      uncertain = true;
      await newCanvas(ctx, state, frame.time);
    }
    await keyframeStep(this, state, {
      frame,
      scan,
      g,
      r,
      roi,
      ownFeatures,
      native,
      current,
      nativePlane,
      nativeFilled,
      markNativeFilled,
      lost,
      skip,
      relocalized,
      weakStep,
      stepError,
    });
    // Displacement-spread consistency voting against the ring (see the block comment above `states` in solve.ts):
    // done with this frame's FINAL pose/canvasId for this region, after every branch above that could still move it
    // (attachment, thin-overlap correction, NONFINITE_POSE recovery).
    if (r.kind === 'moving' && !skip) {
      voting.observe(votingSlot.get(r.id)!, state.canvasId, state.pose, g, votingState.uploaded);
      votingState.uploaded = true;
      votingState.observed = true;
    }
    const occlusions = previous && occlusionEligible(!!previous, r.kind, decision)
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
    const placement: Placement = {
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
    };
    if (r.kind === 'moving') {
      state.blind = !textured;
      state.weak = decision === 'tracked' ? weakStep : false;
    }
    state.previousFeatures = ownFeatures;
    return placement;
  }
}
