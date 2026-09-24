#!/usr/bin/env bash
# Builds the Rust reconstruction core to WebAssembly three times from one source: a baseline (scalar) module for
# every engine; a SIMD128 module for engines whose WebAssembly.validate accepts v128 (Chrome 91+, Safari 16.4+); and
# a SIMD128 + shared-memory threads module for cross-origin-isolated pages, whose kernels split work across pool
# helper workers (rust/core/src/pool.rs). The adapter picks at load time (src/core/wasm.ts::planCore). Outputs under
# rust/target/{scalar,simd,threads}/wasm32-unknown-unknown/release/long_screen_core.wasm; scripts/build.ts
# copies them to dist/assets/core.wasm, core.simd.wasm and core.threads.wasm.
#
# The threaded build must rebuild std with atomics (-Zbuild-std), which stable rustc only allows with
# RUSTC_BOOTSTRAP=1; it uses the same pinned 1.94.0 toolchain plus its rust-src component. Its memory limits must
# match THREADS_INITIAL_PAGES / THREADS_MAX_PAGES in src/core/wasm.ts.
# Requires rustup, which installs the toolchain pinned in rust/rust-toolchain.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
cd rust
common="-C link-arg=--export=__heap_base"
RUSTFLAGS="$common -C target-feature=-simd128" \
  cargo build --release --locked --target wasm32-unknown-unknown --target-dir target/scalar "$@"
RUSTFLAGS="$common -C target-feature=+simd128" \
  cargo build --release --locked --target wasm32-unknown-unknown --target-dir target/simd "$@"
threads="$common -C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128"
threads="$threads -C link-arg=--shared-memory -C link-arg=--import-memory"
threads="$threads -C link-arg=--initial-memory=33554432 -C link-arg=--max-memory=2147483648"
for symbol in __stack_pointer __wasm_init_tls __tls_size __tls_align __tls_base; do
  threads="$threads -C link-arg=--export=$symbol"
done
RUSTC_BOOTSTRAP=1 RUSTFLAGS="$threads" \
  cargo build --release --locked --target wasm32-unknown-unknown -Zbuild-std=panic_abort,std \
  --target-dir target/threads "$@"
# The threads build's "unstable feature `stdarch_wasm_atomic_wait`" warning during compilation is expected: it is
# only reachable via RUSTC_BOOTSTRAP=1 + -Zbuild-std above, which is how this script unlocks nightly-gated wait/notify
# on the stable toolchain pinned in rust/rust-toolchain.toml.
ls -l target/scalar/wasm32-unknown-unknown/release/long_screen_core.wasm \
      target/simd/wasm32-unknown-unknown/release/long_screen_core.wasm \
      target/threads/wasm32-unknown-unknown/release/long_screen_core.wasm
