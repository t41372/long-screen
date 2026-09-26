# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

Long Screen turns a screen recording of a page explored along any path into one big screenshot, entirely in the browser. A thin TypeScript shell (UI, worker RPC, browser I/O, orchestration) wraps a Rust core compiled to WebAssembly that holds every algorithm. There is no upload, server-side processing or model download. A completed run does not prove the result is correct; reconstruction is heuristic and reports what it could not resolve as diagnostics and separate fragments.

## Commands

Deno 2.x and rustup are required; `rust/rust-toolchain.toml` pins Rust, and rustup installs it on the first build.

```sh
deno task start          # serve dist/ on http://localhost:4173 (builds first if dist/ is missing)
deno task build:core     # Rust core → rust/target/{scalar,simd,threads}; the only supported way to build the .rs sources
deno task build          # core + TS bundles into dist/ (dev: test harness, source maps)
deno task build:prod     # production dist/; build:portable makes the file:// single-file build in dist-portable/
deno task check          # type check
deno task test           # build:core + cargo test --lib + Deno unit and scenario tests
deno task test:browser   # real Google Chrome + Playwright WebKit; builds and serves its own dist-test/
deno task lint           # deno lint + cargo fmt --check + clippy (scalar and threads builds)
deno task fmt            # deno fmt + cargo fmt (does not cover AGENTS.md)
deno task coverage       # tests plus per-file line-coverage floors in scripts/coverage.ts
deno task fingerprint out.json   # hash every persisted row of every synthetic scenario
```

- One Deno test file: `deno test --allow-read --allow-write --allow-env tests/unit/motion.test.ts --filter "<name>"`. It loads the core from `rust/target/`, so run `deno task build:core` after changing Rust. `LONGSCREEN_CORE=scalar|threads` picks another core build (default simd) and `LONGSCREEN_THREADS` sets the helper count.
- One Rust test: `cd rust && cargo test --lib <name>`. A bare `cargo build` uses the scalar flags from `rust/.cargo/config.toml` and does not produce the three builds the app loads.
- One browser file: `deno test --allow-all tests/browser/ui.test.ts`. The full browser suite takes over ten minutes because one known WebKit test times out at 600 s.
- A/B against another checkout: `deno run -A scripts/fingerprint-scenarios.ts b.json --root ../other`, then `deno run -A scripts/compare-fingerprints.ts a.json b.json`.

## Architecture

```text
File/Blob → mediabunny demux (MP4/MOV/WebM) → WebCodecs → RGBA
  → pass 1 scan: per-frame motion evidence + region learning   → IndexedDB
  → pass 2 solve: layer tracking, relocalization, pose graph  → IndexedDB
  → pass 3 render: pixel ownership, temporal conflicts → native-size tiles
  → presentation: framing + preview pyramid
```

- Decoding is the only step that depends on browser APIs. Everything after it runs in the Wasm core, and Deno tests load the same core the browser does, so algorithm behaviour verified in Deno is what ships.
- Each core domain has three matching files: `rust/core/src/<d>.rs` (algorithm, no FFI) ↔ `rust/core/src/abi/<d>.rs` (`extern "C"` exports) ↔ `src/core/wasm/<d>.ts` (marshalling). `src/core/wasm/loader.ts::planCore` picks the scalar, SIMD or threads build; threads need a cross-origin-isolated page.
- `src/pipeline/` orders the passes, holds run state and does KV I/O; the per-pixel and tracking work happens in core calls. The page talks to `src/worker.ts` through the typed commands in `src/protocol.ts`.
- `docs/` is written in Chinese and README.md in English. Read these when the task touches their area, not before every edit:
  - `docs/ARCHITECTURE.md` §十 before changing compositing, consistency, motion, layers or i18n. Each invariant there records a measured failure.
  - §十一 for which module owns what; §十二 before moving code between TS and Rust.
  - `docs/TESTING.md` for scenario ground truth, ratchets, fingerprints and known browser failures.
  - `docs/FORMAT.md` when changing the export package or persisted rows. `docs/history/` is a closed log.

## Testing principles

- Avoid writing unit tests after the code they test. A test fitted to finished code tends to mirror the implementation instead of checking it.
- Prefer end-to-end tests, and use them to show that a complex feature works. End each E2E run with an artifact that someone else can check and reproduce.
- When a part does need testing in isolation, list the ways it could fail before writing the code, and make that list the tests.

In this repository:

- E2E here means the whole `Engine` on an input with known truth: the synthetic scenarios (`tests/unit/scenarios-{1..4}.test.ts`, pixel-exact ground truth from `src/synthetic/`), the browser tests (`tests/browser/`, real decoding, worker, storage, UI and export) and real recordings (`scripts/e2e-recordings.sh`).
- The artifact goes in `test-results/`, as the existing tests already do: a JSON report with exact counts or content hashes, a screenshot or an exported ZIP, plus the command that regenerates it. For a pipeline change, a fingerprint JSON compared against clean main is the artifact. Every changed row must be explained by the change; a byte-identical output is not required.
- Isolation tests cover Rust `#[cfg(test)]` modules, parity tests and anything else below the engine. For those, write the failure cases as tests before the code.
- The existing unit and parity suites stay and keep running. Scenario ratchets (`maxMissing`, `maxContaminated*`, and the rest) only move down, and coverage floors only move up; review the `--update-floors` diff line by line.
- Compare a failing browser test against clean main before blaming your change: `docs/TESTING.md` lists the known WebKit failures. Real recordings live in `test_case/`, which is gitignored and present only in the main checkout, so worktrees skip those tests. Run long browser suites in a worktree nobody is merging into.
- Deno can expose a real WebGPU adapter (it does on macOS with Metal), so compute results depend on the host. Pass `null`, not `undefined`, to mean "no GPU".
- When feeding a `test_case/*.mov` to ffmpeg, pass `-fps_mode passthrough`. The recordings are variable frame rate, and without it frames are duplicated and every result is silently wrong. Read the frame size from ffprobe.

## Project rules

- **Algorithms belong in `rust/core`.** TypeScript stays a thin shell, and logic never moves from Rust back to TS. A browser API such as WebCodecs, CompressionStream or WebGPU counts as shell and wins when it measures faster. Before porting, benchmark the options on real recordings in Chrome and WebKit and record the numbers in §十二. A port freezes the TS version as an oracle in `tests/support/reference/`, adds its parity test first, then implements in Rust. It is done when parity holds on all three builds, the fingerprint matches or every difference is explained, and a real-recording A/B has run.
- **Prefer well-known dependencies** (crates, npm, jsr) to hand-written codecs, parsers, checksums and storage wrappers. Pin versions and use pure-Rust crates in the core. Hand-rolled code costs more to review than a trusted library.
- **Formatting:** run `deno task fmt` before committing and `deno task lint` before calling work finished. Markdown is formatted but not hard-wrapped, one line per paragraph. When joining wrapped Chinese lines, do not insert spaces between CJK characters.
- **i18n:** add both zh and en keys; en catalogues are typed against zh, so a missing key is a compile error. zh text is persisted in diagnostics and hashed by the fingerprint, so keep zh strings byte-identical when moving them, and rerun the fingerprint. Region and canvas names are a fixed zh vocabulary that is translated only for display (`src/i18n/names.ts`). Shared `src/i18n/index.ts` never reads `navigator`. Chinese UI copy should read as a person wrote it, not as a translation.
- **UI contract:** keep the ids the tests use, `details.advanced`, `.export-advanced`, the `replaceOnce` anchors in `scripts/build-portable.ts`, and zh text in `static/index.html` byte-identical to the zh catalogue. The page makes no external requests. Controls and status stay on the printer, and the how-to stays above the fold at 390 px and 1440 px. Copy describes any travel path turning into one big screenshot, not only scrolling. After a UI change, check screenshots at 390, 1024, 1440 and 1920 px in en, covering the settings flap, the log sheet, the spread print and the demo.
- **Storage:** the browser keeps only the latest print, for 24 hours (`KEEP_MS` in `src/worker.ts`), as a safety net against reloads and crashes. Do not bring back project history or persistent-storage prompts.
- **Logos:** read a brand's usage policy before showing its logo; TypeScript and Deno are named as text only. Keep the footer and `LOGO_NOTICES` in `scripts/notices.ts` in step with the logos shown.
- **Demo video:** if `static/demo/sample.mp4` is regenerated (`deno task demo-video`), keep even per-frame steps, no B-frames and CRF ≤ 14, or recheck diagnostics in Chrome and WebKit.
- **Portable build** runs in Chromium only: WebKit cannot read a picked file inside a `file://` worker. Do not promise Safari support for it.

## Git and deployment

- Pushing `main` deploys to production: Cloudflare Pages' Git integration runs `bash scripts/pages-build.sh` and publishes `dist/`. Push only when the owner says so. Keep the host on Pages, add no Worker code or deploy test gate, and leave Deno unpinned unless the owner decides otherwise.
- `static/_headers` must match `RESPONSE_HEADERS` in `main.ts` (COOP/COEP/CORP and `no-cache`), and hosts must send them on 304 responses too.
- History on `main` is linear: no merge commits, and a few thematic commits per batch. Fold a fix for something earlier in the same unpushed series into that commit, and verify each rebuilt commit. Messages have a conventional subject and a body saying what changed and why, with no agent, session or round labels. Never rewrite pushed history.
- Other sessions may be working in sibling worktrees and branches. Leave branches, worktrees and commits you did not create alone.

## Working with the owner

- When the owner asks for a change, carry it through to a verified result without stopping to ask about steps the request already covers. When the owner describes a problem or asks a question, report your assessment and stop until they ask for a fix.
- Keep changes to what was asked. Report pre-existing bugs, performance concerns and cleanups you notice as follow-ups instead of fixing them in the same change.
- When relaying review findings, recommend fixes only for bugs with a realistic trigger: a real user flow, a shipped artifact, or data loss in normal use. Label speculative guards against misuse or hypothetical input "not worth it". Do not start another review→fix→review round unless asked.
- End with a short recap that stands on its own: what changed, how it was verified (commands and `test-results/` artifacts), and what is still open. Write it in plain language.
