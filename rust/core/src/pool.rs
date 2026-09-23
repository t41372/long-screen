//! Data-parallel `for` over independent chunks, run on helper Web Workers that share this module's memory.
//!
//! Only the threaded build (`target_feature = "atomics"`, shared imported memory) has helpers; every other
//! build, and any call made while a job is already running, executes the chunks inline in index order. Kernels
//! are written so their output never depends on which thread ran a chunk or in what order: chunks write
//! disjoint output ranges, and any reduction is kept per chunk and folded afterwards in chunk order.
//!
//! Contract for chunk bodies: no heap allocation and no locks. The calling thread may be a browser main thread,
//! which cannot block on `memory.atomic.wait32`; it never waits here (it runs chunks itself and then spins for
//! the last few), and because chunk bodies never touch the allocator the helpers can never hold its lock while
//! the caller needs it.

/// Helper threads currently parked in [`worker_loop`] (0 in single-threaded builds).
pub fn helpers() -> usize {
    imp::helpers()
}

/// Runs `body(i)` for every `i in 0..chunks`, in parallel when helpers exist.
pub fn par_for<F: Fn(usize) + Sync>(chunks: usize, body: F) {
    imp::par_for(chunks, &body)
}

/// Splits `0..len` into at most `parts` contiguous ranges of near-equal size, returned as the start of range
/// `i` for `i in 0..=parts` (so range `i` is `bounds(i)..bounds(i + 1)`).
#[inline]
pub fn split(len: usize, parts: usize, i: usize) -> usize {
    len * i / parts.max(1)
}

/// A chunk count for `len` units of work with at least `min` units per chunk: enough chunks to balance
/// load across helpers, few enough that dispatch stays negligible. Single-threaded builds get 1.
pub fn chunks_for(len: usize, min: usize) -> usize {
    let threads = helpers() + 1;
    if threads == 1 || len == 0 {
        return 1;
    }
    (len / min.max(1)).clamp(1, threads * 4)
}

/// A raw pointer chunk bodies may share; each chunk derives its own disjoint slice from it.
#[derive(Clone, Copy)]
pub struct SyncPtr<T>(pub *mut T);
// SAFETY: only ever used to hand disjoint ranges of one buffer to concurrently running chunks.
unsafe impl<T> Sync for SyncPtr<T> {}
unsafe impl<T> Send for SyncPtr<T> {}
impl<T> SyncPtr<T> {
    #[inline]
    pub fn get(self) -> *mut T {
        self.0
    }
}

/// Entered once by each helper instance; never returns.
pub fn worker_loop() -> ! {
    imp::worker_loop()
}

#[cfg(target_feature = "atomics")]
mod imp {
    use core::arch::wasm32::{memory_atomic_notify, memory_atomic_wait32};
    use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering::SeqCst};

    /// Seqlock-style job epoch: odd while the caller rewrites the job fields, even once they are published.
    static EPOCH: AtomicU32 = AtomicU32::new(0);
    static HELPERS: AtomicUsize = AtomicUsize::new(0);
    /// Helpers between "saw this epoch" and "done claiming"; the caller does not rewrite the job while > 0.
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    static BUSY: AtomicBool = AtomicBool::new(false);
    static JOB_DATA: AtomicUsize = AtomicUsize::new(0);
    static JOB_CALL: AtomicUsize = AtomicUsize::new(0);
    static JOB_CHUNKS: AtomicUsize = AtomicUsize::new(0);
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    static PENDING: AtomicUsize = AtomicUsize::new(0);

    pub fn helpers() -> usize {
        HELPERS.load(SeqCst)
    }

    unsafe fn trampoline<F: Fn(usize) + Sync>(data: usize, i: usize) {
        (*(data as *const F))(i)
    }

    fn run_chunks(data: usize, call: usize, chunks: usize) {
        // SAFETY: `call` was produced from `trampoline::<F>` for the `F` behind `data`, in this same module.
        let f: unsafe fn(usize, usize) = unsafe { core::mem::transmute(call) };
        loop {
            let i = NEXT.fetch_add(1, SeqCst);
            if i >= chunks {
                return;
            }
            unsafe { f(data, i) };
            PENDING.fetch_sub(1, SeqCst);
        }
    }

    pub fn par_for<F: Fn(usize) + Sync>(chunks: usize, body: &F) {
        if chunks <= 1 || HELPERS.load(SeqCst) == 0 || BUSY.swap(true, SeqCst) {
            (0..chunks).for_each(body);
            return;
        }
        // Unpublish, wait out helpers still looking at the previous job, then publish this one.
        EPOCH.fetch_add(1, SeqCst);
        while ACTIVE.load(SeqCst) != 0 {
            core::hint::spin_loop();
        }
        let data = body as *const F as usize;
        let call = trampoline::<F> as unsafe fn(usize, usize) as usize;
        JOB_DATA.store(data, SeqCst);
        JOB_CALL.store(call, SeqCst);
        JOB_CHUNKS.store(chunks, SeqCst);
        PENDING.store(chunks, SeqCst);
        NEXT.store(0, SeqCst);
        EPOCH.fetch_add(1, SeqCst);
        unsafe { memory_atomic_notify(EPOCH.as_ptr() as *mut i32, u32::MAX) };
        run_chunks(data, call, chunks);
        while PENDING.load(SeqCst) != 0 {
            core::hint::spin_loop();
        }
        BUSY.store(false, SeqCst);
    }

    pub fn worker_loop() -> ! {
        HELPERS.fetch_add(1, SeqCst);
        let mut seen = EPOCH.load(SeqCst);
        loop {
            let e = EPOCH.load(SeqCst);
            if e == seen || e & 1 == 1 {
                // SAFETY: EPOCH is a naturally aligned 32-bit atomic in shared memory.
                unsafe { memory_atomic_wait32(EPOCH.as_ptr() as *mut i32, e as i32, -1) };
                continue;
            }
            ACTIVE.fetch_add(1, SeqCst);
            if EPOCH.load(SeqCst) == e {
                seen = e;
                run_chunks(
                    JOB_DATA.load(SeqCst),
                    JOB_CALL.load(SeqCst),
                    JOB_CHUNKS.load(SeqCst),
                );
            }
            ACTIVE.fetch_sub(1, SeqCst);
        }
    }
}

#[cfg(not(target_feature = "atomics"))]
mod imp {
    pub fn helpers() -> usize {
        0
    }
    pub fn par_for<F: Fn(usize) + Sync>(chunks: usize, body: &F) {
        (0..chunks).for_each(body)
    }
    pub fn worker_loop() -> ! {
        panic!("worker_loop requires the threaded core build")
    }
}
