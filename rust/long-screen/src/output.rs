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

    /// The print: the framed presentation of the moving canvas with the most observed pixels when there is one,
    /// else that canvas itself.
    pub fn print(&self) -> Option<CanvasInfo> {
        let canvases = self.canvases();
        let main = canvases
            .iter()
            .filter(|c| c.kind == "moving" && c.attached_to.is_none() && c.tile_count > 0)
            .max_by(|a, b| a.observed_pixels.total_cmp(&b.observed_pixels))?;
        canvases
            .iter()
            .find(|c| c.presents.as_deref() == Some(&main.id))
            .or(Some(main))
            .cloned()
    }

    /// Moving canvases with tiles other than the print's own: separate fragments the run could not place.
    pub fn fragments(&self) -> Vec<CanvasInfo> {
        let print = self.print();
        let main = print
            .as_ref()
            .map(|p| p.presents.clone().unwrap_or_else(|| p.id.clone()));
        self.canvases()
            .into_iter()
            .filter(|c| {
                c.kind == "moving"
                    && c.attached_to.is_none()
                    && c.tile_count > 0
                    && Some(&c.id) != main.as_ref()
            })
            .collect()
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
