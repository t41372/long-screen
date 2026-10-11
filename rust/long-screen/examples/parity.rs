//! Parity harness: runs the native driver on the exact frames the web Engine gets and writes the fingerprint of
//! every persisted row, in the format of `scripts/fingerprint-scenarios.ts` (compare with
//! `scripts/compare-fingerprints.ts`).
//!
//!   cargo run -p long-screen --release --example parity -- scenarios <dir> <out.json> [scenario…]
//!     `<dir>` from `deno run -A scripts/native-parity.ts export <dir>`.
//!   cargo run -p long-screen --release --example parity -- recording <video> <out.json>
//!     Decodes with ffmpeg exactly as `scripts/native-parity.ts recording` does.

use long_screen::source::{Frame, FrameSource, Frames, MediaInfo, RawFrame, SourceError};
use long_screen::value::{Js, Obj};
use long_screen::{run, Control, Framing, Options, RawSource, Settings, TemporalPolicy};
use long_screen_core::yuv::hdr::{rgb_to_rgba, Packing, Transfer};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn settings_of(row: &Obj) -> Settings {
    let d = Settings::default();
    let num = |k: &str, v: f64| {
        row.get(k)
            .map(Js::num)
            .filter(|n| n.is_finite())
            .unwrap_or(v)
    };
    Settings {
        analysis_size: num("analysisSize", d.analysis_size as f64) as u32,
        memory_mb: num("memoryMB", d.memory_mb),
        tile_size: num("tileSize", d.tile_size as f64) as u32,
        temporal_policy: if row.str("temporalPolicy") == Some("latest") {
            TemporalPolicy::Latest
        } else {
            TemporalPolicy::Stable
        },
        framing: if row.str("framing") == Some("region") {
            Framing::Region
        } else {
            Framing::Context
        },
    }
}

fn fingerprint_entry(
    source: &mut dyn FrameSource,
    settings_row: Option<Obj>,
    threads: Option<usize>,
) -> Value {
    let mut options = Options::default();
    if let Some(row) = &settings_row {
        options.settings = settings_of(row);
    }
    options.settings_row = settings_row;
    options.threads = threads;
    let started = std::time::Instant::now();
    let result = match run(source, &options, &mut (), &Control::new()) {
        Ok(r) => r,
        Err(long_screen::Error::Failed { result, .. }) => *result,
        Err(e) => panic!("{e}"),
    };
    if let Ok(pattern) = std::env::var("LONGSCREEN_DUMP") {
        let run = result.project().str("id").unwrap_or_default().to_string();
        for (key, _) in result.store().iter() {
            if key.contains(&pattern) {
                let mut v = result.store().get(key).unwrap();
                if std::env::var("RAW").is_ok() {
                    if let Js::Obj(o) = &mut v {
                        for (_, x) in o.0.iter_mut() {
                            if let Js::Typed(kind, b) = x {
                                let values: Vec<Js> = match kind {
                                    long_screen::value::Typed::Uint32 => {
                                        b.chunks_exact(4)
                                            .map(|c| {
                                                Js::Num(u32::from_le_bytes(c.try_into().unwrap())
                                                    as f64)
                                            })
                                            .collect()
                                    }
                                    _ => b.iter().map(|&c| Js::Num(c as f64)).collect(),
                                };
                                *x = Js::Arr(values);
                            }
                        }
                    }
                }
                println!(
                    "{key}\n{}",
                    long_screen::value::to_json(&long_screen::value::canonical(&v, &run))
                );
            }
        }
    }
    let (rows, project) = result.fingerprint();
    serde_json::json!({
        "rows": rows,
        "events": "",
        "project": project,
        "seconds": (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "status": result.status(),
        "frames": result.frames(),
    })
}

/// RGBA frames from ffmpeg, as the web harness reads them.
struct Ffmpeg {
    path: PathBuf,
    width: usize,
    height: usize,
    transfer: Option<Transfer>,
    times: Vec<f64>,
    info: MediaInfo,
}

fn probe(args: &[&str]) -> String {
    let out = Command::new("ffprobe")
        .args(args)
        .output()
        .expect("ffprobe");
    String::from_utf8(out.stdout).unwrap()
}

impl Ffmpeg {
    fn open(path: &Path) -> Ffmpeg {
        let p = path.to_str().unwrap();
        let stream: Value = serde_json::from_str(&probe(&[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name,color_transfer:format=duration",
            "-of",
            "json",
            p,
        ]))
        .unwrap();
        let s = &stream["streams"][0];
        let (width, height) = (
            s["width"].as_u64().unwrap() as usize,
            s["height"].as_u64().unwrap() as usize,
        );
        let transfer = match s["color_transfer"].as_str() {
            Some("smpte2084") => Some(Transfer::Pq),
            Some("arib-std-b67") => Some(Transfer::Hlg),
            _ => None,
        };
        let mut times: Vec<f64> = probe(&[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time",
            "-of",
            "csv=p=0",
            p,
        ])
        .trim()
        .lines()
        .map(|l| l.trim().parse::<f64>().unwrap_or(f64::NAN))
        .collect();
        times.sort_by(|a, b| a.total_cmp(b));
        let duration: f64 = stream["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0);
        let js = Obj::new()
            .with("name", path.file_name().unwrap().to_str().unwrap())
            .with("size", std::fs::metadata(path).unwrap().len())
            .with("width", width)
            .with("height", height)
            .with("codedWidth", width)
            .with("codedHeight", height)
            .with("rotation", 0u32)
            .with("duration", duration)
            .with("frameCount", times.len())
            .with("codec", s["codec_name"].as_str().unwrap_or_default())
            .with("mode", "ffmpeg (parity)")
            .with("noise", 10u32)
            .with("warnings", Js::Arr(vec![]))
            .with("notices", Js::Arr(vec![]));
        Ffmpeg {
            path: path.to_path_buf(),
            width,
            height,
            transfer,
            times,
            info: MediaInfo::from_js(js),
        }
    }
}

impl FrameSource for Ffmpeg {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        let mut args: Vec<String> = vec![
            "-v".into(),
            "error".into(),
            "-i".into(),
            self.path.to_str().unwrap().into(),
        ];
        if self.transfer.is_some() {
            args.extend([
                "-vf".into(),
                "scale=in_color_matrix=bt2020:in_range=tv:out_range=pc".into(),
            ]);
        }
        args.extend(
            [
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ]
            .map(String::from),
        );
        let mut child = Command::new("ffmpeg")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| SourceError(e.to_string()))?;
        let mut stdout = child.stdout.take().unwrap();
        let (w, h, transfer) = (self.width, self.height, self.transfer);
        let times = self.times.clone();
        let mut index = 0usize;
        Ok(Box::new(std::iter::from_fn(move || {
            let mut rgba = vec![0u8; w * h * 4];
            if stdout.read_exact(&mut rgba).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            if let Some(t) = transfer {
                rgb_to_rgba(&mut rgba, Packing::Rgba8, w, h, t);
            }
            let time = times.get(index).copied().unwrap_or(index as f64 / 60.0);
            let next = times.get(index + 1).copied().unwrap_or(time + 1.0 / 60.0);
            let frame = Frame {
                index: index as u32,
                time,
                duration: next - time,
                width: w,
                height: h,
                rgba,
            };
            index += 1;
            Some(Ok(frame))
        })))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let threads = std::env::var("LONGSCREEN_NATIVE_THREADS")
        .ok()
        .and_then(|t| t.parse().ok());
    let mut out = serde_json::Map::new();
    match args.first().map(String::as_str) {
        Some("scenarios") => {
            let dir = PathBuf::from(&args[1]);
            let mut names: Vec<String> = args[3..].to_vec();
            if names.is_empty() {
                // fingerprint-scenarios.ts's order: the export's own order is not kept by the file system.
                names = std::fs::read_dir(&dir)
                    .unwrap()
                    .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                    .collect();
                names.sort();
            }
            for name in names {
                let meta: Value = serde_json::from_str(
                    &std::fs::read_to_string(dir.join(&name).join("meta.json")).unwrap(),
                )
                .unwrap();
                let Js::Obj(info) = Js::from_json(&meta["info"]) else {
                    panic!()
                };
                let Js::Obj(settings) = Js::from_json(&meta["settings"]) else {
                    panic!()
                };
                let frames = meta["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| RawFrame {
                        time: f[0].as_f64().unwrap(),
                        duration: f[1].as_f64().unwrap(),
                        width: f[2].as_u64().unwrap() as usize,
                        height: f[3].as_u64().unwrap() as usize,
                    })
                    .collect();
                let mut source = RawSource::new(
                    dir.join(&name).join("frames.rgba"),
                    frames,
                    MediaInfo::from_js(info),
                );
                let entry = fingerprint_entry(&mut source, Some(settings), threads);
                eprintln!(
                    "{name}: {} rows, {}s",
                    entry["rows"].as_object().unwrap().len(),
                    entry["seconds"]
                );
                out.insert(name, entry);
            }
        }
        Some("recording") => {
            let path = PathBuf::from(&args[1]);
            let mut source = Ffmpeg::open(&path);
            let entry = fingerprint_entry(&mut source, None, threads);
            eprintln!(
                "{}: {} rows, {}, {}s",
                path.display(),
                entry["rows"].as_object().unwrap().len(),
                entry["status"],
                entry["seconds"]
            );
            out.insert(
                path.file_name().unwrap().to_string_lossy().into_owned(),
                entry,
            );
        }
        _ => {
            eprintln!("usage: parity scenarios <dir> <out.json> [scenario…] | recording <video> <out.json>");
            std::process::exit(2);
        }
    }
    std::fs::write(
        &args[2],
        serde_json::to_string_pretty(&Value::Object(out)).unwrap(),
    )
    .unwrap();
}
