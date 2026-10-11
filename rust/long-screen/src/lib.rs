//! Long Screen as a native library: a screen recording in, one big screenshot out.
//!
//! [`run`] drives the same engine the web page runs (`long-screen-engine`), pass by pass and in the same order —
//! scan, solve, render, reveal, framing, preview pyramid — over a [`FrameSource`] (a video file decoded natively by
//! [`VideoSource`], or RGBA frames you already have). It keeps the rows the page would keep in IndexedDB in an
//! in-memory [`Store`], formats diagnostics with the page's own zh/en catalogue, reports progress and diagnostics
//! to an [`Observer`], and honours pause and stop through a [`Control`] between steps. The [`RunResult`] holds the
//! canvases (the print, its framed presentation and any separate fragments) as tiles, and writes any of them as a
//! PNG of any size, streamed band by band.
//!
//! The command-line tool `long-screen` (feature `cli`) is a thin layer over this crate; a desktop app or a Python
//! binding can drive it the same way.
//!
//! ```no_run
//! use long_screen::{run, Control, Options, VideoSource};
//! use long_screen_decode::Options as DecodeOptions;
//!
//! let mut source = VideoSource::open("recording.mov".as_ref(), DecodeOptions::default())?;
//! let control = Control::new(); // clone it to another thread to pause or stop the run
//! let mut on_progress = |p: &long_screen::Progress| eprintln!("{} {:.0}%", p.phase, p.fraction * 100.0);
//! let result = run(&mut source, &Options::default(), &mut on_progress, &control)?;
//! if let Some(print) = result.print() {
//!     let file = std::fs::File::create("print.png")?;
//!     result.write_png(&print.id, std::io::BufWriter::new(file))?;
//! }
//! for d in result.diagnostics() {
//!     eprintln!("{} {}: {}", d.severity, d.code, d.message);
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

mod context;
mod output;
mod present;
mod render;
mod reveal;
mod scan;
mod solve;
pub mod source;
pub mod store;
mod tiles;
pub mod value;
mod wasm_math;

use context::{t, Ctx};
pub use long_screen_engine::catalog::Locale;
pub use output::{CanvasInfo, RunResult};
pub use source::{Frame, FrameSource, MediaInfo, RawSource, SourceError, VideoSource};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
pub use store::Store;
use value::{Js, Obj};

/// How conflicting content (an area that changed while it was on screen) is resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemporalPolicy {
    /// Keep the first moment the area was seen whole (the page's default).
    Stable,
    /// Replace it with each later complete moment.
    Latest,
}

/// Whether the print is also shown inside the recording's own frame (chrome, toolbars).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    /// Also build a framed presentation canvas from the first frame (the page's default).
    Context,
    /// Only the reconstructed content.
    Region,
}

/// The run settings the page offers (`Settings` in src/types.ts), with its defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// Motion is analysed on frames scaled down so the longer side is at most this many pixels (default 640).
    pub analysis_size: u32,
    /// Working-memory budget of the tile cache, in MB (default 128).
    pub memory_mb: f64,
    /// Output tile side in pixels, a multiple of 16 (default 512).
    pub tile_size: u32,
    pub temporal_policy: TemporalPolicy,
    pub framing: Framing,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            analysis_size: 640,
            memory_mb: 128.0,
            tile_size: 512,
            temporal_policy: TemporalPolicy::Stable,
            framing: Framing::Context,
        }
    }
}

impl Settings {
    pub(crate) fn framing_context(&self) -> bool {
        self.framing == Framing::Context
    }

    pub(crate) fn stable(&self) -> bool {
        self.temporal_policy == TemporalPolicy::Stable
    }

    /// The `settings` object the project row persists, in the page's field order.
    fn to_js(&self) -> Obj {
        Obj::new()
            .with("analysisSize", self.analysis_size)
            .with("memoryMB", self.memory_mb)
            .with("tileSize", self.tile_size)
            .with("regions", Js::Arr(Vec::new()))
            .with(
                "temporalPolicy",
                if self.stable() { "stable" } else { "latest" },
            )
            .with("decoder", "precise")
            .with("compatibilityFPS", 60u32)
            .with(
                "framing",
                if self.framing_context() {
                    "context"
                } else {
                    "region"
                },
            )
            .with("compute", "cpu")
    }
}

/// Everything a run takes besides its source.
#[derive(Clone, Debug)]
pub struct Options {
    pub settings: Settings,
    /// The language of the diagnostics and progress messages the observer and the result show (default English).
    /// Persisted rows are always written in zh, as the page writes them.
    pub locale: Locale,
    /// Threads the kernels run on; `None` uses rayon's global pool (one per core).
    pub threads: Option<usize>,
    /// Keep encoded tiles in memory up to this many bytes, then move them to `spill_dir` (default: no limit).
    pub store_budget: Option<usize>,
    /// Where encoded tiles go past `store_budget` (default: a fresh directory under the system temp directory).
    pub spill_dir: Option<PathBuf>,
    /// The settings object to persist instead of the one `settings` describes (the parity harness replays the
    /// page's own).
    #[doc(hidden)]
    pub settings_row: Option<Obj>,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            settings: Settings::default(),
            locale: Locale::En,
            threads: None,
            store_budget: None,
            spill_dir: None,
            settings_row: None,
        }
    }
}

/// One progress event.
#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    /// `scanning`, `solving`, `optimizing`, `rendering`, `revealing`, `framing`, `pyramid`, then `complete` or
    /// `partial`.
    pub phase: String,
    /// 0…1 within the phase.
    pub fraction: f64,
    /// Frames done in the phase.
    pub frames: u32,
    /// Frames the container lists, when it lists them.
    pub total: Option<u64>,
    /// Seconds into the recording.
    pub time: f64,
    pub message: String,
    /// The canvas the event concerns, if any.
    pub canvas: Option<String>,
}

/// One diagnostic, in the run's display language.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub code: String,
    /// `info`, `warning` or `error`.
    pub severity: String,
    pub message: String,
    pub action: Option<String>,
    pub frame: Option<u32>,
    pub time: Option<f64>,
    pub canvas: Option<String>,
    /// How many times this code has fired so far in the run.
    pub occurrences: u32,
    /// The whole row (as the page stores it, but in the display language).
    pub row: Obj,
}

impl Diagnostic {
    pub(crate) fn from_row(row: Obj, occurrences: u32) -> Diagnostic {
        let num = |k: &str| row.get(k).map(Js::num).filter(|n| n.is_finite());
        Diagnostic {
            code: row.str("code").unwrap_or_default().to_string(),
            severity: row.str("severity").unwrap_or_default().to_string(),
            message: row.str("message").unwrap_or_default().to_string(),
            action: row.str("action").map(String::from),
            frame: num("frame").map(|f| f as u32),
            time: num("time"),
            canvas: row.str("canvasId").map(String::from),
            occurrences,
            row,
        }
    }
}

/// Receives a run's events on the run's thread. Both methods default to doing nothing.
pub trait Observer: Send {
    fn progress(&mut self, _progress: &Progress) {}
    fn diagnostic(&mut self, _diagnostic: &Diagnostic) {}
}

/// No events.
impl Observer for () {}

/// A closure observes progress only.
impl<F: FnMut(&Progress) + Send> Observer for F {
    fn progress(&mut self, progress: &Progress) {
        self(progress)
    }
}

/// Pause and stop for a running [`run`], from any thread. Clones share the same flags. A stop ends the current
/// pass at its next step and keeps what is done (the result is `partial`); a pause holds the run between steps.
#[derive(Clone, Debug, Default)]
pub struct Control {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

impl Control {
    pub fn new() -> Control {
        Control::default()
    }

    /// Asks the run to stop (and wakes it if paused).
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub(crate) fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub(crate) fn take_stop(&self) -> bool {
        self.stop.swap(false, Ordering::SeqCst)
    }
}

/// Why a run could not produce anything.
#[derive(Debug)]
pub enum Error {
    /// The settings cannot be used (for example a tile size that is not a multiple of 16).
    Settings(String),
    /// The thread pool could not be built.
    Threads(String),
    /// The run failed before any frame was rendered; the result's diagnostics say more.
    Failed {
        message: String,
        result: Box<RunResult>,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Settings(m) => write!(f, "invalid settings: {m}"),
            Error::Threads(m) => write!(f, "could not start the thread pool: {m}"),
            Error::Failed { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

/// A run id like the page's: unique, and not a word that occurs in any message.
fn run_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("n{:x}{:x}", nanos, std::process::id())
}

/// `new Date().toISOString()`.
fn iso_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (secs, millis) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + (month <= 2) as i64;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

/// Runs the whole reconstruction on `source`. Progress and diagnostics go to `observer` as they happen; `control`
/// pauses or stops the run from another thread. Returns the result even when the run ended `partial` (a stop, or a
/// failure after some frames were rendered); only a run that rendered nothing is an [`Error::Failed`].
pub fn run(
    source: &mut dyn FrameSource,
    options: &Options,
    observer: &mut dyn Observer,
    control: &Control,
) -> Result<RunResult, Error> {
    let s = &options.settings;
    if s.tile_size < 16 || !s.tile_size.is_multiple_of(16) {
        return Err(Error::Settings(
            "the tile size must be a positive multiple of 16".into(),
        ));
    }
    match options.threads {
        Some(n) => {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(n.max(1))
                .build()
                .map_err(|e| Error::Threads(e.to_string()))?;
            pool.install(|| run_in_pool(source, options, observer, control))
        }
        None => run_in_pool(source, options, observer, control),
    }
}

fn run_in_pool(
    source: &mut dyn FrameSource,
    options: &Options,
    observer: &mut dyn Observer,
    control: &Control,
) -> Result<RunResult, Error> {
    let store = match (options.store_budget, &options.spill_dir) {
        (Some(budget), dir) => {
            let dir = dir
                .clone()
                .unwrap_or_else(|| std::env::temp_dir().join(format!("long-screen-{}", run_id())));
            Store::spilling(dir, budget).map_err(|e| Error::Settings(e.to_string()))?
        }
        (None, _) => Store::in_memory(),
    };
    let settings_js = options
        .settings_row
        .clone()
        .unwrap_or_else(|| options.settings.to_js());
    let info = source.info().clone();
    let mut ctx = Ctx::new(
        info,
        observer,
        options.settings.clone(),
        settings_js,
        control.clone(),
        options.locale,
        store,
        rayon::current_num_threads(),
    )
    .map_err(Error::Settings)?;
    ctx.run_id = run_id();
    ctx.created = iso_now();
    let started = Instant::now();
    ctx.persist();
    startup_diagnostics(&mut ctx);
    let outcome = stages(&mut ctx, source);
    let failure = match outcome {
        Ok(()) => None,
        Err(message) => {
            handle_failure(&mut ctx, &message);
            Some(message)
        }
    };
    let result = RunResult::new(ctx, started.elapsed().as_secs_f64());
    match failure {
        Some(message) if result.rendered_frames() == 0 => Err(Error::Failed {
            message,
            result: Box::new(result),
        }),
        _ => Ok(result),
    }
}

/// The run's assumptions and inputs, before the first stage.
fn startup_diagnostics(ctx: &mut Ctx) {
    let noise = ctx.noise;
    let (mode, codec) = (ctx.info.mode.clone(), ctx.info.codec.clone());
    ctx.emit(&|l| {
        let margin = if noise != 0.0 {
            t(l, "diag.MODEL_ASSUMPTIONS.marginLossy", &[])
        } else {
            t(l, "diag.MODEL_ASSUMPTIONS.marginLossless", &[])
        };
        Obj::new()
            .with("code", "MODEL_ASSUMPTIONS")
            .with("severity", "info")
            .with(
                "message",
                t(
                    l,
                    "diag.MODEL_ASSUMPTIONS.message",
                    &[
                        ("noise", long_screen_engine::catalog::Param::Num(noise)),
                        ("margin", long_screen_engine::catalog::Param::Str(&margin)),
                    ],
                ),
            )
            .with("action", t(l, "diag.MODEL_ASSUMPTIONS.action", &[]))
            .with(
                "detail",
                Obj::new()
                    .with("noise", noise)
                    .with("lossless", noise == 0.0)
                    .with("source", mode.as_str())
                    .with("codec", codec.as_str()),
            )
    });
    if ctx.settings_js.str("decoder") == Some("compatibility") {
        let fps = ctx.settings_js.num("compatibilityFPS");
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "APPROXIMATE_DECODER")
                .with("severity", "warning")
                .with(
                    "message",
                    t(
                        l,
                        "diag.APPROXIMATE_DECODER.message",
                        &[("fps", long_screen_engine::catalog::Param::Num(fps))],
                    ),
                )
                .with("action", t(l, "diag.APPROXIMATE_DECODER.action", &[]))
        });
    }
    let size = ctx.settings.analysis_size;
    if ctx.info.width > size as usize || ctx.info.height > size as usize {
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "ANALYSIS_PYRAMID")
                .with("severity", "info")
                .with(
                    "message",
                    t(
                        l,
                        "diag.ANALYSIS_PYRAMID.message",
                        &[("size", long_screen_engine::catalog::Param::Int(size as i64))],
                    ),
                )
        });
    }
    for warning in ctx.info.warnings.clone() {
        ctx.emit(&|_| {
            Obj::new()
                .with("code", "MEDIA_NOTICE")
                .with("severity", "warning")
                .with("message", warning.as_str())
        });
    }
    let (w, h) = (ctx.info.width as f64, ctx.info.height as f64);
    if w * h * 4.0 * 4.0 > ctx.settings.memory_mb * 1024.0 * 1024.0 * 0.8 {
        ctx.emit(&|l| {
            Obj::new()
                .with("code", "FRAME_MEMORY_PRESSURE")
                .with("severity", "warning")
                .with("message", t(l, "diag.FRAME_MEMORY_PRESSURE.message", &[]))
                .with("action", t(l, "diag.FRAME_MEMORY_PRESSURE.action", &[]))
        });
    }
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// The stages in the page's order: scan, solve, render, reveal, framing, pyramid.
fn stages(ctx: &mut Ctx, source: &mut dyn FrameSource) -> Result<(), String> {
    let at = Instant::now();
    let features = scan::scan(ctx, source)?;
    ctx.timing("scanMS", ms(at));
    if ctx.frames == 0 {
        return Err(
            "No observations could be decoded. Nothing has been marked as reconstructed.".into(),
        );
    }
    let at = Instant::now();
    solve::solve(ctx, source, features)?;
    ctx.timing("solveMS", ms(at));
    let at = Instant::now();
    render::render(ctx, source)?;
    ctx.timing("renderMS", ms(at));
    reveal::reveal(ctx, source)?;
    let at = Instant::now();
    present::framing(ctx);
    ctx.timing("framingMS", ms(at));
    let at = Instant::now();
    ctx.phase = "pyramid";
    ctx.status = "pyramid";
    ctx.persist();
    present::pyramid(ctx);
    if ctx.stop_requested {
        ctx.partial = true;
        ctx.stop_requested = false;
    }
    ctx.timing("pyramidMS", ms(at));
    let stats = ctx.tiles.cache.stats();
    let mut performance = ctx.timings.clone();
    performance.set("exactDuplicateFrames", ctx.duplicates);
    performance.set("skippedPaints", ctx.skipped_paints);
    performance.set("tileEncodes", stats.encoded);
    performance.set("tileDecodes", stats.decoded);
    performance.set("tileEvictions", stats.evictions);
    performance.set(
        "compute",
        Obj::new()
            .with("backend", "cpu")
            .with("threads", ctx.threads),
    );
    performance.set("consistencyVotedLayers", ctx.voted_layers);
    performance.set("consistencyThinLayers", ctx.thin_layers);
    performance.set(
        "note",
        "Stage timings include decoding, storage and yields; not GPU-only kernel time.",
    );
    ctx.put("performance", performance);
    ctx.status = if ctx.partial { "partial" } else { "complete" };
    ctx.persist();
    let message = ctx.tr(
        if ctx.partial {
            "progress.runPartial"
        } else {
            "progress.runComplete"
        },
        &[],
    );
    let (status, rendered, duration) = (ctx.status, ctx.rendered_frames, ctx.info.duration);
    ctx.event(status, 1.0, rendered, duration, message);
    Ok(())
}

/// The page's top-level catch: keep what was committed, journal the failure.
fn handle_failure(ctx: &mut Ctx, message: &str) {
    ctx.status = if ctx.rendered_frames > 0 {
        "partial"
    } else {
        "error"
    };
    ctx.error = Some(message.to_string());
    let message = message.to_string();
    ctx.emit(&|l| {
        Obj::new()
            .with("code", "PROCESSING_ERROR")
            .with("severity", "error")
            .with("message", message.as_str())
            .with("action", t(l, "diag.RUN_FAILURE.action", &[]))
    });
    let run = ctx.key("");
    let _ = ctx.tiles.flush(&mut ctx.store, &run, None);
    ctx.persist();
}
