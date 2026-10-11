//! Fetches and checks the public test recordings, and decodes their benchmark windows into fixtures.
//!
//!   cases verify                    check every recording that is present against its pinned size and SHA-256
//!   cases fetch                     download the missing recordings (curl), then verify them all
//!   cases fixtures [--write-hashes] fetch, then decode each window with ffmpeg and check the fixture's SHA-256;
//!                                   `--write-hashes` records the hashes in cases.json instead (after changing a
//!                                   window or the extractor)
//!
//! `LONGSCREEN_CASES=/dir` reads the recordings from a directory that already holds them (nothing is downloaded);
//! `LONGSCREEN_FIXTURES=/dir` puts the fixtures somewhere other than rust/target/bench-fixtures;
//! `LONGSCREEN_CASES_URL=https://mirror/{file}` downloads from somewhere other than the release in cases.json.

use long_screen_bench::{
    cases_dir, fixtures_dir, manifest, manifest_path, sha256_file, span_path, Case, Manifest, Span,
    Window,
};
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("verify") => verify(&manifest(), false).map(|_| ()),
        Some("fetch") => verify(&manifest(), true).map(|_| ()),
        Some("fixtures") => fixtures(args.iter().any(|a| a == "--write-hashes")),
        _ => Err("usage: cases verify | fetch | fixtures [--write-hashes]".to_string()),
    };
    if let Err(message) = result {
        eprintln!("error: {message}");
        exit(1);
    }
}

fn recording_path(case: &Case) -> PathBuf {
    cases_dir().0.join(&case.file)
}

/// Checks every recording (downloading the missing ones first when `fetch`); returns their paths.
fn verify(m: &Manifest, fetch: bool) -> Result<Vec<PathBuf>, String> {
    let (dir, given) = cases_dir();
    let mut paths = Vec::new();
    let mut missing = Vec::new();
    for case in &m.cases {
        let path = recording_path(case);
        if !path.exists() {
            if fetch && !given {
                download(m, case, &path)?;
            } else {
                missing.push(case.file.clone());
                continue;
            }
        }
        check(case, &path)?;
        println!("ok  {}  {}", case.sha256, case.file);
        paths.push(path);
    }
    if !missing.is_empty() {
        return Err(format!(
            "{} recording(s) missing from {}: {}",
            missing.len(),
            dir.display(),
            missing.join(", ")
        ));
    }
    Ok(paths)
}

fn check(case: &Case, path: &Path) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();
    if size != case.bytes {
        return Err(format!(
            "{}: {size} bytes, expected {}",
            path.display(),
            case.bytes
        ));
    }
    let hash = sha256_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if hash != case.sha256 {
        return Err(format!(
            "{}: SHA-256 {hash}, expected {}",
            path.display(),
            case.sha256
        ));
    }
    Ok(())
}

fn download(m: &Manifest, case: &Case, path: &Path) -> Result<(), String> {
    let pattern = std::env::var("LONGSCREEN_CASES_URL").unwrap_or_else(|_| m.release.url.clone());
    let url = pattern.replace("{file}", &case.file);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let partial = path.with_extension("part");
    println!("get {url}");
    let status = Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--output",
        ])
        .arg(&partial)
        .arg(&url)
        .status()
        .map_err(|e| format!("cannot run curl: {e}"))?;
    if !status.success() {
        return Err(format!("download of {url} failed ({status})"));
    }
    check(case, &partial)?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

/// Decodes `case`'s window into `out`: the frames exactly as decoded (same pixel format, planes tightly packed),
/// counting every decoded frame because the recordings are variable frame rate.
fn extract(case: &Case, window: Window, video: &Path, out: &Path) -> Result<(), String> {
    let (start, end) = (window.start, window.start + window.count - 1);
    let status = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-y", "-i"])
        .arg(video)
        .args(["-map", "0:v:0", "-an", "-fps_mode", "passthrough", "-vf"])
        .arg(format!("select='between(n,{start},{end})'"))
        .args(["-frames:v", &window.count.to_string()])
        .args(["-pix_fmt", &case.pix_fmt, "-f", "rawvideo"])
        .arg(out)
        .status()
        .map_err(|e| format!("cannot run ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg failed on {} ({status})", video.display()));
    }
    let size = std::fs::metadata(out).map_err(|e| e.to_string())?.len() as usize;
    let expected = case.frame_bytes() * window.count as usize;
    if size != expected {
        return Err(format!(
            "{}: ffmpeg wrote {size} bytes, expected {expected} ({} frames)",
            case.id, window.count
        ));
    }
    Ok(())
}

/// Every fixture a case has: its kernel window, and its pipeline window when it has one.
fn spans(case: &Case) -> Vec<(Span, Window)> {
    [Span::Kernels, Span::Pipeline]
        .into_iter()
        .filter_map(|s| case.span(s).map(|w| (s, w)))
        .collect()
}

fn fixtures(write_hashes: bool) -> Result<(), String> {
    let mut m = manifest();
    std::fs::create_dir_all(fixtures_dir(&m)).map_err(|e| e.to_string())?;
    // A fixture already on disk with the pinned hash is reused without touching the recording, so a CI cache of
    // the fixtures needs no download at all.
    let ready = |m: &Manifest, case: &Case, span: Span| {
        let path = span_path(m, case, span);
        let pinned = case.span_sha256(span).cloned();
        pinned.is_some() && !write_hashes && path.exists() && sha256_file(&path).ok() == pinned
    };
    if m.cases
        .iter()
        .any(|c| spans(c).iter().any(|(s, _)| !ready(&m, c, *s)))
    {
        verify(&m, true)?;
    }
    let mut mismatched = Vec::new();
    for i in 0..m.cases.len() {
        let case = m.cases[i].clone();
        for (span, window) in spans(&case) {
            let path = span_path(&m, &case, span);
            if !ready(&m, &case, span) {
                extract(&case, window, &recording_path(&case), &path)?;
            }
            let hash = sha256_file(&path).map_err(|e| e.to_string())?;
            println!("fixture  {hash}  {}", path.display());
            match case.span_sha256(span) {
                _ if write_hashes => match span {
                    Span::Kernels => m.cases[i].fixture_sha256 = Some(hash),
                    Span::Pipeline => m.cases[i].pipeline_sha256 = Some(hash),
                },
                Some(expected) if *expected == hash => {}
                expected => mismatched.push(format!(
                    "{} {span:?}: {hash}, expected {}",
                    case.id,
                    expected.map_or("(none recorded)", |e| e.as_str())
                )),
            }
        }
    }
    if write_hashes {
        let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())? + "\n";
        std::fs::write(manifest_path(), text).map_err(|e| e.to_string())?;
        println!("recorded fixture hashes in {}", manifest_path().display());
    } else if !mismatched.is_empty() {
        // Another ffmpeg build decoding these windows differently would make the numbers incomparable with
        // earlier runs, so it stops here instead of benchmarking other bytes.
        return Err(format!(
            "fixture hashes differ from cases.json (another decoder?):\n  {}",
            mismatched.join("\n  ")
        ));
    }
    Ok(())
}
