//! The ffmpeg backend: `ffprobe` for the stream's metadata, then `ffmpeg` decoding the first video track to raw 4:2:0
//! planes on its stdout. `-fps_mode passthrough` keeps one output frame per decoded frame (the default would duplicate
//! frames of a variable-frame-rate recording to a constant rate), `-noautorotate` keeps the coded orientation (the
//! rotation is reported instead, as the system backends do), and a `showinfo` filter prints every frame's timestamp on
//! stderr, which a reader thread pairs with the frames in order.

use crate::{
    install_hint, normalise_rotation, pack_layout, Backend, Colour, Decoder, Error, Frame, Matrix,
    Options, PixelFormat, Primaries, Transfer, VideoInfo,
};
use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

#[derive(Deserialize, Default)]
struct Probe {
    #[serde(default)]
    streams: Vec<Stream>,
    format: Option<Format>,
}

#[derive(Deserialize, Default)]
struct Format {
    duration: Option<String>,
}

#[derive(Deserialize, Default)]
struct Stream {
    codec_name: Option<String>,
    width: Option<usize>,
    height: Option<usize>,
    pix_fmt: Option<String>,
    color_range: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    duration: Option<String>,
    bits_per_raw_sample: Option<String>,
    #[serde(default)]
    side_data_list: Vec<SideData>,
}

#[derive(Deserialize, Default)]
struct SideData {
    side_data_type: Option<String>,
    rotation: Option<f64>,
}

/// What ffmpeg is asked to output for a source pixel format: (`-pix_fmt` name, our format, whether swscale converts).
fn output_format(pix_fmt: &str, bit_depth: u8) -> (&'static str, PixelFormat, bool) {
    match pix_fmt {
        "yuv420p" => ("yuv420p", PixelFormat::I420, false),
        "yuvj420p" => ("yuvj420p", PixelFormat::I420, false),
        "nv12" => ("nv12", PixelFormat::Nv12, false),
        "yuv420p10le" => ("yuv420p10le", PixelFormat::I420P10, false),
        "p010le" => ("p010le", PixelFormat::P010, false),
        _ if bit_depth > 8 => ("yuv420p10le", PixelFormat::I420P10, true),
        _ => ("yuv420p", PixelFormat::I420, true),
    }
}

/// Reads ffprobe's JSON into a [`VideoInfo`] and the ffmpeg output format.
fn parse_probe(json: &str) -> Result<(VideoInfo, &'static str, bool), Error> {
    let probe: Probe = serde_json::from_str(json)
        .map_err(|e| Error::Decode(format!("unreadable ffprobe output: {e}")))?;
    let stream = probe
        .streams
        .into_iter()
        .next()
        .ok_or_else(|| Error::Unsupported("the file has no video track".into()))?;
    let (Some(width), Some(height)) = (stream.width, stream.height) else {
        return Err(Error::Unsupported(
            "the video track has no frame size".into(),
        ));
    };
    if width == 0 || height == 0 {
        return Err(Error::Unsupported(
            "the video track has no frame size".into(),
        ));
    }
    let pix_fmt = stream.pix_fmt.unwrap_or_default();
    let bit_depth = stream
        .bits_per_raw_sample
        .as_deref()
        .and_then(|b| b.parse::<u8>().ok())
        .unwrap_or_else(|| depth_of(&pix_fmt));
    let (out, format, converted) = output_format(&pix_fmt, bit_depth);
    let rotation = stream
        .side_data_list
        .iter()
        .find(|s| s.side_data_type.as_deref() == Some("Display Matrix"))
        .and_then(|s| s.rotation)
        // ffprobe's display-matrix rotation is counter-clockwise; ours is the clockwise turn for display.
        .map(|ccw| normalise_rotation(-ccw))
        .transpose()?
        .unwrap_or(0);
    let transfer = match stream.color_transfer.as_deref() {
        Some("smpte2084") => Transfer::Pq,
        Some("arib-std-b67") => Transfer::Hlg,
        _ => Transfer::Sdr,
    };
    let matrix = match stream.color_space.as_deref() {
        Some("bt709") => Some(Matrix::Bt709),
        Some("smpte170m" | "bt470bg") => Some(Matrix::Bt601),
        Some("bt2020nc" | "bt2020c") => Some(Matrix::Bt2020),
        _ => None,
    };
    let primaries = match stream.color_primaries.as_deref() {
        Some("bt709") => Some(Primaries::Bt709),
        Some("bt2020") => Some(Primaries::Bt2020),
        Some("smpte432") => Some(Primaries::DisplayP3),
        Some("smpte170m" | "bt470bg") => Some(Primaries::Bt601),
        _ => None,
    };
    // A conversion is told to write limited range (see `FfmpegDecoder::open`); otherwise the planes keep the source's.
    let full_range =
        !converted && (pix_fmt.starts_with("yuvj") || stream.color_range.as_deref() == Some("pc"));
    let seconds = |s: Option<String>| s.and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0);
    let duration =
        seconds(stream.duration).or_else(|| seconds(probe.format.and_then(|f| f.duration)));
    Ok((
        VideoInfo {
            width,
            height,
            rotation,
            duration,
            // `nb_frames` would list the container's samples, which can be one more than ffmpeg presents (a sample at
            // the end of the edit list); `FfmpegDecoder::open` counts the packets ffmpeg keeps instead.
            frame_count: None,
            codec: stream.codec_name.unwrap_or_default(),
            bit_depth,
            colour: Colour {
                transfer,
                matrix,
                primaries,
                full_range,
            },
            format,
            backend: Backend::Ffmpeg,
        },
        out,
        converted,
    ))
}

fn depth_of(pix_fmt: &str) -> u8 {
    for (tag, depth) in [("p10", 10), ("p12", 12), ("p16", 16), ("010", 10)] {
        if pix_fmt.contains(tag) {
            return depth;
        }
    }
    8
}

/// One parsed line of the showinfo filter's log.
#[derive(Debug, PartialEq)]
enum Info {
    TimeBase(i64, i64),
    Pts(i64),
}

fn parse_showinfo(line: &str) -> Option<Info> {
    if !line.contains("Parsed_showinfo_") {
        return None;
    }
    if let Some(rest) = line.split("config in time_base:").nth(1) {
        let tb = rest.trim().split([',', ' ']).next()?;
        let (n, d) = tb.split_once('/')?;
        let (n, d) = (n.parse().ok()?, d.parse().ok()?);
        return (d != 0).then_some(Info::TimeBase(n, d));
    }
    // "n:   0 pts:      0 pts_time:0 ..." — a frame line carries both `n:` and `pts:`.
    let rest = line.split(" n:").nth(1)?;
    let pts = rest.split(" pts:").nth(1)?.split_whitespace().next()?;
    pts.parse().ok().map(Info::Pts)
}

fn resolve(explicit: &Option<PathBuf>, var: &str, name: &str) -> PathBuf {
    explicit
        .clone()
        .or_else(|| std::env::var_os(var).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn spawn_error(tool: &Path, error: std::io::Error) -> Error {
    if error.kind() == ErrorKind::NotFound || error.kind() == ErrorKind::PermissionDenied {
        Error::ToolMissing {
            tool: tool.display().to_string(),
            hint: install_hint().into(),
        }
    } else {
        Error::Io(format!("{}: {error}", tool.display()))
    }
}

pub struct FfmpegDecoder {
    info: VideoInfo,
    child: Child,
    stdout: ChildStdout,
    timestamps: Receiver<Info>,
    log: Arc<Mutex<VecDeque<String>>>,
    stderr: Option<JoinHandle<()>>,
    time_base: Option<(i64, i64)>,
    first_pts: Option<i64>,
    next: u64,
    done: bool,
}

impl FfmpegDecoder {
    pub fn open(path: &Path, options: &Options) -> Result<FfmpegDecoder, Error> {
        let ffprobe = resolve(&options.ffprobe, "LONGSCREEN_FFPROBE", "ffprobe");
        let output = Command::new(&ffprobe)
            .args(["-v", "error", "-select_streams", "V:0", "-show_entries"])
            .arg(
                "stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,\
                 duration,bits_per_raw_sample:stream_side_data:format=duration",
            )
            .args(["-of", "json"])
            .arg(path)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| spawn_error(&ffprobe, e))?;
        if !output.status.success() {
            return Err(Error::Unsupported(format!(
                "ffprobe could not read {}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let (mut info, pix_fmt, converted) = parse_probe(&String::from_utf8_lossy(&output.stdout))?;
        info.frame_count = presented_frames(&ffprobe, path);

        let ffmpeg = resolve(&options.ffmpeg, "LONGSCREEN_FFMPEG", "ffmpeg");
        // A source outside the four 4:2:0 layouts is converted to limited range, so the tags stay true.
        let filter = if converted {
            format!("scale=out_range=limited:flags=accurate_rnd+full_chroma_int,format={pix_fmt},showinfo")
        } else {
            "showinfo".into()
        };
        let mut child = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "info",
                "-noautorotate",
                "-i",
            ])
            .arg(path)
            .args(["-map", "0:V:0", "-an", "-sn", "-dn", "-vf", &filter])
            .args(["-fps_mode", "passthrough", "-pix_fmt", pix_fmt])
            .args(["-f", "rawvideo", "pipe:1"])
            .env("AV_LOG_FORCE_NOCOLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| spawn_error(&ffmpeg, e))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (tx, timestamps) = channel();
        let log = Arc::new(Mutex::new(VecDeque::new()));
        let tail = log.clone();
        let stderr = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                match parse_showinfo(&line) {
                    Some(info) => {
                        if tx.send(info).is_err() {
                            break;
                        }
                    }
                    None => {
                        let mut tail = tail.lock().unwrap();
                        if tail.len() == 20 {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            }
        });
        Ok(FfmpegDecoder {
            info,
            child,
            stdout,
            timestamps,
            log,
            stderr: Some(stderr),
            time_base: None,
            first_pts: None,
            next: 0,
            done: false,
        })
    }

    fn failure(&mut self, what: &str) -> Error {
        // Let the log thread finish so the tail holds ffmpeg's last words.
        let _ = self.child.wait();
        if let Some(handle) = self.stderr.take() {
            let _ = handle.join();
        }
        let tail: Vec<String> = self.log.lock().unwrap().iter().cloned().collect();
        Error::Decode(format!("{what}: {}", tail.join("\n")))
    }

    fn next_pts(&mut self) -> Result<i64, Error> {
        loop {
            match self.timestamps.recv() {
                Ok(Info::TimeBase(n, d)) => self.time_base = Some((n, d)),
                Ok(Info::Pts(pts)) => return Ok(pts),
                Err(_) => return Err(self.failure("ffmpeg gave a frame without its timestamp")),
            }
        }
    }
}

/// The frames ffmpeg will present: the first video track's packets, less those its demuxer marks discard (`D`), which
/// the decoder decodes but never outputs. ffmpeg marks a sample discard when it lies outside the edit list: before
/// the edit's start (decoded only because later frames depend on it), or at or after its end rounded to a whole tick
/// of the track's timescale. iPhone and macOS recordings commonly hold one such sample at the end. The walk reads no
/// pixels and takes tens of milliseconds for a few hundred MB. `None` when ffprobe cannot list the packets.
fn presented_frames(ffprobe: &Path, path: &Path) -> Option<u64> {
    let output = Command::new(ffprobe)
        .args(["-v", "error", "-select_streams", "V:0"])
        .args(["-show_entries", "packet=flags", "-of", "csv=p=0"])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    count_presented(&String::from_utf8_lossy(&output.stdout))
}

/// Counts the lines of ffprobe's `packet=flags` CSV whose flags (`K`ey, `D`iscard, `C`orrupt) leave out `D`.
fn count_presented(flags: &str) -> Option<u64> {
    let n = flags
        .lines()
        .map(|line| line.split(',').next().unwrap_or_default().trim())
        .filter(|f| !f.is_empty() && !f.contains('D'))
        .count() as u64;
    (n > 0).then_some(n)
}

/// Fills `buf` from `r`; `Ok(false)` if the stream ended before the first byte.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

impl Decoder for FfmpegDecoder {
    fn info(&self) -> &VideoInfo {
        &self.info
    }

    fn read_frame(&mut self, frame: &mut Frame) -> Result<bool, Error> {
        if self.done {
            return Ok(false);
        }
        pack_layout(frame, self.info.format, self.info.width, self.info.height);
        match read_full(&mut self.stdout, &mut frame.data) {
            Ok(true) => {}
            Ok(false) => {
                self.done = true;
                let status = self
                    .child
                    .wait()
                    .map_err(|e| Error::Io(format!("ffmpeg: {e}")))?;
                if !status.success() {
                    return Err(self.failure(&format!("ffmpeg exited with {status}")));
                }
                return Ok(false);
            }
            Err(e) => {
                self.done = true;
                return Err(self.failure(&format!("ffmpeg's output ended inside a frame ({e})")));
            }
        }
        let pts = self.next_pts()?;
        let Some((num, den)) = self.time_base else {
            return Err(self.failure("ffmpeg gave no time base"));
        };
        let first = *self.first_pts.get_or_insert(pts);
        frame.index = self.next;
        frame.timestamp = (pts - first) as f64 * num as f64 / den as f64;
        self.next += 1;
        Ok(true)
    }
}

impl Drop for FfmpegDecoder {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showinfo_lines_give_time_base_and_pts() {
        assert_eq!(
            parse_showinfo(
                "[Parsed_showinfo_0 @ 0x6000] config in time_base: 1/600, frame_rate: 60/1"
            ),
            Some(Info::TimeBase(1, 600))
        );
        assert_eq!(
            parse_showinfo(
                "[Parsed_showinfo_2 @ 0x6000] n:  12 pts:   7230 pts_time:12.05   duration:     10 fmt:yuv420p"
            ),
            Some(Info::Pts(7230))
        );
        // Side-data lines, other filters and ffmpeg's own log are not frames.
        assert_eq!(
            parse_showinfo("[Parsed_showinfo_0 @ 0x6000]   side data - mastering display:"),
            None
        );
        assert_eq!(
            parse_showinfo("frame=  100 fps= 50 q=-0.0 size= n: 3 pts: 4"),
            None
        );
        assert_eq!(
            parse_showinfo("[Parsed_showinfo_0 @ 0x1] config in time_base: 1/0"),
            None
        );
    }

    #[test]
    fn presented_frames_leave_out_discarded_packets() {
        // test_6's last packets: the one at the edit's end carries ffmpeg's discard flag and is never shown.
        assert_eq!(count_presented("K__\n___\n___\n_D_\n"), Some(3));
        // A leading sample before the edit is discarded the same way; a corrupt one (`C`) is still decoded.
        assert_eq!(count_presented("KD_\n___\n__C\n"), Some(2));
        // A field ffprobe may append after the flags does not change the count.
        assert_eq!(count_presented("K__,\n___,\n"), Some(2));
        // Nothing listed (an empty walk, or ffprobe printing nothing): no count rather than an expectation of zero.
        assert_eq!(count_presented(""), None);
        assert_eq!(count_presented("_D_\n"), None);
    }

    #[test]
    fn negative_pts_parse() {
        assert_eq!(
            parse_showinfo("[Parsed_showinfo_0 @ 0x1] n:   0 pts:    -20 pts_time:-0.0333"),
            Some(Info::Pts(-20))
        );
    }

    const HDR_IPHONE: &str = r#"{"streams":[{"codec_name":"hevc","width":1320,"height":2868,"pix_fmt":"yuv420p10le",
        "color_range":"tv","color_space":"bt2020nc","color_transfer":"smpte2084","color_primaries":"bt2020",
        "nb_frames":"336","duration":"5.666667","bits_per_raw_sample":"10",
        "side_data_list":[{"side_data_type":"Mastering display metadata"}]}],"format":{"duration":"5.70"}}"#;

    #[test]
    fn hdr_hevc_keeps_ten_bit_planes_and_pq_tags() {
        let (info, pix_fmt, converted) = parse_probe(HDR_IPHONE).unwrap();
        assert_eq!((pix_fmt, converted), ("yuv420p10le", false));
        assert_eq!(info.format, PixelFormat::I420P10);
        assert_eq!((info.width, info.height, info.rotation), (1320, 2868, 0));
        assert_eq!(info.bit_depth, 10);
        // `nb_frames` lists the container's samples (336), one more than ffmpeg presents; `open` counts instead.
        assert_eq!(info.frame_count, None);
        assert_eq!(info.duration, Some(5.666667));
        assert_eq!(info.codec, "hevc");
        assert_eq!(
            info.colour,
            Colour {
                transfer: Transfer::Pq,
                matrix: Some(Matrix::Bt2020),
                primaries: Some(Primaries::Bt2020),
                full_range: false
            }
        );
    }

    #[test]
    fn display_matrix_rotation_turns_into_a_clockwise_quarter() {
        let json = r#"{"streams":[{"width":1920,"height":1080,"pix_fmt":"yuv420p",
            "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]}]}"#;
        assert_eq!(parse_probe(json).unwrap().0.rotation, 90);
        let json = json.replace("-90", "90");
        assert_eq!(parse_probe(&json).unwrap().0.rotation, 270);
    }

    #[test]
    fn untagged_sdr_and_full_range_jpeg_formats() {
        let json = r#"{"streams":[{"width":640,"height":480,"pix_fmt":"yuvj420p"}],"format":{"duration":"2.5"}}"#;
        let (info, pix_fmt, converted) = parse_probe(json).unwrap();
        assert_eq!((pix_fmt, converted), ("yuvj420p", false));
        assert!(info.colour.full_range);
        assert_eq!(info.colour.matrix, None);
        assert_eq!(info.colour.transfer, Transfer::Sdr);
        assert_eq!(info.duration, Some(2.5));
        assert_eq!(info.frame_count, None);
    }

    #[test]
    fn other_layouts_convert_to_limited_four_two_zero_at_their_depth() {
        let json =
            r#"{"streams":[{"width":64,"height":64,"pix_fmt":"yuv444p","color_range":"pc"}]}"#;
        let (info, pix_fmt, converted) = parse_probe(json).unwrap();
        assert_eq!(
            (pix_fmt, converted, info.format),
            ("yuv420p", true, PixelFormat::I420)
        );
        assert!(!info.colour.full_range);
        let json = r#"{"streams":[{"width":64,"height":64,"pix_fmt":"yuv422p10le"}]}"#;
        let (info, pix_fmt, _) = parse_probe(json).unwrap();
        assert_eq!(
            (pix_fmt, info.format, info.bit_depth),
            ("yuv420p10le", PixelFormat::I420P10, 10)
        );
    }

    #[test]
    fn no_video_track_and_no_size_are_unsupported() {
        assert!(matches!(
            parse_probe(r#"{"streams":[]}"#),
            Err(Error::Unsupported(_))
        ));
        assert!(matches!(
            parse_probe(r#"{"streams":[{"codec_name":"h264"}]}"#),
            Err(Error::Unsupported(_))
        ));
        assert!(matches!(parse_probe("not json"), Err(Error::Decode(_))));
    }

    #[test]
    fn a_missing_ffprobe_is_reported_with_an_install_hint() {
        let file = std::env::current_exe().unwrap();
        let options = Options {
            backend: Backend::Ffmpeg,
            ffprobe: Some("/nonexistent/ffprobe".into()),
            ffmpeg: Some("/nonexistent/ffmpeg".into()),
        };
        match FfmpegDecoder::open(&file, &options) {
            Err(Error::ToolMissing { tool, hint }) => {
                assert_eq!(tool, "/nonexistent/ffprobe");
                assert!(hint.contains("ffmpeg"));
            }
            other => panic!("{:?}", other.err()),
        }
    }
}
