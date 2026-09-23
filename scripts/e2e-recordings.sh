#!/usr/bin/env bash
# End-to-end evidence for the Rust-core pipeline on real recordings, in real Chrome (Playwright's Chromium has
# no H.264). For every recording: builds and runs the current tree (and, with --baseline, the checkout in
# .baseline), hashes every persisted tile PNG and evidence row, and writes one summary JSON per input
# under test-results/e2e-recordings/. Recordings never leave the machine; only timings, counts and hashes are
# written. Usage:
#   LONGSCREEN_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bash scripts/e2e-recordings.sh [--baseline] file.mov [file2.mov ...]
set -euo pipefail
cd "$(dirname "$0")/.."
baseline=""
if [ "${1:-}" = "--baseline" ]; then
  baseline="--baseline-root .baseline"
  shift
fi
[ $# -ge 1 ] || { echo "usage: $0 [--baseline] recording.mov [...]" >&2; exit 2; }
out=test-results/e2e-recordings
mkdir -p "$out"
for input in "$@"; do
  name="$(basename "${input%.*}")"
  echo "== $input"
  # shellcheck disable=SC2086
  deno run --allow-all scripts/benchmark-pipeline.ts --input "$input" --passes 1 --allow-partial --verify-tiles \
    $baseline --output "$out/$name" 2>&1 | grep -vE "BENCHMARK (scanning|solving|rendering) \(" || true
  deno eval "
    const dir = '$out/$name';
    const read = async (f) => JSON.parse(await Deno.readTextFile(dir + '/' + f)).results[0];
    const pick = (r) => ({ status: r.status, frames: r.pipeline.frames, seconds: Math.round(r.pipeline.seconds), phases: Object.fromEntries(Object.entries(r.pipeline.phases).map(([k, v]) => [k, Math.round(v / 1000)])), png: { encodes: r.png.encodes, decodes: r.png.decodes }, storage: { putMany: r.storage.putManyCalls, writeS: Math.round(r.storage.writeMS / 1000) }, canvases: r.canvases.map((c) => ({ id: c.id, observedPixels: c.observedPixels, conflictPixels: c.conflictPixels, tiles: c.tileCount })), diagnostics: r.consistency.diagnostics, tiles: r.storedTiles && { count: r.storedTiles.count, sha256: r.storedTiles.sha256 } });
    const summary = { input: '$name', generatedAt: new Date().toISOString(), chrome: Deno.env.get('LONGSCREEN_CHROME') || 'playwright-chromium', current: pick(await read('$( [ -n "$baseline" ] && echo current || echo benchmark ).json')) };
    try { summary.baseline = pick(await read('baseline.json')); summary.speedup = Number((summary.baseline.seconds / summary.current.seconds).toFixed(2)); summary.identicalTiles = summary.baseline.tiles.sha256 === summary.current.tiles.sha256; } catch { /* no baseline run */ }
    await Deno.writeTextFile(dir + '/summary.json', JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  "
done
