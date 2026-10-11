#!/usr/bin/env bash
# Builds the Python package's wheel (rust/python) with maturin, installs it into a fresh CPython 3.11 venv
# (rust/target/py311) and runs its pytest suite there. Needs uv (https://docs.astral.sh/uv/), which fetches maturin
# and Python 3.11 when they are missing. Extra arguments go to pytest, e.g. `deno task test:python -k frames`.
# The recording tests use test_case/public_test_cases (or LONGSCREEN_TEST_CASES) and skip without it.
set -euo pipefail
cd "$(dirname "$0")/../rust"
rm -rf target/wheels/long_screen-*.whl target/py311
(cd python && uvx --from maturin==1.15.0 maturin build --release --locked --out ../target/wheels)
uv venv --quiet --python 3.11 target/py311
uv pip install --quiet --python target/py311 target/wheels/long_screen-*.whl pytest pillow
target/py311/bin/python -m pytest python/tests "$@"
