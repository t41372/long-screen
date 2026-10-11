//! `bytes.rs` form of the engine's structured diagnostics (`long_screen_engine::diagnostic`), decoded by
//! `src/core/wasm/diagnostic.ts`: u32 count, then per diagnostic the code (u32 length + UTF-8), u32 severity
//! (0 info, 1 warning, 2 error), u32 has-frame, u32 frame, u32 has-time, f64 time, u32 parameter count, and per
//! parameter its name (u32 length + UTF-8) and f64 value.

use crate::bytes::Out;
use long_screen_engine::diagnostic::{Diagnostic, Severity};

pub(crate) fn write_diagnostics(w: &mut Out, diagnostics: &[Diagnostic]) {
    w.u32(diagnostics.len() as u32);
    for d in diagnostics {
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
    }
}
