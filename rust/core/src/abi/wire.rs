//! Byte layouts shared across the ABI: size constants, a little-endian reader over adapter-owned buffers, and
//! rect (de)serialisation. `Reader` replaces the `u = |i| u32::from_le_bytes(..)` closure that used to be
//! redefined at each call site.

use crate::abi::STATUS_BAD_ARGUMENT;
use crate::features::DESCRIPTOR_WORDS;
use crate::geometry::Rect;

/// Bytes per serialised feature: i32 x, i32 y, f32 score, 8 × u32 descriptor.
pub const FEATURE_BYTES: usize = 4 + 4 + 4 + DESCRIPTOR_WORDS * 4;
/// Bytes per serialised match: u32 a, u32 b, u16 distance, u8 unique, u8 padding.
pub const MATCH_BYTES: usize = 12;
/// Bytes per serialised match point pair: f64 ax, ay, bx, by, u32 unique, u32 padding.
pub const MATCH_POINT_BYTES: usize = 40;
/// Bytes per serialised motion: f64 x, y, u32 support, u32 unique, f64 confidence, f64 error, u32 ambiguous, u32 padding.
pub const MOTION_BYTES: usize = 48;
/// Motion field header: u32 cols, rows, cell, motion count, f64 difference, u32 feature count, u32 unknown, f64 zoom.
pub const MOTION_FIELD_HEADER_BYTES: usize = 40;
/// Native refinement result: i32 x, i32 y, f64 error, u32 samples, u32 padding, f64 runner-up.
pub const REFINEMENT_BYTES: usize = 32;
/// Serialised keyframe patch: i32 x, i32 y, u32 size, u32 data pointer.
pub const PATCH_BYTES: usize = 16;
/// Composite result header: u32 added, u32 conflicts, u32 uncertain, i32 provisional delta, u32 changed,
/// u32 conflict block count, then (u32 bx, u32 by) pairs.
pub const COMPOSITE_HEADER_BYTES: usize = 24;
/// Serialised voting region (`ls_voting_new`): 32-byte rect, u32 exclusion ptr, u32 exclusion count,
/// u32 crop ptr (0 = none), u32 solid, u32 mask ptr (0 = none), u32 mask width, u32 mask height, u32 mask factor.
pub const VOTING_REGION_BYTES: usize = 64;
/// Serialised learner field motion: f64 x, f64 y, u32 support, u32 padding, f64 confidence.
pub const LEARNER_MOTION_BYTES: usize = 32;
/// Learner field descriptor: u32 motions ptr, u32 motion count, u32 labels ptr, u32 confidence ptr,
/// u32 dynamic ptr, u32 cols, u32 rows, u32 unknown, f64 difference.
pub const LEARNER_FIELD_BYTES: usize = 40;
/// Serialised 2-D point for `ls_extract_patches`'/`ls_probe_scale`'s feature lists: f64 x, f64 y.
pub const POINT_BYTES: usize = 16;
/// One `ls_extract_patches` output patch header (data follows immediately, `size × size` bytes): f64 x, f64 y,
/// u32 size, u32 padding.
pub const EXTRACTED_PATCH_HEADER_BYTES: usize = 24;

/// A little-endian view over one adapter-owned descriptor, replacing the `u = |i| u32::from_le_bytes(..)`
/// closure each ABI function used to redefine.
pub(crate) struct Reader<'a>(pub &'a [u8]);

impl Reader<'_> {
    pub(crate) fn u32(&self, at: usize) -> u32 {
        u32::from_le_bytes(self.0[at..at + 4].try_into().unwrap())
    }

    pub(crate) fn i32(&self, at: usize) -> i32 {
        i32::from_le_bytes(self.0[at..at + 4].try_into().unwrap())
    }

    pub(crate) fn f64(&self, at: usize) -> f64 {
        f64::from_le_bytes(self.0[at..at + 8].try_into().unwrap())
    }
}

pub(crate) fn read_rect(bytes: &[u8]) -> Rect {
    read_rects(&bytes[..32])[0]
}

pub(crate) fn read_rects(bytes: &[u8]) -> Vec<Rect> {
    bytes
        .chunks_exact(32)
        .map(|c| Rect {
            x: f64::from_le_bytes(c[0..8].try_into().unwrap()),
            y: f64::from_le_bytes(c[8..16].try_into().unwrap()),
            width: f64::from_le_bytes(c[16..24].try_into().unwrap()),
            height: f64::from_le_bytes(c[24..32].try_into().unwrap()),
        })
        .collect()
}

/// One optional rect: `ptr` zero means none, otherwise it points at one 32-byte rect. Used at every call site
/// that used to hand-roll this as an `if ptr == 0 { None } else { ... }` with its own error shape.
///
/// # Safety
/// `ptr` is zero or points at 32 readable bytes.
pub(crate) unsafe fn read_optional_rect(ptr: u32) -> Result<Option<Rect>, i32> {
    if ptr == 0 {
        return Ok(None);
    }
    crate::abi::memory::slice(ptr, 32)
        .map(|b| Some(read_rect(b)))
        .ok_or(STATUS_BAD_ARGUMENT)
}
