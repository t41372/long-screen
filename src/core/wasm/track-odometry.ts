/** `track.ts::odometry` fused into one call (R4c 3b-i) — split from the former monolithic `wasm/track.ts`
 *  (R6-B, final-verify-report.md item 10). See `track.ts`'s module doc comment for the split. */
import type { Feature, Gray, Point, Rect, Region } from '../../types.ts';
import type { Core, LabelMask } from './core.ts';
import type { CoreExports } from './exports.ts';
import { VOTING_REGION_BYTES } from './exports.ts';
import { writeFeatures } from './features.ts';
import { type FrameInput, Resident, ResidentFrame } from './memory.ts';
import { writeRegion } from './track.ts';

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
