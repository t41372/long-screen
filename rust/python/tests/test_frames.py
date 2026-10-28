"""reconstruct_frames on a synthetic page with known pixels: the result itself, re-iterables against one-shot
iterators, thread counts, and what goes wrong with bad frames."""

import numpy as np
import pytest

import long_screen
from conftest import H, OFFSETS, W


def run(frames, **kwargs):
    return long_screen.reconstruct_frames(frames, width=W, height=H, lossless=True, **kwargs)


def moving(result):
    [canvas] = [c for c in result.canvases if c.kind == "moving" and c.fragment == 0]
    return canvas


def test_the_print_is_the_page_that_scrolled_past(scroll, tmp_path):
    frames, full = scroll
    result = run(frames)
    assert result.status == "complete", [d["code"] for d in result.diagnostics]
    assert result.frames == len(OFFSETS)
    assert result.fragments == []
    content = moving(result)
    assert (content.width, content.height) == (W, H + OFFSETS[-1])
    x, y, _, _ = content.bounds
    image = content.image()
    assert image.dtype == np.uint8 and image.shape == (H + OFFSETS[-1], W, 4)
    # Every pixel of it is the page's, at the page position the canvas origin maps to.
    ox, oy = int(x), int(y)
    expected = full[oy : oy + image.shape[0], ox : ox + image.shape[1]]
    assert np.array_equal(image, expected), "pixels that are not the page's"
    # The print is that canvas (or its framed presentation); save() writes it and print_image() reads it.
    assert result.print is not None and content.id in (result.print.id, result.print.presents)
    result.save(tmp_path / "print.png")
    from PIL import Image

    with Image.open(tmp_path / "print.png") as png:
        assert np.array_equal(np.asarray(png.convert("RGBA")), result.print_image())


def test_the_result_package_is_the_pages_project_zip(scroll, tmp_path):
    """write_package writes the page's result package: its fixed entries first, then each level-0 tile's PNG with its
    coverage, provisional and quality records, the JSON-lines records and the summaries (docs/FORMAT.md)."""
    import json
    import zipfile

    frames, _ = scroll
    result = run(frames)
    result.write_package(tmp_path / "package.zip")
    with zipfile.ZipFile(tmp_path / "package.zip") as package:
        names = package.namelist()
        assert names[:4] == ["manifest.json", "index.html", "README.txt", "regions.json"]
        manifest = json.loads(package.read("manifest.json"))
        assert manifest["format"] == "long-screen/sparse-canvas" and manifest["version"] == 2
        assert {c["id"] for c in manifest["canvases"]} == {c.id for c in result.canvases}
        content = moving(result)
        tiles = [n for n in names if n.startswith(f"tiles/{content.id}/0/")]
        assert tiles, names
        for tile in tiles:
            xy = tile.rsplit("/", 1)[1][: -len(".png")]
            for record in (f"coverage/{content.id}/{xy}.bin", f"provisional/{content.id}/{xy}.bin", f"quality/{content.id}/{xy}.json"):
                assert record in names, record
        assert names[-10:] == [
            "observations.jsonl",
            "diagnostics.jsonl",
            "poses.jsonl",
            "pose-edges.jsonl",
            "analysis.jsonl",
            "temporal.jsonl",
            "attachments.jsonl",
            "graph-summary.json",
            "memory-stats.json",
            "performance.json",
        ]
        assert b"%%" not in package.read("index.html")


def test_a_generator_gives_the_same_rows_as_a_list(scroll):
    frames, _ = scroll
    duration = len(frames) / 30
    listed = run(frames, duration=duration)._fingerprint()
    generated = run((f for f in frames), duration=duration)._fingerprint()
    assert listed["rows"] == generated["rows"]


def test_results_do_not_depend_on_the_thread_count(scroll):
    frames, _ = scroll
    one = run(frames, threads=1)._fingerprint()["rows"]
    four = run(frames, threads=4)._fingerprint()["rows"]
    differing = [
        k for k in one if one[k] != four.get(k) and not k.endswith("/performance") and not k.startswith("project/")
    ]
    assert one.keys() == four.keys()
    assert differing == []


def test_diagnostics_are_dicts_in_the_chosen_language(scroll):
    frames, _ = scroll
    en = run(frames).diagnostics
    zh = run(frames, lang="zh").diagnostics
    assert [d["code"] for d in en] == [d["code"] for d in zh]
    first = en[0]
    assert set(first) == {"code", "severity", "message", "action", "frame", "time", "canvas", "occurrences", "params"}
    assert first["code"] == "MODEL_ASSUMPTIONS" and first["severity"] == "info"
    assert first["params"]["detail"]["lossless"] is True
    assert en[0]["message"] != zh[0]["message"]


def test_canvas_names_are_in_the_chosen_language(scroll):
    frames, _ = scroll
    en = run(frames)
    zh = run(frames, lang="zh")
    assert moving(en).name == "Content canvas 1"
    assert moving(zh).name == "内容画布 1"
    # Only what is shown follows the language: every stored row is the same.
    en_rows, zh_rows = en._fingerprint()["rows"], zh._fingerprint()["rows"]
    assert en_rows.keys() == zh_rows.keys()
    differing = [
        k
        for k in en_rows
        if en_rows[k] != zh_rows[k] and not k.endswith("/performance") and not k.startswith("project/")
    ]
    assert differing == []


def test_progress_reaches_complete(scroll):
    frames, _ = scroll
    events = []
    run(frames, on_progress=events.append)
    assert events[-1].phase == "complete" and events[-1].fraction == 1.0
    # Events are throttled to one per 100 ms, so a short run may skip a phase; the first and last always come.
    assert events[0].phase == "scanning"
    assert all(0.0 <= e.fraction <= 1.0 for e in events)
    assert all(e.total == len(OFFSETS) for e in events)


# --- Failure cases ---


def test_no_frames_fails_and_says_why():
    with pytest.raises(long_screen.RunFailedError, match="No observations could be decoded") as caught:
        run([])
    assert caught.value.result.status == "error"
    assert "PROCESSING_ERROR" in [d["code"] for d in caught.value.result.diagnostics]
    assert caught.value.result.print is None
    with pytest.raises(long_screen.LongScreenError, match="no print"):
        caught.value.result.save("never.png")


def test_a_frame_of_the_wrong_shape_is_named(scroll):
    frames, _ = scroll
    bad = frames[:5] + [(5 / 30, np.zeros((H, W // 2, 4), np.uint8))] + frames[6:]
    with pytest.raises(ValueError, match=r"frame 5: the image has shape \[400, 320, 4\]; expected \(400, 640, 4\)"):
        run(bad)


def test_a_frame_of_the_wrong_type_is_named(scroll):
    frames, _ = scroll
    with pytest.raises(TypeError, match="frame 1: the image must be a uint8 array"):
        run([frames[0], (1 / 30, frames[1][1].astype(np.float32))])
    with pytest.raises(TypeError, match=r"frame 0: expected a \(timestamp_seconds, image\) pair"):
        run([frames[0][1]])
    with pytest.raises(TypeError, match=r"frame 0: expected a \(timestamp_seconds, image\) pair"):
        run((f[1] for f in frames))


def test_a_non_contiguous_array_is_read_as_its_values(scroll):
    frames, _ = scroll
    # The same pixels through a strided view (every channel of a wider array).
    strided = []
    for t, image in frames:
        wide = np.zeros((H, W, 8), np.uint8)
        wide[..., ::2] = image
        strided.append((t, wide[..., ::2]))
    assert not strided[0][1].flags.c_contiguous
    assert run(strided)._fingerprint()["rows"] == run(frames)._fingerprint()["rows"]


def test_an_error_in_the_iterable_propagates(scroll):
    frames, _ = scroll

    class Broken:
        def __iter__(self):
            yield from frames[:3]
            raise RuntimeError("camera unplugged")

    with pytest.raises(RuntimeError, match="camera unplugged"):
        run(Broken())


def test_bad_arguments_are_refused_before_the_run(scroll):
    frames, _ = scroll
    with pytest.raises(ValueError, match="lang"):
        run(frames, lang="fr")
    with pytest.raises(ValueError, match="threads"):
        run(frames, threads=0)
    with pytest.raises(ValueError, match="memory_mb"):
        run(frames, memory_mb=-1)
    with pytest.raises(ValueError, match="width and height"):
        long_screen.reconstruct_frames(frames, width=0, height=H)
    with pytest.raises(TypeError):
        long_screen.reconstruct_frames(42, width=W, height=H)
