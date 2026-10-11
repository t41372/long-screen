//! Prints what a backend reads from a video: its info, then one line per frame (index, timestamp in seconds, and a
//! checksum of the planes), and the decode rate.
//!
//! cargo run --release -p long-screen-decode --example probe -- <file> [auto|ffmpeg|avfoundation|mediafoundation] [--quiet]

use long_screen_decode::{open, Backend, Frame, Options};
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: probe <file> [auto|ffmpeg|avfoundation|mediafoundation] [--quiet]");
        std::process::exit(2);
    };
    let backend = args
        .get(1)
        .filter(|a| !a.starts_with("--"))
        .map(|name| Backend::parse(name).unwrap_or_else(|| panic!("unknown backend {name}")))
        .unwrap_or(Backend::Auto);
    let quiet = args.iter().any(|a| a == "--quiet");
    let started = Instant::now();
    let mut decoder = match open(Path::new(path), &Options::with_backend(backend)) {
        Ok(decoder) => decoder,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    println!("{:#?}", decoder.info());
    let mut frame = Frame::default();
    let mut count = 0u64;
    loop {
        match decoder.read_frame(&mut frame) {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) => {
                eprintln!("frame {count}: {error}");
                std::process::exit(1);
            }
        }
        count += 1;
        if !quiet {
            // FNV-1a over the planes, enough to compare backends frame by frame.
            let hash = frame.data.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
                (h ^ b as u64).wrapping_mul(0x0100_0000_01b3)
            });
            println!("{} {:.6} {hash:016x}", frame.index, frame.timestamp);
        }
    }
    let seconds = started.elapsed().as_secs_f64();
    eprintln!(
        "{count} frames in {seconds:.2} s ({:.1} frames/s) with {}",
        count as f64 / seconds,
        decoder.info().backend.name()
    );
}
