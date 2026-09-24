/** Translation/scale hypotheses, verification, refinement, and motion-field estimation (mirrors
 *  `rust/core/src/abi/motion.rs`). */
import type { Feature, Gray, Match, Motion, MotionField, Point, Rect } from '../../types.ts';
import type { Core, LabelMask, PatchInput, RefinementResult } from './core.ts';
import { type FrameInput, Resident, ResidentFrame, ResidentGray } from './memory.ts';
import { writeFeatures } from './features.ts';
import {
  EXTRACTED_PATCH_HEADER_BYTES,
  MATCH_POINT_BYTES,
  MOTION_BYTES,
  MOTION_CELL,
  MOTION_FIELD_HEADER,
  PATCH_BYTES,
  POINT_BYTES,
  REFINEMENT_BYTES,
} from './exports.ts';

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
function readMotions(core: Core, ptr: number, count: number): Motion[] {
  const view = new DataView(core.exports.memory.buffer, ptr, count * MOTION_BYTES), out: Motion[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * MOTION_BYTES;
    out[i] = {
      x: view.getFloat64(o, true),
      y: view.getFloat64(o + 8, true),
      support: view.getUint32(o + 16, true),
      unique: view.getUint32(o + 20, true),
      confidence: view.getFloat64(o + 24, true),
      error: view.getFloat64(o + 32, true),
      ambiguous: view.getUint32(o + 40, true) === 1,
    };
  }
  return out;
}
export function translationHypotheses(core: Core, matches: Match[], max: number): Motion[] {
  const [input, output] = core.scratch([matches.length * MATCH_POINT_BYTES, max * MOTION_BYTES]);
  writeMatches(core, input, matches);
  const count = core.check(core.exports.ls_translation_hypotheses(input, matches.length, max, output), 'translationHypotheses');
  return readMotions(core, output, count);
}
export function detectScale(core: Core, matches: Match[]): number {
  const [input] = core.scratch([matches.length * MATCH_POINT_BYTES]);
  writeMatches(core, input, matches);
  return core.exports.ls_detect_scale(input, matches.length);
}
/** Plans two grey images plus an optional roi and extra buffers; returns their pointers in order. */
function planGrays(
  core: Core,
  a: Gray,
  b: Gray,
  roi: Rect | undefined,
  extra: number[],
): { pa: number; pb: number; rect: number; extra: number[] } {
  const ptr = core.scratch([a.data.byteLength, b.data.byteLength, 32, ...extra]);
  core.writeBytes(ptr[0], a.data);
  core.writeBytes(ptr[1], b.data);
  if (roi) core.writeRect(ptr[2], roi);
  return { pa: ptr[0], pb: ptr[1], rect: roi ? ptr[2] : 0, extra: ptr.slice(3) };
}
export function verifyTranslation(core: Core, a: Gray, b: Gray, dx: number, dy: number, roi?: Rect): number {
  const p = planGrays(core, a, b, roi, []);
  const result = core.exports.ls_verify_translation(p.pa, a.width, a.height, p.pb, b.width, b.height, dx, dy, p.rect);
  if (Number.isNaN(result)) throw new Error('CORE_BAD_ARGUMENT: verifyTranslation.');
  return result;
}
export function auditTranslation(
  core: Core,
  a: Gray,
  b: Gray,
  dx: number,
  dy: number,
  roi: Rect | undefined,
  tolerant: boolean,
): {
  error: number;
  mismatch: number;
  overlap: number;
  samples: number;
  blocks: number;
  agreeing: number;
  agreement: number;
  agreeingError: number;
} {
  const p = planGrays(core, a, b, roi, [64]);
  core.check(
    core.exports.ls_audit_translation(p.pa, a.width, a.height, p.pb, b.width, b.height, dx, dy, p.rect, tolerant ? 1 : 0, p.extra[0]),
    'auditTranslation',
  );
  const v = new Float64Array(core.readBytes(p.extra[0], 64).buffer);
  return {
    error: v[0],
    mismatch: v[1],
    overlap: v[2],
    samples: v[3],
    blocks: v[4],
    agreeing: v[5],
    agreement: v[6],
    agreeingError: v[7],
  };
}
export function refineTranslation(
  core: Core,
  a: Gray,
  b: Gray,
  p: { x: number; y: number },
  roi: Rect | undefined,
  radius: number,
): { x: number; y: number } {
  const g = planGrays(core, a, b, roi, [8]);
  core.check(
    core.exports.ls_refine_translation(g.pa, a.width, a.height, g.pb, b.width, b.height, p.x, p.y, g.rect, radius, g.extra[0]),
    'refineTranslation',
  );
  const v = new Int32Array(core.readBytes(g.extra[0], 8).buffer);
  return { x: v[0], y: v[1] };
}
export function estimateMotion(core: Core, a: Gray, b: Gray, matches: Match[], featureCount: number): MotionField {
  if (a.width !== b.width || a.height !== b.height) throw new Error('FRAME_GEOMETRY_CHANGED');
  const cols = Math.ceil(b.width / MOTION_CELL), rows = Math.ceil(b.height / MOTION_CELL), n = cols * rows;
  const outBytes = MOTION_FIELD_HEADER + 8 * MOTION_BYTES + 3 * n;
  const [pa, pb, pm, output] = core.scratch([a.data.byteLength, b.data.byteLength, matches.length * MATCH_POINT_BYTES, outBytes]);
  core.writeBytes(pa, a.data);
  core.writeBytes(pb, b.data);
  writeMatches(core, pm, matches);
  core.check(core.exports.ls_estimate_motion(pa, pb, a.width, a.height, pm, matches.length, featureCount, output), 'estimateMotion');
  const bytes = core.readBytes(output, outBytes), view = new DataView(bytes.buffer);
  const count = view.getUint32(12, true), base = MOTION_FIELD_HEADER + 8 * MOTION_BYTES;
  return {
    cols: view.getUint32(0, true),
    rows: view.getUint32(4, true),
    cell: view.getUint32(8, true),
    motions: readMotions(core, output + MOTION_FIELD_HEADER, count),
    difference: view.getFloat64(16, true),
    featureCount: view.getUint32(24, true),
    unknown: view.getUint32(28, true) === 1,
    zoom: view.getFloat64(32, true),
    labels: bytes.slice(base, base + n),
    confidence: bytes.slice(base + n, base + 2 * n),
    dynamic: bytes.slice(base + 2 * n, base + 3 * n),
  };
}
function readRefinement(core: Core, ptr: number): RefinementResult {
  const view = new DataView(core.readBytes(ptr, REFINEMENT_BYTES).buffer);
  return {
    x: view.getInt32(0, true),
    y: view.getInt32(4, true),
    error: view.getFloat64(8, true),
    samples: view.getUint32(16, true),
    runnerUp: view.getFloat64(24, true),
  };
}
export function refineNative(
  core: Core,
  a: FrameInput,
  b: FrameInput,
  guess: { x: number; y: number },
  region: Rect,
  mask: LabelMask | undefined,
  radius: number,
): RefinementResult {
  if (a.width !== b.width || a.height !== b.height) {
    return { x: Math.round(guess.x), y: Math.round(guess.y), error: Infinity, samples: 0, runnerUp: Infinity };
  }
  const frameBytes = (f: FrameInput) => f instanceof ResidentFrame ? 0 : f.data.byteLength;
  const residentLabels = mask?.labels instanceof Resident ? mask.labels : undefined;
  if (residentLabels && residentLabels.length !== a.width * a.height) {
    throw new Error('CORE_BAD_ARGUMENT: resident labels do not match the frame.');
  }
  const [pa, pb, rect, scratchLabels, output] = core.scratch([
    frameBytes(a),
    frameBytes(b),
    32,
    mask && !residentLabels ? (mask.labels as Uint8Array).byteLength : 0,
    REFINEMENT_BYTES,
  ]);
  const ra = core.placeFrame(a, pa), rb = core.placeFrame(b, pb);
  core.writeRect(rect, region);
  let labels = 0;
  if (residentLabels) labels = residentLabels.ptr;
  else if (mask) {
    core.writeBytes(scratchLabels, mask.labels as Uint8Array);
    labels = scratchLabels;
  }
  core.check(
    core.exports.ls_refine_native(ra, rb, a.width, a.height, guess.x, guess.y, rect, labels, mask?.code ?? 0, radius, output),
    'refineNative',
  );
  return readRefinement(core, output);
}
export function refinePatches(
  core: Core,
  patches: PatchInput[],
  native: Gray | ResidentGray,
  region: Rect,
  guess: { x: number; y: number },
  radius: number,
): RefinementResult {
  const resident = native instanceof ResidentGray;
  const ptr = core.scratch([
    resident ? 0 : (native as Gray).data.byteLength,
    32,
    patches.length * PATCH_BYTES,
    REFINEMENT_BYTES,
    ...patches.map((p) => p.data.byteLength),
  ]);
  const [scratch, rect, list, output] = ptr;
  let pn = scratch;
  if (native instanceof ResidentGray) pn = native.ptr;
  else core.writeBytes(scratch, native.data);
  core.writeRect(rect, region);
  const view = new DataView(core.exports.memory.buffer, list, Math.max(1, patches.length * PATCH_BYTES));
  patches.forEach((p, i) => {
    if (p.data.byteLength !== p.size * p.size) throw new Error('CORE_BAD_ARGUMENT: patch data does not match its size.');
    core.writeBytes(ptr[4 + i], p.data);
    view.setInt32(i * PATCH_BYTES, p.x, true);
    view.setInt32(i * PATCH_BYTES + 4, p.y, true);
    view.setUint32(i * PATCH_BYTES + 8, p.size, true);
    view.setUint32(i * PATCH_BYTES + 12, ptr[4 + i], true);
  });
  core.check(
    core.exports.ls_refine_patches(list, patches.length, pn, native.width, native.height, rect, guess.x, guess.y, radius, output),
    'refinePatches',
  );
  return readRefinement(core, output);
}
export function resampleGray(core: Core, g: Gray, scale: number): Gray {
  const width = Math.max(2, Math.round(g.width * scale)), height = Math.max(2, Math.round(g.height * scale));
  const [input, output] = core.scratch([g.data.byteLength, width * height]);
  core.writeBytes(input, g.data);
  core.check(core.exports.ls_resample_gray(input, g.width, g.height, scale, output), 'resampleGray');
  return { width, height, data: core.readBytes(output, width * height) };
}
/** Non-overlapping `size×size` native texture samples around `features` (analysis-resolution points scaled by
 *  `factor`), clamped to `region`, first `count` accepted in feature order — `rust/core/src/motion.rs::extract_patches`.
 *  `native` may be the resident luma plane a solve pass already holds in core memory (its pointer is used
 *  directly) or a plain `Gray` (copied into scratch first). */
export function extractPatches(
  core: Core,
  native: Gray | ResidentGray,
  region: Rect,
  features: Point[],
  factor: number,
  count = 24,
  size = 32,
): PatchInput[] {
  const resident = native instanceof ResidentGray;
  const [scratch, rect, flist, output] = core.scratch([
    resident ? 0 : (native as Gray).data.byteLength,
    32,
    features.length * POINT_BYTES,
    count * (EXTRACTED_PATCH_HEADER_BYTES + size * size),
  ]);
  let pn = scratch;
  if (native instanceof ResidentGray) pn = native.ptr;
  else core.writeBytes(scratch, native.data);
  core.writeRect(rect, region);
  const view = new DataView(core.exports.memory.buffer, flist, Math.max(1, features.length * POINT_BYTES));
  features.forEach((f, i) => {
    view.setFloat64(i * POINT_BYTES, f.x, true);
    view.setFloat64(i * POINT_BYTES + 8, f.y, true);
  });
  const returned = core.check(
    core.exports.ls_extract_patches(pn, native.width, native.height, rect, flist, features.length, factor, count, size, output),
    'extractPatches',
  );
  const stride = EXTRACTED_PATCH_HEADER_BYTES + size * size;
  const bytes = core.readBytes(output, returned * stride), dv = new DataView(bytes.buffer);
  const out: PatchInput[] = new Array(returned);
  for (let i = 0; i < returned; i++) {
    const o = i * stride;
    out[i] = {
      x: dv.getFloat64(o, true),
      y: dv.getFloat64(o + 8, true),
      size: dv.getUint32(o + 16, true),
      data: bytes.slice(o + 24, o + 24 + size * size),
    };
  }
  return out;
}
/** When translation fails, asks explicitly whether `previous` (resampled at each candidate scale) explains
 *  `current` — `rust/core/src/motion.rs::probe_scale`, fusing the whole per-scale resample/extract/match/
 *  hypothesis/audit loop into one call. */
export function probeScale(
  core: Core,
  previous: Gray,
  current: Gray,
  currentFeatures: Feature[],
  roi?: Rect,
  scales = [1.1, 1.25, 1.5, 2, 1 / 1.1, 1 / 1.25, 1 / 1.5, 1 / 2],
): { scale: number; error: number } | undefined {
  const [pp, pc, pf, rect, ps, output] = core.scratch([
    previous.data.byteLength,
    current.data.byteLength,
    currentFeatures.length * core.featureBytes,
    32,
    scales.length * 8,
    16,
  ]);
  core.writeBytes(pp, previous.data);
  core.writeBytes(pc, current.data);
  writeFeatures(core, pf, currentFeatures);
  if (roi) core.writeRect(rect, roi);
  const scaleView = new DataView(core.exports.memory.buffer, ps, scales.length * 8);
  scales.forEach((s, i) => scaleView.setFloat64(i * 8, s, true));
  const found = core.check(
    core.exports.ls_probe_scale(
      pp,
      previous.width,
      previous.height,
      pc,
      current.width,
      current.height,
      pf,
      currentFeatures.length,
      roi ? rect : 0,
      ps,
      scales.length,
      output,
    ),
    'probeScale',
  );
  if (!found) return undefined;
  const view = new DataView(core.readBytes(output, 16).buffer);
  return { scale: view.getFloat64(0, true), error: view.getFloat64(8, true) };
}
