//! Source-history handles and typed metadata. Native pixels stay in resident buffers; only metadata
//! crosses JSON, and persisted candidate payloads use the versioned Postcard format.
mod evidence;
mod opacity;
use super::memory::{slice, slice_mut, HandleTable};
use super::STATUS_BAD_ARGUMENT;
use crate::sources::tile::{Capture, TileHistory};
static mut TILES: HandleTable<TileHistory> = HandleTable::new();
static mut BYTES: HandleTable<Vec<u8>> = HandleTable::new();
fn tiles() -> &'static mut HandleTable<TileHistory> {
    // SAFETY: handles are accessed only by the main instance, never by pool helpers.
    unsafe { &mut *std::ptr::addr_of_mut!(TILES) }
}
fn bytes() -> &'static mut HandleTable<Vec<u8>> {
    // SAFETY: same main-instance ownership as TILES.
    unsafe { &mut *std::ptr::addr_of_mut!(BYTES) }
}
pub(crate) fn result(data: Vec<u8>) -> i32 {
    bytes().insert(data)
}
pub(crate) fn json<T: serde::Serialize>(value: &T) -> i32 {
    serde_json::to_vec(value)
        .map(result)
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_bytes_len(handle: u32) -> i32 {
    bytes()
        .get(handle)
        .map(|b| b.len() as i32)
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_bytes_read(handle: u32, out: u32) -> i32 {
    let Some(b) = bytes().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter allocated out according to bytes_len, separate from the owned result.
    let Some(out) = (unsafe { slice_mut(out, b.len()) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    out.copy_from_slice(b);
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_bytes_free(handle: u32) {
    bytes().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_new(
    size: u32,
    tx: i32,
    ty: i32,
    noise: u32,
    disputes: u32,
) -> i32 {
    if size == 0 || !size.is_multiple_of(16) || size > 4096 {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: one byte per quality block, owned by the adapter.
    let Some(d) = (unsafe { slice(disputes, (size as usize / 16).pow(2)) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    tiles().insert(TileHistory::new(
        size as usize,
        tx,
        ty,
        noise.min(255) as u8,
        d,
    ))
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_load(ptr: u32, len: u32) -> i32 {
    // SAFETY: immutable archive copied into the adapter arena.
    let Some(b) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    TileHistory::decode(b)
        .map(|t| tiles().insert(t))
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_free(handle: u32) {
    tiles().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_state(handle: u32) -> i32 {
    let Some(t) = tiles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    t.encode().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_spill(handle: u32) -> i32 {
    let Some(t) = tiles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    match t.spill() {
        Ok(Some(b)) => result(b),
        Ok(None) => 0,
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_stats(handle: u32) -> i32 {
    let Some(t) = tiles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&t.stats())
}
#[no_mangle]
pub extern "C" fn ls_sources_tile_capture(
    handle: u32,
    desc: u32,
    len: u32,
    rgba: u32,
    labels: u32,
    visibility: u32,
    ownership: u32,
    context_visibility: u32,
) -> i32 {
    let Some(t) = tiles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: metadata and native planes are adapter-owned and remain live for the call.
    let Some(d) = (unsafe { slice(desc, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(input) = serde_json::from_slice::<Capture>(d) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(n) = input.width.checked_mul(input.height) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (Some(rgba), Some(labels), Some(visibility)) = (
        unsafe { slice(rgba, n * 4) },
        unsafe { slice(labels, n) },
        unsafe { slice(visibility, n) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let ownership = if ownership == 0 {
        None
    } else {
        // SAFETY: optional immutable original-owner plane, also frame-sized.
        let Some(owner) = (unsafe { slice(ownership, n) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(owner)
    };
    let context_visibility = if context_visibility == 0 {
        None
    } else {
        // SAFETY: optional frame-sized auxiliary visibility plane.
        let Some(v) = (unsafe { slice(context_visibility, n) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(v)
    };
    t.capture_owned(
        &input,
        rgba,
        labels,
        visibility,
        ownership,
        context_visibility,
    );
    0
}

use crate::sources::analysis::TileAnalysis;
use crate::sources::scene::{EpochSweep, Scene};
static mut ANALYSES: HandleTable<TileAnalysis> = HandleTable::new();
static mut SCENES: HandleTable<Scene> = HandleTable::new();
static mut EPOCHS: HandleTable<EpochSweep> = HandleTable::new();
fn analyses() -> &'static mut HandleTable<TileAnalysis> {
    // SAFETY: main-instance handles, as above.
    unsafe { &mut *std::ptr::addr_of_mut!(ANALYSES) }
}
fn scenes() -> &'static mut HandleTable<Scene> {
    // SAFETY: main-instance handles, as above.
    unsafe { &mut *std::ptr::addr_of_mut!(SCENES) }
}
fn epochs() -> &'static mut HandleTable<EpochSweep> {
    // SAFETY: main-instance handles, as above.
    unsafe { &mut *std::ptr::addr_of_mut!(EPOCHS) }
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_new(size: u32, tx: i32, ty: i32, noise: u32) -> i32 {
    analyses().insert(TileAnalysis::new(
        size as usize,
        tx,
        ty,
        noise.min(255) as u8,
    ))
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_free(handle: u32) {
    analyses().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_feed(handle: u32, ptr: u32, len: u32, page: i32) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable archive bytes supplied by the adapter.
    let Some(data) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    if page < 0 {
        let Ok(state) = TileHistory::decode(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        a.feed_state(&state);
    } else {
        let Ok(entries) = crate::sources::tile::decode_page(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        a.feed_page(&entries, page);
    }
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_summary(handle: u32) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&a.summaries())
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_state(handle: u32) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.encode().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_load(ptr: u32, len: u32) -> i32 {
    // SAFETY: immutable archive bytes supplied by the adapter.
    let Some(data) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    TileAnalysis::decode(data)
        .map(|a| analyses().insert(a))
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_scene_new() -> i32 {
    scenes().insert(Scene::default())
}
#[no_mangle]
pub extern "C" fn ls_sources_scene_free(handle: u32) {
    scenes().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_scene_add(handle: u32, tx: i32, ty: i32, ptr: u32, len: u32) -> i32 {
    let Some(s) = scenes().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: typed metadata only; native image buffers never cross JSON.
    let Some(data) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(summary) = serde_json::from_slice::<Vec<crate::sources::analysis::BlockSummary>>(data)
    else {
        return STATUS_BAD_ARGUMENT;
    };
    s.add(tx, ty, &summary);
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_scene_components(handle: u32) -> i32 {
    let Some(s) = scenes().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&s.components())
}
#[no_mangle]
pub extern "C" fn ls_sources_epoch_new() -> i32 {
    epochs().insert(EpochSweep::default())
}
#[no_mangle]
pub extern "C" fn ls_sources_epoch_free(handle: u32) {
    epochs().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_epoch_add(
    handle: u32,
    expected: u32,
    ptr: u32,
    len: u32,
    new_block: u32,
) -> i32 {
    let Some(e) = epochs().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: typed metadata only, borrowed during the call.
    let Some(data) = (unsafe { slice(ptr, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(options) = serde_json::from_slice::<Vec<crate::sources::analysis::EpochOption>>(data)
    else {
        return STATUS_BAD_ARGUMENT;
    };
    if new_block != 0 {
        e.add(expected as u16, &options);
    } else {
        e.add_options(expected as u16, &options);
    }
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_epoch_choose(handle: u32, latest: u32) -> i32 {
    let Some(e) = epochs().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&e.choose(if latest == 0 {
        crate::sources::TemporalPolicy::Stable
    } else {
        crate::sources::TemporalPolicy::Latest
    }))
}

#[no_mangle]
pub extern "C" fn ls_sources_analysis_options(handle: u32) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    crate::sources::archive::encode(&(1u32, a.take_options()))
        .map(result)
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_epoch_page(
    handle: u32,
    data: u32,
    len: u32,
    targets: u32,
    targets_len: u32,
) -> i32 {
    let Some(sweep) = epochs().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable packed options and JSON block addresses supplied by the adapter.
    let (Some(data), Some(targets)) = (unsafe { slice(data, len as usize) }, unsafe {
        slice(targets, targets_len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok((version, options)) = crate::sources::archive::decode::<(
        u32,
        std::collections::BTreeMap<u16, Vec<crate::sources::analysis::EpochOption>>,
    )>(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(targets) = serde_json::from_slice::<Vec<crate::sources::scene::BlockAddress>>(targets)
    else {
        return STATUS_BAD_ARGUMENT;
    };
    if version != 1 {
        return STATUS_BAD_ARGUMENT;
    }
    for block in targets {
        if let Some(choices) = options.get(&block.block) {
            sweep.add_options(block.expected, choices);
        }
    }
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_block(
    handle: u32,
    block: u32,
    rgba: u32,
    frames: u32,
    reasons: u32,
) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(b) = a.blocks.get(&(block as u16)) else {
        return STATUS_BAD_ARGUMENT;
    };
    let r = b.resolution();
    // SAFETY: disjoint fixed-size output planes allocated by the adapter.
    let (Some(p), Some(f), Some(why)) = (
        unsafe { slice_mut(rgba, 1024) },
        unsafe { slice_mut(frames, 1024) },
        unsafe { slice_mut(reasons, 256) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    p.copy_from_slice(&r.rgba);
    for (i, frame) in r.sources.iter().enumerate() {
        f[i * 4..i * 4 + 4].copy_from_slice(&frame.to_le_bytes());
        why[i] = r.reasons[i] as u8;
    }
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_missing(
    handle: u32,
    block: u32,
    frame: u32,
    component: u32,
) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.select(block as u16, None, frame, component, false);
    0
}

use crate::sources::objects::{ObjectTracker, View};
static mut TRACKERS: HandleTable<ObjectTracker> = HandleTable::new();
fn trackers() -> &'static mut HandleTable<ObjectTracker> {
    // SAFETY: main-instance ownership, like the other source handles.
    unsafe { &mut *std::ptr::addr_of_mut!(TRACKERS) }
}
#[no_mangle]
pub extern "C" fn ls_sources_tracker_new() -> i32 {
    trackers().insert(ObjectTracker::default())
}
#[no_mangle]
pub extern "C" fn ls_sources_tracker_free(handle: u32) {
    trackers().free(handle)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MotionInput {
    #[serde(default)]
    auxiliary: bool,
    ownership: Option<u32>,
    width: usize,
    height: usize,
    frame: u32,
    code: u8,
    pose_x: f64,
    pose_y: f64,
    previous_x: f64,
    previous_y: f64,
    noise: u8,
}
#[no_mangle]
pub extern "C" fn ls_sources_tracker_observe(
    handle: u32,
    desc: u32,
    len: u32,
    rgba: u32,
    previous: u32,
    labels: u32,
    visibility: u32,
) -> i32 {
    let Some(t) = trackers().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: independent native frames, immutable atlas, and one writable visibility plane.
    let Some(data) = (unsafe { slice(desc, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(d) = serde_json::from_slice::<MotionInput>(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(n) = d.width.checked_mul(d.height) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (Some(rgba), Some(labels), Some(visibility)) = (
        unsafe { slice(rgba, n * 4) },
        unsafe { slice(labels, n) },
        unsafe { slice_mut(visibility, n) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let current = View {
        rgba,
        labels,
        width: d.width,
        height: d.height,
        code: d.code,
        pose: (
            crate::geometry::js_round(d.pose_x),
            crate::geometry::js_round(d.pose_y),
        ),
    };
    let previous = if previous == 0 {
        None
    } else {
        // SAFETY: previous has the same dimensions as the current frame ring slot.
        let Some(rgba) = (unsafe { slice(previous, n * 4) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(View {
            rgba,
            pose: (
                crate::geometry::js_round(d.previous_x),
                crate::geometry::js_round(d.previous_y),
            ),
            ..current
        })
    };
    let mut update = t.observe(d.frame, current, previous, d.noise, visibility);
    if d.auxiliary {
        if let (Some(previous), Some(ptr)) = (previous, d.ownership) {
            // SAFETY: optional original ownership has the same native dimensions as labels.
            let Some(ownership) = (unsafe { slice(ptr, d.width * d.height) }) else {
                return STATUS_BAD_ARGUMENT;
            };
            let witnesses = crate::sources::objects::ObjectTracker::previous_background(
                d.frame,
                current,
                previous,
                d.noise,
                visibility,
                ownership,
                &update.objects,
            );
            update.objects.extend(witnesses);
        }
    }
    evidence::update(update, d.auxiliary)
}
#[no_mangle]
pub extern "C" fn ls_sources_shards(size: u32, tx: i32, ty: i32, side: u32, ptr: u32) -> i32 {
    if size == 0 || !size.is_multiple_of(16) || side == 0 || !side.is_multiple_of(16) {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: one byte per source quality block.
    let Some(d) = (unsafe { slice(ptr, (size as usize / 16).pow(2)) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&crate::sources::materialize::shards(
        size as usize,
        tx,
        ty,
        side as usize,
        d,
    ))
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_apply(
    handle: u32,
    size: u32,
    tx: i32,
    ty: i32,
    rgba: u32,
    coverage: u32,
    provisional: u32,
    owner: u32,
) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = size as usize * size as usize;
    // SAFETY: adapter supplies separate writable tile planes of these exact sizes.
    let (Some(rgba), Some(cov), Some(prov), Some(owners)) = (
        unsafe { slice_mut(rgba, n * 4) },
        unsafe { slice_mut(coverage, n.div_ceil(8)) },
        unsafe { slice_mut(provisional, n.div_ceil(8)) },
        unsafe { slice_mut(owner, (size as usize / 16).pow(2) * 4) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut decoded: Vec<u32> = owners
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let applied = a.apply(crate::sources::materialize::TargetTile {
        size: size as usize,
        x: tx,
        y: ty,
        rgba,
        coverage: cov,
        provisional: prov,
        owner: &mut decoded,
    });
    for (value, out) in decoded.iter().zip(owners.chunks_exact_mut(4)) {
        out.copy_from_slice(&value.to_le_bytes());
    }
    json(&applied)
}
#[no_mangle]
pub extern "C" fn ls_sources_archive_frames(data: u32, len: u32, page: i32) -> i32 {
    // SAFETY: immutable archive provided by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    if page < 0 {
        let Ok(state) = TileHistory::decode(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        json(&crate::sources::annotation::frames(
            state.blocks.into_values().flat_map(|h| h.resident),
        ))
    } else {
        let Ok(entries) = crate::sources::tile::decode_page(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        json(&crate::sources::annotation::frames(
            entries.into_iter().map(|e| e.candidate),
        ))
    }
}
#[derive(serde::Deserialize)]
struct Annotation {
    size: usize,
    tx: i32,
    ty: i32,
    evidence: u32,
}
#[no_mangle]
pub extern "C" fn ls_sources_archive_annotate(
    data: u32,
    len: u32,
    page: i32,
    desc: u32,
    desc_len: u32,
    analysis: u32,
) -> i32 {
    // SAFETY: independent archive and metadata inputs in the adapter arena.
    let (Some(data), Some(desc)) = (unsafe { slice(data, len as usize) }, unsafe {
        slice(desc, desc_len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(d) = serde_json::from_slice::<Annotation>(desc) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = d.size / 16;
    if n == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let Some(evidence) = evidence::get(d.evidence) else {
        return STATUS_BAD_ARGUMENT;
    };
    let annotate = |block: u16, c: &mut crate::sources::Candidate| {
        evidence.apply(
            c,
            d.tx * d.size as i32 + (block as usize % n * 16) as i32,
            d.ty * d.size as i32 + (block as usize / n * 16) as i32,
        )
    };
    if page < 0 {
        let Ok(mut state) = TileHistory::decode(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        for (&block, h) in &mut state.blocks {
            for c in &mut h.resident {
                annotate(block, c);
            }
        }
        if analysis != 0 {
            let Some(a) = analyses().get(analysis) else {
                return STATUS_BAD_ARGUMENT;
            };
            a.feed_state(&state);
        }
        state.encode().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
    } else {
        let Ok(mut entries) = crate::sources::tile::decode_page(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        for e in &mut entries {
            annotate(e.block, &mut e.candidate);
        }
        if analysis != 0 {
            let Some(a) = analyses().get(analysis) else {
                return STATUS_BAD_ARGUMENT;
            };
            a.feed_page(&entries, page);
        }
        crate::sources::archive::encode(&(1u32, entries))
            .map(result)
            .unwrap_or(STATUS_BAD_ARGUMENT)
    }
}

#[derive(serde::Deserialize)]
struct EpochTarget {
    block: u16,
    frame: u32,
    component: u32,
    complete: bool,
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_epoch(
    handle: u32,
    data: u32,
    len: u32,
    page: i32,
    desc: u32,
    desc_len: u32,
) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable candidate and target inputs in separate arena ranges.
    let (Some(data), Some(desc)) = (unsafe { slice(data, len as usize) }, unsafe {
        slice(desc, desc_len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(targets) = serde_json::from_slice::<Vec<EpochTarget>>(desc) else {
        return STATUS_BAD_ARGUMENT;
    };
    let entries: Vec<_> = if page < 0 {
        let Ok(state) = TileHistory::decode(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        state
            .blocks
            .into_iter()
            .flat_map(|(block, h)| {
                h.resident
                    .into_iter()
                    .map(move |candidate| crate::sources::tile::SpillEntry { block, candidate })
            })
            .collect()
    } else {
        let Ok(entries) = crate::sources::tile::decode_page(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        entries
    };
    for e in &entries {
        if let Some(t) = targets
            .iter()
            .find(|t| t.block == e.block && e.candidate.contains_frame(t.frame))
        {
            a.select(
                t.block,
                Some(&e.candidate),
                t.frame,
                t.component,
                t.complete,
            );
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn ls_sources_archive_export(data: u32, len: u32, page: i32, png: u32) -> i32 {
    // SAFETY: immutable archive provided by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(entries) = crate::sources::export::entries(data, page) else {
        return STATUS_BAD_ARGUMENT;
    };
    let (sheet, rgba) = crate::sources::export::sheet(entries);
    if png == 0 {
        json(&sheet)
    } else {
        crate::sources::export::encode_png(&sheet, &rgba)
            .map(result)
            .unwrap_or(STATUS_BAD_ARGUMENT)
    }
}

#[no_mangle]
pub extern "C" fn ls_sources_analysis_baseline(
    handle: u32,
    history: u32,
    len: u32,
    size: u32,
    tx: i32,
    ty: i32,
    rgba: u32,
    coverage: u32,
) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = size as usize * size as usize;
    // SAFETY: archive and read-only tile planes are disjoint adapter buffers.
    let (Some(h), Some(rgba), Some(coverage)) = (
        unsafe { slice(history, len as usize) },
        unsafe { slice(rgba, n * 4) },
        unsafe { slice(coverage, n.div_ceil(8)) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(h) = TileHistory::decode(h) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.baseline_tile(&h, size as usize, tx, ty, rgba, coverage);
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_copy_baseline(handle: u32, other: u32) -> i32 {
    if handle == other {
        return STATUS_BAD_ARGUMENT;
    }
    let Some(reference) = analyses().get(other) else {
        return STATUS_BAD_ARGUMENT;
    };
    // Copy only the baseline; none of the old visibility ranks may survive reannotation.
    let mut copy = TileAnalysis::new(reference.size, reference.tx, reference.ty, reference.noise);
    copy.copy_baseline(reference);
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.copy_baseline(&copy);
    0
}

#[no_mangle]
pub extern "C" fn ls_sources_same_frame(a: u32, b: u32, len: u32) -> i32 {
    // SAFETY: independent resident frame-ring slots with matching dimensions.
    let (Some(a), Some(b)) = (unsafe { slice(a, len as usize) }, unsafe {
        slice(b, len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    (a == b) as i32
}

#[no_mangle]
pub extern "C" fn ls_sources_analysis_refute_needed(handle: u32) -> i32 {
    analyses()
        .get(handle)
        .map(|a| a.needs_refutation() as i32)
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_analysis_refute(handle: u32, data: u32, len: u32, page: i32) -> i32 {
    let Some(a) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable native archive allocated by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(entries) = crate::sources::export::entries(data, page) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.refute(&entries) as i32
}

#[no_mangle]
pub extern "C" fn ls_sources_parent_labels(
    labels: u32,
    len: u32,
    regions: u32,
    regions_len: u32,
    out: u32,
) -> i32 {
    // SAFETY: input/output label planes are disjoint frame-sized adapter buffers.
    let (Some(labels), Some(regions), Some(out)) = (
        unsafe { slice(labels, len as usize) },
        unsafe { slice(regions, regions_len as usize) },
        unsafe { slice_mut(out, len as usize) },
    ) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(regions) = serde_json::from_slice::<Vec<crate::sources::ownership::Region>>(regions)
    else {
        return STATUS_BAD_ARGUMENT;
    };
    crate::sources::ownership::parent_labels(labels, &regions, out) as i32
}

#[no_mangle]
pub extern "C" fn ls_sources_ownership_shards(
    labels: u32,
    parents: u32,
    desc: u32,
    len: u32,
) -> i32 {
    let Some(bytes) = (unsafe { slice(desc, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(replay) = serde_json::from_slice::<crate::sources::ownership::Replay>(bytes) else {
        return STATUS_BAD_ARGUMENT;
    };
    if replay.side == 0 || !replay.side.is_multiple_of(16) {
        return STATUS_BAD_ARGUMENT;
    }
    let Some(n) = replay.width.checked_mul(replay.height) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: both resident label planes cover the declared native frame dimensions.
    let (Some(labels), Some(parents)) = (unsafe { slice(labels, n) }, unsafe { slice(parents, n) })
    else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&crate::sources::ownership::shards(labels, parents, replay))
}

#[no_mangle]
pub extern "C" fn ls_sources_analysis_corroborate(
    handle: u32,
    data: u32,
    len: u32,
    page: i32,
) -> i32 {
    let Some(analysis) = analyses().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable native archive allocated by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(entries) = crate::sources::export::entries(data, page) else {
        return STATUS_BAD_ARGUMENT;
    };
    analysis.corroborate(&entries);
    0
}
