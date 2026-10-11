//! End-to-end checks of every backend this system has, against ffprobe and against each other.
//!
//! Synthetic clips are made with the installed ffmpeg (tests skip without it). Real recordings are read from
//! `LONGSCREEN_CASES` (the `test_case/public_test_cases` directory of the main checkout); those tests skip when it is
//! unset. What could go wrong, and the test that catches it:
//! - a frame duplicated or dropped to reach a constant rate → `vfr_*`, `real_*` (counts and timestamps vs ffprobe);
//! - frames out of presentation order (B-frames) → `vfr_*` (strictly increasing, exact times);
//! - colour tags, depth or layout misread → `real_tags_*`;
//! - rotation ignored or turned the wrong way → `rotation_*`;
//! - backends disagreeing on pixels or timing → `*_backends_agree`;
//! - ffmpeg missing → `missing_ffmpeg_*`; a file the system decoder rejects → `auto_falls_back_*`.

use long_screen_decode::{
    open, Backend, Decoder, Error, Frame, Matrix, Options, PixelFormat, Transfer,
};
use std::path::{Path, PathBuf};
use std::process::Command;

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
        && Command::new("ffprobe")
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
}

fn system_backends() -> Vec<Backend> {
    [Backend::AvFoundation, Backend::MediaFoundation]
        .into_iter()
        .filter(|b| b.available())
        .collect()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("long-screen-decode-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn ffmpeg(args: &[&str]) {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "ffmpeg {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Frame times of the VFR clip: steps of 1/30 s with an extra half step after every third frame.
fn vfr_times(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| (i as f64 + (i / 3) as f64 * 0.5) / 30.0)
        .collect()
}

/// A 45-frame H.264 clip with B-frames and irregular frame times (multiples of 1/60 s, timescale 600).
fn vfr_clip() -> PathBuf {
    let path = scratch("vfr.mp4");
    if !path.exists() {
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=30",
            "-frames:v",
            "45",
            // The encoder's time base must hold half steps, or it rounds them back onto a 1/30 s grid.
            "-vf",
            "settb=1/600,setpts=(N+floor(N/3)*0.5)/30/TB",
            "-fps_mode",
            "passthrough",
            "-enc_time_base",
            "1/600",
            "-c:v",
            "libx264",
            "-bf",
            "3",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "600",
            path.to_str().unwrap(),
        ]);
    }
    path
}

fn decode_all(path: &Path, backend: Backend) -> (Box<dyn Decoder>, Vec<Frame>) {
    let mut decoder =
        open(path, &Options::with_backend(backend)).unwrap_or_else(|e| panic!("{backend:?}: {e}"));
    let mut frames = Vec::new();
    while let Some(frame) = decoder
        .next_frame()
        .unwrap_or_else(|e| panic!("{backend:?}: {e}"))
    {
        frames.push(frame);
    }
    (decoder, frames)
}

/// Every frame's time from ffprobe (decoding the file): seconds after the first frame, in output order.
fn ffprobe_times(path: &Path) -> Vec<f64> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "V:0",
            "-show_entries",
            "frame=pts:stream=time_base",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let tb = json["streams"][0]["time_base"].as_str().unwrap();
    let (n, d) = tb.split_once('/').unwrap();
    let (n, d): (f64, f64) = (n.parse().unwrap(), d.parse().unwrap());
    let pts: Vec<i64> = json["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["pts"].as_i64().unwrap())
        .collect();
    pts.iter().map(|p| (p - pts[0]) as f64 * n / d).collect()
}

fn assert_times(frames: &[Frame], expected: &[f64], what: &str) {
    assert_eq!(frames.len(), expected.len(), "{what}: frame count");
    for (i, (f, t)) in frames.iter().zip(expected).enumerate() {
        assert_eq!(f.index, i as u64, "{what}: index");
        assert!(
            (f.timestamp - t).abs() < 1e-6,
            "{what}: frame {i} at {} s, expected {t} s",
            f.timestamp
        );
        if i > 0 {
            assert!(
                f.timestamp > frames[i - 1].timestamp,
                "{what}: frame {i} not after frame {}",
                i - 1
            );
        }
    }
}

/// Sample `i` of plane `p` (0 Y, 1 U, 2 V) as a 10-bit value, whatever the layout.
fn sample(f: &Frame, p: usize, x: usize, y: usize) -> u16 {
    let format = f.format.unwrap();
    let (plane, index) = match (p, format.semi_planar()) {
        (0, _) => (0, x),
        (c, true) => (1, x * 2 + c - 1),
        (c, false) => (c, x),
    };
    let b = format.sample_bytes();
    let off = f.planes[plane].offset + y * f.planes[plane].stride + index * b;
    match format {
        PixelFormat::I420 | PixelFormat::Nv12 => (f.data[off] as u16) << 2,
        PixelFormat::I420P10 => u16::from_le_bytes([f.data[off], f.data[off + 1]]),
        PixelFormat::P010 => u16::from_le_bytes([f.data[off], f.data[off + 1]]) >> 6,
    }
}

/// (max, mean) absolute difference over every sample of two frames, in 10-bit units.
fn pixel_diff(a: &Frame, b: &Frame) -> (u16, f64) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let (mut max, mut sum, mut n) = (0u16, 0u64, 0u64);
    for p in 0..3 {
        let (w, h) = if p == 0 {
            (a.width, a.height)
        } else {
            (a.width.div_ceil(2), a.height.div_ceil(2))
        };
        for y in 0..h {
            for x in 0..w {
                let d = sample(a, p, x, y).abs_diff(sample(b, p, x, y));
                max = max.max(d);
                sum += d as u64;
                n += 1;
            }
        }
    }
    (max, sum as f64 / n as f64)
}

/// Decodes `path` with ffmpeg and every system backend; checks they agree on count, timing and (every `step`th frame)
/// pixels. Returns the worst (max, mean) difference seen, for the report.
fn backends_agree(path: &Path, step: usize) -> Option<(u16, f64)> {
    let (_, reference) = decode_all(path, Backend::Ffmpeg);
    let mut worst: Option<(u16, f64)> = None;
    for backend in system_backends() {
        let (decoder, frames) = decode_all(path, backend);
        let times: Vec<f64> = reference.iter().map(|f| f.timestamp).collect();
        assert_times(
            &frames,
            &times,
            &format!("{backend:?} vs ffmpeg on {}", path.display()),
        );
        for (a, b) in reference.iter().zip(&frames).step_by(step) {
            let (max, mean) = pixel_diff(a, b);
            let w = worst.get_or_insert((0, 0.0));
            *w = (w.0.max(max), w.1.max(mean));
        }
        let (max, mean) = worst.unwrap();
        eprintln!("{}: {backend:?} vs ffmpeg — {} frames, max diff {max}, worst mean {mean:.4} (10-bit units)",
            path.file_name().unwrap().to_string_lossy(), frames.len());
        assert!(
            max <= 4,
            "{backend:?} differs from ffmpeg by {max} on {}",
            path.display()
        );
        assert_eq!(
            decoder.info().rotation,
            open(path, &Options::with_backend(Backend::Ffmpeg))
                .unwrap()
                .info()
                .rotation
        );
    }
    worst
}

#[test]
fn vfr_clip_keeps_every_frame_and_its_time_on_every_backend() {
    if !have_ffmpeg() {
        eprintln!("skipped: no ffmpeg");
        return;
    }
    let clip = vfr_clip();
    // The container's times are the truth (the muxer moves some by a tick of its 1/600 s timescale); check they are
    // the irregular ones asked for, and that every backend returns exactly them.
    let expected = ffprobe_times(&clip);
    assert_eq!(expected.len(), 45);
    for (got, asked) in expected.iter().zip(vfr_times(45)) {
        assert!(
            (got - asked).abs() <= 2.0 / 600.0 + 1e-9,
            "{got} vs {asked}"
        );
    }
    let steps: Vec<f64> = expected.windows(2).map(|w| w[1] - w[0]).collect();
    assert!(
        steps.iter().any(|s| *s > 1.3 / 30.0),
        "the clip must be variable frame rate: {steps:?}"
    );
    for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
        let (decoder, frames) = decode_all(&clip, backend);
        assert_times(&frames, &expected, backend.name());
        let info = decoder.info();
        assert_eq!(
            (info.width, info.height, info.rotation, info.bit_depth),
            (320, 240, 0, 8)
        );
        assert_eq!(info.codec, "h264");
        for f in &frames {
            assert_eq!(f.data.len(), info.format.frame_bytes(320, 240));
        }
    }
}

/// The VFR clip with its edit list narrowed by one frame at each end. ffmpeg's muxer writes one edit starting at the
/// first frame's composition time (40 ticks of 1/600 s, the B-frame delay) and lasting to the end of the last frame;
/// here it starts at the second frame (60) and ends exactly where the last frame starts (1059), so the first frame is
/// decoded (the others depend on it) but not shown, and the last one is not shown either. Container samples: 45.
fn trimmed_clip() -> PathBuf {
    let path = scratch("trimmed.mp4");
    if !path.exists() {
        let mut bytes = std::fs::read(vfr_clip()).unwrap();
        let at = bytes
            .windows(4)
            .position(|w| w == b"elst")
            .expect("the muxer writes an edit list for a B-frame clip");
        let entry = at + 12; // type, version and flags, entry count
        let (version, count) = (bytes[at + 4], &bytes[at + 8..at + 12]);
        assert_eq!(
            (version, count),
            (0, &[0, 0, 0, 1][..]),
            "one version-0 edit"
        );
        let media_time = i32::from_be_bytes(bytes[entry + 4..entry + 8].try_into().unwrap());
        assert_eq!(
            media_time, 40,
            "the clip's B-frame delay, in its 1/600 s timescale"
        );
        // The movie timescale is ffmpeg's default 1000: 999 media ticks (60 → 1059) are 1665 movie ticks exactly.
        bytes[entry..entry + 4].copy_from_slice(&1665u32.to_be_bytes());
        bytes[entry + 4..entry + 8].copy_from_slice(&60i32.to_be_bytes());
        std::fs::write(&path, bytes).unwrap();
    }
    path
}

#[test]
fn an_edit_list_trim_is_counted_the_way_each_backend_presents_it() {
    if !have_ffmpeg() {
        eprintln!("skipped: no ffmpeg");
        return;
    }
    let clip = trimmed_clip();
    let shown = ffprobe_times(&clip);
    assert_eq!(
        shown.len(),
        43,
        "ffprobe shows the 43 frames inside the edit"
    );
    for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
        let (decoder, frames) = decode_all(&clip, backend);
        assert_eq!(
            frames.len(),
            43,
            "{backend:?} decodes the frames inside the edit"
        );
        assert_eq!(
            decoder.info().frame_count,
            Some(43),
            "{backend:?} expects the frames it presents, not the 45 samples the container lists"
        );
    }
    // Untrimmed, every sample is presented and expected.
    for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
        let (decoder, frames) = decode_all(&vfr_clip(), backend);
        assert_eq!(
            (frames.len(), decoder.info().frame_count),
            (45, Some(45)),
            "{backend:?}"
        );
    }
}

#[test]
fn vfr_clip_backends_agree() {
    if !have_ffmpeg() {
        return;
    }
    if let Some((max, _)) = backends_agree(&vfr_clip(), 1) {
        assert_eq!(
            max, 0,
            "H.264 decoding is bit-exact across conforming decoders"
        );
    }
}

#[test]
fn rotation_metadata_is_reported_clockwise_and_frames_stay_coded() {
    if !have_ffmpeg() {
        return;
    }
    let rotated = scratch("rotated.mp4");
    // `-display_rotation 90` stores a quarter turn counter-clockwise: shown upright, the frames turn 270° clockwise.
    ffmpeg(&[
        "-display_rotation",
        "90",
        "-i",
        vfr_clip().to_str().unwrap(),
        "-c",
        "copy",
        rotated.to_str().unwrap(),
    ]);
    for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
        let (decoder, frames) = decode_all(&rotated, backend);
        let info = decoder.info();
        assert_eq!(info.rotation, 270, "{backend:?}");
        assert_eq!(
            (info.width, info.height),
            (320, 240),
            "{backend:?}: frames keep their coded size"
        );
        assert_eq!(info.display_size(), (240, 320));
        assert_eq!(frames.len(), 45);
    }
}

#[test]
fn missing_ffmpeg_is_reported_with_an_install_hint() {
    if !have_ffmpeg() {
        return;
    }
    let options = Options {
        backend: Backend::Ffmpeg,
        ffmpeg: Some("/nonexistent/ffmpeg".into()),
        ffprobe: None,
    };
    match open(&vfr_clip(), &options) {
        Err(Error::ToolMissing { tool, hint }) => {
            assert_eq!(tool, "/nonexistent/ffmpeg");
            assert!(hint.contains("ffmpeg"), "{hint}");
        }
        other => panic!("{:?}", other.err()),
    }
}

#[test]
fn auto_uses_the_system_decoder_and_falls_back_to_ffmpeg() {
    if !have_ffmpeg() {
        return;
    }
    let (decoder, _) = decode_all(&vfr_clip(), Backend::Auto);
    let expected = system_backends()
        .first()
        .copied()
        .unwrap_or(Backend::Ffmpeg);
    assert_eq!(decoder.info().backend, expected);
    // A Matroska file: AVFoundation and Media Foundation do not read the container, ffmpeg does.
    let mkv = scratch("clip.mkv");
    ffmpeg(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=10",
        "-frames:v",
        "12",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        mkv.to_str().unwrap(),
    ]);
    let (decoder, frames) = decode_all(&mkv, Backend::Auto);
    assert_eq!(frames.len(), 12, "via {:?}", decoder.info().backend);
    eprintln!("auto read clip.mkv with {:?}", decoder.info().backend);
}

// ---- Real recordings ------------------------------------------------------------------------------------------

fn case(name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("LONGSCREEN_CASES")?;
    let path = Path::new(&dir).join(name);
    if !path.is_file() || !have_ffmpeg() {
        eprintln!("skipped: {name} not found under LONGSCREEN_CASES");
        return None;
    }
    Some(path)
}

const REAL: [&str; 3] = [
    "test_1_sdr_desktop_basic_anypath.mov",
    "test_3_hdr_desktop_vertical.mov",
    "test_6_iphone_safari.MP4",
];

#[test]
fn real_recordings_decode_every_frame_ffprobe_decodes_at_its_time() {
    for name in REAL {
        let Some(path) = case(name) else { continue };
        let expected = ffprobe_times(&path);
        for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
            let mut decoder = open(&path, &Options::with_backend(backend)).unwrap();
            let mut frame = Frame::default();
            let mut times = Vec::new();
            while decoder.read_frame(&mut frame).unwrap() {
                times.push(frame.timestamp);
            }
            assert_eq!(times.len(), expected.len(), "{name} with {backend:?}");
            for (i, (t, e)) in times.iter().zip(&expected).enumerate() {
                assert!(
                    (t - e).abs() < 1e-6,
                    "{name} {backend:?} frame {i}: {t} vs {e}"
                );
                assert!(
                    i == 0 || *t > times[i - 1],
                    "{name} {backend:?}: frame {i} not after the previous one"
                );
            }
            eprintln!(
                "{name}: {backend:?} decoded {} frames (container lists {:?})",
                times.len(),
                decoder.info().frame_count
            );
        }
    }
}

/// Every public case, with the frames ffmpeg and AVFoundation present. Five of them (test_4 to test_8) list one sample
/// more than ffmpeg presents, at the end of the track's single edit: test_4, test_6 and test_7's starts exactly where
/// the edit ends and test_5's after it, so neither backend presents it; test_8's starts a hundredth of a tick before
/// the end, which AVFoundation presents and ffmpeg, rounding the end to a whole tick, does not.
const ALL: [&str; 8] = [
    "test_1_sdr_desktop_basic_anypath.mov",
    "test_2_sdr_desktop_gpt_scroll_with_floating.mov",
    "test_3_hdr_desktop_vertical.mov",
    "test_4_hdr_monalisa.mov",
    "test_5_hdr_image.mov",
    "test_6_iphone_safari.MP4",
    "test_7_iphone_chatgpt.MP4",
    "test_8_iphone_signal.MP4",
];

#[test]
fn real_recordings_expect_the_frames_each_backend_presents() {
    for name in ALL {
        let Some(path) = case(name) else { continue };
        for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
            let mut decoder = open(&path, &Options::with_backend(backend)).unwrap();
            let expected = decoder.info().frame_count;
            let mut frame = Frame::default();
            let mut decoded = 0u64;
            while decoder.read_frame(&mut frame).unwrap() {
                decoded += 1;
            }
            eprintln!("{name}: {backend:?} expects {expected:?}, decoded {decoded}");
            assert_eq!(expected, Some(decoded), "{name} with {backend:?}");
        }
    }
}

#[test]
fn real_tags_sdr_h264_and_hdr_hevc() {
    if let Some(path) = case("test_1_sdr_desktop_basic_anypath.mov") {
        for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
            let info = open(&path, &Options::with_backend(backend))
                .unwrap()
                .info()
                .clone();
            assert_eq!(
                (info.width, info.height, info.rotation, info.bit_depth),
                (3456, 2234, 0, 8),
                "{backend:?}"
            );
            assert_eq!(info.codec, "h264");
            assert_eq!(info.colour.transfer, Transfer::Sdr);
            assert_eq!(info.colour.matrix, Some(Matrix::Bt709));
            assert!(!info.colour.full_range);
            assert_eq!(info.format.bit_depth(), 8);
            assert_eq!(info.colour.core_code(info.height), 0);
        }
    }
    if let Some(path) = case("test_6_iphone_safari.MP4") {
        for backend in std::iter::once(Backend::Ffmpeg).chain(system_backends()) {
            let info = open(&path, &Options::with_backend(backend))
                .unwrap()
                .info()
                .clone();
            assert_eq!(
                (info.width, info.height, info.rotation, info.bit_depth),
                (1320, 2868, 0, 10),
                "{backend:?}"
            );
            assert_eq!(info.codec, "hevc");
            assert_eq!(info.colour.transfer, Transfer::Pq);
            assert_eq!(info.colour.matrix, Some(Matrix::Bt2020));
            assert!(!info.colour.full_range);
            assert_eq!(info.format.bit_depth(), 10);
            assert_eq!(info.colour.core_code(info.height), 8 + 4);
        }
    }
}

#[test]
fn real_recordings_backends_agree() {
    for (name, step) in [
        ("test_1_sdr_desktop_basic_anypath.mov", 25),
        ("test_6_iphone_safari.MP4", 10),
    ] {
        if let Some(path) = case(name) {
            backends_agree(&path, step);
        }
    }
}
