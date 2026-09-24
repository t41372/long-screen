/** FROZEN TypeScript oracle for the solve pass's per-region tracking decisions and keyframe scoring, as they ran
 * before the port to rust/core/src/track.rs. Verbatim copy of src/pipeline/solve/track.ts plus
 * KeyframeIndex.evaluateCandidates from src/core/keyframes.ts, frozen at the commit that ported them to Rust.
 * Parity oracle for tests/unit/parity/track.test.ts. Not used by production code. Do not "fix" this — if the
 * production algorithm changes, that is a behaviour change and belongs in its own commit, not a silent edit here. */
import type { Feature, Gray, Match, Point, Region, RGBA } from '../../../src/types.ts';
import { auditTranslation, detectScale, probeScale, translationHypotheses } from './motion.ts';
// refineNative/refinePatches: NOT re-frozen here. Both this oracle and its own callers (track.ts's resident-plane
// fast path) need to accept `ResidentFrame`/`ResidentGray`, which the plain-`Gray`/`RGBA` frozen `./motion.ts`
// copies do not model; called live through `core()` (both are one-call Rust kernels, not TS algorithm code),
// whose own parity is covered separately (tests/unit/parity/motion.test.ts).
import type { NativeRefinement, Patch } from '../../../src/core/motion.ts';
import { referenceRegionContains as regionContains } from './layers.ts';
import { matchFeatures } from './kernels.ts';
import { core, type LabelMask, type ResidentFrame, type ResidentGray } from '../../../src/core/wasm.ts';
import type { Keyframe, Relocalization } from '../../../src/core/keyframes.ts';
/** Region-step.ts's own-features/texture/prior-matches setup (was inline decision logic in the shell). */
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
  return confidence < .60 || ambiguous || weakStep;
}
/** Confidence assigned on branches with no measurement to derive one from (named so the value has one home). */
export const STATIC_CONFIDENCE = .3;
export const BLIND_CONFIDENCE = 0;
export const FRAGMENT_CONFIDENCE = .20;
export const NONFINITE_CONFIDENCE = 0;
export function relocalizeVerdict(
  match: { ambiguous: boolean; confidence: number } | undefined,
  zoomChange: boolean,
): boolean {
  return !!match && !match.ambiguous && match.confidence > .6 && !zoomChange;
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
  if (zoomChange) {
    return { scale: fieldZoom, error: 0 };
  }
  return previousGray && !blind ? probeScale(previousGray, g, ownFeatures, roi) : undefined;
}
export function occlusionEligible(hasPrevious: boolean, kind: Region['kind'], decision: 'tracked' | 'static' | 'blind' | 'lost'): boolean {
  return hasPrevious && kind === 'moving' && (decision === 'tracked' || decision === 'static');
}
/** A frame-global zoom gate fires for every pane at once, so one pane's pinch fragments every other pane too.
 * Measure this pane's own scale evidence against its own previous frame instead; fall back to the frame-global
 * diagnostic value only when there is too little of this pane's own history to judge from.
 * detectScale() itself returns exactly 1 (indistinguishable from "no zoom") once it has fewer than 8 unique
 * matches to work with; gating on that same threshold here (not on the raw previous-frame feature count, which
 * says nothing about how many of THIS pair's matches were usable) is what makes the "undefined" branch — the
 * frame-global fallback — reachable at all. */
export function regionZoom(kind: Region['kind'], priorMatches: Match[]): number | undefined {
  return kind === 'moving' && priorMatches.filter((m) => m.unique).length >= 8 ? detectScale(priorMatches) : undefined;
}
export function zoomChanged(regionZoom: number | undefined, fieldZoom: number): boolean {
  return regionZoom !== undefined ? Math.abs(regionZoom - 1) > .04 : Math.abs(fieldZoom - 1) > .04;
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
  matches: Match[];
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
/** Step 1: frame-to-frame odometry — analysis-scale hypotheses, block-aware audit, then a native-pixel decision. */
export function odometry(inputs: OdometryInputs): OdometryEstimate {
  const { f, radius, mask, roi, rect, region: r, image, previous, current, previousGray, g, velocity, matches } = inputs;
  const models = translationHypotheses(matches, 16).filter((m) => m.support >= 4);
  // Period-aliased hypotheses on repeated content audit equally well; the constant-velocity prior orders them before the
  // native decision so the true small step is never dropped in favour of a one-row-off alias with more (arbitrary) matches.
  const prior = (m: Point) => .02 * Math.hypot(m.x * f - velocity.x, m.y * f - velocity.y);
  const scored = models.map((m) => ({ m, audit: auditTranslation(previousGray, g, m.x, m.y, roi, f > 1) }))
    .filter((v) =>
      v.audit.overlap > .10 && Number.isFinite(v.audit.error) &&
      ((v.audit.error < 14 && v.audit.mismatch < .2) ||
        (v.audit.agreement >= .4 && v.audit.agreeing >= 3 && v.audit.agreeingError < 8))
    )
    .sort((a, b) =>
      Math.min(a.audit.error, a.audit.agreeingError) + prior(a.m) - Math.min(b.audit.error, b.audit.agreeingError) - prior(b.m)
    );
  const refined = scored.slice(0, 6).map((v) => {
    const n = core().refineNative(previous, current, { x: v.m.x * f, y: v.m.y * f }, rect, mask, radius);
    return { ...v, n, key: n.error + .02 * Math.hypot(n.x - velocity.x, n.y - velocity.y) };
  }).filter((v) => Number.isFinite(v.n.error)).sort((a, b) => a.key - b.key);
  const best = refined[0];
  if (best && best.n.error < 14) {
    const delta = { x: best.n.x, y: best.n.y };
    const rival = refined.find((v) => v !== best && Math.hypot(v.n.x - best.n.x, v.n.y - best.n.y) > 2 && v.n.error < best.n.error + 2);
    const ambiguous = !!rival || (best.m.ambiguous && refined.length > 1);
    // A fast jump leaves a thin strip of shared content. Periodic layouts align just as well one period
    // away, so such a step is a best guess to be re-examined by revisit evidence, not a settled fact.
    const weakStep = best.audit.overlap < .25;
    const confidence = Math.max(.05, best.m.confidence) * Math.exp(-best.n.error / 20) * (ambiguous ? .6 : 1) * (weakStep ? .5 : 1);
    const stepError = best.n.error;
    const contentChange = best.audit.agreement < .85 && best.audit.blocks >= 4
      ? { agreement: best.audit.agreement, blocks: best.audit.blocks }
      : undefined;
    return { decision: 'tracked', delta, confidence, ambiguous, weakStep, stepError, contentChange };
  }
  let difference = 0, samples = 0;
  for (let y = Math.ceil(roi.y); y < roi.y + roi.height; y += 7) {
    for (let x = Math.ceil(roi.x); x < roi.x + roi.width; x += 7) {
      if (!regionContains(r, x * f, y * f, image.width, image.height)) {
        continue;
      }
      difference += Math.abs(previousGray.data[y * g.width + x] - g.data[y * g.width + x]);
      samples++;
    }
  }
  const decision = difference / Math.max(1, samples) > 5 ? 'lost' : 'static';
  return { decision, delta: { x: 0, y: 0 }, confidence: inputs.confidence, ambiguous: false, weakStep: false, stepError: Infinity };
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
    n: core().refinePatches(anchorPatches, native(), rect, { x: m.x * f, y: m.y * f }, radius),
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
  const n = core().refinePatches(anchor.patches, native(), rect, expected, radius);
  if (n.error < 12 && n.runnerUp > n.error + 1.5) {
    return { pose: { x: anchor.x + n.x, y: anchor.y + n.y }, confidence: Math.max(confidence, .96 * Math.exp(-n.error / 20)) };
  }
  return undefined;
}
/** Whether this frame mints a new keyframe. `lastNodeFrame` undefined means no node exists yet for this region
 * (replaces an -Infinity sentinel for "no prior node" when computing framesSinceLastNode — with lastNodeFrame
 * itself optional, that branch is short-circuited before the subtraction ever runs). */
export function needsKeyframe(
  kind: Region['kind'],
  anchor: Point | undefined,
  pose: Point,
  lastNodeFrame: number | undefined,
  rect: { width: number; height: number },
  frameIndex: number,
  fieldDifference: number,
): boolean {
  if (lastNodeFrame === undefined) {
    return true;
  }
  if (kind !== 'moving') {
    return false;
  }
  const anchorDistance = anchor ? Math.hypot(pose.x - anchor.x, pose.y - anchor.y) : Infinity;
  const framesSinceLastNode = frameIndex - lastNodeFrame;
  return anchorDistance > Math.max(48, Math.min(rect.width, rect.height) * .30) ||
    (framesSinceLastNode > 90 && fieldDifference > .2);
}
export function targetPose(keyframe: Point, offset: Point, shift: Point): Point {
  return { x: keyframe.x + offset.x + shift.x, y: keyframe.y + offset.y + shift.y };
}
/** Whether a same-canvas revisit found at attachment time (`global`) should be folded onto `canvasId`: the
 * revisit's own canvas differs, the match is unambiguous, and confident enough (was inline in
 * keyframe-step.ts). `resolvedTarget`/`shift` are computed by the caller because they close over the pass's
 * `attachments` map. */
export function attachVerdict(
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number } | undefined,
  resolvedTarget: string,
  canvasId: string,
  shift: Point,
): { target: string; pose: Point } | undefined {
  if (!global || resolvedTarget === canvasId || global.ambiguous || !(global.confidence > .72)) {
    return undefined;
  }
  return { target: resolvedTarget, pose: targetPose(global.keyframe, global.offset, shift) };
}
export function odometryWeight(weakStep: boolean): number {
  return weakStep ? .05 : 1;
}
/** Pose-graph edge weights for the three ways a loop/attachment edge is added (were literal 6/5/4 inline). */
export const LOOP_WEIGHT_CORRECTED = 6;
export const LOOP_WEIGHT_RELINK = 5;
export const LOOP_WEIGHT_CLOSURE = 4;
/** Gate for thinOverlapCorrection, split out so the caller can check it once, before computing canonicalPose
 * — the original had this exact gate duplicated inline in keyframe-step.ts AND inside thinOverlapCorrection
 * itself; this is the single copy. */
export function thinOverlapEligible(weakStep: boolean, weak: boolean, ambiguous: boolean, confidence: number, error: number): boolean {
  return (weakStep || weak) && !ambiguous && confidence > .72 && error < 8;
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
  const target = { x: canonicalKeyframe.x + offset.x, y: canonicalKeyframe.y + offset.y };
  const discrepancy = Math.hypot(target.x - pose.x, target.y - pose.y);
  return discrepancy >= 16 ? { target, discrepancy } : undefined;
}
export type LoopVerdict = 'closure' | 'inconsistent' | 'ambiguous' | 'none';
/** Whether a revisit on the SAME canvas the frame already resolved to should be folded in as a global position
 * constraint (a loop edge), rejected as conflicting with the continuous trajectory, or left unresolved because
 * the historical match itself was ambiguous. Computes the discrepancy itself (was precomputed by the caller). */
export function loopClosureVerdict(
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number },
  shift: Point,
  pose: Point,
): { verdict: LoopVerdict; discrepancy: number } {
  const discrepancy = Math.hypot(
    global.keyframe.x + shift.x + global.offset.x - pose.x,
    global.keyframe.y + shift.y + global.offset.y - pose.y,
  );
  if (!global.ambiguous && global.confidence > .72 && discrepancy < 16) {
    return { verdict: 'closure', discrepancy };
  } else if (discrepancy >= 16) {
    return { verdict: 'inconsistent', discrepancy };
  } else if (global.ambiguous) {
    return { verdict: 'ambiguous', discrepancy };
  }
  return { verdict: 'none', discrepancy };
}
/** Pure candidate evaluation core of KeyframeIndex.find() (src/core/keyframes.ts's evaluateCandidates, frozen
 * verbatim here alongside track.ts since Phase 4 ports it in the same Rust call as the tracking decisions'
 * keyframe scoring). */
export function evaluateCandidates(
  keyframes: Keyframe[],
  q: {
    features: Feature[];
    gray: Gray;
    native: Gray | ResidentGray | (() => Gray | ResidentGray);
    roi: { x: number; y: number; width: number; height: number };
    region: { x: number; y: number; width: number; height: number };
    factor: number;
    radius: number;
  },
  canonical: Map<string, { canvasId: string; dx: number; dy: number }>,
): (Relocalization & { strong: boolean }) | undefined {
  const { features, gray, native, roi, region, factor, radius } = q;
  const results: (Relocalization & { strong: boolean })[] = [];
  for (const k of keyframes) {
    const matches = matchFeatures(k.features, features), models = translationHypotheses(matches, 16);
    for (const m of models.slice(0, 8)) {
      if (m.support < 6) {
        continue;
      }
      // Analysis-scale audit tolerates sub-factor misalignment; the decision is made on native pixels below.
      const audit = auditTranslation(k.gray, gray, m.x, m.y, roi, factor > 1);
      if (audit.overlap < .22 || !Number.isFinite(audit.error) || (audit.mismatch > .12 && audit.agreement < .5)) {
        continue;
      }
      const refined = core().refinePatches(k.patches, typeof native === 'function' ? native() : native, region, {
        x: m.x * factor,
        y: m.y * factor,
      }, radius);
      if (!Number.isFinite(refined.error) || refined.error > 12) {
        continue;
      }
      const strong = m.support >= 10 && m.unique >= 6 && m.confidence >= .45;
      const confidence = Math.min(.95, .45 + .5 * (1 - Math.exp(-m.unique / 7))) * Math.exp(-refined.error / 20);
      results.push({
        keyframe: k,
        offset: { x: refined.x, y: refined.y },
        confidence,
        ambiguous: m.ambiguous,
        support: m.support,
        unique: m.unique,
        error: refined.error,
        analysisError: audit.error,
        strong,
      });
    }
  }
  const score = (r: Relocalization) => (r.support * .25 + r.unique) * r.confidence;
  results.sort((a, b) => score(b) - score(a));
  const best = results.find((r) => r.strong);
  if (!best) {
    return undefined;
  }
  const position = (r: Relocalization) => {
    const x = r.keyframe.x + r.offset.x, y = r.keyframe.y + r.offset.y;
    const c = canonical.get(r.keyframe.canvasId);
    return c ? { canvas: c.canvasId, x: x + c.dx, y: y + c.dy } : { canvas: r.keyframe.canvasId, x, y };
  };
  const bp = position(best);
  // Any other plausible place, weak or strong, that lands somewhere else makes the revisit ambiguous. Repeated cards look alike.
  const rival = results.find((r) =>
    r !== best && (position(r).canvas !== bp.canvas || Math.hypot(position(r).x - bp.x, position(r).y - bp.y) > 6) &&
    score(r) > score(best) * .8
  );
  if (rival || best.ambiguous) {
    best.ambiguous = true;
  }
  return best;
}
