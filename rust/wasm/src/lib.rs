//! `extern "C"` surface of the `long-screen` crate's kernels and engine consumed by the TypeScript adapter
//! (`src/core/wasm.ts`). This crate is the only place with FFI: the algorithms it calls carry none. One file per
//! domain mirrors `src/core/wasm/*.ts`; `memory.rs` and `wire.rs` hold the plumbing every domain shares.
//!
//! Memory contract: the adapter allocates every buffer through `ls_alloc`/`ls_free`, writes inputs,
//! calls a kernel, and reads outputs. Kernels never allocate host-visible memory themselves and never
//! retain pointers between calls. Every pointer is validated against linear memory before use; an
//! invalid request returns a negative status instead of trapping.
//!
//! Error conventions (six, by export — TS depends on each; do not change any of them):
//!   1. `STATUS_OK` (0) / `STATUS_BAD_ARGUMENT` (−1): most exports that write through an output pointer.
//!   2. `STATUS_OK` / `STATUS_BAD_ARGUMENT` / `STATUS_BAD_FILTER − filter_byte`: `ls_png_decode` only.
//!   3. A non-negative count or length, `STATUS_BAD_ARGUMENT` on failure: extraction/matching exports
//!      (`ls_extract_features`, `ls_match_features`, `ls_feature_words`, `ls_translation_hypotheses`,
//!      `ls_sticky_occlusions`, `ls_voting_push`/`_drain`/`_pop`, `ls_learner_len`, `ls_keyframes_evaluate_candidates`,
//!      `ls_extract_patches`), plus `ls_voting_peek`, which additionally returns −2 for "no pending record" (not
//!      a bad argument), and `ls_probe_scale`, whose count is 0 or 1 (no candidate passed the gates / one did,
//!      written to `out`).
//!   4. A handle (> 0) or `STATUS_BAD_ARGUMENT`: `ls_learner_new`, `ls_voting_new`, `ls_pose_graph_new`,
//!      `ls_temporal_index_new`, `ls_png_encode`, `ls_pyramid_new`, `ls_framing_new`, `ls_reveal_new`.
//!   5. A plain numeric result with its own out-of-band sentinel, no status code: `ls_stationary_boundary`
//!      (−1.0 none, −2.0 bad argument), `ls_verify_translation` (`NaN` bad argument), `ls_detect_scale` and
//!      `ls_mean_difference` (a neutral default — 1.0 / 255.0 — on a bad argument, since callers cannot branch
//!      on a status here).
//!   6. A result length (≥ 0, the result waiting in the handle for its `_take`) or a negative status, some with
//!      their own meaning: the engine state objects (`ls_pose_graph_*`, see `pose_graph.rs` for its
//!      missing-node statuses; `ls_keyframe_index_retrieve`; the solve session `ls_solve_*`, whose pose-graph
//!      failures use the same missing-node statuses; `ls_pyramid_step`; `ls_framing_step` and `ls_reveal_step`,
//!      whose −2 is a tile asked for and not inserted; `ls_render_*`, whose step reports a failed frame as a result
//!      record carrying the message rather than as a status).

mod bytes;
mod chrome;
mod compositor;
mod consistency;
mod diagnostic;
mod features;
mod framing;
mod keyframes;
mod layers;
mod memory;
mod motion;
mod png;
mod pose_graph;
mod pyramid;
mod raster;
mod regions;
mod render;
mod resize;
mod reveal;
mod scan;
mod solve;
mod temporal;
mod tiles;
mod track;
mod track_keyframes;
mod track_odometry;
mod track_reacquire;
pub(crate) mod voting;
pub(crate) mod wire;
mod yuv;

pub const STATUS_OK: i32 = 0;
pub const STATUS_BAD_ARGUMENT: i32 = -1;
/// PNG filter failures are `STATUS_BAD_FILTER - filter_byte` (−256 … −511).
pub const STATUS_BAD_FILTER: i32 = -256;

/// Selectors for `ls_layout`, in the order the byte sizes/selector numbers are duplicated as TS constants
/// (`src/core/wasm/exports.ts`). `Core`'s constructor asserts every one against this export once, so the two
/// sides can no longer drift silently.
#[no_mangle]
pub extern "C" fn ls_layout(which: u32) -> u32 {
    use framing::LAYOUT_BYTES;
    use layers::LEARNER_ARRAY_COUNT;
    use long_screen::kernels::motion::MOTION_CELL;
    use regions::{REGIONS_FINISH_DESC_BYTES, REGION_HEADER_BYTES};
    use track_keyframes::{CANDIDATE_RECORD_BYTES, KEYFRAME_BYTES};
    use track_reacquire::TRACK_DRIFT_CORRECTION_OUT_BYTES;
    use wire::{
        COMPOSITE_HEADER_BYTES, EXTRACTED_PATCH_HEADER_BYTES, LEARNER_FIELD_BYTES,
        LEARNER_MOTION_BYTES, MATCH_POINT_BYTES, MOTION_BYTES, MOTION_FIELD_HEADER_BYTES,
        PATCH_BYTES, POINT_BYTES, REFINEMENT_BYTES, VOTING_REGION_BYTES,
    };
    (match which {
        0 => MATCH_POINT_BYTES,
        1 => MOTION_BYTES,
        2 => MOTION_FIELD_HEADER_BYTES,
        3 => REFINEMENT_BYTES,
        4 => PATCH_BYTES,
        5 => COMPOSITE_HEADER_BYTES,
        6 => VOTING_REGION_BYTES,
        7 => LEARNER_MOTION_BYTES,
        8 => LEARNER_FIELD_BYTES,
        9 => MOTION_CELL,
        10 => REGIONS_FINISH_DESC_BYTES,
        11 => REGION_HEADER_BYTES,
        12 => LEARNER_ARRAY_COUNT,
        13 => LAYOUT_BYTES,
        14 => POINT_BYTES,
        15 => EXTRACTED_PATCH_HEADER_BYTES,
        16 => KEYFRAME_BYTES,
        17 => CANDIDATE_RECORD_BYTES,
        18 => TRACK_DRIFT_CORRECTION_OUT_BYTES,
        _ => 0,
    }) as u32
}

/// Parks the calling helper instance in the shared-memory pool; only valid in the threaded build.
#[no_mangle]
pub extern "C" fn ls_pool_worker() {
    long_screen::kernels::pool::worker_loop()
}

/// Helper threads currently parked in the pool.
#[no_mangle]
pub extern "C" fn ls_pool_helpers() -> u32 {
    long_screen::kernels::pool::helpers() as u32
}
