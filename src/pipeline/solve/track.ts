// ALGORITHM-AWAITING-PORT (Rust, next round — see docs/HANDOFF.md "已在 Rust 核心中"): the per-region tracking
// DECISIONS region-step.ts's stepRegion() applies each frame. Every function here is a pure algorithm over plain
// inputs (features, grays, native frames, rects, poses, thresholds) — no ctx, no store, no diagnostics emission,
// no state mutation. It returns a plain result object; the shell (region-step.ts) applies it, in the original
// order, and is responsible for any diagnostics or storage the result implies. This split exists so the next
// round can freeze these functions' outputs as a TS oracle and re-implement them behind one Rust FFI call per
// region per frame (fusing ~20 crossings into one), without also having to disentangle them from storage/graph/
// diagnostics side effects at the same time.
import type { Feature, Gray, Match, Point, Region, RGBA } from '../../types.ts';
import {
  auditTranslation,
  detectScale,
  type NativeRefinement,
  type Patch,
  refineNative,
  refinePatches,
  translationHypotheses,
} from '../../core/motion.ts';
import { regionContains } from '../../core/layers.ts';
import { matchFeatures } from '../../core/features.ts';
import type { LabelMask, ResidentFrame, ResidentGray } from '../../core/wasm.ts';
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
    const n = refineNative(previous, current, { x: v.m.x * f, y: v.m.y * f }, rect, mask, radius);
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
export function needsKeyframe(
  kind: Region['kind'],
  hasLastNode: boolean,
  anchorDistance: number,
  rect: { width: number; height: number },
  framesSinceLastNode: number,
  fieldDifference: number,
): boolean {
  return !hasLastNode ||
    kind === 'moving' &&
      (anchorDistance > Math.max(48, Math.min(rect.width, rect.height) * .30) ||
        (framesSinceLastNode > 90 && fieldDifference > .2));
}
export function targetPose(keyframe: Point, offset: Point, shift: Point): Point {
  return { x: keyframe.x + offset.x + shift.x, y: keyframe.y + offset.y + shift.y };
}
export interface ThinOverlapInputs {
  weakStep: boolean;
  weak: boolean;
  ambiguous: boolean;
  confidence: number;
  error: number;
  canonicalKeyframe: Point;
  offset: Point;
  pose: Point;
}
/** Whether to correct the current step's trajectory against a same-canvas revisit before the pose graph node for
 * this frame exists, so the odometry edge records the corrected geometry and a weight matching how little
 * evidence the step actually had. `undefined` means "no correction" (the discrepancy is not decisive, or the
 * gates below are not met). The caller only invokes this once it has already established the revisit did not
 * attach a fragment and resolved to this region's own canvas (the original's `!attachedFrom &&
 * resolveTarget(...) === state.canvasId` guard) — those two conditions are not repeated here as inputs. */
export function thinOverlapCorrection(inputs: ThinOverlapInputs): { target: Point; discrepancy: number } | undefined {
  const { weakStep, weak, ambiguous, confidence, error, canonicalKeyframe, offset, pose } = inputs;
  if ((weakStep || weak) && !ambiguous && confidence > .72 && error < 8) {
    // The keyframe used for this correction may itself sit on a fragment attached onto the current canvas; its
    // raw x/y must already be translated into that canvas's coordinates (by the caller, via canonicalPose)
    // before comparing to `pose`.
    const target = { x: canonicalKeyframe.x + offset.x, y: canonicalKeyframe.y + offset.y };
    const discrepancy = Math.hypot(target.x - pose.x, target.y - pose.y);
    if (discrepancy >= 16) {
      return { target, discrepancy };
    }
  }
  return undefined;
}
export type LoopVerdict = 'closure' | 'inconsistent' | 'ambiguous' | 'none';
/** Whether a revisit on the SAME canvas the frame already resolved to should be folded in as a global position
 * constraint (a loop edge), rejected as conflicting with the continuous trajectory, or left unresolved because
 * the historical match itself was ambiguous. */
export function loopClosureVerdict(
  ambiguous: boolean,
  confidence: number,
  discrepancy: number,
): { verdict: LoopVerdict; discrepancy: number } {
  if (!ambiguous && confidence > .72 && discrepancy < 16) {
    return { verdict: 'closure', discrepancy };
  } else if (discrepancy >= 16) {
    return { verdict: 'inconsistent', discrepancy };
  } else if (ambiguous) {
    return { verdict: 'ambiguous', discrepancy };
  }
  return { verdict: 'none', discrepancy };
}
