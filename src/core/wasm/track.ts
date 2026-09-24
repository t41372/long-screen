/** Per-region, per-frame tracking verdicts (R4b phase 3a) plus keyframe candidate scoring (R4d step 4),
 *  mirroring `rust/core/src/abi/track.rs`. Every export here is a single call over plain scalars/buffers — no
 *  handles, no state carried across calls (a stateful per-region tracker was measured in R4c 3b-iii and NOT
 *  built: no measurable gain over these per-call fusions). `has*`/`*EqCanvas` booleans are `0`/`1`; multi-way
 *  verdicts come back as small tags decoded into the TS union types `track.ts` already exports. */
import type { Feature, Gray, Match, Point, Rect, Region } from '../../types.ts';
import type { Core, LabelMask, PatchInput, RefinementResult } from './core.ts';
import type { CoreExports } from './exports.ts';
import { MATCH_POINT_BYTES, PATCH_BYTES, VOTING_REGION_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import { type FrameInput, Resident, ResidentFrame, ResidentGray } from './memory.ts';

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
  // WHY this multiply stays in TS (architecture decision, R4c 3b-i): on 'tracked', `confidence` off the wire is
  // the RAW hypothesis confidence (`rust/core/src/track.rs`'s `OdometryEstimate.confidence` doc comment) —
  // `Math.exp(-stepError / 20)` runs HERE, in TS, for bit-identity with the historical TS confidence formula.
  // Rust libm's `exp` rounds the last bit differently from V8's `Math.exp` on some inputs (confirmed by the
  // differential harness: `stepError` is a continuous, effectively-arbitrary float, unlike the few small-integer-
  // ratio `.exp()` inputs already in motion.rs, which never hit a rounding boundary in the 24×11 differential
  // suite). Moving this multiply into Rust too is a separate, deliberately-verified behaviour change, not a
  // consequence of "fuse into one call" — don't do it as a drive-by.
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

function b2(v: boolean) {
  return v ? 1 : 0;
}
function writePatches(core: Core, listPtr: number, dataPtrs: number[], patches: PatchInput[]): void {
  const view = new DataView(core.exports.memory.buffer, listPtr, Math.max(1, patches.length * PATCH_BYTES));
  patches.forEach((p, i) => {
    if (p.data.byteLength !== p.size * p.size) throw new Error('CORE_BAD_ARGUMENT: patch data does not match its size.');
    core.writeBytes(dataPtrs[i], p.data);
    view.setInt32(i * PATCH_BYTES, p.x, true);
    view.setInt32(i * PATCH_BYTES + 4, p.y, true);
    view.setUint32(i * PATCH_BYTES + 8, p.size, true);
    view.setUint32(i * PATCH_BYTES + 12, dataPtrs[i], true);
  });
}
/** Resolves `reacquire`/`driftCorrection`/`evaluateCandidates`'s "native luma source" the same way
 *  `rust/core/src/abi/track.rs`'s `resolve_native` expects: mode 1 (resident) when `current` is a
 *  `ResidentFrame` and `nativePlane` exists — the fused call fills it lazily, core-side, if `nativeFilled` says
 *  it hasn't been this frame; mode 0 (ready buffer, freshly copied into scratch) otherwise — the rare
 *  geometry-mismatch fallback, where `native()` (the historical thunk, still doing the JS-side `grayscale()`
 *  conversion for this branch — R4c 3b-ii does not port that rare path) is called EAGERLY here, before Rust
 *  even knows whether a candidate exists, unlike the resident branch's true laziness; the trade-off is
 *  deliberate (this branch never reaches the 24×11 differential suite, and the alternative was a second ABI
 *  call splitting the hypothesis pre-check from the refinement for this one rare path).
 *  `current` is `undefined` for callers with no resident frame to offer at all (R4d step 4:
 *  `evaluateCandidates`'s direct-call test callers, and the differential harness's frozen pre-fusion engine,
 *  which never threads `current`/`nativePlane` through `KeyframeIndex.find()` at all) — that alone does not
 *  imply `native()` returns a plain `Gray`: a caller's own `native()` closure can still close over a resident
 *  frame independently (exactly what the frozen engine's `native` thunk does) and hand back a `ResidentGray`
 *  here. `alreadyFilled: true` on THAT result (not `nativeFilled`, which is meaningless for a plane that is not
 *  the shared per-frame memo) tells the caller never to report this as "I filled the memo". */
function resolveNative(
  current: FrameInput | undefined,
  nativePlane: ResidentGray | undefined,
  native: () => Gray | ResidentGray,
): {
  mode: number;
  ptr: number;
  currentFramePtr: number;
  width: number;
  height: number;
  scratchBytes: number;
  alreadyFilled: boolean;
  fallback?: Gray;
} {
  if (current instanceof ResidentFrame && nativePlane) {
    return {
      mode: 1,
      ptr: nativePlane.ptr,
      currentFramePtr: current.ptr,
      width: nativePlane.width,
      height: nativePlane.height,
      scratchBytes: 0,
      alreadyFilled: false,
    };
  }
  const result = native();
  if (result instanceof ResidentGray) {
    return {
      mode: 1,
      ptr: result.ptr,
      currentFramePtr: 0,
      width: result.width,
      height: result.height,
      scratchBytes: 0,
      alreadyFilled: true,
    };
  }
  return {
    mode: 0,
    ptr: 0,
    currentFramePtr: 0,
    width: result.width,
    height: result.height,
    scratchBytes: result.data.byteLength,
    alreadyFilled: false,
    fallback: result,
  };
}

export interface ReacquireEstimate {
  n: RefinementResult;
  ambiguous: boolean;
  confidence: number;
}
export interface ReacquireInputs {
  anchorFeatures: Feature[];
  ownFeatures: Feature[];
  anchorPatches: PatchInput[];
  current: FrameInput;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
  rect: Rect;
  f: number;
  radius: number;
}
/** `track.ts::reacquire`, fused into one call (R4c 3b-ii). `filledNative` tells the caller whether to update
 *  the SAME per-frame `native()` memo `solve.ts` owns (see `FrameInput.markNativeFilled`). */
export function reacquire(
  core: Core,
  exports: CoreExports,
  inputs: ReacquireInputs,
): { result: ReacquireEstimate | undefined; filledNative: boolean } {
  const { anchorFeatures, ownFeatures, anchorPatches, current, nativePlane, nativeFilled, native, rect, f, radius } = inputs;
  const src = resolveNative(current, nativePlane, native);
  const ptr = core.scratch([
    anchorFeatures.length * core.featureBytes,
    ownFeatures.length * core.featureBytes,
    anchorPatches.length * PATCH_BYTES,
    32,
    src.scratchBytes,
    TRACK_REACQUIRE_OUT_BYTES,
    ...anchorPatches.map((p) => p.data.byteLength),
  ]);
  const [pAnchorFeat, pOwnFeat, pPatchList, pRect, pFallback, pOut] = ptr, dataPtrs = ptr.slice(6);
  writeFeatures(core, pAnchorFeat, anchorFeatures);
  writeFeatures(core, pOwnFeat, ownFeatures);
  writePatches(core, pPatchList, dataPtrs, anchorPatches);
  core.writeRect(pRect, rect);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const tag = exports.ls_track_reacquire(
    pAnchorFeat,
    anchorFeatures.length,
    pOwnFeat,
    ownFeatures.length,
    pPatchList,
    anchorPatches.length,
    pRect,
    f,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b2(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: reacquire.');
  const bytes = core.readBytes(pOut, TRACK_REACQUIRE_OUT_BYTES), view = new DataView(bytes.buffer);
  const filledNative = view.getUint32(36, true) === 1;
  if (tag === 0) return { result: undefined, filledNative };
  const ambiguous = view.getUint32(8, true) === 1, error = view.getFloat64(24, true);
  // `confidence` off the wire is the RAW hypothesis confidence (rust/core/src/track.rs's `ReacquireEstimate` doc
  // comment); Math.exp finished here on the host's own implementation, same bit-exactness reason as
  // OdometryEstimate's confidence field.
  const confidence = Math.max(.05, view.getFloat64(16, true)) * Math.exp(-error / 20) * (ambiguous ? .6 : 1);
  return {
    result: {
      n: { x: view.getInt32(0, true), y: view.getInt32(4, true), error, samples: 0, runnerUp: 0 },
      ambiguous,
      confidence,
    },
    filledNative,
  };
}
const TRACK_REACQUIRE_OUT_BYTES = 40;

export interface DriftCorrectionInputs {
  anchor: { x: number; y: number; patches: PatchInput[] };
  pose: Point;
  current: FrameInput;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
  rect: Rect;
  radius: number;
}
/** `track.ts::driftCorrection`, fused into one call (R4c 3b-ii). No gate: the original always evaluates
 *  `native()`, so `filledNative` is true here whenever the resident plane wasn't already filled this frame. */
export function driftCorrection(
  core: Core,
  exports: CoreExports,
  inputs: DriftCorrectionInputs,
): { pose: Point | undefined; error: number; filledNative: boolean } {
  const { anchor, pose, current, nativePlane, nativeFilled, native, rect, radius } = inputs;
  const src = resolveNative(current, nativePlane, native);
  const ptr = core.scratch([
    anchor.patches.length * PATCH_BYTES,
    32,
    src.scratchBytes,
    TRACK_DRIFT_CORRECTION_OUT_BYTES,
    ...anchor.patches.map((p) => p.data.byteLength),
  ]);
  const [pPatchList, pRect, pFallback, pOut] = ptr, dataPtrs = ptr.slice(4);
  writePatches(core, pPatchList, dataPtrs, anchor.patches);
  core.writeRect(pRect, rect);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const tag = exports.ls_track_drift_correction(
    pPatchList,
    anchor.patches.length,
    pRect,
    anchor.x,
    anchor.y,
    pose.x,
    pose.y,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b2(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (tag === -1) throw new Error('CORE_BAD_ARGUMENT: driftCorrection.');
  const bytes = core.readBytes(pOut, TRACK_DRIFT_CORRECTION_OUT_BYTES), view = new DataView(bytes.buffer);
  const filledNative = view.getUint32(24, true) === 1;
  if (tag === 0) return { pose: undefined, error: Infinity, filledNative };
  return { pose: { x: view.getFloat64(0, true), y: view.getFloat64(8, true) }, error: view.getFloat64(16, true), filledNative };
}
const TRACK_DRIFT_CORRECTION_OUT_BYTES = 32;

export interface EvaluateCandidatesKeyframe {
  features: Feature[];
  gray: Gray;
  patches: PatchInput[];
}
export interface EvaluateCandidatesQuery {
  features: Feature[];
  gray: Gray;
  roi: Rect;
  region: Rect;
  factor: number;
  radius: number;
  /** See `ReacquireInputs.current`'s doc comment for the resident-lazy-fill contract — `undefined` here means
   *  the caller has no resident frame to offer at all (R4d step 4: direct `evaluateCandidates`/`find()` callers
   *  in tests, which do not go through `solve.ts`'s frame loop); `resolveNative` treats that exactly like any
   *  other non-resident `current` (mode 0, `native()` called eagerly). */
  current: FrameInput | undefined;
  nativePlane: ResidentGray | undefined;
  nativeFilled: boolean;
  native: () => Gray | ResidentGray;
}
export interface EvaluateCandidatesResult {
  keyframeIndex: number;
  x: number;
  y: number;
  support: number;
  unique: number;
  ambiguous: boolean;
  strong: boolean;
  error: number;
  analysisError: number;
}
/** `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor (this module's own wire format — see
 *  `rust/core/src/abi/track.rs::KEYFRAME_BYTES`): u32 featuresPtr, featureCount, patchesPtr, patchCount,
 *  grayPtr, grayWidth, grayHeight, padding. */
const KEYFRAME_BYTES = 32;
const CANDIDATE_HEADER_BYTES = 8;
const CANDIDATE_RECORD_BYTES = 48;

/** `keyframes.ts::evaluateCandidates` fused into one call (R4d step 4): match + hypothesis + analysis-scale
 *  audit for every keyframe, then — only if at least one candidate passed the audit — the lazy native-plane
 *  fill (same rule as `reacquire`/`driftCorrection`) and native-patch refinement. Returns the audited-and-
 *  refined candidate list, not the final pick: `keyframes.ts` finishes the `Math.exp` confidence formula and
 *  the sort/best/rival selection in TS (see `rust/core/src/track.rs::RefinedCandidate`'s doc comment — that
 *  selection needs the exact host-`Math.exp`'d confidence as its sort key, so it cannot move to Rust without
 *  a second bit-exactness risk on top of `OdometryEstimate.confidence`'s). */
export function evaluateCandidates(
  core: Core,
  exports: CoreExports,
  keyframes: EvaluateCandidatesKeyframe[],
  q: EvaluateCandidatesQuery,
): { results: EvaluateCandidatesResult[]; filledNative: boolean } {
  const { features, gray, roi, region, factor, radius, current, nativePlane, nativeFilled, native } = q;
  const src = resolveNative(current, nativePlane, native);
  const maxRecords = keyframes.length * 8;
  const perKeyframeSizes = keyframes.flatMap((k) => [
    k.features.length * core.featureBytes,
    k.patches.length * PATCH_BYTES,
    k.gray.data.byteLength,
    ...k.patches.map((p) => p.data.byteLength),
  ]);
  const ptr = core.scratch([
    keyframes.length * KEYFRAME_BYTES,
    features.length * core.featureBytes,
    gray.data.byteLength,
    32,
    32,
    src.scratchBytes,
    CANDIDATE_HEADER_BYTES + maxRecords * CANDIDATE_RECORD_BYTES,
    ...perKeyframeSizes,
  ]);
  const [pKeyframes, pFeatures, pGray, pRoi, pRegion, pFallback, pOut] = ptr;
  let cursor = 7;
  const desc = new DataView(core.exports.memory.buffer);
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i];
    const featuresPtr = ptr[cursor++], patchListPtr = ptr[cursor++], grayPtr = ptr[cursor++];
    const dataPtrs = k.patches.map(() => ptr[cursor++]);
    writeFeatures(core, featuresPtr, k.features);
    writePatches(core, patchListPtr, dataPtrs, k.patches);
    core.writeBytes(grayPtr, k.gray.data);
    const base = pKeyframes + i * KEYFRAME_BYTES;
    desc.setUint32(base, featuresPtr, true);
    desc.setUint32(base + 4, k.features.length, true);
    desc.setUint32(base + 8, patchListPtr, true);
    desc.setUint32(base + 12, k.patches.length, true);
    desc.setUint32(base + 16, grayPtr, true);
    desc.setUint32(base + 20, k.gray.width, true);
    desc.setUint32(base + 24, k.gray.height, true);
    desc.setUint32(base + 28, 0, true);
  }
  writeFeatures(core, pFeatures, features);
  core.writeBytes(pGray, gray.data);
  core.writeRect(pRoi, roi);
  core.writeRect(pRegion, region);
  if (src.mode === 0) core.writeBytes(pFallback, src.fallback!.data);
  const count = exports.ls_keyframes_evaluate_candidates(
    pKeyframes,
    keyframes.length,
    pFeatures,
    features.length,
    pGray,
    gray.width,
    gray.height,
    pRoi,
    pRegion,
    factor,
    radius,
    src.mode,
    src.mode === 0 ? pFallback : src.ptr,
    src.currentFramePtr,
    b(nativeFilled || src.alreadyFilled),
    src.width,
    src.height,
    pOut,
  );
  if (count === -1) throw new Error('CORE_BAD_ARGUMENT: evaluate candidates.');
  if (count === 0) return { results: [], filledNative: false };
  const headerBytes = core.readBytes(pOut, CANDIDATE_HEADER_BYTES);
  const filledNative = new DataView(headerBytes.buffer, headerBytes.byteOffset, CANDIDATE_HEADER_BYTES).getUint32(0, true) === 1;
  const recordBytes = core.readBytes(pOut + CANDIDATE_HEADER_BYTES, count * CANDIDATE_RECORD_BYTES);
  const rview = new DataView(recordBytes.buffer, recordBytes.byteOffset, count * CANDIDATE_RECORD_BYTES);
  const results: EvaluateCandidatesResult[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * CANDIDATE_RECORD_BYTES;
    results.push({
      keyframeIndex: rview.getUint32(o, true),
      x: rview.getInt32(o + 4, true),
      y: rview.getInt32(o + 8, true),
      support: rview.getUint32(o + 12, true),
      unique: rview.getUint32(o + 16, true),
      ambiguous: rview.getUint32(o + 20, true) === 1,
      strong: rview.getUint32(o + 24, true) === 1,
      error: rview.getFloat64(o + 32, true),
      analysisError: rview.getFloat64(o + 40, true),
    });
  }
  return { results, filledNative };
}
