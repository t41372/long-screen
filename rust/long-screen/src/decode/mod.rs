//! Native video decoding for the command line, the Python module and desktop builds.
//!
//! A [`Decoder`] yields every frame of a file's first video track once, in presentation order, with the timestamp
//! the container gives it. Screen recordings are variable frame rate, so nothing here resamples to a constant rate:
//! a frame is never duplicated or dropped. Frames keep the decoder's own 4:2:0 planes ([`PixelFormat`]) and coded
//! orientation; [`VideoInfo::rotation`] says how to turn them for display, and the colour tags say how to read the
//! planes, so an HDR (PQ or HLG) recording reaches the kernels' converter with its signal untouched.
//!
//! Backends: the system decoder on macOS (AVFoundation) and Windows (Media Foundation), and a user-installed
//! `ffmpeg`/`ffprobe` run as a child process on every system. Linux has no single system decoder API, so it uses
//! ffmpeg. ffmpeg is never linked or bundled; [`Error::ToolMissing`] says how to install it.
//!
//! The driver reads videos through this module (`VideoSource`); use it directly when you only need the frames. It
//! is an implementation layer like [`kernels`](crate::kernels) and [`engine`](crate::engine): its API may change in
//! minor versions. [`Options`] and [`Backend`] are re-exported at the crate root as `DecodeOptions` and
//! `DecodeBackend`.
//!
//! ```no_run
//! use long_screen::decode::{open, Frame, Options};
//! use std::path::Path;
//!
//! let mut decoder = open(Path::new("recording.mov"), &Options::default())?;
//! println!("{:?}", decoder.info());
//! let mut frame = Frame::default();
//! while decoder.read_frame(&mut frame)? {
//!     println!("frame {} at {:.3} s", frame.index, frame.timestamp);
//! }
//! # Ok::<(), long_screen::decode::Error>(())
//! ```

use std::fmt;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod avf;
mod ffmpeg;
#[cfg(windows)]
mod mf;

/// Which decoder reads the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// The system decoder where there is one (AVFoundation on macOS, Media Foundation on Windows), else ffmpeg.
    /// A file the system decoder cannot open falls back to ffmpeg when ffmpeg is installed.
    Auto,
    Ffmpeg,
    AvFoundation,
    MediaFoundation,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Backend::Auto => "auto",
            Backend::Ffmpeg => "ffmpeg",
            Backend::AvFoundation => "avfoundation",
            Backend::MediaFoundation => "mediafoundation",
        }
    }

    pub fn parse(name: &str) -> Option<Backend> {
        [
            Backend::Auto,
            Backend::Ffmpeg,
            Backend::AvFoundation,
            Backend::MediaFoundation,
        ]
        .into_iter()
        .find(|b| b.name() == name)
    }

    /// Whether this build has the backend at all (the system ones are per operating system).
    pub fn available(self) -> bool {
        match self {
            Backend::Auto | Backend::Ffmpeg => true,
            Backend::AvFoundation => cfg!(target_os = "macos"),
            Backend::MediaFoundation => cfg!(windows),
        }
    }
}

/// How a frame's bytes are laid out. Every format is 4:2:0 with chroma planes of `ceil(w/2) × ceil(h/2)` samples.
/// 10-bit formats store each sample in a little-endian `u16`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    /// 8-bit Y, U and V planes.
    I420,
    /// 8-bit Y plane and one interleaved UV plane.
    Nv12,
    /// 10-bit Y, U and V planes, value in the low ten bits (ffmpeg's `yuv420p10le`).
    I420P10,
    /// 10-bit Y plane and one interleaved UV plane, value in the high ten bits (`P010`, `x420`).
    P010,
}

impl PixelFormat {
    pub fn bit_depth(self) -> u8 {
        match self {
            PixelFormat::I420 | PixelFormat::Nv12 => 8,
            PixelFormat::I420P10 | PixelFormat::P010 => 10,
        }
    }

    pub fn semi_planar(self) -> bool {
        matches!(self, PixelFormat::Nv12 | PixelFormat::P010)
    }

    /// Bytes per sample.
    pub fn sample_bytes(self) -> usize {
        if self.bit_depth() > 8 {
            2
        } else {
            1
        }
    }

    /// Per plane, tightly packed: (bytes per row, rows).
    pub fn planes(self, width: usize, height: usize) -> Vec<(usize, usize)> {
        let (cw, ch, b) = (width.div_ceil(2), height.div_ceil(2), self.sample_bytes());
        if self.semi_planar() {
            vec![(width * b, height), (cw * 2 * b, ch)]
        } else {
            vec![(width * b, height), (cw * b, ch), (cw * b, ch)]
        }
    }

    /// Bytes of a tightly packed frame.
    pub fn frame_bytes(self, width: usize, height: usize) -> usize {
        self.planes(width, height).iter().map(|(r, n)| r * n).sum()
    }
}

/// One plane of a frame: byte offset of its first row in [`Frame::data`] and bytes between rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plane {
    pub offset: usize,
    pub stride: usize,
}

/// The transfer function the samples code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transfer {
    /// Any SDR transfer (BT.709, sRGB, BT.601 …); untagged streams are SDR.
    Sdr,
    /// SMPTE ST 2084.
    Pq,
    /// ARIB STD-B67.
    Hlg,
}

/// The YUV matrix of the planes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Matrix {
    Bt709,
    Bt601,
    Bt2020,
}

/// The colour primaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primaries {
    Bt709,
    Bt2020,
    DisplayP3,
    Bt601,
}

/// The stream's colour tags. `None` means untagged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colour {
    pub transfer: Transfer,
    pub matrix: Option<Matrix>,
    pub primaries: Option<Primaries>,
    /// Full-range (0–255) samples rather than limited (16–235).
    pub full_range: bool,
}

impl Colour {
    /// The matrix to convert with: the tag, else BT.709 from 720 rows up and BT.601 below (as browsers assume).
    pub fn matrix_or_default(&self, height: usize) -> Matrix {
        self.matrix.unwrap_or(if height >= 720 {
            Matrix::Bt709
        } else {
            Matrix::Bt601
        })
    }

    /// The colour code of the kernels' `yuv::Signal::from_code` (transfer × 8 + matrix × 2 + full range).
    pub fn core_code(&self, height: usize) -> u32 {
        let transfer = match self.transfer {
            Transfer::Sdr => 0,
            Transfer::Pq => 1,
            Transfer::Hlg => 2,
        };
        let matrix = match self.matrix_or_default(height) {
            Matrix::Bt709 => 0,
            Matrix::Bt601 => 1,
            Matrix::Bt2020 => 2,
        };
        transfer * 8 + matrix * 2 + self.full_range as u32
    }
}

/// What the file holds, as the chosen backend reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoInfo {
    /// Size of the decoded frames, before [`VideoInfo::rotation`].
    pub width: usize,
    pub height: usize,
    /// Degrees (0, 90, 180 or 270) to turn the frames clockwise for display.
    pub rotation: u16,
    /// Seconds, when the container says.
    pub duration: Option<f64>,
    /// Frames this backend will present (decode and output), counted before decoding: the track's samples inside its
    /// edit list, as the backend applies it. This can be fewer than the samples the container lists: iPhone and macOS
    /// recordings commonly list one sample starting where the edit ends, which the backend does not present. A run
    /// that decodes fewer frames than this has lost some. `None` when the backend cannot tell in advance (Media Foundation; an
    /// AVFoundation track with several edits; ffprobe unable to list the packets).
    pub frame_count: Option<u64>,
    /// The codec's short name: `h264`, `hevc`, `vp9`, `av1`, `prores` …
    pub codec: String,
    /// Bits per sample of the coded stream (the frames' format may hold them in wider samples).
    pub bit_depth: u8,
    pub colour: Colour,
    /// The format every frame comes in.
    pub format: PixelFormat,
    /// The backend that read the file (never `Auto`).
    pub backend: Backend,
}

impl VideoInfo {
    /// Size after rotation, as the recording is shown.
    pub fn display_size(&self) -> (usize, usize) {
        if self.rotation % 180 == 90 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

/// One decoded frame.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    /// Position in presentation order, from 0.
    pub index: u64,
    /// Presentation time in seconds, from the container's timestamps (after its edit list).
    pub timestamp: f64,
    pub width: usize,
    pub height: usize,
    /// `None` only on a `Frame::default()` not yet filled by [`Decoder::read_frame`].
    pub format: Option<PixelFormat>,
    pub data: Vec<u8>,
    /// One entry per plane of `format` (Y, U, V or Y, UV).
    pub planes: Vec<Plane>,
}

impl Frame {
    /// Row `y` of plane `p`, `len` bytes long.
    pub fn row(&self, p: usize, y: usize, len: usize) -> &[u8] {
        let plane = self.planes[p];
        &self.data[plane.offset + y * plane.stride..][..len]
    }

    /// An 8-bit copy of a 10-bit frame (`I420P10` → `I420`, `P010` → `Nv12`), each sample rounded to the nearest 8-bit
    /// code (`(v + 2) >> 2`, clamped); an 8-bit frame is returned as a packed copy. The core converts 8-bit planes,
    /// and both 10-bit layouts round to the same bytes.
    pub fn to_8bit(&self) -> Frame {
        let format = self.format.expect("a decoded frame");
        let out_format = match format {
            PixelFormat::I420 | PixelFormat::I420P10 => PixelFormat::I420,
            PixelFormat::Nv12 | PixelFormat::P010 => PixelFormat::Nv12,
        };
        let dims = out_format.planes(self.width, self.height);
        let mut data = Vec::with_capacity(out_format.frame_bytes(self.width, self.height));
        let mut planes = Vec::with_capacity(dims.len());
        for (p, &(row_bytes, rows)) in dims.iter().enumerate() {
            planes.push(Plane {
                offset: data.len(),
                stride: row_bytes,
            });
            for y in 0..rows {
                match format {
                    PixelFormat::I420 | PixelFormat::Nv12 => {
                        data.extend_from_slice(self.row(p, y, row_bytes))
                    }
                    PixelFormat::I420P10 => data.extend(
                        self.row(p, y, row_bytes * 2)
                            .chunks_exact(2)
                            .map(|s| round10(u16::from_le_bytes([s[0], s[1]]))),
                    ),
                    PixelFormat::P010 => data.extend(
                        self.row(p, y, row_bytes * 2)
                            .chunks_exact(2)
                            .map(|s| round10(u16::from_le_bytes([s[0], s[1]]) >> 6)),
                    ),
                }
            }
        }
        Frame {
            index: self.index,
            timestamp: self.timestamp,
            width: self.width,
            height: self.height,
            format: Some(out_format),
            data,
            planes,
        }
    }
}

#[inline]
fn round10(v: u16) -> u8 {
    ((v.min(1023) + 2) >> 2).min(255) as u8
}

/// Lays out `frame` as a tightly packed `format` frame of `width × height`, reusing its allocation.
pub(crate) fn pack_layout(frame: &mut Frame, format: PixelFormat, width: usize, height: usize) {
    frame.width = width;
    frame.height = height;
    frame.format = Some(format);
    frame.planes.clear();
    let mut offset = 0;
    for (row_bytes, rows) in format.planes(width, height) {
        frame.planes.push(Plane {
            offset,
            stride: row_bytes,
        });
        offset += row_bytes * rows;
    }
    frame.data.resize(offset, 0);
}

/// Reads a file's frames in presentation order.
pub trait Decoder: Send {
    fn info(&self) -> &VideoInfo;

    /// Decodes the next frame into `frame`, reusing its buffer. `Ok(false)` at the end of the stream.
    fn read_frame(&mut self, frame: &mut Frame) -> Result<bool, Error>;

    /// The next frame in a fresh buffer, `Ok(None)` at the end.
    fn next_frame(&mut self) -> Result<Option<Frame>, Error> {
        let mut frame = Frame::default();
        Ok(self.read_frame(&mut frame)?.then_some(frame))
    }
}

/// How to open a file.
#[derive(Clone, Debug)]
pub struct Options {
    pub backend: Backend,
    /// The `ffmpeg` executable; `None` reads `LONGSCREEN_FFMPEG`, else `ffmpeg` on `PATH`.
    pub ffmpeg: Option<PathBuf>,
    /// The `ffprobe` executable; `None` reads `LONGSCREEN_FFPROBE`, else `ffprobe` on `PATH`.
    pub ffprobe: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            backend: Backend::Auto,
            ffmpeg: None,
            ffprobe: None,
        }
    }
}

impl Options {
    pub fn with_backend(backend: Backend) -> Options {
        Options {
            backend,
            ..Options::default()
        }
    }
}

/// Opens `path` for decoding with `options.backend`.
pub fn open(path: &Path, options: &Options) -> Result<Box<dyn Decoder>, Error> {
    if !path.is_file() {
        return Err(Error::Io(format!("{}: no such file", path.display())));
    }
    match options.backend {
        Backend::Ffmpeg => Ok(Box::new(ffmpeg::FfmpegDecoder::open(path, options)?)),
        Backend::AvFoundation => open_avf(path),
        Backend::MediaFoundation => open_mf(path),
        Backend::Auto => {
            let system = if cfg!(target_os = "macos") {
                Some(open_avf(path))
            } else if cfg!(windows) {
                Some(open_mf(path))
            } else {
                None
            };
            match system {
                Some(Ok(decoder)) => Ok(decoder),
                Some(Err(system_error)) => match ffmpeg::FfmpegDecoder::open(path, options) {
                    Ok(decoder) => Ok(Box::new(decoder)),
                    // Neither works: the system decoder's reason is the more useful one unless ffmpeg is simply absent.
                    Err(Error::ToolMissing { .. }) => Err(system_error),
                    Err(error) => Err(error),
                },
                None => Ok(Box::new(ffmpeg::FfmpegDecoder::open(path, options)?)),
            }
        }
    }
}

/// The file's [`VideoInfo`] as `options.backend` would decode it, without decoding.
pub fn probe(path: &Path, options: &Options) -> Result<VideoInfo, Error> {
    open(path, options).map(|decoder| decoder.info().clone())
}

#[cfg(target_os = "macos")]
fn open_avf(path: &Path) -> Result<Box<dyn Decoder>, Error> {
    Ok(Box::new(avf::AvfDecoder::open(path)?))
}

#[cfg(not(target_os = "macos"))]
fn open_avf(_: &Path) -> Result<Box<dyn Decoder>, Error> {
    Err(Error::BackendUnavailable(Backend::AvFoundation))
}

#[cfg(windows)]
fn open_mf(path: &Path) -> Result<Box<dyn Decoder>, Error> {
    Ok(Box::new(mf::MfDecoder::open(path)?))
}

#[cfg(not(windows))]
fn open_mf(_: &Path) -> Result<Box<dyn Decoder>, Error> {
    Err(Error::BackendUnavailable(Backend::MediaFoundation))
}

/// Normalises a rotation in degrees (any sign, any multiple of 90) to 0, 90, 180 or 270.
pub(crate) fn normalise_rotation(degrees: f64) -> Result<u16, Error> {
    let quarter = (degrees / 90.0).round();
    if (degrees - quarter * 90.0).abs() > 0.5 {
        return Err(Error::Unsupported(format!(
            "a rotation of {degrees}° (only multiples of 90° are supported)"
        )));
    }
    Ok(((quarter as i64).rem_euclid(4) * 90) as u16)
}

/// Why a file could not be read.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// `ffmpeg` or `ffprobe` could not be started.
    ToolMissing {
        tool: String,
        hint: String,
    },
    /// The backend does not exist on this operating system.
    BackendUnavailable(Backend),
    /// The file or its stream is something this crate does not read (no video track, an unsupported layout …).
    Unsupported(String),
    /// The decoder failed partway, or a backend call failed.
    Decode(String),
    Io(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::ToolMissing { tool, hint } => {
                write!(f, "`{tool}` could not be started. {hint}")
            }
            Error::BackendUnavailable(b) => {
                write!(
                    f,
                    "the {} decoder is not available on this system",
                    b.name()
                )
            }
            Error::Unsupported(what) => write!(f, "unsupported video: {what}"),
            Error::Decode(what) => write!(f, "decoding failed: {what}"),
            Error::Io(what) => write!(f, "{what}"),
        }
    }
}

impl std::error::Error for Error {}

/// How to install ffmpeg on this system, for [`Error::ToolMissing`].
pub(crate) fn install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install ffmpeg (it provides ffmpeg and ffprobe), e.g. `brew install ffmpeg`, or set LONGSCREEN_FFMPEG and LONGSCREEN_FFPROBE to their paths."
    } else if cfg!(windows) {
        "Install ffmpeg (it provides ffmpeg and ffprobe), e.g. `winget install Gyan.FFmpeg`, and make sure it is on PATH, or set LONGSCREEN_FFMPEG and LONGSCREEN_FFPROBE to their paths."
    } else {
        "Install ffmpeg (it provides ffmpeg and ffprobe) with your package manager, e.g. `sudo apt install ffmpeg` or `sudo dnf install ffmpeg`, or set LONGSCREEN_FFMPEG and LONGSCREEN_FFPROBE to their paths."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(
        format: PixelFormat,
        width: usize,
        height: usize,
        fill: impl Fn(usize) -> u16,
    ) -> Frame {
        let mut f = Frame::default();
        pack_layout(&mut f, format, width, height);
        let samples = f.data.len() / format.sample_bytes();
        if format.sample_bytes() == 2 {
            f.data = (0..samples).flat_map(|i| fill(i).to_le_bytes()).collect();
        } else {
            f.data = (0..samples).map(|i| fill(i) as u8).collect();
        }
        f
    }

    #[test]
    fn plane_sizes_round_chroma_up_for_odd_dimensions() {
        assert_eq!(PixelFormat::I420.planes(5, 3), vec![(5, 3), (3, 2), (3, 2)]);
        assert_eq!(PixelFormat::P010.planes(5, 3), vec![(10, 3), (12, 2)]);
        assert_eq!(PixelFormat::I420P10.frame_bytes(4, 4), (16 + 4 + 4) * 2);
    }

    #[test]
    fn ten_bit_rounds_to_nearest_and_clamps_at_white() {
        for (v10, v8) in [
            (0, 0),
            (1, 0),
            (2, 1),
            (5, 1),
            (6, 2),
            (940, 235),
            (1021, 255),
            (1023, 255),
        ] {
            assert_eq!(round10(v10), v8, "{v10}");
        }
    }

    #[test]
    fn both_ten_bit_layouts_reduce_to_the_same_bytes() {
        let value = |i: usize| ((i * 37) % 1024) as u16;
        let planar = frame(PixelFormat::I420P10, 6, 4, value);
        // The same samples in P010: luma identical, chroma interleaved, each value shifted into the high bits.
        let (w, h) = (6, 4);
        let mut p010 = frame(PixelFormat::P010, w, h, |_| 0);
        let read = |f: &Frame, p: usize, i: usize| {
            let o = f.planes[p].offset + i * 2;
            u16::from_le_bytes([f.data[o], f.data[o + 1]])
        };
        let mut write = |p: usize, i: usize, v: u16| {
            let o = p010.planes[p].offset + i * 2;
            p010.data[o..o + 2].copy_from_slice(&(v << 6).to_le_bytes());
        };
        for i in 0..w * h {
            write(0, i, read(&planar, 0, i));
        }
        for i in 0..(w / 2) * (h / 2) {
            write(1, i * 2, read(&planar, 1, i));
            write(1, i * 2 + 1, read(&planar, 2, i));
        }
        let (a, b) = (planar.to_8bit(), p010.to_8bit());
        assert_eq!(a.format, Some(PixelFormat::I420));
        assert_eq!(b.format, Some(PixelFormat::Nv12));
        assert_eq!(a.data[..w * h], b.data[..w * h]);
        let (us, vs) = (&a.data[a.planes[1].offset..], &a.data[a.planes[2].offset..]);
        let uv = &b.data[b.planes[1].offset..];
        for i in 0..(w / 2) * (h / 2) {
            assert_eq!([us[i], vs[i]], [uv[i * 2], uv[i * 2 + 1]]);
        }
    }

    #[test]
    fn to_8bit_drops_row_padding() {
        // A 2×2 I420 frame whose rows are padded to 4 bytes.
        let f = Frame {
            width: 2,
            height: 2,
            format: Some(PixelFormat::I420),
            data: vec![1, 2, 0, 0, 3, 4, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0],
            planes: vec![
                Plane {
                    offset: 0,
                    stride: 4,
                },
                Plane {
                    offset: 8,
                    stride: 4,
                },
                Plane {
                    offset: 12,
                    stride: 4,
                },
            ],
            ..Frame::default()
        };
        assert_eq!(f.to_8bit().data, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn rotation_normalises_to_quarter_turns() {
        assert_eq!(normalise_rotation(-90.0), Ok(270));
        assert_eq!(normalise_rotation(90.0), Ok(90));
        assert_eq!(normalise_rotation(-180.0), Ok(180));
        assert_eq!(normalise_rotation(360.0), Ok(0));
        assert_eq!(normalise_rotation(89.99), Ok(90));
        assert!(matches!(
            normalise_rotation(45.0),
            Err(Error::Unsupported(_))
        ));
    }

    #[test]
    fn core_code_matches_the_core_signal_codes() {
        let c = |transfer, matrix, full_range| Colour {
            transfer,
            matrix,
            primaries: None,
            full_range,
        };
        assert_eq!(
            c(Transfer::Sdr, Some(Matrix::Bt709), false).core_code(1080),
            0
        );
        assert_eq!(
            c(Transfer::Sdr, Some(Matrix::Bt709), true).core_code(1080),
            1
        );
        assert_eq!(c(Transfer::Sdr, None, false).core_code(480), 2);
        assert_eq!(c(Transfer::Sdr, None, false).core_code(720), 0);
        assert_eq!(
            c(Transfer::Pq, Some(Matrix::Bt2020), false).core_code(2868),
            8 + 4
        );
        assert_eq!(
            c(Transfer::Hlg, Some(Matrix::Bt2020), true).core_code(2160),
            16 + 4 + 1
        );
    }

    #[test]
    fn display_size_swaps_on_quarter_turns() {
        let mut info = VideoInfo {
            width: 1920,
            height: 1080,
            rotation: 90,
            duration: None,
            frame_count: None,
            codec: "h264".into(),
            bit_depth: 8,
            colour: Colour {
                transfer: Transfer::Sdr,
                matrix: None,
                primaries: None,
                full_range: false,
            },
            format: PixelFormat::I420,
            backend: Backend::Ffmpeg,
        };
        assert_eq!(info.display_size(), (1080, 1920));
        info.rotation = 180;
        assert_eq!(info.display_size(), (1920, 1080));
    }

    #[test]
    fn missing_file_is_an_io_error_for_every_backend() {
        for backend in [
            Backend::Auto,
            Backend::Ffmpeg,
            Backend::AvFoundation,
            Backend::MediaFoundation,
        ] {
            let err = open(
                Path::new("/nonexistent/clip.mov"),
                &Options::with_backend(backend),
            )
            .err();
            assert!(matches!(err, Some(Error::Io(_))), "{backend:?}: {err:?}");
        }
    }

    #[test]
    fn backends_parse_by_name() {
        for b in [
            Backend::Auto,
            Backend::Ffmpeg,
            Backend::AvFoundation,
            Backend::MediaFoundation,
        ] {
            assert_eq!(Backend::parse(b.name()), Some(b));
        }
        assert_eq!(Backend::parse("vlc"), None);
    }
}
