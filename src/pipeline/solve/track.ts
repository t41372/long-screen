// PARTIALLY PORTED (Rust — see docs/HANDOFF.md "已在 Rust 核心中"): the per-region tracking DECISIONS
// region-step.ts's stepRegion() and keyframe-step.ts's keyframeStep() apply each frame. R4b phase 3a ported every
// stateless verdict below (uncertainty, relocalizeVerdict, fragmentCause's gate, occlusionEligible, attachVerdict,
// odometryWeight, thinOverlapEligible/Correction, loopClosureVerdict, needsKeyframe, zoomChanged, regionZoom,
// targetPose) to rust/core/src/track.rs; each function here is now a thin call into src/core/wasm/track.ts,
// exported under its original name/signature so region-step.ts/keyframe-step.ts need no changes. R4c 3b-i fused
// odometry (matchFeatures + translationHypotheses + the audit filter/sort + native refinements + rival detection
// + confidence + the static/lost difference sample) into one more such call. reacquire and driftCorrection
// (below) are still TS pending phase 3b-ii's stateful tracker handle. This split (R1/R2, plus keyframe scoring's
// own pure core, evaluateCandidates, in src/core/keyframes.ts) is why tests/support/reference/track.ts could
// freeze the pre-port functions' outputs as a TS oracle (tests/unit/parity/track.test.ts checks the Rust
// replacements against it).
import type { Feature, Gray, Match, Point, Region, RGBA } from '../../types.ts';
import { type NativeRefinement, type Patch, probeScale, refinePatches, translationHypotheses } from '../../core/motion.ts';
import { regionContains } from '../../core/layers.ts';
import { matchFeatures } from '../../core/features.ts';
import { core, type LabelMask, type ResidentFrame, type ResidentGray } from '../../core/wasm.ts';
/** Region-step.ts's own-features/texture/prior-matches setup (R1: was inline decision logic in the shell). */
export function ownFeaturesOf(
  features: Feature[],
  r: Region,
  f: number,
  image: { width: number; height: number },
): Feature[] {
  return features.filter((p) => regionContains(r, p.x * f, p.y * f, image.width, image.height));
}
export function isTextured(ownFeatures: Feature[]): boolean {
  return ownFeatures.length >= 8;
}
export function priorMatchesOf(kind: Region['kind'], previousFeatures: Feature[] | undefined, ownFeatures: Feature[]): Match[] {
  return kind === 'moving' ? matchFeatures(previousFeatures || [], ownFeatures) : [];
}
export type GateTag = 'start' | 'fixed-init' | 'fixed' | 'blind' | 'lost' | 'odometry';
/** The branch region-step.ts's stepRegion() takes before any tracking math runs: whether the canvas is only now
 * being founded ('start'), a fixed-kind region's once-per-run init ('fixed-init'/'fixed'), an unobservable frame
 * ('blind'), a frame where odometry cannot even be attempted ('lost'), or a normal odometry step. */
export function gate(
  kind: Region['kind'],
  started: boolean,
  textured: boolean,
  frameIndex: number,
  blind: boolean,
  zoomChange: boolean,
  hasPrevious: boolean,
  hasPreviousGray: boolean,
): GateTag {
  if (kind === 'moving' && !started) {
    return textured ? 'start' : 'blind';
  } else if (kind !== 'moving') {
    return frameIndex === 0 ? 'fixed-init' : 'fixed';
  } else if (!textured) {
    return 'blind';
  } else if (blind || zoomChange || !hasPrevious || !hasPreviousGray) {
    return 'lost';
  }
  return 'odometry';
}
export function uncertainty(confidence: number, ambiguous: boolean, weakStep: boolean): boolean {
  return core().trackUncertainty(confidence, ambiguous, weakStep);
}
/** Confidence assigned on branches with no measurement to derive one from (R1: named so the value has one home). */
export const STATIC_CONFIDENCE = .3;
export const BLIND_CONFIDENCE = 0;
export const FRAGMENT_CONFIDENCE = .20;
export const NONFINITE_CONFIDENCE = 0;
export function relocalizeVerdict(
  match: { ambiguous: boolean; confidence: number } | undefined,
  zoomChange: boolean,
): boolean {
  return core().trackRelocalizeVerdict(match, zoomChange);
}
/** Names the cause of an unplaced fragment: a magnification change is a different pixel grid, not a lost
 * trajectory (checked first); otherwise probe for a scale change against the previous frame when one is available. */
export function fragmentCause(
  zoomChange: boolean,
  fieldZoom: number,
  previousGray: Gray | undefined,
  blind: boolean,
  g: Gray,
  ownFeatures: Feature[],
  roi: { x: number; y: number; width: number; height: number },
): { scale: number; error: number } | undefined {
  switch (core().trackFragmentCauseGate(zoomChange, !!previousGray, blind)) {
    case 'zoom-change':
      return { scale: fieldZoom, error: 0 };
    case 'probe-scale':
      return probeScale(previousGray!, g, ownFeatures, roi);
    default:
      return undefined;
  }
}
export function occlusionEligible(hasPrevious: boolean, kind: Region['kind'], decision: 'tracked' | 'static' | 'blind' | 'lost'): boolean {
  return core().trackOcclusionEligible(hasPrevious, kind === 'moving', decision);
}
/** A frame-global zoom gate fires for every pane at once, so one pane's pinch fragments every other pane too.
 * Measure this pane's own scale evidence against its own previous frame instead; fall back to the frame-global
 * diagnostic value only when there is too little of this pane's own history to judge from.
 * detectScale() itself returns exactly 1 (indistinguishable from "no zoom") once it has fewer than 8 unique
 * matches to work with; gating on that same threshold here (not on the raw previous-frame feature count, which
 * says nothing about how many of THIS pair's matches were usable) is what makes the "undefined" branch — the
 * frame-global fallback — reachable at all. */
export function regionZoom(kind: Region['kind'], priorMatches: Match[]): number | undefined {
  return core().trackRegionZoom(kind === 'moving', priorMatches);
}
export function zoomChanged(regionZoom: number | undefined, fieldZoom: number): boolean {
  return core().trackZoomChanged(regionZoom, fieldZoom);
}
export interface OdometryInputs {
  f: number;
  radius: number;
  mask: LabelMask;
  roi: { x: number; y: number; width: number; height: number };
  rect: { x: number; y: number; width: number; height: number };
  region: Region;
  image: { width: number; height: number };
  previous: RGBA | ResidentFrame;
  current: RGBA | ResidentFrame;
  previousGray: Gray;
  g: Gray;
  velocity: Point;
  previousFeatures: Feature[];
  ownFeatures: Feature[];
  /** confidence carried in from before this call; returned unchanged on the 'static'/'lost' branches, exactly as
   * the original left the outer `confidence` local untouched there. */
  confidence: number;
}
export interface OdometryEstimate {
  decision: 'tracked' | 'static' | 'lost';
  delta: Point;
  confidence: number;
  ambiguous: boolean;
  weakStep: boolean;
  stepError: number;
  contentChange?: { agreement: number; blocks: number };
}
/** Step 1: frame-to-frame odometry — analysis-scale hypotheses, block-aware audit, then a native-pixel decision
 * (R4c 3b-i: `matchFeatures` + `translationHypotheses` + the audit filter/sort + up to 6 native refinements +
 * rival detection + confidence + the static/lost difference sample, fused into one Rust call). */
export function odometry(inputs: OdometryInputs): OdometryEstimate {
  return core().trackOdometry(inputs);
}
export interface ReacquireInputs {
  anchorFeatures: Feature[];
  ownFeatures: Feature[];
  anchorPatches: Patch[];
  /** Lazy, as in the original: only evaluated once `models.slice(0, 4)` actually has a candidate to refine. */
  native: () => Gray | ResidentGray;
  rect: { x: number; y: number; width: number; height: number };
  f: number;
  radius: number;
}
/** Step 2: re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank gaps with overlap). */
export function reacquire(inputs: ReacquireInputs): { n: NativeRefinement; ambiguous: boolean; confidence: number } | undefined {
  const { anchorFeatures, ownFeatures, anchorPatches, native, rect, f, radius } = inputs;
  const matches = matchFeatures(anchorFeatures, ownFeatures), models = translationHypotheses(matches, 8).filter((m) => m.support >= 6);
  const options = models.slice(0, 4).map((m) => ({
    m,
    n: refinePatches(anchorPatches, native(), rect, { x: m.x * f, y: m.y * f }, radius),
  })).filter((v) => v.n.error < 12).sort((a, b) => a.n.error - b.n.error);
  const top = options[0];
  if (top && !options.some((v) => v !== top && Math.hypot(v.n.x - top.n.x, v.n.y - top.n.y) > 2 && v.n.error < top.n.error + 2)) {
    const ambiguous = top.m.ambiguous;
    const confidence = Math.max(.05, top.m.confidence) * Math.exp(-top.n.error / 20) * (ambiguous ? .6 : 1);
    return { n: top.n, ambiguous, confidence };
  }
  return undefined;
}
export interface DriftCorrectionInputs {
  anchor: { x: number; y: number; patches: Patch[] };
  pose: Point;
  native: () => Gray | ResidentGray;
  rect: { x: number; y: number; width: number; height: number };
  radius: number;
  confidence: number;
}
/** Drift control: re-measure the pose against the anchor keyframe's native patches whenever they are still in view. */
export function driftCorrection(inputs: DriftCorrectionInputs): { pose: Point; confidence: number } | undefined {
  const { anchor, pose, native, rect, radius, confidence } = inputs;
  const expected = { x: pose.x - anchor.x, y: pose.y - anchor.y };
  const n = refinePatches(anchor.patches, native(), rect, expected, radius);
  if (n.error < 12 && n.runnerUp > n.error + 1.5) {
    return { pose: { x: anchor.x + n.x, y: anchor.y + n.y }, confidence: Math.max(confidence, .96 * Math.exp(-n.error / 20)) };
  }
  return undefined;
}
/** Whether this frame mints a new keyframe. `lastNodeFrame` undefined means no node exists yet for this region
 * (R2: replaces the -Infinity sentinel the original used for "no prior node" when computing framesSinceLastNode —
 * with lastNodeFrame itself optional, that branch is short-circuited before the subtraction ever runs). */
export function needsKeyframe(
  kind: Region['kind'],
  anchor: Point | undefined,
  pose: Point,
  lastNodeFrame: number | undefined,
  rect: { width: number; height: number },
  frameIndex: number,
  fieldDifference: number,
): boolean {
  return core().trackNeedsKeyframe(kind === 'moving', anchor, pose, lastNodeFrame, rect, frameIndex, fieldDifference);
}
export function targetPose(keyframe: Point, offset: Point, shift: Point): Point {
  return core().trackTargetPose(keyframe, offset, shift);
}
/** Whether a same-canvas revisit found at attachment time (`global`) should be folded onto `canvasId`: the
 * revisit's own canvas differs, the match is unambiguous, and confident enough (R1: was inline in
 * keyframe-step.ts). `resolvedTarget`/`shift` are computed by the caller because they close over the pass's
 * `attachments` map. */
export function attachVerdict(
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number } | undefined,
  resolvedTarget: string,
  canvasId: string,
  shift: Point,
): { target: string; pose: Point } | undefined {
  const pose = core().trackAttachVerdict(global, resolvedTarget === canvasId, shift);
  return pose ? { target: resolvedTarget, pose } : undefined;
}
export function odometryWeight(weakStep: boolean): number {
  return core().trackOdometryWeight(weakStep);
}
/** Pose-graph edge weights for the three ways a loop/attachment edge is added (R1: were literal 6/5/4 inline). */
export const LOOP_WEIGHT_CORRECTED = 6;
export const LOOP_WEIGHT_RELINK = 5;
export const LOOP_WEIGHT_CLOSURE = 4;
/** Gate for thinOverlapCorrection, split out (R2) so the caller can check it once, before computing canonicalPose
 * — the original had this exact gate duplicated inline in keyframe-step.ts AND inside thinOverlapCorrection
 * itself; this is the single copy. */
export function thinOverlapEligible(weakStep: boolean, weak: boolean, ambiguous: boolean, confidence: number, error: number): boolean {
  return core().trackThinOverlapEligible(weakStep, weak, ambiguous, confidence, error);
}
export interface ThinOverlapInputs {
  canonicalKeyframe: Point;
  offset: Point;
  pose: Point;
}
/** Whether to correct the current step's trajectory against a same-canvas revisit before the pose graph node for
 * this frame exists, so the odometry edge records the corrected geometry and a weight matching how little
 * evidence the step actually had. `undefined` means "no correction" (the discrepancy is not decisive). The
 * caller only invokes this once thinOverlapEligible() has passed and it has already established the revisit did
 * not attach a fragment and resolved to this region's own canvas (the original's `!attachedFrom &&
 * resolveTarget(...) === state.canvasId` guard) — those conditions are not repeated here as inputs. */
export function thinOverlapCorrection(inputs: ThinOverlapInputs): { target: Point; discrepancy: number } | undefined {
  const { canonicalKeyframe, offset, pose } = inputs;
  // The keyframe used for this correction may itself sit on a fragment attached onto the current canvas; its
  // raw x/y must already be translated into that canvas's coordinates (by the caller, via canonicalPose)
  // before comparing to `pose`.
  return core().trackThinOverlapCorrection(canonicalKeyframe, offset, pose);
}
export type LoopVerdict = 'closure' | 'inconsistent' | 'ambiguous' | 'none';
/** Whether a revisit on the SAME canvas the frame already resolved to should be folded in as a global position
 * constraint (a loop edge), rejected as conflicting with the continuous trajectory, or left unresolved because
 * the historical match itself was ambiguous. Computes the discrepancy itself (R2: was precomputed by the caller). */
export function loopClosureVerdict(
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number },
  shift: Point,
  pose: Point,
): { verdict: LoopVerdict; discrepancy: number } {
  return core().trackLoopClosureVerdict(global, shift, pose);
}
