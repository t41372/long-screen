//! The state every pass of a run shares (the page's `RunContext`), the diagnostics journal (`Diagnostics`), and the
//! small helpers that format messages from the catalogue.
//!
//! Rows are written straight into the store; the page batches them (24 rows, 1.2 s) only to spare IndexedDB
//! transactions, and what ends up stored is the same.

use crate::engine::catalog::{self, Locale, Param};
use crate::kernels::regions::RegionOut;
use crate::source::MediaInfo;
use crate::store::Store;
use crate::tiles::Tiles;
use crate::value::{Js, Obj};
use crate::{Control, Diagnostic, Observer, Progress, Settings};
use std::time::{Duration, Instant};

/// `String(n).padStart(10, '0')`.
pub fn pad(n: u32) -> String {
    format!("{n:010}")
}

/// The catalogue message `key` in `locale`.
pub fn t(locale: Locale, key: &str, params: &[(&str, Param)]) -> String {
    catalog::format(locale, key, params)
}

/// Builds a diagnostic row in a given language. The journal stores the zh row (the page persists zh text); the
/// observer gets the row again in the run's display language.
pub type Build<'a> = &'a dyn Fn(Locale) -> Obj;

/// The diagnostics journal: `diagnostic/<seq>` rows, per-code counts and the highest severity per code.
#[derive(Default)]
pub struct Journal {
    pub counts: Obj,
    pub severities: Obj,
    sequence: u32,
    /// Every row emitted, in the display language (the run's result lists them).
    pub shown: Vec<Diagnostic>,
}

fn rank(severity: &str) -> u8 {
    match severity {
        "error" => 2,
        "warning" => 1,
        _ => 0,
    }
}

/// An error turned into text the way the page's `String(error)` does.
pub fn error_text(message: &str) -> String {
    format!("Error: {message}")
}

/// The run's shared state.
pub struct Ctx<'a> {
    pub store: Store,
    pub journal: Journal,
    pub tiles: Tiles,
    pub settings: Settings,
    pub settings_js: Obj,
    pub info: MediaInfo,
    pub observer: &'a mut dyn Observer,
    pub control: Control,
    pub locale: Locale,
    pub run_id: String,
    pub created: String,
    // Project fields.
    pub status: &'static str,
    pub frames: u32,
    pub rendered_frames: u32,
    pub canvas_count: u32,
    pub tile_total: f64,
    pub observed_pixels: f64,
    pub project_regions: Js,
    pub error: Option<String>,
    // Run state.
    pub phase: &'static str,
    pub partial: bool,
    pub stopped: bool,
    pub stop_requested: bool,
    pub processed: u32,
    pub factor: usize,
    pub refine_radius: i32,
    pub noise: f64,
    pub regions: Vec<RegionOut>,
    pub atlas: Option<(Vec<u8>, Vec<u32>)>,
    pub duplicates: u32,
    pub skipped_paints: u64,
    pub voted_layers: u32,
    pub thin_layers: u32,
    pub timings: Obj,
    pub threads: usize,
    last_progress: Option<Instant>,
}

/// `Math.max(1, Math.ceil(Math.max(width, height) / Math.max(1, analysisSize)))`.
pub fn analysis_factor(width: usize, height: usize, analysis_size: f64) -> usize {
    ((width.max(height) as f64) / analysis_size.max(1.0))
        .ceil()
        .max(1.0) as usize
}

impl<'a> Ctx<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        info: MediaInfo,
        observer: &'a mut dyn Observer,
        settings: Settings,
        settings_js: Obj,
        control: Control,
        locale: Locale,
        store: Store,
        threads: usize,
    ) -> Result<Ctx<'a>, String> {
        let factor = analysis_factor(info.width, info.height, settings.analysis_size as f64);
        let tiles = Tiles::new(settings.tile_size as usize, settings.memory_mb)?;
        let noise = info.noise;
        Ok(Ctx {
            store,
            journal: Journal::default(),
            tiles,
            settings,
            settings_js,
            info,
            observer,
            control,
            locale,
            run_id: "native".into(),
            created: String::new(),
            status: "scanning",
            frames: 0,
            rendered_frames: 0,
            canvas_count: 0,
            tile_total: 0.0,
            observed_pixels: 0.0,
            project_regions: Js::Arr(Vec::new()),
            error: None,
            phase: "scanning",
            partial: false,
            stopped: false,
            stop_requested: false,
            processed: 0,
            factor,
            refine_radius: (factor as f64 / 2.0).ceil().max(2.0) as i32 + 1,
            noise,
            regions: Vec::new(),
            atlas: None,
            duplicates: 0,
            skipped_paints: 0,
            voted_layers: 0,
            thin_layers: 0,
            timings: Obj::new(),
            threads,
            last_progress: None,
        })
    }

    pub fn tr(&self, key: &str, params: &[(&str, Param)]) -> String {
        t(self.locale, key, params)
    }

    /// The `run/<id>/` key of a row.
    pub fn key(&self, key: &str) -> String {
        format!("run/{}/{key}", self.run_id)
    }

    pub fn put(&mut self, key: &str, value: impl Into<Js>) {
        let k = self.key(key);
        self.store.put(&k, value.into());
    }

    pub fn get(&self, key: &str) -> Option<Js> {
        self.store.get(&self.key(key))
    }

    pub fn delete(&mut self, key: &str) {
        let k = self.key(key);
        self.store.delete(&k);
    }

    /// Run-relative keys under `prefix`, in key order.
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        let base = self.key("");
        self.store
            .keys(&self.key(prefix))
            .into_iter()
            .map(|k| k[base.len()..].to_string())
            .collect()
    }

    /// Emits one diagnostic: the zh row into the journal, the display-language row to the observer.
    pub fn emit(&mut self, build: Build) {
        let row = build(Locale::Zh);
        let code = row.str("code").unwrap_or_default().to_string();
        let severity = row.str("severity").unwrap_or("info").to_string();
        let count = self.journal.counts.num(&code);
        let count = if count.is_nan() { 1.0 } else { count + 1.0 };
        self.journal.counts.set(&code, count);
        let higher = match self.journal.severities.str(&code) {
            Some(known) => rank(&severity) > rank(known),
            None => true,
        };
        if higher {
            self.journal.severities.set(&code, severity.as_str());
        }
        let key = format!("diagnostic/{}", pad(self.journal.sequence));
        self.journal.sequence += 1;
        self.put(&key, Js::Obj(row.clone()));
        let shown = if self.locale == Locale::Zh {
            row
        } else {
            build(self.locale)
        };
        let diagnostic = Diagnostic::from_row(shown, count as u32);
        self.observer.diagnostic(&diagnostic);
        self.journal.shown.push(diagnostic);
    }

    /// The `project/<id>` row, in the page's field order.
    pub fn project(&self) -> Obj {
        let mut p = Obj::new()
            .with("id", self.run_id.as_str())
            .with("created", self.created.as_str())
            .with("updated", self.created.as_str())
            .with("name", self.info.name.as_str())
            .with("settings", Js::Obj(self.settings_js.clone()))
            .with("media", Js::Obj(self.info.js.clone()))
            .with("status", self.status)
            .with("frames", self.frames)
            .with("renderedFrames", self.rendered_frames)
            .with("canvasCount", self.canvas_count)
            .with("tiles", self.tile_total)
            .with("observedPixels", self.observed_pixels)
            .with("diagnostics", Js::Obj(self.journal.counts.clone()))
            .with("regions", self.project_regions.clone())
            .with("schema", 2u32)
            .with("severities", Js::Obj(self.journal.severities.clone()));
        if let Some(e) = &self.error {
            p.set("error", e.as_str());
        }
        p
    }

    pub fn persist(&mut self) {
        let row = self.project();
        let key = format!("project/{}", self.run_id);
        self.store.put(&key, Js::Obj(row));
    }

    /// Pause and stop between steps (the page's `checkpoint`): waits while paused, notes a stop request.
    pub fn checkpoint(&mut self) {
        while self.control.is_paused() && !self.control.stop_requested() {
            std::thread::sleep(Duration::from_millis(50));
        }
        if self.control.take_stop() {
            self.stop_requested = true;
        }
        if self.stop_requested {
            self.partial = true;
        }
    }

    /// The page's `honourStop`.
    pub fn honour_stop(&mut self) {
        self.partial = true;
        self.stopped = true;
        self.stop_requested = false;
    }

    /// A progress event (throttled to one per 100 ms, as the page's `report`), then a checkpoint.
    pub fn report(
        &mut self,
        frame: u32,
        time: f64,
        message: &str,
        fraction: Option<f64>,
        canvas: Option<&str>,
    ) {
        let now = Instant::now();
        if self
            .last_progress
            .is_some_and(|last| now.duration_since(last) < Duration::from_millis(100))
        {
            return;
        }
        self.last_progress = Some(now);
        let fraction = fraction.unwrap_or_else(|| (time / self.info.duration.max(0.001)).min(1.0));
        self.observer.progress(&Progress {
            phase: self.phase.to_string(),
            fraction,
            frames: frame,
            total: self.info.frame_count,
            time,
            message: message.to_string(),
            canvas: canvas.map(String::from),
        });
        self.checkpoint();
    }

    /// An unthrottled progress event.
    pub fn event(&mut self, phase: &str, fraction: f64, frames: u32, time: f64, message: String) {
        self.observer.progress(&Progress {
            phase: phase.to_string(),
            fraction,
            frames,
            total: self.info.frame_count,
            time,
            message,
            canvas: None,
        });
    }

    /// `PASS_FRAME_COUNT_MISMATCH` when a pass finished fewer frames than it expected.
    pub fn pass_mismatch(&mut self, pass: &str, expected: u32, actual: u32) {
        if expected == actual {
            return;
        }
        self.partial = true;
        self.emit(&|l| {
            Obj::new()
                .with("code", "PASS_FRAME_COUNT_MISMATCH")
                .with("severity", "error")
                .with(
                    "message",
                    t(
                        l,
                        "diag.PASS_FRAME_COUNT_MISMATCH.message",
                        &[
                            ("pass", Param::Str(pass)),
                            ("actual", Param::Int(actual as i64)),
                            ("expected", Param::Int(expected as i64)),
                        ],
                    ),
                )
                .with("action", t(l, "diag.PASS_FRAME_COUNT_MISMATCH.action", &[]))
                .with(
                    "detail",
                    Obj::new()
                        .with("pass", pass)
                        .with("expected", expected)
                        .with("actual", actual),
                )
        });
    }

    /// The page's `prefixOnly`: a pass keeps the prefix it committed.
    pub fn prefix_only(
        &mut self,
        code: &'static str,
        pass: &'static str,
        frames: u32,
        message: &str,
    ) {
        let message = error_text(message);
        self.emit(&|l| {
            let base = t(
                l,
                &format!("diag.prefixOnly.base.{pass}"),
                &[("frames", Param::Int(frames as i64))],
            );
            let suffix = if code == "PERSISTENCE_PREFIX_ONLY" {
                t(l, "diag.prefixOnly.suffixPersistence", &[])
            } else {
                t(l, "diag.prefixOnly.suffixDefault", &[])
            };
            let mut row = Obj::new()
                .with("code", code)
                .with("severity", "error")
                .with("message", message.as_str())
                .with("action", base + &suffix);
            if pass != "scan" {
                row.set(
                    "detail",
                    Obj::new().with("pass", pass).with("frames", frames),
                );
            }
            row
        });
    }

    /// Adds an entry to the `performance` row's timings, in order.
    pub fn timing(&mut self, key: &str, value: f64) {
        self.timings.set(key, value);
    }
}
