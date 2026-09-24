//! Linear-memory allocation, bounds checking, and the handle-table pattern shared by every stateful domain
//! (`learner`, `voting`).

use std::alloc::{alloc, dealloc, Layout};

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

#[cfg(target_arch = "wasm32")]
fn memory_size() -> usize {
    core::arch::wasm32::memory_size(0) * 65536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_size() -> usize {
    usize::MAX
}

#[inline]
pub(crate) fn in_bounds(ptr: u32, len: usize) -> bool {
    (ptr as usize)
        .checked_add(len)
        .is_some_and(|end| end <= memory_size())
}

/// # Safety
/// Only called on pointers the adapter obtained from `ls_alloc` and filled; bounds are re-checked.
pub(crate) unsafe fn slice<'a>(ptr: u32, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    (ptr != 0 && in_bounds(ptr, len)).then(|| std::slice::from_raw_parts(ptr as *const u8, len))
}

/// # Safety
/// See `slice`; the caller guarantees the output does not alias any input.
pub(crate) unsafe fn slice_mut<'a>(ptr: u32, len: usize) -> Option<&'a mut [u8]> {
    if len == 0 {
        return Some(&mut []);
    }
    (ptr != 0 && in_bounds(ptr, len)).then(|| std::slice::from_raw_parts_mut(ptr as *mut u8, len))
}

/// A freelist-reusing table of boxed values addressed by a 1-based handle, as returned to the adapter by
/// `ls_*_new` exports. Replaces the duplicated Vec<Option<Box<T>>> insert/free/get code that `learner` and
/// `voting` each had.
pub(crate) struct HandleTable<T> {
    slots: Vec<Option<Box<T>>>,
}

impl<T> HandleTable<T> {
    pub(crate) const fn new() -> Self {
        Self { slots: Vec::new() }
    }

    /// Inserts `value`, reusing a freed slot when one exists. Returns the 1-based handle.
    pub(crate) fn insert(&mut self, value: T) -> i32 {
        let boxed = Box::new(value);
        if let Some(free) = self.slots.iter().position(|h| h.is_none()) {
            self.slots[free] = Some(boxed);
            return free as i32 + 1;
        }
        self.slots.push(Some(boxed));
        self.slots.len() as i32
    }

    pub(crate) fn free(&mut self, handle: u32) {
        if let Some(slot) = self.slots.get_mut(handle.wrapping_sub(1) as usize) {
            *slot = None;
        }
    }

    pub(crate) fn get(&mut self, handle: u32) -> Option<&mut T> {
        self.slots
            .get_mut(handle.wrapping_sub(1) as usize)
            .and_then(|h| h.as_deref_mut())
    }
}
