//! Region membership (`src/core/layers.ts::regionContains`): rect, exclusions, optional native crop, and an
//! analysis-resolution mask looked up at `floor(x / factor)` (or by ratio for masks built without a factor).

use crate::geometry::{js_floor, Rect};

pub struct Mask {
    pub width: usize,
    pub height: usize,
    /// Integer analysis factor the mask was built at; 0 selects the legacy ratio lookup.
    pub factor: u32,
    pub data: Vec<u8>,
}

pub struct Region {
    pub rect: Rect,
    pub exclusions: Vec<Rect>,
    pub crop: Option<Rect>,
    pub solid: bool,
    pub mask: Option<Mask>,
}

#[inline]
fn clamp_index(value: i32, len: usize) -> usize {
    value.clamp(0, len as i32 - 1) as usize
}

impl Region {
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
        mask.data[yy * mask.width + xx] != 0
    }
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
}
