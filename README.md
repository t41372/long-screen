# Long Screen

**Recover a sparse 2D canvas from a local screen recording.**

A pure client-side static web project: a thin layer of TypeScript (UI, Worker RPC, browser I/O, orchestration) wraps a Rust core compiled to WebAssembly, which handles all the algorithms. The project covers video demuxing, frame-accurate decoding, motion layering, historical relocalization, an on-disk pose graph, native-resolution tile composition, quality diagnostics, and offline export. There is no upload endpoint, cloud inference, OCR, or model download. The toolchain is Deno; the core's build toolchain is rustup/cargo (installed automatically on the first build, see below).

> Think of this as a visual reconstruction system with inspectable evidence, not a page recoverer that can prove correctness for any arbitrary screen recording. Automatic layering, relocalization, and dynamic-region detection are still heuristic. **A completed run does not mean the result is proven correct.** For the range of what's actually tested and what's not implemented, see [Capabilities](docs/CAPABILITIES.md) and [Testing notes](docs/TESTING.md) (both in Chinese).

## Running

Requires [Deno](https://deno.com) 2.x and [rustup](https://rustup.rs). No `npm install`, no API key, and no internet connection needed at runtime. The build compiles the Rust core: `rust/rust-toolchain.toml` pins the Rust version, the wasm32 target, and the required components, which rustup downloads and installs automatically on the first build.

```sh
deno task start      # builds automatically if dist/ is missing, then serves static files on 4173
```

Open `http://localhost:4173`. On the left you can run the built-in demo directly (the same ground-truth synthetic scenes used by the test suite), or pick your own screen recording.

```sh
deno task build:core # compiles only the Rust core to rust/target/{scalar,simd,threads}
deno task build      # builds the Rust core + bundles TS into dist/ (for testing/dev, with test harness and source maps)
deno task build:prod # same, minus the test harness and source maps, for production deployment
deno task check      # full type check
deno task test       # unit + scenario end-to-end tests (pure Deno, no browser; builds the core first)
deno task coverage   # same, plus enforcing the coverage floor for the core directory
deno task test:browser   # decoding, reconstruction, UI, and export tests in real Chrome + Playwright WebKit
deno task fixtures   # generates missing encoded test fixtures with ffmpeg (existing files are not overwritten)
deno task fingerprint    # byte-level fingerprinting tool per scenario, per persisted row; see docs/TESTING.md
```

Browser tests (`deno task test:browser`) require Google Chrome (the Chromium bundled with Playwright doesn't include H.264) and Playwright's WebKit: `npx playwright@1.58.2 install webkit` (requires Node.js; the version matches the `playwright` entry in `deno.json`). `deno task fixtures` requires ffmpeg.

The main app uses ES modules and Workers, so it needs a static file server — you can't just double-click `dist/index.html`. **Local development works over plain HTTP on localhost, no certificate setup needed.** A phone can also open the app over the computer's LAN HTTP IP, run the demo, and test a local video using "approximate · native seek" mode (the browser must be able to play that video; frames may be dropped). Browsers generally only expose WebCodecs frame-accurate decoding and OPFS disk export on secure origins; `localhost` counts as a secure origin, a LAN IP does not, so verifying these capabilities from a phone requires HTTPS, e.g. GitHub Pages. The app enables features based on actual API capability and won't refuse to run just because it's HTTP; these browser restrictions have nothing to do with uploading — all processing still happens locally. The exported **result package** is different: after unzipping, you can open its `index.html` directly to view it offline.

For situations with no server and no easy way to run one yourself (e.g. a locked-down corporate laptop), use `deno task build:portable`: it first runs `deno task build:prod` (so it also overwrites the whole `dist/` directory), then inlines the page, styles, Workers, and the single-threaded Wasm core into `dist-portable/long-screen/long-screen.html`, and zips it up together with usage instructions. Double-click it in Chrome / Edge to open — no software install, no internet connection needed. The approach rewrites each bundled artifact from ES modules into classic scripts, and replaces `Worker` and `fetch` in the page and in Workers so they return the embedded script and Wasm directly instead of requesting files from disk (see the comment at the top of `scripts/build-portable.ts` for why). Trade-offs: a `file://` page can't be cross-origin isolated, so the Rust core only runs a single-threaded build (results are unchanged; on real screen recordings in test_case it isn't slower than the multi-threaded build — the bottleneck is decoding and I/O); OPFS isn't available, so export goes through "Save As", falling back to an in-memory download (capped at 1 GB) if that dialog is disabled by policy; only Chromium-based browsers are supported — WebKit can't read the user's picked video file from a Worker under `file://`, so the built-in demo works but a real screen recording doesn't.

## Usage

The interface language follows your browser's preferred languages (any `zh-*` variant selects Chinese, otherwise English); a language menu in the header lets you switch it, and the choice is saved in the browser (localStorage) for later visits.

Pick a screen recording → optionally specify independent motion regions → reconstruct → select a canvas and check the quality mask / diagnostics → export.

After picking a file, the app uses WebCodecs to decode the first frame directly to read the actual codec, dimensions, rotation, and frame count; it doesn't rely on whether the browser's `<video>` element can render that container. The native player is only used for "approximate · native seek" mode and "view original moment".

Automatic mode keeps moving content and fixed UI separate; multiple independent panes each have their own coordinate system. Observations whose position can't be confirmed become exportable independent fragments rather than being forced onto the end of the main long image; if a later revisit provides reliable evidence, the fragment is reattached as a whole and recorded. Transparent areas mean no observation is available there, not a white page.

## Export

**Full project ZIP64**: native-size PNG tiles, preview pyramid, offline viewer, pixel coverage bitmap, block-level confidence / conflict / source-frame data, a contribution record for every processed frame, motion analysis logs, the pose graph, and all diagnostics. The original video is not copied into the project.

**Current canvas PNG / paged export**: if the size fits, it's streamed and encoded directly to PNG; if it exceeds the compatible size, multiple native-size PNGs are output, with world coordinates and a 32px overlap noted. It never silently downscales.

It writes to a user-chosen file when possible; if that API isn't supported, it writes a temporary file via OPFS and then downloads it. When there's no disk write path available, it fails explicitly rather than falling back to assembling the entire output in RAM.

## Deployment

The `dist/` produced by `deno task build:prod` is a static site — upload it to any static host that respects a `_headers` file (Cloudflare Pages, Netlify; `static/_headers` is copied as-is and sets the COOP/COEP/CORP response headers needed for the threaded build, plus a caching policy). GitHub Pages is no longer the recommended host: it can't set custom response headers, which means the page isn't cross-origin isolated and the Wasm core falls back to the single-threaded build (it still runs, just without thread acceleration). **The host must send all three headers on 304 responses too**, not only on 200: the dev server (`deno task start`) reattaches them to every response, but static hosts don't necessarily behave consistently here — a 304 missing the CORP header once broke the download flow in WebKit private browsing (see the commit history entry "dev server re-applies COOP/COEP/CORP to every response"); whether the `_headers` file itself applies to 304s varies by host, so verify on the real host when deploying (check a repeated request with `If-None-Match` in the browser devtools to confirm the 304 response also carries all three headers).

This repository deploys through Cloudflare Pages' Git integration: on a push to `main`, Cloudflare pulls the repository, runs `bash scripts/pages-build.sh` and publishes `dist/`; a push to any other branch creates a preview deployment. The Pages build image has neither Rust nor Deno installed, so the script first installs rustup and the toolchain pinned in `rust/rust-toolchain.toml`, then runs `deno task build:prod` with the official `deno` package from npm. Set it up once in the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git, pick this repository, production branch `main`, build command `bash scripts/pages-build.sh`, build output directory `dist`. No API token, repository secret or GitHub Actions is needed.

## Architecture

```text
File / Blob (chunked random-access reads via the npm package mediabunny)
  → MP4 / MOV / fMP4 / WebM demuxing (including signed QuickTime ctts; mediabunny handles container parsing, this project keeps only the small amount of validation it doesn't cover)
  → WebCodecs (PTS, B-frames, backpressure, releasing VideoFrame) → RGBA
  → Pass 1: per-frame motion evidence + global region learning → disk
  → Pass 2: layer localization, native-pixel refinement, historical relocalization, pose graph → disk
  → Pass 3: coordinate correction, pixel ownership, temporal conflicts → bounded LRU tile cache
  → IndexedDB native-size tiles / coverage bitmap / diagnostics
```

Decoding is the only step that depends on browser APIs: `FrameSource` produces `RGBA`, not a canvas, for the passes that follow. Registration, layering, the pose graph, compositing, tile encode/decode, and other algorithms all live in the Wasm core compiled from `rust/core`; TypeScript is a thin shell around it (UI, Worker RPC, I/O, orchestration). Deno tests and the browser load the same core, so algorithm behavior verified in Deno is the same behavior you get in the browser. See the [architecture doc](docs/ARCHITECTURE.md) (in Chinese) for details (sections 11 and 12 are the current module-by-module ownership list and what's deliberately kept in TS); the history of the migration is recorded in [docs/history/2026-09-rust-migration-log.md](docs/history/2026-09-rust-migration-log.md) (finished, doesn't reflect current state).

## Directory layout

```text
rust/core       Rust core source; compiles into three builds: core.wasm / core.simd.wasm / core.threads.wasm
src/core        TS shell around the core: registration, layering, pose graph, keyframes, compositing, rasterization, loading the core and picking its build (src/core/wasm/**)
src/media       Container parsing (Input/BlobSource/EncodedPacketSink from the npm package mediabunny), ranged reads, WebCodecs decoding
src/codec       TS orchestration layer for PNG encode/decode; chunk/CRC validation goes through the core
src/pipeline    Orchestration of the three-pass engine (scan/solve/render); conflict resolution and pose-graph optimization themselves are already in the Rust core, this is call ordering and KV I/O
src/storage     IndexedDB / in-memory KV, tiles, diagnostics
src/synthetic   Synthetic scenes, renderer, ground-truth validator (also the built-in demo)
src/export      ZIP64 (via the npm package client-zip), PNG paging, offline viewer
src/ui          UI and tile viewer
scripts         Build (build.ts/build-core.sh), benchmarks, fingerprinting, sample generation, and other tooling scripts
static          COOP/COEP `_headers`, dev harness page, and other static assets
tests/unit      Pure Deno unit tests, scenario end-to-end tests, TS↔Rust byte-level parity checks under `tests/unit/parity/`
tests/support   Test core loader, scenario ground-truth validation, frozen parity reference implementations (tests/support/reference/)
tests/browser   Playwright driving real Chrome + WebKit
```

License: MIT.
