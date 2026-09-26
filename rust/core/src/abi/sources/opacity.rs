//! Bounded model pages: learn/apply one candidate archive and one 64px opacity field at a time.
use super::{analyses, json, result, Annotation};
use crate::abi::{
    memory::{slice, HandleTable},
    STATUS_BAD_ARGUMENT,
};
use crate::sources::{
    opacity::{Annotation as OpacityAnnotation, Field, Learning},
    tile::TileHistory,
};
static mut LEARNING: HandleTable<Learning> = HandleTable::new();
struct Applying {
    state: Option<TileHistory>,
    annotation: OpacityAnnotation,
}
static mut APPLYING: HandleTable<Applying> = HandleTable::new();
fn learning() -> &'static mut HandleTable<Learning> {
    // SAFETY: main instance only, like the other source handles.
    unsafe { &mut *std::ptr::addr_of_mut!(LEARNING) }
}
fn applying() -> &'static mut HandleTable<Applying> {
    // SAFETY: main instance only.
    unsafe { &mut *std::ptr::addr_of_mut!(APPLYING) }
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_learn(
    analysis: u32,
    data: u32,
    len: u32,
    page: i32,
    desc: u32,
    desc_len: u32,
) -> i32 {
    let Some(a) = analyses().get(analysis) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: independent borrowed archive and JSON evidence buffers.
    let (Some(data), Some(desc)) = (unsafe { slice(data, len as usize) }, unsafe {
        slice(desc, desc_len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(d) = serde_json::from_slice::<Annotation>(desc) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(entries) = crate::sources::export::entries(data, page) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(evidence) = super::evidence::get(d.evidence) else {
        return STATUS_BAD_ARGUMENT;
    };
    learning().insert(Learning::new(a, &entries, &evidence))
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_keys(handle: u32, apply: u32) -> i32 {
    if apply == 0 {
        let Some(l) = learning().get(handle) else {
            return STATUS_BAD_ARGUMENT;
        };
        json(&l.keys())
    } else {
        let Some(a) = applying().get(handle) else {
            return STATUS_BAD_ARGUMENT;
        };
        json(&a.annotation.keys())
    }
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_free(handle: u32, apply: u32) {
    if apply == 0 {
        learning().free(handle)
    } else {
        applying().free(handle)
    }
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_prepare(
    data: u32,
    len: u32,
    page: i32,
    desc: u32,
    desc_len: u32,
) -> i32 {
    // SAFETY: immutable archive and metadata buffers.
    let (Some(data), Some(desc)) = (unsafe { slice(data, len as usize) }, unsafe {
        slice(desc, desc_len as usize)
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(d) = serde_json::from_slice::<Annotation>(desc) else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut state = if page < 0 {
        let Ok(s) = TileHistory::decode(data) else {
            return STATUS_BAD_ARGUMENT;
        };
        Some(s)
    } else {
        None
    };
    let entries = if let Some(state) = &mut state {
        state
            .blocks
            .iter_mut()
            .flat_map(|(&block, h)| {
                std::mem::take(&mut h.resident)
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
    let Some(evidence) = super::evidence::get(d.evidence) else {
        return STATUS_BAD_ARGUMENT;
    };
    applying().insert(Applying {
        state,
        annotation: OpacityAnnotation::new(entries, d.size, d.tx, d.ty, evidence),
    })
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_archive(handle: u32) -> i32 {
    let Some(a) = applying().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    if let Some(state) = &mut a.state {
        for h in state.blocks.values_mut() {
            h.resident.clear();
        }
        for e in &a.annotation.entries {
            state
                .blocks
                .entry(e.block)
                .or_default()
                .resident
                .push(e.candidate.clone());
        }
        state.encode().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
    } else {
        crate::sources::archive::encode(&(1u32, &a.annotation.entries))
            .map(result)
            .unwrap_or(STATUS_BAD_ARGUMENT)
    }
}
/// Selection consumes the already annotated candidates, before they cross the storage boundary.
/// Hot representatives have the same block-major entry order as TileAnalysis::feed_state.
#[no_mangle]
pub extern "C" fn ls_sources_opacity_feed(handle: u32, analysis: u32, page: i32) -> i32 {
    let Some(a) = applying().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(target) = analyses().get(analysis) else {
        return STATUS_BAD_ARGUMENT;
    };
    target.feed_page(&a.annotation.entries, page);
    0
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_valid(data: u32, len: u32, noise: u32) -> i32 {
    // SAFETY: immutable field buffer in the adapter arena.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(field) = Field::decode(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    field.valid_pixels(noise.min(255) as u8) as i32
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_export(data: u32, len: u32) -> i32 {
    // SAFETY: immutable field buffer in the adapter arena.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(field) = Field::decode(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&field)
}

static mut FIELDS: HandleTable<Field> = HandleTable::new();
fn fields() -> &'static mut HandleTable<Field> {
    // SAFETY: main-instance-only model cache, with the same lifetime contract as other handles.
    unsafe { &mut *std::ptr::addr_of_mut!(FIELDS) }
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_field_new(data: u32, len: u32) -> i32 {
    if len == 0 {
        return fields().insert(Field::default());
    }
    // SAFETY: immutable persisted field in the adapter arena.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    Field::decode(data)
        .map(|f| fields().insert(f))
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_field_free(handle: u32) {
    fields().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_field_merge(
    handle: u32,
    learning_handle: u32,
    key: u32,
    key_len: u32,
    noise: u32,
) -> i32 {
    let Some(field) = fields().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(delta) = learning().get(learning_handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: UTF-8 metadata key allocated by the adapter.
    let Some(key) = (unsafe { slice(key, key_len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(key) = std::str::from_utf8(key) else {
        return STATUS_BAD_ARGUMENT;
    };
    delta.merge(key, field, noise.min(255) as u8) as i32
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_field_state(handle: u32) -> i32 {
    let Some(f) = fields().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    f.encode().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_field_bytes(handle: u32) -> i32 {
    let Some(f) = fields().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    f.resident_bytes() as i32
}

static mut FITTED: HandleTable<std::collections::BTreeMap<u16, crate::sources::opacity::Fit>> =
    HandleTable::new();
fn fitted(
) -> &'static mut HandleTable<std::collections::BTreeMap<u16, crate::sources::opacity::Fit>> {
    // SAFETY: immutable main-instance fitted fields; no sample histories remain resident here.
    unsafe { &mut *std::ptr::addr_of_mut!(FITTED) }
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_fitted_new(data: u32, len: u32, noise: u32) -> i32 {
    // SAFETY: immutable field buffer supplied by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(field) = Field::decode(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    fitted().insert(field.fits(noise.min(255) as u8))
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_fitted_free(handle: u32) {
    fitted().free(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_fitted_bytes(handle: u32) -> i32 {
    let Some(f) = fitted().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    (f.len() * (std::mem::size_of::<crate::sources::opacity::Fit>() + 32)) as i32
}
#[no_mangle]
pub extern "C" fn ls_sources_opacity_fitted_apply(
    handle: u32,
    analysis: u32,
    key: u32,
    key_len: u32,
    field: u32,
    noise: u32,
) -> i32 {
    let Some(a) = applying().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(reference) = analyses().get(analysis) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(field) = fitted().get(field) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: borrowed UTF-8 metadata key.
    let Some(key) = (unsafe { slice(key, key_len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(key) = std::str::from_utf8(key) else {
        return STATUS_BAD_ARGUMENT;
    };
    a.annotation
        .apply_fitted(key, field, reference, noise.min(255) as u8) as i32
}
