//! Streaming export resize; buffers are owned by the adapter and the session retains only row accumulators.
use crate::memory::{slice, slice_mut, HandleTable};
use crate::STATUS_BAD_ARGUMENT;
use long_screen::kernels::resize::Resize;

static mut HANDLES: HandleTable<Resize> = HandleTable::new();
fn handles() -> &'static mut HandleTable<Resize> {
    // SAFETY: only the main instance calls these exports; pool helpers never access this table.
    unsafe { &mut *std::ptr::addr_of_mut!(HANDLES) }
}

#[no_mangle]
pub extern "C" fn ls_resize_new(width: u32, height: u32, out_width: u32, out_height: u32) -> i32 {
    match Resize::new(
        width as usize,
        height as usize,
        out_width as usize,
        out_height as usize,
    ) {
        Some(resize) => handles().insert(resize),
        None => STATUS_BAD_ARGUMENT,
    }
}

/// Returns 0 while accumulating, 1 when `out` holds a complete row, or a negative status on bad arguments.
#[no_mangle]
pub extern "C" fn ls_resize_push(handle: u32, input: u32, out: u32) -> i32 {
    let Some(resize) = handles().get(handle) else {
        return STATUS_BAD_ARGUMENT;
    };
    // SAFETY: adapter-owned, separate buffers; slice helpers check linear-memory bounds.
    let (Some(src), Some(dst)) = (unsafe { slice(input, resize.input_bytes()) }, unsafe {
        slice_mut(out, resize.output_bytes())
    }) else {
        return STATUS_BAD_ARGUMENT;
    };
    match resize.push(src, dst) {
        Ok(ready) => i32::from(ready),
        Err(_) => STATUS_BAD_ARGUMENT,
    }
}

#[no_mangle]
pub extern "C" fn ls_resize_free(handle: u32) {
    handles().free(handle);
}
