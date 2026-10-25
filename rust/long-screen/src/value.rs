//! Persisted rows as the web page stores them: JavaScript values with ordered object fields, typed arrays and blobs.
//!
//! The page writes plain JS objects into IndexedDB, and both its export package and the scenario fingerprint
//! (`scripts/fingerprint-scenarios.ts`) read them back field by field, in insertion order. The native host keeps the
//! same values, built field by field in the same order, so a native run's rows can be compared with the page's row
//! for row ([`fingerprint`]).

use sha2::{Digest, Sha256};
use std::sync::Arc;

/// The typed-array constructor a byte buffer stands for (its elements are little-endian).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Typed {
    Uint8,
    Uint8Clamped,
    Int16,
    Int32,
    Uint32,
    Float32,
}

impl Typed {
    pub fn name(self) -> &'static str {
        match self {
            Typed::Uint8 => "Uint8Array",
            Typed::Uint8Clamped => "Uint8ClampedArray",
            Typed::Int16 => "Int16Array",
            Typed::Int32 => "Int32Array",
            Typed::Uint32 => "Uint32Array",
            Typed::Float32 => "Float32Array",
        }
    }
}

/// A JavaScript value as a row holds it.
#[derive(Clone, Debug, PartialEq)]
pub enum Js {
    /// `undefined`: left out of an object, `null` in an array (as `JSON.stringify` does).
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
    /// A typed array, as its little-endian bytes.
    Typed(Typed, Arc<Vec<u8>>),
    /// A `Blob` of the given media type.
    Blob(String, Arc<Vec<u8>>),
}

/// An object: fields in insertion order. Setting an existing field keeps its position, as in JavaScript.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(pub Vec<(String, Js)>);

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }

    /// Appends or replaces `key` (keeping its position when it exists).
    pub fn set(&mut self, key: &str, value: impl Into<Js>) -> &mut Obj {
        let value = value.into();
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some((_, v)) => *v = value,
            None => self.0.push((key.to_string(), value)),
        }
        self
    }

    /// Builder form of [`Obj::set`].
    pub fn with(mut self, key: &str, value: impl Into<Js>) -> Obj {
        self.set(key, value);
        self
    }

    /// Sets `key` only when `value` is `Some`.
    pub fn with_opt<T: Into<Js>>(mut self, key: &str, value: Option<T>) -> Obj {
        if let Some(v) = value {
            self.set(key, v);
        }
        self
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Js> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn remove(&mut self, key: &str) -> Option<Js> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(at).1)
    }

    pub fn num(&self, key: &str) -> f64 {
        self.get(key).map_or(f64::NAN, Js::num)
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Js::as_str)
    }

    pub fn bool(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Js::Bool(true)))
    }
}

impl Js {
    pub fn num(&self) -> f64 {
        match self {
            Js::Num(n) => *n,
            _ => f64::NAN,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            Js::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_obj_mut(&mut self) -> Option<&mut Obj> {
        match self {
            Js::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Js]> {
        match self {
            Js::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// The bytes of a typed array or blob.
    pub fn bytes(&self) -> Option<&Arc<Vec<u8>>> {
        match self {
            Js::Typed(_, b) | Js::Blob(_, b) => Some(b),
            _ => None,
        }
    }

    pub fn typed(kind: Typed, bytes: Vec<u8>) -> Js {
        Js::Typed(kind, Arc::new(bytes))
    }

    pub fn u8s(bytes: Vec<u8>) -> Js {
        Js::typed(Typed::Uint8, bytes)
    }

    pub fn u32s(values: &[u32]) -> Js {
        Js::typed(
            Typed::Uint32,
            values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
    }

    pub fn f32s(values: &[f32]) -> Js {
        Js::typed(
            Typed::Float32,
            values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
    }

    pub fn png(bytes: Vec<u8>) -> Js {
        Js::Blob("image/png".into(), Arc::new(bytes))
    }

    /// Reads a JSON document into values, keeping its field order.
    pub fn from_json(value: &serde_json::Value) -> Js {
        match value {
            serde_json::Value::Null => Js::Null,
            serde_json::Value::Bool(b) => Js::Bool(*b),
            serde_json::Value::Number(n) => Js::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Js::Str(s.clone()),
            serde_json::Value::Array(a) => Js::Arr(a.iter().map(Js::from_json).collect()),
            serde_json::Value::Object(o) => Js::Obj(Obj(o
                .iter()
                .map(|(k, v)| (k.clone(), Js::from_json(v)))
                .collect())),
        }
    }
}

impl From<f64> for Js {
    fn from(v: f64) -> Js {
        Js::Num(v)
    }
}
impl From<u32> for Js {
    fn from(v: u32) -> Js {
        Js::Num(v as f64)
    }
}
impl From<i32> for Js {
    fn from(v: i32) -> Js {
        Js::Num(v as f64)
    }
}
impl From<u64> for Js {
    fn from(v: u64) -> Js {
        Js::Num(v as f64)
    }
}
impl From<usize> for Js {
    fn from(v: usize) -> Js {
        Js::Num(v as f64)
    }
}
impl From<bool> for Js {
    fn from(v: bool) -> Js {
        Js::Bool(v)
    }
}
impl From<&str> for Js {
    fn from(v: &str) -> Js {
        Js::Str(v.to_string())
    }
}
impl From<String> for Js {
    fn from(v: String) -> Js {
        Js::Str(v)
    }
}
impl From<Obj> for Js {
    fn from(v: Obj) -> Js {
        Js::Obj(v)
    }
}
impl From<Vec<Js>> for Js {
    fn from(v: Vec<Js>) -> Js {
        Js::Arr(v)
    }
}

/// `{ x, y, width, height }`.
pub fn rect(r: crate::kernels::geometry::Rect) -> Js {
    Js::Obj(
        Obj::new()
            .with("x", r.x)
            .with("y", r.y)
            .with("width", r.width)
            .with("height", r.height),
    )
}

/// Reads `{ x, y, width, height }`.
pub fn read_rect(v: &Js) -> Option<crate::kernels::geometry::Rect> {
    let o = v.as_obj()?;
    Some(crate::kernels::geometry::Rect {
        x: o.num("x"),
        y: o.num("y"),
        width: o.num("width"),
        height: o.num("height"),
    })
}

/// A diagnostic `detail` payload as a value.
pub fn detail(v: &crate::engine::diagnostic::Value) -> Js {
    use crate::engine::diagnostic::Value;
    match v {
        Value::Number(n) => Js::Num(*n),
        Value::Bool(b) => Js::Bool(*b),
        Value::Text(s) => Js::Str(s.clone()),
        Value::List(l) => Js::Arr(l.iter().map(detail).collect()),
        Value::Object(fields) => Js::Obj(Obj(fields
            .iter()
            .map(|(k, v)| (k.to_string(), detail(v)))
            .collect())),
    }
}

// --- JSON as `JSON.stringify` writes it ---

/// `JSON.stringify` of a value (typed arrays and blobs must have been replaced first; see [`canonical`]).
pub fn write_json(v: &Js, out: &mut String) {
    match v {
        Js::Undefined | Js::Null => out.push_str("null"),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Num(n) => {
            if n.is_finite() {
                out.push_str(&crate::engine::catalog::js_number(*n))
            } else {
                out.push_str("null")
            }
        }
        Js::Str(s) => write_string(s, out),
        Js::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        Js::Obj(o) => {
            out.push('{');
            let mut first = true;
            for (k, x) in ordered(o) {
                if matches!(x, Js::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_string(k, out);
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
        // Not JSON: a typed array stringifies as an object of its indices, a blob as `{}`. Rows never reach here
        // without [`canonical`]; the report writes their sizes instead.
        Js::Typed(..) | Js::Blob(..) => out.push_str("{}"),
    }
}

/// JavaScript's own-property order: integer-like keys first, ascending, then the rest in insertion order.
fn ordered(o: &Obj) -> Vec<(&String, &Js)> {
    let index = |k: &str| -> Option<u32> {
        if k == "0"
            || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
        {
            k.parse::<u32>().ok().filter(|n| *n < u32::MAX)
        } else {
            None
        }
    };
    let mut ints: Vec<(u32, &String, &Js)> =
        o.0.iter()
            .filter_map(|(k, v)| index(k).map(|n| (n, k, v)))
            .collect();
    ints.sort_by_key(|(n, _, _)| *n);
    let mut out: Vec<(&String, &Js)> = ints.into_iter().map(|(_, k, v)| (k, v)).collect();
    out.extend(
        o.0.iter()
            .filter(|(k, _)| index(k).is_none())
            .map(|(k, v)| (k, v)),
    );
    out
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The elements of a typed array as the numbers `Array.from(typedArray)` gives (little-endian bytes).
pub fn typed_values(kind: Typed, bytes: &[u8]) -> Vec<f64> {
    match kind {
        Typed::Uint8 | Typed::Uint8Clamped => bytes.iter().map(|&b| b as f64).collect(),
        Typed::Int16 => bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f64)
            .collect(),
        Typed::Int32 => bytes
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
            .collect(),
        Typed::Uint32 => bytes
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
            .collect(),
        Typed::Float32 => bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64)
            .collect(),
    }
}

/// `v` with every typed array replaced by a plain array of its numbers, as the replacer
/// `(_, x) => ArrayBuffer.isView(x) ? Array.from(x) : x` hands `JSON.stringify` (src/export/project.ts's `jsonLines`).
pub fn typed_as_arrays(v: &Js) -> Js {
    match v {
        Js::Typed(kind, bytes) => Js::Arr(
            typed_values(*kind, bytes)
                .into_iter()
                .map(Js::Num)
                .collect(),
        ),
        Js::Arr(a) => Js::Arr(a.iter().map(typed_as_arrays).collect()),
        Js::Obj(o) => Js::Obj(Obj(o
            .0
            .iter()
            .map(|(k, x)| (k.clone(), typed_as_arrays(x)))
            .collect())),
        other => other.clone(),
    }
}

/// `JSON.stringify(v, null, 2)`. A typed array stringifies as an object of its indices and a blob as `{}`, as
/// JavaScript's own would without a replacer.
pub fn to_json_pretty(v: &Js) -> String {
    let mut s = String::new();
    write_pretty(v, 0, &mut s);
    s
}

fn write_pretty(v: &Js, depth: usize, out: &mut String) {
    let pad = |n: usize, out: &mut String| out.extend(std::iter::repeat_n("  ", n));
    match v {
        Js::Arr(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(depth + 1, out);
                write_pretty(x, depth + 1, out);
            }
            out.push('\n');
            pad(depth, out);
            out.push(']');
        }
        Js::Obj(o) => {
            let fields: Vec<(&String, &Js)> = ordered(o)
                .into_iter()
                .filter(|(_, x)| !matches!(x, Js::Undefined))
                .collect();
            if fields.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, (k, x)) in fields.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(depth + 1, out);
                write_string(k, out);
                out.push_str(": ");
                write_pretty(x, depth + 1, out);
            }
            out.push('\n');
            pad(depth, out);
            out.push('}');
        }
        Js::Typed(kind, bytes) => {
            let indices = Obj(typed_values(*kind, bytes)
                .into_iter()
                .enumerate()
                .map(|(i, n)| (i.to_string(), Js::Num(n)))
                .collect());
            write_pretty(&Js::Obj(indices), depth, out)
        }
        other => write_json(other, out),
    }
}

pub fn to_json(v: &Js) -> String {
    let mut s = String::new();
    write_json(v, &mut s);
    s
}

// --- The scenario fingerprint ---

/// The first 12 bytes of SHA-256, in hex: the fingerprint's digest.
pub fn short_sha(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d[..12].iter().map(|b| format!("{b:02x}")).collect()
}

fn volatile(key: &str) -> bool {
    matches!(key, "created" | "updated" | "compute" | "id")
        || key.ends_with("MS")
        || key == "seconds"
}

/// The value `scripts/fingerprint-scenarios.ts`'s `canon()` makes of a row: wall-clock and id fields dropped, the
/// run id replaced by `<run>`, typed arrays and blobs replaced by their digests, `COMPUTE_BACKEND`'s host-timed
/// message and detail dropped.
pub fn canonical(v: &Js, run: &str) -> Js {
    match v {
        Js::Blob(kind, bytes) => Js::Obj(
            Obj::new()
                .with("blob", kind.as_str())
                .with("sha", short_sha(bytes)),
        ),
        Js::Typed(kind, bytes) => Js::Obj(Obj::new().with(kind.name(), short_sha(bytes))),
        Js::Str(s) => Js::Str(if run.is_empty() {
            s.clone()
        } else {
            s.replace(run, "<run>")
        }),
        Js::Arr(a) => Js::Arr(a.iter().map(|x| canonical(x, run)).collect()),
        Js::Obj(o) => {
            let host_timed = o.str("code") == Some("COMPUTE_BACKEND");
            Js::Obj(Obj(o
                .0
                .iter()
                .filter(|(k, _)| !volatile(k) && !(host_timed && (k == "message" || k == "detail")))
                .map(|(k, x)| (k.clone(), canonical(x, run)))
                .collect()))
        }
        other => other.clone(),
    }
}

/// A row's fingerprint digest: the short SHA-256 of `JSON.stringify(canon(row))`.
pub fn fingerprint(v: &Js, run: &str) -> String {
    short_sha(to_json(&canonical(v, run)).as_bytes())
}

// --- Number formatting the page's messages use ---

/// `Number.prototype.toFixed(digits)`: the exact value rounded half away from zero (JS picks the larger `n` on a
/// tie of the exact binary value), in plain notation below 1e21.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return crate::engine::catalog::js_number(value);
    }
    if value.abs() >= 1e21 {
        return crate::engine::catalog::js_number(value);
    }
    let negative = value < 0.0;
    // Rust prints the exact decimal expansion of the double with enough digits; round that half up.
    let exact = format!("{:.*}", digits + 40, value.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_vec: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    let rest = &frac.as_bytes()[digits.min(frac.len())..];
    let round_up = rest.first().is_some_and(|&d| d >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_vec[i] == b'9' {
                digits_vec[i] = b'0';
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(digits_vec).unwrap();
    let split = s.len() - digits;
    let body = if digits == 0 {
        s
    } else {
        format!("{}.{}", &s[..split], &s[split..])
    };
    // JS: "if x < 0, let s be "-"" — so (-0.04).toFixed(1) is "-0.0", while -0 itself has no sign.
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

/// `Number.prototype.toLocaleString()` in the `en-US` locale Deno and the page default to: grouped thousands, at
/// most three fraction digits.
pub fn to_locale(value: f64) -> String {
    if !value.is_finite() {
        return crate::engine::catalog::js_number(value);
    }
    let fixed = to_fixed(value, 3);
    let (int, frac) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let (sign, int) = int.strip_prefix('-').map_or(("", int), |i| ("-", i));
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_the_exact_value_half_up_like_javascript() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 is 1.00499999… as a double
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-1.25, 1), "-1.3");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(9.996, 2), "10.00");
        assert_eq!(to_fixed(3.0, 2), "3.00");
    }

    #[test]
    fn to_locale_groups_thousands() {
        assert_eq!(to_locale(1234567.0), "1,234,567");
        assert_eq!(to_locale(999.0), "999");
        assert_eq!(to_locale(1000.5), "1,000.5");
    }

    #[test]
    fn json_matches_json_stringify() {
        let v = Js::Obj(
            Obj::new()
                .with("b", 1.5)
                .with("2", true)
                .with("a", Js::Undefined)
                .with("s", "x\"\n\u{1}")
                .with(
                    "1",
                    Js::Arr(vec![Js::Undefined, Js::Num(f64::NAN), Js::Num(-0.0)]),
                ),
        );
        assert_eq!(
            to_json(&v),
            r#"{"1":[null,null,0],"2":true,"b":1.5,"s":"x\"\n\u0001"}"#
        );
    }
}
