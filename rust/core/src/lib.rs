//! Long Screen reconstruction core.
//!
//! Every pixel algorithm the browser adapter needs lives here and is compiled to a single-threaded
//! WebAssembly module. The TypeScript side owns browser APIs only (decoding, storage, UI); it must not
//! reimplement anything exported from this crate. `abi` is the only module with `extern "C"` surface.

pub mod abi;
pub mod chrome;
pub mod compositor;
pub mod consistency;
pub mod features;
pub mod geometry;
pub mod layers;
pub mod motion;
pub mod png;
pub mod raster;
pub mod region;
pub mod voting;
