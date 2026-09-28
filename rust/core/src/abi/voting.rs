//! Voting-ring handles: per-region motion voting across a rolling frame window, finalised records drained by
//! the adapter.

use crate::abi::memory::{slice, slice_mut, HandleTable};
use crate::abi::wire::{read_optional_rect, read_rects, Reader, VOTING_REGION_BYTES};
use crate::abi::STATUS_BAD_ARGUMENT;
use crate::region::{Mask as RegionMask, Region as RegionDef};
use crate::voting::{Finalized, Ring};

/// Finalised voting records waiting to be read by the adapter, oldest first.
struct VotingHandle {
    ring: Ring,
    pending: std::collections::VecDeque<Finalized>,
}

static mut VOTING: HandleTable<VotingHandle> = HandleTable::new();

fn voting_handles() -> &'static mut HandleTable<VotingHandle> {
    // SAFETY: only the main instance touches VOTING, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(VOTING) }
}

fn voting(handle: u32) -> Option<&'static mut VotingHandle> {
    voting_handles().get(handle)
}

/// # Safety
/// `ptr` points at `count × VOTING_REGION_BYTES` bytes whose pointers cover the sizes they declare.
/// Reused by `abi::track::ls_track_odometry` (same `VOTING_REGION_BYTES` wire format) for the one region a
/// fused odometry call needs for its own difference-sampling fallback.
pub(crate) unsafe fn read_voting_regions(ptr: u32, count: u32) -> Option<Vec<RegionDef>> {
    let bytes = slice(ptr, count as usize * VOTING_REGION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(VOTING_REGION_BYTES) {
        let r = Reader(c);
        let rect = crate::abi::wire::read_rect(c);
        let exclusions = read_rects(slice(r.u32(32), r.u32(36) as usize * 32)?);
        let crop = read_optional_rect(r.u32(40)).ok()?;
        let mask = if r.u32(48) == 0 {
            None
        } else {
            let (w, h) = (r.u32(52) as usize, r.u32(56) as usize);
            if w == 0 || h == 0 {
                return None;
            }
            Some(RegionMask {
                width: w,
                height: h,
                factor: r.u32(60),
                data: slice(r.u32(48), w * h)?.to_vec(),
            })
        };
        out.push(RegionDef {
            rect,
            exclusions,
            crop,
            solid: r.u32(44) != 0,
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
    voting_handles().insert(VotingHandle {
        ring,
        pending: Default::default(),
    })
}

#[no_mangle]
pub extern "C" fn ls_voting_free(handle: u32) {
    voting_handles().free(handle);
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
    crate::abi::STATUS_OK
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
    crate::abi::STATUS_OK
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
    crate::abi::STATUS_OK
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

/// Copies verdict `which` of the oldest pending record: `bits`, `clean`, and `screen`, each `ceil(w·h/8)` bytes.
#[no_mangle]
pub extern "C" fn ls_voting_read(
    handle: u32,
    which: u32,
    bits: u32,
    clean: u32,
    screen: u32,
) -> i32 {
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
    let Some(s) = (unsafe { slice_mut(screen, verdict.screen.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    s.copy_from_slice(&verdict.screen);
    crate::abi::STATUS_OK
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
