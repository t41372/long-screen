//! Long Screen reconstruction core.
//!
//! Every pixel algorithm lives here, with no FFI and no I/O. The browser reaches it through the `extern "C"`
//! exports of `long-screen-wasm` (rust/wasm), compiled three ways: scalar, SIMD128 and SIMD128 + shared-memory
//! threads (see scripts/build-core.sh). The TypeScript side owns browser APIs only (decoding, storage, UI); it must
//! not reimplement anything this crate provides.

// The threaded build is compiled with RUSTC_BOOTSTRAP for -Zbuild-std; wait/notify are still unstable there.
#![cfg_attr(target_feature = "atomics", feature(stdarch_wasm_atomic_wait))]

pub mod chrome;
pub mod compositor;
pub mod consistency;
pub mod features;
pub mod framing;
pub mod geometry;
pub mod layers;
pub mod motion;
pub mod png;
pub mod pool;
pub mod pose_graph;
pub mod pyramid;
pub mod raster;
pub mod region;
pub mod regions;
pub mod reveal;
pub mod temporal;
pub mod track;
pub mod voting;
pub mod yuv;
