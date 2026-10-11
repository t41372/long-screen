//! The macOS backend: AVFoundation's `AVAssetReader` decoding the first video track through VideoToolbox into
//! bi-planar 4:2:0 pixel buffers of the stream's own depth and range (`420v`/`420f` for 8-bit, `x420`/`xf20` for
//! 10-bit), so no colour conversion happens on the way. Sample timestamps are the track's presentation times after
//! its edit list.

use crate::decode::{
    normalise_rotation, pack_layout, Backend, Colour, Decoder, Error, Frame, Matrix, PixelFormat,
    Primaries, Transfer, VideoInfo,
};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack, AVMediaTypeVideo,
    AVURLAsset,
};
use objc2_core_foundation::{CFBoolean, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    kCMFormatDescriptionExtension_BitsPerComponent, kCMFormatDescriptionExtension_ColorPrimaries,
    kCMFormatDescriptionExtension_FullRangeVideo, kCMFormatDescriptionExtension_TransferFunction,
    kCMFormatDescriptionExtension_YCbCrMatrix, CMFormatDescription, CMSampleBuffer, CMTime,
};
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
    kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBuffer,
    CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
    CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
use std::path::Path;

/// The reader and its output. AppKit-free AVFoundation objects may be used from any thread as long as only one uses
/// them at a time, which `&mut self` guarantees.
struct Reader {
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
}

// SAFETY: see `Reader`; the objects are owned here alone and only touched through `&mut AvfDecoder`.
unsafe impl Send for Reader {}

pub struct AvfDecoder {
    info: VideoInfo,
    reader: Reader,
    /// The first frame, read by `open` to learn the buffers' size and format.
    pending: Option<Frame>,
    first_pts: Option<CMTime>,
    next: u64,
}

fn string(value: Option<CFRetained<CFType>>) -> Option<String> {
    value.and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()))
}

fn ns_error(error: &objc2_foundation::NSError) -> String {
    error.localizedDescription().to_string()
}

fn codec_name(subtype: u32) -> String {
    let fourcc: String = subtype.to_be_bytes().iter().map(|&b| b as char).collect();
    match fourcc.as_str() {
        "avc1" | "avc3" => "h264".into(),
        "hvc1" | "hev1" => "hevc".into(),
        "av01" => "av1".into(),
        "vp09" => "vp9".into(),
        "ap4h" | "ap4x" | "apch" | "apcn" | "apcs" | "apco" => "prores".into(),
        _ => fourcc.trim().to_string(),
    }
}

impl AvfDecoder {
    pub fn open(path: &Path) -> Result<AvfDecoder, Error> {
        autoreleasepool(|_| Self::open_inner(path))
    }

    fn open_inner(path: &Path) -> Result<AvfDecoder, Error> {
        let path_str = path
            .canonicalize()
            .map_err(|e| Error::Io(format!("{}: {e}", path.display())))?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path_str.to_string_lossy()));
        // SAFETY: plain AVFoundation calls on objects this function owns.
        unsafe {
            let asset = AVURLAsset::URLAssetWithURL_options(&url, None);
            let video =
                AVMediaTypeVideo.ok_or_else(|| Error::Decode("AVMediaTypeVideo missing".into()))?;
            #[allow(deprecated)]
            let tracks = asset.tracksWithMediaType(video);
            let track: Retained<AVAssetTrack> = tracks.firstObject().ok_or_else(|| {
                Error::Unsupported("the file has no video track AVFoundation can read".into())
            })?;
            let descriptions = track.formatDescriptions();
            let description: &CMFormatDescription = descriptions
                .firstObject()
                .map(|d| &*(Retained::as_ptr(&d) as *const CMFormatDescription))
                .ok_or_else(|| {
                    Error::Unsupported("the video track has no format description".into())
                })?;
            let ext = |key: &CFString| {
                description
                    .extension(key)
                    .map(|v| CFRetained::cast_unchecked::<CFType>(v))
            };
            let transfer =
                match string(ext(kCMFormatDescriptionExtension_TransferFunction)).as_deref() {
                    Some("SMPTE_ST_2084_PQ") => Transfer::Pq,
                    Some("ITU_R_2100_HLG") => Transfer::Hlg,
                    _ => Transfer::Sdr,
                };
            let matrix = match string(ext(kCMFormatDescriptionExtension_YCbCrMatrix)).as_deref() {
                Some("ITU_R_709_2") => Some(Matrix::Bt709),
                Some("ITU_R_601_4" | "SMPTE_240M_1995") => Some(Matrix::Bt601),
                Some("ITU_R_2020") => Some(Matrix::Bt2020),
                _ => None,
            };
            let primaries =
                match string(ext(kCMFormatDescriptionExtension_ColorPrimaries)).as_deref() {
                    Some("ITU_R_709_2") => Some(Primaries::Bt709),
                    Some("ITU_R_2020") => Some(Primaries::Bt2020),
                    Some("P3_D65") => Some(Primaries::DisplayP3),
                    Some("EBU_3213" | "SMPTE_C") => Some(Primaries::Bt601),
                    _ => None,
                };
            let full_range = ext(kCMFormatDescriptionExtension_FullRangeVideo)
                .and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool()))
                .unwrap_or(false);
            let bits = ext(kCMFormatDescriptionExtension_BitsPerComponent)
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i32()));
            // HDR transfers are only coded at 10 bits or more; untagged depth otherwise means 8.
            let bit_depth = bits
                .map(|b| b as u8)
                .unwrap_or(if transfer == Transfer::Sdr { 8 } else { 10 });
            let pixel_format = match (bit_depth > 8, full_range) {
                (false, false) => kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                (false, true) => kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                (true, false) => kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
                (true, true) => kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
            };
            let t = track.preferredTransform();
            #[allow(
                clippy::disallowed_methods,
                reason = "the angle is only rounded to a quarter turn, which the last bit of atan2 cannot move"
            )]
            let rotation = normalise_rotation(t.b.atan2(t.a).to_degrees())?;
            let duration = {
                let d = asset.duration();
                (d.timescale > 0).then(|| d.value as f64 / d.timescale as f64)
            };
            let frame_count = presented_frames(&track);

            let reader = AVAssetReader::assetReaderWithAsset_error(&asset).map_err(|e| {
                Error::Unsupported(format!(
                    "AVFoundation cannot read the file: {}",
                    ns_error(&e)
                ))
            })?;
            // SAFETY: toll-free bridged CFString → NSString.
            let key: &NSString =
                &*(kCVPixelBufferPixelFormatTypeKey as *const CFString as *const NSString);
            let value: Retained<AnyObject> = Retained::into_super(Retained::into_super(
                Retained::into_super(NSNumber::new_u32(pixel_format)),
            ));
            let settings =
                NSDictionary::<NSString, AnyObject>::from_retained_objects(&[key], &[value]);
            let output = AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(
                &track,
                Some(&settings),
            );
            output.setAlwaysCopiesSampleData(false);
            if !reader.canAddOutput(&output) {
                return Err(Error::Unsupported(
                    "AVFoundation cannot decode this track to 4:2:0 planes".into(),
                ));
            }
            reader.addOutput(&output);
            if !reader.startReading() {
                let why = reader.error().map(|e| ns_error(&e)).unwrap_or_default();
                return Err(Error::Unsupported(format!(
                    "AVFoundation cannot decode the track: {why}"
                )));
            }
            let format = if bit_depth > 8 {
                PixelFormat::P010
            } else {
                PixelFormat::Nv12
            };
            let mut decoder = AvfDecoder {
                info: VideoInfo {
                    width: 0,
                    height: 0,
                    rotation,
                    duration,
                    frame_count,
                    codec: codec_name(description.media_sub_type()),
                    bit_depth,
                    colour: Colour {
                        transfer,
                        matrix,
                        primaries,
                        full_range,
                    },
                    format,
                    backend: Backend::AvFoundation,
                },
                reader: Reader { reader, output },
                pending: None,
                first_pts: None,
                next: 0,
            };
            let mut first = Frame::default();
            if !decoder.decode(&mut first)? {
                return Err(Error::Unsupported("the video track has no frames".into()));
            }
            decoder.pending = Some(first);
            Ok(decoder)
        }
    }

    /// Decodes the next sample into `frame` (sizing `info` from the first one).
    fn decode(&mut self, frame: &mut Frame) -> Result<bool, Error> {
        autoreleasepool(|_| loop {
            // SAFETY: the reader and output are owned by this decoder; see `Reader`.
            let sample: Option<Retained<CMSampleBuffer>> =
                unsafe { self.reader.output.copyNextSampleBuffer() };
            let Some(sample) = sample else {
                let reader = &self.reader.reader;
                // SAFETY: as above.
                return unsafe {
                    if reader.status() == AVAssetReaderStatus::Failed {
                        let why = reader.error().map(|e| ns_error(&e)).unwrap_or_default();
                        Err(Error::Decode(format!("AVFoundation: {why}")))
                    } else {
                        Ok(false)
                    }
                };
            };
            // SAFETY: a sample buffer from the output; markers without an image are skipped.
            let Some(image) = (unsafe { sample.image_buffer() }) else {
                continue;
            };
            let pts = unsafe { sample.presentation_time_stamp() };
            self.copy(&image, frame)?;
            let first = *self.first_pts.get_or_insert(pts);
            frame.timestamp = seconds(pts) - seconds(first);
            frame.index = self.next;
            self.next += 1;
            return Ok(true);
        })
    }

    #[allow(non_upper_case_globals)] // CoreVideo's format constants, matched by name
    fn copy(&mut self, buffer: &CVPixelBuffer, frame: &mut Frame) -> Result<(), Error> {
        let (width, height) = (
            CVPixelBufferGetWidth(buffer),
            CVPixelBufferGetHeight(buffer),
        );
        let format = match CVPixelBufferGetPixelFormatType(buffer) {
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            | kCVPixelFormatType_420YpCbCr8BiPlanarFullRange => PixelFormat::Nv12,
            kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
            | kCVPixelFormatType_420YpCbCr10BiPlanarFullRange => PixelFormat::P010,
            other => {
                return Err(Error::Decode(format!(
                    "AVFoundation returned pixel format {}",
                    String::from_utf8_lossy(&other.to_be_bytes())
                )))
            }
        };
        if self.info.width == 0 {
            (self.info.width, self.info.height, self.info.format) = (width, height, format);
        } else if (width, height, format) != (self.info.width, self.info.height, self.info.format) {
            return Err(Error::Unsupported(format!(
                "the frame size or format changed mid-stream ({}×{} → {width}×{height})",
                self.info.width, self.info.height
            )));
        }
        pack_layout(frame, format, width, height);
        let read_only = CVPixelBufferLockFlags::ReadOnly;
        // SAFETY: the buffer is locked for reading while its planes are copied; each row read lies inside the plane
        // (`bytes per row ≥ row_bytes`, `rows` = the plane's height for a 4:2:0 buffer of this size).
        unsafe {
            if CVPixelBufferLockBaseAddress(buffer, read_only) != 0 {
                return Err(Error::Decode("could not lock a decoded frame".into()));
            }
            let dims = format.planes(width, height);
            for (p, &(row_bytes, rows)) in dims.iter().enumerate() {
                let base = CVPixelBufferGetBaseAddressOfPlane(buffer, p) as *const u8;
                let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, p);
                if base.is_null() || stride < row_bytes {
                    CVPixelBufferUnlockBaseAddress(buffer, read_only);
                    return Err(Error::Decode("a decoded frame has no plane data".into()));
                }
                let dst = frame.planes[p].offset;
                for y in 0..rows {
                    let src = std::slice::from_raw_parts(base.add(y * stride), row_bytes);
                    frame.data[dst + y * row_bytes..][..row_bytes].copy_from_slice(src);
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, read_only);
        }
        Ok(())
    }
}

/// The frames `AVAssetReader` will present: the track's samples whose presentation time lies in its edit, the
/// half-open media-time range `[start, start + duration)` of its one non-empty segment, compared exactly. A sample
/// the container lists at or past the edit's end (iPhone and macOS recordings commonly hold one) is not presented,
/// nor is one before its start. Read with a sample cursor over the track's sample table, without decoding; checked
/// against the frames decoded from every public test recording. `None` when the track offers no sample cursors or
/// has more than one non-empty edit (the web app rejects that layout too), rather than a count that might be wrong.
///
/// SAFETY: plain AVFoundation calls on a track the caller owns.
unsafe fn presented_frames(track: &AVAssetTrack) -> Option<u64> {
    let segments = track.segments();
    let mut edits = segments.iter().filter(|s| !s.isEmpty());
    let edit = edits.next()?.timeMapping().source;
    if edits.next().is_some() || !track.canProvideSampleCursors() {
        return None;
    }
    let (start, length) = (edit.start, edit.duration);
    if start.timescale <= 0 || length.timescale <= 0 {
        return None;
    }
    let cursor = track.makeSampleCursorAtFirstSampleInDecodeOrder()?;
    let mut count = 0u64;
    loop {
        let pts = cursor.presentationTimeStamp();
        if pts.timescale <= 0 {
            return None;
        }
        // pts ∈ [start, start + length), on the common denominator of the three timescales.
        let (p, s, l) = (
            pts.timescale as i128,
            start.timescale as i128,
            length.timescale as i128,
        );
        let at = pts.value as i128 * s * l;
        let from = start.value as i128 * p * l;
        let span = length.value as i128 * p * s;
        if at >= from && at < from + span {
            count += 1;
        }
        if cursor.stepInDecodeOrderByCount(1) != 1 {
            break;
        }
    }
    (count > 0).then_some(count)
}

fn seconds(t: CMTime) -> f64 {
    t.value as f64 / t.timescale as f64
}

impl Decoder for AvfDecoder {
    fn info(&self) -> &VideoInfo {
        &self.info
    }

    fn read_frame(&mut self, frame: &mut Frame) -> Result<bool, Error> {
        if let Some(first) = self.pending.take() {
            *frame = first;
            return Ok(true);
        }
        self.decode(frame)
    }
}

impl Drop for AvfDecoder {
    fn drop(&mut self) {
        // SAFETY: as in `decode`.
        unsafe { self.reader.reader.cancelReading() };
    }
}
