//! `extern "C"` surface consumed by the TypeScript adapter (`src/core/wasm.ts`).
//!
//! Memory contract: the adapter allocates every buffer through `ls_alloc`/`ls_free`, writes inputs,
//! calls a kernel, and reads outputs. Kernels never allocate host-visible memory themselves and never
//! retain pointers between calls. Every pointer is validated against linear memory before use; an
//! invalid request returns a negative status instead of trapping.

use crate::chrome::{stationary_boundary, sticky_occlusions, Axis, Choose};
use crate::compositor::{composite_tile, Observation, TileBuffers, QUALITY_BLOCK};
use crate::consistency::{consistency_mask, MaskInput, Neighbour, Vote};
use crate::features::{extract_features, feature_words, match_features, Feature, DESCRIPTOR_WORDS};
use crate::geometry::Rect;
use crate::layers::{Field as LearnerField, FieldMotion, Learner};
use crate::motion::{
    audit_translation, detect_scale, estimate_motion, refine_native, refine_patches,
    refine_translation, resample_gray, translation_hypotheses, verify_translation, Gray,
    MatchPoints, Motion, NativeRefinement, Patch, Point,
};
use crate::png::{filter_sub_rgba, unfilter_to_rgba};
use crate::raster::{
    downscale_gray, downscaled_size, fixed_update, grayscale, halve_rgba, mean_difference,
};
use crate::region::{Mask as RegionMask, Region as RegionDef};
use crate::voting::{Finalized, Ring};
use std::alloc::{alloc, dealloc, Layout};

pub const STATUS_OK: i32 = 0;
pub const STATUS_BAD_ARGUMENT: i32 = -1;
/// PNG filter failures are `STATUS_BAD_FILTER - filter_byte` (−256 … −511).
pub const STATUS_BAD_FILTER: i32 = -256;

/// Bytes per serialised feature: i32 x, i32 y, f32 score, 8 × u32 descriptor.
pub const FEATURE_BYTES: usize = 4 + 4 + 4 + DESCRIPTOR_WORDS * 4;
/// Bytes per serialised match: u32 a, u32 b, u16 distance, u8 unique, u8 padding.
pub const MATCH_BYTES: usize = 12;
/// Bytes per serialised match point pair: f64 ax, ay, bx, by, u32 unique, u32 padding.
pub const MATCH_POINT_BYTES: usize = 40;
/// Bytes per serialised motion: f64 x, y, u32 support, u32 unique, f64 confidence, f64 error, u32 ambiguous, u32 padding.
pub const MOTION_BYTES: usize = 48;
/// Motion field header: u32 cols, rows, cell, motion count, f64 difference, u32 feature count, u32 unknown, f64 zoom.
pub const MOTION_FIELD_HEADER_BYTES: usize = 40;
/// Native refinement result: i32 x, i32 y, f64 error, u32 samples, u32 padding, f64 runner-up.
pub const REFINEMENT_BYTES: usize = 32;
/// Serialised keyframe patch: i32 x, i32 y, u32 size, u32 data pointer.
pub const PATCH_BYTES: usize = 16;
/// Composite result header: u32 added, u32 conflicts, u32 uncertain, i32 provisional delta, u32 changed,
/// u32 conflict block count, then (u32 bx, u32 by) pairs.
pub const COMPOSITE_HEADER_BYTES: usize = 24;
/// Serialised voting region (`ls_voting_new`): 32-byte rect, u32 exclusion ptr, u32 exclusion count,
/// u32 crop ptr (0 = none), u32 solid, u32 mask ptr (0 = none), u32 mask width, u32 mask height, u32 mask factor.
pub const VOTING_REGION_BYTES: usize = 64;
/// Serialised learner field motion: f64 x, f64 y, u32 support, u32 padding, f64 confidence.
pub const LEARNER_MOTION_BYTES: usize = 32;
/// Learner field descriptor: u32 motions ptr, u32 motion count, u32 labels ptr, u32 confidence ptr,
/// u32 dynamic ptr, u32 cols, u32 rows, u32 unknown, f64 difference.
pub const LEARNER_FIELD_BYTES: usize = 40;

/// Persistent appearance edge in `rgba` (width×height) along `axis` (0 = x, 1 = y) between `from` and `to`,
/// sampling cross coordinates `cross_from..cross_to`; `choose` 0 = first, 1 = last. Returns the coordinate
/// (≥ 1), −1 when none, or −2 on a bad argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_stationary_boundary(
    rgba: u32,
    width: u32,
    height: u32,
    axis: u32,
    from: f64,
    to: f64,
    cross_from: f64,
    cross_to: f64,
    choose: u32,
) -> f64 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return -2.0;
    }
    // SAFETY: adapter-owned frame, bounds checked.
    let Some(rgba) = (unsafe { slice(rgba, w * h * 4) }) else {
        return -2.0;
    };
    let axis = if axis == 0 { Axis::X } else { Axis::Y };
    let choose = if choose == 0 {
        Choose::First
    } else {
        Choose::Last
    };
    stationary_boundary(rgba, w, h, axis, from, to, cross_from, cross_to, choose).unwrap_or(-1.0)
}

/// Sticky bands for one observation. `region` is one 32-byte rect (the region's crop or rect), `carry` holds
/// `carry_count` previous bands, `out` has room for `max(carry_count, 1)` rects. Returns the band count.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_sticky_occlusions(
    previous: u32,
    current: u32,
    width: u32,
    height: u32,
    region: u32,
    motion_x: f64,
    motion_y: f64,
    carry: u32,
    carry_count: u32,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let capacity = (carry_count as usize).max(1);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(previous), Some(current), Some(region), Some(carry), Some(dst)) = (
        unsafe { slice(previous, w * h * 4) },
        unsafe { slice(current, w * h * 4) },
        unsafe { slice(region, 32) },
        unsafe { slice(carry, carry_count as usize * 32) },
        unsafe { slice_mut(out, capacity * 32) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let bands = sticky_occlusions(
        previous,
        current,
        w,
        h,
        read_rect(region),
        motion_x,
        motion_y,
        &read_rects(carry),
    );
    for (b, d) in bands.iter().zip(dst.chunks_exact_mut(32)) {
        d[0..8].copy_from_slice(&b.x.to_le_bytes());
        d[8..16].copy_from_slice(&b.y.to_le_bytes());
        d[16..24].copy_from_slice(&b.width.to_le_bytes());
        d[24..32].copy_from_slice(&b.height.to_le_bytes());
    }
    bands.len() as i32
}

static mut LEARNERS: Vec<Option<Box<Learner>>> = Vec::new();

fn learner_handles() -> &'static mut Vec<Option<Box<Learner>>> {
    // SAFETY: single-threaded module; handles are only touched through the exported entry points.
    unsafe { &mut *std::ptr::addr_of_mut!(LEARNERS) }
}

fn learner(handle: u32) -> Option<&'static mut Learner> {
    learner_handles()
        .get_mut(handle.wrapping_sub(1) as usize)
        .and_then(|h| h.as_deref_mut())
}

/// Creates a layer learner over an `width × height` analysis grid. Returns a handle (> 0).
#[no_mangle]
pub extern "C" fn ls_learner_new(width: u32, height: u32) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let handles = learner_handles();
    let handle = Box::new(Learner::new(width as usize, height as usize));
    if let Some(free) = handles.iter().position(|h| h.is_none()) {
        handles[free] = Some(handle);
        return free as i32 + 1;
    }
    handles.push(Some(handle));
    handles.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_learner_free(handle: u32) {
    if let Some(slot) = learner_handles().get_mut(handle.wrapping_sub(1) as usize) {
        *slot = None;
    }
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
    let u = |i: usize| u32::from_le_bytes(d[i..i + 4].try_into().unwrap());
    let (cols, rows, count) = (u(20) as usize, u(24) as usize, u(4) as usize);
    if cols != l.cols || rows != l.rows || count == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let cells = cols * rows;
    // SAFETY: as above.
    let (Some(motions), Some(labels), Some(confidence), Some(dynamic)) = (
        unsafe { slice(u(0), count * LEARNER_MOTION_BYTES) },
        unsafe { slice(u(8), cells) },
        unsafe { slice(u(12), cells) },
        unsafe { slice(u(16), cells) },
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
        difference: f64::from_le_bytes(d[32..40].try_into().unwrap()),
        unknown: u(28) != 0,
    };
    l.add(&field, prev, current, native) as i32
}

/// Accumulator selectors for `ls_learner_len`/`ls_learner_read`, in the adapter's field order; 14 = counts
/// (informative frames, native frames, native width, native height).
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
    if which == 14 {
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
    let values: Vec<f64> = if which == 14 {
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
    STATUS_OK
}

/// Finalised voting records waiting to be read by the adapter, oldest first.
struct VotingHandle {
    ring: Ring,
    pending: std::collections::VecDeque<Finalized>,
}

static mut VOTING: Vec<Option<Box<VotingHandle>>> = Vec::new();

fn voting_handles() -> &'static mut Vec<Option<Box<VotingHandle>>> {
    // SAFETY: the module is single-threaded; handles are only touched through the exported entry points.
    unsafe { &mut *std::ptr::addr_of_mut!(VOTING) }
}

fn voting(handle: u32) -> Option<&'static mut VotingHandle> {
    voting_handles()
        .get_mut(handle.wrapping_sub(1) as usize)
        .and_then(|h| h.as_deref_mut())
}

/// # Safety
/// `ptr` points at `count × VOTING_REGION_BYTES` bytes whose pointers cover the sizes they declare.
unsafe fn read_voting_regions(ptr: u32, count: u32) -> Option<Vec<RegionDef>> {
    let bytes = slice(ptr, count as usize * VOTING_REGION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(VOTING_REGION_BYTES) {
        let u = |i: usize| u32::from_le_bytes(c[i..i + 4].try_into().unwrap());
        let rect = read_rect(c);
        let exclusions = read_rects(slice(u(32), u(36) as usize * 32)?);
        let crop = read_optional_rect(u(40)).ok()?;
        let mask = if u(48) == 0 {
            None
        } else {
            let (w, h) = (u(52) as usize, u(56) as usize);
            if w == 0 || h == 0 {
                return None;
            }
            Some(RegionMask {
                width: w,
                height: h,
                factor: u(60),
                data: slice(u(48), w * h)?.to_vec(),
            })
        };
        out.push(RegionDef {
            rect,
            exclusions,
            crop,
            solid: u(44) != 0,
            mask,
        });
    }
    Some(out)
}

/// Creates a voting ring over `count` moving regions. Returns a handle (> 0) or a negative status.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_voting_new(
    factor: u32,
    noise: f64,
    native_width: u32,
    native_height: u32,
    analysis_width: u32,
    analysis_height: u32,
    budget_bytes: u32,
    regions: u32,
    count: u32,
) -> i32 {
    if analysis_width == 0 || analysis_height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned descriptors, bounds checked.
    let Some(regions) = (unsafe { read_voting_regions(regions, count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let ring = Ring::new(
        factor as i32,
        noise,
        native_width as usize,
        native_height as usize,
        analysis_width as usize,
        analysis_height as usize,
        budget_bytes as usize,
        regions,
    );
    let handles = voting_handles();
    let handle = Box::new(VotingHandle {
        ring,
        pending: Default::default(),
    });
    if let Some(free) = handles.iter().position(|h| h.is_none()) {
        handles[free] = Some(handle);
        return free as i32 + 1;
    }
    handles.push(Some(handle));
    handles.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_voting_free(handle: u32) {
    if let Some(slot) = voting_handles().get_mut(handle.wrapping_sub(1) as usize) {
        *slot = None;
    }
}

/// Box geometry of region `slot`: writes i32 x0, y0, w, h to `out` (16 bytes).
#[no_mangle]
pub extern "C" fn ls_voting_box(handle: u32, slot: u32, out: u32) -> i32 {
    // SAFETY: adapter-owned output.
    let (Some(v), Some(dst)) = (voting(handle), unsafe { slice_mut(out, 16) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(region) = v.ring.slots.get(slot as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    let b = region.box_;
    dst[0..4].copy_from_slice(&b.x0.to_le_bytes());
    dst[4..8].copy_from_slice(&b.y0.to_le_bytes());
    dst[8..12].copy_from_slice(&b.w.to_le_bytes());
    dst[12..16].copy_from_slice(&b.h.to_le_bytes());
    STATUS_OK
}

/// Interior-cell mask of region `slot` (w×h bytes) — exposed for parity tests.
#[no_mangle]
pub extern "C" fn ls_voting_interior(handle: u32, slot: u32, out: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(region) = v.ring.slots.get(slot as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, region.interior.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(&region.interior);
    STATUS_OK
}

/// Votes region `slot` of the frame under construction, with its final pose on `canvas`, against the ring.
/// `gray` is the whole analysis frame (analysis_width × analysis_height bytes).
#[no_mangle]
pub extern "C" fn ls_voting_observe(
    handle: u32,
    slot: u32,
    canvas: u32,
    pose_x: f64,
    pose_y: f64,
    gray: u32,
) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if slot as usize >= v.ring.slots.len() {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned analysis frame, bounds checked.
    let Some(gray) = (unsafe { slice(gray, v.ring.analysis_width * v.ring.analysis_height) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    v.ring.observe(slot as usize, canvas, pose_x, pose_y, gray);
    STATUS_OK
}

/// Commits frame `index`; returns the number of finalised records now pending (or a negative status).
#[no_mangle]
pub extern "C" fn ls_voting_push(handle: u32, index: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    v.pending.extend(v.ring.push_frame(index));
    v.pending.len() as i32
}

/// Finalises every resident frame; returns the number of pending records.
#[no_mangle]
pub extern "C" fn ls_voting_drain(handle: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    v.pending.extend(v.ring.drain());
    v.pending.len() as i32
}

/// Header of the oldest pending record: u32 frame index, u32 verdict count, u32 voted layers, u32 thin layers,
/// then per verdict u32 slot. `out` needs `16 + 4 × slots` bytes. Returns the verdict count, or −2 when empty.
#[no_mangle]
pub extern "C" fn ls_voting_peek(handle: u32, out: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(record) = v.pending.front() else {
        return -2;
    };
    // SAFETY: adapter-owned output sized for every slot.
    let Some(dst) = (unsafe { slice_mut(out, 16 + 4 * v.ring.slots.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst[0..4].copy_from_slice(&record.index.to_le_bytes());
    dst[4..8].copy_from_slice(&(record.verdicts.len() as u32).to_le_bytes());
    dst[8..12].copy_from_slice(&record.voted_layers.to_le_bytes());
    dst[12..16].copy_from_slice(&record.thin_layers.to_le_bytes());
    for (i, verdict) in record.verdicts.iter().enumerate() {
        dst[16 + i * 4..20 + i * 4].copy_from_slice(&(verdict.slot as u32).to_le_bytes());
    }
    record.verdicts.len() as i32
}

/// Copies verdict `which` of the oldest pending record: `bits` then `clean`, each `ceil(w·h/8)` bytes.
#[no_mangle]
pub extern "C" fn ls_voting_read(handle: u32, which: u32, bits: u32, clean: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(verdict) = v
        .pending
        .front()
        .and_then(|r| r.verdicts.get(which as usize))
    else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned outputs sized from ls_voting_box.
    let (Some(b), Some(c)) = (unsafe { slice_mut(bits, verdict.bits.len()) }, unsafe {
        slice_mut(clean, verdict.clean.len())
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    b.copy_from_slice(&verdict.bits);
    c.copy_from_slice(&verdict.clean);
    STATUS_OK
}

/// Discards the oldest pending record after it has been read.
#[no_mangle]
pub extern "C" fn ls_voting_pop(handle: u32) -> i32 {
    let Some(v) = voting(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    v.pending.pop_front();
    v.pending.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_alloc(size: u32) -> u32 {
    if size == 0 {
        return 0;
    }
    let Ok(layout) = Layout::from_size_align(size as usize, 8) else {
        return 0;
    };
    // SAFETY: layout has non-zero size.
    unsafe { alloc(layout) as u32 }
}

#[no_mangle]
pub extern "C" fn ls_free(ptr: u32, size: u32) {
    if ptr == 0 || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size as usize, 8) {
        // SAFETY: pointers only come from ls_alloc with the same size.
        unsafe { dealloc(ptr as *mut u8, layout) }
    }
}

/// Refreshes a fixed region's saved pixels (`rw × rh` RGBA from origin `(x0, y0)`) from `rgba`; returns 1 when a
/// region pixel changed, 0 when none did, or a negative status on a bad argument.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_fixed_update(
    saved: u32,
    rgba: u32,
    labels: u32,
    width: u32,
    height: u32,
    x0: i32,
    y0: i32,
    rw: u32,
    rh: u32,
    code: u32,
) -> i32 {
    let (w, h, rw, rh) = (width as usize, height as usize, rw as usize, rh as usize);
    // SAFETY: adapter-owned buffers, bounds checked; `saved` never aliases the frame or labels.
    let (Some(saved), Some(rgba), Some(labels)) = (
        unsafe { slice_mut(saved, rw * rh * 4) },
        unsafe { slice(rgba, w * h * 4) },
        unsafe { slice(labels, w * h) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    fixed_update(
        saved, rgba, labels, w, h, x0 as i64, y0 as i64, rw, rh, code as u8,
    ) as i32
}

/// Parks the calling helper instance in the shared-memory pool; only valid in the threaded build.
#[no_mangle]
pub extern "C" fn ls_pool_worker() {
    crate::pool::worker_loop()
}

/// Helper threads currently parked in the pool.
#[no_mangle]
pub extern "C" fn ls_pool_helpers() -> u32 {
    crate::pool::helpers() as u32
}

#[no_mangle]
pub extern "C" fn ls_feature_bytes() -> u32 {
    FEATURE_BYTES as u32
}

#[no_mangle]
pub extern "C" fn ls_match_bytes() -> u32 {
    MATCH_BYTES as u32
}

#[no_mangle]
pub extern "C" fn ls_mean_difference(a: u32, b: u32, len: u32) -> f64 {
    // SAFETY: adapter-owned buffers, bounds checked.
    match (unsafe { slice(a, len as usize) }, unsafe {
        slice(b, len as usize)
    }) {
        (Some(a), Some(b)) => mean_difference(a, b),
        _ => 255.0,
    }
}

fn read_rect(bytes: &[u8]) -> Rect {
    read_rects(&bytes[..32])[0]
}

/// # Safety
/// `ptr` is zero (none) or points at one 32-byte rect.
unsafe fn read_optional_rect(ptr: u32) -> Result<Option<Rect>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    slice(ptr, 32)
        .map(|b| Some(read_rect(b)))
        .ok_or(STATUS_BAD_ARGUMENT)
}

/// # Safety
/// `ptr` points at `count × MATCH_POINT_BYTES` readable bytes.
unsafe fn read_match_points(ptr: u32, count: u32) -> Option<Vec<MatchPoints>> {
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
    STATUS_OK
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
    STATUS_OK
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
    STATUS_OK
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
    STATUS_OK
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
    STATUS_OK
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
    STATUS_OK
}

#[cfg(target_arch = "wasm32")]
fn memory_size() -> usize {
    core::arch::wasm32::memory_size(0) * 65536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_size() -> usize {
    usize::MAX
}

#[inline]
fn in_bounds(ptr: u32, len: usize) -> bool {
    (ptr as usize)
        .checked_add(len)
        .is_some_and(|end| end <= memory_size())
}

/// # Safety
/// Only called on pointers the adapter obtained from `ls_alloc` and filled; bounds are re-checked.
unsafe fn slice<'a>(ptr: u32, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    (ptr != 0 && in_bounds(ptr, len)).then(|| std::slice::from_raw_parts(ptr as *const u8, len))
}

/// # Safety
/// See `slice`; the caller guarantees the output does not alias any input.
unsafe fn slice_mut<'a>(ptr: u32, len: usize) -> Option<&'a mut [u8]> {
    if len == 0 {
        return Some(&mut []);
    }
    (ptr != 0 && in_bounds(ptr, len)).then(|| std::slice::from_raw_parts_mut(ptr as *mut u8, len))
}

fn read_rects(bytes: &[u8]) -> Vec<Rect> {
    bytes
        .chunks_exact(32)
        .map(|c| Rect {
            x: f64::from_le_bytes(c[0..8].try_into().unwrap()),
            y: f64::from_le_bytes(c[8..16].try_into().unwrap()),
            width: f64::from_le_bytes(c[16..24].try_into().unwrap()),
            height: f64::from_le_bytes(c[24..32].try_into().unwrap()),
        })
        .collect()
}

/// Vote descriptor: 4 × i32 (x0, y0, w, h) followed by two u32 pointers (bits, clean).
/// # Safety
/// `ptr` is zero (no vote) or points at 24 readable bytes whose bit pointers cover `ceil(w*h/8)` bytes.
unsafe fn read_vote<'a>(ptr: u32) -> Result<Option<Vote<'a>>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    let d = slice(ptr, 24).ok_or(STATUS_BAD_ARGUMENT)?;
    let word = |i: usize| i32::from_le_bytes(d[i * 4..i * 4 + 4].try_into().unwrap());
    let (x0, y0, w, h) = (word(0), word(1), word(2), word(3));
    if w <= 0 || h <= 0 {
        return Err(STATUS_BAD_ARGUMENT);
    }
    let bytes = ((w as usize) * (h as usize)).div_ceil(8);
    let bits = slice(word(4) as u32, bytes).ok_or(STATUS_BAD_ARGUMENT)?;
    let clean = slice(word(5) as u32, bytes).ok_or(STATUS_BAD_ARGUMENT)?;
    Ok(Some(Vote {
        x0,
        y0,
        w,
        h,
        bits,
        clean,
    }))
}

#[no_mangle]
pub extern "C" fn ls_grayscale(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    let n = width as usize * height as usize;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, n * 4) }, unsafe { slice_mut(out, n) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    grayscale(src, dst);
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_downscale_gray(
    rgba: u32,
    width: u32,
    height: u32,
    factor: u32,
    out: u32,
) -> i32 {
    if width == 0 || height == 0 || factor == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (w, h, f) = (width as usize, height as usize, factor as usize);
    let (ow, oh) = downscaled_size(w, h, f);
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, ow * oh)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    downscale_gray(src, w, h, f, dst);
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn ls_halve_rgba(rgba: u32, width: u32, height: u32, out: u32) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let (w, h) = (width as usize, height as usize);
    let (ow, oh) = ((w >> 1).max(1), (h >> 1).max(1));
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(src), Some(dst)) = (unsafe { slice(rgba, w * h * 4) }, unsafe {
        slice_mut(out, ow * oh * 4)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    halve_rgba(src, w, h, dst);
    STATUS_OK
}

fn write_features(features: &[Feature], out: &mut [u8]) {
    for (f, dst) in features.iter().zip(out.chunks_exact_mut(FEATURE_BYTES)) {
        dst[0..4].copy_from_slice(&f.x.to_le_bytes());
        dst[4..8].copy_from_slice(&f.y.to_le_bytes());
        dst[8..12].copy_from_slice(&(f.score as f32).to_le_bytes());
        for (k, word) in f.descriptor.iter().enumerate() {
            dst[12 + k * 4..16 + k * 4].copy_from_slice(&word.to_le_bytes());
        }
    }
}

fn read_features(bytes: &[u8]) -> Vec<Feature> {
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

/// Decoded neighbour descriptor; owns its occlusion rects so the kernel can borrow them.
struct NeighbourData<'a> {
    rgba: &'a [u8],
    pose_x: f64,
    pose_y: f64,
    occlusions: Vec<Rect>,
    vote: Option<Vote<'a>>,
}

impl NeighbourData<'_> {
    fn borrow(&self) -> Neighbour<'_> {
        Neighbour {
            rgba: self.rgba,
            pose_x: self.pose_x,
            pose_y: self.pose_y,
            occlusions: &self.occlusions,
            vote: self.vote.as_ref().map(|v| Vote {
                x0: v.x0,
                y0: v.y0,
                w: v.w,
                h: v.h,
                bits: v.bits,
                clean: v.clean,
            }),
        }
    }
}

/// Neighbour descriptor (48 bytes): u32 rgba, f64 pose_x, f64 pose_y, u32 occlusions ptr, u32 occlusion count,
/// u32 vote descriptor ptr, 12 bytes padding. Absent neighbours pass a zero pointer.
/// # Safety
/// Pointer validity is checked; `pixels` is the frame pixel count the rgba pointer must cover.
unsafe fn read_neighbour<'a>(ptr: u32, pixels: usize) -> Result<Option<NeighbourData<'a>>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    let d = slice(ptr, 48).ok_or(STATUS_BAD_ARGUMENT)?;
    let u = |i: usize| u32::from_le_bytes(d[i..i + 4].try_into().unwrap());
    let f = |i: usize| f64::from_le_bytes(d[i..i + 8].try_into().unwrap());
    let rgba = slice(u(0), pixels * 4).ok_or(STATUS_BAD_ARGUMENT)?;
    let count = u(28) as usize;
    let occlusion_bytes = if count == 0 {
        &[][..]
    } else {
        slice(u(24), count * 32).ok_or(STATUS_BAD_ARGUMENT)?
    };
    Ok(Some(NeighbourData {
        rgba,
        pose_x: f(8),
        pose_y: f(16),
        occlusions: read_rects(occlusion_bytes),
        vote: read_vote(u(32))?,
    }))
}

/// World-consistency mask. `region` points at one 32-byte rect; `prev`/`next` at neighbour descriptors
/// (or zero); `vote` at a vote descriptor (or zero). `out` receives width×height bytes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_consistency_mask(
    rgba: u32,
    labels: u32,
    width: u32,
    height: u32,
    region: u32,
    code: u32,
    pose_x: f64,
    pose_y: f64,
    prev: u32,
    next: u32,
    vote: u32,
    factor: u32,
    noise: f64,
    out: u32,
) -> i32 {
    let (w, h) = (width as usize, height as usize);
    let pixels = w * h;
    if pixels == 0 || factor == 0 || w > i32::MAX as usize / 4 || h > i32::MAX as usize / 4 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(rgba), Some(labels), Some(region_bytes), Some(out)) = (
        unsafe { slice(rgba, pixels * 4) },
        unsafe { slice(labels, pixels) },
        unsafe { slice(region, 32) },
        unsafe { slice_mut(out, pixels) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let region = read_rects(region_bytes)[0];
    // SAFETY: descriptors validated field by field.
    let (prev, next, vote) = match unsafe {
        (
            read_neighbour(prev, pixels),
            read_neighbour(next, pixels),
            read_vote(vote),
        )
    } {
        (Ok(p), Ok(n), Ok(v)) => (p, n, v),
        _ => return STATUS_BAD_ARGUMENT,
    };
    let input = MaskInput {
        rgba,
        labels,
        width: w,
        height: h,
        region,
        code: code as u8,
        pose_x,
        pose_y,
        prev: prev.as_ref().map(NeighbourData::borrow),
        next: next.as_ref().map(NeighbourData::borrow),
        vote,
        factor: factor as i32,
        noise,
    };
    consistency_mask(&input, out);
    STATUS_OK
}

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
        Ok(()) => STATUS_OK,
        Err(filter) => STATUS_BAD_FILTER - filter as i32,
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
    STATUS_OK
}
/// Tile descriptor (40 bytes): u32 pixels, coverage, provisional, quality, conflicts, owner, score, frozen
/// pointers, u32 size, u32 padding. Observation descriptor (64 bytes): u32 rgba, u32 width, u32 height,
/// u32 labels (0 = rectangular fast path), u32 code, u32 occlusions ptr, u32 occlusion count, u32 consistent
/// ptr (0 = all consistent), f64 confidence, u32 uncertain, u32 frame, 8 bytes padding.
/// `world` points at one rect; `out` holds COMPOSITE_HEADER_BYTES + 8 × block count.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_composite_tile(
    tile: u32,
    observation: u32,
    world: u32,
    ox: i32,
    oy: i32,
    tx: i32,
    ty: i32,
    out: u32,
) -> i32 {
    // SAFETY: descriptors are adapter-owned, bounds checked field by field below.
    let (Some(t), Some(o), Some(world)) = (
        unsafe { slice(tile, 40) },
        unsafe { slice(observation, 64) },
        unsafe { slice(world, 32) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let u = |d: &[u8], i: usize| u32::from_le_bytes(d[i..i + 4].try_into().unwrap());
    let size = u(t, 32) as usize;
    if size == 0 || !size.is_multiple_of(QUALITY_BLOCK) {
        return STATUS_BAD_ARGUMENT;
    }
    let n = size * size;
    let blocks = (size / QUALITY_BLOCK) * (size / QUALITY_BLOCK);
    let (width, height) = (u(o, 4) as usize, u(o, 8) as usize);
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: every buffer is validated against linear memory; tile buffers are distinct allocations.
    let (
        Some(pixels),
        Some(coverage),
        Some(provisional),
        Some(quality),
        Some(conflicts),
        Some(frozen),
        Some(rgba),
        Some(dst),
    ) = (unsafe {
        (
            slice_mut(u(t, 0), n * 4),
            slice_mut(u(t, 4), n.div_ceil(8)),
            slice_mut(u(t, 8), n.div_ceil(8)),
            slice_mut(u(t, 12), blocks),
            slice_mut(u(t, 16), blocks),
            slice(u(t, 28), blocks),
            slice(u(o, 0), width * height * 4),
            slice_mut(out, COMPOSITE_HEADER_BYTES + 8 * blocks),
        )
    })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    let (owner_ptr, score_ptr) = (u(t, 20), u(t, 24));
    if owner_ptr == 0
        || score_ptr == 0
        || owner_ptr % 4 != 0
        || score_ptr % 4 != 0
        || !in_bounds(owner_ptr, blocks * 4)
        || !in_bounds(score_ptr, blocks * 4)
    {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: 4-byte aligned, bounds checked, adapter-owned.
    let owner = unsafe { std::slice::from_raw_parts_mut(owner_ptr as *mut u32, blocks) };
    let score = unsafe { std::slice::from_raw_parts_mut(score_ptr as *mut f32, blocks) };
    let labels = if u(o, 12) == 0 {
        None
    } else {
        // SAFETY: label plane covers the frame.
        match unsafe { slice(u(o, 12), width * height) } {
            Some(l) => Some((l, u(o, 16) as u8)),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let occlusion_count = u(o, 24) as usize;
    // SAFETY: occlusion rects are adapter-owned.
    let occlusions = if occlusion_count == 0 {
        Vec::new()
    } else {
        match unsafe { slice(u(o, 20), occlusion_count * 32) } {
            Some(b) => read_rects(b),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let consistent = if u(o, 28) == 0 {
        None
    } else {
        // SAFETY: mask covers the frame.
        match unsafe { slice(u(o, 28), width * height) } {
            Some(c) => Some(c),
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let obs = Observation {
        rgba,
        width,
        height,
        labels,
        occlusions: &occlusions,
        consistent,
        confidence: f64::from_le_bytes(o[32..40].try_into().unwrap()),
        uncertain: u(o, 40) != 0,
        frame: u(o, 44),
    };
    let mut buffers = TileBuffers {
        size,
        pixels,
        coverage,
        provisional,
        quality,
        conflicts,
        owner,
        score,
        frozen,
    };
    let stats = composite_tile(
        &mut buffers,
        &obs,
        read_rect(world),
        ox as i64,
        oy as i64,
        tx as i64,
        ty as i64,
    );
    dst[0..4].copy_from_slice(&stats.added.to_le_bytes());
    dst[4..8].copy_from_slice(&stats.conflicts.to_le_bytes());
    dst[8..12].copy_from_slice(&stats.uncertain.to_le_bytes());
    dst[12..16].copy_from_slice(&stats.provisional_delta.to_le_bytes());
    dst[16..20].copy_from_slice(&(stats.changed as u32).to_le_bytes());
    dst[20..24].copy_from_slice(&(stats.conflict_blocks.len() as u32).to_le_bytes());
    for (i, (bx, by)) in stats.conflict_blocks.iter().enumerate() {
        let at = COMPOSITE_HEADER_BYTES + i * 8;
        dst[at..at + 4].copy_from_slice(&bx.to_le_bytes());
        dst[at + 4..at + 8].copy_from_slice(&by.to_le_bytes());
    }
    STATUS_OK
}
