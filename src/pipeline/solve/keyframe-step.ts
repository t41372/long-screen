// The keyframe/revisit half of region-step.ts's per-region shell, split out because the combined shell exceeded
// ~350 lines (see solve/solve.ts's module-map comment). Decides whether this frame mints a new keyframe for the
// region and, if so, runs the revisit search, fragment-attachment, thin-overlap trajectory correction and
// loop-closure bookkeeping that a new keyframe triggers — applying track.ts's pure decisions in the original
// order. Not an algorithm awaiting a Rust port itself; see track.ts's header for what is.
import type { Attachment, CanvasMeta, Feature, Gray, Point, Region, ScanRecord } from '../../types.ts';
import { extractPatches } from '../../core/motion.ts';
import type { Keyframe, KeyframeIndex } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import type { ResidentGray } from '../../core/wasm.ts';
import { attachmentShift } from '../attachments.ts';
import type { RegionState } from './state.ts';
import {
  attachVerdict,
  LOOP_WEIGHT_CLOSURE,
  LOOP_WEIGHT_CORRECTED,
  LOOP_WEIGHT_RELINK,
  loopClosureVerdict,
  needsKeyframe,
  odometryWeight,
  thinOverlapCorrection,
  thinOverlapEligible,
} from './track.ts';
import type { SolvePass } from './region-step.ts';
/** Everything keyframeStep() needs beyond `pass` and `state`: this frame's shared inputs plus the three values
 * odometry/reacquire (region-step.ts's earlier two steps) already decided for this region this frame. */
export interface KeyframeStepInput {
  frame: { index: number; time: number };
  scan: ScanRecord;
  g: Gray;
  r: Region;
  roi: { x: number; y: number; width: number; height: number };
  ownFeatures: Feature[];
  native: () => Gray | ResidentGray;
  lost: boolean;
  skip: boolean;
  relocalized: boolean;
  weakStep: boolean;
  stepError: number;
}
/** Mints a keyframe for this region's current pose when needsKeyframe() says one is due, running the revisit
 * search, attachment, thin-overlap correction and loop-closure bookkeeping that a new keyframe triggers. Mutates
 * `state` (canvasId, pose, lastNode, anchor, velocity, weak) and `pass.attachments`/`pass.ctx`/`pass.graph`/
 * `pass.index` exactly as the original inline loop body did. */
export async function keyframeStep(pass: SolvePass, state: RegionState, input: KeyframeStepInput): Promise<void> {
  const { ctx, graph, index, attachments, f, radius, resolveTarget, canonicalCanvas, canonicalPose, canonical } = pass;
  const { frame, scan, g, r, roi, ownFeatures, native, lost, skip, relocalized, weakStep, stepError } = input;
  if (skip) {
    return;
  }
  const needsKey = needsKeyframe(r.kind, state.anchor, state.pose, state.lastNode?.frame, r.rect, frame.index, scan.field.difference);
  if (!needsKey) {
    return;
  }
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
  const verdict = global
    ? attachVerdict(global, resolveTarget(global.keyframe.canvasId), state.canvasId, attachmentShift(attachments, global.keyframe.canvasId))
    : undefined;
  if (verdict) {
    const { target, pose } = verdict;
    const attachment: Attachment = {
      id: state.canvasId,
      target,
      dx: pose.x - state.pose.x,
      dy: pose.y - state.pose.y,
      frame: frame.index,
      confidence: global!.confidence,
      node: global!.keyframe.node,
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
      confidence: global!.confidence,
      detail: attachment,
      message: '回访证据把一个独立片段整体接回了已有画布；片段内的相对轨迹保持不变。',
    });
    attachedFrom = state.canvasId;
    attachMatch = global;
    state.canvasId = target;
    state.pose = pose;
    state.lastNode = undefined;
    state.velocity = { x: 0, y: 0 };
  }
  // Decide a thin-overlap correction before the node exists, so the odometry edge records the corrected
  // geometry and a weight that matches how little evidence the step actually had.
  let corrected: Point | undefined, edgeWeight = odometryWeight(weakStep), correctedShift: Point | undefined;
  // thinOverlapEligible() (track.ts) gates once here so canonicalPose — a translation the correction only needs
  // once that gate passes — is not computed on every keyframe (6f838af engine.ts ~1413-1418 computed it inside
  // the same combined `if`; region-step.ts's split moved the resolveTarget half out into this shell, but the
  // rest of the gate belongs with it too).
  if (
    global && !attachedFrom && resolveTarget(global.keyframe.canvasId) === state.canvasId &&
    thinOverlapEligible(weakStep, state.weak, global.ambiguous, global.confidence, global.error)
  ) {
    // The keyframe used for this correction may itself sit on a fragment attached onto state.canvasId;
    // its raw x/y must be translated into state.canvasId's coordinates before comparing to state.pose.
    const kp = canonicalPose(global.keyframe);
    const correction = thinOverlapCorrection({
      canonicalKeyframe: kp,
      offset: global.offset,
      pose: state.pose,
    });
    if (correction) {
      corrected = correction.target;
      correctedShift = attachmentShift(attachments, global.keyframe.canvasId);
      edgeWeight = .05;
      await ctx.diagnostics.emit({
        code: 'TRAJECTORY_CORRECTED',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        canvasId: state.canvasId,
        confidence: global.confidence,
        detail: {
          discrepancy: correction.discrepancy,
          from: { x: state.pose.x, y: state.pose.y },
          to: correction.target,
          revisitError: global.error,
          stepError,
          weakStep,
        },
        message: `上一步只有很小的重叠，本帧与已观察内容的匹配相差 ${
          correction.discrepancy.toFixed(1)
        }px 且证据更强；已按这一匹配改正当前位置。`,
        action: '被改正的是本帧及之后的轨迹；此前写入的像素保持原样，可能与改正后的坐标存在接缝。',
      });
      state.pose = corrected;
      state.weak = false;
    }
  }
  const node = await graph.add(state.canvasId, frame.index, state.pose, state.lastNode, edgeWeight);
  if (corrected) {
    await graph.connect(
      global!.keyframe.node,
      node.id,
      global!.offset.x + correctedShift!.x,
      global!.offset.y + correctedShift!.y,
      LOOP_WEIGHT_CORRECTED,
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
    await graph.connect(link.node, node.id, state.pose.x - link.x, state.pose.y - link.y, LOOP_WEIGHT_RELINK, 'loop');
  } else if (global && canonicalCanvas(global.keyframe.canvasId) === state.canvasId) {
    const linkShift = attachmentShift(attachments, global.keyframe.canvasId);
    const loopVerdict = loopClosureVerdict(global, linkShift, state.pose);
    const discrepancy = loopVerdict.discrepancy;
    if (loopVerdict.verdict === 'closure') {
      await graph.connect(
        global.keyframe.node,
        node.id,
        global.offset.x + linkShift.x,
        global.offset.y + linkShift.y,
        LOOP_WEIGHT_CLOSURE,
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
    } else if (loopVerdict.verdict === 'inconsistent') {
      await ctx.diagnostics.emit({
        code: 'INCONSISTENT_LOOP_REJECTED',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        canvasId: state.canvasId,
        message: `历史匹配与连续轨迹相差 ${discrepancy.toFixed(1)}px；证据冲突，未强加为回环。`,
        confidence: global.confidence,
      });
    } else if (loopVerdict.verdict === 'ambiguous') {
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
    patches: r.kind === 'moving' ? extractPatches(native(), r.rect, ownFeatures.map((p) => ({ x: p.x - roi.x, y: p.y - roi.y })), f) : [],
  };
  state.anchor = k;
  if (r.kind === 'moving') {
    await index.add(k);
  }
}
