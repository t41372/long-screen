//! The solve pass's keyframe index (`long_screen::engine::keyframes::KeyframeIndex`), one handle per
//! `src/core/keyframes.ts` instance. Records are `bytes.rs` records; features travel separately in the usual
//! serialised layout (`wire::FEATURE_BYTES` each).
//!
//! `ls_keyframe_index_retrieve` returns its result's length and leaves it in the handle for
//! `ls_keyframe_index_take` (u8 budget warning, u32 count, then that many str ids), and keeps the retrieval for
//! `ls_keyframe_index_admits` to check the loaded candidates against.

use crate::bytes::{Cursor, Out};
use crate::features::read_features;
use crate::memory::{slice, slice_mut, HandleTable};
use crate::wire::FEATURE_BYTES;
use crate::{STATUS_BAD_ARGUMENT, STATUS_OK};
use long_screen::engine::keyframes::{KeyframeIndex, Retrieval};
use long_screen::kernels::features::DESCRIPTOR_WORDS;

struct Session {
    index: KeyframeIndex,
    retrieval: Option<Retrieval>,
    out: Vec<u8>,
}

static mut HANDLES: HandleTable<Session> = HandleTable::new();

fn handles() -> &'static mut HandleTable<Session> {
    // SAFETY: only the main instance touches HANDLES, and only through these exported entry points — no pool
    // helper thread reaches this module.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

/// The session, the input record and the features' descriptors, or `None` on a bad handle or buffer.
fn inputs<'a>(
    handle: u32,
    input: u32,
    len: u32,
    features: u32,
    count: u32,
) -> Option<(&'a mut Session, Cursor<'a>, Vec<[u32; DESCRIPTOR_WORDS]>)> {
    let session = handles().get(handle)?;
    // SAFETY: adapter-owned buffers, bounds-checked by `slice`.
    let bytes = unsafe { slice(input, len as usize) }?;
    let features = unsafe { slice(features, count as usize * FEATURE_BYTES) }?;
    let descriptors = read_features(features)
        .into_iter()
        .map(|f| f.descriptor)
        .collect();
    Some((session, Cursor::new(bytes), descriptors))
}

#[no_mangle]
pub extern "C" fn ls_keyframe_index_new() -> i32 {
    handles().insert(Session {
        index: KeyframeIndex::new(),
        retrieval: None,
        out: Vec::new(),
    })
}

#[no_mangle]
pub extern "C" fn ls_keyframe_index_free(handle: u32) {
    handles().free(handle);
}

/// Input: str id, str layer, u32 frame; `count` features at `features`. Returns a status.
#[no_mangle]
pub extern "C" fn ls_keyframe_index_add(
    handle: u32,
    input: u32,
    len: u32,
    features: u32,
    count: u32,
) -> i32 {
    let added = (|| {
        let (session, mut c, descriptors) = inputs(handle, input, len, features, count)?;
        let (id, layer, frame) = (c.str()?, c.str()?, c.u32()?);
        session.index.add(id, layer, frame, &descriptors);
        Some(())
    })();
    added.map_or(STATUS_BAD_ARGUMENT, |()| STATUS_OK)
}

/// Input: str layer, u32 frame, u8 has exclude, [str exclude], u8 has min gap, [u32 min gap]; `count` features at
/// `features`. Returns the result's length or a negative status.
#[no_mangle]
pub extern "C" fn ls_keyframe_index_retrieve(
    handle: u32,
    input: u32,
    len: u32,
    features: u32,
    count: u32,
) -> i32 {
    let retrieved = (|| {
        let (session, mut c, descriptors) = inputs(handle, input, len, features, count)?;
        let (layer, frame) = (c.str()?, c.u32()?);
        let exclude = if c.bool()? { Some(c.str()?) } else { None };
        let min_gap = if c.bool()? { Some(c.u32()?) } else { None };
        let retrieval = session
            .index
            .retrieve(layer, frame, &descriptors, exclude, min_gap);
        let mut out = Out::default();
        out.bool(retrieval.budget_warning);
        out.u32(retrieval.candidates.len() as u32);
        for id in &retrieval.candidates {
            out.str(id);
        }
        session.retrieval = Some(retrieval);
        session.out = out.0;
        Some(session.out.len() as i32)
    })();
    retrieved.unwrap_or(STATUS_BAD_ARGUMENT)
}

/// Copies the last result (`len` bytes, as that call returned) into `out`.
#[no_mangle]
pub extern "C" fn ls_keyframe_index_take(handle: u32, out: u32, len: u32) -> i32 {
    let Some(session) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if session.out.len() != len as usize {
        return STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned output of the length it was told.
    let Some(dst) = (unsafe { slice_mut(out, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(&session.out);
    session.out = Vec::new();
    STATUS_OK
}

/// Whether the last retrieval admits a loaded candidate keyframe at `frame`: 1 or 0.
#[no_mangle]
pub extern "C" fn ls_keyframe_index_admits(handle: u32, frame: u32) -> i32 {
    match handles().get(handle).and_then(|s| s.retrieval.as_ref()) {
        Some(retrieval) => retrieval.admits(frame) as i32,
        None => STATUS_BAD_ARGUMENT,
    }
}
