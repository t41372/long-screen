# Contributing to Long Screen

Thanks for taking a look. This file has two parts: how to propose a change, and how the maintainer ships one (deploying the web app and releasing the packages).

## Proposing a change

- **Bugs and ideas:** open a [GitHub issue](https://github.com/t41372/long-screen/issues). For a wrong result, say which browser or package you used and, if you can share it, attach the recording or a short clip that shows the problem. A screenshot of the print and the diagnostics from the log sheet help too.
- **Pull requests:** small and focused is easiest to review. Say what changed and why, and how you checked it.

### Setting up

Install [Deno](https://deno.com) 2.x and [rustup](https://rustup.rs); rustup fetches the pinned Rust toolchain on the first build. `deno task start` builds the app and serves it on http://localhost:4173. The other tasks:

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

Browser tests (`deno task test:browser`) require Google Chrome (the Chromium bundled with Playwright doesn't include H.264) and Playwright's WebKit: `npx playwright@1.58.2 install webkit` (requires Node.js; the version matches the `playwright` entry in `deno.json`). `deno task fixtures` requires ffmpeg.

Run `deno task fmt` before committing and `deno task lint` before calling a change done.

### Where things are

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

### Rules

[AGENTS.md](AGENTS.md) holds the project's rules (it is written for coding agents, but it is the same rulebook for people). The ones that matter most:

- Algorithms live in the Rust crate (`rust/long-screen`); the TypeScript stays a thin shell around it.
- A change to the pipeline comes with evidence: a fingerprint comparison against `main` (`deno task fingerprint`), and for real recordings an A/B run. [docs/TESTING.md](docs/TESTING.md) explains both.
- UI text is added in both Chinese and English.

## Maintainer guide

### What ships where

Nothing is published by merging a pull request. Each target has its own trigger:

| What                         | Where it goes                                                                                     | What publishes it                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| The web app                  | https://long-screen.yi-ting.com and https://long-screen.pages.dev                                 | a push to `main` (Cloudflare Pages builds and deploys it) |
| Rust crate `long-screen`     | [crates.io](https://crates.io/crates/long-screen), docs on [docs.rs](https://docs.rs/long-screen) | a `crates-v<version>` tag                                 |
| Python package `long-screen` | [PyPI](https://pypi.org/project/long-screen/)                                                     | a `py-v<version>` tag                                     |
| npm package `long-screen`    | [npm](https://www.npmjs.com/package/long-screen)                                                  | an `npm-v<version>` tag                                   |

So pushing `main` updates the website straight away, and a tag sends one package to one registry. The three packages are built from the same source but versioned separately; you can release just one of them.

### The workflows

The four workflows in `.github/workflows` (CodSpeed benchmarks and the three release workflows) pin every action to a full commit hash, with the version in a comment next to it, run on the newest GitHub-hosted runner images, and keep the token's permissions to what each job needs. When you change one, or bump an action, run [zizmor](https://docs.zizmor.sh) and fix what it reports:

```sh
GH_TOKEN=$(gh auth token) uvx zizmor --pedantic .github/workflows
```

### Deploying the web app

Push to `main`. Cloudflare Pages runs `bash scripts/pages-build.sh` and publishes `dist/` within a few minutes; any other branch gets a preview URL instead. After a deploy, open the site and run the sample recording once. The threaded core needs the COOP/COEP headers from `static/_headers`; `curl -sI https://long-screen.yi-ting.com/` should list them. [README.md](README.md#deployment) covers hosting a copy anywhere else.

This repository deploys through Cloudflare Pages' Git integration: on a push to `main`, Cloudflare pulls the repository, runs `bash scripts/pages-build.sh` and publishes `dist/`; a push to any other branch creates a preview deployment. The Pages build image has neither Rust nor Deno installed, so the script first installs rustup and the toolchain pinned in `rust/rust-toolchain.toml`, then runs `deno task build:prod` with the official `deno` package from npm. Set it up once in the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git, pick this repository, production branch `main`, build command `bash scripts/pages-build.sh`, build output directory `dist`. No API token, repository secret or GitHub Actions is needed.

### Releasing

Version 0.1.0 of all three packages went out on 2026-10-12, from commit `748a0ac`; the crate and the Python package 0.1.1 on 2026-10-18, from `e0664e0`, through their tag workflows. The first release of each needed one-off manual steps; those are written up in [docs/RELEASING.md](docs/RELEASING.md) (in Chinese), together with every settings page and button. From now on a release is the same short routine for each package.

**1. Pick the version and write it down.** Between releases `main` carries the next version with a `-dev` suffix (now `0.1.2-dev`; `rust/wasm/Cargo.toml` follows the core crate), which is what the web page's printer plate shows next to the commit. For a release, drop the `-dev` (or change the number if this release is a different one); right after the release, move to the next `-dev` (after `0.1.1`, `0.1.2-dev`). A `-dev` version never matches a tag, so a release workflow stops before uploading if you forget. Each package keeps its version in one file:

| Package | File                                                   | Tag             |
| ------- | ------------------------------------------------------ | --------------- |
| crate   | `rust/long-screen/Cargo.toml`                          | `crates-v0.1.1` |
| Python  | `rust/python/Cargo.toml`                               | `py-v0.1.1`     |
| npm     | `deno.json` (copied into the package's `package.json`) | `npm-v0.1.1`    |

A version number can be used only once per registry, forever, even if you delete it later. Think about it before tagging, not after.

**2. Check it on your machine.** On the commit you are going to release, with a clean `git status`:

```sh
deno task lint && deno task test
deno task test:python                                  # if releasing the Python package
deno test --allow-all tests/browser/package.test.ts    # if releasing the npm package (opens Chrome and WebKit)
cd rust && cargo publish --dry-run --locked -p long-screen   # if releasing the crate
```

**3. Push `main`.** This also deploys the website, so check the site afterwards.

**4. Optional dry run on GitHub.** Each release workflow can be started by hand from the Actions tab (**Run workflow**, branch `main`). A manual run builds and tests everything but publishes nothing. Do this when the release touches the build, the workflows or the platforms.

**5. Tag and push the tag.** For example:

```sh
git tag -a py-v0.1.1 -m "Python package 0.1.1" <commit>
git push origin py-v0.1.1
```

The workflow builds and tests on Linux, macOS and Windows, then checks that the tag matches the version in the file. If they differ it stops before uploading anything.

**6. Approve.** The last job of each workflow waits for you: open the run on the Actions tab and press **Review deployments → Approve and deploy**. This is the point of no return.

**7. Check the result.** Open the registry page, then install the new version somewhere fresh:

```sh
uv run --with long-screen==0.1.1 python -c "import long_screen"   # Python
cargo install long-screen --version 0.1.1 --root /tmp/ls && /tmp/ls/bin/long-screen --help   # crate
cd "$(mktemp -d)" && npm init -y && npm install long-screen@0.1.1   # npm
```

For the crate, also check that docs.rs built the documentation (a few minutes after publishing).

### Per-registry notes

None of the workflows holds a password or a long-lived token. They use _trusted publishing_: when a job runs, GitHub vouches for it ("this is `release-crates.yml` in `t41372/long-screen`, environment `crates-io`") and the registry hands it a short-lived upload permission. Each registry has to be told once which repository, workflow file and environment to trust.

- **PyPI:** set up and already used for 0.1.0. Nothing to do.
- **crates.io:** 0.1.0 was uploaded by hand (crates.io only allows trusted publishing for a crate that already exists), and the `crates-v0.1.0` run skipped its upload because the version was already there. The `crates-v0.1.1` run was the first tag-driven upload and went through trusted publishing. If a later upload fails with an authorization error, compare the settings at https://crates.io/crates/long-screen/settings (owner `t41372`, repository `long-screen`, workflow `release-crates.yml`, environment `crates-io`) and press **Re-run failed jobs**. Once a tag has published successfully, consider turning on **Trusted Publishing only** there, which stops API tokens from publishing.
- **npm:** not set up yet. The `npm-v0.1.1` run built and packed the package and stopped at the upload with `E404` (no trusted publisher), so npm still serves 0.1.0. npm deletes a new trusted-publisher setting that has not been used within 48 hours, so create it right before re-running that run's failed job (or before the next `npm-v` tag): https://www.npmjs.com/package/long-screen/access → **Trusted Publisher** → GitHub Actions, with `t41372` / `long-screen` / `release-npm.yml` / `npm`, and tick **npm publish** under allowed actions. After that first automatic release, set **Publishing access** to "Require two-factor authentication and disallow tokens".

### Lessons from the first release

- Commands that ask for a browser login or a 2FA code (`npm login`, `npm publish`, `cargo login`) need a real terminal. Run them yourself; a script or an assistant's shell cannot wait for the browser step.
- A token made for a one-off upload should be the narrowest kind (crates.io: 7 days, `publish-new` only, limited to `long-screen`). Revoke it on the website as soon as the upload is done; `cargo logout` only deletes the local copy.
- A brand-new npm package shows a placeholder version `0.0.0-stage` for a few minutes while npm processes the upload. `latest` points at the real version once it is done.
- The crate's packaging warnings about examples and tests "not included in the published package" are expected: `include` in `rust/long-screen/Cargo.toml` leaves them out on purpose.

### When something goes wrong

- **The tag was wrong and nothing was uploaded yet** (the workflow stopped at the version check or a test): delete the tag (`git push origin :refs/tags/<tag>` and `git tag -d <tag>`), fix, push `main`, tag again.
- **A transient GitHub failure** (network, runner): press **Re-run failed jobs**. Re-running is safe: each workflow skips a version that is already on its registry.
- **A bad version was published:** you cannot overwrite or reuse it. Publish a fixed version (say 0.1.2), then mark the bad one: `cargo yank --version 0.1.1 long-screen`, "yank" on PyPI's release page, or `npm deprecate long-screen@0.1.1 "use 0.1.2"`. Existing users keep working; new installs skip it.
- **A secret was published by mistake:** revoke the secret first. Yanking and deprecating do not delete files.
