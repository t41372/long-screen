// MOSTLY PORTED (Rust — see docs/history/2026-09-rust-migration-log.md "已在 Rust 核心中"): the per-region tracking
// DECISIONS region-step.ts's stepRegion() and keyframe-step.ts's keyframeStep() apply each frame. R4b phase 3a
// ported every stateless verdict (uncertainty, relocalizeVerdict, fragmentCause's gate, occlusionEligible,
// attachVerdict, odometryWeight, thinOverlapEligible/Correction, loopClosureVerdict, needsKeyframe, zoomChanged,
// regionZoom, targetPose) to rust/core/src/track.rs; each is now a thin call into src/core/wasm/track.ts,
// exported under its original name/signature so region-step.ts/keyframe-step.ts need no changes. R4c 3b-i fused
// odometry the same way; R4c 3b-ii fused reacquire and driftCorrection (native luma filled lazily, core-side) —
// a stateful cross-frame tracker handle was measured and NOT built (no measurable gain over these per-call
// fusions). Keyframe candidate scoring's own pure core, evaluateCandidates, is a separate module
// (src/core/keyframes.ts, bound through src/core/wasm/track.ts too) — R4d step 4 ported it the same way. Every
// `Math.exp` these functions' TS halves still finish (driftCorrection's/reacquire's/odometry's confidence
// multiply) is a deliberate bit-exactness choice, not unported logic — see each one's own WHY comment.
// STILL TS below (not this round's job — see spec-r4d): isTextured/priorMatchesOf (R1: named so the shell's own
// inline setup has one home; priorMatchesOf is match glue over an already-Rust kernel (matchFeatures), isTextured
// is a bare `.length >= 8`) and gate() (a six-way branch with no native/patch/feature work of its own — the
// shell's dispatch, not tracking math). ownFeaturesOf used to filter through a TS `regionContains` copy too; R6-B
// moved that filter into Rust (final-verify-report.md item 13 — `rust/core/src/region.rs::filter_features`, bound
// through `core().filterFeatures`), so this function is now a thin call, kept here (not inlined at its one call
// site in region-step.ts) because it is still this shell's own per-region setup, not tracking math. This split
// (R1/R2) is why tests/support/reference/track.ts could freeze the pre-port functions' outputs as a TS oracle
// (tests/unit/parity/track.test.ts checks the Rust replacements against it).
import type { Feature, Gray, Match, Point, Region, RGBA } from '../../types.ts';
import type { NativeRefinement, Patch } from '../../core/motion.ts';
import { core, type LabelMask, type ResidentFrame, type ResidentGray } from '../../core/wasm.ts';
/** Region-step.ts's own-features/texture/prior-matches setup (R1: was inline decision logic in the shell). */
export function ownFeaturesOf(
  features: Feature[],
  r: Region,
  f: number,
  image: { width: number; height: number },
): Feature[] {
  return core().filterFeatures(features, r, f, image.width, image.height);
}
export function isTextured(ownFeatures: Feature[]): boolean {
  return ownFeatures.length >= 8;
}
export function priorMatchesOf(kind: Region['kind'], previousFeatures: Feature[] | undefined, ownFeatures: Feature[]): Match[] {
  return kind === 'moving' ? core().matchFeatures(previousFeatures || [], ownFeatures, true) : [];
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
      return core().probeScale(previousGray!, g, ownFeatures, roi);
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
  current: RGBA | ResidentFrame;
  /** The shared per-frame resident native-luma plane (`solve.ts`'s `nativePlane`), when `current` is resident —
   * undefined for the rare geometry-mismatch fallback, where `native` below still does the JS-side conversion,
   * unfused (R4c 3b-ii does not port that rare path; see `src/core/wasm/track.ts::resolveNative`'s doc comment). */
  nativePlane: ResidentGray | undefined;
  /** Whether `nativePlane` already holds this frame's luma (`native()`'s own per-frame memo — see
   * `region-step.ts`'s `FrameInput.nativeFilled`). */
  nativeFilled: boolean;
  markNativeFilled: () => void;
  /** Lazy, as in the original: only evaluated once `models.slice(0, 4)` actually has a candidate to refine — for
   * the resident branch, this now happens core-side (see `nativePlane`'s doc comment); this thunk is only
   * called (eagerly) for the non-resident fallback. */
  native: () => Gray | ResidentGray;
  rect: { x: number; y: number; width: number; height: number };
  f: number;
  radius: number;
}
/** Step 2: re-acquire the anchor on native patches after blind frames or a failed odometry step (short blank
 * gaps with overlap) — fused into one Rust call (R4c 3b-ii): `matchFeatures` + `translationHypotheses` (no
 * native luma needed), then, only if that found a candidate, the native-plane lazy fill and up to 4 patch
 * refinements + rival rejection. */
export function reacquire(inputs: ReacquireInputs): { n: NativeRefinement; ambiguous: boolean; confidence: number } | undefined {
  const { markNativeFilled, ...rest } = inputs;
  const { result, filledNative } = core().trackReacquire(rest);
  if (filledNative) markNativeFilled();
  return result;
}
export interface DriftCorrectionInputs {
  anchor: { x: number; y: number; patches: Patch[] };
  pose: Point;
  current: RGBA | ResidentFrame;
  /** See `ReacquireInputs`'s field of the same name — `driftCorrection` has no gate, so the resident branch's
   * lazy fill always runs (if not already filled this frame) rather than being conditional on a candidate. */
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  markNativeFilled: () => void;
  native: () => Gray | ResidentGray;
  rect: { x: number; y: number; width: number; height: number };
  radius: number;
  confidence: number;
}
/** Drift control: re-measure the pose against the anchor keyframe's native patches whenever they are still in
 * view — fused into one Rust call (R4c 3b-ii). */
export function driftCorrection(inputs: DriftCorrectionInputs): { pose: Point; confidence: number } | undefined {
  const { markNativeFilled, confidence, ...rest } = inputs;
  const { pose, error, filledNative } = core().trackDriftCorrection(rest);
  if (filledNative) markNativeFilled();
  if (!pose) return undefined;
  // Math.exp finished in TS on the host's own implementation — see src/core/wasm/track.ts's WHY comment at
  // OdometryEstimate's confidence field (same bit-exactness reason).
  return { pose, confidence: Math.max(confidence, .96 * Math.exp(-error / 20)) };
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
