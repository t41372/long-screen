//! Layer-learner handles: accumulates per-frame motion-discontinuity evidence across a whole recording
//! (`src/core/layers.ts`), read back once at `finish()`.

use crate::abi::memory::HandleTable;
use crate::abi::wire::{Reader, LEARNER_FIELD_BYTES, LEARNER_MOTION_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::layers::{Field as LearnerField, FieldMotion, Learner};

use super::memory::{slice, slice_mut};

static mut LEARNERS: HandleTable<Learner> = HandleTable::new();

fn learner_handles() -> &'static mut HandleTable<Learner> {
    // SAFETY: only the main instance touches LEARNERS, and only through these exported entry points — no
    // pool helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(LEARNERS) }
}

fn learner(handle: u32) -> Option<&'static mut Learner> {
    learner_handles().get(handle)
}

/// Creates a layer learner over an `width × height` analysis grid. Returns a handle (> 0).
#[no_mangle]
pub extern "C" fn ls_learner_new(width: u32, height: u32) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    learner_handles().insert(Learner::new(width as usize, height as usize))
}

#[no_mangle]
pub extern "C" fn ls_learner_free(handle: u32) {
    learner_handles().free(handle);
}

/// Accumulates one field. `prev`/`current` are analysis grays; `prev_native`/`current_native` are RGBA frames
/// of `native_width × native_height` (zero pointers skip the native statistics). Returns 1 when the field was
/// informative and accumulated, 0 when ignored, negative on a bad argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_learner_add(
    handle: u32,
    field: u32,
    prev: u32,
    current: u32,
    prev_native: u32,
    current_native: u32,
    native_width: u32,
    native_height: u32,
) -> i32 {
    let Some(l) = learner(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let pixels = l.width * l.height;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(d), Some(prev), Some(current)) = (
        unsafe { slice(field, LEARNER_FIELD_BYTES) },
        unsafe { slice(prev, pixels) },
        unsafe { slice(current, pixels) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = Reader(d);
    let (cols, rows, count) = (r.u32(20) as usize, r.u32(24) as usize, r.u32(4) as usize);
    if cols != l.cols || rows != l.rows || count == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let cells = cols * rows;
    // SAFETY: as above.
    let (Some(motions), Some(labels), Some(confidence), Some(dynamic)) = (
        unsafe { slice(r.u32(0), count * LEARNER_MOTION_BYTES) },
        unsafe { slice(r.u32(8), cells) },
        unsafe { slice(r.u32(12), cells) },
        unsafe { slice(r.u32(16), cells) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    if labels.iter().any(|&label| label as usize >= count) {
        return STATUS_BAD_ARGUMENT;
    }
    let motions: Vec<FieldMotion> = motions
        .chunks_exact(LEARNER_MOTION_BYTES)
        .map(|c| FieldMotion {
            x: f64::from_le_bytes(c[0..8].try_into().unwrap()),
            y: f64::from_le_bytes(c[8..16].try_into().unwrap()),
            support: u32::from_le_bytes(c[16..20].try_into().unwrap()),
            confidence: f64::from_le_bytes(c[24..32].try_into().unwrap()),
        })
        .collect();
    let native = if prev_native == 0 || current_native == 0 {
        None
    } else {
        let n = native_width as usize * native_height as usize * 4;
        // SAFETY: as above.
        match (unsafe { slice(prev_native, n) }, unsafe {
            slice(current_native, n)
        }) {
            (Some(a), Some(b)) => Some((a, b, native_width as usize, native_height as usize)),
            _ => return STATUS_BAD_ARGUMENT,
        }
    };
    let field = LearnerField {
        motions: &motions,
        labels,
        confidence,
        dynamic,
        cols,
        rows,
        difference: r.f64(32),
        unknown: r.u32(28) != 0,
    };
    l.add(&field, prev, current, native) as i32
}

/// Number of named accumulator arrays `learner_array` recognises (selectors 0..=13); selector 14 is the
/// separate "counts" tuple (informative frames, native frames, native width, native height). Asserted against
/// `src/core/wasm/learner.ts`'s `LEARNER_ARRAYS` via `ls_layout` selector 12, so an array added or removed on
/// one side without the other is caught instead of silently misreading `which`.
pub const LEARNER_ARRAY_COUNT: usize = 14;

/// Accumulator selectors for `ls_learner_len`/`ls_learner_read`, in the adapter's field order; `LEARNER_ARRAY_COUNT`
/// = counts (informative frames, native frames, native width, native height).
fn learner_array(l: &Learner, which: u32) -> Option<&[f64]> {
    Some(match which {
        0 => &l.split,
        1 => &l.evidence,
        2 => &l.activity,
        3 => &l.observations,
        4 => &l.row_fixed,
        5 => &l.row_moving,
        6 => &l.row_change,
        7 => &l.col_change,
        8 => &l.col_mean,
        9 => &l.col_gain,
        10 => &l.horizontal_gain,
        11 => &l.native_row_change,
        12 => &l.native_col_change,
        13 => &l.native_col_mean,
        _ => return None,
    })
}

/// Length in f64 of accumulator `which`.
#[no_mangle]
pub extern "C" fn ls_learner_len(handle: u32, which: u32) -> i32 {
    let Some(l) = learner(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if which == LEARNER_ARRAY_COUNT as u32 {
        return 4;
    }
    match learner_array(l, which) {
        Some(a) => a.len() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Copies accumulator `which` (f64 little-endian) into `out`, sized from `ls_learner_len`.
#[no_mangle]
pub extern "C" fn ls_learner_read(handle: u32, which: u32, out: u32) -> i32 {
    let Some(l) = learner(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let values: Vec<f64> = if which == LEARNER_ARRAY_COUNT as u32 {
        vec![
            l.informative_frames as f64,
            l.native_frames as f64,
            l.native_width as f64,
            l.native_height as f64,
        ]
    } else {
        match learner_array(l, which) {
            Some(a) => a.to_vec(),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, values.len() * 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (v, d) in values.iter().zip(dst.chunks_exact_mut(8)) {
        d.copy_from_slice(&v.to_le_bytes());
    }
    crate::abi::STATUS_OK
}
