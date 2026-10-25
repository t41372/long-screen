/** The `extern "C"` surface `rust/wasm/src/*.rs` exports, the byte layouts shared with it, and the status
 *  convention every kernel call is checked against. */

export interface CoreExports {
  memory: WebAssembly.Memory;
  ls_alloc(size: number): number;
  ls_pool_helpers(): number;
  ls_layout(which: number): number;
  ls_frame_to_rgba(
    src: number,
    srcLen: number,
    format: number,
    width: number,
    height: number,
    planes: number,
    matrix: number,
    dst: number,
  ): number;
  ls_hdr_rgb_to_rgba(pixels: number, packing: number, width: number, height: number, transfer: number): number;
  __tls_size?: WebAssembly.Global;
  __tls_align?: WebAssembly.Global;
  ls_free(ptr: number, size: number): void;
  ls_feature_bytes(): number;
  ls_match_bytes(): number;
  ls_grayscale(rgba: number, width: number, height: number, out: number): number;
  ls_downscale_gray(rgba: number, width: number, height: number, factor: number, out: number): number;
  ls_halve_rgba(rgba: number, width: number, height: number, out: number): number;
  ls_assemble_pyramid_parent(
    c0: number,
    c1: number,
    c2: number,
    c3: number,
    present: number,
    size: number,
    out: number,
  ): number;
  ls_pyramid_new(canvas: number, canvasLen: number, width: number, height: number, size: number): number;
  ls_pyramid_free(handle: number): void;
  ls_pyramid_queue(handle: number, x: number, y: number, out: number): number;
  ls_pyramid_provide(handle: number, children: number): number;
  ls_pyramid_step(handle: number): number;
  ls_pyramid_take(handle: number, out: number, len: number): number;
  ls_overwrite_tile(
    tile: number,
    rgba: number,
    imgWidth: number,
    imgHeight: number,
    blocks: number,
    blockCount: number,
    ox: number,
    oy: number,
    tx: number,
    ty: number,
    frame: number,
    confidence: number,
    stable: number,
    out: number,
  ): number;
  ls_extract_features(gray: number, width: number, height: number, max: number, roi: number, out: number): number;
  ls_match_features(a: number, countA: number, b: number, countB: number, ambiguous: number, out: number): number;
  ls_feature_words(features: number, count: number, out: number): number;
  ls_consistency_mask(
    rgba: number,
    labels: number,
    width: number,
    height: number,
    region: number,
    code: number,
    poseX: number,
    poseY: number,
    prev: number,
    next: number,
    vote: number,
    factor: number,
    noise: number,
    out: number,
  ): number;
  ls_png_filter_sub(rgba: number, width: number, height: number, out: number): number;
  ls_png_encode(rgba: number, width: number, height: number): number;
  ls_png_encode_len(handle: number): number;
  ls_png_encode_read(handle: number, out: number): number;
  ls_png_encode_free(handle: number): void;
  ls_png_decode(src: number, len: number, out: number, cap: number): number;
  ls_crc32(ptr: number, len: number): number;
  ls_mean_difference(a: number, b: number, len: number): number;
  ls_translation_hypotheses(matches: number, count: number, max: number, out: number): number;
  ls_detect_scale(matches: number, count: number): number;
  ls_verify_translation(a: number, aw: number, ah: number, b: number, bw: number, bh: number, dx: number, dy: number, roi: number): number;
  ls_audit_translation(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    dx: number,
    dy: number,
    roi: number,
    tolerant: number,
    out: number,
  ): number;
  ls_refine_translation(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    px: number,
    py: number,
    roi: number,
    radius: number,
    out: number,
  ): number;
  ls_estimate_motion(
    a: number,
    b: number,
    width: number,
    height: number,
    matches: number,
    count: number,
    featureCount: number,
    out: number,
  ): number;
  ls_refine_native(
    a: number,
    b: number,
    width: number,
    height: number,
    gx: number,
    gy: number,
    region: number,
    labels: number,
    code: number,
    radius: number,
    guide: number,
    guideWidth: number,
    guideHeight: number,
    factor: number,
    out: number,
  ): number;
  ls_refine_patches(
    patches: number,
    count: number,
    native: number,
    width: number,
    height: number,
    region: number,
    gx: number,
    gy: number,
    radius: number,
    out: number,
  ): number;
  ls_resample_gray(gray: number, width: number, height: number, scale: number, out: number): number;
  ls_extract_patches(
    native: number,
    width: number,
    height: number,
    region: number,
    features: number,
    featureCount: number,
    factor: number,
    count: number,
    size: number,
    out: number,
  ): number;
  ls_probe_scale(
    previous: number,
    pw: number,
    ph: number,
    current: number,
    cw: number,
    ch: number,
    currentFeatures: number,
    featureCount: number,
    roi: number,
    scales: number,
    scaleCount: number,
    out: number,
  ): number;
  ls_tiles_new(size: number, memoryMB: number): number;
  ls_tiles_free(handle: number): void;
  ls_tiles_max(handle: number): number;
  ls_tiles_set_max(handle: number, max: number): number;
  ls_tiles_stats(handle: number, out: number): number;
  ls_tiles_touch(handle: number, canvas: number, canvasLen: number, level: number, x: number, y: number): number;
  ls_tiles_victim(handle: number): number;
  ls_tiles_evict(handle: number, id: number): number;
  ls_tiles_release(handle: number, id: number): void;
  ls_tiles_insert(handle: number, canvas: number, canvasLen: number, level: number, x: number, y: number, stored: number): number;
  ls_tiles_planes(handle: number, id: number, out: number): number;
  ls_tiles_set_dirty(handle: number, id: number, dirty: number): number;
  ls_tiles_set_touched(handle: number, id: number, touched: number): number;
  ls_tiles_dirty(handle: number, settledBefore: number, out: number, capacity: number): number;
  ls_tiles_encoded(handle: number): void;
  ls_tiles_saved(handle: number, id: number): void;
  ls_tiles_observed(handle: number, id: number): number;
  ls_tiles_clear(handle: number): void;
  ls_compositor_new(policy: number, atlasWidth: number, atlasHeight: number): number;
  ls_compositor_free(handle: number): void;
  ls_compositor_begin(handle: number, tiles: number, placement: number, frame: number): number;
  ls_compositor_cancel(handle: number): void;
  ls_compositor_step(handle: number, tiles: number, frame: number, now: number, out: number): number;
  ls_compositor_diagnostics(handle: number, out: number): number;
  ls_compositor_load_temporal(handle: number, canvas: number, canvasLen: number, headers: number, blocks: number, count: number): number;
  ls_compositor_flush(handle: number): number;
  ls_compositor_flush_sizes(handle: number, canvas: number, out: number): number;
  ls_compositor_flush_take(
    handle: number,
    canvas: number,
    idOut: number,
    deletedOut: number,
    headersOut: number,
    blocksOut: number,
  ): number;
  ls_compositor_dispose(handle: number): void;
  ls_voting_new(
    factor: number,
    noise: number,
    nativeWidth: number,
    nativeHeight: number,
    analysisWidth: number,
    analysisHeight: number,
    budgetBytes: number,
    regions: number,
    count: number,
  ): number;
  ls_voting_free(handle: number): void;
  ls_voting_box(handle: number, slot: number, out: number): number;
  ls_voting_interior(handle: number, slot: number, out: number): number;
  ls_voting_observe(handle: number, slot: number, canvas: number, poseX: number, poseY: number, gray: number): number;
  ls_voting_push(handle: number, index: number): number;
  ls_voting_drain(handle: number): number;
  ls_voting_peek(handle: number, out: number): number;
  ls_voting_read(handle: number, which: number, bits: number, clean: number): number;
  ls_voting_pop(handle: number): number;
  ls_reveal_new(input: number, len: number): number;
  ls_reveal_free(handle: number): void;
  ls_reveal_memory(handle: number, fits: number, coreBytes: number): number;
  ls_reveal_observation(handle: number, input: number, len: number): number;
  ls_reveal_frame(handle: number): number;
  ls_reveal_push(handle: number, index: number, labels: number, labelLength: number): number;
  ls_reveal_end(handle: number, labels: number, labelLength: number): number;
  ls_reveal_step(handle: number, tiles: number, now: number): number;
  ls_reveal_take(handle: number, out: number, len: number): number;
  ls_learner_new(width: number, height: number): number;
  ls_learner_free(handle: number): void;
  ls_learner_add(
    handle: number,
    field: number,
    prev: number,
    current: number,
    prevNative: number,
    currentNative: number,
    nativeWidth: number,
    nativeHeight: number,
  ): number;
  ls_learner_len(handle: number, which: number): number;
  ls_learner_read(handle: number, which: number, out: number): number;
  ls_learner_finish(handle: number, nativeWidth: number, nativeHeight: number, factor: number, manual: number, manualCount: number): number;
  ls_learner_take(handle: number, out: number, length: number): number;
  ls_scan_new(width: number, height: number, factor: number): number;
  ls_scan_free(handle: number): void;
  ls_scan_frame(handle: number): number;
  ls_scan_is_duplicate(handle: number): number;
  ls_scan_push(handle: number, index: number, time: number, duration: number, gray: number, grayLength: number): number;
  ls_scan_finish(handle: number, manual: number, manualCount: number): number;
  ls_scan_take(handle: number, out: number, length: number): number;
  ls_scan_estimate_motion(
    a: number,
    b: number,
    width: number,
    height: number,
    aFeatures: number,
    aCount: number,
    bFeatures: number,
    bCount: number,
    flags: number,
    out: number,
  ): number;
  ls_stationary_boundary(
    rgba: number,
    width: number,
    height: number,
    axis: number,
    from: number,
    to: number,
    crossFrom: number,
    crossTo: number,
    choose: number,
  ): number;
  ls_sticky_occlusions(
    previous: number,
    current: number,
    width: number,
    height: number,
    region: number,
    motionX: number,
    motionY: number,
    carry: number,
    carryCount: number,
    blocks: number,
    blockCount: number,
    blockMotionX: number,
    blockMotionY: number,
    blockMeasured: number,
    out: number,
  ): number;
  ls_regions_finish(desc: number): number;
  ls_regions_free(handle: number): void;
  ls_regions_count(handle: number): number;
  ls_regions_cells_total(handle: number): number;
  ls_regions_read_headers(handle: number, out: number): number;
  ls_regions_read_masks(handle: number, out: number): number;
  ls_regions_read_cells(handle: number, out: number): number;
  ls_regions_label_atlas(
    regions: number,
    count: number,
    width: number,
    height: number,
    epochs: number,
    epochsLength: number,
    frame: number,
    labelsOut: number,
    countsOut: number,
  ): number;
  ls_regions_epoch_starts(epochs: number, epochsLength: number, count: number, out: number, capacity: number): number;
  ls_regions_epoch_index(starts: number, count: number, frame: number): number;
  ls_render_new(input: number, len: number): number;
  ls_render_free(handle: number): void;
  ls_render_take(handle: number, out: number, len: number): number;
  ls_render_configure_tiles(handle: number, tiles: number, memoryMB: number): number;
  ls_render_wanted_votes(handle: number, index: number, hasPrev: number, hasNext: number): number;
  ls_render_add_plans(handle: number, input: number, len: number): number;
  ls_render_begin(handle: number, input: number, len: number): number;
  ls_render_step(handle: number, compositor: number, tiles: number, graph: number, labels: number, labelsLen: number, now: number): number;
  ls_render_provide_meta(handle: number, input: number, len: number): number;
  ls_render_frame_slot(handle: number, index: number, out: number): number;
  ls_render_cancel(handle: number, compositor: number): void;
  ls_render_begin_finish(handle: number): number;
  ls_render_patch_reference(handle: number, rgba: number, width: number, height: number, frame: number): number;
  ls_render_meta(handle: number, input: number, len: number): number;
  ls_render_dirty_metas(handle: number): number;
  ls_pose_graph_new(): number;
  ls_pose_graph_free(handle: number): void;
  ls_pose_graph_take(handle: number, out: number, len: number): number;
  ls_pose_graph_hydrate(handle: number, input: number, len: number): number;
  ls_pose_graph_add(handle: number, input: number, len: number): number;
  ls_pose_graph_connect(handle: number, input: number, len: number): number;
  ls_pose_graph_unpin(handle: number, input: number, len: number): number;
  ls_pose_graph_get(handle: number, input: number, len: number): number;
  ls_pose_graph_correction(handle: number, input: number, len: number, frame: number, out: number): number;
  ls_pose_graph_loops(handle: number): number;
  ls_pose_graph_optimize_begin(handle: number): number;
  ls_pose_graph_optimize_step(handle: number, sweeps: number): number;
  ls_pose_graph_optimize_finish(handle: number): number;
  ls_pose_graph_optimize_cancel(handle: number): void;
  ls_solve_new(input: number, len: number, shapes: number): number;
  ls_solve_free(handle: number): void;
  ls_solve_take(handle: number, out: number, len: number): number;
  ls_solve_begin(handle: number, index: number, time: number, duplicate: number, zoom: number, difference: number): number;
  ls_solve_frame(handle: number): number;
  ls_solve_run(handle: number, gray: number, grayLen: number, features: number, featureCount: number, labels: number): number;
  ls_solve_provide(handle: number, input: number, len: number, labels: number): number;
  ls_solve_effects(handle: number): number;
  ls_solve_drain(handle: number): number;
  ls_solve_take_graph(handle: number): number;
  ls_keyframe_index_new(): number;
  ls_keyframe_index_free(handle: number): void;
  ls_keyframe_index_add(handle: number, input: number, len: number, features: number, count: number): number;
  ls_keyframe_index_retrieve(handle: number, input: number, len: number, features: number, count: number): number;
  ls_keyframe_index_take(handle: number, out: number, len: number): number;
  ls_keyframe_index_admits(handle: number, frame: number): number;
  ls_track_uncertainty(confidence: number, ambiguous: number, weakStep: number): number;
  ls_track_relocalize_verdict(hasMatch: number, ambiguous: number, confidence: number, zoomChange: number): number;
  ls_track_fragment_cause_gate(zoomChange: number, hasPreviousGray: number, blind: number): number;
  ls_track_occlusion_eligible(hasPrevious: number, kindMoving: number, decision: number): number;
  ls_track_target_pose(kx: number, ky: number, ox: number, oy: number, sx: number, sy: number, out: number): number;
  ls_track_attach_verdict(
    hasGlobal: number,
    kx: number,
    ky: number,
    ox: number,
    oy: number,
    ambiguous: number,
    confidence: number,
    resolvedTargetEqCanvas: number,
    sx: number,
    sy: number,
    out: number,
  ): number;
  ls_track_odometry_weight(weakStep: number): number;
  ls_track_thin_overlap_eligible(weakStep: number, weak: number, ambiguous: number, confidence: number, error: number): number;
  ls_track_thin_overlap_correction(ckx: number, cky: number, ox: number, oy: number, px: number, py: number, out: number): number;
  ls_track_loop_closure_verdict(
    gkx: number,
    gky: number,
    gox: number,
    goy: number,
    gAmbiguous: number,
    gConfidence: number,
    sx: number,
    sy: number,
    px: number,
    py: number,
    out: number,
  ): number;
  ls_track_needs_keyframe(
    kindMoving: number,
    hasAnchor: number,
    ax: number,
    ay: number,
    px: number,
    py: number,
    hasLastNode: number,
    lastNodeFrame: number,
    rectW: number,
    rectH: number,
    frameIndex: number,
    fieldDifference: number,
  ): number;
  ls_track_zoom_changed(hasRegionZoom: number, regionZoom: number, fieldZoom: number): number;
  ls_track_region_zoom(kindMoving: number, matches: number, count: number): number;
  ls_track_odometry(
    previous: number,
    current: number,
    imageWidth: number,
    imageHeight: number,
    previousGray: number,
    g: number,
    grayWidth: number,
    grayHeight: number,
    previousFeatures: number,
    previousFeatureCount: number,
    ownFeatures: number,
    ownFeatureCount: number,
    roi: number,
    rect: number,
    region: number,
    labels: number,
    code: number,
    f: number,
    radius: number,
    vx: number,
    vy: number,
    confidence: number,
    out: number,
  ): number;
  ls_track_reacquire(
    anchorFeatures: number,
    anchorFeatureCount: number,
    ownFeatures: number,
    ownFeatureCount: number,
    anchorPatches: number,
    patchCount: number,
    rect: number,
    f: number,
    radius: number,
    nativeMode: number,
    nativePtr: number,
    currentFramePtr: number,
    alreadyFilled: number,
    nativeWidth: number,
    nativeHeight: number,
    out: number,
  ): number;
  ls_track_drift_correction(
    anchorPatches: number,
    patchCount: number,
    rect: number,
    ax: number,
    ay: number,
    px: number,
    py: number,
    radius: number,
    nativeMode: number,
    nativePtr: number,
    currentFramePtr: number,
    alreadyFilled: number,
    nativeWidth: number,
    nativeHeight: number,
    out: number,
  ): number;
  ls_keyframes_evaluate_candidates(
    keyframes: number,
    keyframeCount: number,
    features: number,
    featureCount: number,
    gray: number,
    grayWidth: number,
    grayHeight: number,
    roi: number,
    region: number,
    factor: number,
    radius: number,
    nativeMode: number,
    nativePtr: number,
    currentFramePtr: number,
    alreadyFilled: number,
    nativeWidth: number,
    nativeHeight: number,
    out: number,
  ): number;
  ls_frame_layout(sourceWidth: number, sourceHeight: number, pane: number, boundsWidth: number, boundsHeight: number, out: number): number;
  ls_frame_coordinate(layout: number, x: number, y: number, out: number): number;
  ls_framing_new(input: number, len: number, ignore: number, ignoreCount: number): number;
  ls_framing_free(handle: number): void;
  ls_framing_reference(handle: number, frame: number, rgba: number, width: number, height: number): number;
  ls_framing_index(handle: number, x: number, y: number, observed: number): number;
  ls_framing_step(handle: number, tiles: number, now: number): number;
  ls_framing_take(handle: number, out: number, len: number): number;
  ls_framing_detached(handle: number, out: number): number;
}

/** Byte layouts shared with `rust/wasm/src/wire.rs`. Asserted against the live module's `ls_layout` once
 *  when `Core` is constructed (see `assertLayout`), so the two sides can no longer drift silently — historically
 *  only the feature/match sizes (`ls_feature_bytes`/`ls_match_bytes`) were checked at runtime. */
export const MATCH_POINT_BYTES = 40,
  MOTION_BYTES = 48,
  MOTION_FIELD_HEADER = 40,
  REFINEMENT_BYTES = 32,
  PATCH_BYTES = 16,
  MOTION_CELL = 24;
export const COMPOSITE_HEADER = 24, VOTING_REGION_BYTES = 64, LEARNER_MOTION_BYTES = 32, LEARNER_FIELD_BYTES = 40;
/** `ls_regions_finish` request descriptor, and one output region header (`rust/wasm/src/regions.rs`). */
export const REGIONS_FINISH_DESC_BYTES = 120, REGION_HEADER_BYTES = 88;
/** One hand-placed region descriptor (`rust/wasm/src/regions.rs::MANUAL_REGION_BYTES`): rect, u32 kind, padding. */
export const MANUAL_REGION_BYTES = 40;
/** One serialised `framing::Layout` (`rust/wasm/src/framing.rs`). */
export const LAYOUT_BYTES = 104;
/** Named accumulator arrays `rust/wasm/src/layers.rs::learner_array` recognises — must match
 *  `./learner.ts`'s `LEARNER_ARRAYS.length` (selector 14, "counts", is separate and not part of this count). */
export const LEARNER_ARRAY_COUNT = 17;
/** `ls_extract_patches`'/`ls_probe_scale`'s serialised `(x, y)` feature point: f64, f64. */
export const POINT_BYTES = 16;
/** One `ls_extract_patches` output patch header, immediately followed by its `size × size` data bytes. */
export const EXTRACTED_PATCH_HEADER_BYTES = 24;
/** `ls_keyframes_evaluate_candidates`'s per-keyframe descriptor and its single chosen-candidate output record
 *  (`rust/wasm/src/track_keyframes.rs::KEYFRAME_BYTES`/`CANDIDATE_RECORD_BYTES`). */
export const KEYFRAME_BYTES = 64, CANDIDATE_RECORD_BYTES = 56;
/** `ls_track_drift_correction`'s output record (`rust/wasm/src/track_reacquire.rs::TRACK_DRIFT_CORRECTION_OUT_BYTES`). */
export const TRACK_DRIFT_CORRECTION_OUT_BYTES = 40;

/** Selector → constant, in the order `rust/wasm/src/lib.rs::ls_layout` matches them. */
const LAYOUT = [
  MATCH_POINT_BYTES,
  MOTION_BYTES,
  MOTION_FIELD_HEADER,
  REFINEMENT_BYTES,
  PATCH_BYTES,
  COMPOSITE_HEADER,
  VOTING_REGION_BYTES,
  LEARNER_MOTION_BYTES,
  LEARNER_FIELD_BYTES,
  MOTION_CELL,
  REGIONS_FINISH_DESC_BYTES,
  REGION_HEADER_BYTES,
  LEARNER_ARRAY_COUNT,
  LAYOUT_BYTES,
  POINT_BYTES,
  EXTRACTED_PATCH_HEADER_BYTES,
  KEYFRAME_BYTES,
  CANDIDATE_RECORD_BYTES,
  TRACK_DRIFT_CORRECTION_OUT_BYTES,
];

/** Throws a clear error the moment a Rust/TS byte-layout constant has drifted, instead of a wrong answer or an
 *  out-of-bounds panic somewhere downstream. */
export function assertLayout(exports: CoreExports): void {
  if (typeof exports.ls_layout !== 'function') {
    throw new Error('CORE_LAYOUT_MISMATCH: module predates ls_layout (stale build?)');
  }
  for (const [which, expected] of LAYOUT.entries()) {
    const actual = exports.ls_layout(which);
    if (actual !== expected) {
      throw new Error(`CORE_LAYOUT_MISMATCH: ls_layout(${which}) = ${actual}, TS expects ${expected}.`);
    }
  }
}

const STATUS: Record<number, string> = { [-1]: 'CORE_BAD_ARGUMENT' };
/** Rust reports an unknown PNG filter byte as −256 − byte; the message keeps naming the byte, as the TS decoder did. */
export const BAD_FILTER = -256;

/** Throws when `status` is negative (a kernel's bad-argument or bad-PNG-filter convention); otherwise returns it
 *  unchanged so a count/length/handle result can be used inline. */
export function check(status: number, what: string): number {
  if (status <= BAD_FILTER && status > BAD_FILTER - 256) throw new Error(`Invalid PNG filter ${BAD_FILTER - status}.`);
  if (status < 0) throw new Error(`${STATUS[status] || 'CORE_FAILURE'}: ${what} (status ${status}).`);
  return status;
}
