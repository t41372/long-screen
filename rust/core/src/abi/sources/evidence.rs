//! Native motion masks cross the JS/storage boundary once as compact Postcard bytes. Page analysis
//! reuses one parsed evidence handle instead of serializing thousands of mask runs through JSON.
use super::{json, result};
use crate::abi::{
    memory::{slice, HandleTable},
    STATUS_BAD_ARGUMENT,
};
use crate::sources::{
    annotation::{Evidence, Roles},
    objects::{ObjectObservation, ObjectState, ObjectUpdate},
};
use std::{collections::BTreeMap, rc::Rc};
static mut EVIDENCE: HandleTable<Rc<Evidence>> = HandleTable::new();
fn table() -> &'static mut HandleTable<Rc<Evidence>> {
    // SAFETY: only the main instance accesses these handles.
    unsafe { &mut *std::ptr::addr_of_mut!(EVIDENCE) }
}
pub(super) fn get(handle: u32) -> Option<Rc<Evidence>> {
    table().get(handle).map(|e| e.clone())
}
static mut ROLES: HandleTable<Rc<Roles>> = HandleTable::new();
fn roles() -> &'static mut HandleTable<Rc<Roles>> {
    // SAFETY: only the main instance owns these immutable role indexes.
    unsafe { &mut *std::ptr::addr_of_mut!(ROLES) }
}
#[no_mangle]
pub extern "C" fn ls_sources_roles_new(data: u32, len: u32, region: u32) -> i32 {
    // SAFETY: immutable JSON states supplied by the adapter.
    let Some(data) = (unsafe { slice(data, len as usize) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Ok(states) = serde_json::from_slice::<Vec<ObjectState>>(data) else {
        return STATUS_BAD_ARGUMENT;
    };
    roles().insert(Rc::new(Roles::new(states).in_region(region as u16)))
}
#[no_mangle]
pub extern "C" fn ls_sources_roles_free(handle: u32) {
    roles().free(handle);
}
#[derive(serde::Serialize)]
struct Chunk {
    frame: u32,
    handle: i32,
}
#[derive(serde::Serialize)]
struct Update {
    evidence: Vec<Chunk>,
    states: Vec<ObjectState>,
    overflow: bool,
}
pub(super) fn update(mut update: ObjectUpdate, auxiliary: bool) -> i32 {
    if auxiliary {
        for object in &mut update.objects {
            object.region += 256;
        }
        for state in &mut update.states {
            state.region += 256;
        }
    }
    let mut frames = BTreeMap::<u32, Vec<ObjectObservation>>::new();
    for object in update.objects {
        frames.entry(object.frame).or_default().push(object);
    }
    let mut evidence = Vec::new();
    for (frame, objects) in frames {
        let Ok(data) = postcard::to_allocvec(&(1u32, objects)) else {
            return STATUS_BAD_ARGUMENT;
        };
        evidence.push(Chunk {
            frame,
            handle: result(data),
        });
    }
    json(&Update {
        evidence,
        states: update.states,
        overflow: update.overflow,
    })
}
#[no_mangle]
pub extern "C" fn ls_sources_evidence_new(desc: u32, count: u32, role_handle: u32) -> i32 {
    // SAFETY: pointer/length pairs borrow immutable binary frame records during this call.
    let Some(desc) = (unsafe { slice(desc, count as usize * 8) }) else {
        return STATUS_BAD_ARGUMENT;
    };
    let Some(states) = roles().get(role_handle).cloned() else {
        return STATUS_BAD_ARGUMENT;
    };
    let mut objects = Vec::new();
    for record in desc.chunks_exact(8) {
        let ptr = u32::from_le_bytes(record[..4].try_into().unwrap());
        let len = u32::from_le_bytes(record[4..].try_into().unwrap());
        // SAFETY: this slice is covered by the descriptor contract above.
        let Some(data) = (unsafe { slice(ptr, len as usize) }) else {
            return STATUS_BAD_ARGUMENT;
        };
        let Ok((version, mut frame)) = postcard::from_bytes::<(u32, Vec<ObjectObservation>)>(data)
        else {
            return STATUS_BAD_ARGUMENT;
        };
        if version != 1 {
            return STATUS_BAD_ARGUMENT;
        }
        objects.append(&mut frame);
    }
    table().insert(Rc::new(Evidence::with_roles(objects, states)))
}
#[no_mangle]
pub extern "C" fn ls_sources_evidence_free(handle: u32) {
    table().free(handle)
}
