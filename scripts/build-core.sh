#!/usr/bin/env bash
# Builds the Rust reconstruction core to WebAssembly twice: a baseline (scalar) module for every engine, and a
# SIMD128 module for browsers whose WebAssembly.validate accepts v128 (Chrome 91+, Safari 16.4+). The adapter picks
# at load time (src/core/wasm.ts::coreURL). Outputs under rust/target/{scalar,simd}/wasm32-unknown-unknown/
# release/long_screen_core.wasm; scripts/build.ts copies them to dist/assets/core.wasm and core.simd.wasm.
# Requires rustup, which installs the toolchain pinned in rust/rust-toolchain.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
cd rust
common="-C link-arg=--export=__heap_base"
RUSTFLAGS="$common -C target-feature=-simd128" \
  cargo build --release --locked --target wasm32-unknown-unknown --target-dir target/scalar "$@"
RUSTFLAGS="$common -C target-feature=+simd128" \
  cargo build --release --locked --target wasm32-unknown-unknown --target-dir target/simd "$@"
# Keep the historical single-output path for tests/tools that read it.
mkdir -p target/wasm32-unknown-unknown/release
cp target/scalar/wasm32-unknown-unknown/release/long_screen_core.wasm target/wasm32-unknown-unknown/release/long_screen_core.wasm
ls -l target/scalar/wasm32-unknown-unknown/release/long_screen_core.wasm \
      target/simd/wasm32-unknown-unknown/release/long_screen_core.wasm
