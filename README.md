# Long Screen

**Recover a sparse 2D canvas from a local screen recording.**

**Use it in your browser: [long-screen.yi-ting.com](https://long-screen.yi-ting.com)** (also at [long-screen.pages.dev](https://long-screen.pages.dev)). Nothing is uploaded; the recording is processed on your own device.

Record a web page, an app, a map or a design file while you move around it — scroll, pan, go diagonally, loop back, pause, shake — and Long Screen puts everything the recording showed back in place as one native-size PNG. Fixed window chrome and status bars are restored too. Everything runs on your own machine: there is no upload endpoint, cloud inference, OCR or model download.

The main form is a static web app: a thin layer of TypeScript (UI, Worker RPC, browser I/O, orchestration) wraps a Rust core compiled to WebAssembly, which holds every algorithm — motion layering, historical relocalization, an on-disk pose graph, native-resolution tile composition and quality diagnostics. The same engine also runs [outside the browser](#use-it-outside-the-browser), as a command line, a Rust library, a Python package and a TypeScript package for other web pages.

> Think of this as a visual reconstruction system with inspectable evidence, not a page recoverer that can prove correctness for any arbitrary screen recording. Automatic layering, relocalization, and dynamic-region detection are still heuristic. **A completed run does not mean the result is proven correct.** For the range of what's actually tested and what's not implemented, see [Capabilities](docs/CAPABILITIES.md) and [Testing notes](docs/TESTING.md) (both in Chinese).

## Try it

The quickest way is the hosted app at [long-screen.yi-ting.com](https://long-screen.yi-ting.com). To run it from a checkout instead:

Requires [Deno](https://deno.com) 2.x and [rustup](https://rustup.rs). No `npm install`, no API key, and no internet connection needed at runtime. The build compiles the Rust core: `rust/rust-toolchain.toml` pins the Rust version, the wasm32 target, and the required components, which rustup downloads and installs automatically on the first build.

```sh
deno task start      # builds automatically if dist/ is missing, then serves the app on port 4173
```

Open `http://localhost:4173`. The “Play a sample recording” chip in the intro feeds the printer a sample recording that wanders around a page (`static/demo/sample.mp4`), or drop your own screen recording onto its screen.

### Using the app

Drop a screen recording on the printer's screen → optionally mark independent motion regions under Settings → Run → pick a canvas, check the quality mask and the log → take the PNG. The recording can move along any path, as long as it shows every part you want in the picture.

The interface language follows your browser's preferred languages (any `zh-*` variant selects Chinese, otherwise English); a language menu in the header switches it, and the choice is saved in the browser (localStorage) for later visits.

After you pick a file, the app decodes its first frame with WebCodecs to read the actual codec, dimensions, rotation and frame count; it doesn't rely on whether the browser's `<video>` element can render that container. The native player is only used for the “Approximate · native seek” mode and for viewing the original moment.

Automatic mode keeps moving content and fixed UI separate; multiple independent panes each get their own coordinate system. Observations whose position can't be confirmed become exportable independent fragments rather than being forced onto the end of the main print; if a later revisit provides reliable evidence, the fragment is reattached as a whole and recorded. Transparent areas mean nothing was observed there, not a white page.

The browser keeps only the latest print, for 24 hours, so a reload or a crash does not lose it; running again or pressing Clear deletes it. Download what you want to keep.

### Export

**Current canvas PNG / paged export**: if the size fits, it's streamed and encoded directly to PNG; if it exceeds the compatible size, multiple native-size PNGs are output, with world coordinates and a 32px overlap noted. It never silently downscales.

**Crop**: once a print is composed, Crop puts a box over it to drag or type; the PNG, the paged export and the copy then take only that part of the canvas, still at native size. The crop is kept with the print (a reload keeps it) and Whole print undoes it. The full project ZIP is never cropped.

**Full project ZIP64**: native-size PNG tiles, preview pyramid, offline viewer, pixel coverage bitmap, block-level confidence / conflict / source-frame data, a contribution record for every processed frame, motion analysis logs, the pose graph, and all diagnostics. The original video is not copied into the project. After unzipping, open its `index.html` directly to view it offline.

Exports write to a user-chosen file when possible; if that API isn't supported, they write a temporary file via OPFS and then download it. When there's no disk write path available, the export fails explicitly rather than assembling the entire output in RAM.

### Install it as an app

The app can be installed as a PWA: where the browser can install it, an **Install app** key appears in the header. Chrome and Edge (Android and desktop) show their own install prompt; on iPhone, iPad and Mac Safari, which have no install API, the key shows the Share → Add to Home Screen (or File → Add to Dock) steps. An installed copy opens and runs without a connection once it has been opened online once: a service worker (`src/sw.ts`) keeps a copy of the current build. Online, every load still comes from the network, so a new deploy reaches users on their next visit.

### Plain HTTP and phones

The app uses ES modules and Workers, so it needs a static file server — you can't just double-click `dist/index.html`. **Local development works over plain HTTP on localhost, no certificate setup needed.** A phone can also open the app over the computer's LAN HTTP IP and test a local video using “Approximate · native seek” mode (the browser must be able to play that video; frames may be dropped). Browsers generally only expose WebCodecs frame-accurate decoding and OPFS disk export on secure origins; `localhost` counts as a secure origin, a LAN IP does not, so verifying these capabilities from a phone requires HTTPS. The app enables features based on actual API capability and won't refuse to run just because it's HTTP; these browser restrictions have nothing to do with uploading — all processing still happens locally.

### Without a server: the portable build

For situations with no server and no easy way to run one yourself (e.g. a locked-down corporate laptop), use `deno task build:portable`: it first runs `deno task build:prod --out dist-portable/.site` (leaving `dist/` alone), then inlines the page, styles, Workers, and the single-threaded Wasm core into `dist-portable/long-screen/long-screen.html`, and zips it up together with usage instructions, the license and the third-party notices. Double-click it in Chrome / Edge to open — no software install, no internet connection needed. The approach rewrites each bundled artifact from ES modules into classic scripts, and replaces `Worker` and `fetch` in the page and in Workers so they return the embedded script and Wasm directly instead of requesting files from disk (see the comment at the top of `scripts/build-portable.ts` for why).

Trade-offs: a `file://` page can't be cross-origin isolated, so the Rust core only runs a single-threaded build (results are unchanged; on real screen recordings in test_case it isn't slower than the multi-threaded build — the bottleneck is decoding and I/O); OPFS isn't available, so export goes through “Save As”, falling back to an in-memory download (capped at 1 GB) if that dialog is disabled by policy; only Chromium-based browsers are supported — WebKit can't read the user's picked video file from a Worker under `file://`, so a screen recording cannot be processed there. Opened in any other browser, the page says at the top to use Chrome or Edge instead; if its script fails to load or throws during start-up, a notice at the top says so too, rather than leaving a page that does nothing (a Worker error after start-up is still reported by the app's own error message).

## Use it outside the browser

The same reconstruction comes in four other forms. Each runs the engine the web app runs (the `long-screen` crate in `rust/long-screen`), with native decoders or the browser's WebCodecs in front of it. None of them is published to a package registry yet: build them from this repository as described below.

### Command line

`long-screen` reads a video file and writes the print as a PNG, without a browser. Install it from source with Rust (rustup picks up the pinned toolchain):

```sh
cd rust && cargo install --path long-screen
long-screen recording.mov -o print.png --json report.json
```

It writes the print as one PNG (fragments it could not place go next to it as `print-fragment-<n>.png`, or use `--out-dir` for every canvas), progress and warnings on stderr, and with `--json` a report of the diagnostics, canvases and timings; `--lang zh`, `--threads`, `--memory-mb` and `--help` for the rest. Exit codes: 0 complete, 3 partial result, 1 the run failed, 4 the video could not be opened, 5 an output could not be written, 2 any other error.

On macOS and Windows it decodes with the system decoder (AVFoundation, Media Foundation). On Linux, and for files the system decoder cannot read (WebM on macOS, for example), it runs a user-installed `ffmpeg` and `ffprobe` (e.g. `sudo apt install ffmpeg`); ffmpeg is not bundled. Its rows match the web app's row for row on the same frames (`scripts/native-parity.ts` checks this).

### Rust library

The command line is a thin layer over the `long-screen` crate (`rust/long-screen`), which a desktop app or another binding can drive the same way. It is one crate: the algorithms (`long_screen::kernels`), the run's state machine (`long_screen::engine`) and native decoding (`long_screen::decode`) are modules inside it, and the web app's WebAssembly is built from the same crate without its native features. Use it as a git or path dependency; leaving out the `cli` feature drops the command line's argument parser:

```toml
[dependencies]
long-screen = { git = "https://github.com/t41372/long-screen", default-features = false, features = ["driver", "decode", "rayon"] }
```

Then, inside a function that returns a `Result`:

```rust
use long_screen::{run, Control, DecodeOptions, Options, VideoSource};

let mut source = VideoSource::open("recording.mov".as_ref(), DecodeOptions::default())?;
let control = Control::new(); // clone it to another thread to pause or stop the run
let mut on_progress = |p: &long_screen::Progress| eprintln!("{} {:.0}%", p.phase, p.fraction * 100.0);
let result = run(&mut source, &Options::default(), &mut on_progress, &control)?;
if let Some(print) = result.print() {
    let file = std::fs::File::create("print.png")?;
    result.write_png(&print.id, std::io::BufWriter::new(file))?;
}
```

`RawSource` takes RGBA frames you decoded yourself instead of a video file. The crate documentation (`cd rust && cargo doc -p long-screen --open`) describes the rest.

### Python package

`rust/python` wraps the native driver as a Python package, `long-screen` (CPython 3.11+, one abi3 wheel per platform, NumPy). Build and test it with `deno task test:python` (needs [uv](https://docs.astral.sh/uv/)); `cd rust/python && maturin build --release` makes just the wheel.

```python
import long_screen

result = long_screen.reconstruct("recording.mov", on_progress=lambda p: print(p.phase, p.fraction))
result.save("print.png")  # fragments: result.fragments; NumPy: result.print_image()
print(result.status, [d["code"] for d in result.diagnostics if d["severity"] != "info"])
```

It decodes the way the command line does, and `reconstruct_frames` takes frames you decoded yourself. The engine runs with the GIL released; Ctrl-C stops it at the next step. On macOS its rows are identical to the command line's and the web app's (`rust/python/tests/parity_*.py` check this). The package's own README (`rust/python/README.md`) has the API.

### TypeScript package

`src/package` is the same reconstruction as a package for other web pages; `deno task build:package` builds it into `dist-package/`, ready for npm.

```js
import { reconstruct } from 'long-screen';

const run = reconstruct(file, { locale: 'en', onProgress: (p) => console.log(p.phase, p.fraction) });
const { status, prints, diagnostics } = await run.result; // prints[i].png is a native-size PNG Blob
```

It runs the app's worker and Wasm core unchanged, in a Worker next to `index.js`; `run.pause()`, `resume()`, `stop()` and `cancel()` control it. Each call keeps its working rows in an IndexedDB database of its own and deletes it before `result` settles. Vite and webpack pick up the worker and Wasm files by themselves; without a bundler, serve the package folder from your own origin. A cross-origin-isolated page (COOP/COEP, see [Deployment](#deployment)) runs the threaded core, any other page the single-thread one, with the same result; its PNGs match the app's byte for byte in Chrome and WebKit (`tests/browser/package.test.ts`). The package's own README (`src/package/README.md`) has the details.

## How it works

```text
File / Blob (chunked random-access reads via the npm package mediabunny)
  → MP4 / MOV / fMP4 / WebM demuxing (including signed QuickTime ctts; mediabunny handles container parsing, this project keeps only the small amount of validation it doesn't cover)
  → WebCodecs (PTS, B-frames, backpressure, releasing VideoFrame) → RGBA
  → Pass 1: per-frame motion evidence + global region learning → disk
  → Pass 2: layer localization, native-pixel refinement, historical relocalization, pose graph → disk
  → Pass 3: coordinate correction, pixel ownership, temporal conflicts → bounded LRU tile cache
  → IndexedDB native-size tiles / coverage bitmap / diagnostics
```

Decoding is the only step that depends on browser APIs: `FrameSource` produces `RGBA`, not a canvas, for the passes that follow. Registration, layering, the pose graph, compositing, tile encode/decode, and other algorithms all live in the Wasm core compiled from `rust/long-screen` (its `kernels` and `engine` modules); TypeScript is a thin shell around it (UI, Worker RPC, I/O, orchestration). Deno tests and the browser load the same core, so algorithm behavior verified in Deno is the same behavior you get in the browser. Outside the browser, `rust/long-screen` drives the same engine with native decoders in place of WebCodecs and an in-memory store in place of IndexedDB. See the [architecture doc](docs/ARCHITECTURE.md) (in Chinese) for details (sections 11 and 12 are the current module-by-module ownership list and what's deliberately kept in TS); the history of the migration is recorded in [docs/history/2026-09-rust-migration-log.md](docs/history/2026-09-rust-migration-log.md) (finished, doesn't reflect current state).

### Directory layout

```text
rust/long-screen  The one published crate: the native driver library and the `long-screen` command line, with its layers as modules:
  src/kernels     The algorithms (motion, layers, tracking, compositing, presentation kernels), with no FFI
  src/engine      The run's state machine (scan, solve, render, presentation), driven step by step by a host
  src/decode      Native video decoding: AVFoundation, Media Foundation, or a user-installed ffmpeg
rust/wasm         The kernels' and engine's extern "C" exports; compiles into the three builds core.wasm / core.simd.wasm / core.threads.wasm
rust/python       The Python package (PyO3 + maturin) over rust/long-screen
rust/bench        Native benchmarks of the core kernels on the public test recordings
src/core          TS shell around the core: registration, layering, pose graph, keyframes, compositing, rasterization, loading the core and picking its build (src/core/wasm/**)
src/media         Container parsing (Input/BlobSource/EncodedPacketSink from the npm package mediabunny), ranged reads, WebCodecs decoding
src/codec         TS orchestration layer for PNG encode/decode; chunk/CRC validation goes through the core
src/pipeline      Orchestration of the three-pass engine (scan/solve/render); conflict resolution and pose-graph optimization themselves are already in the Rust core, this is call ordering and KV I/O
src/storage       IndexedDB / in-memory KV, tiles, diagnostics
src/synthetic     Synthetic scenes, renderer, ground-truth validator (used by the tests)
src/export        ZIP64 (via the npm package client-zip), PNG paging, offline viewer
src/ui            UI and tile viewer
src/package       The npm package's entry: reconstruct() driving the app's worker from another page
scripts           Build (build.ts/build-core.sh), benchmarks, fingerprinting, sample generation, and other tooling scripts
static            COOP/COEP `_headers`, dev harness page, and other static assets
tests/unit        Pure Deno unit tests, scenario end-to-end tests, TS↔Rust byte-level parity checks under `tests/unit/parity/`
tests/support     Test core loader, scenario ground-truth validation, frozen parity reference implementations (tests/support/reference/)
tests/browser     Playwright driving real Chrome + WebKit
tests/package     A third-party page using the built package (driven by tests/browser/package.test.ts)
```

## Development

```sh
deno task build:core     # compiles only the Rust core to rust/target/{scalar,simd,threads}
deno task build          # builds the Rust core + bundles TS into dist/ (for testing/dev, with test harness and source maps)
deno task build:prod     # same, minus the test harness and source maps, for production deployment
deno task build:package  # the TypeScript package into dist-package/
deno task check          # full type check
deno task test           # builds the core, runs the Rust tests (cargo), then the Deno unit and scenario end-to-end tests (no browser)
deno task coverage       # the Deno tests plus per-file line-coverage floors (scripts/coverage.ts)
deno task test:browser   # decoding, reconstruction, UI, and export tests in real Chrome + Playwright WebKit
deno task test:python    # builds the Python wheel into a fresh venv and runs its pytest suite (needs uv)
deno task lint           # deno fmt --check + deno lint + cargo fmt --check + clippy
deno task fmt            # deno fmt + cargo fmt
deno task bench          # native benchmarks of the core kernels on the public test recordings
deno task fixtures       # generates missing encoded test fixtures with ffmpeg (existing files are not overwritten)
deno task fingerprint    # byte-level fingerprinting tool per scenario, per persisted row; see docs/TESTING.md
```

Browser tests (`deno task test:browser`) require Google Chrome (the Chromium bundled with Playwright doesn't include H.264) and Playwright's WebKit: `npx playwright@1.58.2 install webkit` (requires Node.js; the version matches the `playwright` entry in `deno.json`). `deno task fixtures` requires ffmpeg. [AGENTS.md](AGENTS.md) collects the project's rules and the commands for running a single test.

## Deployment

The `dist/` produced by `deno task build:prod` is a static site — upload it to any static host that respects a `_headers` file (Cloudflare Pages, Netlify; `static/_headers` is copied as-is and sets the COOP/COEP/CORP response headers needed for the threaded build, plus a caching policy). Keep the service worker `sw.js` next to `index.html`, where the build puts it, so its scope covers the whole app; the `no-cache` policy applies to it like everything else. GitHub Pages is no longer the recommended host: it can't set custom response headers, which means the page isn't cross-origin isolated and the Wasm core falls back to the single-threaded build (it still runs, just without thread acceleration). **The host must send all three headers on 304 responses too**, not only on 200: the dev server (`deno task start`) reattaches them to every response, but static hosts don't necessarily behave consistently here — a 304 missing the CORP header once broke the download flow in WebKit private browsing (see the commit history entry "dev server re-applies COOP/COEP/CORP to every response"); whether the `_headers` file itself applies to 304s varies by host, so verify on the real host when deploying (check a repeated request with `If-None-Match` in the browser devtools to confirm the 304 response also carries all three headers).

This repository deploys through Cloudflare Pages' Git integration: on a push to `main`, Cloudflare pulls the repository, runs `bash scripts/pages-build.sh` and publishes `dist/`; a push to any other branch creates a preview deployment. The Pages build image has neither Rust nor Deno installed, so the script first installs rustup and the toolchain pinned in `rust/rust-toolchain.toml`, then runs `deno task build:prod` with the official `deno` package from npm. Set it up once in the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git, pick this repository, production branch `main`, build command `bash scripts/pages-build.sh`, build output directory `dist`. No API token, repository secret or GitHub Actions is needed.

## License

Long Screen is released under the [MIT License](LICENSE), copyright Yi-Ting Chiu. In short:

- **You may** use, copy, modify, merge, publish, distribute, sublicense and sell it, including inside closed-source products.
- **You must** keep the copyright notice and the license text in every copy or substantial portion of it.
- **No warranty**: it is provided as is, and the authors are not liable for what happens when you use it.

Third-party code bundled into a build, and the logos shown on the page, carry their own licenses; each build lists them in `THIRD_PARTY_NOTICES.txt`.

## How to cite

[`CITATION.cff`](CITATION.cff) holds the citation metadata; GitHub turns it into the "Cite this repository" button on the repository page.

If you use Long Screen or its core in a product, a project or a paper, please let us know with a [GitHub issue](https://github.com/t41372/long-screen/issues). It helps us see where it is useful.
