"""Type stubs of the extension module (rust/python/src); the docstrings there are the reference."""

import os
from collections.abc import Callable, Iterable
from typing import Any, Literal, TypedDict, final

import numpy as np
import numpy.typing as npt

__version__: str

Lang = Literal["en", "zh"]
Backend = Literal["auto", "avfoundation", "mediafoundation", "ffmpeg"]
Severity = Literal["info", "warning", "error"]

class Diagnostic(TypedDict):
    code: str
    severity: Severity
    message: str
    action: str | None
    frame: int | None
    time: float | None
    canvas: str | None
    occurrences: int
    params: dict[str, Any]

@final
class Progress:
    """One progress event of a run."""

    phase: str
    fraction: float
    frames: int
    total: int | None
    time: float
    message: str
    canvas: str | None

ProgressCallback = Callable[[Progress], bool | None]

@final
class Canvas:
    """One canvas of a Result: the print, a fragment, screen-fixed interface or a framed presentation."""

    @property
    def id(self) -> str: ...
    @property
    def layer(self) -> str: ...
    @property
    def name(self) -> str:
        """The canvas's name in the run's language ("Content canvas 1" with lang="en"); `id` and `layer` are the stable identifiers."""
    @property
    def kind(self) -> Literal["moving", "fixed", "presentation"]: ...
    @property
    def bounds(self) -> tuple[float, float, float, float]: ...
    @property
    def width(self) -> int: ...
    @property
    def height(self) -> int: ...
    @property
    def tile_count(self) -> int: ...
    @property
    def observed_pixels(self) -> float: ...
    @property
    def fragment(self) -> int: ...
    @property
    def presents(self) -> str | None: ...
    def save(self, path: str | os.PathLike[str]) -> None:
        """Writes the canvas to `path` as an RGBA PNG (unobserved pixels transparent)."""
    def image(self) -> npt.NDArray[np.uint8]:
        """The canvas as a uint8 array of shape (height, width, 4), RGBA. Large canvases take a lot of memory."""

@final
class Result:
    """What a run produced: its status, diagnostics and canvases."""

    @property
    def status(self) -> Literal["complete", "partial", "error"]: ...
    @property
    def error(self) -> str | None: ...
    @property
    def frames(self) -> int: ...
    @property
    def seconds(self) -> float: ...
    @property
    def diagnostics(self) -> list[Diagnostic]: ...
    @property
    def print(self) -> Canvas | None:
        """The canvas the web page shows first: a framed presentation when the run framed one, else reconstructed
        content, each kind by observed pixels, most first. None when nothing was reconstructed."""
    @property
    def fragments(self) -> list[Canvas]:
        """The reconstructed content other than the print's own, in the order the web page lists it."""
    @property
    def canvases(self) -> list[Canvas]: ...
    def save(self, path: str | os.PathLike[str]) -> None:
        """Writes the print to `path` as an RGBA PNG (unobserved pixels transparent)."""
    def print_image(self) -> npt.NDArray[np.uint8]:
        """The print as a uint8 array of shape (height, width, 4), RGBA. A long print is large."""

class LongScreenError(Exception):
    """Base class of the errors Long Screen raises."""

class DecoderError(LongScreenError):
    """The video could not be opened or decoded."""

class DecoderMissingError(DecoderError):
    """ffmpeg is needed and not installed; the message says how to install it."""

class RunFailedError(LongScreenError):
    """The run produced nothing; `.result` holds its diagnostics."""

    result: Result

def reconstruct(
    path: str | os.PathLike[str],
    *,
    lang: Lang = "en",
    threads: int | None = None,
    memory_mb: float | None = None,
    backend: Backend = "auto",
    on_progress: ProgressCallback | None = None,
) -> Result:
    """Turns a screen recording into one big screenshot."""

def reconstruct_frames(
    frames: Iterable[tuple[float, npt.NDArray[np.uint8]]],
    *,
    width: int,
    height: int,
    lang: Lang = "en",
    threads: int | None = None,
    memory_mb: float | None = None,
    lossless: bool = False,
    duration: float | None = None,
    on_progress: ProgressCallback | None = None,
) -> Result:
    """Reconstructs from (timestamp_seconds, RGBA uint8 array of shape (height, width, 4)) pairs."""
