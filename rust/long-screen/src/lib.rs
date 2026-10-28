//! Long Screen as a native library: a screen recording in, one big screenshot out.
//!
//! [`run`] drives the same engine the web page runs, pass by pass and in the same order — scan, solve, render,
//! reveal, framing, preview pyramid — over a [`FrameSource`] (a video file decoded natively by `VideoSource`, or
//! RGBA frames you already have). It keeps the rows the page would keep in IndexedDB in an in-memory [`Store`],
//! formats diagnostics with the page's own zh/en catalogue, reports progress and diagnostics to an [`Observer`], and
//! honours pause and stop through a [`Control`] between steps. The [`RunResult`] holds the canvases (the print, its
//! framed presentation and any separate fragments) as tiles, and writes any of them as a PNG of any size, streamed
//! band by band.
//!
//! The command-line tool `long-screen` (feature `cli`) is a thin layer over this crate; a desktop app or a Python
//! binding can drive it the same way.
//!
//! ```no_run
//! use long_screen::{run, Control, DecodeOptions, Options, VideoSource};
//!
//! let mut source = VideoSource::open("recording.mov".as_ref(), DecodeOptions::default())?;
//! let control = Control::new(); // clone it to another thread to pause or stop the run
//! let mut on_progress = |p: &long_screen::Progress| eprintln!("{} {:.0}%", p.phase, p.fraction * 100.0);
//! let result = run(&mut source, &Options::default(), &mut on_progress, &control)?;
//! if let Some(print) = result.print() {
//!     let file = std::fs::File::create("print.png")?;
//!     result.write_png(&print.id, std::io::BufWriter::new(file))?;
//! }
//! for d in result.diagnostics() {
//!     eprintln!("{} {}: {}", d.severity, d.code, d.message);
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Layers
//!
//! The crate root is the driver API. Under it sit the layers the driver, the web page's WebAssembly and the
//! benchmarks are built from. They are public so those builds can reach them, but they are implementation layers:
//! their API follows what those hosts need and may change in minor versions.
//!
//! - [`kernels`]: the reconstruction algorithms (motion, regions and layers, tracking, the pose graph, compositing,
//!   reveal, framing, the preview pyramid, YUV→RGBA), with no I/O. Compiles for `wasm32-unknown-unknown`.
//! - [`engine`]: one run as a state machine over the kernels, driven step by step by a host that stores the rows.
//!   Compiles for `wasm32-unknown-unknown`.
//! - `decode` (feature `decode`): native video decoding with the system decoder or a user-installed ffmpeg.
//!
//! # Features
//!
//! - `driver` (default): the driver API at the crate root ([`run`], [`Options`], [`RunResult`], the sources, the
//!   in-memory [`Store`]). Implies `catalog`.
//! - `decode` (default): the `decode` module and `VideoSource` (AVFoundation on macOS, Media Foundation on Windows,
//!   ffmpeg everywhere). Re-exports its options as `DecodeOptions` and `DecodeBackend`.
//! - `rayon` (default): the kernels run on rayon's thread pool. Results do not depend on the thread count.
//! - `catalog` (default): the embedded zh/en diagnostic and progress catalogue and its formatter
//!   (`engine::catalog`), which reproduces the web page's messages exactly.
//! - `cli` (default): the `long-screen` command line and its argument parser. Implies `driver` and `decode`.
//!
//! With `default-features = false` only [`kernels`] and [`engine`] remain, which is what the web page's
//! WebAssembly builds.

// The threaded WebAssembly build is compiled with RUSTC_BOOTSTRAP for -Zbuild-std; wait/notify are still unstable
// there (kernels::pool).
#![cfg_attr(target_feature = "atomics", feature(stdarch_wasm_atomic_wait))]
// The crate docs above link the driver's items, which a build without the `driver` feature does not have.
#![cfg_attr(not(feature = "driver"), allow(rustdoc::broken_intra_doc_links))]

#[cfg(feature = "decode")]
pub mod decode;
pub mod engine;
pub mod kernels;

#[cfg(feature = "driver")]
mod context;
#[cfg(feature = "driver")]
mod driver;
#[cfg(feature = "driver")]
mod output;
#[cfg(feature = "driver")]
mod package;
#[cfg(feature = "driver")]
mod present;
#[cfg(feature = "driver")]
mod render;
#[cfg(feature = "driver")]
mod reveal;
#[cfg(feature = "driver")]
mod scan;
#[cfg(feature = "driver")]
mod solve;
#[cfg(feature = "driver")]
pub mod source;
#[cfg(feature = "driver")]
pub mod store;
#[cfg(feature = "driver")]
mod tiles;
#[cfg(feature = "driver")]
pub mod value;

#[cfg(feature = "decode")]
pub use decode::{Backend as DecodeBackend, Options as DecodeOptions};
#[cfg(feature = "driver")]
pub use driver::*;

// The crate README's examples, compiled by `cargo test --doc`.
#[cfg(all(doctest, feature = "driver", feature = "decode"))]
#[doc = include_str!("../README.md")]
pub struct ReadmeDoctests;
