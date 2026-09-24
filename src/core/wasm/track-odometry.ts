/** `track.ts::odometry` fused into one call — split out of `wasm/track.ts`. See `track.ts`'s module doc
 *  comment for the split. */
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
/** `track.ts::odometry`, fused into one call: `matchFeatures` + `translationHypotheses` + the
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
  // The 'tracked' confidence (including the exp(-stepError / 20) factor) is fully computed in Rust
  // (rust/core/src/track/odometry.rs's `odometry` — see its WHY comment) with `f64::exp`, a software libm
  // identical on every engine, rather than finished here with the host's own `Math.exp`.
  return {
    decision,
    delta: { x: view.getFloat64(0, true), y: view.getFloat64(8, true) },
    confidence: view.getFloat64(16, true),
    ambiguous,
    weakStep,
    stepError,
    ...(hasContentChange ? { contentChange: { agreement: view.getFloat64(48, true), blocks: view.getUint32(56, true) } } : {}),
  };
}
