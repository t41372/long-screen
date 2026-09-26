//! Sparse native source histories, visibility-conditioned resolution, and component epochs.
//! Pixel values always come from an observed candidate. Persistence uses a versioned Postcard envelope.
use serde::{Deserialize, Serialize};
pub mod analysis;
pub mod annotation;
pub mod archive;
mod background;
mod container;
mod epochs;
pub mod export;
mod history;
pub mod materialize;
pub mod objects;
pub mod opacity;
pub mod ownership;
mod phase;
mod resolve;
pub mod scene;
mod surface;
pub mod tile;
mod visibility;
pub use epochs::{at_epoch, choose_component_epoch};
pub use resolve::resolve_block;

pub const SIDE: usize = 16;
pub const PIXELS: usize = SIDE * SIDE;
pub const RESIDENT_CANDIDATES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Visibility {
    Unknown,
    Visible,
    Occluded,
    Outside,
    /// A per-frame placement exclusion is independent of the object's inferred motion role.
    PlacementOccluded,
    /// A fixed interior island projected into its possible moving parent, without motion proof.
    Context,
    ContextOccluded,
    ContextPlacementOccluded,
    ContextExcluded,
    /// Native colour connected to textured page-motion seeds outside object footprints.
    /// Affiliation is supported, but this is still an uncertain observation, not Visible.
    Background,
    ContextBackground,
    /// Enclosed native detail on a supported parent surface; object negatives still apply.
    ContextSurface,
}
impl Visibility {
    pub fn is_context(self) -> bool {
        matches!(
            self,
            Self::Context
                | Self::ContextOccluded
                | Self::ContextPlacementOccluded
                | Self::ContextExcluded
                | Self::ContextBackground
                | Self::ContextSurface
        )
    }
    pub fn is_occluded(self) -> bool {
        matches!(
            self,
            Self::Occluded
                | Self::PlacementOccluded
                | Self::ContextOccluded
                | Self::ContextPlacementOccluded
        )
    }
    pub fn is_locked(self) -> bool {
        matches!(
            self,
            Self::PlacementOccluded | Self::ContextPlacementOccluded
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Reason {
    Unobserved,
    VisibleWitness,
    SingleObservation,
    Ambiguous,
    NoCleanSource,
    DynamicPartial,
    ContextSource,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentKind {
    Static,
    Dynamic,
    Ambiguous,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemporalPolicy {
    Stable,
    Latest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSpan {
    pub first: u32,
    pub last: u32,
    pub pose_x: i32,
    pub pose_y: i32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Exposure {
    pub x: i32,
    pub y: i32,
    pub visibility: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub source_state: u32,
    pub frame: u32,
    pub time: f64,
    pub pose_x: i32,
    pub pose_y: i32,
    #[serde(with = "serde_bytes")]
    pub rgba: Vec<u8>,
    #[serde(with = "visibility")]
    pub visibility: Vec<Visibility>,
    pub quality: u16,
    pub frames: Vec<FrameSpan>,
    pub exposures: Vec<Exposure>,
}
impl Candidate {
    pub fn new(
        frame: u32,
        time: f64,
        pose_x: i32,
        pose_y: i32,
        rgba: Vec<u8>,
        visibility: Vec<Visibility>,
        quality: u16,
    ) -> Self {
        Self {
            source_state: frame,
            frame,
            time,
            pose_x,
            pose_y,
            rgba,
            visibility,
            quality,
            frames: vec![FrameSpan {
                first: frame,
                last: frame,
                pose_x,
                pose_y,
            }],
            exposures: Vec::new(),
        }
    }
    pub fn complete(&self) -> bool {
        self.visibility.iter().all(|v| *v == Visibility::Visible)
    }
    pub fn contains_frame(&self, frame: u32) -> bool {
        self.frames
            .iter()
            .any(|s| frame >= s.first && frame <= s.last)
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct History {
    pub resident: Vec<Candidate>,
    /// Drained into immutable disk pages by the adapter before an LRU eviction. Never silently discarded.
    pub spilled: Vec<Candidate>,
}
impl History {
    pub fn all_candidates(&self) -> Vec<Candidate> {
        self.spilled.iter().chain(&self.resident).cloned().collect()
    }
    pub fn encode(&self) -> Result<Vec<u8>, postcard::Error> {
        archive::encode(&(1u32, self))
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, postcard::Error> {
        let (version, history): (u32, Self) = archive::decode(bytes)?;
        if version != 1 {
            return Err(postcard::Error::DeserializeBadEncoding);
        }
        Ok(history)
    }
}

pub struct BlockResolution {
    pub kind: ContentKind,
    pub rgba: Vec<u8>,
    pub sources: Vec<u32>,
    pub reasons: Vec<Reason>,
}
pub struct EpochChoice {
    pub frame: Option<u32>,
    pub complete: bool,
    pub missing_blocks: Vec<usize>,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod object_tests;

#[cfg(test)]
mod opacity_tests;
