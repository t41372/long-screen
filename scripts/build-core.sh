#!/usr/bin/env bash
# Builds the Rust reconstruction core to WebAssembly. Output: rust/target/.../long_screen_core.wasm
# (copied into dist/assets/core.wasm by scripts/build.ts). Requires rustup, which installs the
# toolchain pinned in rust/rust-toolchain.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
cd rust
cargo build --release --locked --target wasm32-unknown-unknown "$@"
ls -l target/wasm32-unknown-unknown/release/long_screen_core.wasm
