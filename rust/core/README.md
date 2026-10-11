# long-screen-core

The reconstruction algorithms of [Long Screen](https://github.com/t41372/long-screen), which turns a screen recording of a page explored along any path into one big screenshot: features and motion evidence, region and layer learning, tracking, the pose graph, compositing with temporal conflicts, reveal, framing and the preview pyramid, plus the YUV→RGBA and PNG row kernels.

This is an implementation layer. Most Rust users want the [`long-screen`](https://crates.io/crates/long-screen) crate, which runs the whole pipeline on a video file or on RGBA frames. The crate has no FFI and does no I/O, and it compiles for `wasm32-unknown-unknown`: the Long Screen web page runs these same functions as WebAssembly. Its API follows what the engine and the web page need and may change between minor versions.

## Example

Check a candidate motion between two grayscale frames: the second frame is the first one scrolled up by 8 pixels, and the retained block error is near zero only for the right displacement.

```rust
use long_screen_core::motion::{verify_translation, Gray};

let (width, height) = (192, 192);
let texture = |x: usize, y: usize| ((x * 37 + y * 101 + (x * y) % 23) % 251) as u8;
let a: Vec<u8> = (0..height).flat_map(|y| (0..width).map(move |x| texture(x, y))).collect();
let b: Vec<u8> = (0..height).flat_map(|y| (0..width).map(move |x| texture(x, y + 8))).collect();
let a = Gray { width, height, data: &a };
let b = Gray { width, height, data: &b };

let right = verify_translation(a, b, 0.0, 8.0, None);
let wrong = verify_translation(a, b, 0.0, 0.0, None);
println!("error at the right shift {right:.2}, without it {wrong:.2}");
assert!(right < wrong);
```

## Features

- `rayon`: runs `pool::par_for` chunks on rayon's thread pool (native hosts). Results do not depend on the thread count. The WebAssembly builds leave it off.

## Related crates

- [`long-screen-engine`](https://crates.io/crates/long-screen-engine): one run as a step-by-step state machine over these algorithms.
- [`long-screen-decode`](https://crates.io/crates/long-screen-decode): native video decoding.
- [`long-screen`](https://crates.io/crates/long-screen): the native driver library and the `long-screen` command line.

## License

MIT © 2026 Yi-Ting Chiu
