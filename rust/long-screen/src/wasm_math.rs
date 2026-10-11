//! The C math functions the core calls (`f64::exp`, `powf`, `ln`, `hypot` and their f32 forms), defined here with
//! the `libm` crate — the same musl-derived code `compiler-builtins` links into the web page's WebAssembly build.
//!
//! Without this, a native build calls the operating system's libm, whose results can differ from musl's in the
//! last bit for some inputs (measured: a motion confidence of 0.054445016798489 on the page came out as
//! 0.05444501679848899 natively). The difference is tiny but it flows into placements and pixels, and the native
//! driver promises the page's results row for row. Definitions in the executable take precedence over the system
//! library's for every call the Rust code in it makes; system frameworks keep their own.

#[no_mangle]
pub extern "C" fn exp(x: f64) -> f64 {
    libm::exp(x)
}

#[no_mangle]
pub extern "C" fn expf(x: f32) -> f32 {
    libm::expf(x)
}

#[no_mangle]
pub extern "C" fn pow(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

#[no_mangle]
pub extern "C" fn powf(x: f32, y: f32) -> f32 {
    libm::powf(x, y)
}

#[no_mangle]
pub extern "C" fn log(x: f64) -> f64 {
    libm::log(x)
}

#[no_mangle]
pub extern "C" fn logf(x: f32) -> f32 {
    libm::logf(x)
}

#[no_mangle]
pub extern "C" fn hypot(x: f64, y: f64) -> f64 {
    libm::hypot(x, y)
}

#[no_mangle]
pub extern "C" fn hypotf(x: f32, y: f32) -> f32 {
    libm::hypotf(x, y)
}
