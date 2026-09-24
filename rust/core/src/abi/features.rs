//! Feature extraction, matching, and visual-word hashing.

use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::{read_rects, FEATURE_BYTES, MATCH_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::features::{extract_features, feature_words, match_features, Feature, DESCRIPTOR_WORDS};

#[no_mangle]
pub extern "C" fn ls_feature_bytes() -> u32 {
    FEATURE_BYTES as u32
}

#[no_mangle]
pub extern "C" fn ls_match_bytes() -> u32 {
    MATCH_BYTES as u32
}

pub(crate) fn write_features(features: &[Feature], out: &mut [u8]) {
    for (f, dst) in features.iter().zip(out.chunks_exact_mut(FEATURE_BYTES)) {
        dst[0..4].copy_from_slice(&f.x.to_le_bytes());
        dst[4..8].copy_from_slice(&f.y.to_le_bytes());
        dst[8..12].copy_from_slice(&(f.score as f32).to_le_bytes());
        for (k, word) in f.descriptor.iter().enumerate() {
            dst[12 + k * 4..16 + k * 4].copy_from_slice(&word.to_le_bytes());
        }
    }
}

pub(crate) fn read_features(bytes: &[u8]) -> Vec<Feature> {
    bytes
        .chunks_exact(FEATURE_BYTES)
        .map(|c| {
            let mut descriptor = [0u32; DESCRIPTOR_WORDS];
            for (k, word) in descriptor.iter_mut().enumerate() {
                *word = u32::from_le_bytes(c[12 + k * 4..16 + k * 4].try_into().unwrap());
            }
            Feature {
                x: i32::from_le_bytes(c[0..4].try_into().unwrap()),
                y: i32::from_le_bytes(c[4..8].try_into().unwrap()),
                score: f32::from_le_bytes(c[8..12].try_into().unwrap()) as f64,
                descriptor,
            }
        })
        .collect()
}

/// Extracts up to `max_features` into `out` (capacity `max_features × FEATURE_BYTES`); returns the count.
/// `roi` is zero or a pointer to one 32-byte rect.
#[no_mangle]
pub extern "C" fn ls_extract_features(
    gray: u32,
    width: u32,
    height: u32,
    max_features: u32,
    roi: u32,
    out: u32,
) -> i32 {
    let (w, h, max) = (width as usize, height as usize, max_features as usize);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(gray, w * h) }, unsafe {
        slice_mut(out, max * FEATURE_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let roi = if roi == 0 {
        None
    } else {
        // SAFETY: one rect, bounds checked.
        match unsafe { slice(roi, 32) } {
            Some(bytes) => read_rects(bytes).into_iter().next(),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let features = extract_features(src, w, h, max, roi);
    write_features(&features, dst);
    features.len() as i32
}

/// Matches two serialised feature arrays; `out` holds up to `2 × count_a` matches. Returns the count.
#[no_mangle]
pub extern "C" fn ls_match_features(
    a: u32,
    count_a: u32,
    b: u32,
    count_b: u32,
    include_ambiguous: u32,
    out: u32,
) -> i32 {
    let (na, nb) = (count_a as usize, count_b as usize);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(fa), Some(fb), Some(dst)) = (
        unsafe { slice(a, na * FEATURE_BYTES) },
        unsafe { slice(b, nb * FEATURE_BYTES) },
        unsafe { slice_mut(out, na * 2 * MATCH_BYTES) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let matches = match_features(
        &read_features(fa),
        &read_features(fb),
        include_ambiguous != 0,
    );
    for (m, d) in matches.iter().zip(dst.chunks_exact_mut(MATCH_BYTES)) {
        d[0..4].copy_from_slice(&m.a.to_le_bytes());
        d[4..8].copy_from_slice(&m.b.to_le_bytes());
        d[8..10].copy_from_slice(&m.distance.to_le_bytes());
        d[10] = m.unique as u8;
        d[11] = 0;
    }
    matches.len() as i32
}

/// Visual words for serialised features; `out` holds up to `4 × count` u32 words. Returns the count.
#[no_mangle]
pub extern "C" fn ls_feature_words(features: u32, count: u32, out: u32) -> i32 {
    let n = count as usize;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(features, n * FEATURE_BYTES) }, unsafe {
        slice_mut(out, n * 4 * 4)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let descriptors: Vec<[u32; DESCRIPTOR_WORDS]> = read_features(src)
        .into_iter()
        .map(|f| f.descriptor)
        .collect();
    let words = feature_words(&descriptors);
    for (word, d) in words.iter().zip(dst.chunks_exact_mut(4)) {
        d.copy_from_slice(&word.to_le_bytes());
    }
    words.len() as i32
}
