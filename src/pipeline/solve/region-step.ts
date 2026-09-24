// The per-region shell inside solve()'s frame loop: calls track.ts's pure tracking decisions and applies their
// results IN THE ORIGINAL ORDER — diagnostics, KeyframeIndex/PoseGraph I/O, new canvases, voting, occlusion
// detection, placement construction. Not an algorithm awaiting a Rust port itself; see track.ts's header for what
// is.
import type { Attachment, Feature, Gray, Match, Placement, Point, Region, RGBA, ScanRecord } from '../../types.ts';
import { stickyOcclusions } from '../../core/layers.ts';
import type { NativeRefinement } from '../../core/motion.ts';
import type { PoseGraph } from '../../core/pose-graph.ts';
import type { KeyframeIndex } from '../../core/keyframes.ts';
import type { LabelMask, ResidentFrame, ResidentGray, VotingRing } from '../../core/wasm.ts';
import { attachmentShift, resolveTarget as resolveAttachmentTarget } from '../attachments.ts';
import { t } from '../../i18n/index.ts';
import type { RunContext } from '../context.ts';
import { type Decision, newCanvas, type RegionState } from './state.ts';
import {
  BLIND_CONFIDENCE,
  driftCorrection,
  FRAGMENT_CONFIDENCE,
  fragmentCause,
  gate,
  isTextured,
  isValidPose,
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
  /** The shared resident native-luma plane `native()` above also fills, only when `current` is a
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
/** Per-call state for one stepRegion() invocation: the values the original inline body derived once up front
 * (r, code, roi, mask, ownFeatures, textured, priorMatches, zoom, zoomChange) plus the ones it reassigned across
 * branches (confidence, uncertain, relocalized, skip, ambiguous, lost, decision, delta, viaAnchor, weakStep,
 * stepError). Built fresh inside stepRegion() on every call and passed to (and mutated by) the extracted methods
 * below — never promoted to fields on SolvePass, which lives for the whole solve() pass and must not carry one
 * region's frame-local state into the next call. */
interface StepLocals {
  r: Region;
  code: number;
  roi: { x: number; y: number; width: number; height: number };
  mask: { labels: LabelMask['labels']; code: number };
  ownFeatures: Feature[];
  textured: boolean;
  priorMatches: Match[];
  zoom: number | undefined;
  zoomChange: boolean;
  confidence: number;
  uncertain: boolean;
  relocalized: boolean;
  skip: boolean;
  ambiguous: boolean;
  lost: boolean;
  decision: Decision;
  delta: Point;
  viaAnchor: NativeRefinement | undefined;
  weakStep: boolean;
  stepError: number;
}
/** Everything region-step.ts's stepRegion() needs that lives for the whole solve() pass, not just one frame:
 * services, the pose graph and keyframe index, the fragment-attachment map and its three canonicalisation
 * methods (they close over `this.attachments`, which grows during the pass), and the analysis-geometry constants.
 * `resolveTarget`/`canonicalCanvas`/`canonicalPose`/`canonical` are arrow-function fields, not prototype methods,
 * so a bare reference to one (e.g. `const { canonical } = this;`) stays bound to this instance like a closure would. */
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
    const locals = this.setupLocals(state, input);
    // 0. Which branch this frame takes before any tracking math runs (track.ts's gate).
    const tag = gate(
      locals.r.kind,
      state.started,
      locals.textured,
      input.frame.index,
      state.blind,
      locals.zoomChange,
      !!input.previous,
      !!input.previousGray,
    );
    if (tag === 'odometry') {
      // 1. Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision.
      // gate() only returns 'odometry' when hasPrevious && hasPreviousGray both held, so odometryStep can assume them.
      await this.odometryStep(state, input, locals);
    } else {
      await this.gateBranch(tag, state, input, locals);
    }
    // 2. Re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with overlap).
    this.reacquireStep(state, input, locals);
    // 3. Apply the decision.
    if (locals.r.kind === 'moving') {
      if (locals.decision === 'tracked') {
        await this.applyTracked(state, input, locals);
      } else if (locals.decision === 'static') {
        await this.applyStatic(state, input, locals);
      } else if (locals.decision === 'blind') {
        await this.applyBlind(state, input, locals);
      } else {
        await this.applyLost(state, input, locals);
      }
    }
    await this.recoverNonfinitePose(state, input, locals);
    await keyframeStep(this, state, {
      frame: input.frame,
      scan: input.scan,
      g: input.g,
      r: locals.r,
      roi: locals.roi,
      ownFeatures: locals.ownFeatures,
      native: input.native,
      current: input.current,
      nativePlane: input.nativePlane,
      nativeFilled: input.nativeFilled,
      markNativeFilled: input.markNativeFilled,
      lost: locals.lost,
      skip: locals.skip,
      relocalized: locals.relocalized,
      weakStep: locals.weakStep,
      stepError: locals.stepError,
    });
    // keyframeStep can still move state.pose (attachment, thin-overlap correction) after the check above ran.
    // Those two candidates are validated and rejected in place (keyframe-step.ts's applyAttachment/
    // applyThinOverlapCorrection) before they are ever assigned to state.pose or persisted, so this call is
    // defense-in-depth — it only fires if some other path inside keyframeStep reintroduces an invalid pose — and
    // keeps the invariant that finalizePlacement() never sees one.
    await this.recoverNonfinitePose(state, input, locals);
    return this.finalizePlacement(state, input, locals);
  }
  /** Derives this call's read-mostly values (region, roi, mask, own features, zoom state) and the mutable locals
   * (confidence/decision/etc.) at their original starting values, before any branch below can reassign them. */
  private setupLocals(state: RegionState, input: FrameInput): StepLocals {
    const { f } = this;
    const { image, scan, features } = input;
    const r = state.region,
      code = state.code,
      roi = { x: r.rect.x / f, y: r.rect.y / f, width: r.rect.width / f, height: r.rect.height / f };
    const mask = { labels: this.residentLabels, code };
    const ownFeatures = ownFeaturesOf(features, r, f, image);
    const textured = isTextured(ownFeatures);
    const priorMatches = priorMatchesOf(r.kind, state.previousFeatures, ownFeatures);
    const zoom = computeRegionZoom(r.kind, priorMatches);
    const zoomChange = zoomChanged(zoom, scan.field.zoom);
    return {
      r,
      code,
      roi,
      mask,
      ownFeatures,
      textured,
      priorMatches,
      zoom,
      zoomChange,
      confidence: r.unassigned ? .2 : 1,
      uncertain: !!r.unassigned,
      relocalized: false,
      skip: false,
      ambiguous: false,
      lost: false,
      decision: 'tracked',
      delta: { x: 0, y: 0 },
      viaAnchor: undefined,
      weakStep: false,
      stepError: Infinity,
    };
  }
  /** The non-odometry gate() branches: found the canvas ('start'/'fixed-init'), a no-op for an already-initialised
   * fixed region, or set `locals.decision` for a frame the gate already classified as 'blind'/'lost'. */
  private async gateBranch(tag: ReturnType<typeof gate>, state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    if (tag === 'start') {
      state.started = true;
      state.canvasId = '';
      await newCanvas(this.ctx, state, input.frame.time);
    } else if (tag === 'fixed-init') {
      await newCanvas(this.ctx, state, input.frame.time);
    } else if (tag === 'fixed') {
      // No-op: fixed-kind region, already initialised.
    } else if (tag === 'blind') {
      // No canvas origin exists until a textured observation defines one; blank leading frames are counted, not placed.
      locals.decision = 'blind';
    } else if (tag === 'lost') {
      locals.decision = 'lost';
    }
  }
  /** Frame-to-frame odometry: analysis-scale hypotheses, block-aware audit, then a native-pixel decision. Only
   * called when gate() returned 'odometry', so `input.previous`/`input.previousGray` are defined here. */
  private async odometryStep(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    const { f, radius } = this;
    const { frame, image, current, previous, previousGray, g } = input;
    const est = odometry({
      f,
      radius,
      mask: locals.mask,
      roi: locals.roi,
      rect: locals.r.rect,
      region: locals.r,
      image,
      previous: previous!,
      current,
      previousGray: previousGray!,
      g,
      velocity: state.velocity,
      previousFeatures: state.previousFeatures || [],
      ownFeatures: locals.ownFeatures,
      confidence: locals.confidence,
    });
    locals.decision = est.decision;
    locals.delta = est.delta;
    locals.ambiguous = est.ambiguous;
    locals.weakStep = est.weakStep;
    locals.confidence = est.confidence;
    locals.stepError = est.stepError;
    if (est.contentChange) {
      await this.ctx.diagnostics.emit({
        code: 'PARTIAL_CONTENT_CHANGE',
        severity: 'info',
        time: frame.time,
        frame: frame.index,
        canvasId: state.canvasId,
        message: t('diag.PARTIAL_CONTENT_CHANGE.message', { percent: Math.round((1 - est.contentChange.agreement) * 100) }),
      });
    }
  }
  /** Re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with
   * overlap): a successful match promotes `locals.decision` back to 'tracked'. */
  private reacquireStep(state: RegionState, input: FrameInput, locals: StepLocals): void {
    const { f, radius } = this;
    if (!(locals.decision === 'lost' && state.anchor && !locals.zoomChange && locals.r.kind === 'moving')) {
      return;
    }
    const top = reacquire({
      anchorFeatures: state.anchor.features,
      ownFeatures: locals.ownFeatures,
      anchorPatches: state.anchor.patches,
      current: input.current,
      nativePlane: input.nativePlane,
      nativeFilled: input.nativeFilled(),
      markNativeFilled: input.markNativeFilled,
      native: input.native,
      rect: locals.r.rect,
      f,
      radius,
    });
    if (top) {
      locals.decision = 'tracked';
      locals.viaAnchor = top.n;
      locals.ambiguous = top.ambiguous;
      locals.confidence = top.confidence;
    }
  }
  /** decision === 'tracked': advances the pose (via the re-acquired anchor or the odometry delta plus drift
   * correction), then raises the THIN_OVERLAP_STEP/LOW_CONFIDENCE_PLACEMENT diagnostics that depend on the result. */
  private async applyTracked(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    const { radius } = this;
    const { frame, current, previous, nativePlane, nativeFilled, markNativeFilled, native, scan } = input;
    if (locals.viaAnchor) {
      state.pose = { x: state.anchor!.x + locals.viaAnchor.x, y: state.anchor!.y + locals.viaAnchor.y };
      state.velocity = { x: 0, y: 0 };
    } else if (frame.index > 0 && previous) {
      state.pose = { x: state.pose.x + locals.delta.x, y: state.pose.y + locals.delta.y };
      state.velocity = locals.delta;
      // Drift control: re-measure the pose against the anchor keyframe's native patches whenever they are still in view.
      // Intentional TS, not an unported kernel: `.12` gates the call on the frame carrying enough field-level content
      // difference to make a native re-measurement worthwhile; it is the shell's own decision of WHETHER to call
      // `driftCorrection` (see track.ts's header), not tracking math itself, so it stays beside the call it gates
      // rather than moving into the Rust verdict.
      if (state.anchor && scan.field.difference >= .12) {
        const drift = driftCorrection({
          anchor: state.anchor,
          pose: state.pose,
          current,
          nativePlane,
          nativeFilled: nativeFilled(),
          markNativeFilled,
          native,
          rect: locals.r.rect,
          radius,
          confidence: locals.confidence,
        });
        if (drift) {
          state.pose = drift.pose;
          locals.confidence = drift.confidence;
        }
      }
    }
    locals.uncertain = uncertainty(locals.confidence, locals.ambiguous, locals.weakStep);
    if (locals.weakStep) {
      await this.ctx.diagnostics.emit({
        code: 'THIN_OVERLAP_STEP',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        canvasId: state.canvasId,
        confidence: locals.confidence,
        message: t('diag.THIN_OVERLAP_STEP.message'),
        action: t('diag.THIN_OVERLAP_STEP.action'),
      });
    }
    if (locals.uncertain) {
      await this.ctx.diagnostics.emit({
        code: 'LOW_CONFIDENCE_PLACEMENT',
        severity: 'warning',
        time: frame.time,
        frame: frame.index,
        canvasId: state.canvasId,
        confidence: locals.confidence,
        region: {
          x: state.pose.x + locals.r.rect.x,
          y: state.pose.y + locals.r.rect.y,
          width: locals.r.rect.width,
          height: locals.r.rect.height,
        },
        message: locals.ambiguous
          ? t('diag.LOW_CONFIDENCE_PLACEMENT.messageAmbiguous')
          : t('diag.LOW_CONFIDENCE_PLACEMENT.messageLowConfidence'),
        action: t('diag.LOW_CONFIDENCE_PLACEMENT.action'),
      });
    }
  }
  /** decision === 'static': zero velocity, fixed confidence, a LOW_CONFIDENCE_PLACEMENT diagnostic. */
  private async applyStatic(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    const { frame } = input;
    state.velocity = { x: 0, y: 0 };
    locals.confidence = STATIC_CONFIDENCE;
    locals.uncertain = true;
    await this.ctx.diagnostics.emit({
      code: 'LOW_CONFIDENCE_PLACEMENT',
      severity: 'warning',
      time: frame.time,
      frame: frame.index,
      canvasId: state.canvasId,
      confidence: locals.confidence,
      message: t('diag.LOW_CONFIDENCE_PLACEMENT.messageStatic'),
    });
  }
  /** decision === 'blind': skip this observation, fixed confidence, an UNOBSERVABLE_FRAME diagnostic. */
  private async applyBlind(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    const { frame } = input;
    locals.skip = true;
    locals.confidence = BLIND_CONFIDENCE;
    locals.uncertain = true;
    state.velocity = { x: 0, y: 0 };
    await this.ctx.diagnostics.emit({
      code: 'UNOBSERVABLE_FRAME',
      severity: 'warning',
      time: frame.time,
      frame: frame.index,
      canvasId: state.canvasId || undefined,
      message: t('diag.UNOBSERVABLE_FRAME.message'),
      action: t('diag.UNOBSERVABLE_FRAME.action'),
    });
  }
  /** decision === 'lost': a keyframe-index revisit search either relocalises onto an existing canvas
   * (RELOCALIZED) or starts a new unplaced fragment (SCALE_CHANGE_FRAGMENT/UNPLACED_FRAGMENT). */
  private async applyLost(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    const { index, attachments, f, radius, resolveTarget, canonical } = this;
    const { frame, g, native, current, nativePlane, nativeFilled, markNativeFilled, previousGray } = input;
    locals.lost = true;
    const match = await index.find({
      features: locals.ownFeatures,
      gray: g,
      native,
      current,
      nativePlane,
      nativeFilled: nativeFilled(),
      markNativeFilled,
      layer: locals.r.id,
      frame: frame.index,
      roi: locals.roi,
      region: locals.r.rect,
      factor: f,
      radius,
      exclude: state.anchor?.id,
      canonical,
    });
    if (match && relocalizeVerdict(match, locals.zoomChange)) {
      state.canvasId = resolveTarget(match.keyframe.canvasId);
      const shift = attachmentShift(attachments, match.keyframe.canvasId);
      state.pose = targetPose(match.keyframe, match.offset, shift);
      state.lastNode = undefined;
      state.anchor = match.keyframe;
      state.velocity = { x: 0, y: 0 };
      locals.confidence = match.confidence;
      locals.relocalized = true;
      await this.ctx.diagnostics.emit({
        code: 'RELOCALIZED',
        severity: 'info',
        canvasId: state.canvasId,
        time: frame.time,
        frame: frame.index,
        confidence: locals.confidence,
        detail: {
          anchorFrame: match.keyframe.frame,
          support: match.support,
          unique: match.unique,
          error: match.error,
          offset: match.offset,
        },
        message: t('diag.RELOCALIZED.message'),
      });
    } else {
      // Name the cause: a magnification change is a different pixel grid, not a lost trajectory.
      const scale = fragmentCause(locals.zoomChange, input.scan.field.zoom, previousGray, state.blind, g, locals.ownFeatures, locals.roi);
      state.fragment++;
      state.pose = { x: 0, y: 0 };
      state.lastNode = undefined;
      state.anchor = undefined;
      state.velocity = { x: 0, y: 0 };
      await newCanvas(this.ctx, state, frame.time);
      locals.confidence = FRAGMENT_CONFIDENCE;
      locals.uncertain = true;
      await this.ctx.diagnostics.emit({
        code: scale ? 'SCALE_CHANGE_FRAGMENT' : 'UNPLACED_FRAGMENT',
        severity: 'warning',
        canvasId: state.canvasId,
        time: frame.time,
        frame: frame.index,
        confidence: locals.confidence,
        detail: scale,
        message: scale ? t('diag.SCALE_CHANGE_FRAGMENT.message', { scale: scale.scale.toFixed(2) }) : t('diag.UNPLACED_FRAGMENT.message'),
        action: scale ? t('diag.SCALE_CHANGE_FRAGMENT.action') : t('diag.UNPLACED_FRAGMENT.action'),
      });
    }
  }
  /** After the decision is applied: if the pose ended up non-finite or outside the canvas-addressable range (any
   * branch above, keyframeStep's attach/thin-overlap correction, or a pre-existing NaN carried into this call),
   * isolate the observation into a fresh fragment rather than writing invalid coordinates. Called twice per
   * region per frame — before and after keyframeStep() — because keyframeStep can still move state.pose. */
  private async recoverNonfinitePose(state: RegionState, input: FrameInput, locals: StepLocals): Promise<void> {
    if (isValidPose(state.pose)) {
      return;
    }
    const { frame } = input;
    await this.ctx.diagnostics.emit({
      code: 'NONFINITE_POSE',
      severity: 'error',
      time: frame.time,
      frame: frame.index,
      message: t('diag.NONFINITE_POSE.message'),
    });
    state.fragment++;
    state.pose = { x: 0, y: 0 };
    state.lastNode = undefined;
    state.anchor = undefined;
    locals.confidence = NONFINITE_CONFIDENCE;
    locals.uncertain = true;
    await newCanvas(this.ctx, state, frame.time);
  }
  /** Displacement-spread consistency voting, sticky-occlusion detection and the returned Placement: all done with
   * this frame's FINAL pose/canvasId for this region, after every branch above that could still move it
   * (attachment, thin-overlap correction, NONFINITE_POSE recovery). */
  private async finalizePlacement(state: RegionState, input: FrameInput, locals: StepLocals): Promise<Placement> {
    const { voting, votingSlot } = this;
    const { frame, current, previous, g, previousPlan, voting: votingState } = input;
    if (locals.r.kind === 'moving' && !locals.skip) {
      voting.observe(votingSlot.get(locals.r.id)!, state.canvasId, state.pose, g, votingState.uploaded);
      votingState.uploaded = true;
      votingState.observed = true;
    }
    const occlusions = previous && occlusionEligible(!!previous, locals.r.kind, locals.decision)
      ? stickyOcclusions(
        previous,
        current,
        locals.r,
        locals.delta,
        previousPlan?.placements.find((p) => p.layer === locals.r.id && p.canvasId === state.canvasId)?.occlusions,
      )
      : [];
    if (occlusions.length) {
      await this.ctx.diagnostics.emit({
        code: 'STICKY_OCCLUSION',
        severity: 'info',
        frame: frame.index,
        time: frame.time,
        canvasId: state.canvasId,
        region: occlusions[0],
        message: t('diag.STICKY_OCCLUSION.message'),
      });
    }
    const placement: Placement = {
      layer: locals.r.id,
      canvasId: state.canvasId,
      node: state.lastNode?.id || '',
      x: state.pose.x,
      y: state.pose.y,
      confidence: locals.confidence,
      uncertain: locals.uncertain,
      time: frame.time,
      ...(locals.skip ? { skip: true } : {}),
      ...(occlusions.length ? { occlusions } : {}),
    };
    if (locals.r.kind === 'moving') {
      state.blind = !locals.textured;
      state.weak = locals.decision === 'tracked' ? locals.weakStep : false;
    }
    state.previousFeatures = locals.ownFeatures;
    return placement;
  }
}
