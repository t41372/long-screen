//! `long-screen`: a screen recording in, one big screenshot out.
//!
//! Exit codes: 0 complete, 1 the run failed (nothing rendered), 2 bad arguments, 3 partial result (written, but
//! the run could not finish: stopped, a decode or storage failure, or a frame-count mismatch), 4 the video could
//! not be opened (no decoder for it, or ffmpeg missing where it is needed), 5 an output file could not be written.

use clap::{Parser, ValueEnum};
use long_screen::decode::{Backend as DecodeBackend, Options as DecodeOptions};
use long_screen::value::{to_json, Js, Obj};
use long_screen::{
    run, CanvasInfo, Control, Diagnostic, Error, Framing, Locale, Observer, Options, Progress,
    RunResult, Settings, TemporalPolicy, VideoSource,
};
use std::fs::File;
use std::io::{BufWriter, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Lang {
    En,
    Zh,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Backend {
    Auto,
    Avfoundation,
    Mediafoundation,
    Ffmpeg,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Policy {
    Stable,
    Latest,
}

/// Turns a screen recording of a page explored along any path into one big screenshot.
#[derive(Parser, Debug)]
#[command(name = "long-screen", version, about, long_about = None)]
struct Args {
    /// The recording (MP4, MOV, WebM, … whatever the decoder reads).
    video: PathBuf,
    /// Where to write the print, the canvas the web page shows first (default: <video name>.png in the current
    /// directory). Fragments the run could not place go next to it as <name>-fragment-<n>.png, in the page's order.
    #[arg(short, long, conflicts_with = "out_dir")]
    output: Option<PathBuf>,
    /// Write the print, its fragments and every other canvas into this directory instead.
    #[arg(long)]
    out_dir: Option<PathBuf>,
    /// A JSON report: status, diagnostics (codes, severities, messages, counts), canvases, timings.
    #[arg(long)]
    json: Option<PathBuf>,
    /// Language of messages.
    #[arg(long, value_enum, default_value = "en")]
    lang: Lang,
    /// Which decoder reads the video. `auto`: the system decoder (AVFoundation, Media Foundation), else ffmpeg.
    #[arg(long, value_enum, default_value = "auto")]
    backend: Backend,
    /// Kernel threads (default: one per core). Results do not depend on it.
    #[arg(long)]
    threads: Option<usize>,
    /// Tile-cache working memory in MB.
    #[arg(long, default_value_t = 128.0)]
    memory_mb: f64,
    /// Longer side of the frames motion is analysed on, in pixels.
    #[arg(long, default_value_t = 640)]
    analysis_size: u32,
    /// Output tile side in pixels (a multiple of 16).
    #[arg(long, default_value_t = 512)]
    tile_size: u32,
    /// How content that changed while on screen is resolved: keep its first complete moment, or the latest.
    #[arg(long, value_enum, default_value = "stable")]
    temporal_policy: Policy,
    /// Do not build the framed presentation (the print inside the recording's own window chrome).
    #[arg(long)]
    no_frame: bool,
    /// Keep encoded tiles in memory up to this many MB, then move them to a temporary directory.
    #[arg(long)]
    store_mb: Option<usize>,
    /// Print only errors.
    #[arg(short, long)]
    quiet: bool,
}

struct Terminal {
    quiet: bool,
    tty: bool,
    last: Instant,
    width: usize,
}

impl Terminal {
    fn clear(&mut self) {
        if self.tty && self.width > 0 {
            eprint!("\r{}\r", " ".repeat(self.width));
            self.width = 0;
        }
    }
}

impl Observer for Terminal {
    fn progress(&mut self, p: &Progress) {
        if self.quiet {
            return;
        }
        let now = Instant::now();
        let final_event = p.phase == "complete" || p.phase == "partial";
        if !final_event && now.duration_since(self.last).as_millis() < 250 {
            return;
        }
        self.last = now;
        let total = p.total.map_or(String::new(), |t| format!("/{t}"));
        let line = format!(
            "{:<10} {:>3.0}%  frame {}{}  {}",
            p.phase,
            (p.fraction * 100.0).clamp(0.0, 100.0),
            p.frames,
            total,
            p.message
        );
        if self.tty {
            self.clear();
            eprint!("{line}");
            self.width = line.chars().count();
            let _ = std::io::stderr().flush();
        } else {
            eprintln!("{line}");
        }
    }

    fn diagnostic(&mut self, d: &Diagnostic) {
        let show = match d.severity.as_str() {
            "error" => true,
            "warning" => !self.quiet && d.occurrences <= 3,
            _ => false,
        };
        if show {
            self.clear();
            let at = d.frame.map_or(String::new(), |f| format!(" (frame {f})"));
            eprintln!("{} {}{}: {}", d.severity, d.code, at, d.message);
        }
    }
}

fn write_canvas(
    result: &RunResult,
    canvas: &CanvasInfo,
    path: &Path,
) -> std::io::Result<(u32, u32)> {
    let file = BufWriter::new(File::create(path)?);
    result.write_png(&canvas.id, file)
}

fn file_name(c: &CanvasInfo) -> String {
    c.id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn report(
    args: &Args,
    result: &RunResult,
    written: &[(CanvasInfo, PathBuf, (u32, u32))],
    backend: &str,
) -> Js {
    let mut counts = Obj::new();
    for d in result.diagnostics() {
        let n = counts.num(&d.code);
        counts.set(&d.code, if n.is_nan() { 1.0 } else { n + 1.0 });
    }
    let items = result
        .diagnostics()
        .iter()
        .map(|d| {
            Js::Obj(
                Obj::new()
                    .with("code", d.code.as_str())
                    .with("severity", d.severity.as_str())
                    .with("message", d.message.as_str())
                    .with_opt("action", d.action.as_deref())
                    .with_opt("frame", d.frame)
                    .with_opt("time", d.time)
                    .with_opt("canvas", d.canvas.as_deref()),
            )
        })
        .collect();
    let canvases = result
        .canvases()
        .iter()
        .map(|c| {
            let file = written.iter().find(|(w, _, _)| w.id == c.id);
            Js::Obj(
                Obj::new()
                    .with("id", c.id.as_str())
                    .with("name", result.display_name(c))
                    .with("kind", c.kind.as_str())
                    .with("bounds", long_screen::value::rect(c.bounds))
                    .with("tiles", c.tile_count)
                    .with("observedPixels", c.observed_pixels)
                    .with_opt("attachedTo", c.attached_to.as_deref())
                    .with_opt("presents", c.presents.as_deref())
                    .with_opt("file", file.map(|(_, p, _)| p.display().to_string()))
                    .with_opt("width", file.map(|(_, _, s)| s.0))
                    .with_opt("height", file.map(|(_, _, s)| s.1)),
            )
        })
        .collect();
    let mut timings = Obj::new();
    if let Some(Js::Obj(p)) = result.get("performance") {
        for (k, v) in p.0 {
            if k.ends_with("MS") {
                timings.set(&k[..k.len() - 2], Js::Num((v.num() / 10.0).round() / 100.0));
            }
        }
    }
    let project = result.project();
    let media = project.get("media").and_then(Js::as_obj);
    Js::Obj(
        Obj::new()
            .with("tool", "long-screen")
            .with("version", env!("CARGO_PKG_VERSION"))
            .with("input", args.video.display().to_string())
            .with("decoder", backend)
            .with_opt("width", media.map(|m| m.num("width")))
            .with_opt("height", media.map(|m| m.num("height")))
            .with_opt(
                "frameCount",
                media.and_then(|m| m.get("frameCount").cloned()),
            )
            .with("status", result.status())
            .with_opt("error", result.error())
            .with("frames", result.frames())
            .with("renderedFrames", result.rendered_frames())
            .with("seconds", (result.seconds() * 100.0).round() / 100.0)
            .with("timingsSeconds", timings)
            .with("canvases", Js::Arr(canvases))
            .with(
                "diagnostics",
                Obj::new()
                    .with("counts", counts)
                    .with(
                        "severities",
                        project.get("severities").cloned().unwrap_or(Js::Undefined),
                    )
                    .with("items", Js::Arr(items)),
            ),
    )
}

fn main() -> ExitCode {
    let args = Args::parse();
    let decode = DecodeOptions::with_backend(match args.backend {
        Backend::Auto => DecodeBackend::Auto,
        Backend::Avfoundation => DecodeBackend::AvFoundation,
        Backend::Mediafoundation => DecodeBackend::MediaFoundation,
        Backend::Ffmpeg => DecodeBackend::Ffmpeg,
    });
    let mut source = match VideoSource::open(&args.video, decode) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("long-screen: cannot read {}: {e}", args.video.display());
            return ExitCode::from(4);
        }
    };
    let backend = source.video().backend.name().to_string();
    let options = Options {
        settings: Settings {
            analysis_size: args.analysis_size,
            memory_mb: args.memory_mb,
            tile_size: args.tile_size,
            temporal_policy: match args.temporal_policy {
                Policy::Stable => TemporalPolicy::Stable,
                Policy::Latest => TemporalPolicy::Latest,
            },
            framing: if args.no_frame {
                Framing::Region
            } else {
                Framing::Context
            },
        },
        locale: match args.lang {
            Lang::En => Locale::En,
            Lang::Zh => Locale::Zh,
        },
        threads: args.threads,
        store_budget: args.store_mb.map(|mb| mb * 1024 * 1024),
        ..Options::default()
    };
    let mut terminal = Terminal {
        quiet: args.quiet,
        tty: std::io::stderr().is_terminal(),
        last: Instant::now(),
        width: 0,
    };
    let control = Control::new();
    let outcome = run(&mut source, &options, &mut terminal, &control);
    terminal.clear();
    let (result, failed) = match outcome {
        Ok(r) => (r, None),
        Err(Error::Failed { message, result }) => (*result, Some(message)),
        Err(e) => {
            eprintln!("long-screen: {e}");
            return ExitCode::from(2);
        }
    };
    let stem = args
        .video
        .file_stem()
        .map_or("print".into(), |s| s.to_string_lossy().into_owned());
    let mut written = Vec::new();
    let mut write_error = false;
    if failed.is_none() {
        let mut targets: Vec<(CanvasInfo, PathBuf)> = Vec::new();
        if let Some(dir) = &args.out_dir {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("long-screen: cannot create {}: {e}", dir.display());
                return ExitCode::from(5);
            }
            let print = result.print();
            for c in result.canvases().into_iter().filter(|c| c.tile_count > 0) {
                let name = if print.as_ref().is_some_and(|p| p.id == c.id) {
                    "print".to_string()
                } else {
                    file_name(&c)
                };
                targets.push((c, dir.join(format!("{name}.png"))));
            }
        } else {
            let out = args
                .output
                .clone()
                .unwrap_or_else(|| PathBuf::from(format!("{stem}.png")));
            if let Some(print) = result.print() {
                targets.push((print, out.clone()));
            }
            let base = out.with_extension("");
            for (i, f) in result.fragments().into_iter().enumerate() {
                targets.push((
                    f,
                    PathBuf::from(format!("{}-fragment-{}.png", base.display(), i + 1)),
                ));
            }
        }
        for (canvas, path) in targets {
            match write_canvas(&result, &canvas, &path) {
                Ok(size) => {
                    if !args.quiet {
                        eprintln!(
                            "wrote {} ({}×{}, {})",
                            path.display(),
                            size.0,
                            size.1,
                            result.display_name(&canvas)
                        );
                    }
                    written.push((canvas, path, size));
                }
                Err(e) => {
                    eprintln!("long-screen: cannot write {}: {e}", path.display());
                    write_error = true;
                }
            }
        }
    }
    if let Some(path) = &args.json {
        let json = to_json(&report(&args, &result, &written, &backend));
        if let Err(e) = std::fs::write(path, json + "\n") {
            eprintln!("long-screen: cannot write {}: {e}", path.display());
            write_error = true;
        }
    }
    if let Some(message) = failed {
        eprintln!("long-screen: the run failed: {message}");
        return ExitCode::from(1);
    }
    if write_error {
        return ExitCode::from(5);
    }
    if !args.quiet {
        eprintln!(
            "{}: {} frames in {:.1} s",
            result.status(),
            result.frames(),
            result.seconds()
        );
    }
    if result.status() == "complete" {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}
