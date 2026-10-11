"""Stopping a run: a progress callback that returns False, one that raises, and Ctrl-C (SIGINT) while the engine
runs with the GIL released."""

import os
import signal
import sys
import threading
import time

import numpy as np
import pytest

import long_screen
from conftest import H, W, page

FRAMES = 240

# os.kill(pid, SIGINT) ends the process on Windows instead of raising KeyboardInterrupt in it.
posix_signals = pytest.mark.skipif(sys.platform == "win32", reason="SIGINT is not delivered as on POSIX")


@pytest.fixture(scope="module")
def long_scroll():
    """240 frames (a few seconds of work): long enough to interrupt partway."""
    full = page(W, H + 23 * (FRAMES - 1))
    return [(i / 30, np.ascontiguousarray(full[i * 23 : i * 23 + H])) for i in range(FRAMES)]


def run(frames, on_progress):
    return long_screen.reconstruct_frames(frames, width=W, height=H, lossless=True, on_progress=on_progress)


def test_returning_false_stops_and_keeps_what_is_done(long_scroll):
    result = run(long_scroll, lambda p: False if p.phase == "solving" else None)
    assert result.status == "partial"
    assert result.frames == FRAMES, "the scan finished before the stop"
    # A stop is honoured, not reported as a failure, and no presentation is built after it.
    assert "PROCESSING_ERROR" not in [d["code"] for d in result.diagnostics]
    assert all(c.kind != "presentation" for c in result.canvases)


def test_an_exception_in_the_callback_stops_the_run_and_propagates(long_scroll):
    seen = []

    def interrupt(p):
        seen.append(p.phase)
        if p.phase == "solving":
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        run(long_scroll, interrupt)
    # The callback is not called again after it raised.
    assert seen[-1] == "solving" and seen.count("solving") == 1


@posix_signals
def test_ctrl_c_stops_the_run_between_steps(long_scroll):
    started = time.monotonic()
    full = run(long_scroll, None)
    whole = time.monotonic() - started
    assert full.status == "complete"

    timer = threading.Timer(0.3, os.kill, (os.getpid(), signal.SIGINT))
    started = time.monotonic()
    timer.start()
    with pytest.raises(KeyboardInterrupt):
        run(long_scroll, None)
    elapsed = time.monotonic() - started
    timer.join()
    # Relative to a whole run, so a slow machine does not fail it.
    assert elapsed < 0.3 + whole / 2, f"took {elapsed:.2f} s to stop (a whole run takes {whole:.2f} s)"


@posix_signals
def test_ctrl_c_stops_copying_a_generator(long_scroll):
    def slow():
        for frame in long_scroll:
            time.sleep(0.01)
            yield frame

    timer = threading.Timer(0.3, os.kill, (os.getpid(), signal.SIGINT))
    started = time.monotonic()
    timer.start()
    with pytest.raises(KeyboardInterrupt):
        run(slow(), None)
    timer.join()
    assert time.monotonic() - started < 1.0
