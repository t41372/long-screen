//! One decoded archive shared by frame discovery and phase work. The adapter releases each page
//! before advancing storage; this table is never a recording-wide cache.
use super::{analyses, evidence, json, result, Annotation};
use crate::abi::{
    memory::{slice, HandleTable},
    STATUS_BAD_ARGUMENT,
};
use crate::sources::{
    annotation,
    tile::{decode_page, SpillEntry, TileHistory},
};

pub(super) struct DecodedPage {
    pub state: Option<TileHistory>,
    pub entries: Vec<SpillEntry>,
    pub page: i32,
}
impl DecodedPage {
    pub fn decode(data: &[u8], page: i32) -> Result<Self, postcard::Error> {
        let mut state = if page < 0 {
            Some(TileHistory::decode(data)?)
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
                        .map(move |candidate| SpillEntry { block, candidate })
                })
                .collect()
        } else {
            decode_page(data)?
        };
        Ok(Self {
            state,
            entries,
            page,
        })
    }
    pub fn archive(&mut self) -> Result<Vec<u8>, postcard::Error> {
        if let Some(state) = &mut self.state {
            // Move, encode, restore: preserve hot-state metadata without cloning the pixel payloads.
            for entry in self.entries.drain(..) {
                state
                    .blocks
                    .entry(entry.block)
                    .or_default()
                    .resident
                    .push(entry.candidate);
            }
            let result = state.encode();
            for (&block, h) in &mut state.blocks {
                self.entries.extend(
                    std::mem::take(&mut h.resident)
                        .into_iter()
                        .map(|candidate| SpillEntry { block, candidate }),
                );
            }
            result
        } else {
            crate::sources::tile::encode_page(&self.entries)
        }
    }
}
static mut PAGES: HandleTable<DecodedPage> = HandleTable::new();
fn pages() -> &'static mut HandleTable<DecodedPage> {
    // SAFETY: source handles are used only by the main instance.
    unsafe { &mut *std::ptr::addr_of_mut!(PAGES) }
}
pub(super) fn get(handle: u32) -> Option<&'static mut DecodedPage> {
    pages().get(handle)
}
#[no_mangle]
pub extern "C" fn ls_sources_page_new(data: u32, len: u32, page: i32) -> i32 {
    // SAFETY: immutable bytes owned by the adapter for this call.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    DecodedPage::decode(data, page)
        .map(|p| pages().insert(p))
        .unwrap_or(STATUS_BAD_ARGUMENT)
}
#[no_mangle]
pub extern "C" fn ls_sources_page_free(handle: u32) {
    pages().free(handle);
}
#[no_mangle]
pub extern "C" fn ls_sources_page_frames(handle: u32) -> i32 {
    let Some(page) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    json(&annotation::frames(
        page.entries.iter().map(|e| &e.candidate),
    ))
}
#[no_mangle]
pub extern "C" fn ls_sources_page_annotate(handle: u32, desc: u32, len: u32, analysis: u32) -> i32 {
    let Some(page) = get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: immutable descriptor in adapter scratch memory.
    let Some(desc) = (unsafe { slice(desc, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(d) = serde_json::from_slice::<Annotation>(desc) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(evidence) = evidence::get(d.evidence) else {
        return STATUS_BAD_ARGUMENT;
    };
    let n = d.size / 16;
    if n == 0 {
        return STATUS_BAD_ARGUMENT;
    }
    let mut changed = false;
    for e in &mut page.entries {
        changed |= evidence.apply(
            &mut e.candidate,
            d.tx * d.size as i32 + (e.block as usize % n * 16) as i32,
            d.ty * d.size as i32 + (e.block as usize / n * 16) as i32,
        );
    }
    if analysis != 0 {
        let Some(a) = analyses().get(analysis) else {
            return STATUS_BAD_ARGUMENT;
        };
        a.feed_page(&page.entries, page.page);
    }
    if changed {
        page.archive().map(result).unwrap_or(STATUS_BAD_ARGUMENT)
    } else {
        0
    }
}
