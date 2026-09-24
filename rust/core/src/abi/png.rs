//! PNG scanline (un)filtering for the streaming single-PNG export path, and the tile codec
//! (`ls_png_encode`/`ls_png_decode`, `png` crate end to end — see the dependency audit in the R3-1 spec:
//! `Compression::Fast` + the crate's default Adaptive filter is ~5.5× faster than the previous
//! Sub-filter + `CompressionStream` + JS CRC32 path, for +8.6% bytes; the owner chose this setting).

use crate::abi::memory::{slice, slice_mut, HandleTable};
use crate::abi::{STATUS_BAD_ARGUMENT, STATUS_BAD_FILTER, STATUS_OK};
use crate::png::{expand_to_rgba, filter_sub_rgba, unfilter_to_rgba};
use std::io::Cursor;

/// PNG scanline reconstruction to RGBA. Returns 0, STATUS_BAD_ARGUMENT, or STATUS_BAD_FILTER − filter byte.
#[no_mangle]
pub extern "C" fn ls_png_unfilter(
    raw: u32,
    width: u32,
    height: u32,
    channels: u32,
    out: u32,
) -> i32 {
    let (w, h, c) = (width as usize, height as usize, channels as usize);
    if w == 0 || h == 0 || !(1..=4).contains(&c) {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(raw, (w * c + 1) * h) }, unsafe {
        slice_mut(out, w * h * 4)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    // A bad filter byte is reported as -(256 + byte) so the adapter can name the offending value.
    match unfilter_to_rgba(src, w, h, c, dst) {
        Ok(()) => crate::abi::STATUS_OK,
        Err(filter) => crate::abi::STATUS_BAD_FILTER - filter as i32,
    }
}

/// Sub-filters RGBA rows for PNG encoding; `out` receives `height × (width×4 + 1)` bytes.
#[no_mangle]
pub extern "C" fn ls_png_filter_sub(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, (w * 4 + 1) * h)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    filter_sub_rgba(src, w, h, dst);
    crate::abi::STATUS_OK
}

// --- Tile codec: encode RGBA -> PNG bytes, decode PNG bytes -> RGBA, on the `png` crate. ---

/// Any decode failure other than an invalid scanline filter byte (`STATUS_BAD_FILTER` range, see below).
/// `src/codec/png.ts::decodePNG` validates the container (signature, per-chunk CRC via `ls_crc32`, IHDR
/// colour/depth/interlace, truncation, IHDR/IEND presence) itself before ever calling `ls_png_decode`, so in
/// practice this status should not be reachable from that caller — every rejection case it is tested against
/// (`tests/unit/codec.test.ts`) is already thrown by that container walk with its existing message text.
pub const STATUS_PNG_DECODE_FAILED: i32 = -2;

static mut ENCODE_HANDLES: HandleTable<Vec<u8>> = HandleTable::new();
fn encode_handles() -> &'static mut HandleTable<Vec<u8>> {
    // SAFETY: only the main instance touches ENCODE_HANDLES, and only through these exported entry points —
    // no pool helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(ENCODE_HANDLES) }
}

/// Encodes `width×height` RGBA pixels as a complete PNG file (8-bit, colour type RGBA, `Compression::Fast`
/// with the crate's default Adaptive filter — not overridden, matching the dependency audit's chosen
/// setting). Returns a handle (> 0), drained by `ls_png_encode_len`/`_read`/`_free`, or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
pub extern "C" fn ls_png_encode(rgba: u32, width: u32, height: u32) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(src) = (unsafe { slice(rgba, width as usize * height as usize * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let Ok(mut writer) = enc.write_header() else {
            return STATUS_BAD_ARGUMENT;
        };
        if writer.write_image_data(src).is_err() || writer.finish().is_err() {
            return STATUS_BAD_ARGUMENT;
        }
    }
    encode_handles().insert(out)
}

#[no_mangle]
pub extern "C" fn ls_png_encode_len(handle: u32) -> i32 {
    match encode_handles().get(handle) {
        Some(bytes) => bytes.len() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_png_encode_read(handle: u32, out: u32) -> i32 {
    let Some(bytes) = encode_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output, sized from `ls_png_encode_len`.
    let Some(dst) = (unsafe { slice_mut(out, bytes.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(bytes);
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_png_encode_free(handle: u32) {
    encode_handles().free(handle);
}

/// Classifies a `png` crate decode failure. `DecodingError`'s format-error detail is a private enum (only its
/// `Display` text is public API), so an invalid filter byte — the one rejection case that must carry its
/// specific value in the returned status, matching `ls_png_unfilter`'s convention — is recovered by parsing
/// the crate's own "Unknown filter method N." message, which its `Display` impl (`png::decoder::stream`)
/// documents as stable wording for that variant. Anything else becomes `STATUS_PNG_DECODE_FAILED`.
fn classify(err: &png::DecodingError) -> i32 {
    let text = err.to_string();
    if let Some(rest) = text.strip_prefix("Unknown filter method ") {
        if let Ok(n) = rest.trim_end_matches('.').parse::<u8>() {
            return STATUS_BAD_FILTER - n as i32;
        }
    }
    STATUS_PNG_DECODE_FAILED
}

/// Decodes a complete PNG file into RGBA. `cap` must equal `width×height×4` from the caller's own IHDR read
/// (`src/codec/png.ts::decodePNG`, which validates the container before this call — see
/// `STATUS_PNG_DECODE_FAILED` above). Only the scanline predictor's filter-type byte lives inside the deflate
/// stream, invisible to that container walk, so it is the one failure this call must still distinguish:
/// returns `STATUS_OK`, `STATUS_BAD_ARGUMENT`, or `STATUS_BAD_FILTER − filter_byte` (same convention as
/// `ls_png_unfilter`, so `src/core/wasm/exports.ts::check()` needs no change).
#[no_mangle]
pub extern "C" fn ls_png_decode(src: u32, len: u32, out: u32, cap: u32) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(bytes), Some(dst)) = (unsafe { slice(src, len as usize) }, unsafe {
        slice_mut(out, cap as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = match decoder.read_info() {
        Ok(r) => r,
        Err(e) => return classify(&e),
    };
    let Some(buf_len) = reader.output_buffer_size() else {
        return STATUS_PNG_DECODE_FAILED;
    };
    let mut raw = vec![0u8; buf_len];
    if let Err(e) = reader.next_frame(&mut raw) {
        return classify(&e);
    }
    let (color_type, depth) = reader.output_color_type();
    if depth != png::BitDepth::Eight {
        return STATUS_PNG_DECODE_FAILED;
    }
    let channels = match color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return STATUS_PNG_DECODE_FAILED,
    };
    let (width, height) = reader.info().size();
    if cap as u64 != width as u64 * height as u64 * 4 {
        return STATUS_BAD_ARGUMENT;
    }
    expand_to_rgba(&raw, channels, dst);
    STATUS_OK
}

/// One-shot CRC32 (`crc32fast`, hardware-accelerated where available) for `src/codec/png.ts`'s per-chunk PNG
/// CRC checks, where the bytes to hash are already one contiguous slice — replaces the hand-rolled JS CRC32
/// table it used. `ls_crc32_new`/`_update`/`_digest` below is the incremental form.
#[no_mangle]
pub extern "C" fn ls_crc32(ptr: u32, len: u32) -> u32 {
    // SAFETY: adapter-owned buffer, bounds checked.
    match unsafe { slice(ptr, len as usize) } {
        Some(bytes) => crc32fast::hash(bytes),
        None => 0,
    }
}

static mut CRC_HANDLES: HandleTable<crc32fast::Hasher> = HandleTable::new();
fn crc_handles() -> &'static mut HandleTable<crc32fast::Hasher> {
    // SAFETY: only the main instance touches CRC_HANDLES, and only through these exported entry points — no
    // pool helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(CRC_HANDLES) }
}

/// Incremental CRC32 for a streaming caller that sees its data in bounded chunks and must not buffer a whole
/// file to hash it (`src/export/zip.ts`'s per-entry CRC, and `src/codec/png.ts::chunk()`'s type+body CRC).
/// Returns a handle (> 0) or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
pub extern "C" fn ls_crc32_new() -> i32 {
    crc_handles().insert(crc32fast::Hasher::new())
}

#[no_mangle]
pub extern "C" fn ls_crc32_update(handle: u32, ptr: u32, len: u32) -> i32 {
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(bytes) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(hasher) = crc_handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    hasher.update(bytes);
    STATUS_OK
}

/// Reads the digest without consuming the handle: `src/export/zip.ts::ZipWriter.add` reads the same running
/// CRC twice (the data descriptor, then the central-directory record) before the entry is done. Callers free
/// the handle explicitly with `ls_crc32_free` once they are (`Crc32` in `src/core/wasm/png.ts`).
#[no_mangle]
pub extern "C" fn ls_crc32_digest(handle: u32) -> u32 {
    match crc_handles().get(handle) {
        Some(hasher) => hasher.clone().finalize(),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn ls_crc32_free(handle: u32) {
    crc_handles().free(handle);
}
