#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cargo +1.94.0 build --locked --offline --release --target wasm32-unknown-unknown
