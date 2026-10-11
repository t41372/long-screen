# long-screen-engine

One [Long Screen](https://github.com/t41372/long-screen) reconstruction run as a state machine: the scan, solve, render, reveal, framing and preview-pyramid passes over [`long-screen-core`](https://crates.io/crates/long-screen-core)'s algorithms, plus the structured diagnostics and the zh/en message catalogue that formats them.

The engine does no I/O, never blocks and reads no clock. A host drives each pass one step at a time: it hands a session a frame (and the rows it stored for that frame earlier), stores the rows the step returns, shows its diagnostics, and checks for pause and stop between steps. The Long Screen web page is one such host (through WebAssembly) and the [`long-screen`](https://crates.io/crates/long-screen) crate is another.

This is an implementation layer. Most Rust users want `long-screen`, which drives every pass in order on a video file or on RGBA frames and keeps the rows in memory. The engine's API follows what those hosts need and may change between minor versions. It compiles for `wasm32-unknown-unknown`.

## Example

Run the scan pass by hand over a few frames of a page scrolling up by 6 pixels a frame:

```rust
use long_screen_engine::scan::{FrameMeta, ScanSession};

let (width, height) = (320, 240);
let page = |x: usize, y: usize| ((x * 37 + y * 101 + (x * y) % 23) % 251) as u8;
let mut scan = ScanSession::new(width, height, 1);
for index in 0..4u32 {
    let offset = index as usize * 6;
    for (i, pixel) in scan.frame_buffer().chunks_exact_mut(4).enumerate() {
        let v = page(i % width, i / width + offset);
        pixel.copy_from_slice(&[v, v, v, 255]);
    }
    let step = scan
        .push(FrameMeta { index, time: index as f64 / 30.0, duration: 1.0 / 30.0 }, None)
        .expect("a frame was written");
    for diagnostic in &step.diagnostics {
        println!("frame {index}: {}", diagnostic.code);
    }
}
let regions = scan.finish(&[]);
println!("{} region(s)", regions.regions.len());
```

## Features

- `catalog` (default): the embedded zh/en diagnostic and progress catalogue and its formatter (`catalog::format`), which reproduces the web page's messages exactly. Turn it off to keep `serde_json` out of a build that formats messages itself, as the web page's WebAssembly does.

## Related crates

- [`long-screen-core`](https://crates.io/crates/long-screen-core): the algorithms.
- [`long-screen-decode`](https://crates.io/crates/long-screen-decode): native video decoding.
- [`long-screen`](https://crates.io/crates/long-screen): the native driver library and the `long-screen` command line.

## License

MIT © 2026 Yi-Ting Chiu
