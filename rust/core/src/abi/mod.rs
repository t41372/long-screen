//! `extern "C"` surface consumed by the TypeScript adapter (`src/core/wasm.ts`). One file per domain mirrors
//! `src/core/wasm/*.ts`; `memory.rs` and `wire.rs` hold the plumbing every domain shares.
//!
//! Memory contract: the adapter allocates every buffer through `ls_alloc`/`ls_free`, writes inputs,
//! calls a kernel, and reads outputs. Kernels never allocate host-visible memory themselves and never
//! retain pointers between calls. Every pointer is validated against linear memory before use; an
//! invalid request returns a negative status instead of trapping.
//!
//! Error conventions (five, by export — TS depends on each; do not change any of them):
//!   1. `STATUS_OK` (0) / `STATUS_BAD_ARGUMENT` (−1): most exports that write through an output pointer.
//!   2. `STATUS_OK` / `STATUS_BAD_ARGUMENT` / `STATUS_BAD_FILTER − filter_byte`: `ls_png_unfilter` only.
//!   3. A non-negative count or length, `STATUS_BAD_ARGUMENT` on failure: extraction/matching exports
//!      (`ls_extract_features`, `ls_match_features`, `ls_feature_words`, `ls_translation_hypotheses`,
//!      `ls_sticky_occlusions`, `ls_voting_push`/`_drain`/`_pop`, `ls_learner_len`), plus `ls_voting_peek`,
//!      which additionally returns −2 for "no pending record" (not a bad argument).
//!   4. A handle (> 0) or `STATUS_BAD_ARGUMENT`: `ls_learner_new`, `ls_voting_new`.
//!   5. A plain numeric result with its own out-of-band sentinel, no status code: `ls_stationary_boundary`
//!      (−1.0 none, −2.0 bad argument), `ls_verify_translation` (`NaN` bad argument), `ls_detect_scale` and
//!      `ls_mean_difference` (a neutral default — 1.0 / 255.0 — on a bad argument, since callers cannot branch
//!      on a status here).

mod chrome;
mod composite;
mod consistency;
mod features;
mod framing;
mod learner;
mod memory;
mod motion;
mod png;
mod pose_graph;
mod pyramid;
mod raster;
mod regions;
mod temporal;
mod track;
pub(crate) mod voting;
pub(crate) mod wire;

pub const STATUS_OK: i32 = 0;
pub const STATUS_BAD_ARGUMENT: i32 = -1;
/// PNG filter failures are `STATUS_BAD_FILTER - filter_byte` (−256 … −511).
pub const STATUS_BAD_FILTER: i32 = -256;

/// Selectors for `ls_layout`, in the order the byte sizes/selector numbers are duplicated as TS constants
/// (`src/core/wasm/exports.ts`). `Core`'s constructor asserts every one against this export once, so the two
/// sides can no longer drift silently.
#[no_mangle]
pub extern "C" fn ls_layout(which: u32) -> u32 {
    use crate::motion::MOTION_CELL;
    use framing::LAYOUT_BYTES;
    use learner::LEARNER_ARRAY_COUNT;
    use regions::{REGIONS_FINISH_DESC_BYTES, REGION_HEADER_BYTES};
    use wire::{
        COMPOSITE_HEADER_BYTES, LEARNER_FIELD_BYTES, LEARNER_MOTION_BYTES, MATCH_POINT_BYTES,
        MOTION_BYTES, MOTION_FIELD_HEADER_BYTES, PATCH_BYTES, REFINEMENT_BYTES,
        VOTING_REGION_BYTES,
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
        _ => 0,
    }) as u32
}

/// Parks the calling helper instance in the shared-memory pool; only valid in the threaded build.
#[no_mangle]
pub extern "C" fn ls_pool_worker() {
    crate::pool::worker_loop()
}

/// Helper threads currently parked in the pool.
#[no_mangle]
pub extern "C" fn ls_pool_helpers() -> u32 {
    crate::pool::helpers() as u32
}
