# long-screen-decode

Native video decoding for [Long Screen](https://github.com/t41372/long-screen): every frame of a file's first video track, once, in presentation order, with the timestamp the container gives it. Screen recordings are variable frame rate, so nothing is resampled to a constant rate and no frame is duplicated or dropped. Frames keep the decoder's own 4:2:0 planes (8- or 10-bit) and colour tags, so HDR (PQ or HLG) recordings arrive with their signal untouched.

Backends:

- macOS: AVFoundation (part of the system).
- Windows: Media Foundation (part of the system).
- Every system: a user-installed `ffmpeg`/`ffprobe`, run as a child process. Linux always uses it, and the other systems fall back to it for files their decoder cannot open. ffmpeg is never linked or bundled; when it is missing, the error says how to install it.

The [`long-screen`](https://crates.io/crates/long-screen) crate uses this crate to read videos (`long_screen::VideoSource`). Use it directly when you only need the frames.

## Example

```rust,no_run
use long_screen_decode::{open, Frame, Options};
use std::path::Path;

let mut decoder = open(Path::new("recording.mov"), &Options::default())?;
println!("{:?}", decoder.info());
let mut frame = Frame::default();
while decoder.read_frame(&mut frame)? {
    println!("frame {} at {:.3} s", frame.index, frame.timestamp);
}
# Ok::<(), long_screen_decode::Error>(())
```

## Related crates

- [`long-screen`](https://crates.io/crates/long-screen): the native driver library and the `long-screen` command line.
- [`long-screen-engine`](https://crates.io/crates/long-screen-engine) and [`long-screen-core`](https://crates.io/crates/long-screen-core): the reconstruction itself.

## License

MIT © 2026 Yi-Ting Chiu
