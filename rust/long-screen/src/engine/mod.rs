//! One reconstruction run as a state machine over the [`kernels`](crate::kernels).
//!
//! The engine does no I/O and reads no clock. A host drives it one step at a time: each pass (scan, solve, render,
//! reveal, framing, pyramid) is a session that takes one frame (plus the rows the host stored for that frame
//! earlier) and returns what that step produced — rows to write or delete, structured diagnostics, how far it got.
//! The host stores the rows, formats and shows the diagnostics, and checks for pause and stop between steps. The
//! web page's TypeScript loop is one such host (through WebAssembly); the driver at the crate root is another. See
//! docs/ARCHITECTURE.md §十三 for the boundary.
//!
//! Diagnostics carry a code and parameters, never text. `catalog` (feature `catalog`) turns them into the same zh
//! or en sentence the web page shows, from the catalogues exported out of `src/i18n`; the web page's WebAssembly
//! formats them with its own i18n and leaves the feature off.
//!
//! This is an implementation layer, used by the driver and the web page's WebAssembly; most users want the driver
//! at the crate root, which drives every pass in order. Its API follows what those hosts need and may change in
//! minor versions.
//!
//! Run the scan pass by hand over a few frames of a page scrolling up by 6 pixels a frame:
//!
//! ```
//! use long_screen::engine::scan::{FrameMeta, ScanSession};
//!
//! let (width, height) = (320, 240);
//! let page = |x: usize, y: usize| ((x * 37 + y * 101 + (x * y) % 23) % 251) as u8;
//! let mut scan = ScanSession::new(width, height, 1);
//! for index in 0..4u32 {
//!     let offset = index as usize * 6;
//!     for (i, pixel) in scan.frame_buffer().chunks_exact_mut(4).enumerate() {
//!         let v = page(i % width, i / width + offset);
//!         pixel.copy_from_slice(&[v, v, v, 255]);
//!     }
//!     let step = scan
//!         .push(FrameMeta { index, time: index as f64 / 30.0, duration: 1.0 / 30.0 }, None)
//!         .expect("a frame was written");
//!     for diagnostic in &step.diagnostics {
//!         println!("frame {index}: {}", diagnostic.code);
//!     }
//! }
//! let regions = scan.finish(&[]);
//! println!("{} region(s)", regions.regions.len());
//! ```

pub mod attachments;
#[cfg(feature = "catalog")]
pub mod catalog;
pub mod compositor;
pub mod diagnostic;
pub mod framing;
pub mod keyframes;
pub mod layers;
pub mod pose_graph;
pub mod pyramid;
pub mod render;
pub mod reveal;
pub mod scan;
pub mod solve;
pub mod tiles;

#[cfg(test)]
mod host_tests;
#[cfg(test)]
mod presentation_host_tests;
#[cfg(test)]
mod reveal_host_tests;
