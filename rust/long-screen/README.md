# long-screen

[Long Screen](https://github.com/t41372/long-screen) as a Rust library and a command line: a screen recording of a page explored along any path in, one big screenshot out.

`long_screen::run` drives the same engine the [Long Screen web page](https://github.com/t41372/long-screen) runs, pass by pass and in the same order (scan, solve, render, reveal, framing, preview pyramid), over a video file decoded natively or over RGBA frames you already have. It reports progress and diagnostics to an observer, honours pause and stop from another thread, and returns the print, its framed presentation and any separate fragments as tiles that it writes out as PNG at any size. The rows it keeps match the web page's row for row. Reconstruction is heuristic: a completed run does not prove the result is correct, and what it could not resolve comes back as diagnostics and separate fragments.

## Command line

```sh
cargo install long-screen
long-screen recording.mov -o print.png
```

## Library

```toml
[dependencies]
long-screen = { version = "0.1", default-features = false } # without the command line's clap
long-screen-decode = "0.1" # for VideoSource's decoder options
```

```rust,no_run
use long_screen::{run, Control, Options, VideoSource};
use long_screen_decode::Options as DecodeOptions;

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

Decoding uses AVFoundation on macOS and Media Foundation on Windows; Linux, and files the system decoder cannot open, need a user-installed `ffmpeg` and `ffprobe` on `PATH` (see [`long-screen-decode`](https://crates.io/crates/long-screen-decode)).

## Same numbers as the web page

The core computes its exponentials, powers, logarithms and hypotenuses with the [`libm`](https://crates.io/crates/libm) crate, the musl code the web page's WebAssembly links, instead of the system's math library, so a run gives the web page's results row for row.

## Features

- `cli` (default): the `long-screen` command line and its argument parser (`clap`). Libraries can turn it off.

## Related crates

- [`long-screen-engine`](https://crates.io/crates/long-screen-engine): the run as a step-by-step state machine, for hosts that store rows themselves.
- [`long-screen-core`](https://crates.io/crates/long-screen-core): the algorithms.
- [`long-screen-decode`](https://crates.io/crates/long-screen-decode): native video decoding.

## License

MIT © 2026 Yi-Ting Chiu
