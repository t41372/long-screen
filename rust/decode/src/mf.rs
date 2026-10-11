//! The Windows backend: a Media Foundation source reader decoding the first video stream to the decoder's own NV12
//! (8-bit) or P010 (10-bit) planes, without the video processor, so no colour conversion happens on the way. Sample
//! times are the source's presentation times in 100 ns units.
//!
//! Type-checked on other systems with `cargo check --target x86_64-pc-windows-msvc`; it has not been run on Windows.

use crate::{
    normalise_rotation, pack_layout, Backend, Colour, Decoder, Error, Frame, Matrix, PixelFormat,
    Primaries, Transfer, VideoInfo,
};
use std::path::Path;
use windows::core::{Interface, HSTRING};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VT_UI8;

/// Media Foundation's source reader is free-threaded once MF is started in the multithreaded apartment, so the decoder
/// may move between threads; `&mut self` keeps it to one at a time.
struct Reader(IMFSourceReader);
// SAFETY: see `Reader`.
unsafe impl Send for Reader {}

pub struct MfDecoder {
    info: VideoInfo,
    reader: Reader,
    stream: u32,
    /// Rows of the decoder's output buffers (the coded height, which may exceed the visible one, e.g. 1088 for 1080).
    buffer_rows: usize,
    first_time: Option<i64>,
    next: u64,
    done: bool,
    com: bool,
}

fn mf_error(what: &str, e: windows::core::Error) -> Error {
    Error::Decode(format!("Media Foundation {what}: {e}"))
}

/// Media Foundation's packed `(high, low)` pair of a `UINT64` attribute.
fn split(v: u64) -> (usize, usize) {
    ((v >> 32) as usize, (v & 0xffff_ffff) as usize)
}

fn codec_name(subtype: windows::core::GUID) -> String {
    match subtype {
        s if s == MFVideoFormat_H264 => "h264".into(),
        s if s == MFVideoFormat_HEVC => "hevc".into(),
        s if s == MFVideoFormat_AV1 => "av1".into(),
        s if s == MFVideoFormat_VP90 => "vp9".into(),
        // Video subtypes are FourCC GUIDs: the code is the first field.
        s => s
            .data1
            .to_le_bytes()
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .trim()
            .to_string(),
    }
}

impl MfDecoder {
    pub fn open(path: &Path) -> Result<MfDecoder, Error> {
        // SAFETY: COM and Media Foundation start-up, balanced in `Drop` (and below on failure).
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        if let Err(e) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            if com {
                unsafe { CoUninitialize() };
            }
            return Err(mf_error("start-up", e));
        }
        match unsafe { Self::open_reader(path) } {
            Ok((reader, stream, info, buffer_rows)) => Ok(MfDecoder {
                info,
                reader: Reader(reader),
                stream,
                buffer_rows,
                first_time: None,
                next: 0,
                done: false,
                com,
            }),
            Err(e) => {
                unsafe {
                    let _ = MFShutdown();
                    if com {
                        CoUninitialize();
                    }
                }
                Err(e)
            }
        }
    }

    unsafe fn open_reader(path: &Path) -> Result<(IMFSourceReader, u32, VideoInfo, usize), Error> {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 1).map_err(|e| mf_error("attributes", e))?;
        let attributes = attributes.ok_or_else(|| Error::Decode("no attribute store".into()))?;
        attributes
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(|e| mf_error("attributes", e))?;
        let url = HSTRING::from(path.as_os_str());
        let reader = MFCreateSourceReaderFromURL(&url, &attributes).map_err(|e| {
            Error::Unsupported(format!("Media Foundation cannot open the file: {e}"))
        })?;
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
        reader.SetStreamSelection(stream, true).map_err(|_| {
            Error::Unsupported("the file has no video track Media Foundation can read".into())
        })?;
        let native = reader
            .GetNativeMediaType(stream, 0)
            .map_err(|e| mf_error("native type", e))?;
        let get = |key| native.GetUINT32(key).ok();
        let transfer = match get(&MF_MT_TRANSFER_FUNCTION).map(|v| v as i32) {
            Some(v) if v == MFVideoTransFunc_2084.0 => Transfer::Pq,
            Some(v) if v == MFVideoTransFunc_HLG.0 => Transfer::Hlg,
            _ => Transfer::Sdr,
        };
        let matrix = match get(&MF_MT_YUV_MATRIX).map(|v| v as i32) {
            Some(v) if v == MFVideoTransferMatrix_BT709.0 => Some(Matrix::Bt709),
            Some(v) if v == MFVideoTransferMatrix_BT601.0 => Some(Matrix::Bt601),
            Some(v)
                if v == MFVideoTransferMatrix_BT2020_10.0
                    || v == MFVideoTransferMatrix_BT2020_12.0 =>
            {
                Some(Matrix::Bt2020)
            }
            _ => None,
        };
        let primaries = match get(&MF_MT_VIDEO_PRIMARIES).map(|v| v as i32) {
            Some(v) if v == MFVideoPrimaries_BT709.0 => Some(Primaries::Bt709),
            Some(v) if v == MFVideoPrimaries_BT2020.0 => Some(Primaries::Bt2020),
            Some(v)
                if v == MFVideoPrimaries_SMPTE170M.0 || v == MFVideoPrimaries_BT470_2_SysBG.0 =>
            {
                Some(Primaries::Bt601)
            }
            _ => None,
        };
        let full_range = get(&MF_MT_VIDEO_NOMINAL_RANGE) == Some(MFNominalRange_0_255.0 as u32);
        // MF_MT_VIDEO_ROTATION is counter-clockwise; ours is the clockwise turn for display.
        let rotation = normalise_rotation(-(get(&MF_MT_VIDEO_ROTATION).unwrap_or(0) as f64))?;
        let codec = codec_name(
            native
                .GetGUID(&MF_MT_SUBTYPE)
                .map_err(|e| mf_error("subtype", e))?,
        );
        // HDR transfers are coded at 10 bits; Media Foundation does not tag the depth of a compressed type.
        let ten_bit = transfer != Transfer::Sdr;
        let (subtype, format) = if ten_bit {
            (MFVideoFormat_P010, PixelFormat::P010)
        } else {
            (MFVideoFormat_NV12, PixelFormat::Nv12)
        };
        let wanted = MFCreateMediaType().map_err(|e| mf_error("media type", e))?;
        wanted
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|e| mf_error("media type", e))?;
        wanted
            .SetGUID(&MF_MT_SUBTYPE, &subtype)
            .map_err(|e| mf_error("media type", e))?;
        reader
            .SetCurrentMediaType(stream, None, &wanted)
            .map_err(|e| {
                Error::Unsupported(format!(
                    "Media Foundation cannot decode this track to 4:2:0 planes: {e}"
                ))
            })?;
        let (width, height, buffer_rows) = current_size(&reader, stream)?;
        let mut duration = None;
        if let Ok(mut value) =
            reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
        {
            let inner = &value.Anonymous.Anonymous;
            if inner.vt == VT_UI8 {
                duration = Some(inner.Anonymous.uhVal as f64 / 1e7);
            }
            let _ = PropVariantClear(&mut value as *mut PROPVARIANT);
        }
        Ok((
            reader,
            stream,
            VideoInfo {
                width,
                height,
                rotation,
                duration,
                frame_count: None,
                codec,
                bit_depth: if ten_bit { 10 } else { 8 },
                colour: Colour {
                    transfer,
                    matrix,
                    primaries,
                    full_range,
                },
                format,
                backend: Backend::MediaFoundation,
            },
            buffer_rows,
        ))
    }
}

/// The visible size of the current output type and the rows of its buffers.
unsafe fn current_size(
    reader: &IMFSourceReader,
    stream: u32,
) -> Result<(usize, usize, usize), Error> {
    let current = reader
        .GetCurrentMediaType(stream)
        .map_err(|e| mf_error("output type", e))?;
    let (coded_w, coded_h) = split(
        current
            .GetUINT64(&MF_MT_FRAME_SIZE)
            .map_err(|e| mf_error("frame size", e))?,
    );
    let mut area = MFVideoArea::default();
    let mut len = 0u32;
    let visible = current
        .GetBlob(
            &MF_MT_MINIMUM_DISPLAY_APERTURE,
            std::slice::from_raw_parts_mut(
                &mut area as *mut MFVideoArea as *mut u8,
                std::mem::size_of::<MFVideoArea>(),
            ),
            Some(&mut len),
        )
        .is_ok()
        && area.Area.cx > 0
        && area.Area.cy > 0;
    let (w, h) = if visible {
        (area.Area.cx as usize, area.Area.cy as usize)
    } else {
        (coded_w, coded_h)
    };
    Ok((w.min(coded_w), h.min(coded_h), coded_h))
}

impl Decoder for MfDecoder {
    fn info(&self) -> &VideoInfo {
        &self.info
    }

    fn read_frame(&mut self, frame: &mut Frame) -> Result<bool, Error> {
        if self.done {
            return Ok(false);
        }
        loop {
            let (mut flags, mut time) = (0u32, 0i64);
            let mut sample: Option<IMFSample> = None;
            // SAFETY: a synchronous read on the reader this decoder owns.
            unsafe {
                self.reader
                    .0
                    .ReadSample(
                        self.stream,
                        0,
                        None,
                        Some(&mut flags),
                        Some(&mut time),
                        Some(&mut sample),
                    )
                    .map_err(|e| mf_error("read", e))?;
            }
            if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                return Err(Error::Decode(
                    "Media Foundation reported a stream error".into(),
                ));
            }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                let (w, h, rows) = unsafe { current_size(&self.reader.0, self.stream)? };
                if (w, h) != (self.info.width, self.info.height) {
                    return Err(Error::Unsupported(format!(
                        "the frame size changed mid-stream ({}×{} → {w}×{h})",
                        self.info.width, self.info.height
                    )));
                }
                self.buffer_rows = rows;
            }
            let Some(sample) = sample else {
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    self.done = true;
                    return Ok(false);
                }
                continue;
            };
            unsafe { self.copy(&sample, frame)? };
            let first = *self.first_time.get_or_insert(time);
            frame.timestamp = (time - first) as f64 / 1e7;
            frame.index = self.next;
            self.next += 1;
            return Ok(true);
        }
    }
}

impl MfDecoder {
    /// Copies the visible planes of `sample` into `frame`. The UV plane starts `buffer_rows` rows after the Y plane.
    unsafe fn copy(&self, sample: &IMFSample, frame: &mut Frame) -> Result<(), Error> {
        let (format, width, height) = (self.info.format, self.info.width, self.info.height);
        pack_layout(frame, format, width, height);
        let buffer = sample
            .ConvertToContiguousBuffer()
            .map_err(|e| mf_error("buffer", e))?;
        let mut base: *mut u8 = std::ptr::null_mut();
        let mut pitch = 0i32;
        let two_d = buffer.cast::<IMF2DBuffer>().ok();
        let mut length = 0u32;
        match &two_d {
            Some(b) => b
                .Lock2D(&mut base, &mut pitch)
                .map_err(|e| mf_error("lock", e))?,
            None => {
                buffer
                    .Lock(&mut base, None, Some(&mut length))
                    .map_err(|e| mf_error("lock", e))?;
                pitch = (width * format.sample_bytes()) as i32;
            }
        }
        let stride = pitch.unsigned_abs() as usize;
        let dims = format.planes(width, height);
        let starts = [0, stride * self.buffer_rows];
        let needed = starts[1] + stride * dims[1].1;
        let ok = pitch > 0 && stride >= dims[0].0 && (two_d.is_some() || needed <= length as usize);
        if ok {
            for (p, &(row_bytes, rows)) in dims.iter().enumerate() {
                let dst = frame.planes[p].offset;
                for y in 0..rows {
                    let src =
                        std::slice::from_raw_parts(base.add(starts[p] + y * stride), row_bytes);
                    frame.data[dst + y * row_bytes..][..row_bytes].copy_from_slice(src);
                }
            }
        }
        let _ = match &two_d {
            Some(b) => b.Unlock2D(),
            None => buffer.Unlock(),
        };
        if ok {
            Ok(())
        } else {
            Err(Error::Decode(
                "a decoded frame's buffer is smaller than its planes".into(),
            ))
        }
    }
}

impl Drop for MfDecoder {
    fn drop(&mut self) {
        // SAFETY: balances `open`; the reader is released first.
        unsafe {
            let _ = self.reader.0.Flush(self.stream);
            let _ = MFShutdown();
            if self.com {
                CoUninitialize();
            }
        }
    }
}
