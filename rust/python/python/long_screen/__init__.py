"""Long Screen: a screen recording of a page explored along any path in, one big screenshot out.

    import long_screen

    result = long_screen.reconstruct("recording.mov")
    result.save("print.png")
    warnings = [d for d in result.diagnostics if d["severity"] != "info"]

`reconstruct` decodes a video file; `reconstruct_frames` takes frames you decoded yourself. Both return a `Result`
with the run's status, its diagnostics and its canvases (the print, separate fragments, screen-fixed interface).
Reconstruction is heuristic: a complete run does not prove the print is right, so read the diagnostics.
"""

from ._native import (
    Canvas,
    DecoderError,
    DecoderMissingError,
    LongScreenError,
    Progress,
    Result,
    RunFailedError,
    __version__,
    reconstruct,
    reconstruct_frames,
)

__all__ = [
    "Canvas",
    "DecoderError",
    "DecoderMissingError",
    "LongScreenError",
    "Progress",
    "Result",
    "RunFailedError",
    "__version__",
    "reconstruct",
    "reconstruct_frames",
]
