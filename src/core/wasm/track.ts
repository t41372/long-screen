/** Per-region, per-frame tracking verdicts (R4b phase 3a), mirroring `rust/core/src/abi/track.rs`. Every
 *  export here is a single small call over plain scalars — no handles, no state carried across calls
 *  (the stateful per-region tracker is phase 3b). `has*`/`*EqCanvas` booleans are `0`/`1`; multi-way
 *  verdicts come back as small tags decoded into the TS union types `track.ts` already exports. */
import type { Match, Point } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { MATCH_POINT_BYTES } from './exports.ts';

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
