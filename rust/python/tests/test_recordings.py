"""reconstruct() on real recordings against the native `long-screen` command on the same file, and the ways
opening a video fails."""

import json
import subprocess
import time
from collections import Counter

import numpy as np
import pytest

import long_screen
from conftest import array_hash, pixel_hash


@pytest.mark.parametrize("case", ["test_3", "test_7"])
def test_the_print_matches_the_command_line(case, recording, cli, tmp_path, report):
    video = recording(case)

    started = time.monotonic()
    command = [str(cli), str(video), "-o", str(tmp_path / "cli.png"), "--json", str(tmp_path / "cli.json"), "-q"]
    exit_code = subprocess.run(command, capture_output=True).returncode
    cli_seconds = time.monotonic() - started
    cli_report = json.loads((tmp_path / "cli.json").read_text())

    started = time.monotonic()
    result = long_screen.reconstruct(video)
    py_seconds = time.monotonic() - started
    result.save(tmp_path / "py.png")

    assert result.status == cli_report["status"]
    assert exit_code == (0 if result.status == "complete" else 3)
    assert result.frames == cli_report["frames"]
    assert pixel_hash(tmp_path / "py.png") == pixel_hash(tmp_path / "cli.png")
    # Same encoder, same settings: the files are byte for byte the same too.
    assert (tmp_path / "py.png").read_bytes() == (tmp_path / "cli.png").read_bytes()
    assert dict(Counter(d["code"] for d in result.diagnostics)) == cli_report["diagnostics"]["counts"]
    fragments = sorted(tmp_path.glob("cli-fragment-*.png"))
    assert len(result.fragments) == len(fragments)
    for i, (fragment, png) in enumerate(zip(result.fragments, fragments)):
        fragment.save(tmp_path / f"py-fragment-{i + 1}.png")
        assert pixel_hash(tmp_path / f"py-fragment-{i + 1}.png") == pixel_hash(png)

    image = result.print_image()
    assert image.dtype == np.uint8 and image.shape == (result.print.height, result.print.width, 4)
    assert array_hash(image) == pixel_hash(tmp_path / "py.png")

    report(
        case,
        {
            "video": video.name,
            "status": result.status,
            "frames": result.frames,
            "print": f"{result.print.width}x{result.print.height}",
            "fragments": len(result.fragments),
            "print_pixels_sha256": pixel_hash(tmp_path / "py.png"),
            "cli_print_pixels_sha256": pixel_hash(tmp_path / "cli.png"),
            "diagnostics": len(result.diagnostics),
            "python_seconds": round(py_seconds, 2),
            "cli_seconds": round(cli_seconds, 2),
        },
    )


def test_a_missing_file_is_file_not_found(tmp_path):
    with pytest.raises(FileNotFoundError):
        long_screen.reconstruct(tmp_path / "nothing.mov")


def test_a_file_that_is_not_a_video_is_a_decoder_error(tmp_path):
    path = tmp_path / "notes.mov"
    path.write_text("not a video")
    with pytest.raises(long_screen.DecoderError, match="cannot read"):
        long_screen.reconstruct(path)


def test_a_missing_ffmpeg_says_how_to_install_it(tmp_path, monkeypatch):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"\0" * 64)
    monkeypatch.setenv("LONGSCREEN_FFPROBE", str(tmp_path / "no-ffprobe"))
    monkeypatch.setenv("LONGSCREEN_FFMPEG", str(tmp_path / "no-ffmpeg"))
    with pytest.raises(long_screen.DecoderMissingError, match="Install ffmpeg") as caught:
        long_screen.reconstruct(path, backend="ffmpeg")
    assert isinstance(caught.value, long_screen.DecoderError)
    assert isinstance(caught.value, long_screen.LongScreenError)


def test_bad_options_are_value_errors(tmp_path):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"")
    with pytest.raises(ValueError, match="backend"):
        long_screen.reconstruct(path, backend="vlc")
    with pytest.raises(ValueError, match="lang"):
        long_screen.reconstruct(path, lang="de")
