# long-screen

Turn a screen recording of a page explored along any path (scrolling, panning, zooming out and back) into one big screenshot, from Python. This is the engine of [Long Screen](https://github.com/t41372/long-screen) compiled as a native extension module: everything runs locally, nothing is uploaded.

```sh
pip install long-screen
```

```python
import long_screen

result = long_screen.reconstruct("recording.mov")
result.save("print.png")
for d in result.diagnostics:
    if d["severity"] != "info":
        print(d["code"], d["message"])
```

Reconstruction is heuristic. A run that ends `complete` does not prove the print is right: read the diagnostics, and look at `result.fragments`, the pieces the run could not place on the print.

## Decoding

- **macOS**: the system decoder (AVFoundation) reads MP4, MOV and anything else QuickTime plays. Nothing else to install.
- **Windows**: the system decoder (Media Foundation) reads MP4 and other formats Windows plays.
- **Linux**, and files the system decoder cannot read (WebM on macOS, for example): a user-installed `ffmpeg` and `ffprobe`, run as child processes (`sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install Gyan.FFmpeg`). ffmpeg is not bundled. Without it, `reconstruct` raises `DecoderMissingError`, whose message says how to install it. Set `LONGSCREEN_FFMPEG` and `LONGSCREEN_FFPROBE` to use executables that are not on `PATH`.

Frames are never resampled: screen recordings are variable frame rate, and every decoded frame is used once at its own timestamp.

## API

`reconstruct(path, *, lang="en", threads=None, memory_mb=None, backend="auto", on_progress=None) -> Result`

- `lang`: language of diagnostic and progress messages, `"en"` or `"zh"`.
- `threads`: kernel threads (default one per core). Results do not depend on it.
- `memory_mb`: working memory of the tile cache (default 128).
- `backend`: `"auto"`, `"avfoundation"`, `"mediafoundation"` or `"ffmpeg"`.
- `on_progress`: called with a `Progress` (`phase`, `fraction`, `frames`, `total`, `time`, `message`) about ten times a second. Return `False` to stop and keep what is done (the result is then `"partial"`); an exception raised in it stops the run and propagates.

`reconstruct_frames(frames, *, width, height, lossless=False, duration=None, ...) -> Result` takes frames you decoded yourself: an iterable of `(timestamp_seconds, image)` pairs, each image a `uint8` RGBA NumPy array of shape `(height, width, 4)`. The engine reads the frames once per pass, so a list is iterated several times; a generator is first copied to a temporary file (`width × height × 4` bytes per frame). Pass `lossless=True` for exact screen pixels (screenshots, lossless captures); the default allows for the noise of a lossy video codec.

`Result`:

- `status`: `"complete"`, `"partial"` (stopped, or not every frame could be used) or `"error"`.
- `diagnostics`: a list of dicts with `code`, `severity`, `message`, `action`, `frame`, `time`, `canvas`, `occurrences` and `params` (the diagnostic's other fields).
- `save(path)`: the print as an RGBA PNG, written one band of tiles at a time, so memory stays small however long the print is.
- `print_image()`: the print as a NumPy array. It is large: a 1320 × 12 000 print is 63 MB. Prefer `save()` when a file is what you need.
- `print`, `fragments`, `canvases`: `Canvas` objects (`id`, `kind`, `width`, `height`, `bounds`, `save(path)`, `image()`).

The engine runs with the GIL released. Ctrl-C stops a run at its next step and raises `KeyboardInterrupt`.

Errors: `FileNotFoundError`; `DecoderMissingError` (ffmpeg needed and not installed) and `DecoderError` (no decoder reads the file); `RunFailedError` when nothing could be reconstructed (its `.result.diagnostics` say why); `ValueError` and `TypeError` for bad arguments and frames. All Long Screen errors derive from `LongScreenError`.

## Requirements

CPython 3.11 or later (one `abi3` wheel per platform) and NumPy. Wheels: macOS (Apple silicon and Intel), Linux (manylinux x86_64 and aarch64) and Windows x86_64.

## License

MIT, Copyright (c) 2026 Yi-Ting Chiu. The source, the web app and the command line are at <https://github.com/t41372/long-screen>.
