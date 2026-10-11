//! The scan pass (`long_screen_engine::scan::ScanSession`) for `src/core/wasm/scan.ts`. A session is a handle; the
//! adapter writes each decoded frame straight into the session's own frame buffer (`ls_scan_frame`), then steps it.
//! `ls_scan_push` and `ls_scan_finish` return their result's length and leave the result in the handle for
//! `ls_scan_take` (error convention 6). Results are `bytes.rs` records:
//!   a step: u32 flags (1 duplicate, 2 first frame, 4 initial field layout, 8 has a features row); the motion field
//!   (`write_field`); with a features row, u32 count, then x/y pairs (i16), scores (f32) and descriptors (8 × u32);
//!   then the diagnostics (`diagnostic.rs`);
//!   a finish: the diagnostics, then the regions (`regions::write_finished`).

use crate::bytes::{take, Out};
use crate::diagnostic::write_diagnostics;
use crate::features::read_features;
use crate::memory::{slice, slice_mut, HandleTable};
use crate::motion::write_motions;
use crate::regions::{read_manual, write_finished};
use crate::wire::{FEATURE_BYTES, MOTION_BYTES, MOTION_FIELD_HEADER_BYTES};
use crate::STATUS_BAD_ARGUMENT;
use long_screen_core::features::Feature;
use long_screen_core::motion::{Gray, MotionField, MOTION_CELL};
use long_screen_engine::scan::{estimate_motion, FieldLayout, FrameMeta, ScanSession};

struct Session {
    scan: ScanSession,
    out: Vec<u8>,
}

static mut SESSIONS: HandleTable<Session> = HandleTable::new();

fn sessions() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches SESSIONS, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(SESSIONS) }
}

/// A scan over `width × height` native frames at the integer analysis `factor`. Returns a handle (> 0). A run
/// whose container reports no size still gets a session: it finishes with no regions, as a scan with no frames does.
#[no_mangle]
pub extern "C" fn ls_scan_new(width: u32, height: u32, factor: u32) -> i32 {
    if factor == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    sessions().insert(Session {
        scan: ScanSession::new(width as usize, height as usize, factor as usize),
        out: Vec::new(),
    })
}

#[no_mangle]
pub extern "C" fn ls_scan_free(handle: u32) {
    sessions().free(handle);
}

/// Pointer to the `width × height × 4`-byte buffer the next frame's RGBA goes into (0 on a bad handle). It stays
/// valid for the session's lifetime; memory growth does not move it.
#[no_mangle]
pub extern "C" fn ls_scan_frame(handle: u32) -> u32 {
    match sessions().get(handle) {
        Some(s) => s.scan.frame_buffer().as_mut_ptr() as u32,
        None => 0,
    }
}

/// 1 when the written frame repeats the previous one exactly, 0 otherwise.
#[no_mangle]
pub extern "C" fn ls_scan_is_duplicate(handle: u32) -> i32 {
    match sessions().get(handle) {
        Some(s) => s.scan.is_duplicate() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Analyses the written frame. `gray` is 0, or the host's analysis gray of `gray_len` bytes. Returns the length of
/// the step record (see the module doc comment) or a negative status.
#[no_mangle]
pub extern "C" fn ls_scan_push(
    handle: u32,
    index: u32,
    time: f64,
    duration: f64,
    gray: u32,
    gray_len: u32,
) -> i32 {
    let Some(s) = sessions().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let gray = if gray == 0 {
        None
    } else {
        // SAFETY: adapter-owned buffer, bounds checked.
        match unsafe { slice(gray, gray_len as usize) } {
            Some(g) => Some(g),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let meta = FrameMeta {
        index,
        time,
        duration,
    };
    let Ok(step) = s.scan.push(meta, gray) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut w = Out::default();
    let record = &step.record;
    w.u32(
        record.duplicate as u32
            | (step.first as u32) << 1
            | ((record.layout == FieldLayout::Initial) as u32) << 2
            | (step.features.is_some() as u32) << 3,
    );
    write_field(&mut w, &record.field);
    if let Some(features) = &step.features {
        w.u32(features.score.len() as u32);
        features.xy.iter().for_each(|v| w.bytes(&v.to_le_bytes()));
        features
            .score
            .iter()
            .for_each(|v| w.bytes(&v.to_le_bytes()));
        features.descriptors.iter().for_each(|&v| w.u32(v));
    }
    write_diagnostics(&mut w, &step.diagnostics);
    s.out = w.0;
    s.out.len() as i32
}

/// A motion field: u32 cols, rows, cell, motion count, f64 difference, u32 feature count, u32 unknown, f64 zoom
/// (`MOTION_FIELD_HEADER_BYTES`), the motions (`MOTION_BYTES` each), then labels, confidence and dynamic (cols × rows
/// bytes each).
fn write_field(w: &mut Out, f: &MotionField) {
    for v in [
        f.cols as u32,
        f.rows as u32,
        f.cell as u32,
        f.motions.len() as u32,
    ] {
        w.u32(v);
    }
    w.f64(f.difference);
    w.u32(f.feature_count);
    w.u32(f.unknown as u32);
    w.f64(f.zoom);
    let mut motions = vec![0u8; f.motions.len() * MOTION_BYTES];
    write_motions(&f.motions, &mut motions);
    w.bytes(&motions);
    w.bytes(&f.labels);
    w.bytes(&f.confidence);
    w.bytes(&f.dynamic);
}

/// `long_screen_engine::scan::estimate_motion` for `src/core/motion.ts::estimateMotion`: motion from analysis gray
/// `a` to `b` (`width × height` each). `flags` bit 0 says `a_features` (`a_count × FEATURE_BYTES`) is given, bit 1
/// the same for `b_features`; a feature list that is not given is extracted here. Writes the field (`write_field`)
/// into `out`, which holds `MOTION_FIELD_HEADER_BYTES + 8 × MOTION_BYTES + 3 × cells` bytes, and returns the length
/// written or a negative status.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_scan_estimate_motion(
    a: u32,
    b: u32,
    width: u32,
    height: u32,
    a_features: u32,
    a_count: u32,
    b_features: u32,
    b_count: u32,
    flags: u32,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    let capacity = MOTION_FIELD_HEADER_BYTES
        + 8 * MOTION_BYTES
        + 3 * w.div_ceil(MOTION_CELL) * h.div_ceil(MOTION_CELL);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(a), Some(b), Some(dst)) = (
        unsafe { slice(a, w * h) },
        unsafe { slice(b, w * h) },
        unsafe { slice_mut(out, capacity) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let features = |given: bool, ptr: u32, count: u32| -> Result<Option<Vec<Feature>>, ()> {
        if !given {
            return Ok(None);
        }
        // SAFETY: as above.
        let bytes = unsafe { slice(ptr, count as usize * FEATURE_BYTES) }.ok_or(())?;
        Ok(Some(read_features(bytes)))
    };
    let (Ok(fa), Ok(fb)) = (
        features(flags & 1 != 0, a_features, a_count),
        features(flags & 2 != 0, b_features, b_count),
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let gray = |data| Gray {
        width: w,
        height: h,
        data,
    };
    let Ok(field) = estimate_motion(gray(a), gray(b), fa.as_deref(), fb.as_deref()) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut record = Out::default();
    write_field(&mut record, &field);
    if record.0.len() > capacity {
        return STATUS_BAD_ARGUMENT;
    }
    dst[..record.0.len()].copy_from_slice(&record.0);
    record.0.len() as i32
}

/// Builds the run's regions: from the learned evidence, or from the `manual_count` hand-placed regions at
/// `manual` (`regions::MANUAL_REGION_BYTES` each). Returns the length of the finish record or a negative status.
#[no_mangle]
pub extern "C" fn ls_scan_finish(handle: u32, manual: u32, manual_count: u32) -> i32 {
    let Some(s) = sessions().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned descriptors, bounds checked.
    let Some(manual) = (unsafe { read_manual(manual, manual_count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let done = s.scan.finish(&manual);
    let mut w = Out::default();
    write_diagnostics(&mut w, &done.diagnostics);
    write_finished(&mut w, done.regions);
    s.out = w.0;
    s.out.len() as i32
}

/// Copies the last step's or finish's record (`len` bytes, the length that call returned) into `out`.
#[no_mangle]
pub extern "C" fn ls_scan_take(handle: u32, out: u32, len: u32) -> i32 {
    match sessions().get(handle) {
        Some(s) => take(&mut s.out, out, len),
        None => STATUS_BAD_ARGUMENT,
    }
}
