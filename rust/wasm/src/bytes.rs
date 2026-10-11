//! Little-endian records with strings, for the engine's row types: a cursor that reads what the adapter wrote and a
//! buffer the engine's results are written into. A string is a u32 byte length followed by its UTF-8 bytes; numbers
//! are unpadded little-endian. The TypeScript half is `src/core/wasm/bytes.ts`.

/// Reads one adapter-written record; every read is bounds-checked and returns `None` past the end.
pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let out = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(out)
    }

    pub(crate) fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    pub(crate) fn bool(&mut self) -> Option<bool> {
        self.u8().map(|b| b != 0)
    }

    pub(crate) fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    }

    pub(crate) fn f64(&mut self) -> Option<f64> {
        self.take(8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
    }

    pub(crate) fn str(&mut self) -> Option<&'a str> {
        let n = self.u32()? as usize;
        std::str::from_utf8(self.take(n)?).ok()
    }
}

/// Builds one result record for the adapter to copy out.
#[derive(Default)]
pub(crate) struct Out(pub(crate) Vec<u8>);

impl Out {
    pub(crate) fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    pub(crate) fn bool(&mut self, v: bool) {
        self.0.push(v as u8);
    }

    pub(crate) fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(crate) fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(crate) fn str(&mut self, v: &str) {
        self.u32(v.len() as u32);
        self.0.extend_from_slice(v.as_bytes());
    }

    /// Raw bytes, no length prefix (the reader knows how many follow).
    pub(crate) fn bytes(&mut self, v: &[u8]) {
        self.0.extend_from_slice(v);
    }
}

/// A `_take` export's body: copies the result a handle holds (`len` bytes, the length its producing call returned)
/// into the adapter's `out` and clears it. Returns a status.
pub(crate) fn take(pending: &mut Vec<u8>, out: u32, len: u32) -> i32 {
    if pending.len() != len as usize {
        return crate::STATUS_BAD_ARGUMENT;
    }
    // SAFETY: adapter-owned output of the length it was told.
    let Some(dst) = (unsafe { crate::memory::slice_mut(out, len as usize) }) else {
        return crate::STATUS_BAD_ARGUMENT;
    };
    dst.copy_from_slice(pending);
    *pending = Vec::new();
    crate::STATUS_OK
}
