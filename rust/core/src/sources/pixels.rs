//! Immutable native RGB payloads are separate from observation identity and visibility.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ops::{Deref, DerefMut},
    rc::{Rc, Weak},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pixels(Rc<Vec<u8>>);
// Retain the existing logical LRU charge. Sharing bytes must not change archive page boundaries
// or the model's observation order; measured Wasm high-water reports the physical saving separately.
pub const LEGACY_HEADER_BYTES: usize =
    std::mem::size_of::<Vec<u8>>() - std::mem::size_of::<Pixels>();
const PALETTE_LIMIT: usize = 4096;
thread_local! {
    static PALETTE: RefCell<BTreeMap<u32, Weak<Vec<u8>>>> = const { RefCell::new(BTreeMap::new()) };
}
impl From<Vec<u8>> for Pixels {
    fn from(bytes: Vec<u8>) -> Self {
        if bytes.len() != super::PIXELS * 4
            || !bytes.chunks_exact(4).all(|pixel| pixel == &bytes[..4])
        {
            return Self(Rc::new(bytes));
        }
        let colour = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        PALETTE.with(|palette| {
            let mut palette = palette.borrow_mut();
            if let Some(shared) = palette.get(&colour).and_then(Weak::upgrade) {
                // Capacity is part of the old cache accounting; don't let sharing change it.
                if shared.capacity() == bytes.capacity() {
                    return Self(shared);
                }
            }
            if palette.len() >= PALETTE_LIMIT {
                palette.clear();
            }
            let shared = Rc::new(bytes);
            palette.insert(colour, Rc::downgrade(&shared));
            Self(shared)
        })
    }
}
impl Pixels {
    pub fn capacity(&self) -> usize {
        self.0.capacity()
    }
    pub(super) fn allocation_key(&self) -> usize {
        Rc::as_ptr(&self.0) as usize
    }
}
impl Deref for Pixels {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.0.as_slice()
    }
}
impl DerefMut for Pixels {
    fn deref_mut(&mut self) -> &mut [u8] {
        Rc::make_mut(&mut self.0).as_mut_slice()
    }
}
impl Serialize for Pixels {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self)
    }
}
impl<'de> Deserialize<'de> for Pixels {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(serde_bytes::ByteBuf::deserialize(deserializer)?
            .into_vec()
            .into())
    }
}
impl PartialEq<Vec<u8>> for Pixels {
    fn eq(&self, other: &Vec<u8>) -> bool {
        &**self == other.as_slice()
    }
}
impl PartialEq<Pixels> for Vec<u8> {
    fn eq(&self, other: &Pixels) -> bool {
        self.as_slice() == &**other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exact RGBA only: alpha and a one-pixel reveal must survive. A later write detaches its
    // payload, serialization keeps the existing byte format, and weak palette entries own no image.
    #[test]
    fn shared_payloads_preserve_native_bytes_and_detach_on_write() {
        let bytes = [30, 30, 30, 255].repeat(super::super::PIXELS);
        let first = Pixels::from(bytes.clone());
        let mut second = Pixels::from(bytes.clone());
        assert!(Rc::ptr_eq(&first.0, &second.0));
        let weak = Rc::downgrade(&first.0);
        let encoded = postcard::to_allocvec(&first).unwrap();
        assert_eq!(
            encoded,
            postcard::to_allocvec(serde_bytes::Bytes::new(&bytes)).unwrap()
        );
        let decoded: Pixels = postcard::from_bytes(&encoded).unwrap();
        assert_eq!(&*decoded, bytes.as_slice());
        second[0] = 31;
        assert_eq!(first[0], 30);
        assert_eq!(second[0], 31);
        let translucent = Pixels::from([30, 30, 30, 254].repeat(super::super::PIXELS));
        assert!(!Rc::ptr_eq(&first.0, &translucent.0));
        drop(first);
        drop(decoded);
        assert!(weak.upgrade().is_none());
    }
}
