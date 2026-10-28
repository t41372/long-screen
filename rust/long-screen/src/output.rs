//! What a run leaves: its rows, its canvases as tiles, PNG output of any canvas, the diagnostics, and the
//! fingerprint of every row (the format `scripts/fingerprint-scenarios.ts` writes, for parity with the web page).

use crate::context::Ctx;
use crate::engine::catalog::{display_name, Locale};
use crate::kernels::geometry::Rect;
use crate::store::Store;
use crate::tiles::decode_png;
use crate::value::{fingerprint, read_rect, Js, Obj};
use crate::Diagnostic;
use std::collections::BTreeMap;
use std::io::{self, Write};

/// One canvas of the result.
#[derive(Clone, Debug, PartialEq)]
pub struct CanvasInfo {
    pub id: String,
    /// The region (layer) it belongs to.
    pub layer: String,
    /// The stored name: the zh vocabulary the page persists (`内容画布 1`, `固定界面`, …) whatever the run's
    /// language. [`RunResult::display_name`] gives it in the run's language.
    pub name: String,
    /// `moving` (reconstructed content), `fixed` (screen-fixed interface) or `presentation` (a framed view).
    pub kind: String,
    /// World-coordinate bounds of what was painted.
    pub bounds: Rect,
    pub tile_count: u64,
    pub observed_pixels: f64,
    /// Fragment number within its layer (0 is the main canvas).
    pub fragment: u32,
    /// Set when revisit evidence merged this fragment into another canvas (it then has no tiles).
    pub attached_to: Option<String>,
    /// For a framed presentation: the canvas it frames.
    pub presents: Option<String>,
}

impl CanvasInfo {
    fn from_row(o: &Obj) -> CanvasInfo {
        CanvasInfo {
            id: o.str("id").unwrap_or_default().to_string(),
            layer: o.str("layer").unwrap_or_default().to_string(),
            name: o.str("name").unwrap_or_default().to_string(),
            kind: o.str("kind").unwrap_or_default().to_string(),
            bounds: o.get("bounds").and_then(read_rect).unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            }),
            tile_count: o.num("tileCount").max(0.0) as u64,
            observed_pixels: o.num("observedPixels"),
            fragment: o.num("fragment").max(0.0) as u32,
            attached_to: o.str("attachedTo").map(String::from),
            presents: o
                .get("presentation")
                .and_then(Js::as_obj)
                .and_then(|p| p.str("sourceCanvas"))
                .map(String::from),
        }
    }
}

/// A finished (or partial) run.
pub struct RunResult {
    store: Store,
    run_id: String,
    project: Obj,
    diagnostics: Vec<Diagnostic>,
    tile_size: usize,
    seconds: f64,
    locale: Locale,
}

impl std::fmt::Debug for RunResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunResult")
            .field("status", &self.status())
            .field("frames", &self.frames())
            .field("rows", &self.store.len())
            .finish()
    }
}

impl RunResult {
    pub(crate) fn new(ctx: Ctx, seconds: f64) -> RunResult {
        let project = ctx.project();
        RunResult {
            run_id: ctx.run_id.clone(),
            tile_size: ctx.tiles.size,
            diagnostics: ctx.journal.shown,
            store: ctx.store,
            project,
            seconds,
            locale: ctx.locale,
        }
    }

    /// `complete`, `partial` or `error`.
    pub fn status(&self) -> &str {
        self.project.str("status").unwrap_or("error")
    }

    /// The failure that ended the run early, if one did.
    pub fn error(&self) -> Option<&str> {
        self.project.str("error")
    }

    /// Frames analysed.
    pub fn frames(&self) -> u32 {
        self.project.num("frames") as u32
    }

    pub fn rendered_frames(&self) -> u32 {
        let n = self.project.num("renderedFrames");
        if n.is_finite() {
            n as u32
        } else {
            0
        }
    }

    /// Wall-clock seconds the run took.
    pub fn seconds(&self) -> f64 {
        self.seconds
    }

    /// The project row (as the page stores it).
    pub fn project(&self) -> &Obj {
        &self.project
    }

    /// Every diagnostic, in emission order, in the run's display language.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// `canvas`'s name in the run's language (`Content canvas 1` in English), as the page shows it.
    pub fn display_name(&self, canvas: &CanvasInfo) -> String {
        display_name(self.locale, &canvas.name)
    }

    /// Every stored row.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// The run's id: its rows are stored under `run/<id>/`.
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The language the run's messages and names are in.
    pub(crate) fn locale(&self) -> Locale {
        self.locale
    }

    fn row(&self, key: &str) -> Option<Js> {
        self.store.get(&format!("run/{}/{key}", self.run_id))
    }

    /// The run-relative stored row `key` (e.g. `performance`, `canvas/<id>`).
    pub fn get(&self, key: &str) -> Option<Js> {
        self.row(key)
    }

    /// Every canvas, in key order.
    pub fn canvases(&self) -> Vec<CanvasInfo> {
        let base = format!("run/{}/canvas/", self.run_id);
        self.store
            .keys(&base)
            .iter()
            .filter_map(|k| self.store.get(k))
            .filter_map(|v| v.as_obj().map(CanvasInfo::from_row))
            .collect()
    }

    /// Every canvas worth a PNG, in the order the page lists them (its canvas menu, and `prints` in the npm package):
    /// framed presentations first when the run framed them ([`crate::Framing::Context`]), then reconstructed
    /// content, then screen-fixed interface, each by observed pixels, most first. A canvas without tiles (a fragment
    /// that later evidence merged into another canvas holds none) is left out.
    pub fn prints(&self) -> Vec<CanvasInfo> {
        let framed = self
            .project
            .get("settings")
            .and_then(Js::as_obj)
            .and_then(|s| s.str("framing"))
            == Some("context");
        printable(self.canvases(), framed)
    }

    /// The print: the canvas the page shows first, the first of [`RunResult::prints`].
    pub fn print(&self) -> Option<CanvasInfo> {
        self.prints().into_iter().next()
    }

    /// The reconstructed content other than the print's own, in the page's order: separate fragments the run could
    /// not place.
    pub fn fragments(&self) -> Vec<CanvasInfo> {
        fragments_of(&self.prints())
    }

    /// The level-0 tile `(x, y)` of `canvas` as `tile_size × tile_size` RGBA, if it was painted.
    pub fn tile(&self, canvas: &str, x: i32, y: i32) -> Option<Vec<u8>> {
        let row = self.row(&format!("tile/{canvas}/0/{x}_{y}"))?;
        let blob = row.as_obj()?.get("blob")?.bytes()?.clone();
        decode_png(&blob).ok().map(|(_, _, rgba)| rgba)
    }

    pub fn tile_size(&self) -> usize {
        self.tile_size
    }

    /// The pixel extent of `canvas`'s bounds: its top-left world pixel and its size.
    fn extent(&self, canvas: &str) -> io::Result<(i64, i64, u32, u32)> {
        let info = self
            .canvases()
            .into_iter()
            .find(|c| c.id == canvas)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, format!("no canvas {canvas}"))
            })?;
        let b = info.bounds;
        let (x0, y0) = (b.x.floor() as i64, b.y.floor() as i64);
        let (w, h) = (
            b.width.ceil().max(0.0) as u32,
            b.height.ceil().max(0.0) as u32,
        );
        if w == 0 || h == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the canvas is empty",
            ));
        }
        Ok((x0, y0, w, h))
    }

    /// The size in pixels of the image [`RunResult::write_png`] and [`RunResult::read_rows`] give for `canvas`.
    pub fn canvas_size(&self, canvas: &str) -> io::Result<(u32, u32)> {
        self.extent(canvas).map(|(_, _, w, h)| (w, h))
    }

    /// Hands `row` each row of `canvas`'s bounds as RGBA (unobserved pixels transparent), top to bottom, decoding
    /// one band of tiles at a time, so memory stays at one tile row however long the print is.
    pub fn read_rows(
        &self,
        canvas: &str,
        mut row: impl FnMut(&[u8]) -> io::Result<()>,
    ) -> io::Result<(u32, u32)> {
        let (x0, y0, w, h) = self.extent(canvas)?;
        let size = self.tile_size as i64;
        let mut line = vec![0u8; w as usize * 4];
        let mut y = 0i64;
        while y < h as i64 {
            let wy = y0 + y;
            let ty = wy.div_euclid(size);
            let band_end = ((ty + 1) * size - y0).min(h as i64);
            let tx0 = x0.div_euclid(size);
            let tx1 = (x0 + w as i64 - 1).div_euclid(size);
            let tiles: Vec<Option<Vec<u8>>> = (tx0..=tx1)
                .map(|tx| self.tile(canvas, tx as i32, ty as i32))
                .collect();
            while y < band_end {
                let ly = (y0 + y - ty * size) as usize;
                line.fill(0);
                for (i, tile) in tiles.iter().enumerate() {
                    let Some(tile) = tile else { continue };
                    let tx = tx0 + i as i64;
                    let from = (tx * size).max(x0);
                    let to = ((tx + 1) * size).min(x0 + w as i64);
                    let src = ((ly * self.tile_size) + (from - tx * size) as usize) * 4;
                    let dst = (from - x0) as usize * 4;
                    let n = (to - from) as usize * 4;
                    line[dst..dst + n].copy_from_slice(&tile[src..src + n]);
                }
                row(&line)?;
                y += 1;
            }
        }
        Ok((w, h))
    }

    /// Writes `canvas`'s bounds as one RGBA PNG (unobserved pixels transparent), one band of tiles at a time, so
    /// memory stays at one tile row however long the print is.
    pub fn write_png<W: Write>(&self, canvas: &str, out: W) -> io::Result<(u32, u32)> {
        let (w, h) = self.canvas_size(canvas)?;
        let mut encoder = png::Encoder::new(out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(io::Error::other)?;
        let mut stream = writer.stream_writer().map_err(io::Error::other)?;
        self.read_rows(canvas, |line| stream.write_all(line))?;
        stream.finish().map_err(io::Error::other)?;
        Ok((w, h))
    }

    /// Every row's fingerprint digest, keyed as `scripts/fingerprint-scenarios.ts` keys them (`<run>` for the run
    /// id), plus the project row's digest.
    pub fn fingerprint(&self) -> (BTreeMap<String, String>, String) {
        let mut rows = BTreeMap::new();
        for (key, _) in self.store.iter() {
            let value = self.store.get(key).unwrap();
            let k = key.replace(&self.run_id, "<run>");
            rows.insert(k, fingerprint(&value, &self.run_id));
        }
        let project = fingerprint(&Js::Obj(self.project.clone()), &self.run_id);
        (rows, project)
    }
}

/// The page's order (`printable` in src/package/index.ts; the canvas menu in src/ui/canvases.ts ranks the same way):
/// canvases with tiles, not merged into another and with finite bounds, ranked presentation (only when `framed`),
/// then moving, then fixed, and within a rank by observed pixels, most first. The sort is stable, so ties keep key
/// order, as the page's `Array.prototype.sort` keeps the order its rows arrive in.
fn printable(canvases: Vec<CanvasInfo>, framed: bool) -> Vec<CanvasInfo> {
    let rank = |c: &CanvasInfo| match c.kind.as_str() {
        "presentation" if framed => -1,
        "fixed" => 1,
        _ => 0,
    };
    let mut out: Vec<CanvasInfo> = canvases
        .into_iter()
        .filter(|c| {
            c.tile_count > 0
                && c.attached_to.is_none()
                && c.bounds.width.is_finite()
                && c.bounds.height.is_finite()
        })
        .collect();
    // `b.observedPixels - a.observedPixels`: a NaN difference compares equal, as it does in the page's sort.
    out.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then_with(|| {
            (b.observed_pixels - a.observed_pixels)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    out
}

/// The moving canvases in `prints` other than the one the print shows.
fn fragments_of(prints: &[CanvasInfo]) -> Vec<CanvasInfo> {
    let main = prints
        .first()
        .map(|p| p.presents.clone().unwrap_or_else(|| p.id.clone()));
    prints
        .iter()
        .filter(|c| c.kind == "moving" && Some(&c.id) != main.as_ref())
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canvas(id: &str, kind: &str, observed: f64) -> CanvasInfo {
        CanvasInfo {
            id: id.into(),
            layer: "body".into(),
            name: id.into(),
            kind: kind.into(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            tile_count: 1,
            observed_pixels: observed,
            fragment: 0,
            attached_to: None,
            presents: None,
        }
    }

    fn framed(id: &str, of: &str, observed: f64) -> CanvasInfo {
        CanvasInfo {
            presents: Some(of.into()),
            ..canvas(id, "presentation", observed)
        }
    }

    fn ids(canvases: &[CanvasInfo]) -> Vec<&str> {
        canvases.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn a_framed_main_canvas_outranks_a_bigger_fragment_that_was_not_framed() {
        // The main canvas was framed; the fragment, with more observed pixels, was not (framing found no reference
        // for it, or skipped it as too sparse). The page shows the framed main canvas.
        let rows = vec![
            canvas("main", "moving", 100.0),
            framed("main-framed", "main", 150.0),
            CanvasInfo {
                fragment: 1,
                ..canvas("piece", "moving", 200.0)
            },
        ];
        let prints = printable(rows, true);
        assert_eq!(ids(&prints), ["main-framed", "piece", "main"]);
        assert_eq!(ids(&fragments_of(&prints)), ["piece"]);
    }

    #[test]
    fn presentations_rank_by_their_own_observed_pixels() {
        // The framed views need not follow their sources' order: each frame adds its own chrome.
        let rows = vec![
            canvas("a", "moving", 100.0),
            canvas("b", "moving", 200.0),
            framed("a-framed", "a", 300.0),
            framed("b-framed", "b", 250.0),
        ];
        let prints = printable(rows, true);
        assert_eq!(ids(&prints), ["a-framed", "b-framed", "b", "a"]);
        assert_eq!(ids(&fragments_of(&prints)), ["b"]);
    }

    #[test]
    fn fragments_follow_observed_pixels_not_key_order() {
        let rows = vec![
            canvas("a", "moving", 300.0),
            canvas("b", "moving", 10.0),
            canvas("c", "moving", 20.0),
        ];
        let prints = printable(rows, false);
        assert_eq!(ids(&prints), ["a", "c", "b"]);
        assert_eq!(ids(&fragments_of(&prints)), ["c", "b"]);
    }

    #[test]
    fn fixed_parts_come_last_and_empty_merged_or_unbounded_canvases_are_left_out() {
        let rows = vec![
            canvas("chrome", "fixed", 1e6),
            canvas("page", "moving", 100.0),
            CanvasInfo {
                tile_count: 0,
                attached_to: Some("page".into()),
                ..canvas("merged", "moving", 500.0)
            },
            CanvasInfo {
                tile_count: 0,
                ..canvas("empty", "moving", 0.0)
            },
            CanvasInfo {
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: f64::NAN,
                    height: 100.0,
                },
                ..canvas("unbounded", "moving", 900.0)
            },
        ];
        assert_eq!(ids(&printable(rows, true)), ["page", "chrome"]);
    }

    #[test]
    fn without_framing_a_presentation_ranks_with_the_content() {
        // The npm package ranks a presentation first only under `framing: 'context'`.
        let rows = vec![
            canvas("page", "moving", 100.0),
            framed("page-framed", "page", 50.0),
        ];
        assert_eq!(ids(&printable(rows, false)), ["page", "page-framed"]);
    }

    #[test]
    fn ties_keep_key_order() {
        let rows = vec![canvas("a", "moving", 100.0), canvas("b", "moving", 100.0)];
        assert_eq!(ids(&printable(rows, false)), ["a", "b"]);
    }

    #[test]
    fn only_fixed_interface_still_gives_a_print() {
        // The page shows a fixed canvas when nothing moved; so does the print.
        let prints = printable(vec![canvas("chrome", "fixed", 10.0)], true);
        assert_eq!(ids(&prints), ["chrome"]);
        assert!(fragments_of(&prints).is_empty());
    }
}
