//! The zh and en diagnostic and progress messages, and the formatter that fills in their `{{name}}` placeholders;
//! also the display names of regions and canvases ([`display_name()`]).
//!
//! The catalogues are the `diag`, `progress` and `names` sections of `src/i18n/{zh,en}`, exported to
//! `catalog/*.json` by `scripts/export-catalog.ts` (`deno task export-catalog`); `tests/unit/catalog-export.test.ts`
//! fails when the checked-in JSON no longer matches the TypeScript. [`format()`] reproduces what the page's `t()`
//! (i18next 26 with `escapeValue: false`) returns for the same key and values, so a diagnostic formatted natively
//! reads exactly like the one the page persists. The export refuses catalogue features this formatter does not
//! implement (nesting, formatters, unescaped placeholders, plural keys), so the two cannot drift apart silently.

use serde_json::Value;
use std::sync::OnceLock;

/// A catalogue language. zh is the language persisted rows are written in and the fallback for a missing en key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    Zh,
    En,
}

impl Locale {
    fn code(self) -> &'static str {
        match self {
            Locale::Zh => "zh",
            Locale::En => "en",
        }
    }
}

/// One interpolation value, rendered the way JavaScript's `String(value)` renders it.
#[derive(Clone, Debug, PartialEq)]
pub enum Param<'a> {
    Str(&'a str),
    Int(i64),
    Num(f64),
    Bool(bool),
}

impl Param<'_> {
    fn render(&self) -> String {
        match self {
            Param::Str(s) => (*s).to_string(),
            Param::Int(n) => n.to_string(),
            Param::Num(n) => js_number(*n),
            Param::Bool(b) => b.to_string(),
        }
    }
}

fn catalogue(locale: Locale) -> &'static Value {
    static ZH: OnceLock<Value> = OnceLock::new();
    static EN: OnceLock<Value> = OnceLock::new();
    let (cell, text) = match locale {
        Locale::Zh => (&ZH, include_str!("../catalog/zh.json")),
        Locale::En => (&EN, include_str!("../catalog/en.json")),
    };
    cell.get_or_init(|| serde_json::from_str(text).expect("embedded catalogue is valid JSON"))
}

/// The text stored under a dotted `key` (e.g. `diag.GRAPH_RESIDUAL.message`), without falling back to zh.
pub fn lookup(locale: Locale, key: &str) -> Option<&'static str> {
    find(catalogue(locale), key).and_then(Value::as_str)
}

/// The message for `key` in `locale` with `params` filled in, exactly as the page's `t(key, params)` would return it:
/// an en key that is missing falls back to zh, a key that is missing everywhere comes back as the key itself, and a
/// placeholder whose name is not among `params` stays in the text as written.
pub fn format(locale: Locale, key: &str, params: &[(&str, Param)]) -> String {
    format_in(
        catalogue(locale),
        catalogue(Locale::Zh),
        locale,
        key,
        params,
    )
}

/// A region or canvas name in `locale`, for display. Persisted names are a fixed zh vocabulary (`names` in the
/// catalogue: 固定界面, 内容画布 N, …) whatever the display language, so rows and fingerprints do not depend on it;
/// this translates one the way the page's `displayName` (src/i18n/names.ts) does: the base name, then an optional
/// ` · 未定位片段 N` (unplaced fragment) suffix, then an optional ` · 保留外框` (framed) suffix, each on its own. A
/// name outside the vocabulary is kept as stored, and zh returns every name unchanged.
pub fn display_name(locale: Locale, name: &str) -> String {
    if locale == Locale::Zh {
        return name.to_string();
    }
    let canonical = |key: &str| {
        lookup(Locale::Zh, &format!("names.{key}")).expect("the catalogue has the names section")
    };
    let mut suffixes = Vec::new();
    let mut rest = name;
    if let Some(base) = rest
        .strip_suffix(canonical("framed"))
        .and_then(|r| r.strip_suffix(NAME_SEPARATOR))
    {
        rest = base;
        suffixes.push(format(locale, "names.framed", &[]));
    }
    if let Some((base, tail)) = rest.rsplit_once(NAME_SEPARATOR) {
        if let Some(n) = numbered(canonical("fragment"), tail) {
            rest = base;
            suffixes.insert(0, format(locale, "names.fragment", &[("n", Param::Str(n))]));
        }
    }
    let base = ["fixed", "divider", "unassigned", "ignored"]
        .into_iter()
        .find(|key| canonical(key) == rest)
        .map(|key| format(locale, &format!("names.{key}"), &[]))
        .or_else(|| {
            ["contentCanvas", "contentRegion"]
                .into_iter()
                .find_map(|key| {
                    numbered(canonical(key), rest)
                        .map(|n| format(locale, &format!("names.{key}"), &[("n", Param::Str(n))]))
                })
        })
        .unwrap_or_else(|| rest.to_string());
    std::iter::once(base)
        .chain(suffixes)
        .collect::<Vec<_>>()
        .join(NAME_SEPARATOR)
}

/// What joins a base name and its suffixes.
const NAME_SEPARATOR: &str = " · ";

/// The number in `name` if it is `template` (`内容画布 {{n}}`) with `{{n}}` replaced by one or more ASCII digits.
fn numbered<'a>(template: &str, name: &'a str) -> Option<&'a str> {
    let (before, after) = template.split_once("{{n}}")?;
    let n = name.strip_prefix(before)?.strip_suffix(after)?;
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then_some(n)
}

fn find<'v>(root: &'v Value, key: &str) -> Option<&'v Value> {
    key.split('.').try_fold(root, |node, part| node.get(part))
}

fn format_in(
    primary: &Value,
    fallback: &Value,
    locale: Locale,
    key: &str,
    params: &[(&str, Param)],
) -> String {
    match find(primary, key).or_else(|| find(fallback, key)) {
        Some(Value::String(text)) => interpolate(text, params),
        // i18next's wording for a key that names a whole section instead of one message.
        Some(Value::Object(_)) => format!(
            "key '{key} ({})' returned an object instead of string.",
            locale.code()
        ),
        _ => key.to_string(),
    }
}

/// i18next allows at most this many substitutions per string (`maxReplaces`).
const MAX_REPLACES: usize = 1000;

/// i18next's `Interpolator.interpolate` for `{{name}}` with `skipOnVariables` (its default): scan left to right for
/// `{{…}}` (one or more characters, no line break), trim the name, and replace the FIRST occurrence of that
/// placeholder text in the whole string — not necessarily the one just found — then continue scanning after the
/// substituted value, so a value is never interpolated again. A name missing from `params` is left in place.
fn interpolate(text: &str, params: &[(&str, Param)]) -> String {
    let mut out = text.to_string();
    let mut cursor = 0;
    for _ in 0..MAX_REPLACES {
        let Some((start, end)) = next_placeholder(&out, cursor) else {
            break;
        };
        let placeholder = out[start..end].to_string();
        let name = placeholder[2..placeholder.len() - 2].trim();
        let Some((_, value)) = params.iter().find(|(n, _)| *n == name) else {
            cursor = end;
            continue;
        };
        let value = value.render();
        let first = out
            .find(&placeholder)
            .expect("the placeholder was just found");
        out.replace_range(first..first + placeholder.len(), &value);
        cursor = start + value.len();
    }
    out
}

/// The first match of i18next's `/{{(.+?)}}/g` at or after byte `from`: the leftmost `{{` whose shortest following
/// non-empty run without a line terminator ends in `}}`.
fn next_placeholder(text: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut start = from;
    while start + 5 <= bytes.len() {
        if bytes[start] == b'{' && bytes[start + 1] == b'{' {
            let body = &text[start + 2..];
            let mut offset = 0;
            for (i, c) in body.char_indices() {
                if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                    break;
                }
                if i > 0 && body[i..].starts_with("}}") {
                    offset = i;
                    break;
                }
            }
            if offset > 0 {
                return Some((start, start + 2 + offset + 2));
            }
        }
        start += 1;
        while start < bytes.len() && !text.is_char_boundary(start) {
            start += 1;
        }
    }
    None
}

/// JavaScript's `Number.prototype.toString()` (radix 10): shortest round-trip digits, plain notation for exponents
/// in [-7, 21), exponent notation (`1e+21`, `1e-7`) outside it, `-0` as `0`.
pub fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // `{:e}` prints the shortest round-trip digits as d.ddde±x.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("`{:e}` always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // The value is 0.digits × 10^n, as in the ECMAScript algorithm.
    let n = exponent
        .parse::<i32>()
        .expect("`{:e}` exponent is an integer")
        + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> (Value, Value) {
        let zh = json!({
            "a": "x={{x}} y={{y}}!",
            "only_zh": "仅中文 {{n}}",
            "section": { "leaf": "n {{n}}" },
            "spaced": "k {{ k }} {{k}}",
            "twice": "{{x}}{{x}}",
            "broken": "{{a\nb}} {{c}}",
            "empty": "{{}} {{c}}",
        });
        let en = json!({ "a": "en x={{x}}", "section": { "leaf": "en n {{n}}" } });
        (zh, en)
    }

    fn zh(key: &str, params: &[(&str, Param)]) -> String {
        let (zh, _) = sample();
        format_in(&zh, &zh, Locale::Zh, key, params)
    }

    #[test]
    fn missing_key_comes_back_as_the_key() {
        assert_eq!(zh("no.such.key", &[]), "no.such.key");
        assert_eq!(zh("a.deeper", &[]), "a.deeper");
    }

    #[test]
    fn a_section_key_reads_like_i18next() {
        assert_eq!(
            zh("section", &[]),
            "key 'section (zh)' returned an object instead of string."
        );
    }

    #[test]
    fn missing_param_leaves_the_placeholder() {
        assert_eq!(zh("a", &[("x", Param::Int(1))]), "x=1 y={{y}}!");
        assert_eq!(zh("section.leaf", &[]), "n {{n}}");
    }

    #[test]
    fn en_falls_back_to_zh_per_key() {
        let (zh, en) = sample();
        assert_eq!(
            format_in(&en, &zh, Locale::En, "a", &[("x", Param::Int(2))]),
            "en x=2"
        );
        assert_eq!(
            format_in(&en, &zh, Locale::En, "only_zh", &[("n", Param::Int(3))]),
            "仅中文 3"
        );
        assert_eq!(format_in(&en, &zh, Locale::En, "nowhere", &[]), "nowhere");
    }

    #[test]
    fn numbers_render_like_javascript() {
        let cases: [(f64, &str); 16] = [
            (1.0, "1"),
            (1.5, "1.5"),
            (2.50, "2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1.23e-18, "1.23e-18"),
            (-0.0, "0"),
            (-12.25, "-12.25"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
            (123456789012.0, "123456789012"),
            (1.5e300, "1.5e+300"),
        ];
        for (value, expected) in cases {
            assert_eq!(js_number(value), expected, "{value:?}");
            assert_eq!(
                zh("section.leaf", &[("n", Param::Num(value))]),
                format!("n {expected}")
            );
        }
        assert_eq!(zh("section.leaf", &[("n", Param::Int(-7))]), "n -7");
        assert_eq!(zh("section.leaf", &[("n", Param::Bool(true))]), "n true");
    }

    #[test]
    fn substitution_follows_i18next_first_occurrence_rule() {
        // Measured with i18next 26.4.2: the value "{{y}}" replaces {{x}}, then the scan finds that new {{y}} first.
        assert_eq!(
            zh("a", &[("x", Param::Str("{{y}}")), ("y", Param::Str("Y"))]),
            "x=Y y={{y}}!"
        );
        assert_eq!(zh("spaced", &[("k", Param::Int(7))]), "k 7 7");
        assert_eq!(zh("twice", &[("x", Param::Str("Q"))]), "QQ");
        assert_eq!(
            zh("a", &[("x", Param::Str("$&")), ("y", Param::Str("a$1b"))]),
            "x=$& y=a$1b!"
        );
    }

    #[test]
    fn placeholders_need_a_name_on_one_line() {
        assert_eq!(
            zh("broken", &[("c", Param::Int(1)), ("a\nb", Param::Int(2))]),
            "{{a\nb}} 1"
        );
        // "{{}} {{c}}" is one placeholder named "}} {{c": the non-greedy body needs one character before `}}`.
        assert_eq!(zh("empty", &[("c", Param::Int(1))]), "{{}} {{c}}");
        assert_eq!(zh("empty", &[("}} {{c", Param::Int(1))]), "1");
    }

    #[test]
    fn real_catalogues_are_embedded() {
        assert_eq!(
            lookup(Locale::Zh, "progress.scanFrame"),
            Some("一帧一帧看录屏，找出哪些区域在动。")
        );
        assert!(lookup(Locale::En, "progress.scanFrame").is_some());
        assert!(lookup(Locale::Zh, "diag.MODEL_ASSUMPTIONS").is_none());
        let message = format(
            Locale::Zh,
            "diag.MEMORY_BUDGET_RAISED.message",
            &[
                ("from", Param::Int(12)),
                ("to", Param::Int(30)),
                ("mb", Param::Int(9)),
            ],
        );
        assert_eq!(
            message,
            "瓦片缓存从预算允许的 12 块提高到 30 块（约 9 MB），以容纳一帧触及的全部瓦片。"
        );
    }

    // display_name mirrors src/i18n/names.ts::displayName. Ways it could go wrong: translating in zh (persisted
    // names are zh already); missing one of the four fixed names or the two numbered ones; reading a numbered name
    // whose number is not ASCII digits (JS `\d`) or is empty; translating the fragment and framed suffixes in the
    // wrong order, or a suffix that is not at the end; dropping a name outside the vocabulary instead of keeping it;
    // splitting the unassigned name, which contains the separator itself.
    #[test]
    fn names_stay_as_stored_in_zh() {
        for name in [
            "内容画布 1",
            "内容画布 1 · 未定位片段 2 · 保留外框",
            "固定界面",
            "",
        ] {
            assert_eq!(display_name(Locale::Zh, name), name);
        }
    }

    #[test]
    fn the_vocabulary_reads_in_english() {
        let cases = [
            ("固定界面", "Fixed UI"),
            ("固定分隔界面", "Fixed divider"),
            (
                "未指定区域 · 屏幕坐标观察",
                "Unassigned area · screen-space observations",
            ),
            ("主动忽略", "Ignored"),
            ("内容画布 1", "Content canvas 1"),
            ("内容画布 12", "Content canvas 12"),
            ("内容画布 01", "Content canvas 01"),
            ("内容区域 3", "Content region 3"),
            ("内容画布 1 · 保留外框", "Content canvas 1 · framed"),
            (
                "内容画布 2 · 未定位片段 3",
                "Content canvas 2 · unplaced fragment 3",
            ),
            (
                "内容画布 1 · 未定位片段 2 · 保留外框",
                "Content canvas 1 · unplaced fragment 2 · framed",
            ),
            (
                "未指定区域 · 屏幕坐标观察 · 未定位片段 1",
                "Unassigned area · screen-space observations · unplaced fragment 1",
            ),
        ];
        for (name, english) in cases {
            assert_eq!(display_name(Locale::En, name), english, "{name}");
        }
    }

    #[test]
    fn names_outside_the_vocabulary_keep_what_they_can() {
        let cases = [
            ("Header", "Header"),
            ("", ""),
            ("内容画布 x", "内容画布 x"),
            ("内容画布 ", "内容画布 "),
            ("内容画布 ١", "内容画布 ١"),
            ("内容画布 1 extra", "内容画布 1 extra"),
            ("内容画布 1 · 未定位片段 x", "内容画布 1 · 未定位片段 x"),
            // Suffixes are read from the end in a fixed order: fragment, then framed.
            (
                "内容画布 1 · 保留外框 · 未定位片段 2",
                "内容画布 1 · 保留外框 · unplaced fragment 2",
            ),
            ("Header · 未定位片段 1", "Header · unplaced fragment 1"),
            ("保留外框", "保留外框"),
        ];
        for (name, english) in cases {
            assert_eq!(display_name(Locale::En, name), english, "{name}");
        }
    }
}
