//! `long_screen._native`: the Python binding of the native driver (`rust/long-screen`). Binding glue only: it turns
//! Python arguments into the driver's `Options` and sources, runs [`long_screen::run`] with the GIL released, and
//! hands back the result's canvases as PNG files or NumPy arrays. The package `python/long_screen` re-exports it.
//!
//! Progress callbacks re-attach to the interpreter; so does each frame read from a Python iterable. Ctrl-C is
//! checked at every progress event and frame: it asks the run to stop through the driver's [`Control`] (which takes
//! effect between engine steps), and the `KeyboardInterrupt` is raised once the run has wound down.

mod frames;
mod result;

use long_screen::decode;
use long_screen::{run, Control, Error, Locale, Observer, Options, Progress, VideoSource};
use pyo3::create_exception;
use pyo3::exceptions::{PyException, PyFileNotFoundError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBool;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

create_exception!(
    long_screen,
    LongScreenError,
    PyException,
    "Base class of the errors Long Screen raises."
);
create_exception!(
    long_screen,
    DecoderError,
    LongScreenError,
    "The video could not be opened or decoded: no decoder reads it, or the file is not a video."
);
create_exception!(
    long_screen,
    DecoderMissingError,
    DecoderError,
    "The decoder the video needs (ffmpeg and ffprobe) is not installed; the message says how to install it."
);
create_exception!(
    long_screen,
    RunFailedError,
    LongScreenError,
    "The run produced nothing (no frame could be placed). `.result` holds its diagnostics."
);

/// One progress event of a run.
#[pyclass(frozen, get_all, module = "long_screen", name = "Progress")]
pub struct PyProgress {
    /// `scanning`, `solving`, `optimizing`, `rendering`, `revealing`, `framing`, `pyramid`, then `complete` or
    /// `partial`.
    phase: String,
    /// 0…1 within the phase.
    fraction: f64,
    /// Frames done in the phase.
    frames: u32,
    /// Frames the source lists, when it lists them.
    total: Option<u64>,
    /// Seconds into the recording.
    time: f64,
    /// What is happening, in the run's language.
    message: String,
    /// The canvas the event concerns, if any.
    canvas: Option<String>,
}

#[pymethods]
impl PyProgress {
    fn __repr__(&self) -> String {
        format!(
            "Progress(phase={:?}, fraction={:.3}, frames={}, time={:.3})",
            self.phase, self.fraction, self.frames, self.time
        )
    }
}

impl From<&Progress> for PyProgress {
    fn from(p: &Progress) -> PyProgress {
        PyProgress {
            phase: p.phase.clone(),
            fraction: p.fraction,
            frames: p.frames,
            total: p.total,
            time: p.time,
            message: p.message.clone(),
            canvas: p.canvas.clone(),
        }
    }
}

/// The first Python exception of a run (from a callback, a frame iterable or Ctrl-C), raised after it ends.
#[derive(Clone, Default)]
pub(crate) struct Failure(Arc<Mutex<Option<PyErr>>>);

impl Failure {
    /// Keeps `error` unless an earlier one is kept, and asks the run to stop.
    pub(crate) fn set(&self, error: PyErr, control: &Control) {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(error);
        }
        control.stop();
    }

    pub(crate) fn is_set(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    fn take(&self) -> Option<PyErr> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Calls the progress callback (attached to the interpreter) and checks for Ctrl-C at every event.
struct PyObserver {
    callback: Option<Py<PyAny>>,
    control: Control,
    failure: Failure,
}

impl Observer for PyObserver {
    fn progress(&mut self, progress: &Progress) {
        if self.failure.is_set() {
            return;
        }
        Python::attach(|py| {
            if let Err(e) = py.check_signals() {
                self.failure.set(e, &self.control);
                return;
            }
            let Some(callback) = &self.callback else {
                return;
            };
            match callback.call1(py, (PyProgress::from(progress),)) {
                // `False` (not merely falsy) stops the run and keeps what is done.
                Ok(value) => {
                    let value = value.bind(py);
                    if value.is_instance_of::<PyBool>() && !value.is_truthy().unwrap_or(true) {
                        self.control.stop();
                    }
                }
                Err(e) => self.failure.set(e, &self.control),
            }
        });
    }
}

/// The options every entry point shares.
pub(crate) struct Common {
    pub options: Options,
    pub callback: Option<Py<PyAny>>,
}

pub(crate) fn common(
    lang: &str,
    threads: Option<usize>,
    memory_mb: Option<f64>,
    on_progress: Option<Py<PyAny>>,
) -> PyResult<Common> {
    let locale = match lang {
        "en" => Locale::En,
        "zh" => Locale::Zh,
        other => {
            return Err(PyValueError::new_err(format!(
                "lang must be \"en\" or \"zh\", not {other:?}"
            )))
        }
    };
    let mut options = Options {
        locale,
        ..Options::default()
    };
    if threads == Some(0) {
        return Err(PyValueError::new_err(
            "threads must be at least 1 (or None for one per core)",
        ));
    }
    options.threads = threads;
    if let Some(mb) = memory_mb {
        if !(mb.is_finite() && mb > 0.0) {
            return Err(PyValueError::new_err(format!(
                "memory_mb must be a positive number of megabytes, not {mb}"
            )));
        }
        options.settings.memory_mb = mb;
    }
    Ok(Common {
        options,
        callback: on_progress,
    })
}

/// Runs the driver on `source` with the GIL released and turns its outcome into a `Result` or an exception.
pub(crate) fn run_source(
    py: Python<'_>,
    source: &mut dyn long_screen::FrameSource,
    common: Common,
    control: Control,
    failure: Failure,
) -> PyResult<result::PyRunResult> {
    let mut observer = PyObserver {
        callback: common.callback,
        control: control.clone(),
        failure: failure.clone(),
    };
    let options = common.options;
    let outcome = py.detach(|| run(source, &options, &mut observer, &control));
    if let Some(error) = failure.take() {
        return Err(error);
    }
    match outcome {
        Ok(r) => Ok(result::PyRunResult::new(r)),
        Err(Error::Failed { message, result }) => {
            let error = RunFailedError::new_err(message);
            let value = error.value(py);
            value.setattr("result", result::PyRunResult::new(*result))?;
            Err(error)
        }
        Err(Error::Settings(m)) => Err(PyValueError::new_err(m)),
        Err(e @ Error::Threads(_)) => Err(LongScreenError::new_err(e.to_string())),
    }
}

/// Maps a decoder error to the exception a caller can act on.
fn decode_error(path: &std::path::Path, error: decode::Error) -> PyErr {
    let message = format!("cannot read {}: {error}", path.display());
    match error {
        decode::Error::ToolMissing { .. } => DecoderMissingError::new_err(message),
        _ => DecoderError::new_err(message),
    }
}

/// Turns a screen recording into one big screenshot.
///
/// Decodes `path` with the system decoder (AVFoundation on macOS, Media Foundation on Windows) or a user-installed
/// ffmpeg (Linux, and files the system decoder cannot read) and runs the whole reconstruction. The GIL is released
/// while the engine runs.
///
/// Args:
///     path: The recording (MP4, MOV, WebM, ... whatever the decoder reads), as a str or os.PathLike.
///     lang: Language of diagnostics and progress messages: "en" or "zh".
///     threads: Kernel threads; None uses one per core. Results do not depend on it.
///     memory_mb: Working memory of the tile cache in MB (default 128).
///     backend: "auto", "avfoundation" (macOS), "mediafoundation" (Windows) or "ffmpeg".
///     on_progress: Called with a Progress about ten times a second, on the calling thread. Return False to stop
///         the run and keep what is done (the result's status is then "partial"); an exception raised in it stops
///         the run and propagates.
///
/// Returns:
///     A Result. Its status is "complete", or "partial" when the run stopped early or could not use every frame;
///     read its diagnostics either way.
///
/// Raises:
///     FileNotFoundError: `path` does not exist.
///     DecoderMissingError: ffmpeg is needed and not installed (the message says how to install it).
///     DecoderError: no decoder can read the file.
///     RunFailedError: nothing could be reconstructed; `.result.diagnostics` says why.
///     KeyboardInterrupt: Ctrl-C; the run stops at its next step first.
#[pyfunction]
#[pyo3(signature = (path, *, lang = "en", threads = None, memory_mb = None, backend = "auto", on_progress = None))]
fn reconstruct(
    py: Python<'_>,
    path: PathBuf,
    lang: &str,
    threads: Option<usize>,
    memory_mb: Option<f64>,
    backend: &str,
    on_progress: Option<Py<PyAny>>,
) -> PyResult<result::PyRunResult> {
    let common = common(lang, threads, memory_mb, on_progress)?;
    let backend = decode::Backend::parse(backend).ok_or_else(|| {
        PyValueError::new_err(format!(
            "backend must be \"auto\", \"avfoundation\", \"mediafoundation\" or \"ffmpeg\", not {backend:?}"
        ))
    })?;
    if !path.is_file() {
        return Err(PyFileNotFoundError::new_err((
            2,
            "No such file",
            path.display().to_string(),
        )));
    }
    let options = decode::Options::with_backend(backend);
    let mut source = py
        .detach(|| VideoSource::open(&path, options))
        .map_err(|e| decode_error(&path, e))?;
    run_source(py, &mut source, common, Control::new(), Failure::default())
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = m.py();
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add_function(wrap_pyfunction!(reconstruct, m)?)?;
    m.add_function(wrap_pyfunction!(frames::reconstruct_frames, m)?)?;
    m.add_function(wrap_pyfunction!(frames::_fingerprint_raw, m)?)?;
    m.add_class::<result::PyRunResult>()?;
    m.add_class::<result::PyCanvas>()?;
    m.add_class::<PyProgress>()?;
    m.add("LongScreenError", py.get_type::<LongScreenError>())?;
    m.add("DecoderError", py.get_type::<DecoderError>())?;
    m.add("DecoderMissingError", py.get_type::<DecoderMissingError>())?;
    m.add("RunFailedError", py.get_type::<RunFailedError>())?;
    Ok(())
}
