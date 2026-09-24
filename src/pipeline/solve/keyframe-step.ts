// The keyframe/revisit half of region-step.ts's per-region shell, split out because the combined shell exceeded
// ~350 lines (see solve/solve.ts's module-map comment). Decides whether this frame mints a new keyframe for the
// region and, if so, runs the revisit search, fragment-attachment, thin-overlap trajectory correction and
// loop-closure bookkeeping that a new keyframe triggers — applying track.ts's pure decisions in the original
// order. Not an algorithm awaiting a Rust port itself; see track.ts's header for what is.
import type { Attachment, CanvasMeta, Feature, Gray, Point, Region, RGBA, ScanRecord } from '../../types.ts';
import type { Keyframe, KeyframeIndex } from '../../core/keyframes.ts';
import { pad } from '../../core/math.ts';
import type { PoseNode } from '../../core/pose-graph.ts';
import { core, type ResidentFrame, type ResidentGray } from '../../core/wasm.ts';
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
/** Per-call state one keyframeStep() invocation threads through its revisit-search/attachment/thin-overlap/
 * graph steps: the revisit match and its derived attach/loop verdicts, whether this canvas got attached onto
 * another this call, and the (possibly corrected) edge weight the new graph node is added with. Built fresh by
 * keyframeStep() every call it doesn't return early from — never fields on SolvePass, whose instance outlives
 * this one call. */
interface KeyframeLocals {
  oldAnchor: Keyframe | undefined;
  global: Awaited<ReturnType<KeyframeIndex['find']>> | undefined;
  attachedFrom: string | undefined;
  attachMatch: Awaited<ReturnType<KeyframeIndex['find']>> | undefined;
  corrected: Point | undefined;
  edgeWeight: number;
  correctedShift: Point | undefined;
}
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
  /** See `region-step.ts`'s `FrameInput` fields of the same name — passed through so this frame's `index.find()`
   * call can use the same lazy resident native-plane fill as odometry/reacquire/driftCorrection. */
  current: RGBA | ResidentFrame;
  nativePlane: ResidentGray | undefined;
  nativeFilled(): boolean;
  markNativeFilled(): void;
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
  if (input.skip) {
    return;
  }
  const { frame, scan, r } = input;
  const needsKey = needsKeyframe(r.kind, state.anchor, state.pose, state.lastNode?.frame, r.rect, frame.index, scan.field.difference);
  if (!needsKey) {
    return;
  }
  const locals: KeyframeLocals = {
    oldAnchor: state.anchor,
    global: undefined,
    attachedFrom: undefined,
    attachMatch: undefined,
    corrected: undefined,
    edgeWeight: odometryWeight(input.weakStep),
    correctedShift: undefined,
  };
  await revisitSearch(pass, input, locals);
  await applyAttachment(pass, state, input, locals);
  await applyThinOverlapCorrection(pass, state, input, locals);
  const node = await pass.graph.add(state.canvasId, frame.index, state.pose, state.lastNode, locals.edgeWeight);
  if (locals.corrected) {
    await pass.graph.connect(
      locals.global!.keyframe.node,
      node.id,
      locals.global!.offset.x + locals.correctedShift!.x,
      locals.global!.offset.y + locals.correctedShift!.y,
      LOOP_WEIGHT_CORRECTED,
      'loop',
    );
  }
  await connectRelinkOrLoopClosure(pass, state, input, locals, node);
  state.lastNode = (await pass.graph.get(node.id))!;
  await mintKeyframe(pass, state, input, node.id);
}
/** Revisit search at every keyframe: same canvas → loop closure; another canvas → this fragment is tied back rigidly. */
async function revisitSearch(pass: SolvePass, input: KeyframeStepInput, locals: KeyframeLocals): Promise<void> {
  const { f, radius, canonical } = pass;
  const { frame, g, r, roi, ownFeatures, native, current, nativePlane, nativeFilled, markNativeFilled, lost, skip } = input;
  locals.global = !lost && !skip && r.kind === 'moving' && frame.index > 3
    ? await pass.index.find({
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
      exclude: locals.oldAnchor?.id,
      canonical,
    })
    : undefined;
}
/** Ties an independent fragment rigidly back onto an existing canvas when the revisit search's global match
 * clears attachVerdict(): records the Attachment row, updates the canvas's attachedTo, emits FRAGMENT_ATTACHED,
 * and re-homes `state` onto the target canvas/pose. */
async function applyAttachment(pass: SolvePass, state: RegionState, input: KeyframeStepInput, locals: KeyframeLocals): Promise<void> {
  const { ctx, attachments, resolveTarget } = pass;
  const { frame } = input;
  const global = locals.global;
  const verdict = global
    ? attachVerdict(global, resolveTarget(global.keyframe.canvasId), state.canvasId, attachmentShift(attachments, global.keyframe.canvasId))
    : undefined;
  if (!verdict) {
    return;
  }
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
  locals.attachedFrom = state.canvasId;
  locals.attachMatch = global;
  state.canvasId = target;
  state.pose = pose;
  state.lastNode = undefined;
  state.velocity = { x: 0, y: 0 };
}
/** Decide a thin-overlap correction before the node exists, so the odometry edge records the corrected geometry
 * and a weight that matches how little evidence the step actually had. thinOverlapEligible() (track.ts) gates
 * once here so canonicalPose — a translation the correction only needs once that gate passes — is not computed
 * on every keyframe. */
async function applyThinOverlapCorrection(
  pass: SolvePass,
  state: RegionState,
  input: KeyframeStepInput,
  locals: KeyframeLocals,
): Promise<void> {
  const { ctx, canonicalPose } = pass;
  const { frame, weakStep, stepError } = input;
  const global = locals.global;
  if (
    !(global && !locals.attachedFrom && pass.resolveTarget(global.keyframe.canvasId) === state.canvasId &&
      thinOverlapEligible(weakStep, state.weak, global.ambiguous, global.confidence, global.error))
  ) {
    return;
  }
  // The keyframe used for this correction may itself sit on a fragment attached onto state.canvasId;
  // its raw x/y must be translated into state.canvasId's coordinates before comparing to state.pose.
  const kp = canonicalPose(global.keyframe);
  const correction = thinOverlapCorrection({
    canonicalKeyframe: kp,
    offset: global.offset,
    pose: state.pose,
  });
  if (!correction) {
    return;
  }
  locals.corrected = correction.target;
  locals.correctedShift = attachmentShift(pass.attachments, global.keyframe.canvasId);
  locals.edgeWeight = .05;
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
  state.pose = locals.corrected;
  state.weak = false;
}
/** The graph edge from this new node back to history: a relink (relocalized-with-an-old-anchor, or this call's
 * own attachment) takes priority; otherwise, on a same-canvas revisit, loopClosureVerdict() decides between a
 * loop-closure edge (LOOP_CLOSURE), a rejected conflict (INCONSISTENT_LOOP_REJECTED) or an unresolved ambiguous
 * match (AMBIGUOUS_LOOP). */
async function connectRelinkOrLoopClosure(
  pass: SolvePass,
  state: RegionState,
  input: KeyframeStepInput,
  locals: KeyframeLocals,
  node: PoseNode,
): Promise<void> {
  const { ctx, graph, attachments, canonicalCanvas } = pass;
  const { frame, relocalized } = input;
  const global = locals.global;
  if ((relocalized && locals.oldAnchor) || locals.attachedFrom) {
    node.pinned = false;
    await ctx.store.put(`node/${node.id}`, node);
    const link = locals.attachMatch ? locals.attachMatch.keyframe : locals.oldAnchor!;
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
}
/** Builds this frame's Keyframe row (with native patches for a moving region) and posts it as `state`'s new
 * anchor, registering it with the keyframe index for future revisit search. */
async function mintKeyframe(pass: SolvePass, state: RegionState, input: KeyframeStepInput, nodeId: string): Promise<void> {
  const { f } = pass;
  const { frame, g, r, roi, ownFeatures, native } = input;
  const k: Keyframe = {
    id: `${r.id}/${pad(frame.index)}`,
    node: nodeId,
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
      ? core().extractPatches(native(), r.rect, ownFeatures.map((p) => ({ x: p.x - roi.x, y: p.y - roi.y })), f)
      : [],
  };
  state.anchor = k;
  if (r.kind === 'moving') {
    await pass.index.add(k);
  }
}
