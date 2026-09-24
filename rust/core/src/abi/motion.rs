//! Translation/scale hypotheses, verification, refinement (native and patch-based) and motion-field
//! estimation.

use crate::abi::features::read_features;
use crate::abi::memory::{slice, slice_mut};
use crate::abi::wire::{
    read_optional_rect, read_rect, EXTRACTED_PATCH_HEADER_BYTES, MATCH_POINT_BYTES, MOTION_BYTES,
    MOTION_FIELD_HEADER_BYTES, PATCH_BYTES, POINT_BYTES, REFINEMENT_BYTES,
};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::motion::{
    audit_translation, detect_scale, estimate_motion, extract_patches, probe_scale, refine_native,
    refine_patches, refine_translation, resample_gray, translation_hypotheses, verify_translation,
    Gray, MatchPoints, Motion, NativeRefinement, Patch, Point,
};

/// # Safety
/// `ptr` points at `count × MATCH_POINT_BYTES` readable bytes.
pub(crate) unsafe fn read_match_points(ptr: u32, count: u32) -> Option<Vec<MatchPoints>> {
    let bytes = slice(ptr, count as usize * MATCH_POINT_BYTES)?;
    let f = |c: &[u8], i: usize| f64::from_le_bytes(c[i..i + 8].try_into().unwrap());
    Some(
        bytes
            .chunks_exact(MATCH_POINT_BYTES)
            .map(|c| MatchPoints {
                ax: f(c, 0),
                ay: f(c, 8),
                bx: f(c, 16),
                by: f(c, 24),
                unique: c[32] != 0,
            })
            .collect(),
    )
}

fn write_motions(motions: &[Motion], out: &mut [u8]) {
    for (m, d) in motions.iter().zip(out.chunks_exact_mut(MOTION_BYTES)) {
        d[0..8].copy_from_slice(&m.x.to_le_bytes());
        d[8..16].copy_from_slice(&m.y.to_le_bytes());
        d[16..20].copy_from_slice(&m.support.to_le_bytes());
        d[20..24].copy_from_slice(&m.unique.to_le_bytes());
        d[24..32].copy_from_slice(&m.confidence.to_le_bytes());
        d[32..40].copy_from_slice(&m.error.to_le_bytes());
        d[40..44].copy_from_slice(&(m.ambiguous as u32).to_le_bytes());
        d[44..48].fill(0);
    }
}

/// # Safety
/// Gray pointer covers `width × height` bytes.
unsafe fn read_gray<'a>(ptr: u32, width: u32, height: u32) -> Option<Gray<'a>> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return None;
    }
    slice(ptr, w * h).map(|data| Gray {
        width: w,
        height: h,
        data,
    })
}

/// Translation hypotheses from `count` match points; `out` holds `max` motions. Returns the count.
#[no_mangle]
pub extern "C" fn ls_translation_hypotheses(matches: u32, count: u32, max: u32, out: u32) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(points), Some(dst)) = (unsafe { read_match_points(matches, count) }, unsafe {
        slice_mut(out, max as usize * MOTION_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let motions = translation_hypotheses(&points, max as usize);
    write_motions(&motions, dst);
    motions.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_detect_scale(matches: u32, count: u32) -> f64 {
    // SAFETY: adapter-owned buffers, bounds checked.
    match unsafe { read_match_points(matches, count) } {
        Some(points) => detect_scale(&points),
        None => 1.0,
    }
}

/// Retained-75% block error; NaN signals a bad argument (a real result is finite or +∞).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_verify_translation(
    a: u32,
    aw: u32,
    ah: u32,
    b: u32,
    bw: u32,
    bh: u32,
    dx: f64,
    dy: f64,
    roi: u32,
) -> f64 {
    // SAFETY: adapter-owned buffers, bounds checked.
    match unsafe {
        (
            read_gray(a, aw, ah),
            read_gray(b, bw, bh),
            read_optional_rect(roi),
        )
    } {
        (Some(a), Some(b), Ok(roi)) => verify_translation(a, b, dx, dy, roi),
        _ => f64::NAN,
    }
}

/// Audit; `out` receives 8 × f64: error, mismatch, overlap, samples, blocks, agreeing, agreement, agreeingError.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_audit_translation(
    a: u32,
    aw: u32,
    ah: u32,
    b: u32,
    bw: u32,
    bh: u32,
    dx: f64,
    dy: f64,
    roi: u32,
    tolerant: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(a), Some(b), Ok(roi), Some(dst)) = (
        unsafe { read_gray(a, aw, ah) },
        unsafe { read_gray(b, bw, bh) },
        unsafe { read_optional_rect(roi) },
        unsafe { slice_mut(out, 64) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = audit_translation(a, b, dx, dy, roi, tolerant != 0);
    for (i, v) in [
        r.error,
        r.mismatch,
        r.overlap,
        r.samples as f64,
        r.blocks as f64,
        r.agreeing as f64,
        r.agreement,
        r.agreeing_error,
    ]
    .iter()
    .enumerate()
    {
        dst[i * 8..i * 8 + 8].copy_from_slice(&v.to_le_bytes());
    }
    crate::abi::STATUS_OK
}

/// Integer refinement; `out` receives 2 × i32.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_refine_translation(
    a: u32,
    aw: u32,
    ah: u32,
    b: u32,
    bw: u32,
    bh: u32,
    px: f64,
    py: f64,
    roi: u32,
    radius: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(a), Some(b), Ok(roi), Some(dst)) = (
        unsafe { read_gray(a, aw, ah) },
        unsafe { read_gray(b, bw, bh) },
        unsafe { read_optional_rect(roi) },
        unsafe { slice_mut(out, 8) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (x, y) = refine_translation(a, b, Point { x: px, y: py }, roi, radius as i32);
    dst[0..4].copy_from_slice(&x.to_le_bytes());
    dst[4..8].copy_from_slice(&y.to_le_bytes());
    crate::abi::STATUS_OK
}

/// Motion field of `b` (current) against `a` (previous), both `width × height`. `out` layout:
/// header (MOTION_FIELD_HEADER_BYTES), 8 motion slots (MOTION_BYTES each), then labels, confidence and
/// dynamic (`cols × rows` bytes each). The adapter sizes it from the same cell size (24).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_estimate_motion(
    a: u32,
    b: u32,
    width: u32,
    height: u32,
    matches: u32,
    count: u32,
    feature_count: u32,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    let n = w.div_ceil(24) * h.div_ceil(24);
    let out_len = MOTION_FIELD_HEADER_BYTES + 8 * MOTION_BYTES + 3 * n;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(a), Some(b), Some(points), Some(dst)) = (
        unsafe { read_gray(a, width, height) },
        unsafe { read_gray(b, width, height) },
        unsafe { read_match_points(matches, count) },
        unsafe { slice_mut(out, out_len) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let field = estimate_motion(a, b, &points, feature_count);
    if field.motions.len() > 8 || field.cols * field.rows != n {
        return STATUS_BAD_ARGUMENT;
    }
    dst[0..4].copy_from_slice(&(field.cols as u32).to_le_bytes());
    dst[4..8].copy_from_slice(&(field.rows as u32).to_le_bytes());
    dst[8..12].copy_from_slice(&(field.cell as u32).to_le_bytes());
    dst[12..16].copy_from_slice(&(field.motions.len() as u32).to_le_bytes());
    dst[16..24].copy_from_slice(&field.difference.to_le_bytes());
    dst[24..28].copy_from_slice(&field.feature_count.to_le_bytes());
    dst[28..32].copy_from_slice(&(field.unknown as u32).to_le_bytes());
    dst[32..40].copy_from_slice(&field.zoom.to_le_bytes());
    write_motions(&field.motions, &mut dst[MOTION_FIELD_HEADER_BYTES..]);
    let base = MOTION_FIELD_HEADER_BYTES + 8 * MOTION_BYTES;
    dst[base..base + n].copy_from_slice(&field.labels);
    dst[base + n..base + 2 * n].copy_from_slice(&field.confidence);
    dst[base + 2 * n..base + 3 * n].copy_from_slice(&field.dynamic);
    crate::abi::STATUS_OK
}

fn write_refinement(r: &NativeRefinement, dst: &mut [u8]) {
    dst[0..4].copy_from_slice(&r.x.to_le_bytes());
    dst[4..8].copy_from_slice(&r.y.to_le_bytes());
    dst[8..16].copy_from_slice(&r.error.to_le_bytes());
    dst[16..20].copy_from_slice(&r.samples.to_le_bytes());
    dst[20..24].fill(0);
    dst[24..32].copy_from_slice(&r.runner_up.to_le_bytes());
}

/// Native refinement of RGBA `b` against `a`; `labels` is zero (no mask) or an atlas label plane.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_refine_native(
    a: u32,
    b: u32,
    width: u32,
    height: u32,
    gx: f64,
    gy: f64,
    region: u32,
    labels: u32,
    code: u32,
    radius: u32,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    if w < 4 || h < 4 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(a), Some(b), Some(region), Some(dst)) = (
        unsafe { slice(a, w * h * 4) },
        unsafe { slice(b, w * h * 4) },
        unsafe { slice(region, 32) },
        unsafe { slice_mut(out, REFINEMENT_BYTES) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mask = if labels == 0 {
        None
    } else {
        // SAFETY: label plane covers the frame.
        match unsafe { slice(labels, w * h) } {
            Some(l) => Some((l, code as u8)),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let r = refine_native(
        a,
        b,
        w,
        h,
        Point { x: gx, y: gy },
        read_rect(region),
        mask,
        radius as i32,
    );
    write_refinement(&r, dst);
    crate::abi::STATUS_OK
}

/// Patch refinement in native luma; `patches` points at `count` PATCH_BYTES descriptors.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_refine_patches(
    patches: u32,
    count: u32,
    native: u32,
    width: u32,
    height: u32,
    region: u32,
    gx: f64,
    gy: f64,
    radius: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(native), Some(region), Some(descriptors), Some(dst)) = (
        unsafe { read_gray(native, width, height) },
        unsafe { slice(region, 32) },
        unsafe { slice(patches, count as usize * PATCH_BYTES) },
        unsafe { slice_mut(out, REFINEMENT_BYTES) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut list: Vec<Patch<'_>> = Vec::with_capacity(count as usize);
    for c in descriptors.chunks_exact(PATCH_BYTES) {
        let size = u32::from_le_bytes(c[8..12].try_into().unwrap()) as usize;
        let data_ptr = u32::from_le_bytes(c[12..16].try_into().unwrap());
        // SAFETY: patch pixels are adapter-owned; bounds checked.
        let Some(data) = (unsafe { slice(data_ptr, size * size) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        list.push(Patch {
            x: i32::from_le_bytes(c[0..4].try_into().unwrap()),
            y: i32::from_le_bytes(c[4..8].try_into().unwrap()),
            size,
            data,
        });
    }
    let r = refine_patches(
        &list,
        native,
        read_rect(region),
        Point { x: gx, y: gy },
        radius as i32,
    );
    write_refinement(&r, dst);
    crate::abi::STATUS_OK
}

/// Bilinear probe resample; `out` must hold `max(2, round(w×scale)) × max(2, round(h×scale))` bytes.
#[no_mangle]
pub extern "C" fn ls_resample_gray(
    gray: u32,
    width: u32,
    height: u32,
    scale: f64,
    out: u32,
) -> i32 {
    if !(scale.is_finite() && scale > 0.0) {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let Some(g) = (unsafe { read_gray(gray, width, height) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (w, h, data) = resample_gray(g, scale);
    // SAFETY: output sized by the adapter with the same formula.
    let Some(dst) = (unsafe { slice_mut(out, w * h) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(&data);
    crate::abi::STATUS_OK
}

/// Reads `count` serialised `(f64 x, f64 y)` points (`POINT_BYTES` each).
/// # Safety
/// `ptr` points at `count × POINT_BYTES` readable bytes.
unsafe fn read_points(ptr: u32, count: u32) -> Option<Vec<(f64, f64)>> {
    let bytes = slice(ptr, count as usize * POINT_BYTES)?;
    Some(
        bytes
            .chunks_exact(POINT_BYTES)
            .map(|c| {
                (
                    f64::from_le_bytes(c[0..8].try_into().unwrap()),
                    f64::from_le_bytes(c[8..16].try_into().unwrap()),
                )
            })
            .collect(),
    )
}

/// `extractPatches` in one call: `native` is the full native luma plane (`width × height`), `region` a 32-byte
/// rect, `features` a `feature_count`-long list of `(x, y)` points (`POINT_BYTES` each — analysis pixels, scaled
/// by `factor`). `out` holds up to `count` patches, each `EXTRACTED_PATCH_HEADER_BYTES + size × size` bytes wide
/// (fixed stride: every patch shares `size`). Returns the patch count actually written.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_extract_patches(
    native: u32,
    width: u32,
    height: u32,
    region: u32,
    features: u32,
    feature_count: u32,
    factor: f64,
    count: u32,
    size: u32,
    out: u32,
) -> i32 {
    let (w, h, sz, cnt) = (
        width as usize,
        height as usize,
        size as usize,
        count as usize,
    );
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(native_bytes), Some(region_bytes), Some(points)) = (
        unsafe { slice(native, w * h) },
        unsafe { slice(region, 32) },
        unsafe { read_points(features, feature_count) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let patches = extract_patches(
        native_bytes,
        w,
        h,
        read_rect(region_bytes),
        &points,
        factor,
        cnt,
        sz,
    );
    let stride = EXTRACTED_PATCH_HEADER_BYTES + sz * sz;
    // SAFETY: adapter-sized output, computed with the same stride formula.
    let Some(dst) = (unsafe { slice_mut(out, patches.len() * stride) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (i, p) in patches.iter().enumerate() {
        let o = i * stride;
        dst[o..o + 8].copy_from_slice(&p.x.to_le_bytes());
        dst[o + 8..o + 16].copy_from_slice(&p.y.to_le_bytes());
        dst[o + 16..o + 20].copy_from_slice(&(p.size as u32).to_le_bytes());
        dst[o + 20..o + 24].fill(0);
        dst[o + 24..o + 24 + sz * sz].copy_from_slice(&p.data);
    }
    patches.len() as i32
}

/// `probeScale` in one call: `previous`/`current` are analysis-resolution grey images (possibly different
/// sizes), `current_features` a serialised `Feature` list (`FEATURE_BYTES` each, from `ls_extract_features`),
/// `roi` zero or a 32-byte rect, `scales` a `scale_count`-long list of f64 candidate scales. `out` receives
/// `(f64 scale, f64 error)`. Returns 1 when a candidate passed the gates (result in `out`), 0 when none did,
/// `STATUS_BAD_ARGUMENT` on a malformed request.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_probe_scale(
    previous: u32,
    pw: u32,
    ph: u32,
    current: u32,
    cw: u32,
    ch: u32,
    current_features: u32,
    feature_count: u32,
    roi: u32,
    scales: u32,
    scale_count: u32,
    out: u32,
) -> i32 {
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(previous), Some(current), Some(feature_bytes), Ok(roi), Some(scale_bytes), Some(dst)) = (
        unsafe { read_gray(previous, pw, ph) },
        unsafe { read_gray(current, cw, ch) },
        unsafe {
            slice(
                current_features,
                feature_count as usize * crate::abi::wire::FEATURE_BYTES,
            )
        },
        unsafe { read_optional_rect(roi) },
        unsafe { slice(scales, scale_count as usize * 8) },
        unsafe { slice_mut(out, 16) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let current_features = read_features(feature_bytes);
    let scales: Vec<f64> = scale_bytes
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect();
    match probe_scale(previous, current, &current_features, roi, &scales) {
        Some((scale, error)) => {
            dst[0..8].copy_from_slice(&scale.to_le_bytes());
            dst[8..16].copy_from_slice(&error.to_le_bytes());
            1
        }
        None => 0,
    }
}
