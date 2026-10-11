//! The native-executable twin of `long_screen.reconstruct(video)._fingerprint()`: the same driver call with the
//! same defaults, run in an executable, so the two can be compared row by row with `scripts/compare-fingerprints.ts`.
//!
//!   cargo run --release -p long-screen-py --example fingerprint -- <video> <out.json>

use long_screen::{run, Control, Error, Options, VideoSource};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [video, out] = &args[..] else {
        eprintln!("usage: fingerprint <video> <out.json>");
        std::process::exit(2);
    };
    let path = std::path::Path::new(video);
    let mut source =
        VideoSource::open(path, long_screen_decode::Options::default()).expect("open the video");
    let result = match run(&mut source, &Options::default(), &mut (), &Control::new()) {
        Ok(r) => r,
        Err(Error::Failed { result, .. }) => *result,
        Err(e) => panic!("{e}"),
    };
    let (rows, project) = result.fingerprint();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let entry = serde_json::json!({
        name: {
            "rows": rows,
            "events": "",
            "project": project,
            "status": result.status(),
            "frames": result.frames(),
        }
    });
    std::fs::write(out, serde_json::to_string_pretty(&entry).unwrap()).unwrap();
    eprintln!(
        "{video}: {} rows, {}",
        result.store().len(),
        result.status()
    );
}
