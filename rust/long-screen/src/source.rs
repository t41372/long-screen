//! Where frames come from. A run reads its source once per pass (scan, solve, render, and the reveal's sweeps), in
//! order, as the web page re-decodes its file for every pass; [`FrameSource::frames`] starts one such read.
//!
//! [`VideoSource`] decodes a file with `long-screen-decode` (AVFoundation, Media Foundation or ffmpeg) and turns each
//! frame into RGBA with the core's converter, as the page does: 10-bit PQ/HLG frames are rounded to 8 bits first and
//! converted through the core's HDR path. [`RawSource`] replays RGBA frames already in memory or on disk (the
//! parity harness feeds the web page's exact frames this way).

use crate::value::{Js, Obj};
use long_screen_core::yuv::{self, Format, Signal};
use long_screen_decode::{self as decode, PixelFormat};
use std::fmt;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Per-channel decode noise a decoded video declares (`DECODED_VIDEO_NOISE` in src/media/source.ts).
pub const DECODED_VIDEO_NOISE: f64 = 10.0;

/// One decoded frame, as RGBA.
pub struct Frame {
    pub index: u32,
    /// Seconds.
    pub time: f64,
    pub duration: f64,
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// A decoder notice the scan pass reports (`MediaNotice`).
#[derive(Clone, Debug)]
pub struct Notice {
    pub code: String,
    pub message: String,
    pub count: u64,
}

/// What a source says about itself (the page's `MediaInfo`). `js` is the object persisted as the project's
/// `media` field, the other fields the values the run reads from it.
#[derive(Clone, Debug)]
pub struct MediaInfo {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub duration: f64,
    pub frame_count: Option<u64>,
    pub codec: String,
    pub mode: String,
    pub noise: f64,
    pub warnings: Vec<String>,
    pub notices: Vec<Notice>,
    pub js: Obj,
}

impl MediaInfo {
    /// Reads a `MediaInfo` object as the page builds it.
    pub fn from_js(js: Obj) -> MediaInfo {
        let strings = |v: Option<&Js>| -> Vec<String> {
            v.and_then(Js::as_arr)
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        let notices = js
            .get("notices")
            .and_then(Js::as_arr)
            .map(|a| {
                a.iter()
                    .filter_map(Js::as_obj)
                    .map(|n| Notice {
                        code: n.str("code").unwrap_or_default().to_string(),
                        message: n.str("message").unwrap_or_default().to_string(),
                        count: n.num("count") as u64,
                    })
                    .collect()
            })
            .unwrap_or_default();
        MediaInfo {
            name: js.str("name").unwrap_or("video").to_string(),
            width: js.num("width") as usize,
            height: js.num("height") as usize,
            duration: js.num("duration"),
            frame_count: js
                .get("frameCount")
                .map(Js::num)
                .filter(|n| n.is_finite())
                .map(|n| n as u64),
            codec: js.str("codec").unwrap_or_default().to_string(),
            mode: js.str("mode").unwrap_or_default().to_string(),
            noise: js.get("noise").map_or(DECODED_VIDEO_NOISE, Js::num),
            warnings: strings(js.get("warnings")),
            notices,
            js,
        }
    }
}

/// A failure to read the next frame.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceError(pub String);

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SourceError {}

/// One read of the source, frame by frame.
pub type Frames<'a> = Box<dyn Iterator<Item = Result<Frame, SourceError>> + 'a>;

/// A recording a run reads, once per pass.
pub trait FrameSource: Send {
    fn info(&self) -> &MediaInfo;
    /// Starts a read from the first frame.
    fn frames(&mut self) -> Result<Frames<'_>, SourceError>;

    /// Like [`FrameSource::frames`], but a frame whose entry in `wanted` is false (or past its end) may come without
    /// pixels (an empty `rgba`), which saves converting it. The default converts every frame.
    fn sparse_frames(&mut self, wanted: &[bool]) -> Result<Frames<'_>, SourceError> {
        let _ = wanted;
        self.frames()
    }
}

// --- Decoded video ---

/// A video file decoded natively.
pub struct VideoSource {
    path: PathBuf,
    options: decode::Options,
    video: decode::VideoInfo,
    info: MediaInfo,
}

impl VideoSource {
    /// Opens `path` with `options` (probing it once); errors carry the decoder's reason, including how to install
    /// ffmpeg when it is needed and missing.
    pub fn open(path: &Path, options: decode::Options) -> Result<VideoSource, decode::Error> {
        let video = decode::probe(path, &options)?;
        let (width, height) = video.display_size();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".into());
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let mode = format!("Native {} decoder", video.backend.name());
        // The page's MediaInfo field order (src/media/source.ts PreciseSource).
        let mut js = Obj::new()
            .with("name", name.as_str())
            .with("size", size)
            .with("width", width)
            .with("height", height)
            .with("codedWidth", video.width)
            .with("codedHeight", video.height)
            .with("rotation", video.rotation as u32)
            .with("duration", video.duration.unwrap_or(0.0))
            .with("codec", video.codec.as_str());
        if let Some(n) = video.frame_count {
            js.set("frameCount", n);
        }
        js.set("mode", mode.as_str());
        js.set("noise", DECODED_VIDEO_NOISE);
        js.set("warnings", Js::Arr(Vec::new()));
        js.set("notices", Js::Arr(Vec::new()));
        let info = MediaInfo::from_js(js);
        Ok(VideoSource {
            path: path.to_path_buf(),
            options,
            video,
            info,
        })
    }

    /// The decoder's view of the file.
    pub fn video(&self) -> &decode::VideoInfo {
        &self.video
    }
}

impl FrameSource for VideoSource {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        self.read(None)
    }

    fn sparse_frames(&mut self, wanted: &[bool]) -> Result<Frames<'_>, SourceError> {
        self.read(Some(wanted.to_vec()))
    }
}

impl VideoSource {
    fn read(&mut self, wanted: Option<Vec<bool>>) -> Result<Frames<'_>, SourceError> {
        let mut decoder =
            decode::open(&self.path, &self.options).map_err(|e| SourceError(e.to_string()))?;
        let video = self.video.clone();
        let signal = Signal::from_code(video.colour.core_code(video.height))
            .ok_or_else(|| SourceError("unsupported colour signal".into()))?;
        let duration = video.duration;
        let mut pending: Option<decode::Frame> = None;
        let mut done = false;
        let mut index = 0u32;
        let mut last_step = 1.0 / 60.0;
        Ok(Box::new(std::iter::from_fn(move || {
            if done && pending.is_none() {
                return None;
            }
            // One frame of lookahead gives each frame its duration (the next timestamp minus its own).
            {
                if pending.is_none() {
                    match decoder.next_frame() {
                        Ok(Some(f)) => pending = Some(f),
                        Ok(None) => {
                            done = true;
                            return None;
                        }
                        Err(e) => {
                            done = true;
                            return Some(Err(SourceError(e.to_string())));
                        }
                    }
                }
                let current = pending.take().unwrap();
                let next = if done {
                    None
                } else {
                    match decoder.next_frame() {
                        Ok(f) => f,
                        Err(e) => {
                            done = true;
                            pending = None;
                            return Some(Err(SourceError(e.to_string())));
                        }
                    }
                };
                let step = match &next {
                    Some(n) if n.timestamp > current.timestamp => n.timestamp - current.timestamp,
                    Some(_) => last_step,
                    None => duration
                        .map(|d| d - current.timestamp)
                        .filter(|d| *d > 0.0)
                        .unwrap_or(last_step),
                };
                last_step = step;
                if next.is_none() {
                    done = true;
                }
                pending = next;
                let skip = wanted
                    .as_ref()
                    .is_some_and(|w| !w.get(index as usize).copied().unwrap_or(false));
                let rgba = if skip {
                    let (w, h) = video.display_size();
                    (w, h, Vec::new())
                } else {
                    match to_rgba(&current, signal, video.rotation) {
                        Ok(f) => f,
                        Err(e) => {
                            done = true;
                            pending = None;
                            return Some(Err(e));
                        }
                    }
                };
                let frame = Frame {
                    index,
                    time: current.timestamp,
                    duration: step,
                    width: rgba.0,
                    height: rgba.1,
                    rgba: rgba.2,
                };
                index += 1;
                Some(Ok(frame))
            }
        })))
    }
}

/// The core's YUV → RGBA conversion of one decoded frame (10-bit frames rounded to 8 bits first, as the page
/// copies them), turned for display.
fn to_rgba(
    frame: &decode::Frame,
    signal: Signal,
    rotation: u16,
) -> Result<(usize, usize, Vec<u8>), SourceError> {
    let eight;
    let frame = match frame.format {
        Some(PixelFormat::I420P10) | Some(PixelFormat::P010) => {
            eight = frame.to_8bit();
            &eight
        }
        Some(_) => frame,
        None => return Err(SourceError("frame without a pixel format".into())),
    };
    let format = match frame.format {
        Some(PixelFormat::I420) => Format::I420,
        Some(PixelFormat::Nv12) => Format::Nv12,
        _ => return Err(SourceError("unsupported pixel format".into())),
    };
    let (w, h) = (frame.width, frame.height);
    let planes: Vec<yuv::Plane> = frame
        .planes
        .iter()
        .map(|p| yuv::Plane {
            offset: p.offset,
            stride: p.stride,
        })
        .collect();
    let mut rgba = vec![0u8; w * h * 4];
    yuv::convert(&frame.data, format, &planes, w, h, signal, &mut rgba);
    Ok(rotate(w, h, rgba, rotation))
}

/// Turns an RGBA frame clockwise by `rotation` degrees (0, 90, 180, 270).
fn rotate(w: usize, h: usize, rgba: Vec<u8>, rotation: u16) -> (usize, usize, Vec<u8>) {
    if rotation == 0 {
        return (w, h, rgba);
    }
    let (ow, oh) = if rotation % 180 == 90 { (h, w) } else { (w, h) };
    let mut out = vec![0u8; rgba.len()];
    for y in 0..h {
        for x in 0..w {
            let (ox, oy) = match rotation {
                90 => (h - 1 - y, x),
                180 => (w - 1 - x, h - 1 - y),
                _ => (y, w - 1 - x),
            };
            let s = (y * w + x) * 4;
            let d = (oy * ow + ox) * 4;
            out[d..d + 4].copy_from_slice(&rgba[s..s + 4]);
        }
    }
    (ow, oh, out)
}

// --- Raw RGBA frames ---

/// One frame of a [`RawSource`]: its time, duration and size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawFrame {
    pub time: f64,
    pub duration: f64,
    pub width: usize,
    pub height: usize,
}

/// RGBA frames in a file, back to back, with each frame's time, duration and size.
pub struct RawSource {
    path: PathBuf,
    frames: Vec<RawFrame>,
    info: MediaInfo,
}

impl RawSource {
    /// `path` holds the frames `frames` describes, in order.
    pub fn new(path: PathBuf, frames: Vec<RawFrame>, info: MediaInfo) -> RawSource {
        RawSource { path, frames, info }
    }
}

impl FrameSource for RawSource {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn frames(&mut self) -> Result<Frames<'_>, SourceError> {
        let mut file = File::open(&self.path).map_err(|e| SourceError(e.to_string()))?;
        let frames = self.frames.clone();
        let mut index = 0usize;
        let mut offset = 0u64;
        Ok(Box::new(std::iter::from_fn(move || {
            let &RawFrame {
                time,
                duration,
                width: w,
                height: h,
            } = frames.get(index)?;
            let bytes = w * h * 4;
            let mut rgba = vec![0u8; bytes];
            let read = file
                .seek(SeekFrom::Start(offset))
                .and_then(|_| file.read_exact(&mut rgba));
            offset += bytes as u64;
            if let Err(e) = read {
                return Some(Err(SourceError(e.to_string())));
            }
            let frame = Frame {
                index: index as u32,
                time,
                duration,
                width: w,
                height: h,
                rgba,
            };
            index += 1;
            Some(Ok(frame))
        })))
    }
}
