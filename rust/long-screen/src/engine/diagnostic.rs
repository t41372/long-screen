//! Structured diagnostics: what a pass found, as a code plus numbers, never text. The host formats the message from
//! its catalogue (the page's `t()`, or [`crate::engine::catalog::format`] natively) under `diag.<code>.*` with these
//! parameters, so the zh text it persists stays byte-identical to what the page wrote before the pass moved here.
//! A diagnostic may also name the canvas it concerns, a confidence and a rectangle, and carry a `detail` payload the
//! journal row stores as it is.

use crate::kernels::geometry::Rect;

/// How serious a diagnostic is; the same three levels the page's `Severity` has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
        }
    }
}

/// A `detail` payload: numbers, flags, text, objects whose fields keep the order they are listed in, and lists.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Number(f64),
    Bool(bool),
    Text(String),
    Object(Vec<(&'static str, Value)>),
    List(Vec<Value>),
}

impl Value {
    /// `{ x, y }`.
    pub fn point(x: f64, y: f64) -> Value {
        Value::Object(vec![("x", Value::Number(x)), ("y", Value::Number(y))])
    }

    /// `{ x, y, width, height }`.
    pub fn rect(r: Rect) -> Value {
        Value::Object(vec![
            ("x", Value::Number(r.x)),
            ("y", Value::Number(r.y)),
            ("width", Value::Number(r.width)),
            ("height", Value::Number(r.height)),
        ])
    }
}

/// One diagnostic event. `frame`/`time` locate a per-frame finding; `params` are the catalogue's `{{name}}` values,
/// in the order the message uses them. `canvas`, `confidence`, `region` and `detail` are the row's own fields of
/// those names, when it has them.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub frame: Option<u32>,
    pub time: Option<f64>,
    pub params: Vec<(&'static str, f64)>,
    pub canvas: Option<String>,
    pub confidence: Option<f64>,
    pub region: Option<Rect>,
    pub detail: Option<Value>,
}

impl Diagnostic {
    pub fn new(code: &'static str, severity: Severity) -> Diagnostic {
        Diagnostic {
            code,
            severity,
            frame: None,
            time: None,
            params: Vec::new(),
            canvas: None,
            confidence: None,
            region: None,
            detail: None,
        }
    }

    pub fn at(mut self, frame: u32, time: f64) -> Diagnostic {
        self.frame = Some(frame);
        self.time = Some(time);
        self
    }

    pub fn param(mut self, name: &'static str, value: f64) -> Diagnostic {
        self.params.push((name, value));
        self
    }

    pub fn canvas(mut self, canvas: &str) -> Diagnostic {
        self.canvas = Some(canvas.to_string());
        self
    }

    pub fn confidence(mut self, confidence: f64) -> Diagnostic {
        self.confidence = Some(confidence);
        self
    }

    pub fn region(mut self, region: Rect) -> Diagnostic {
        self.region = Some(region);
        self
    }

    pub fn detail(mut self, detail: Value) -> Diagnostic {
        self.detail = Some(detail);
        self
    }
}
