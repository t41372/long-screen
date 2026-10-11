//! Structured diagnostics: what a pass found, as a code plus numbers, never text. The host formats the message from
//! its catalogue (the page's `t()`, or [`crate::catalog::format`] natively) under `diag.<code>.*` with these
//! parameters, so the zh text it persists stays byte-identical to what the page wrote before the pass moved here.

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

/// One diagnostic event. `frame`/`time` locate a per-frame finding; `params` are the catalogue's `{{name}}` values,
/// in the order the message uses them.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub frame: Option<u32>,
    pub time: Option<f64>,
    pub params: Vec<(&'static str, f64)>,
}

impl Diagnostic {
    pub fn new(code: &'static str, severity: Severity) -> Diagnostic {
        Diagnostic {
            code,
            severity,
            frame: None,
            time: None,
            params: Vec::new(),
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
}
