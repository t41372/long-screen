//! Photometric evidence for an identified object's translucent/native fringe. A field is learned
//! from independently page-visible backgrounds at different world positions. It only classifies
//! source visibility: output pixels are still copied from preserved observations.
use serde::{Deserialize, Serialize};
const SAMPLES: usize = 8;
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub observed_frame: u32,
    pub background_frame: u32,
    pub world_x: i32,
    pub world_y: i32,
    pub background: [u8; 3],
    pub observed: [u8; 3],
}
#[derive(Default, Serialize, Deserialize)]
pub struct PixelModel {
    samples: Vec<Sample>,
    ambiguous: bool,
    counterexample: Option<Sample>,
    cached: Option<CachedFit>,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
struct CachedFit {
    noise: u8,
    fit: Fit,
    occluding: bool,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Fit {
    pub transmission: f64,
    bias: [f64; 3],
}
fn difference(a: [u8; 3], b: [u8; 3]) -> u32 {
    (0..3).map(|c| a[c].abs_diff(b[c]) as u32).sum()
}
impl Fit {
    /// Even without a known background, a convex overlay cannot emit colours outside this range.
    /// This rejects a newly exposed dark glyph under an opaque white header, or a bright clean
    /// glyph that a dark shadow could never produce from any 8-bit background.
    pub fn explains(&self, observed: [u8; 3], noise: u8) -> bool {
        (0..3).all(|c| {
            observed[c] as f64 >= self.bias[c] - noise as f64 - 1.
                && observed[c] as f64 <= self.bias[c] + 255. * self.transmission + noise as f64 + 1.
        })
    }
    pub fn matches(&self, observed: [u8; 3], background: [u8; 3], noise: u8) -> bool {
        (0..3).all(|c| {
            (observed[c] as f64 - (background[c] as f64 * self.transmission + self.bias[c])).abs()
                <= noise as f64 + 1.
        })
    }
}
impl PixelModel {
    pub fn observe(&mut self, sample: Sample, noise: u8) -> bool {
        if self.ambiguous {
            return false;
        }
        let contradicts_same_colour = self.samples.iter().any(|old| {
            difference(old.background, sample.background) <= noise as u32 * 3
                && difference(old.observed, sample.observed) > (noise as u32 + 1) * 3
        });
        if contradicts_same_colour
            || self
                .cached
                .filter(|c| c.noise == noise)
                .is_some_and(|c| !c.fit.matches(sample.observed, sample.background, noise))
        {
            self.ambiguous = true;
            self.counterexample = Some(sample);
            self.cached = None;
            return true;
        }
        if self
            .samples
            .iter()
            .any(|s| s.world_x == sample.world_x && s.world_y == sample.world_y)
        {
            return false;
        }
        // Keep the evidence that established a field. Hundreds of later blank-page observations
        // add no information and must not evict its rare contrasting backgrounds.
        if self.cached.is_some_and(|c| c.noise == noise && c.occluding) {
            return false;
        }
        if self.samples.len() >= 3
            && self
                .samples
                .iter()
                .all(|s| s.background == sample.background && s.observed == sample.observed)
        {
            return false;
        }
        if self.samples.len() < SAMPLES {
            self.samples.push(sample);
        } else {
            let at = self
                .samples
                .iter()
                .enumerate()
                .min_by_key(|(_, s)| difference(s.background, s.observed))
                .map(|(i, _)| i)
                .unwrap();
            self.samples[at] = sample;
        }
        self.cached = self.regression(noise, true).map(|fit| CachedFit {
            noise,
            fit,
            occluding: self.regression(noise, false).is_some(),
        });
        if self.cached.is_none() && self.has_information(noise) {
            self.ambiguous = true;
            self.counterexample = Some(sample);
        }
        true
    }
    fn has_information(&self, noise: u8) -> bool {
        let n = self.samples.len() as f64;
        if n < 3. {
            return false;
        }
        let mut sums = [0f64; 3];
        let mut squares = 0.;
        for s in &self.samples {
            for (c, sum) in sums.iter_mut().enumerate() {
                let b = s.background[c] as f64;
                *sum += b;
                squares += b * b;
            }
        }
        squares - sums.iter().map(|s| s * s / n).sum::<f64>()
            >= n * (noise as f64 * noise as f64 * 4.).max(16.)
    }
    pub fn fit(&self, noise: u8) -> Option<Fit> {
        if self.ambiguous {
            return None;
        }
        if let Some(c) = self.cached.filter(|c| c.noise == noise) {
            return c.occluding.then_some(c.fit);
        }
        self.regression(noise, false)
    }
    fn regression(&self, noise: u8, allow_identity: bool) -> Option<Fit> {
        let n = self.samples.len();
        if self.ambiguous || n < 3 {
            return None;
        }
        let (mut b, mut o) = ([0f64; 3], [0f64; 3]);
        let (mut bb, mut bo, mut oo) = (0., 0., 0.);
        let mut differing = 0;
        for s in &self.samples {
            for c in 0..3 {
                let x = s.background[c] as f64;
                let y = s.observed[c] as f64;
                b[c] += x;
                o[c] += y;
                bb += x * x;
                bo += x * y;
                oo += y * y;
            }
            if difference(s.background, s.observed) > noise as u32 * 3 {
                differing += 1;
            }
        }
        let n = n as f64;
        let variance = bb - b.iter().map(|v| v * v / n).sum::<f64>();
        if variance < n * (noise as f64 * noise as f64 * 4.).max(16.)
            || (!allow_identity && differing < 2)
        {
            return None;
        }
        let covariance = bo - (0..3).map(|c| b[c] * o[c] / n).sum::<f64>();
        let transmission = covariance / variance;
        if !(-0.005..if allow_identity { 1.005 } else { 0.998 }).contains(&transmission) {
            return None;
        }
        let residual =
            (oo - o.iter().map(|v| v * v / n).sum::<f64>() - covariance * covariance / variance)
                .max(0.);
        if residual > n * 3. * (noise as f64 + 0.65).powi(2) {
            return None;
        }
        let uncertainty = (residual / (n * 3. - 4.) / variance).sqrt();
        if !allow_identity && 1. - transmission < 3. * uncertainty + 1. / 1024. {
            return None;
        }
        let bias = std::array::from_fn(|c| (o[c] - transmission * b[c]) / n);
        if bias.iter().any(|&b| {
            b < -(noise as f64 + 1.) || b > 255. * (1. - transmission) + noise as f64 + 1.
        }) {
            return None;
        }
        Some(Fit {
            transmission: transmission.max(0.),
            bias,
        })
    }
}

use super::{
    analysis::TileAnalysis,
    annotation::Evidence,
    objects::{MotionRole, ObjectObservation},
    tile::SpillEntry,
    Visibility, SIDE,
};
use std::collections::BTreeMap;
pub const FIELD_SIDE: i32 = 64;
const FRINGE: i32 = 24;
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct Key {
    region: u16,
    object: u32,
    local: bool,
    x: i32,
    y: i32,
}
impl Key {
    fn at(object: &ObjectObservation, role: MotionRole, x: i32, y: i32) -> (Self, u16) {
        let local = role == MotionRole::Local;
        let (x, y) = if local {
            (x - object.bounds.x, y - object.bounds.y)
        } else {
            (x, y)
        };
        (
            Self {
                region: object.region,
                object: object.id,
                local,
                x: x.div_euclid(FIELD_SIDE),
                y: y.div_euclid(FIELD_SIDE),
            },
            (y.rem_euclid(FIELD_SIDE) * FIELD_SIDE + x.rem_euclid(FIELD_SIDE)) as u16,
        )
    }
    fn label(&self) -> String {
        format!(
            "{}-{}-{}/{:}_{}",
            self.region,
            self.object,
            if self.local { "local" } else { "screen" },
            self.x,
            self.y
        )
    }
}
#[derive(Default, Serialize, Deserialize)]
pub struct Field {
    pixels: BTreeMap<u16, PixelModel>,
}
impl Field {
    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .pixels
                .values()
                .map(|p| {
                    std::mem::size_of::<PixelModel>()
                        + 32
                        + p.samples.capacity() * std::mem::size_of::<Sample>()
                })
                .sum::<usize>()
    }

    pub fn fits(&self, noise: u8) -> BTreeMap<u16, Fit> {
        let direct: BTreeMap<_, _> = self
            .pixels
            .iter()
            .filter_map(|(&i, p)| p.fit(noise).map(|f| (i, f)))
            .collect();
        let mut fits = direct.clone();
        for (&i, pixel) in &self.pixels {
            if fits.contains_key(&i) || pixel.ambiguous || pixel.samples.len() < 3 {
                continue;
            }
            let (x, y) = (i as i32 % FIELD_SIDE, i as i32 / FIELD_SIDE);
            let mut neighbours = Vec::new();
            for (dx, dy) in [
                (-1, 0),
                (1, 0),
                (0, -1),
                (0, 1),
                (-2, 0),
                (2, 0),
                (0, -2),
                (0, 2),
            ] {
                let (xx, yy) = (x + dx, y + dy);
                if xx < 0 || yy < 0 || xx >= FIELD_SIDE || yy >= FIELD_SIDE {
                    continue;
                }
                if let Some(fit) = direct
                    .get(&((yy * FIELD_SIDE + xx) as u16))
                    .filter(|f| f.transmission < 0.02)
                {
                    neighbours.push(*fit);
                }
            }
            if neighbours.len() < 2 {
                continue;
            }
            let fit = neighbours[0];
            // Only extend an opaque, constant native surface through an uninformative sample.
            // There is no recursive dilation, inferred shadow, or output colour interpolation.
            if neighbours
                .iter()
                .all(|n| (0..3).all(|c| (n.bias[c] - fit.bias[c]).abs() <= noise as f64 + 1.))
                && pixel
                    .samples
                    .iter()
                    .all(|s| fit.matches(s.observed, s.background, noise))
            {
                fits.insert(i, fit);
            }
        }
        fits
    }
    pub fn encode(&self) -> Result<Vec<u8>, postcard::Error> {
        super::archive::encode(&(1u32, self))
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, postcard::Error> {
        let (version, field): (u32, Self) = super::archive::decode(bytes)?;
        if version != 1 {
            return Err(postcard::Error::DeserializeBadEncoding);
        }
        Ok(field)
    }
    pub fn valid_pixels(&self, noise: u8) -> usize {
        self.pixels
            .values()
            .filter(|p| p.fit(noise).is_some())
            .count()
    }
}
#[derive(Default)]
pub struct Learning {
    fields: BTreeMap<Key, Vec<(u16, Sample)>>,
}
impl Learning {
    pub fn new(analysis: &TileAnalysis, entries: &[SpillEntry], evidence: &Evidence) -> Self {
        let mut learning = Self::default();
        let n = analysis.size / SIDE;
        for e in entries {
            let Some(block) = analysis.blocks.get(&e.block) else {
                continue;
            };
            let wx = analysis.tx * analysis.size as i32 + (e.block as usize % n * SIDE) as i32;
            let wy = analysis.ty * analysis.size as i32 + (e.block as usize / n * SIDE) as i32;
            evidence.each_object(&e.candidate, |object, role, pose| {
                if object.region >= 256
                    || !matches!(role, MotionRole::Screen | MotionRole::Local)
                    || object.core.iter().map(|r| r.length).sum::<u32>() < 8
                {
                    return;
                }
                let (sx, sy) = (wx - pose.0, wy - pose.1);
                if !intersects(object, sx, sy) {
                    return;
                }
                for (i, p) in block.pixels.iter().enumerate() {
                    if p.rank != 3
                        || p.visible_disagreement
                        || p.occluded_twin
                        || e.candidate.visibility[i] == Visibility::Outside
                        || e.candidate.visibility[i].is_context()
                    {
                        continue;
                    }
                    let x = sx + (i % SIDE) as i32;
                    let y = sy + (i / SIDE) as i32;
                    if !near(object, x, y) {
                        continue;
                    }
                    let (key, pixel) = Key::at(object, role, x, y);
                    let sample = Sample {
                        observed_frame: e.candidate.frame,
                        background_frame: p.frame,
                        world_x: wx + (i % SIDE) as i32,
                        world_y: wy + (i / SIDE) as i32,
                        background: p.rgba[..3].try_into().unwrap(),
                        observed: e.candidate.rgba[i * 4..i * 4 + 3].try_into().unwrap(),
                    };
                    learning
                        .fields
                        .entry(key)
                        .or_default()
                        .push((pixel, sample));
                }
            });
        }
        learning
    }
    pub fn keys(&self) -> Vec<String> {
        self.fields.keys().map(Key::label).collect()
    }
    pub fn merge(&self, key: &str, field: &mut Field, noise: u8) -> bool {
        let mut changed = false;
        if let Some(samples) = self
            .fields
            .iter()
            .find(|(k, _)| k.label() == key)
            .map(|(_, v)| v)
        {
            for &(pixel, sample) in samples {
                changed |= field
                    .pixels
                    .entry(pixel)
                    .or_default()
                    .observe(sample, noise);
            }
        }
        changed
    }
}
fn intersects(o: &ObjectObservation, x: i32, y: i32) -> bool {
    x < o.bounds.x + o.bounds.width + FRINGE
        && y < o.bounds.y + o.bounds.height + FRINGE
        && x + SIDE as i32 > o.bounds.x - FRINGE
        && y + SIDE as i32 > o.bounds.y - FRINGE
}
fn near(o: &ObjectObservation, x: i32, y: i32) -> bool {
    x >= o.bounds.x - FRINGE
        && y >= o.bounds.y - FRINGE
        && x < o.bounds.x + o.bounds.width + FRINGE
        && y < o.bounds.y + o.bounds.height + FRINGE
}

/// One archived page at a time. The adapter pages model fields through KV; there is never a full
/// recording's model set or candidate history resident alongside the frame buffers.
struct FieldVisit {
    entry: usize,
    // Candidate-local intersection, plus field-local position of candidate (0,0).
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    field_x: i32,
    field_y: i32,
}
pub struct Annotation {
    pub entries: Vec<SpillEntry>,
    fields: BTreeMap<String, Vec<FieldVisit>>,
}
impl Annotation {
    pub fn new(
        entries: Vec<SpillEntry>,
        size: usize,
        tx: i32,
        ty: i32,
        evidence: std::rc::Rc<Evidence>,
    ) -> Self {
        let n = size / SIDE;
        let mut fields: BTreeMap<String, Vec<FieldVisit>> = BTreeMap::new();
        for (entry, e) in entries.iter().enumerate() {
            let wx = tx * size as i32 + (e.block as usize % n * SIDE) as i32;
            let wy = ty * size as i32 + (e.block as usize / n * SIDE) as i32;
            evidence.each_object(&e.candidate, |object, role, pose| {
                if object.region >= 256
                    || !matches!(role, MotionRole::Screen | MotionRole::Local)
                    || object.core.iter().map(|r| r.length).sum::<u32>() < 8
                {
                    return;
                }
                let (sx, sy) = (wx - pose.0, wy - pose.1);
                if !intersects(object, sx, sy) {
                    return;
                }
                let local = role == MotionRole::Local;
                let (ox, oy) = if local {
                    (object.bounds.x, object.bounds.y)
                } else {
                    (0, 0)
                };
                let (kx, ky) = (sx - ox, sy - oy);
                for fy in ky.div_euclid(FIELD_SIDE)..=(ky + SIDE as i32 - 1).div_euclid(FIELD_SIDE)
                {
                    for fx in
                        kx.div_euclid(FIELD_SIDE)..=(kx + SIDE as i32 - 1).div_euclid(FIELD_SIDE)
                    {
                        let (field_x, field_y) = (kx - fx * FIELD_SIDE, ky - fy * FIELD_SIDE);
                        let x0 = 0.max(object.bounds.x - FRINGE - sx).max(-field_x);
                        let y0 = 0.max(object.bounds.y - FRINGE - sy).max(-field_y);
                        let x1 = (SIDE as i32)
                            .min(object.bounds.x + object.bounds.width + FRINGE - sx)
                            .min(FIELD_SIDE - field_x);
                        let y1 = (SIDE as i32)
                            .min(object.bounds.y + object.bounds.height + FRINGE - sy)
                            .min(FIELD_SIDE - field_y);
                        if x0 >= x1 || y0 >= y1 {
                            continue;
                        }
                        let key = Key {
                            region: object.region,
                            object: object.id,
                            local,
                            x: fx,
                            y: fy,
                        };
                        fields.entry(key.label()).or_default().push(FieldVisit {
                            entry,
                            x0: x0 as usize,
                            y0: y0 as usize,
                            x1: x1 as usize,
                            y1: y1 as usize,
                            field_x,
                            field_y,
                        });
                    }
                }
            });
        }
        Self { entries, fields }
    }
    pub fn keys(&self) -> Vec<String> {
        self.fields.keys().cloned().collect()
    }
    pub fn apply_fitted(
        &mut self,
        key: &str,
        fits: &BTreeMap<u16, Fit>,
        analysis: &TileAnalysis,
        noise: u8,
    ) -> usize {
        let Some(visits) = self.fields.get(key) else {
            return 0;
        };
        if fits.is_empty() {
            return 0;
        }
        let mut changed = 0;
        // The native field/entry intersection is computed once, rather than walking every object
        // and every candidate again for each of the page's model fields.
        for visit in visits {
            let e = &mut self.entries[visit.entry];
            let reference = analysis.blocks.get(&e.block);
            for y in visit.y0..visit.y1 {
                for x in visit.x0..visit.x1 {
                    let i = y * SIDE + x;
                    if e.candidate.visibility[i] == Visibility::Outside
                        || e.candidate.visibility[i].is_occluded()
                        || e.candidate.visibility[i].is_context()
                    {
                        continue;
                    }
                    let point =
                        ((y as i32 + visit.field_y) * FIELD_SIDE + x as i32 + visit.field_x) as u16;
                    let Some(fit) = fits.get(&point) else {
                        continue;
                    };
                    let known = reference
                        .and_then(|b| b.pixels.get(i))
                        .filter(|p| p.rank == 3 && !p.visible_disagreement);
                    let observed = e.candidate.rgba[i * 4..i * 4 + 3].try_into().unwrap();
                    // Page agreement is provisional evidence too: a confirmed photometric occluder
                    // can refute it. A known background must match this observation. Without it, the measured
                    // field provides only negative evidence; it never supplies hidden RGB.
                    if fit.explains(observed, noise)
                        && known.is_none_or(|p| {
                            fit.matches(observed, p.rgba[..3].try_into().unwrap(), noise)
                        })
                    {
                        e.candidate.visibility[i] = Visibility::Occluded;
                        changed += 1;
                    }
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod annotation_tests {
    use super::*;
    use crate::sources::{
        objects::{Bounds, MaskRun},
        Candidate, PIXELS,
    };

    // Applying one field must not leak into its neighbour, another source entry, or Outside pixels.
    // Exercise a patch straddling both field axes under screen and object-local coordinates.
    #[test]
    fn fitted_field_only_classifies_its_actual_native_intersection() {
        for initial in [Visibility::Unknown, Visibility::Visible] {
            for role in [MotionRole::Screen, MotionRole::Local] {
                let candidate = Candidate::new(
                    7,
                    0.,
                    -60,
                    -60,
                    [50, 50, 50, 255].repeat(PIXELS),
                    vec![initial; PIXELS],
                    100,
                );
                let mut entries = vec![
                    SpillEntry {
                        block: 0,
                        candidate: candidate.clone(),
                    },
                    SpillEntry {
                        block: 1,
                        candidate,
                    },
                ];
                entries[0].candidate.visibility[0] = Visibility::Outside;
                let object = ObjectObservation {
                    region: 1,
                    id: 9,
                    frame: 7,
                    bounds: Bounds {
                        x: 0,
                        y: 0,
                        width: 100,
                        height: 100,
                    },
                    role,
                    core: vec![MaskRun {
                        x: 0,
                        y: 0,
                        length: 100,
                    }],
                    pose_x: -60,
                    pose_y: -60,
                };
                let key = Key::at(&object, role, 60, 60).0.label();
                let evidence =
                    std::rc::Rc::new(Evidence::new(vec![object.clone(), object], vec![]));
                let mut annotation = Annotation::new(entries, 256, 0, 0, evidence);
                let fits = (0..4096)
                    .map(|i| {
                        (
                            i,
                            Fit {
                                transmission: 0.,
                                bias: [50.; 3],
                            },
                        )
                    })
                    .collect();
                assert_eq!(
                    annotation.apply_fitted(&key, &fits, &TileAnalysis::new(256, 0, 0, 0), 0),
                    15
                );
                for (entry, item) in annotation.entries.iter().enumerate() {
                    for (i, visibility) in item.candidate.visibility.iter().enumerate() {
                        let expected = if entry == 0 && i == 0 {
                            Visibility::Outside
                        } else if entry == 0 && i % SIDE < 4 && i / SIDE < 4 {
                            Visibility::Occluded
                        } else {
                            initial
                        };
                        assert_eq!(*visibility, expected);
                    }
                }
            }
        }
    }
}
