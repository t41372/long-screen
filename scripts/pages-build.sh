#!/usr/bin/env bash
# Build command for Cloudflare Pages' Git integration: in the Pages project's build settings, build command
# `bash scripts/pages-build.sh` and build output directory `dist`. Pages' build image preinstalls neither Rust nor Deno
# (https://developers.cloudflare.com/pages/configuration/build-image/), so this installs both and then runs
# `deno task build:prod`: rustup with the toolchain rust/rust-toolchain.toml pins, and the latest Deno 2 from its
# official npm package (the image has Node and npm; Deno's own install script needs `unzip`, which it may not have).
# A rustup or Deno already on PATH is used as-is, so the script also runs on a development machine.
set -euo pipefail
cd "$(dirname "$0")/.."
# Cargo links build scripts (crc32fast's, and std's in the threads build's -Zbuild-std) for the build machine itself,
# which needs a C linker. The Pages image documentation does not say whether it has one, so say so plainly if not.
if ! command -v cc > /dev/null; then
  echo 'pages-build.sh: no C linker (cc) on PATH, which cargo needs to link build scripts.' >&2
  exit 1
fi
if ! command -v rustup > /dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  . "$HOME/.cargo/env"
fi
(cd rust && rustup toolchain install)
if command -v deno > /dev/null; then
  deno task build:prod
else
  npx --yes deno@2 task build:prod
fi
