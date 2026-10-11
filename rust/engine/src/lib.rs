//! Long Screen engine: one reconstruction run as a state machine over `long-screen-core`'s algorithms.
//!
//! The engine does no I/O and reads no clock. A host drives it one step at a time: each pass (scan, solve, render,
//! reveal, framing, pyramid) is a session that takes one frame (plus the rows the host stored for that frame
//! earlier) and returns what that step produced — rows to write or delete, structured diagnostics, how far it got.
//! The host stores the rows, formats and shows the diagnostics, and checks for pause and stop between steps. The
//! web page's TypeScript loop is one such host; the native command line and desktop app are others. See
//! docs/ARCHITECTURE.md §十三 for the boundary and the migration order.
//!
//! Diagnostics carry a code and parameters, never text. [`catalog`] turns them into the same zh or en sentence the
//! web page shows, from the catalogues exported out of `src/i18n`.
//!
//! This crate is an implementation layer, used by the `long-screen` driver and the web page's WebAssembly; most Rust
//! users want the `long-screen` crate, which drives every pass in order. Its API follows what those hosts need and
//! may change between minor versions.

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

// The crate README's examples, compiled and run by `cargo test --doc`.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
pub struct ReadmeDoctests;

#[cfg(test)]
mod host_tests;
#[cfg(test)]
mod presentation_host_tests;
#[cfg(test)]
mod reveal_host_tests;
