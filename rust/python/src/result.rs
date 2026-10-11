//! `Result` and `Canvas`: a finished run's diagnostics and canvases, as PNG files or NumPy arrays.

use crate::LongScreenError;
use long_screen::value::Js;
use long_screen::{CanvasInfo, Diagnostic, RunResult};
use pyo3::prelude::*;
use pyo3::types::{PyByteArray, PyBytes, PyDict, PyList};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Arc;

/// A row value as Python data: objects become dicts (in field order), arrays lists, typed arrays and blobs bytes,
/// whole numbers ints.
fn js_to_py(py: Python<'_>, value: &Js) -> PyResult<Py<PyAny>> {
    Ok(match value {
        Js::Undefined | Js::Null => py.None(),
        Js::Bool(b) => b.into_pyobject(py)?.to_owned().into_any().unbind(),
        Js::Num(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 => {
            (*n as i64).into_pyobject(py)?.into_any().unbind()
        }
        Js::Num(n) => n.into_pyobject(py)?.into_any().unbind(),
        Js::Str(s) => s.into_pyobject(py)?.into_any().unbind(),
        Js::Arr(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(js_to_py(py, item)?)?;
            }
            list.into_any().unbind()
        }
        Js::Obj(o) => {
            let dict = PyDict::new(py);
            for (k, v) in &o.0 {
                if !matches!(v, Js::Undefined) {
                    dict.set_item(k, js_to_py(py, v)?)?;
                }
            }
            dict.into_any().unbind()
        }
        Js::Typed(_, bytes) | Js::Blob(_, bytes) => PyBytes::new(py, bytes).into_any().unbind(),
    })
}

/// The row fields a diagnostic dict names itself; every other field goes into its `params`.
const DIAGNOSTIC_FIELDS: [&str; 7] = [
    "code", "severity", "message", "action", "frame", "time", "canvasId",
];

fn diagnostic_dict<'py>(py: Python<'py>, d: &Diagnostic) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("code", &d.code)?;
    dict.set_item("severity", &d.severity)?;
    dict.set_item("message", &d.message)?;
    dict.set_item("action", &d.action)?;
    dict.set_item("frame", d.frame)?;
    dict.set_item("time", d.time)?;
    dict.set_item("canvas", &d.canvas)?;
    dict.set_item("occurrences", d.occurrences)?;
    let params = PyDict::new(py);
    for (k, v) in &d.row.0 {
        if !DIAGNOSTIC_FIELDS.contains(&k.as_str()) && !matches!(v, Js::Undefined) {
            params.set_item(k, js_to_py(py, v)?)?;
        }
    }
    dict.set_item("params", params)?;
    Ok(dict)
}

fn no_print() -> PyErr {
    LongScreenError::new_err(
        "the run produced no print (no canvas has any pixels); see the diagnostics",
    )
}

/// Writes `canvas` to `path` as a PNG with the GIL released.
fn save(py: Python<'_>, result: &RunResult, canvas: &str, path: PathBuf) -> PyResult<()> {
    py.detach(|| {
        let file = File::create(&path)?;
        result.write_png(canvas, BufWriter::new(file))?;
        Ok::<(), std::io::Error>(())
    })
    .map_err(PyErr::from)
}

/// `canvas` as a NumPy `(height, width, 4)` uint8 array.
fn image(py: Python<'_>, result: &RunResult, canvas: &str) -> PyResult<Py<PyAny>> {
    let (w, h) = result.canvas_size(canvas).map_err(PyErr::from)?;
    let bytes = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| PyErr::from(std::io::Error::other("the canvas is too large")))?;
    let buffer = PyByteArray::new_with(py, bytes, |out| {
        let mut at = 0;
        result
            .read_rows(canvas, |line| {
                out[at..at + line.len()].copy_from_slice(line);
                at += line.len();
                Ok(())
            })
            .map_err(PyErr::from)?;
        Ok(())
    })?;
    let numpy = py.import("numpy")?;
    Ok(numpy
        .call_method1("frombuffer", (buffer, "uint8"))?
        .call_method1("reshape", (h, w, 4))?
        .unbind())
}

/// What a run produced: its status, diagnostics and canvases.
///
/// The print is `.print` (also written by `.save()` and read by `.print_image()`); `.fragments` are the pieces the
/// run could not place on it, and `.canvases` lists every canvas, including screen-fixed interface and the framed
/// presentation. Everything stays in memory (as compressed tiles) until the Result is dropped.
#[pyclass(frozen, module = "long_screen", name = "Result")]
pub struct PyRunResult {
    inner: Arc<RunResult>,
}

impl PyRunResult {
    pub(crate) fn new(result: RunResult) -> PyRunResult {
        PyRunResult {
            inner: Arc::new(result),
        }
    }

    fn canvas(&self, info: CanvasInfo) -> PyCanvas {
        PyCanvas {
            result: self.inner.clone(),
            info,
        }
    }
}

#[pymethods]
impl PyRunResult {
    /// "complete", "partial" (stopped, or not every frame could be used) or "error".
    #[getter]
    fn status(&self) -> &str {
        self.inner.status()
    }

    /// The failure that ended the run early, if one did.
    #[getter]
    fn error(&self) -> Option<&str> {
        self.inner.error()
    }

    /// Frames analysed.
    #[getter]
    fn frames(&self) -> u32 {
        self.inner.frames()
    }

    /// Wall-clock seconds the run took.
    #[getter]
    fn seconds(&self) -> f64 {
        self.inner.seconds()
    }

    /// Every diagnostic in the order it was raised, each a dict with `code`, `severity` ("info", "warning" or
    /// "error"), `message` and `action` (in the run's language), `frame` and `time` (or None), `canvas`,
    /// `occurrences` (how many times the code had fired by then) and `params` (the diagnostic's other fields,
    /// such as `detail`).
    #[getter]
    fn diagnostics<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let list = PyList::empty(py);
        for d in self.inner.diagnostics() {
            list.append(diagnostic_dict(py, d)?)?;
        }
        Ok(list)
    }

    /// The print: the framed presentation of the main canvas when there is one, else the main canvas; None when
    /// nothing was reconstructed.
    #[getter]
    fn print(&self) -> Option<PyCanvas> {
        self.inner.print().map(|c| self.canvas(c))
    }

    /// Separate fragments the run could not place on the print (moving canvases with pixels).
    #[getter]
    fn fragments(&self) -> Vec<PyCanvas> {
        self.inner
            .fragments()
            .into_iter()
            .map(|c| self.canvas(c))
            .collect()
    }

    /// Every canvas, in storage order.
    #[getter]
    fn canvases(&self) -> Vec<PyCanvas> {
        self.inner
            .canvases()
            .into_iter()
            .map(|c| self.canvas(c))
            .collect()
    }

    /// Writes the print to `path` as an RGBA PNG (unobserved pixels transparent). Memory stays at one row of tiles
    /// however long the print is.
    fn save(&self, py: Python<'_>, path: PathBuf) -> PyResult<()> {
        let print = self.inner.print().ok_or_else(no_print)?;
        save(py, &self.inner, &print.id, path)
    }

    /// The print as a NumPy uint8 array of shape (height, width, 4), RGBA. A long print is large: 1320 x 12000
    /// pixels is 63 MB. Prefer `save()` when a file is what you need.
    fn print_image(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let print = self.inner.print().ok_or_else(no_print)?;
        image(py, &self.inner, &print.id)
    }

    /// Fingerprint of every stored row (`scripts/fingerprint-scenarios.ts`'s format); a test hook, not API.
    fn _fingerprint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        fingerprint(py, &self.inner)
    }

    fn __repr__(&self) -> String {
        format!(
            "<long_screen.Result status={:?} frames={} canvases={} diagnostics={}>",
            self.inner.status(),
            self.inner.frames(),
            self.inner.canvases().len(),
            self.inner.diagnostics().len()
        )
    }
}

pub(crate) fn fingerprint<'py>(
    py: Python<'py>,
    result: &RunResult,
) -> PyResult<Bound<'py, PyDict>> {
    let (rows, project) = result.fingerprint();
    let dict = PyDict::new(py);
    dict.set_item("rows", rows)?;
    dict.set_item("events", "")?;
    dict.set_item("project", project)?;
    dict.set_item("status", result.status())?;
    dict.set_item("frames", result.frames())?;
    Ok(dict)
}

/// One canvas of a Result: the print, a fragment, screen-fixed interface or a framed presentation.
#[pyclass(frozen, module = "long_screen", name = "Canvas")]
pub struct PyCanvas {
    result: Arc<RunResult>,
    info: CanvasInfo,
}

#[pymethods]
impl PyCanvas {
    #[getter]
    fn id(&self) -> &str {
        &self.info.id
    }

    /// The region (layer) the canvas belongs to.
    #[getter]
    fn layer(&self) -> &str {
        &self.info.layer
    }

    /// The canvas's name in the run's language ("Content canvas 1" with lang="en"); `id` and `layer` are the
    /// stable identifiers.
    #[getter]
    fn name(&self) -> String {
        self.result.display_name(&self.info)
    }

    /// "moving" (reconstructed content), "fixed" (screen-fixed interface) or "presentation" (a framed view).
    #[getter]
    fn kind(&self) -> &str {
        &self.info.kind
    }

    /// World-coordinate bounds of what was painted: (x, y, width, height).
    #[getter]
    fn bounds(&self) -> (f64, f64, f64, f64) {
        let b = self.info.bounds;
        (b.x, b.y, b.width, b.height)
    }

    /// Width in pixels of the image `save()` and `image()` give.
    #[getter]
    fn width(&self) -> u32 {
        self.info.bounds.width.ceil().max(0.0) as u32
    }

    /// Height in pixels of the image `save()` and `image()` give.
    #[getter]
    fn height(&self) -> u32 {
        self.info.bounds.height.ceil().max(0.0) as u32
    }

    #[getter]
    fn tile_count(&self) -> u64 {
        self.info.tile_count
    }

    #[getter]
    fn observed_pixels(&self) -> f64 {
        self.info.observed_pixels
    }

    /// Fragment number within its layer (0 is the main canvas).
    #[getter]
    fn fragment(&self) -> u32 {
        self.info.fragment
    }

    /// For a framed presentation: the id of the canvas it frames.
    #[getter]
    fn presents(&self) -> Option<&str> {
        self.info.presents.as_deref()
    }

    /// Writes the canvas to `path` as an RGBA PNG (unobserved pixels transparent).
    fn save(&self, py: Python<'_>, path: PathBuf) -> PyResult<()> {
        save(py, &self.result, &self.info.id, path)
    }

    /// The canvas as a NumPy uint8 array of shape (height, width, 4), RGBA. Large canvases take a lot of memory
    /// (width x height x 4 bytes); prefer `save()` when a file is what you need.
    fn image(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        image(py, &self.result, &self.info.id)
    }

    fn __repr__(&self) -> String {
        format!(
            "<long_screen.Canvas {:?} kind={:?} {}x{}>",
            self.info.id,
            self.info.kind,
            self.width(),
            self.height()
        )
    }
}
