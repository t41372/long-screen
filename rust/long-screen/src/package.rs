//! The result package (docs/FORMAT.md, `long-screen/sparse-canvas` version 2): the web page's project ZIP
//! (`exportProject` in src/export/project.ts) written from the native run's own rows, entry for entry and in the same
//! order. The offline viewer page, the README and the manifest's fixed notes come from the page's own source through
//! catalog/ (`deno task export-catalog`), so the two packages cannot drift apart.
//!
//! What differs between a page's package and this one is what differs between the runs: the project's id and
//! timestamps, `media` (the decoder and its mode), timings (`performance.json`, `*MS` fields), the host-measured
//! `COMPUTE_BACKEND` diagnostic, and the ZIP container's own bytes (entry timestamps).

use crate::engine::catalog::{display_name, js_number, lookup, Locale};
use crate::output::RunResult;
use crate::value::{to_json, to_json_pretty, typed_as_arrays, typed_values, Js, Obj};
use base64::Engine as _;
use std::io::{self, Seek, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// The viewer page with `%%NAME%%` placeholders (src/export/offline.ts `VIEWER_TEMPLATE`).
const VIEWER: &str = include_str!("../catalog/viewer.html");
/// README.txt (src/export/offline.ts `PACKAGE_README`).
const README: &str = include_str!("../catalog/package-readme.txt");
/// The manifest's fixed notes (src/export/offline.ts `PACKAGE_NOTES`).
const NOTES: &str = include_str!("../catalog/package-notes.json");

/// The JSON-lines files and the row prefixes they list, in the page's order.
const JSON_LINES: [(&str, &str); 7] = [
    ("observations", "observation/"),
    ("diagnostics", "diagnostic/"),
    ("poses", "node/"),
    ("pose-edges", "edge/"),
    ("analysis", "scan/"),
    ("temporal", "temporal/"),
    ("attachments", "attach/"),
];

fn note(notes: &serde_json::Value, key: &str) -> Js {
    match &notes[key] {
        serde_json::Value::String(s) => Js::Str(s.clone()),
        serde_json::Value::Number(n) => Js::Num(n.as_f64().unwrap_or(0.0)),
        _ => Js::Undefined,
    }
}

/// `template` with every `%%NAME%%` replaced by its value, in one pass (`fillTemplate` in src/export/offline.ts).
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find("%%") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let name_len = after.bytes().take_while(|b| b.is_ascii_uppercase()).count();
        let value = (name_len > 0 && after[name_len..].starts_with("%%"))
            .then(|| values.iter().find(|(k, _)| *k == &after[..name_len]))
            .flatten();
        match value {
            Some((_, v)) => {
                out.push_str(v);
                rest = &after[name_len + 2..];
            }
            None => {
                out.push_str("%%");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `&` and `<` escaped, as the viewer escapes text it puts in the page.
fn text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

/// The offline viewer for `manifest`, worded in `locale` (`offlineViewer` in src/export/offline.ts).
fn viewer(manifest: &Obj, locale: Locale) -> String {
    let mut named = manifest.clone();
    if let Some(Js::Arr(canvases)) = named.get("canvases").cloned() {
        let renamed = canvases
            .into_iter()
            .map(|c| match c {
                Js::Obj(mut o) => {
                    let name = display_name(locale, o.str("name").unwrap_or(""));
                    o.set("name", name.as_str());
                    Js::Obj(o)
                }
                other => other,
            })
            .collect();
        named.set("canvases", Js::Arr(renamed));
    }
    let tr = |key: &str| lookup(locale, key).unwrap_or("").to_string();
    let safe = to_json(&Js::Obj(named)).replace('<', "\\u003c");
    let strings = Obj::new()
        .with("previewLevel", tr("offline.previewLevel").as_str())
        .with("nativeTiles", tr("offline.nativeTiles").as_str())
        .with("footer", tr("offline.footer").as_str());
    let strings = to_json(&Js::Obj(strings)).replace('<', "\\u003c");
    let dir = tr("viewer.dir");
    fill(
        VIEWER,
        &[
            ("LANG", &tr("viewer.lang")),
            ("DIR", &dir),
            ("TITLE", &text(&tr("offline.title"))),
            ("FIT", &text(&tr("offline.fit"))),
            ("TIP", &text(&tr("offline.tip"))),
            ("MANIFEST", &safe),
            ("STRINGS", &strings),
            ("RTL", if dir == "rtl" { "true" } else { "false" }),
        ],
    )
}

/// The bytes of a stored typed-array field, if the row has one.
fn plane(row: &Obj, key: &str) -> Option<Vec<u8>> {
    row.get(key)?.bytes().map(|b| b.to_vec())
}

/// A typed-array field as the plain JSON array `[...typed]` writes, or `[]` without one.
fn numbers(row: &Obj, key: &str) -> Js {
    match row.get(key) {
        Some(Js::Typed(kind, bytes)) => Js::Arr(
            typed_values(*kind, bytes)
                .into_iter()
                .map(Js::Num)
                .collect(),
        ),
        _ => Js::Arr(Vec::new()),
    }
}

fn zip_error(e: zip::result::ZipError) -> io::Error {
    io::Error::other(e)
}

impl RunResult {
    /// Writes the result package (docs/FORMAT.md) to `out`: the same entries, in the same order and with the same
    /// contents as the web page's "project ZIP", except what differs between the two runs themselves (see the module
    /// documentation). Entries are stored uncompressed, like the page's; tiles are already PNG.
    pub fn write_package<W: Write + Seek>(&self, out: W) -> io::Result<()> {
        let notes: serde_json::Value =
            serde_json::from_str(NOTES).map_err(|e| io::Error::other(e.to_string()))?;
        let run = format!("run/{}/", self.run_id());
        let store = self.store();
        let rows = |prefix: &str| -> Vec<Js> {
            store
                .keys(&format!("{run}{prefix}"))
                .into_iter()
                .filter_map(|k| store.get(&k))
                .collect()
        };
        let mut zip = ZipWriter::new(out);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(false);
        let add = |zip: &mut ZipWriter<W>, name: &str, bytes: &[u8]| -> io::Result<()> {
            let options = if bytes.len() as u64 >= u32::MAX as u64 {
                options.large_file(true)
            } else {
                options
            };
            zip.start_file(name, options).map_err(zip_error)?;
            zip.write_all(bytes)
        };

        let project = Js::Obj(self.project().clone());
        let tile_size = self
            .project()
            .get("settings")
            .and_then(Js::as_obj)
            .map_or(self.tile_size() as f64, |s| s.num("tileSize"));
        let manifest = Obj::new()
            .with("format", note(&notes, "format"))
            .with("version", note(&notes, "version"))
            .with("presentation", note(&notes, "presentation"))
            .with("tileSize", tile_size)
            .with("coordinates", note(&notes, "coordinates"))
            .with("holes", note(&notes, "holes"))
            .with("levels", note(&notes, "levels"))
            .with("confidence", note(&notes, "confidence"))
            .with("sourceIncluded", false)
            .with("project", project)
            .with("canvases", Js::Arr(rows("canvas/")));
        add(
            &mut zip,
            "manifest.json",
            to_json_pretty(&Js::Obj(manifest.clone())).as_bytes(),
        )?;
        add(
            &mut zip,
            "index.html",
            viewer(&manifest, self.locale()).as_bytes(),
        )?;
        add(&mut zip, "README.txt", README.as_bytes())?;

        let regions: Vec<Js> = store
            .get(&format!("{run}regions"))
            .and_then(|r| r.as_arr().map(|a| a.to_vec()))
            .unwrap_or_default()
            .into_iter()
            .map(|r| match r {
                Js::Obj(mut o) => {
                    if let Some(mask) = o.get("mask").and_then(Js::bytes).cloned() {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&*mask);
                        o.set("mask", encoded.as_str());
                    }
                    Js::Obj(o)
                }
                other => other,
            })
            .collect();
        add(
            &mut zip,
            "regions.json",
            to_json_pretty(&Js::Arr(regions)).as_bytes(),
        )?;

        for key in store.keys(&format!("{run}tile-index/")) {
            let Some(Js::Obj(index)) = store.get(&key) else {
                continue;
            };
            let path = format!(
                "{}/{}/{}_{}",
                index.str("canvasId").unwrap_or(""),
                js_number(index.num("level")),
                js_number(index.num("x")),
                js_number(index.num("y"))
            );
            let Some(Js::Obj(tile)) = store.get(&format!("{run}tile/{path}")) else {
                return Err(io::Error::other(format!(
                    "Missing committed tile {path}; export was not marked complete."
                )));
            };
            let blob = tile
                .get("blob")
                .and_then(Js::bytes)
                .cloned()
                .unwrap_or_default();
            add(&mut zip, &format!("tiles/{path}.png"), &blob)?;
            if index.num("level") == 0.0 {
                let (canvas, x, y) = (
                    index.str("canvasId").unwrap_or(""),
                    js_number(index.num("x")),
                    js_number(index.num("y")),
                );
                let coverage = plane(&tile, "coverage").unwrap_or_default();
                add(
                    &mut zip,
                    &format!("coverage/{canvas}/{x}_{y}.bin"),
                    &coverage,
                )?;
                let provisional =
                    plane(&tile, "provisional").unwrap_or_else(|| vec![0; coverage.len()]);
                add(
                    &mut zip,
                    &format!("provisional/{canvas}/{x}_{y}.bin"),
                    &provisional,
                )?;
                let quality = Obj::new()
                    .with("blockSize", 16u32)
                    .with("quality", numbers(&tile, "quality"))
                    .with("conflicts", numbers(&tile, "conflicts"))
                    .with("frozen", numbers(&tile, "frozen"))
                    .with("ownerFrameEncoding", note(&notes, "ownerFrameEncoding"))
                    .with("ownerFrame", numbers(&tile, "owner"));
                add(
                    &mut zip,
                    &format!("quality/{canvas}/{x}_{y}.json"),
                    to_json(&Js::Obj(quality)).as_bytes(),
                )?;
            }
        }
        for (name, prefix) in JSON_LINES {
            let mut text = String::new();
            for row in rows(prefix) {
                text.push_str(&to_json(&typed_as_arrays(&row)));
                text.push('\n');
            }
            add(&mut zip, &format!("{name}.jsonl"), text.as_bytes())?;
        }
        for key in ["graph-summary", "memory-stats", "performance"] {
            let row = store
                .get(&format!("{run}{key}"))
                .unwrap_or_else(|| Js::Obj(Obj::new()));
            add(
                &mut zip,
                &format!("{key}.json"),
                to_json_pretty(&row).as_bytes(),
            )?;
        }
        zip.finish().map_err(zip_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Typed;

    // Failure cases: a value scanned again for placeholders (a canvas named `%%TITLE%%`), `$`-patterns in a value
    // read as replacement syntax, an unknown or unterminated placeholder dropped; JSON.stringify(x, null, 2) spacing
    // wrong for empty or nested containers, undefined fields written, a typed array not written as its indices.

    #[test]
    fn placeholders_are_filled_once_and_unknown_ones_stay() {
        let page = fill(
            "<t>%%TITLE%%</t>%%MANIFEST%% %%NOPE%% %%TITLE 100%%",
            &[("TITLE", "a %%MANIFEST%% $& $1"), ("MANIFEST", "{}")],
        );
        assert_eq!(page, "<t>a %%MANIFEST%% $& $1</t>{} %%NOPE%% %%TITLE 100%%");
    }

    #[test]
    fn pretty_json_is_json_stringify_with_two_spaces() {
        let v = Js::Obj(
            Obj::new()
                .with("a", 1u32)
                .with("b", Js::Arr(Vec::new()))
                .with("c", Js::Obj(Obj::new()))
                .with("d", Js::Undefined)
                .with(
                    "e",
                    Js::Arr(vec![Js::Num(1.5), Js::Undefined, Js::Str("x".into())]),
                )
                .with("f", Js::typed(Typed::Uint8, vec![7, 8])),
        );
        assert_eq!(
            to_json_pretty(&v),
            "{\n  \"a\": 1,\n  \"b\": [],\n  \"c\": {},\n  \"e\": [\n    1.5,\n    null,\n    \"x\"\n  ],\n  \"f\": {\n    \"0\": 7,\n    \"1\": 8\n  }\n}"
        );
        assert_eq!(
            to_json(&typed_as_arrays(&Js::Obj(Obj::new().with(
                "q",
                Js::typed(Typed::Float32, 0.1f32.to_le_bytes().to_vec())
            )))),
            "{\"q\":[0.10000000149011612]}"
        );
    }
}
