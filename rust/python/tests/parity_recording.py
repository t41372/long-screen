"""Fingerprints `long_screen.reconstruct(video)` run inside the Python extension module, for comparison with the
native executable's run of the same call (rust/python/examples/fingerprint.rs):

    python rust/python/tests/parity_recording.py <video> <out.json>
    cargo run --release -p long-screen-py --example fingerprint -- <video> <native.json>
    deno run -A scripts/compare-fingerprints.ts <native.json> <out.json>

Not a pytest module: `deno task test:python` does not run it.
"""

import json
import sys
from pathlib import Path

import long_screen

video, out = Path(sys.argv[1]), Path(sys.argv[2])
result = long_screen.reconstruct(video)
entry = result._fingerprint()
print(f"{video}: {len(entry['rows'])} rows, {result.status}, {result.seconds:.1f}s", file=sys.stderr)
out.write_text(json.dumps({video.name: entry}, indent=2))
