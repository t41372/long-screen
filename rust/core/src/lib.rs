//! Long Screen reconstruction core.
//!
//! Every pixel algorithm the browser adapter needs lives here and is compiled to WebAssembly, three ways:
//! scalar, SIMD128 and SIMD128 + shared-memory threads (see scripts/build-core.sh). The TypeScript side owns
//! browser APIs only (decoding, storage, UI); it must not reimplement anything exported from this crate.
//! `abi` is the only module with `extern "C"` surface.

// The threaded build is compiled with RUSTC_BOOTSTRAP for -Zbuild-std; wait/notify are still unstable there.
#![cfg_attr(target_feature = "atomics", feature(stdarch_wasm_atomic_wait))]

pub mod abi;
pub mod chrome;
pub mod compositor;
pub mod consistency;
pub mod features;
pub mod geometry;
pub mod layers;
pub mod motion;
pub mod png;
pub mod pool;
pub mod pose_graph;
pub mod raster;
pub mod region;
pub mod regions;
pub mod voting;
pub mod yuv;
