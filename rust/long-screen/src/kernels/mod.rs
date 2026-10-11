//! The reconstruction algorithms: features and motion evidence, region and layer learning, tracking, the pose
//! graph, compositing with temporal conflicts, reveal, framing and the preview pyramid, plus the YUV→RGBA and PNG
//! row kernels.
//!
//! Every pixel algorithm lives here, with no FFI and no I/O. The browser reaches it through the `extern "C"`
//! exports of `long-screen-wasm` (rust/wasm), compiled three ways: scalar, SIMD128 and SIMD128 + shared-memory
//! threads (see scripts/build-core.sh). The TypeScript side owns browser APIs only (decoding, storage, UI); it must
//! not reimplement anything this module provides.
//!
//! This is an implementation layer, used by the [`engine`](crate::engine), the driver and the web page; most users
//! want the driver at the crate root. Its API follows what those layers need and may change in minor versions.
//! With the `rayon` feature, `pool::par_for` chunks run on rayon's thread pool; results do not depend on the thread
//! count, and the WebAssembly builds leave it off.
//!
//! Check a candidate motion between two grayscale frames: the second frame is the first one scrolled up by 8
//! pixels, and the retained block error is near zero only for the right displacement.
//!
//! ```
//! use long_screen::kernels::motion::{verify_translation, Gray};
//!
//! let (width, height) = (192, 192);
//! let texture = |x: usize, y: usize| ((x * 37 + y * 101 + (x * y) % 23) % 251) as u8;
//! let a: Vec<u8> = (0..height).flat_map(|y| (0..width).map(move |x| texture(x, y))).collect();
//! let b: Vec<u8> = (0..height).flat_map(|y| (0..width).map(move |x| texture(x, y + 8))).collect();
//! let a = Gray { width, height, data: &a };
//! let b = Gray { width, height, data: &b };
//!
//! let right = verify_translation(a, b, 0.0, 8.0, None);
//! let wrong = verify_translation(a, b, 0.0, 0.0, None);
//! println!("error at the right shift {right:.2}, without it {wrong:.2}");
//! assert!(right < wrong);
//! ```

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
