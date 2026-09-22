# Isolated Rust/Wasm assessment

This is **not the application's Rust backend**. Nothing in `src/` imports it. It ports the current
`Engine.consistencyMask` truth table and `downscaleGray` to measure feasibility without a full rewrite.
Both kernels use scalar Wasm, not SIMD or shared memory. No recording or reconstructed user pixels are used.

From the repository root:

```sh
rustup toolchain install 1.94.0 --profile minimal --target wasm32-unknown-unknown
bash experiments/wasm-assessment/build.sh
deno check experiments/wasm-assessment/*.ts
deno run -A experiments/wasm-assessment/benchmark.ts --lan-http
```

The build is pinned to Rust 1.94.0 with the wasm32 target.
Use `LONGSCREEN_CHROME=/path/to/chrome` if the default Playwright Chromium is unavailable. Playwright's WebKit
is installed as the repository README describes. The benchmark runs the two browsers sequentially. Do not run other benchmarks concurrently.

The harness bundles the **current production TS modules**, starts a temporary static HTTP server, then:

- Checks 160 deterministic small consistency cases (mixed masks, votes, missing/different-canvas neighbours,
  noise, occlusions, negative/fractional poses), four half-integer boundary cases, and two native-size cases.
- Checks gray output at 641×449/factor 2, 1082×1920/factor 4, 1919×1079/factor 4, 1×3/factor 8,
  and 3456×2234/factor 6, byte for byte.
- Warms each measured path three times, alternates TS/Wasm execution order for nine measured rounds,
  and saves all samples and medians to `test-results/wasm-assessment/{chromium,webkit}.json`.
- With `--lan-http`, requires `isSecureContext === false`, without overriding browser security features.

Resident timings exclude buffer preparation and copy costs. The one-frame path copies one 29.5 MiB RGBA
input and the 7.4 MiB output mask; the three-frame path copies all three RGBA inputs plus output.
Labels/votes/occlusions remain resident in both. The one-frame case models the bandwidth of a frame ring,
not a complete integrated decoder/ring implementation. Wasm reuses output storage while current TS allocates
a mask; this measures the candidate's data layout as well as compiler/code-generation differences.

The Wasm allocation is about 104 MiB for this experiment, **in addition to** the JS test buffers and browser
allocations. It is neither a process memory budget nor evidence of iPhone viability. The raw ABI is for
trusted, bounded test inputs only; prepared calls become invalid when the adapter resets its arena.
This is not a hardened production API. No decode, persistence, PNG codec, whole-pipeline or device benchmark
is included, and the TS oracle establishes migration equivalence, not independent reconstruction truth.

See [the architecture assessment](../../docs/RUST-WASM-ASSESSMENT.md) for the whole-pipeline limits and migration gates.
