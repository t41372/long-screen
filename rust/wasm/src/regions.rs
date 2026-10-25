//! Region construction and pixel labelling (`src/core/layers.ts::LayerLearner.finish`, `RegionAtlas`), backed by
//! `long_screen::kernels::regions`. Coarse-grained entry points, no per-region or per-pixel FFI:
//!   - `ls_regions_finish` builds every algorithmic-path region in one call, into a handle the adapter drains with
//!     `ls_regions_count`/`_cells_total`/`_read_headers`/`_read_masks`/`_read_cells`/`_free`. The scan session and
//!     the learner handle (`ls_scan_finish`, `ls_learner_finish`) hand their finished regions over the same way,
//!     manual layouts included (`write_finished`).
//!   - `ls_regions_label_atlas` builds `RegionAtlas.labels` for a whole region set in one call, reusing the
//!     64-byte per-region wire format `ls_voting_new` already defines (`wire::VOTING_REGION_BYTES`).
//!
//! Output region header (`REGION_HEADER_BYTES` = 88 bytes), written by `ls_regions_read_headers`:
//!   u32 kind (0 moving, 1 fixed), u32 id_index (the N in `layer-N`, and — for a moving region — the N in
//!   `内容画布 (N+1)`), u32 band_side (0 none, 1..4 = `LayerLearner.finish()`'s `bandSide`), u32 has_cells (0 for
//!   the pane divider, which never gets a `cells` array; 1 otherwise), u32 cells_count, rect (4×f64), crop
//!   (4×f64), u32 solid. `cells` and `mask` are separate bulk buffers (`ls_regions_read_cells`/`_read_masks`):
//!   masks are `mask_width × mask_height` bytes each (the caller already knows those dimensions — they are its
//!   own `width`/`height` — so they are not repeated per region), concatenated in region order; cells are u32
//!   analysis-cell indices, concatenated in region order, each region's span given by its header's `cells_count`.

use crate::bytes::Out;
use crate::memory::{slice, slice_mut, HandleTable};
use crate::wire::{read_optional_rect, read_rects, Reader, VOTING_REGION_BYTES};
use crate::STATUS_BAD_ARGUMENT;
use long_screen::engine::layers::ManualRegion;
use long_screen::kernels::geometry::Rect;
use long_screen::kernels::regions::{self, AtlasMask, AtlasRegion, FinishInput, Rgba};

/// `ls_layout` selector 10: bytes of one `ls_regions_finish` request descriptor (`run_finish`).
pub(crate) const REGIONS_FINISH_DESC_BYTES: usize = 120;
/// `ls_layout` selector 11: bytes of one output region header (see the module doc comment).
pub(crate) const REGION_HEADER_BYTES: usize = 88;

static mut HANDLES: HandleTable<Vec<regions::RegionOut>> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Vec<regions::RegionOut>> {
    // SAFETY: only the main instance touches HANDLES, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

/// Bytes read from adapter memory are little-endian on every target this project builds for (wasm32, plus the
/// x86-64/arm64 hosts `cargo test` runs on); a byte reinterpret avoids a copy on the hot path. `ls_alloc`'s
/// 8-byte alignment guarantees every pointer the adapter hands us is `f64`-aligned.
fn as_f64_slice(bytes: &[u8]) -> &[f64] {
    // SAFETY: `bytes` is 8-byte aligned (see above) and was bounds-checked by `slice()`; reinterpreting it as
    // `f64` reads the same little-endian bytes `f64::from_le_bytes` would, and does not outlive `bytes`.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const f64, bytes.len() / 8) }
}

/// Runs `regions::finish` over the request descriptor at `ptr` (`REGIONS_FINISH_DESC_BYTES` bytes, layout in the
/// module doc comment) and returns the built regions. Building `FinishInput` and calling `finish` in the same
/// scope (rather than handing a `FinishInput` borrowing adapter memory back to the caller) keeps every borrow
/// local to this function, with no unsound lifetime to assert.
///
/// # Safety
/// `ptr` points at `REGIONS_FINISH_DESC_BYTES` bytes; every embedded pointer is bounds-checked before use.
unsafe fn run_finish(ptr: u32) -> Option<Vec<regions::RegionOut>> {
    let d = slice(ptr, REGIONS_FINISH_DESC_BYTES)?;
    let r = Reader(d);
    let (width, height, cell) = (r.u32(0) as usize, r.u32(4) as usize, r.u32(8) as usize);
    if width == 0 || height == 0 || cell == 0 {
        return None;
    }
    let cols = width.div_ceil(cell);
    let rows = height.div_ceil(cell);
    let n = cols * rows;
    let native_width = r.f64(88);
    let native_height = r.f64(96);
    let row_change = slice(r.u32(32), height * 8)?;
    let col_change = slice(r.u32(36), width * 8)?;
    let col_mean = slice(r.u32(40), width * 8)?;
    let col_gain = slice(r.u32(44), cols * 8)?;
    let horizontal_gain = slice(r.u32(48), rows * 8)?;
    let split = slice(r.u32(52), n * 2 * 8)?;
    let evidence = slice(r.u32(56), n * 2 * 8)?;
    let activity = slice(r.u32(60), n * 8)?;
    let observations = slice(r.u32(64), n * 8)?;
    let native_row_change_bytes = match r.u32(68) {
        0 => None,
        p => Some(slice(p, native_height as usize * 8)?),
    };
    let native_col_change_bytes = match r.u32(72) {
        0 => None,
        p => Some(slice(p, native_width as usize * 8)?),
    };
    let reference_ptr = r.u32(76);
    let reference_bytes = if reference_ptr == 0 {
        None
    } else {
        let (rw, rh) = (r.u32(80) as usize, r.u32(84) as usize);
        if rw == 0 || rh == 0 {
            return None;
        }
        Some((rw, rh, slice(reference_ptr, rw * rh * 4)?))
    };
    let factor = r.u32(104);
    let col_moving = slice(r.u32(108), width * 8)?;
    let pixel_fixed = slice(r.u32(112), width * height * 8)?;
    let pixel_moving = slice(r.u32(116), width * height * 8)?;
    let input = FinishInput {
        width,
        height,
        cell,
        informative_frames: r.f64(16),
        native_frames: r.f64(24),
        row_change: as_f64_slice(row_change),
        col_change: as_f64_slice(col_change),
        col_moving: as_f64_slice(col_moving),
        col_mean: as_f64_slice(col_mean),
        col_gain: as_f64_slice(col_gain),
        horizontal_gain: as_f64_slice(horizontal_gain),
        split: as_f64_slice(split),
        evidence: as_f64_slice(evidence),
        activity: as_f64_slice(activity),
        observations: as_f64_slice(observations),
        pixel_fixed: as_f64_slice(pixel_fixed),
        pixel_moving: as_f64_slice(pixel_moving),
        native_row_change: native_row_change_bytes.map(as_f64_slice),
        native_row_middle: None,
        native_col_change: native_col_change_bytes.map(as_f64_slice),
        // The descriptor carries the frozen TS oracle's accumulators, which have no row votes; the engine's own
        // `RegionLearner::finish` passes them.
        row_fixed: None,
        row_moving: None,
        reference: reference_bytes.map(|(w, h, data)| Rgba {
            width: w,
            height: h,
            data,
        }),
    };
    Some(regions::finish(&input, native_width, native_height, factor))
}

/// Builds every algorithmic-path region for one `finish()` call. `desc` is a `REGIONS_FINISH_DESC_BYTES`
/// descriptor (see the module doc comment for its layout). Returns a handle (> 0) or a negative status.
#[no_mangle]
pub extern "C" fn ls_regions_finish(desc: u32) -> i32 {
    // SAFETY: adapter-owned descriptor and the buffers it points at, bounds checked.
    let Some(out) = (unsafe { run_finish(desc) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    handles().insert(out)
}

#[no_mangle]
pub extern "C" fn ls_regions_free(handle: u32) {
    handles().free(handle);
}

#[no_mangle]
pub extern "C" fn ls_regions_count(handle: u32) -> i32 {
    match handles().get(handle) {
        Some(regions) => regions.len() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_regions_cells_total(handle: u32) -> i32 {
    match handles().get(handle) {
        Some(regions) => regions
            .iter()
            .map(|r| r.cells.as_ref().map_or(0, |c| c.len()))
            .sum::<usize>() as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}

fn id_index(id: &str) -> u32 {
    id.strip_prefix("layer-")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// Writes `regions.len() × REGION_HEADER_BYTES` bytes (see the module doc comment for the row layout).
#[no_mangle]
pub extern "C" fn ls_regions_read_headers(handle: u32, out: u32) -> i32 {
    let Some(regions) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output, sized from `ls_regions_count`.
    let Some(dst) = (unsafe { slice_mut(out, regions.len() * REGION_HEADER_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (r, row) in regions
        .iter()
        .zip(dst.chunks_exact_mut(REGION_HEADER_BYTES))
    {
        row[0..4].copy_from_slice(
            &(if r.kind == regions::Kind::Fixed {
                1u32
            } else {
                0u32
            })
            .to_le_bytes(),
        );
        row[4..8].copy_from_slice(&id_index(&r.id).to_le_bytes());
        row[8..12].copy_from_slice(&(r.band_side.unwrap_or(0) as u32).to_le_bytes());
        row[12..16].copy_from_slice(&(r.cells.is_some() as u32).to_le_bytes());
        row[16..20]
            .copy_from_slice(&(r.cells.as_ref().map_or(0, |c| c.len()) as u32).to_le_bytes());
        write_rect(&mut row[20..52], r.rect);
        write_rect(&mut row[52..84], r.crop.unwrap_or(r.rect));
        row[84..88].copy_from_slice(&(r.solid as u32).to_le_bytes());
    }
    crate::STATUS_OK
}

fn write_rect(dst: &mut [u8], r: Rect) {
    dst[0..8].copy_from_slice(&r.x.to_le_bytes());
    dst[8..16].copy_from_slice(&r.y.to_le_bytes());
    dst[16..24].copy_from_slice(&r.width.to_le_bytes());
    dst[24..32].copy_from_slice(&r.height.to_le_bytes());
}

/// Writes every region's mask, concatenated in region order (`mask_width × mask_height` bytes each — the
/// caller's own analysis `width`/`height`, not repeated in the header).
#[no_mangle]
pub extern "C" fn ls_regions_read_masks(handle: u32, out: u32) -> i32 {
    let Some(regions) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let total: usize = regions
        .iter()
        .map(|r| r.mask.as_ref().map_or(0, |m| m.len()))
        .sum();
    // SAFETY: adapter-owned output, sized from the caller's own width×height×count.
    let Some(dst) = (unsafe { slice_mut(out, total) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut at = 0;
    for r in regions.iter() {
        if let Some(mask) = &r.mask {
            dst[at..at + mask.len()].copy_from_slice(mask);
            at += mask.len();
        }
    }
    crate::STATUS_OK
}

/// Writes every region's cell-index list (u32 little-endian), concatenated in region order; a region's span is
/// its header row's `cells_count`, running from the previous region's end.
#[no_mangle]
pub extern "C" fn ls_regions_read_cells(handle: u32, out: u32) -> i32 {
    let Some(regions) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let total: usize = regions
        .iter()
        .map(|r| r.cells.as_ref().map_or(0, |c| c.len()))
        .sum();
    // SAFETY: adapter-owned output, sized from `ls_regions_cells_total`.
    let Some(dst) = (unsafe { slice_mut(out, total * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut at = 0;
    for r in regions.iter() {
        if let Some(cells) = &r.cells {
            for &c in cells {
                dst[at..at + 4].copy_from_slice(&(c as u32).to_le_bytes());
                at += 4;
            }
        }
    }
    crate::STATUS_OK
}

/// Borrows every region's mask straight from adapter memory (no `.to_vec()` copy): `AtlasRegion`/`AtlasMask` only
/// need to live for the one `label_atlas` call below, unlike `voting.rs`'s `read_voting_regions`, which builds a
/// long-lived `Ring` and must own its masks.
///
/// # Safety
/// `ptr` points at `count × VOTING_REGION_BYTES` bytes whose embedded pointers cover the sizes they declare
/// (the same wire format `ls_voting_new` reads — see `wire::VOTING_REGION_BYTES`).
unsafe fn read_atlas_regions<'a>(ptr: u32, count: u32) -> Option<Vec<AtlasRegion<'a>>> {
    let bytes = slice(ptr, count as usize * VOTING_REGION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(VOTING_REGION_BYTES) {
        let r = Reader(c);
        let rect = crate::wire::read_rect(c);
        let exclusions = read_rects(slice(r.u32(32), r.u32(36) as usize * 32)?);
        let crop = read_optional_rect(r.u32(40)).ok()?;
        let mask = if r.u32(48) == 0 {
            None
        } else {
            let (w, h) = (r.u32(52) as usize, r.u32(56) as usize);
            if w == 0 || h == 0 {
                return None;
            }
            Some(AtlasMask {
                width: w,
                height: h,
                factor: r.u32(60),
                data: slice(r.u32(48), w * h)?,
            })
        };
        out.push(AtlasRegion {
            rect,
            exclusions,
            crop,
            solid: r.u32(44) != 0,
            mask,
        });
    }
    Some(out)
}

/// `RegionAtlas`'s pixel labelling for `count` regions at once (`wire::VOTING_REGION_BYTES` per region — the
/// same layout `ls_voting_new` uses), written directly into `labels_out` — the adapter's own core-resident label
/// plane (`Resident`), not a scratch buffer copied out afterward — plus the per-code pixel counts into
/// `counts_out` (`(count + 1) × 4` bytes, u32 little-endian, index 0 unused), computed in the same pass instead
/// of a second scan in TS. Returns `STATUS_TOO_MANY_REGIONS` when `count` exceeds 254 (one label byte can only
/// encode that many non-zero codes), matching the error `RegionAtlas`'s former TS constructor threw; never
/// panics across the boundary.
pub const STATUS_TOO_MANY_REGIONS: i32 = -2;
///
/// `epochs_ptr`/`epochs_len` carry the regions' ownership epochs (`read_epochs`; zero length for none): the plane is
/// labelled with the exclusions in effect at `frame` (`kernels::regions::exclusions_at`).
#[no_mangle]
pub extern "C" fn ls_regions_label_atlas(
    regions_ptr: u32,
    count: u32,
    width: u32,
    height: u32,
    epochs_ptr: u32,
    epochs_len: u32,
    frame: u32,
    labels_out: u32,
    counts_out: u32,
) -> i32 {
    if width == 0 || height == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned descriptors and output, bounds checked.
    let Some(mut defs) = (unsafe { read_atlas_regions(regions_ptr, count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: as above.
    let Some(epochs) = (unsafe { read_epochs(epochs_ptr, epochs_len, count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (def, epochs) in defs.iter_mut().zip(&epochs) {
        def.exclusions = regions::exclusions_at(&def.exclusions, epochs, frame);
    }
    if defs.len() > 254 {
        return STATUS_TOO_MANY_REGIONS;
    }
    // SAFETY: as above; `labels_out` is the adapter's own persistent Resident, sized `width × height`.
    let Some(labels) = (unsafe { slice_mut(labels_out, (width * height) as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(counts) = regions::label_atlas(&defs, width as usize, height as usize, labels) else {
        return STATUS_TOO_MANY_REGIONS;
    };
    // SAFETY: as above.
    let Some(counts_dst) = (unsafe { slice_mut(counts_out, counts.len() * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (c, d) in counts.iter().zip(counts_dst.chunks_exact_mut(4)) {
        d.copy_from_slice(&c.to_le_bytes());
    }
    crate::STATUS_OK
}

/// Every region's ownership epochs (`kernels::regions::RegionEpoch`), in region order: per region u32 n, then per
/// epoch u32 first frame, u32 k and k rects (4 × f64). A zero length is no epochs for any of the `count` regions.
///
/// # Safety
/// `ptr` is zero with `len` zero, or points at `len` readable bytes.
unsafe fn read_epochs(ptr: u32, len: u32, count: u32) -> Option<Vec<Vec<regions::RegionEpoch>>> {
    if len == 0 {
        return Some(vec![Vec::new(); count as usize]);
    }
    let mut c = crate::bytes::Cursor::new(slice(ptr, len as usize)?);
    (0..count)
        .map(|_| {
            (0..c.u32()?)
                .map(|_| {
                    let from = c.u32()?;
                    let exclusions = (0..c.u32()?)
                        .map(|_| {
                            Some(Rect {
                                x: c.f64()?,
                                y: c.f64()?,
                                width: c.f64()?,
                                height: c.f64()?,
                            })
                        })
                        .collect::<Option<_>>()?;
                    Some(regions::RegionEpoch { from, exclusions })
                })
                .collect::<Option<Vec<_>>>()
        })
        .collect()
}

/// The frames at which the regions' ownership may change (`kernels::regions::epoch_starts`), as u32s into `out`
/// (room for `cap`). Returns how many there are — at least one, the 0 every run starts with — or a negative status.
#[no_mangle]
pub extern "C" fn ls_regions_epoch_starts(
    epochs_ptr: u32,
    epochs_len: u32,
    count: u32,
    out: u32,
    cap: u32,
) -> i32 {
    // SAFETY: adapter-owned input, bounds checked.
    let Some(epochs) = (unsafe { read_epochs(epochs_ptr, epochs_len, count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let starts = regions::epoch_starts(epochs.iter().map(Vec::as_slice));
    if starts.len() > cap as usize {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: as above; room for `cap` u32s.
    let Some(dst) = (unsafe { slice_mut(out, starts.len() * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (s, d) in starts.iter().zip(dst.chunks_exact_mut(4)) {
        d.copy_from_slice(&s.to_le_bytes());
    }
    starts.len() as i32
}

/// Which of `count` epoch starts (u32s at `starts_ptr`, ascending) `frame` falls in (`kernels::regions::epoch_index`).
#[no_mangle]
pub extern "C" fn ls_regions_epoch_index(starts_ptr: u32, count: u32, frame: u32) -> i32 {
    // SAFETY: adapter-owned input, bounds checked.
    let Some(bytes) = (unsafe { slice(starts_ptr, count as usize * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let starts: Vec<u32> = bytes
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    regions::epoch_index(&starts, frame) as i32
}

/// Bytes of one hand-placed region descriptor (`read_manual`): 32-byte rect, u32 kind (0 moving, 1 fixed,
/// 2 ignore), u32 padding.
pub(crate) const MANUAL_REGION_BYTES: usize = 40;

/// Reads `count` hand-placed region descriptors. Their names stay with the adapter, which keeps the settings
/// objects they came from.
///
/// # Safety
/// `ptr` is zero with `count` zero, or points at `count × MANUAL_REGION_BYTES` readable bytes.
pub(crate) unsafe fn read_manual(ptr: u32, count: u32) -> Option<Vec<ManualRegion>> {
    let bytes = slice(ptr, count as usize * MANUAL_REGION_BYTES)?;
    bytes
        .chunks_exact(MANUAL_REGION_BYTES)
        .map(|c| {
            let kind = match Reader(c).u32(32) {
                0 => regions::Kind::Moving,
                1 => regions::Kind::Fixed,
                2 => regions::Kind::Ignore,
                _ => return None,
            };
            Some(ManualRegion {
                name: String::new(),
                kind,
                rect: crate::wire::read_rect(c),
            })
        })
        .collect()
}

/// Writes a finished region set for the adapter: u32 count, then per region u32 manual, u32 unassigned, u32
/// exclusion count and the exclusion rects, u32 epoch count and per epoch u32 first frame, u32 n + rects, u32
/// sticky-block count and the blocks; then u32 a regions handle (`ls_regions_read_*`, `ls_regions_free`) holding the
/// regions themselves.
pub(crate) fn write_finished(w: &mut Out, regions: Vec<regions::RegionOut>) {
    w.u32(regions.len() as u32);
    for r in &regions {
        w.u32(r.manual as u32);
        w.u32(r.unassigned as u32);
        w.u32(r.exclusions.len() as u32);
        for e in &r.exclusions {
            for v in [e.x, e.y, e.width, e.height] {
                w.f64(v);
            }
        }
        w.u32(r.epochs.len() as u32);
        for epoch in &r.epochs {
            w.u32(epoch.from);
            w.u32(epoch.exclusions.len() as u32);
            for e in &epoch.exclusions {
                for v in [e.x, e.y, e.width, e.height] {
                    w.f64(v);
                }
            }
        }
        w.u32(r.sticky.len() as u32);
        for s in &r.sticky {
            for v in [s.x, s.y, s.width, s.height] {
                w.f64(v);
            }
        }
    }
    w.u32(handles().insert(regions) as u32);
}
