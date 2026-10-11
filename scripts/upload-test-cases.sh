#!/usr/bin/env bash
# Publishes the public test recordings as assets of the GitHub Release that rust/bench/cases.json downloads them from
# (repository and tag are read from the manifest). Run by the repository owner, once per new set of recordings: it
# first checks every file against the manifest's size and SHA-256, then creates the release (marked not latest, so
# the app's own releases stay on top) and uploads the files. Needs `gh` signed in with write access.
#   bash scripts/upload-test-cases.sh /path/to/public_test_cases
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: $0 <directory holding the recordings>" >&2; exit 2; }
dir="$(cd "$1" && pwd)"
manifest=rust/bench/cases.json
repo="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release"]["repository"])' "$manifest")"
tag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release"]["tag"])' "$manifest")"
files=()
while IFS= read -r name; do files+=("$dir/$name"); done < <(
  python3 -c 'import json,sys; [print(c["file"]) for c in json.load(open(sys.argv[1]))["cases"]]' "$manifest"
)
(cd rust && LONGSCREEN_CASES="$dir" cargo run --quiet -p long-screen-bench --bin cases -- verify)
notes="Screen recordings used as Long Screen's public test and benchmark cases. Every file's size and SHA-256 are pinned in rust/bench/cases.json; see docs/TESTING.md."
gh release create "$tag" --repo "$repo" --title "Test cases ($tag)" --notes "$notes" --latest=false "${files[@]}"
