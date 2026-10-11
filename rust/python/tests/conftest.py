"""Shared fixtures: the synthetic page, the public test recordings and the native command line to compare with.

Environment:
    LONGSCREEN_TEST_CASES  directory of the public recordings (default: test_case/public_test_cases in this checkout
                           or the main checkout above a worktree); tests that need them skip when it is missing.
    LONGSCREEN_CLI         the `long-screen` executable (default: built once with `cargo build --release`).
    LONGSCREEN_PY_REPORT   a JSON file the recording tests add their hashes and timings to.
"""

import hashlib
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

RUST = Path(__file__).resolve().parents[2]
REPO = RUST.parent


def find_cases() -> Path | None:
    if os.environ.get("LONGSCREEN_TEST_CASES"):
        return Path(os.environ["LONGSCREEN_TEST_CASES"])
    for root in [REPO, *REPO.parents]:
        candidate = root / "test_case" / "public_test_cases"
        if candidate.is_dir():
            return candidate
    return None


CASES = find_cases()


def pixel_hash(png: Path) -> str:
    """SHA-256 of a PNG's decoded RGBA pixels, with its size."""
    with Image.open(png) as image:
        rgba = image.convert("RGBA")
        return hashlib.sha256(f"{rgba.width}x{rgba.height}:".encode() + rgba.tobytes()).hexdigest()


def array_hash(image: np.ndarray) -> str:
    h, w, _ = image.shape
    return hashlib.sha256(f"{w}x{h}:".encode() + np.ascontiguousarray(image).tobytes()).hexdigest()


@pytest.fixture(scope="session")
def recording():
    """The path of a public test recording by its prefix (`test_3`), or a skip."""
    if CASES is None or not CASES.is_dir():
        pytest.skip("the public test recordings (test_case/public_test_cases) are not here")

    def find(prefix: str) -> Path:
        matches = sorted(CASES.glob(f"{prefix}_*"))
        if not matches:
            pytest.skip(f"{prefix} is not in {CASES}")
        return matches[0]

    return find


@pytest.fixture(scope="session")
def cli() -> Path:
    """The native `long-screen` executable, built in release mode once per session."""
    if os.environ.get("LONGSCREEN_CLI"):
        return Path(os.environ["LONGSCREEN_CLI"])
    try:
        subprocess.run(
            ["cargo", "build", "--release", "--locked", "-p", "long-screen"],
            cwd=RUST,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as e:
        pytest.skip(f"cannot build the long-screen command line: {e}")
    return RUST / "target" / "release" / "long-screen"


@pytest.fixture(scope="session")
def report():
    """Adds an entry to the LONGSCREEN_PY_REPORT JSON file, if one is named."""
    path = os.environ.get("LONGSCREEN_PY_REPORT")

    def add(key: str, value) -> None:
        if not path:
            return
        data = json.loads(Path(path).read_text()) if Path(path).exists() else {}
        data[key] = value
        Path(path).write_text(json.dumps(data, indent=2) + "\n")

    return add


# --- The synthetic page (the same one rust/long-screen/tests/driver.rs scrolls) ---

W, H = 640, 400
OFFSETS = [i * 23 for i in range(24)]


def page(width: int, height: int) -> np.ndarray:
    """A deterministic page with enough texture to track: hashed 4x4 cells over gradients."""
    y, x = np.mgrid[0:height, 0:width].astype(np.uint32)
    cell = ((x // 4) * np.uint32(73_856_093)) ^ ((y // 4) * np.uint32(19_349_663))
    h = cell * np.uint32(2_654_435_761)
    out = np.empty((height, width, 4), np.uint8)
    out[..., 0] = (h >> 24).astype(np.uint8)
    out[..., 1] = ((h >> 16) & 0xFF).astype(np.uint8) ^ (y & 0xFF).astype(np.uint8)
    out[..., 2] = ((h >> 8) & 0xFF).astype(np.uint8) ^ (x & 0xFF).astype(np.uint8)
    out[..., 3] = 255
    return out


@pytest.fixture(scope="session")
def scroll():
    """24 frames of a 640x400 window scrolled 23 px a frame down the page, at 30 fps, and the page itself."""
    full = page(W, H + OFFSETS[-1])
    frames = [(i / 30, np.ascontiguousarray(full[dy : dy + H])) for i, dy in enumerate(OFFSETS)]
    return frames, full
