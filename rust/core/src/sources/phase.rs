//! A weak raster-equivalence test, never a clean-pixel witness. One common subpixel translation
//! must explain a whole informative native patch. Interpolated values are used only for this test;
//! reconstruction continues to copy an actual source, including its original antialiasing.
use super::{Candidate, Visibility, PIXELS, SIDE};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
pub struct Reference {
    #[serde(with = "serde_bytes")]
    rgba: Vec<u8>,
    valid: Vec<bool>,
}
impl Reference {
    pub fn coverage(&self) -> usize {
        self.valid.iter().filter(|v| **v).count()
    }
    pub fn same_phase(&self, other: &Self, noise: u8) -> bool {
        let mut compared = 0;
        for i in 0..PIXELS {
            if self.valid[i] && other.valid[i] {
                compared += 1;
                if (0..3).any(|c| self.rgba[i * 4 + c].abs_diff(other.rgba[i * 4 + c]) > noise) {
                    return false;
                }
            }
        }
        compared >= 32
    }

    pub fn from_candidate(c: &Candidate) -> Option<Self> {
        if c.visibility
            .iter()
            .filter(|v| **v == Visibility::Visible)
            .count()
            < 32
        {
            return None;
        }
        Some(Self {
            rgba: c.rgba.clone(),
            valid: c
                .visibility
                .iter()
                .map(|v| {
                    matches!(
                        v,
                        Visibility::Visible | Visibility::Unknown | Visibility::Background
                    )
                })
                .collect(),
        })
    }
    pub fn incomplete_raster_evidence(&self, c: &Candidate, noise: u8) -> bool {
        if noise == 0
            || (self.coverage() == PIXELS && c.visibility.iter().all(|v| *v != Visibility::Outside))
        {
            return false;
        }
        // At a clipped viewport edge, failure of a full-patch model is not evidence of a new
        // semantic version. Keep it uncertain only when the changed colours can still be drawn
        // from one of the two native neighbourhoods; a new solid colour fails this test.
        let other = Self {
            rgba: c.rgba.clone(),
            valid: c
                .visibility
                .iter()
                .map(|v| {
                    matches!(
                        v,
                        Visibility::Visible | Visibility::Unknown | Visibility::Background
                    )
                })
                .collect(),
        };
        let mut compared = 0;
        for i in 0..PIXELS {
            if !self.valid[i] || !other.valid[i] {
                continue;
            }
            compared += 1;
            let colour = |r: &Self| [r.rgba[i * 4], r.rgba[i * 4 + 1], r.rgba[i * 4 + 2]];
            if !envelope(self, i, colour(&other), noise)
                && !envelope(&other, i, colour(self), noise)
            {
                return false;
            }
        }
        compared >= 16
    }
    pub fn explains(&self, c: &Candidate, noise: u8) -> bool {
        let other = Self {
            rgba: c.rgba.clone(),
            valid: c
                .visibility
                .iter()
                .map(|v| {
                    matches!(
                        v,
                        Visibility::Visible | Visibility::Unknown | Visibility::Background
                    )
                })
                .collect(),
        };
        if self.chroma_phase(&other, noise) {
            return true;
        }
        let mut texture = 0;
        for y in 1..SIDE - 1 {
            for x in 1..SIDE - 1 {
                let i = y * SIDE + x;
                if self.valid[i]
                    && (0..3)
                        .map(|k| {
                            self.rgba[(i - 1) * 4 + k].abs_diff(self.rgba[(i + 1) * 4 + k]) as u32
                                + self.rgba[(i - SIDE) * 4 + k]
                                    .abs_diff(self.rgba[(i + SIDE) * 4 + k])
                                    as u32
                        })
                        .sum::<u32>()
                        > noise as u32 * 3 + 6
                {
                    texture += 1;
                }
            }
        }
        if texture < 8 {
            return false;
        }
        // Quarter-pixel offsets cover the raster phase around an integer placement. Try the common
        // axial shifts first; a failed model exits on its first unexplained informative pixel.
        const SHIFTS: [(i32, i32); 25] = [
            (0, 0),
            (0, 2),
            (0, -2),
            (2, 0),
            (-2, 0),
            (0, 1),
            (0, -1),
            (1, 0),
            (-1, 0),
            (0, 3),
            (0, -3),
            (3, 0),
            (-3, 0),
            (0, 4),
            (0, -4),
            (4, 0),
            (-4, 0),
            (2, 2),
            (2, -2),
            (-2, 2),
            (-2, -2),
            (1, 1),
            (1, -1),
            (-1, 1),
            (-1, -1),
        ];
        SHIFTS
            .iter()
            .any(|&(x, y)| fits(self, &other, x, y, noise) || fits(&other, self, x, y, noise))
    }

    fn chroma_phase(&self, other: &Self, noise: u8) -> bool {
        if noise == 0 {
            return false;
        }
        // 4:2:0 moves the chroma sampling lattice independently of native luma when a page moves
        // by an odd pixel. One RGB interpolation kernel cannot describe that. Require unchanged
        // native luma AND mutual local colour support; neither alone establishes raster equivalence.
        let mut compared = 0;
        for i in 0..PIXELS {
            if !self.valid[i] || !other.valid[i] {
                continue;
            }
            compared += 1;
            let rgb = |r: &Self| [r.rgba[i * 4], r.rgba[i * 4 + 1], r.rgba[i * 4 + 2]];
            let a = rgb(self);
            let b = rgb(other);
            let luma = |p: [u8; 3]| p[0] as i32 * 77 + p[1] as i32 * 150 + p[2] as i32 * 29;
            // Codec ringing is locally balanced around an edge. Compare the common 3×3 luma
            // support, not the single overshooting pixel; a removed native stroke still changes it.
            let (x, y) = (i % SIDE, i / SIDE);
            let (mut residual, mut support) = (0i32, 0i32);
            for yy in y.saturating_sub(1)..=(y + 1).min(SIDE - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(SIDE - 1) {
                    let j = yy * SIDE + xx;
                    if self.valid[j] && other.valid[j] {
                        residual += luma(self.rgba[j * 4..j * 4 + 3].try_into().unwrap())
                            - luma(other.rgba[j * 4..j * 4 + 3].try_into().unwrap());
                        support += 1;
                    }
                }
            }
            // Both observations carry codec error, as in `fits`' two-noise residual budget.
            if residual.abs() > noise as i32 * 512 * support
                || !envelope(self, i, b, noise)
                || !envelope(other, i, a, noise)
            {
                return false;
            }
        }
        compared >= PIXELS * 3 / 8
    }
}
fn fits(source: &Reference, target: &Reference, dx: i32, dy: i32, noise: u8) -> bool {
    let (ox, oy) = (dx.div_euclid(4), dy.div_euclid(4));
    let (fx, fy) = (dx.rem_euclid(4), dy.rem_euclid(4));
    let weights = [(4 - fx) * (4 - fy), fx * (4 - fy), (4 - fx) * fy, fx * fy];
    let mut compared = 0;
    for y in 1..SIDE - 1 {
        for x in 1..SIDE - 1 {
            let i = y * SIDE + x;
            if !target.valid[i] {
                continue;
            }
            let mut predicted = [0i32; 3];
            let mut valid = true;
            for (tap, &weight) in weights.iter().enumerate() {
                if weight == 0 {
                    continue;
                }
                let sx = x as i32 + ox + (tap % 2) as i32;
                let sy = y as i32 + oy + (tap / 2) as i32;
                if sx < 0 || sy < 0 || sx >= SIDE as i32 || sy >= SIDE as i32 {
                    valid = false;
                    break;
                }
                let j = sy as usize * SIDE + sx as usize;
                if !source.valid[j] {
                    valid = false;
                    break;
                }
                for (channel, value) in predicted.iter_mut().enumerate() {
                    *value += source.rgba[j * 4 + channel] as i32 * weight;
                }
            }
            if !valid {
                continue;
            }
            compared += 1;
            let tolerance = noise as i32 * 32 + if fx != 0 || fy != 0 { 8 } else { 0 };
            if (0..3).any(|c| (target.rgba[i * 4 + c] as i32 * 16 - predicted[c]).abs() > tolerance)
            {
                return false;
            }
        }
    }
    compared >= PIXELS * 3 / 8
}

fn envelope(reference: &Reference, i: usize, colour: [u8; 3], noise: u8) -> bool {
    let (x, y) = (i % SIDE, i / SIDE);
    let (mut low, mut high) = ([255u8; 3], [0u8; 3]);
    let mut present = false;
    for y in y.saturating_sub(1)..=(y + 1).min(SIDE - 1) {
        for x in x.saturating_sub(1)..=(x + 1).min(SIDE - 1) {
            let at = y * SIDE + x;
            if !reference.valid[at] {
                continue;
            }
            present = true;
            for c in 0..3 {
                low[c] = low[c].min(reference.rgba[at * 4 + c]);
                high[c] = high[c].max(reference.rgba[at * 4 + c]);
            }
        }
    }
    present
        && (0..3).all(|c| {
            colour[c] >= low[c].saturating_sub(noise.saturating_mul(2))
                && colour[c] <= high[c].saturating_add(noise.saturating_mul(2))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(rgba: Vec<u8>) -> Candidate {
        Candidate::new(0, 0., 0, 0, rgba, vec![Visibility::Visible; PIXELS], 100)
    }
    // Chroma subsampling changes colour at an edge even when its native luma stays put. It must
    // stay uncertain, while a genuinely new isoluminant colour must still be a content change.
    #[test]
    fn chroma_phase_is_weak_evidence_and_does_not_hide_a_new_colour() {
        let mut a = [180, 50, 50, 255].repeat(PIXELS);
        for y in 0..SIDE {
            for x in SIDE / 2..SIDE {
                a[(y * SIDE + x) * 4..(y * SIDE + x) * 4 + 4].copy_from_slice(&[40, 120, 50, 255]);
            }
        }
        let mut b = a.clone();
        for y in 0..SIDE {
            for (x, colour) in [(7, [140, 70, 50, 255]), (8, [80, 100, 50, 255])] {
                b[(y * SIDE + x) * 4..(y * SIDE + x) * 4 + 4].copy_from_slice(&colour);
            }
        }
        let reference = Reference::from_candidate(&candidate(a)).unwrap();
        assert!(reference.explains(&candidate(b), 2));
        assert!(!reference.explains(&candidate([30, 100, 190, 255].repeat(PIXELS)), 2));
    }
}
