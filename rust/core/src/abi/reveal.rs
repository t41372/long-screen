//! Reveal-run handles (`crate::reveal::run`): overlay-aware block selection after the compositor. The adapter
//! feeds decoded frames (resident) and per-frame moving-layer decisions, drains block copies, and writes the
//! deferred blocks at the end.

use crate::abi::memory::{slice, slice_mut, HandleTable};
use crate::abi::{STATUS_BAD_ARGUMENT, STATUS_OK};
use crate::reveal::blocks::Deferred;
use crate::reveal::run::{canvas_bytes, layer_bytes, Decision, Pass, Reveal};
use crate::reveal::CanvasView;

/// Decision descriptor: layer u32, canvas u32, x i32, y i32, occlusion count u32, occlusion pointer u32
/// (each occlusion: x, y, width, height as i32).
pub const REVEAL_DECISION_BYTES: usize = 24;
/// Block-write record: canvas u32, gx i32, gy i32, sx i32, sy i32, frame u32, kind u32.
pub const REVEAL_WRITE_BYTES: usize = 28;
/// Provenance header: gx i32, gy i32, bw u32, bh u32; then bw × bh i32 sources.
pub const REVEAL_PROVENANCE_HEADER_BYTES: usize = 16;
/// Deferred-block record: gx i32, gy i32, frame u32, kind u32, then 16×16 RGBA (alpha 0 keeps the canvas pixel).
pub const REVEAL_DEFERRED_BYTES: usize = 16 + 16 * 16 * 4;

struct RevealHandle {
    run: Reveal,
    deferred: Vec<Deferred>,
}

static mut REVEAL: HandleTable<RevealHandle> = HandleTable::new();

fn handles() -> &'static mut HandleTable<RevealHandle> {
    // SAFETY: only the main instance touches REVEAL, and only through these exported entry points.
    unsafe { &mut *std::ptr::addr_of_mut!(REVEAL) }
}

fn get(handle: u32) -> Option<&'static mut RevealHandle> {
    handles().get(handle)
}

#[inline]
fn i32_at(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// A handle (> 0) or `STATUS_BAD_ARGUMENT`.
#[no_mangle]
pub extern "C" fn ls_reveal_new(width: u32, height: u32, noise: f64) -> i32 {
    if width == 0 || height == 0 || !noise.is_finite() || noise < 0.0 {
        return STATUS_BAD_ARGUMENT;
    }
    handles().insert(RevealHandle {
        run: Reveal::new(width as usize, height as usize, noise),
        deferred: Vec::new(),
    })
}

#[no_mangle]
pub extern "C" fn ls_reveal_free(handle: u32) {
    handles().free(handle);
}

/// Adds a moving layer (screen rectangle and atlas code, 0 = owns its rectangle). Returns its slot.
#[no_mangle]
pub extern "C" fn ls_reveal_layer(
    handle: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    code: u32,
) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if width == 0 || height == 0 || code > 255 {
        return STATUS_BAD_ARGUMENT;
    }
    h.run.add_layer(
        x as i64,
        y as i64,
        width as usize,
        height as usize,
        code as u8,
    ) as i32
}

/// Adds a moving canvas (world bounds). Returns its slot.
#[no_mangle]
pub extern "C" fn ls_reveal_canvas(handle: u32, x: i32, y: i32, width: u32, height: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    h.run
        .add_canvas(x as i64, y as i64, width as usize, height as usize) as i32
}

/// Adds a tile of the compositor's canvas (RGBA and LSB-first coverage bits, world origin) to its reference.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_reveal_ingest(
    handle: u32,
    canvas: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    rgba: u32,
    coverage: u32,
) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = width as usize * height as usize;
    // SAFETY: adapter-owned buffers, bounds checked.
    let (Some(rgba), Some(coverage)) = (unsafe { slice(rgba, n * 4) }, unsafe {
        slice(coverage, n.div_ceil(8))
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    if canvas as usize >= h.run.canvases.len() {
        return STATUS_BAD_ARGUMENT;
    }
    h.run.ingest(
        canvas as usize,
        &CanvasView {
            x: x as i64,
            y: y as i64,
            width: width as usize,
            height: height as usize,
            rgba,
            coverage,
        },
    );
    STATUS_OK
}

/// Starts pass 0 (learn), 1 (agree), 2 (relearn) or 3 (write).
/// Core memory a reveal canvas of `width × height` holds, its write pass's fallback state aside
/// (`reveal::run::canvas_bytes`).
#[no_mangle]
pub extern "C" fn ls_reveal_canvas_bytes(width: u32, height: u32) -> f64 {
    canvas_bytes(width as usize, height as usize) as f64
}

/// Core memory a reveal layer of `width × height` holds (`reveal::run::layer_bytes`).
#[no_mangle]
pub extern "C" fn ls_reveal_layer_bytes(width: u32, height: u32) -> f64 {
    layer_bytes(width as usize, height as usize) as f64
}

/// The write pass's fallback state at most, once the agree pass has run (`Reveal::fallback_bytes`); -1 for a bad
/// handle.
#[no_mangle]
pub extern "C" fn ls_reveal_fallback_bytes(handle: u32) -> f64 {
    get(handle).map_or(-1.0, |h| h.run.fallback_bytes() as f64)
}

#[no_mangle]
pub extern "C" fn ls_reveal_begin(handle: u32, pass: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let pass = match pass {
        0 => Pass::Learn,
        1 => Pass::Agree,
        2 => Pass::Relearn,
        3 => Pass::Write,
        _ => return STATUS_BAD_ARGUMENT,
    };
    h.run.begin(pass);
    STATUS_OK
}

/// Fallback blocks of `canvas` as (gx, gy) i32 pairs written to `out` (up to `max`); returns the total count.
#[no_mangle]
pub extern "C" fn ls_reveal_fallbacks(handle: u32, canvas: u32, out: u32, max: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if canvas as usize >= h.run.canvases.len() {
        return STATUS_BAD_ARGUMENT;
    }
    let blocks = h.run.fallback_blocks(canvas as usize);
    let n = blocks.len().min(max as usize);
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, n * 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (k, (gx, gy)) in blocks.iter().take(n).enumerate() {
        dst[k * 8..k * 8 + 4].copy_from_slice(&(*gx as i32).to_le_bytes());
        dst[k * 8 + 4..k * 8 + 8].copy_from_slice(&(*gy as i32).to_le_bytes());
    }
    blocks.len() as i32
}

/// The compositor's 16×16 RGBA for fallback block (gx, gy) of `canvas`.
#[no_mangle]
pub extern "C" fn ls_reveal_set_main(handle: u32, canvas: u32, gx: i32, gy: i32, rgba: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned buffer, bounds checked.
    let Some(rgba) = (unsafe { slice(rgba, 16 * 16 * 4) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    if canvas as usize >= h.run.canvases.len() {
        return STATUS_BAD_ARGUMENT;
    }
    h.run.set_main(canvas as usize, gx as i64, gy as i64, rgba);
    STATUS_OK
}

/// # Safety
/// `ptr` points at `count × REVEAL_DECISION_BYTES` bytes whose occlusion pointers cover what they declare.
unsafe fn read_decisions(run: &Reveal, ptr: u32, count: u32) -> Option<Vec<Decision>> {
    let bytes = slice(ptr, count as usize * REVEAL_DECISION_BYTES)?;
    let mut out = Vec::with_capacity(count as usize);
    for c in bytes.chunks_exact(REVEAL_DECISION_BYTES) {
        let (layer, canvas) = (i32_at(c, 0) as usize, i32_at(c, 4) as usize);
        if layer >= run.layers.len() || canvas >= run.canvases.len() {
            return None;
        }
        let n = i32_at(c, 16) as usize;
        let occ = slice(i32_at(c, 20) as u32, n * 16)?;
        let occlusions = occ
            .chunks_exact(16)
            .map(|o| {
                (
                    i32_at(o, 0) as i64,
                    i32_at(o, 4) as i64,
                    i32_at(o, 8) as i64,
                    i32_at(o, 12) as i64,
                )
            })
            .collect();
        out.push(Decision {
            layer,
            canvas,
            x: i32_at(c, 8) as i64,
            y: i32_at(c, 12) as i64,
            occlusions,
        });
    }
    Some(out)
}

/// One decoded frame: `current` (and `prev`, `prev2`, 0 = absent) are width × height RGBA, `labels` the atlas
/// label plane (0 = none), `decisions` this frame's moving-layer placements.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ls_reveal_frame(
    handle: u32,
    index: u32,
    current: u32,
    prev: u32,
    prev2: u32,
    labels: u32,
    decisions: u32,
    count: u32,
) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = h.run.width * h.run.height;
    // SAFETY: adapter-owned resident buffers, bounds checked.
    let optional = |p: u32, len: usize| {
        if p == 0 {
            Some(None)
        } else {
            unsafe { slice(p, len) }.map(Some)
        }
    };
    let (Some(current), Some(prev), Some(prev2), Some(labels)) = (
        optional(current, n * 4),
        optional(prev, n * 4),
        optional(prev2, n * 4),
        optional(labels, n),
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: as above.
    let Some(decisions) = (unsafe { read_decisions(&h.run, decisions, count) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    h.run.frame(index, current, prev, prev2, labels, &decisions);
    STATUS_OK
}

/// Ends a selection pass: open runs vote with `last` (the final frame) and `before` (the one ahead of it, 0 = none).
#[no_mangle]
pub extern "C" fn ls_reveal_end(handle: u32, last: u32, before: u32, labels: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = h.run.width * h.run.height;
    let optional = |p: u32, len: usize| {
        if p == 0 {
            Some(None)
        } else {
            unsafe { slice(p, len) }.map(Some)
        }
    };
    // SAFETY: adapter-owned resident buffers, bounds checked.
    let (Some(last), Some(before), Some(labels)) = (
        optional(last, n * 4),
        optional(before, n * 4),
        optional(labels, n),
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    h.run.end(last, before, labels);
    STATUS_OK
}

/// Drains up to `max` pending block writes into `out`; returns how many were written (0 when none remain).
#[no_mangle]
pub extern "C" fn ls_reveal_writes(handle: u32, out: u32, max: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = h.run.writes.len().min(max as usize);
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, n * REVEAL_WRITE_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (k, w) in h.run.writes.drain(..n).enumerate() {
        let o = &mut dst[k * REVEAL_WRITE_BYTES..(k + 1) * REVEAL_WRITE_BYTES];
        for (i, v) in [
            w.canvas as i32,
            w.gx as i32,
            w.gy as i32,
            w.sx as i32,
            w.sy as i32,
            w.frame as i32,
            w.kind as i32,
        ]
        .iter()
        .enumerate()
        {
            o[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    n as i32
}

/// Computes the deferred blocks of `canvas`; returns their count (read them with `ls_reveal_deferred`).
#[no_mangle]
pub extern "C" fn ls_reveal_finish(handle: u32, canvas: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if canvas as usize >= h.run.canvases.len() {
        return STATUS_BAD_ARGUMENT;
    }
    h.deferred = h.run.finish(canvas as usize);
    h.deferred.len() as i32
}

/// Deferred block `k` of the last `ls_reveal_finish` into `out` (`REVEAL_DEFERRED_BYTES`).
#[no_mangle]
pub extern "C" fn ls_reveal_deferred(handle: u32, k: u32, out: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(d) = h.deferred.get(k as usize) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, REVEAL_DEFERRED_BYTES) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (i, v) in [d.gx as i32, d.gy as i32, d.frame as i32, d.kind as i32]
        .iter()
        .enumerate()
    {
        dst[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    dst[16..].copy_from_slice(&d.rgba[..]);
    STATUS_OK
}

/// Six u32 counters: overlay objects, dynamic components, coherent, component, provisional and fallback blocks.
#[no_mangle]
pub extern "C" fn ls_reveal_summary(handle: u32, out: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output.
    let Some(dst) = (unsafe { slice_mut(out, 24) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let s = h.run.summary();
    for (i, v) in [
        s.objects,
        s.components,
        s.coherent,
        s.component_blocks,
        s.provisional,
        s.fallback,
    ]
    .iter()
    .enumerate()
    {
        dst[i * 4..i * 4 + 4].copy_from_slice(&(*v as u32).to_le_bytes());
    }
    STATUS_OK
}

/// Where each block of `canvas` now takes its pixels from (`crate::reveal::blocks::Output::sources`), for the blocks
/// the last [`ls_reveal_finish`] of that canvas returned: the header then one i32 per block, row-major. Returns the
/// block count; with `out` 0 only the count. 0 when the canvas has no output.
#[no_mangle]
pub extern "C" fn ls_reveal_provenance(handle: u32, canvas: u32, out: u32, max: u32) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if canvas as usize >= h.run.canvases.len() {
        return STATUS_BAD_ARGUMENT;
    }
    let Some((gx, gy, bw, bh, sources)) = h.run.provenance(canvas as usize, &h.deferred) else {
        return 0;
    };
    if out == 0 {
        return sources.len() as i32;
    }
    if (max as usize) < sources.len() {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned output of the header plus `max` sources.
    let Some(dst) = (unsafe { slice_mut(out, REVEAL_PROVENANCE_HEADER_BYTES + sources.len() * 4) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    for (i, v) in [gx as i32, gy as i32, bw as i32, bh as i32]
        .iter()
        .enumerate()
    {
        dst[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    for (i, v) in sources.iter().enumerate() {
        let o = REVEAL_PROVENANCE_HEADER_BYTES + i * 4;
        dst[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }
    sources.len() as i32
}

/// Every frame's decisions from `counts[i]` (u32, frame `i`'s decision count) and `decisions` (all frames' decision
/// descriptors in order, occlusions ignored), or `None` when a pointer, layer or canvas is out of range.
fn read_plans(
    run: &Reveal,
    frames: u32,
    counts: u32,
    decisions: u32,
) -> Option<Vec<Vec<Decision>>> {
    let n = frames as usize;
    // SAFETY: adapter-owned input.
    let counts = unsafe { slice(counts, n * 4) }?;
    let total: usize = (0..n).map(|i| i32_at(counts, i * 4) as usize).sum();
    // SAFETY: adapter-owned descriptors.
    let raw = unsafe { slice(decisions, total * REVEAL_DECISION_BYTES) }?;
    let mut plans = Vec::with_capacity(n);
    let mut at = 0;
    for i in 0..n {
        let mut ds = Vec::new();
        for _ in 0..i32_at(counts, i * 4) {
            let o = at * REVEAL_DECISION_BYTES;
            let (layer, canvas) = (i32_at(raw, o) as usize, i32_at(raw, o + 4) as usize);
            if layer >= run.layers.len() || canvas >= run.canvases.len() {
                return None;
            }
            ds.push(Decision {
                layer,
                canvas,
                x: i32_at(raw, o + 8) as i64,
                y: i32_at(raw, o + 12) as i64,
                occlusions: Vec::new(),
            });
            at += 1;
        }
        plans.push(ds);
    }
    Some(plans)
}

/// Which of `frames` decoded frames the current pass reads pixels of (`crate::reveal::run::Reveal::wanted`), one byte
/// (0/1) per frame into `out`. `counts` and `decisions` as in [`read_plans`].
#[no_mangle]
pub extern "C" fn ls_reveal_wanted(
    handle: u32,
    frames: u32,
    counts: u32,
    decisions: u32,
    out: u32,
) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(plans) = read_plans(&h.run, frames, counts, decisions) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned output.
    let Some(out) = (unsafe { slice_mut(out, frames as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    for (o, w) in out.iter_mut().zip(h.run.wanted(&plans)) {
        *o = w as u8;
    }
    STATUS_OK
}

/// Which decisions the passes use (`crate::reveal::run::admitted`): `blind` holds one byte (0/1) per decision, in the
/// order of `decisions`, and `out` receives one byte (0/1) per decision. `counts` and `decisions` as in
/// [`read_plans`].
#[no_mangle]
pub extern "C" fn ls_reveal_admitted(
    handle: u32,
    frames: u32,
    counts: u32,
    decisions: u32,
    blind: u32,
    out: u32,
) -> i32 {
    let Some(h) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(plans) = read_plans(&h.run, frames, counts, decisions) else {
        return STATUS_BAD_ARGUMENT;
    };
    let total: usize = plans.iter().map(Vec::len).sum();
    // SAFETY: adapter-owned input and output.
    let (Some(blind), Some(out)) = (unsafe { slice(blind, total) }, unsafe {
        slice_mut(out, total)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut flags = blind.iter();
    let plans: Vec<Vec<(Decision, bool)>> = plans
        .into_iter()
        .map(|ds| {
            ds.into_iter()
                .map(|d| (d, *flags.next().unwrap() != 0))
                .collect()
        })
        .collect();
    for (o, a) in out
        .iter_mut()
        .zip(crate::reveal::run::admitted(&plans).into_iter().flatten())
    {
        *o = a as u8;
    }
    STATUS_OK
}
