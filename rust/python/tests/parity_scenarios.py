"""Fingerprints every synthetic scenario run inside the Python extension module, in the format of
scripts/fingerprint-scenarios.ts, for comparison with the native executable and the web page.

    deno run -A scripts/native-parity.ts export <dir>
    python rust/python/tests/parity_scenarios.py <dir> <out.json> [threads]
    deno run -A scripts/compare-fingerprints.ts <native or web fingerprint>.json <out.json>

Not a pytest module (it needs the exported scenarios, about 2 GB): `deno task test:python` does not run it.
"""

import json
import sys
from pathlib import Path

from long_screen import _native

directory, out = Path(sys.argv[1]), Path(sys.argv[2])
threads = int(sys.argv[3]) if len(sys.argv) > 3 else None
entries = {}
for scenario in sorted(p.name for p in directory.iterdir() if (p / "meta.json").exists()):
    entry = _native._fingerprint_raw(directory / scenario, threads)
    print(f"{scenario}: {len(entry['rows'])} rows, {entry['seconds']}s", file=sys.stderr)
    entries[scenario] = entry
out.write_text(json.dumps(entries, indent=2))
