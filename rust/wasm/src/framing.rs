//! Presentation canvases (`src/core/wasm/framing.ts` mirrors this file): the engine's framing session
//! (`long_screen_engine::framing::FramingSession`), one handle per framed canvas `buildFramedCanvas` builds, plus
//! the layout/coordinate mapping the parity tests check on their own.
//!
//! `ls_framing_step` returns its result's length (error convention 6) and leaves it in the handle for
//! `ls_framing_take`. The result is a `bytes.rs` record: u8 kind, then
//!   0 need reference; 1 need index; 2 next output tile
//!   3 need tile: str canvas, u32 level, i32 x, i32 y
//!   4 save a resident tile: u32 cache id
//!   5 save a detached tile: str canvas, u32 level, i32 x, i32 y, u8 existed, f64 touched (its planes through
//!     `ls_framing_detached` until the next step)
//!   6 done, unframed; 7 done, skipped: the diagnostics (`diagnostic.rs`)
//!   8 done, framed: str id, f64 width, height, pane rect (4 × f64), u32 reference frame, f64 offset x, offset y,
//!     tile count, observed pixels, provisional pixels

use crate::bytes::{Cursor, Out};
use crate::diagnostic::write_diagnostics;
use crate::memory::{slice, slice_mut, HandleTable};
use crate::tiles::{tiles, TILE_PLANES_BYTES};
use crate::wire::{read_rect, Reader, VOTING_REGION_BYTES};
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen_core::framing::{frame_coordinate, frame_layout, Coordinate, Layout};
use long_screen_core::geometry::Rect;
use long_screen_core::region::{Mask as RegionMask, Region};
use long_screen_engine::framing::{
    FramingError, FramingSession, Outcome, Reference, SaveTile, SourceCanvas, Step,
};
use long_screen_engine::tiles::Tile;

/// Bytes of one serialised `Layout` (`ls_frame_layout`'s `out`): pane rect (32), content rect (32), dx f64 (8),
/// dy f64 (8), seam_x f64 (8), width f64 (8), height f64 (8).
pub(crate) const LAYOUT_BYTES: usize = 104;
/// `ls_framing_step` was called after `NeedTile` without the tile being inserted.
pub const STATUS_NOT_PROVIDED: i32 = -2;

fn write_layout(dst: &mut [u8], layout: &Layout) {
    let w = |dst: &mut [u8], at: usize, v: f64| dst[at..at + 8].copy_from_slice(&v.to_le_bytes());
    w(dst, 0, layout.pane.x);
    w(dst, 8, layout.pane.y);
    w(dst, 16, layout.pane.width);
    w(dst, 24, layout.pane.height);
    w(dst, 32, layout.content.x);
    w(dst, 40, layout.content.y);
    w(dst, 48, layout.content.width);
    w(dst, 56, layout.content.height);
    w(dst, 64, layout.dx);
    w(dst, 72, layout.dy);
    w(dst, 80, layout.seam_x);
    w(dst, 88, layout.width);
    w(dst, 96, layout.height);
}

fn read_layout(src: &[u8]) -> Layout {
    let r = Reader(src);
    Layout {
        pane: read_rect(&src[0..32]),
        content: read_rect(&src[32..64]),
        dx: r.f64(64),
        dy: r.f64(72),
        seam_x: r.f64(80),
        width: r.f64(88),
        height: r.f64(96),
    }
}

/// Computes `frameLayout`. `pane` is one 32-byte rect (`region.crop || region.rect`); `out` is `LAYOUT_BYTES`.
#[no_mangle]
pub extern "C" fn ls_frame_layout(
    source_width: f64,
    source_height: f64,
    pane: u32,
    bounds_width: f64,
    bounds_height: f64,
    out: u32,
) -> i32 {
    let (Some(pane), Some(out)) = (unsafe { slice(pane, 32) }, unsafe {
        slice_mut(out, LAYOUT_BYTES)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let layout = frame_layout(
        source_width,
        source_height,
        read_rect(pane),
        bounds_width,
        bounds_height,
    );
    write_layout(out, &layout);
    crate::STATUS_OK
}

/// Computes `frameCoordinate` for test/diagnostic use (not on the per-tile hot path, which classifies pixels
/// inline in the framing session). Returns 0 (content), 1 (extension), 2 (source — `out` holds x, y as two
/// f64), or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
pub extern "C" fn ls_frame_coordinate(layout: u32, x: f64, y: f64, out: u32) -> i32 {
    let (Some(layout), Some(out)) = (unsafe { slice(layout, LAYOUT_BYTES) }, unsafe {
        slice_mut(out, 16)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match frame_coordinate(&read_layout(layout), x, y) {
        Coordinate::Content => 0,
        Coordinate::Extension => 1,
        Coordinate::Source(sx, sy) => {
            out[0..8].copy_from_slice(&sx.to_le_bytes());
            out[8..16].copy_from_slice(&sy.to_le_bytes());
            2
        }
    }
}

/// # Safety
/// `ptr` points at `count × VOTING_REGION_BYTES` bytes whose embedded pointers cover the sizes they declare.
unsafe fn read_regions(ptr: u32, count: u32) -> Option<Vec<Region>> {
    let bytes = slice(ptr, count as usize * VOTING_REGION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(VOTING_REGION_BYTES) {
        let r = Reader(c);
        let rect = read_rect(&c[0..32]);
        let exclusions = crate::wire::read_rects(slice(r.u32(32), r.u32(36) as usize * 32)?);
        let crop = crate::wire::read_optional_rect(r.u32(40)).ok()?;
        let mask = if r.u32(48) == 0 {
            None
        } else {
            let (mw, mh) = (r.u32(52) as usize, r.u32(56) as usize);
            if mw == 0 || mh == 0 {
                return None;
            }
            Some(RegionMask {
                width: mw,
                height: mh,
                factor: r.u32(60),
                data: slice(r.u32(48), mw * mh)?.to_vec(),
            })
        };
        out.push(Region {
            rect,
            exclusions,
            crop,
            solid: r.u32(44) != 0,
            mask,
        });
    }
    Some(out)
}

struct Session {
    session: FramingSession,
    out: Vec<u8>,
    /// The detached output tile the last step asked the host to store.
    detached: Option<Box<Tile>>,
}

static mut FRAMINGS: HandleTable<Session> = HandleTable::new();

fn framings() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches FRAMINGS, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(FRAMINGS) }
}

fn status(error: FramingError) -> i32 {
    match error {
        FramingError::NotProvided => STATUS_NOT_PROVIDED,
        FramingError::Unexpected | FramingError::BadReference => STATUS_BAD_ARGUMENT,
    }
}

fn read_rect_record(c: &mut Cursor) -> Option<Rect> {
    Some(Rect {
        x: c.f64()?,
        y: c.f64()?,
        width: c.f64()?,
        height: c.f64()?,
    })
}

/// A session for one framed canvas. `input` is a `bytes.rs` record: str source canvas id, its bounds rect
/// (4 × f64), f64 tile count, u8 attached, the pane rect (4 × f64), u32 tile size, u32 tile limit. `ignore` holds
/// `ignore_count` `VOTING_REGION_BYTES` region descriptors (copied; they need not outlive the call). Returns a
/// handle.
#[no_mangle]
pub extern "C" fn ls_framing_new(input: u32, len: u32, ignore: u32, ignore_count: u32) -> i32 {
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(bytes) = (unsafe { slice(input, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut c = Cursor::new(bytes);
    let parsed = (|| {
        let id = c.str()?.to_string();
        let bounds = read_rect_record(&mut c)?;
        let tile_count = c.f64()?;
        let attached = c.bool()?;
        let pane = read_rect_record(&mut c)?;
        let size = c.u32()? as usize;
        let max_tiles = c.u32()? as usize;
        Some((id, bounds, tile_count, attached, pane, size, max_tiles))
    })();
    let Some((id, bounds, tile_count, attached, pane, size, max_tiles)) = parsed else {
        return STATUS_BAD_ARGUMENT;
    };
    let ignore = if ignore_count == 0 {
        Vec::new()
    } else {
        // SAFETY: adapter-owned descriptors whose embedded pointers cover what they declare.
        match unsafe { read_regions(ignore, ignore_count) } {
            Some(v) => v,
            None => return STATUS_BAD_ARGUMENT,
        }
    };
    let source = SourceCanvas {
        id,
        bounds,
        tile_count: if tile_count > 0.0 {
            tile_count as u64
        } else {
            0
        },
        attached,
    };
    framings().insert(Session {
        session: FramingSession::new(source, pane, ignore, size, max_tiles),
        out: Vec::new(),
        detached: None,
    })
}

#[no_mangle]
pub extern "C" fn ls_framing_free(handle: u32) {
    framings().free(handle)
}

/// The reference frame (`rgba` holds width × height × 4 bytes; copied), or none when `rgba` is 0.
#[no_mangle]
pub extern "C" fn ls_framing_reference(
    handle: u32,
    frame: u32,
    rgba: u32,
    width: u32,
    height: u32,
) -> i32 {
    let Some(s) = framings().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let reference = if rgba == 0 {
        None
    } else {
        let (w, h) = (width as usize, height as usize);
        // SAFETY: adapter-owned buffer, bounds checked.
        let Some(pixels) = (unsafe { slice(rgba, w * h * 4) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(Reference {
            frame,
            width: w,
            height: h,
            rgba: pixels.to_vec(),
        })
    };
    match s.session.reference(reference) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

/// One stored level-0 tile-index row of the source canvas.
#[no_mangle]
pub extern "C" fn ls_framing_index(handle: u32, x: i32, y: i32, observed: f64) -> i32 {
    let Some(s) = framings().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let observed = if observed > 0.0 { observed as u64 } else { 0 };
    match s.session.index(x, y, observed) {
        Ok(()) => STATUS_OK,
        Err(e) => status(e),
    }
}

fn write_key(w: &mut Out, canvas: &str, level: u32, x: i32, y: i32) {
    w.str(canvas);
    w.u32(level);
    w.u32(x as u32);
    w.u32(y as u32);
}

/// Runs the session against the tile cache `tiles_handle` to its next step, at the host's time `now`; returns the
/// result's length (see the module comment).
#[no_mangle]
pub extern "C" fn ls_framing_step(handle: u32, tiles_handle: u32, now: f64) -> i32 {
    let (Some(s), Some(t)) = (framings().get(handle), tiles(tiles_handle)) else {
        return STATUS_BAD_ARGUMENT;
    };
    s.detached = None;
    let step = match s.session.step(&mut t.cache, now) {
        Ok(step) => step,
        Err(e) => return status(e),
    };
    let mut w = Out::default();
    match step {
        Step::NeedReference => w.u8(0),
        Step::NeedIndex => w.u8(1),
        Step::Next => w.u8(2),
        Step::NeedTile(k) => {
            w.u8(3);
            write_key(&mut w, &k.canvas, k.level, k.x, k.y);
        }
        Step::Save(SaveTile::Resident(id)) => {
            w.u8(4);
            w.u32(id);
        }
        Step::Save(SaveTile::Detached(tile)) => {
            w.u8(5);
            write_key(
                &mut w,
                &tile.key.canvas,
                tile.key.level,
                tile.key.x,
                tile.key.y,
            );
            w.bool(tile.existed);
            w.f64(tile.touched.unwrap_or(f64::NAN));
            s.detached = Some(tile);
        }
        Step::Done(Outcome::Unframed) => w.u8(6),
        Step::Done(Outcome::Skipped(d)) => {
            w.u8(7);
            write_diagnostics(&mut w, &[d]);
        }
        Step::Done(Outcome::Framed(f)) => {
            w.u8(8);
            w.str(&f.id);
            w.f64(f.width);
            w.f64(f.height);
            for v in [
                f.source_region.x,
                f.source_region.y,
                f.source_region.width,
                f.source_region.height,
            ] {
                w.f64(v);
            }
            w.u32(f.reference_frame);
            w.f64(f.offset_x);
            w.f64(f.offset_y);
            w.f64(f.tile_count as f64);
            w.f64(f.observed_pixels as f64);
            w.f64(f.provisional_pixels as f64);
        }
    }
    s.out = w.0;
    s.out.len() as i32
}

#[no_mangle]
pub extern "C" fn ls_framing_take(handle: u32, out: u32, len: u32) -> i32 {
    let Some(s) = framings().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    crate::bytes::take(&mut s.out, out, len)
}

/// Where the detached output tile the last step returned keeps its planes, in `ls_tiles_planes`'s
/// `TILE_PLANES_BYTES` layout; valid until the next step or `ls_framing_free`.
#[no_mangle]
pub extern "C" fn ls_framing_detached(handle: u32, out: u32) -> i32 {
    let Some(s) = framings().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(tile) = s.detached.as_ref() else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(dst) = (unsafe { slice_mut(out, TILE_PLANES_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let planes: [(*const u8, usize); 8] = [
        (tile.pixels.as_ptr(), tile.pixels.len()),
        (tile.coverage.as_ptr(), tile.coverage.len()),
        (tile.provisional.as_ptr(), tile.provisional.len()),
        (tile.quality.as_ptr(), tile.quality.len()),
        (tile.conflicts.as_ptr(), tile.conflicts.len()),
        (tile.owner.as_ptr() as *const u8, tile.owner.len() * 4),
        (tile.score.as_ptr() as *const u8, tile.score.len() * 4),
        (tile.frozen.as_ptr(), tile.frozen.len()),
    ];
    for (i, (ptr, len)) in planes.into_iter().enumerate() {
        dst[i * 8..i * 8 + 4].copy_from_slice(&(ptr as usize as u32).to_le_bytes());
        dst[i * 8 + 4..i * 8 + 8].copy_from_slice(&(len as u32).to_le_bytes());
    }
    dst[64..68].copy_from_slice(&(tile.dirty as u32).to_le_bytes());
    dst[68..72].copy_from_slice(&(tile.existed as u32).to_le_bytes());
    dst[72..80].copy_from_slice(&tile.touched.unwrap_or(f64::NAN).to_le_bytes());
    STATUS_OK
}
