/** Per-region, per-frame tracking verdicts (R4b phase 3a), mirroring `rust/core/src/abi/track.rs`. Every
 *  export here is a single small call over plain scalars — no handles, no state carried across calls
 *  (the stateful per-region tracker is phase 3b). `has*`/`*EqCanvas` booleans are `0`/`1`; multi-way
 *  verdicts come back as small tags decoded into the TS union types `track.ts` already exports. */
import type { Feature, Gray, Match, Point, Rect, Region } from '../../types.ts';
import type { Core, LabelMask } from './core.ts';
import type { CoreExports } from './exports.ts';
import { MATCH_POINT_BYTES, VOTING_REGION_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import { type FrameInput, Resident, ResidentFrame } from './memory.ts';

const b = (v: boolean) => (v ? 1 : 0);

export function uncertainty(exports: CoreExports, confidence: number, ambiguous: boolean, weakStep: boolean): boolean {
  return exports.ls_track_uncertainty(confidence, b(ambiguous), b(weakStep)) !== 0;
}

export function relocalizeVerdict(
  exports: CoreExports,
  match: { ambiguous: boolean; confidence: number } | undefined,
  zoomChange: boolean,
): boolean {
  return exports.ls_track_relocalize_verdict(b(!!match), b(match?.ambiguous ?? false), match?.confidence ?? 0, b(zoomChange)) !== 0;
}

export type FragmentCauseGate = 'none' | 'zoom-change' | 'probe-scale';
const FRAGMENT_CAUSE_GATE_TAGS: FragmentCauseGate[] = ['none', 'zoom-change', 'probe-scale'];
export function fragmentCauseGate(exports: CoreExports, zoomChange: boolean, hasPreviousGray: boolean, blind: boolean): FragmentCauseGate {
  return FRAGMENT_CAUSE_GATE_TAGS[exports.ls_track_fragment_cause_gate(b(zoomChange), b(hasPreviousGray), b(blind))];
}

/** `decision`: the odometry/gate outcome; only `'tracked'`/`'static'` are eligible (see track.rs). */
export type OcclusionDecision = 'tracked' | 'static' | 'blind' | 'lost';
const OCCLUSION_DECISION_TAGS: Record<OcclusionDecision, number> = { tracked: 0, static: 1, blind: 2, lost: 3 };
export function occlusionEligible(exports: CoreExports, hasPrevious: boolean, kindMoving: boolean, decision: OcclusionDecision): boolean {
  return exports.ls_track_occlusion_eligible(b(hasPrevious), b(kindMoving), OCCLUSION_DECISION_TAGS[decision]) !== 0;
}

function readPoint(core: Core, ptr: number): Point {
  const bytes = core.readBytes(ptr, 16), view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, 16);
  return { x: view.getFloat64(0, true), y: view.getFloat64(8, true) };
}

export function targetPose(core: Core, exports: CoreExports, keyframe: Point, offset: Point, shift: Point): Point {
  const [out] = core.scratch([16]);
  core.check(exports.ls_track_target_pose(keyframe.x, keyframe.y, offset.x, offset.y, shift.x, shift.y, out), 'track target pose');
  return readPoint(core, out);
}

export function attachVerdict(
  core: Core,
  exports: CoreExports,
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number } | undefined,
  resolvedTargetEqCanvas: boolean,
  shift: Point,
): Point | undefined {
  const [out] = core.scratch([16]);
  const result = exports.ls_track_attach_verdict(
    b(!!global),
    global?.keyframe.x ?? 0,
    global?.keyframe.y ?? 0,
    global?.offset.x ?? 0,
    global?.offset.y ?? 0,
    b(global?.ambiguous ?? false),
    global?.confidence ?? 0,
    b(resolvedTargetEqCanvas),
    shift.x,
    shift.y,
    out,
  );
  if (result === -1) {
    throw new Error('CORE_BAD_ARGUMENT: attach verdict.');
  }
  return result === 1 ? readPoint(core, out) : undefined;
}

export function odometryWeight(exports: CoreExports, weakStep: boolean): number {
  return exports.ls_track_odometry_weight(b(weakStep));
}

export function thinOverlapEligible(
  exports: CoreExports,
  weakStep: boolean,
  weak: boolean,
  ambiguous: boolean,
  confidence: number,
  error: number,
): boolean {
  return exports.ls_track_thin_overlap_eligible(b(weakStep), b(weak), b(ambiguous), confidence, error) !== 0;
}

export function thinOverlapCorrection(
  core: Core,
  exports: CoreExports,
  canonicalKeyframe: Point,
  offset: Point,
  pose: Point,
): { target: Point; discrepancy: number } | undefined {
  const [out] = core.scratch([24]);
  const result = exports.ls_track_thin_overlap_correction(
    canonicalKeyframe.x,
    canonicalKeyframe.y,
    offset.x,
    offset.y,
    pose.x,
    pose.y,
    out,
  );
  if (result === -1) {
    throw new Error('CORE_BAD_ARGUMENT: thin overlap correction.');
  }
  if (result === 0) {
    return undefined;
  }
  const target = readPoint(core, out), bytes = core.readBytes(out + 16, 8);
  return { target, discrepancy: new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, 8).getFloat64(0, true) };
}

export type LoopVerdict = 'closure' | 'inconsistent' | 'ambiguous' | 'none';
const LOOP_VERDICT_TAGS: LoopVerdict[] = ['closure', 'inconsistent', 'ambiguous', 'none'];
export function loopClosureVerdict(
  core: Core,
  exports: CoreExports,
  global: { keyframe: Point; offset: Point; ambiguous: boolean; confidence: number },
  shift: Point,
  pose: Point,
): { verdict: LoopVerdict; discrepancy: number } {
  const [out] = core.scratch([8]);
  const tag = exports.ls_track_loop_closure_verdict(
    global.keyframe.x,
    global.keyframe.y,
    global.offset.x,
    global.offset.y,
    b(global.ambiguous),
    global.confidence,
    shift.x,
    shift.y,
    pose.x,
    pose.y,
    out,
  );
  const bytes = core.readBytes(out, 8);
  return {
    verdict: LOOP_VERDICT_TAGS[tag],
    discrepancy: new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, 8).getFloat64(0, true),
  };
}

export function needsKeyframe(
  exports: CoreExports,
  kindMoving: boolean,
  anchor: Point | undefined,
  pose: Point,
  lastNodeFrame: number | undefined,
  rect: { width: number; height: number },
  frameIndex: number,
  fieldDifference: number,
): boolean {
  return exports.ls_track_needs_keyframe(
    b(kindMoving),
    b(!!anchor),
    anchor?.x ?? 0,
    anchor?.y ?? 0,
    pose.x,
    pose.y,
    b(lastNodeFrame !== undefined),
    lastNodeFrame ?? 0,
    rect.width,
    rect.height,
    frameIndex,
    fieldDifference,
  ) !== 0;
}

export function zoomChanged(exports: CoreExports, regionZoom: number | undefined, fieldZoom: number): boolean {
  return exports.ls_track_zoom_changed(b(regionZoom !== undefined), regionZoom ?? 0, fieldZoom) !== 0;
}

function writeMatches(core: Core, ptr: number, matches: Match[]): void {
  const view = new DataView(core.exports.memory.buffer, ptr, matches.length * MATCH_POINT_BYTES);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i], o = i * MATCH_POINT_BYTES;
    view.setFloat64(o, m.a.x, true);
    view.setFloat64(o + 8, m.a.y, true);
    view.setFloat64(o + 16, m.b.x, true);
    view.setFloat64(o + 24, m.b.y, true);
    view.setUint32(o + 32, m.unique ? 1 : 0, true);
    view.setUint32(o + 36, 0, true);
  }
}
/** `track.ts::regionZoom`, fused with the `detectScale` kernel it conditionally calls. */
export function regionZoom(core: Core, exports: CoreExports, kindMoving: boolean, priorMatches: Match[]): number | undefined {
  const [input] = core.scratch([priorMatches.length * MATCH_POINT_BYTES]);
  writeMatches(core, input, priorMatches);
  const result = exports.ls_track_region_zoom(b(kindMoving), input, priorMatches.length);
  return Number.isNaN(result) ? undefined : result;
}

/** One serialised `Region` for `ls_track_odometry`'s difference-sample fallback: the same
 *  `VOTING_REGION_BYTES` wire format `wasm/voting.ts::votingRing` writes once per solve pass, written here
 *  every call (R4c 3b-i keeps this simple; only the rare fallback path — the fast native refinement failed —
 *  actually reads it core-side). */
function writeRegion(core: Core, base: number, exclusions: number, crop: number, mask: number, r: Region): void {
  core.writeRect(base, r.rect);
  const view = new DataView(core.exports.memory.buffer, base, VOTING_REGION_BYTES);
  (r.exclusions || []).forEach((e, k) => core.writeRect(exclusions + k * 32, e));
  view.setUint32(32, r.exclusions?.length ? exclusions : 0, true);
  view.setUint32(36, r.exclusions?.length || 0, true);
  if (r.crop) core.writeRect(crop, r.crop);
  view.setUint32(40, r.crop ? crop : 0, true);
  view.setUint32(44, r.solid ? 1 : 0, true);
  const useMask = !!r.mask && !r.solid;
  if (useMask) {
    if (!r.maskWidth || !r.maskHeight || r.mask!.byteLength !== r.maskWidth * r.maskHeight) {
      throw new Error(`CORE_BAD_ARGUMENT: region ${r.id} mask does not match its declared ${r.maskWidth}×${r.maskHeight}.`);
    }
    core.writeBytes(mask, r.mask!);
  }
  view.setUint32(48, useMask ? mask : 0, true);
  view.setUint32(52, useMask ? r.maskWidth! : 0, true);
  view.setUint32(56, useMask ? r.maskHeight! : 0, true);
  view.setUint32(60, useMask ? r.factor || 0 : 0, true);
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
const ODOMETRY_DECISION_TAGS: OdometryEstimate['decision'][] = ['tracked', 'static', 'lost'];
/** `ls_track_odometry`'s `out` layout (`TRACK_ODOMETRY_OUT_BYTES` in `abi/track.rs`). */
const TRACK_ODOMETRY_OUT_BYTES = 64;

export interface OdometryInputs {
  f: number;
  radius: number;
  mask: LabelMask | undefined;
  roi: Rect;
  rect: Rect;
  region: Region;
  image: { width: number; height: number };
  previous: FrameInput;
  current: FrameInput;
  previousGray: Gray;
  g: Gray;
  velocity: Point;
  previousFeatures: Feature[];
  ownFeatures: Feature[];
  confidence: number;
}
/** `track.ts::odometry`, fused into one call (R4c 3b-i): `matchFeatures` + `translationHypotheses` + the
 *  audit filter/sort + up to 6 native refinements + rival detection + confidence, falling back core-side to
 *  the difference sample that decides `static` vs `lost`. Cross-frame state (`state.previousFeatures`, the
 *  region's velocity) is still owned by the shell; this call is stateless like every other `track.*` export. */
export function odometry(core: Core, exports: CoreExports, inputs: OdometryInputs): OdometryEstimate {
  const {
    f,
    radius,
    mask,
    roi,
    rect,
    region,
    image,
    previous,
    current,
    previousGray,
    g,
    velocity,
    previousFeatures,
    ownFeatures,
    confidence: inputConfidence,
  } = inputs;
  const frameBytes = (fr: FrameInput) => fr instanceof ResidentFrame ? 0 : fr.data.byteLength;
  const residentLabels = mask?.labels instanceof Resident ? mask.labels : undefined;
  if (residentLabels && residentLabels.length !== image.width * image.height) {
    throw new Error('CORE_BAD_ARGUMENT: resident labels do not match the frame.');
  }
  const ptr = core.scratch([
    frameBytes(previous),
    frameBytes(current),
    previousGray.data.byteLength,
    g.data.byteLength,
    previousFeatures.length * core.featureBytes,
    ownFeatures.length * core.featureBytes,
    32,
    32,
    VOTING_REGION_BYTES,
    (region.exclusions?.length || 0) * 32,
    region.crop ? 32 : 0,
    region.mask && !region.solid ? region.mask.byteLength : 0,
    mask && !residentLabels ? (mask.labels as Uint8Array).byteLength : 0,
    TRACK_ODOMETRY_OUT_BYTES,
  ]);
  const [pPrev, pCur, pPrevGray, pG, pPrevFeat, pOwnFeat, pRoi, pRect, pRegion, pExcl, pCrop, pMask, pLabels, pOut] = ptr;
  const ra = core.placeFrame(previous, pPrev), rb = core.placeFrame(current, pCur);
  core.writeBytes(pPrevGray, previousGray.data);
  core.writeBytes(pG, g.data);
  writeFeatures(core, pPrevFeat, previousFeatures);
  writeFeatures(core, pOwnFeat, ownFeatures);
  core.writeRect(pRoi, roi);
  core.writeRect(pRect, rect);
  writeRegion(core, pRegion, pExcl, pCrop, pMask, region);
  let labels = 0;
  if (residentLabels) labels = residentLabels.ptr;
  else if (mask) {
    core.writeBytes(pLabels, mask.labels as Uint8Array);
    labels = pLabels;
  }
  const tag = exports.ls_track_odometry(
    ra,
    rb,
    image.width,
    image.height,
    pPrevGray,
    pG,
    previousGray.width,
    previousGray.height,
    pPrevFeat,
    previousFeatures.length,
    pOwnFeat,
    ownFeatures.length,
    pRoi,
    pRect,
    pRegion,
    labels,
    mask?.code ?? 0,
    f,
    radius,
    velocity.x,
    velocity.y,
    inputConfidence,
    pOut,
  );
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: odometry.');
  const bytes = core.readBytes(pOut, TRACK_ODOMETRY_OUT_BYTES), view = new DataView(bytes.buffer);
  const hasContentChange = view.getUint32(40, true) === 1;
  const decision = ODOMETRY_DECISION_TAGS[tag], ambiguous = view.getUint32(24, true) === 1, weakStep = view.getUint32(28, true) === 1;
  const stepError = view.getFloat64(32, true);
  // On 'tracked', `confidence` off the wire is the RAW hypothesis confidence (`rust/core/src/track.rs`'s
  // `OdometryEstimate.confidence` doc comment): the TS original's own `Math.exp(-stepError / 20)` runs HERE,
  // not in Rust, so it uses this engine's own `Math.exp` — bit-exact with the pre-refactor engine the
  // differential harness compares against, unlike Rust libm's `exp`, which can round the last bit differently
  // for this call's continuous, effectively-arbitrary `stepError` input.
  const confidence = decision === 'tracked'
    ? Math.max(.05, view.getFloat64(16, true)) * Math.exp(-stepError / 20) * (ambiguous ? .6 : 1) * (weakStep ? .5 : 1)
    : view.getFloat64(16, true);
  return {
    decision,
    delta: { x: view.getFloat64(0, true), y: view.getFloat64(8, true) },
    confidence,
    ambiguous,
    weakStep,
    stepError,
    ...(hasContentChange ? { contentChange: { agreement: view.getFloat64(48, true), blocks: view.getUint32(56, true) } } : {}),
  };
}
