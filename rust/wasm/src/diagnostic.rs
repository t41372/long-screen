//! `bytes.rs` form of the engine's structured diagnostics (`long_screen_engine::diagnostic`), decoded by
//! `src/core/wasm/diagnostic.ts`: u32 count, then per diagnostic the code (u32 length + UTF-8), u32 severity
//! (0 info, 1 warning, 2 error), u32 has-frame, u32 frame, u32 has-time, f64 time, u32 parameter count, and per
//! parameter its name (u32 length + UTF-8) and f64 value; then u32 has-canvas [+ str], u32 has-confidence [+ f64],
//! u32 has-region [+ 4 × f64], u32 has-detail [+ value]. A value is u8 0 + f64, u8 1 + u8 flag, u8 2 + str, or u8 3 +
//! u32 field count and per field its name and value.

use crate::bytes::Out;
use long_screen_engine::diagnostic::{Diagnostic, Severity, Value};

pub(crate) fn write_diagnostics(w: &mut Out, diagnostics: &[Diagnostic]) {
    w.u32(diagnostics.len() as u32);
    for d in diagnostics {
        write_diagnostic(w, d);
    }
}

/// One diagnostic, without the count.
pub(crate) fn write_diagnostic(w: &mut Out, d: &Diagnostic) {
    {
        w.str(d.code);
        w.u32(match d.severity {
            Severity::Info => 0,
            Severity::Warning => 1,
            Severity::Error => 2,
        });
        w.u32(d.frame.is_some() as u32);
        w.u32(d.frame.unwrap_or(0));
        w.u32(d.time.is_some() as u32);
        w.f64(d.time.unwrap_or(0.0));
        w.u32(d.params.len() as u32);
        for (name, value) in &d.params {
            w.str(name);
            w.f64(*value);
        }
        w.u32(d.canvas.is_some() as u32);
        if let Some(canvas) = &d.canvas {
            w.str(canvas);
        }
        w.u32(d.confidence.is_some() as u32);
        if let Some(confidence) = d.confidence {
            w.f64(confidence);
        }
        w.u32(d.region.is_some() as u32);
        if let Some(r) = d.region {
            w.f64(r.x);
            w.f64(r.y);
            w.f64(r.width);
            w.f64(r.height);
        }
        w.u32(d.detail.is_some() as u32);
        if let Some(detail) = &d.detail {
            write_value(w, detail);
        }
    }
}

fn write_value(w: &mut Out, v: &Value) {
    match v {
        Value::Number(n) => {
            w.u8(0);
            w.f64(*n);
        }
        Value::Bool(b) => {
            w.u8(1);
            w.bool(*b);
        }
        Value::Text(t) => {
            w.u8(2);
            w.str(t);
        }
        Value::Object(fields) => {
            w.u8(3);
            w.u32(fields.len() as u32);
            for (name, value) in fields {
                w.str(name);
                write_value(w, value);
            }
        }
    }
}
