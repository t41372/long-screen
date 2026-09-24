//! Region membership (`src/core/layers.ts::regionContains`): rect, exclusions, optional native crop, and an
//! analysis-resolution mask looked up at `floor(x / factor)` (or by ratio for masks built without a factor).
//!
//! Generic over the mask storage (`M: AsRef<[u8]>`, defaulting to `Vec<u8>`) so this ONE `contains()` serves both
//! `voting.rs`/`track.rs` (which retain a region across many calls and must own its mask) and
//! `regions::atlas` (which only needs its mask to live for one `label_atlas` call and borrows it instead) — R6-B
//! unified what used to be two mirrored copies of this method (final-verify-report.md item 13).

use crate::features::Feature;
use crate::geometry::{js_floor, Rect};

pub struct Mask<M: AsRef<[u8]> = Vec<u8>> {
    pub width: usize,
    pub height: usize,
    /// Integer analysis factor the mask was built at; 0 selects the legacy ratio lookup.
    pub factor: u32,
    pub data: M,
}

pub struct Region<M: AsRef<[u8]> = Vec<u8>> {
    pub rect: Rect,
    pub exclusions: Vec<Rect>,
    pub crop: Option<Rect>,
    pub solid: bool,
    pub mask: Option<Mask<M>>,
}

#[inline]
fn clamp_index(value: i32, len: usize) -> usize {
    value.clamp(0, len as i32 - 1) as usize
}

impl<M: AsRef<[u8]>> Region<M> {
    pub fn contains(&self, x: f64, y: f64, native_width: f64, native_height: f64) -> bool {
        if !self.rect.contains(x, y) || self.exclusions.iter().any(|r| r.contains(x, y)) {
            return false;
        }
        if self.crop.is_some_and(|c| !c.contains(x, y)) {
            return false;
        }
        if self.solid {
            return true;
        }
        let Some(mask) = &self.mask else {
            return true;
        };
        let (xx, yy) = if mask.factor > 0 {
            let f = mask.factor as f64;
            (
                clamp_index(js_floor(x / f), mask.width),
                clamp_index(js_floor(y / f), mask.height),
            )
        } else {
            (
                clamp_index(js_floor(x * mask.width as f64 / native_width), mask.width),
                clamp_index(
                    js_floor(y * mask.height as f64 / native_height),
                    mask.height,
                ),
            )
        };
        mask.data.as_ref()[yy * mask.width + xx] != 0
    }
}

/// `src/pipeline/solve/track.ts::ownFeaturesOf` (R6-B: moved out of TS, final-verify-report.md item 13 — this was
/// the one production caller of the former TS `regionContains`). Analysis-coordinate features are scaled to
/// native pixels by `factor` (`p.x * f, p.y * f` in the original) before the same `contains()` test above.
pub fn filter_features<M: AsRef<[u8]>>(
    region: &Region<M>,
    features: &[Feature],
    factor: f64,
    native_width: f64,
    native_height: f64,
) -> Vec<Feature> {
    features
        .iter()
        .filter(|p| {
            region.contains(
                p.x as f64 * factor,
                p.y as f64 * factor,
                native_width,
                native_height,
            )
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_lookup_uses_floor_by_factor_and_clamps_the_partial_cell() {
        let region = Region {
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            exclusions: vec![],
            crop: None,
            solid: false,
            mask: Some(Mask {
                width: 3,
                height: 3,
                factor: 4,
                data: vec![1, 0, 0, 0, 1, 0, 0, 0, 1],
            }),
        };
        assert!(region.contains(0.0, 0.0, 10.0, 10.0));
        assert!(!region.contains(4.0, 0.0, 10.0, 10.0));
        assert!(region.contains(9.0, 9.0, 10.0, 10.0));
        assert!(!region.contains(10.0, 9.0, 10.0, 10.0));
    }

    #[test]
    fn filter_features_scales_by_factor_before_testing_containment() {
        let region: Region = Region {
            rect: Rect {
                x: 0.0,
                y: 0.0,
                width: 4.0,
                height: 10.0,
            },
            exclusions: vec![],
            crop: None,
            solid: true,
            mask: None,
        };
        let inside = Feature {
            x: 1,
            y: 1,
            score: 0.0,
            descriptor: [0; crate::features::DESCRIPTOR_WORDS],
        };
        let outside = Feature {
            x: 3,
            y: 1,
            score: 0.0,
            descriptor: [0; crate::features::DESCRIPTOR_WORDS],
        };
        let kept = filter_features(&region, &[inside.clone(), outside], 2.0, 10.0, 10.0);
        assert_eq!(kept, vec![inside]);
    }
}
