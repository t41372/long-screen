# long-screen

[Long Screen](https://github.com/t41372/long-screen) as a Rust library and a command line: a screen recording of a page explored along any path in, one big screenshot out.

`long_screen::run` drives the same engine the [Long Screen web page](https://github.com/t41372/long-screen) runs, pass by pass and in the same order (scan, solve, render, reveal, framing, preview pyramid), over a video file decoded natively or over RGBA frames you already have. It reports progress and diagnostics to an observer, honours pause and stop from another thread, and returns the print, its framed presentation and any separate fragments as tiles that it writes out as PNG at any size. The rows it keeps match the web page's row for row. Reconstruction is heuristic: a completed run does not prove the result is correct, and what it could not resolve comes back as diagnostics and separate fragments.

## Command line

```sh
cargo install long-screen
long-screen recording.mov -o print.png
long-screen recording.mov --package result.zip   # also the web app's result package: tiles, offline viewer, diagnostics
```

## Library

```toml
[dependencies]
long-screen = { version = "0.1", default-features = false, features = ["driver", "decode", "rayon"] } # without the command line's clap
```

```rust,no_run
use long_screen::{run, Control, DecodeOptions, Options, VideoSource};

let mut source = VideoSource::open("recording.mov".as_ref(), DecodeOptions::default())?;
let control = Control::new(); // clone it to another thread to pause or stop the run
let mut on_progress = |p: &long_screen::Progress| eprintln!("{} {:.0}%", p.phase, p.fraction * 100.0);
let result = run(&mut source, &Options::default(), &mut on_progress, &control)?;
if let Some(print) = result.print() {
    let file = std::fs::File::create("print.png")?;
    result.write_png(&print.id, std::io::BufWriter::new(file))?;
}
for d in result.diagnostics() {
    eprintln!("{} {}: {}", d.severity, d.code, d.message);
}
# Ok::<(), Box<dyn std::error::Error>>(())
```

Frames you already have go in through the `FrameSource` trait instead of `VideoSource`.

Decoding uses AVFoundation on macOS and Media Foundation on Windows; Linux, and files the system decoder cannot open, need a user-installed `ffmpeg` and `ffprobe` on `PATH`. ffmpeg is never linked or bundled; when it is missing, the error says how to install it.

## Layers

The crate root is the driver. The layers under it are public modules, because the web page's WebAssembly, the benchmarks and the Python package are built from them, but they are implementation layers whose API may change in minor versions:

- `long_screen::kernels`: the reconstruction algorithms (motion, regions and layers, tracking, the pose graph, compositing, reveal, framing, the preview pyramid, YUV→RGBA), with no I/O.
- `long_screen::engine`: one run as a step-by-step state machine over the kernels, for hosts that store rows themselves.
- `long_screen::decode`: native video decoding, for when you only need the frames.

`kernels` and `engine` compile for `wasm32-unknown-unknown` with `default-features = false`; that is how the web page builds them.

## Same numbers as the web page

The kernels and the engine compute their exponentials, powers, logarithms and hypotenuses with the [`libm`](https://crates.io/crates/libm) crate, the musl code the web page's WebAssembly links, instead of the system's math library, so a run gives the web page's results row for row.

## Features

All are on by default.

- `cli`: the `long-screen` command line and its argument parser (`clap`). Implies `driver` and `decode`. Libraries can turn it off.
- `driver`: the driver API at the crate root (`run`, `Options`, `RunResult`, the sources, the in-memory row store). Implies `catalog`.
- `decode`: the `decode` module and `VideoSource`, with its options re-exported as `DecodeOptions` and `DecodeBackend`.
- `rayon`: the kernels run on rayon's thread pool. Results do not depend on the thread count; without it they run on the calling thread.
- `catalog`: the embedded zh/en diagnostic and progress catalogue (`engine::catalog`), which words diagnostics exactly as the web page does.

## License

MIT © 2026 Yi-Ting Chiu
