//! `reconstruct_frames`: frames the caller decoded, as (timestamp, RGBA array) pairs.
//!
//! The engine reads its source once per pass (scan, solve, render and the reveal's sweeps). A re-iterable (a list,
//! a tuple, any object whose `iter()` starts over) is read again for each pass, one frame at a time with the
//! interpreter attached, so nothing is copied up front. A one-shot iterator (a generator) cannot be read twice, so
//! its frames are first written to a temporary file, which the run reads like the native driver's `RawSource`.

use crate::{common, result, run_source, Failure};
use long_screen::source::{
    Frame, FrameSource, Frames, MediaInfo, RawFrame, RawSource, SourceError, DECODED_VIDEO_NOISE,
};
use long_screen::value::{Js, Obj};
use long_screen::{Control, Framing, Settings, TemporalPolicy};
use pyo3::buffer::PyBuffer;
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyIterator};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A frame's duration when nothing later says (as `VideoSource` starts).
const FIRST_STEP: f64 = 1.0 / 60.0;

/// One (timestamp, image) item as a time and tightly packed RGBA bytes, checked against the run's size.
fn frame_of(
    py: Python<'_>,
    item: &Bound<'_, PyAny>,
    index: usize,
    width: usize,
    height: usize,
) -> PyResult<(f64, Vec<u8>)> {
    let (time, image): (f64, Bound<'_, PyAny>) = item.extract().map_err(|_| {
        PyTypeError::new_err(format!(
            "frame {index}: expected a (timestamp_seconds, image) pair, got {}",
            type_name(item)
        ))
    })?;
    if !time.is_finite() {
        return Err(PyValueError::new_err(format!(
            "frame {index}: the timestamp must be a finite number of seconds, not {time}"
        )));
    }
    let buffer = PyBuffer::<u8>::get(&image).map_err(|_| {
        PyTypeError::new_err(format!(
            "frame {index}: the image must be a uint8 array of shape ({height}, {width}, 4) (RGBA), got {}",
            type_name(&image)
        ))
    })?;
    if buffer.shape() != [height, width, 4] {
        return Err(PyValueError::new_err(format!(
            "frame {index}: the image has shape {:?}; expected ({height}, {width}, 4) (RGBA)",
            buffer.shape()
        )));
    }
    Ok((time, buffer.to_vec(py)?))
}

fn type_name(value: &Bound<'_, PyAny>) -> String {
    value
        .get_type()
        .name()
        .map(|n| n.to_string())
        .unwrap_or_else(|_| "?".into())
}

/// The `MediaInfo` of frames handed over from Python, in the page's field order.
fn frames_info(
    width: usize,
    height: usize,
    duration: f64,
    frame_count: Option<usize>,
    lossless: bool,
) -> MediaInfo {
    let mut js = Obj::new()
        .with("name", "frames")
        .with("size", 0u32)
        .with("width", width)
        .with("height", height)
        .with("codedWidth", width)
        .with("codedHeight", height)
        .with("rotation", 0u32)
        .with("duration", duration)
        .with("codec", "rgba");
    if let Some(n) = frame_count {
        js.set("frameCount", n);
    }
    js.set("mode", "Frames from Python");
    js.set("noise", if lossless { 0.0 } else { DECODED_VIDEO_NOISE });
    js.set("warnings", Js::Arr(Vec::new()));
    js.set("notices", Js::Arr(Vec::new()));
    MediaInfo::from_js(js)
}

/// Frames read again from a re-iterable Python object for every pass.
struct PyFrames {
    iterable: Py<PyAny>,
    info: MediaInfo,
    duration: Option<f64>,
    control: Control,
    failure: Failure,
}

impl FrameSource for PyFrames {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        let (width, height) = (self.info.width, self.info.height);
        let (control, failure) = (self.control.clone(), self.failure.clone());
        let fail = move |e: PyErr| {
            let message = e.to_string();
            failure.set(e, &control);
            SourceError(message)
        };
        let iterator: Py<PyIterator> =
            Python::attach(|py| self.iterable.bind(py).try_iter().map(Bound::unbind))
                .map_err(&fail)?;
        let duration = self.duration;
        let mut index = 0usize;
        let mut read = move || -> Result<Option<(f64, Vec<u8>)>, SourceError> {
            let item = Python::attach(|py| -> PyResult<Option<(f64, Vec<u8>)>> {
                py.check_signals()?;
                match iterator.bind(py).clone().next() {
                    None => Ok(None),
                    Some(item) => frame_of(py, &item?, index, width, height).map(Some),
                }
            })
            .map_err(&fail)?;
            index += 1;
            Ok(item)
        };
        // One frame of lookahead gives each frame its duration (the next timestamp minus its own).
        let mut pending: Option<(f64, Vec<u8>)> = None;
        let mut started = false;
        let mut out_index = 0u32;
        let mut last_step = FIRST_STEP;
        Ok(Box::new(std::iter::from_fn(move || {
            if !started {
                started = true;
                match read() {
                    Ok(first) => pending = first,
                    Err(e) => return Some(Err(e)),
                }
            }
            let (time, rgba) = pending.take()?;
            let next = match read() {
                Ok(next) => next,
                Err(e) => return Some(Err(e)),
            };
            let step = match &next {
                Some((t, _)) if *t > time => t - time,
                Some(_) => last_step,
                None => duration
                    .map(|d| d - time)
                    .filter(|d| *d > 0.0)
                    .unwrap_or(last_step),
            };
            last_step = step;
            pending = next;
            let frame = Frame {
                index: out_index,
                time,
                duration: step,
                width,
                height,
                rgba,
            };
            out_index += 1;
            Some(Ok(frame))
        })))
    }
}

/// A temporary directory removed when dropped.
struct Spool(PathBuf);

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes a one-shot iterator's frames to a temporary file; returns the file's frames and their times.
fn spool(
    py: Python<'_>,
    iterator: &Bound<'_, PyIterator>,
    width: usize,
    height: usize,
    duration: Option<f64>,
) -> PyResult<(Spool, PathBuf, Vec<RawFrame>)> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("long-screen-py-{}-{nanos:x}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let spool = Spool(dir.clone());
    let path = dir.join("frames.rgba");
    let mut file = BufWriter::new(File::create(&path)?);
    let mut times = Vec::new();
    for (index, item) in iterator.clone().enumerate() {
        py.check_signals()?;
        let (time, rgba) = frame_of(py, &item?, index, width, height)?;
        py.detach(|| file.write_all(&rgba))?;
        times.push(time);
    }
    file.flush()?;
    let mut frames = Vec::with_capacity(times.len());
    let mut last_step = FIRST_STEP;
    for (i, &time) in times.iter().enumerate() {
        let step = match times.get(i + 1) {
            Some(&t) if t > time => t - time,
            Some(_) => last_step,
            None => duration
                .map(|d| d - time)
                .filter(|d| *d > 0.0)
                .unwrap_or(last_step),
        };
        last_step = step;
        frames.push(RawFrame {
            time,
            duration: step,
            width,
            height,
        });
    }
    Ok((spool, path, frames))
}

/// Reconstructs from frames you decoded yourself.
///
/// Args:
///     frames: An iterable of (timestamp_seconds, image) pairs in presentation order, each image a uint8 RGBA
///         array of shape (height, width, 4) (a NumPy array or anything with the buffer protocol). The engine
///         reads the frames once per pass: a re-iterable such as a list is iterated again for every pass, while a
///         one-shot iterator such as a generator is first copied to a temporary file (width x height x 4 bytes
///         per frame on disk).
///     width: Frame width in pixels.
///     height: Frame height in pixels.
///     lossless: True when the frames are exact screen pixels (screenshots, a lossless capture); the default
///         assumes they were decoded from a lossy video and allows for its noise. It changes the results.
///     duration: The recording's length in seconds, for progress fractions and the last frame's duration;
///         None takes it from the frames when it can.
///     lang, threads, memory_mb, on_progress: as for reconstruct().
///
/// Returns:
///     A Result, as reconstruct() does.
///
/// Raises:
///     TypeError, ValueError: a frame is not a (timestamp, uint8 array of the given shape) pair; the message names
///         the frame. An exception raised by the iterable itself propagates.
///     RunFailedError: nothing could be reconstructed; `.result.diagnostics` says why.
///     KeyboardInterrupt: Ctrl-C; the run stops at its next step first.
#[pyfunction]
#[pyo3(signature = (frames, *, width, height, lang = "en", threads = None, memory_mb = None, lossless = false, duration = None, on_progress = None))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn reconstruct_frames(
    py: Python<'_>,
    frames: Bound<'_, PyAny>,
    width: usize,
    height: usize,
    lang: &str,
    threads: Option<usize>,
    memory_mb: Option<f64>,
    lossless: bool,
    duration: Option<f64>,
    on_progress: Option<Py<PyAny>>,
) -> PyResult<result::PyRunResult> {
    let common = common(lang, threads, memory_mb, on_progress)?;
    if width == 0 || height == 0 {
        return Err(PyValueError::new_err("width and height must be positive"));
    }
    if let Some(d) = duration {
        if !(d.is_finite() && d >= 0.0) {
            return Err(PyValueError::new_err(format!(
                "duration must be a non-negative number of seconds, not {d}"
            )));
        }
    }
    let (control, failure) = (Control::new(), Failure::default());
    let iterator = frames.try_iter()?;
    if iterator.is(&frames) {
        let (_spool, path, raw) = spool(py, &iterator, width, height, duration)?;
        let total = raw.last().map_or(0.0, |f| f.time + f.duration);
        let info = frames_info(width, height, total, Some(raw.len()), lossless);
        let mut source = RawSource::new(path, raw, info);
        return run_source(py, &mut source, common, control, failure);
    }
    drop(iterator);
    let frame_count = frames.len().ok();
    // A sequence's last timestamp, when it can be read without iterating.
    let last_time = || -> Option<f64> {
        let item = frames.get_item(-1).ok()?;
        item.extract::<(f64, Bound<'_, PyAny>)>().ok().map(|t| t.0)
    };
    let total = duration
        .or_else(|| frame_count.filter(|n| *n > 0).and_then(|_| last_time()))
        .unwrap_or(0.0);
    let info = frames_info(width, height, total, frame_count, lossless);
    let mut source = PyFrames {
        iterable: frames.unbind(),
        info,
        duration,
        control: control.clone(),
        failure: failure.clone(),
    };
    run_source(py, &mut source, common, control, failure)
}

/// The run settings a settings row describes (as `rust/long-screen/examples/parity.rs` reads them).
fn settings_of(row: &Obj) -> Settings {
    let d = Settings::default();
    let num = |k: &str, v: f64| {
        row.get(k)
            .map(Js::num)
            .filter(|n| n.is_finite())
            .unwrap_or(v)
    };
    Settings {
        analysis_size: num("analysisSize", d.analysis_size as f64) as u32,
        memory_mb: num("memoryMB", d.memory_mb),
        tile_size: num("tileSize", d.tile_size as f64) as u32,
        temporal_policy: if row.str("temporalPolicy") == Some("latest") {
            TemporalPolicy::Latest
        } else {
            TemporalPolicy::Stable
        },
        framing: if row.str("framing") == Some("region") {
            Framing::Region
        } else {
            Framing::Context
        },
    }
}

/// Runs one scenario exported by `scripts/native-parity.ts export` (its `frames.rgba` and `meta.json`) exactly as
/// `rust/long-screen/examples/parity.rs` does and returns the fingerprint entry; a test hook for measuring parity
/// of this extension module with the native executable and the web page, not API.
#[pyfunction]
#[pyo3(signature = (directory, threads = None))]
pub(crate) fn _fingerprint_raw<'py>(
    py: Python<'py>,
    directory: PathBuf,
    threads: Option<usize>,
) -> PyResult<Bound<'py, PyDict>> {
    let text = std::fs::read_to_string(directory.join("meta.json"))?;
    let meta: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| PyValueError::new_err(e.to_string()))?;
    let (Js::Obj(info), Js::Obj(settings)) = (
        Js::from_json(&meta["info"]),
        Js::from_json(&meta["settings"]),
    ) else {
        return Err(PyValueError::new_err("meta.json lacks info or settings"));
    };
    let frames = meta["frames"]
        .as_array()
        .ok_or_else(|| PyValueError::new_err("meta.json lacks frames"))?
        .iter()
        .map(|f| RawFrame {
            time: f[0].as_f64().unwrap_or(0.0),
            duration: f[1].as_f64().unwrap_or(0.0),
            width: f[2].as_u64().unwrap_or(0) as usize,
            height: f[3].as_u64().unwrap_or(0) as usize,
        })
        .collect();
    let mut source = RawSource::new(
        directory.join("frames.rgba"),
        frames,
        MediaInfo::from_js(info),
    );
    let mut options = long_screen::Options {
        settings: settings_of(&settings),
        threads,
        ..Default::default()
    };
    options.settings_row = Some(settings);
    let started = std::time::Instant::now();
    let outcome = py.detach(|| long_screen::run(&mut source, &options, &mut (), &Control::new()));
    let result = match outcome {
        Ok(r) => r,
        Err(long_screen::Error::Failed { result, .. }) => *result,
        Err(e) => return Err(PyValueError::new_err(e.to_string())),
    };
    let entry = result::fingerprint(py, &result)?;
    entry.set_item(
        "seconds",
        (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
    )?;
    Ok(entry)
}
