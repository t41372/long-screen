//! The scan pass (pass 1): per-frame motion evidence and region learning.
//!
//! The host decodes frames in order and, for each one, writes its native RGBA into [`ScanSession::frame_buffer`],
//! optionally asks [`ScanSession::is_duplicate`] (so it can skip work of its own, such as a WebGPU downscale, on an
//! exact repeat), then calls [`ScanSession::push`] with the frame's index and timing and, when it already has one, the
//! analysis gray. The step returns the `scan/<frame>` record, the `scan-features/<frame>` row (not for a duplicate),
//! and the per-frame diagnostics. After the last frame, [`ScanSession::finish`] builds the run's regions and the
//! diagnostics about their shape.
//!
//! What stays with the host: decoding, the geometry check against the run's frame size, storing rows (in batches),
//! error classification, progress, pause and stop, and the facts only it knows (the compute backend, how frames were
//! converted, the frame-reference image).

use crate::engine::diagnostic::{Diagnostic, Severity};
use crate::engine::layers::{ManualRegion, RegionLearner};
use crate::kernels::features::{extract_features, match_features, Feature, MAX_FEATURES_DEFAULT};
use crate::kernels::layers::{Field, FieldMotion};
use crate::kernels::motion::{self, Gray, MatchPoints, Motion, MotionField, MOTION_CELL};
use crate::kernels::raster::{downscale_gray, downscaled_size, mean_difference};
use crate::kernels::regions::{Kind, RegionOut};
use std::fmt;
use std::rc::Rc;

/// Frames at least this far behind the current one are tried as a long-baseline reference when the single step was
/// not informative: sub-analysis-pixel motion per frame never clears the evidence bar, the same motion over several
/// frames does.
const LONG_BASELINE_MIN_GAP: u32 = 4;
/// A long-baseline reference older than this many frames that still yields no evidence is replaced by the current
/// frame.
const LONG_BASELINE_MAX_GAP: u32 = 24;
/// Mean analysis-gray change below which two frames count as paused (no feature matching is done).
const PAUSED_DIFFERENCE: f64 = 0.12;
/// A frame shown longer than this (seconds) is reported as temporal undersampling.
const UNDERSAMPLED_DURATION: f64 = 0.12;

/// Which branch first laid out a motion field. The page persists the field as an object whose key order follows
/// the branch that built it (a duplicate frame keeps its predecessor's), and the scenario fingerprint hashes key
/// order, so the host rebuilds the object in this layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldLayout {
    /// The first frame's stand-in zero-motion field.
    Initial,
    /// A field estimated against an earlier frame.
    Estimated,
}

/// The `scan/<frame>` row.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanRecord {
    pub index: u32,
    pub time: f64,
    pub duration: f64,
    pub field: MotionField,
    pub layout: FieldLayout,
    /// Exact native RGBA equality with the previous frame.
    pub duplicate: bool,
}

/// The `scan-features/<frame>` row: a frame's features as three flat arrays (analysis-pixel `x, y` pairs as i16,
/// scores as f32, eight descriptor words each).
#[derive(Clone, Debug, PartialEq)]
pub struct CompactFeatures {
    pub xy: Vec<i16>,
    pub score: Vec<f32>,
    pub descriptors: Vec<u32>,
}

impl CompactFeatures {
    pub fn encode(features: &[Feature]) -> CompactFeatures {
        CompactFeatures {
            xy: features
                .iter()
                .flat_map(|f| [f.x as i16, f.y as i16])
                .collect(),
            score: features.iter().map(|f| f.score as f32).collect(),
            descriptors: features.iter().flat_map(|f| f.descriptor).collect(),
        }
    }
}

/// What one frame produced.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanStep {
    pub record: ScanRecord,
    /// `None` for a duplicate frame, which reuses its predecessor's features.
    pub features: Option<CompactFeatures>,
    /// This was the run's first analysed frame (the host records its own first-frame facts then).
    pub first: bool,
    pub diagnostics: Vec<Diagnostic>,
}

/// The index and timing of one decoded frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameMeta {
    pub index: u32,
    pub time: f64,
    pub duration: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScanError {
    /// `push` without a frame written into `frame_buffer` first.
    NoFrame,
    /// The host's analysis gray does not have the session's analysis size.
    GrayGeometry { expected: usize, actual: usize },
    /// Two analysis frames of different sizes were compared.
    FrameGeometryChanged,
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScanError::NoFrame => write!(
                f,
                "CORE_BAD_ARGUMENT: no frame was written before this scan step."
            ),
            ScanError::GrayGeometry { expected, actual } => write!(
                f,
                "CORE_BAD_ARGUMENT: the analysis gray holds {actual} pixels, not {expected}."
            ),
            ScanError::FrameGeometryChanged => write!(f, "FRAME_GEOMETRY_CHANGED"),
        }
    }
}

impl std::error::Error for ScanError {}

/// The run's regions and the diagnostics about their shape.
pub struct ScanRegions {
    pub regions: Vec<RegionOut>,
    pub diagnostics: Vec<Diagnostic>,
}

/// One analysed frame as later frames compare against it: its native slot, analysis gray and features.
#[derive(Clone)]
struct Observed {
    slot: usize,
    gray: Rc<Vec<u8>>,
    features: Rc<Vec<Feature>>,
    index: u32,
}

/// The scan pass of one run.
pub struct ScanSession {
    width: usize,
    height: usize,
    factor: usize,
    analysis_width: usize,
    analysis_height: usize,
    /// Native RGBA frames: at most three are alive (the previous frame, the long-baseline reference and the frame
    /// being written), so each decoded frame is written once and never copied between them.
    slots: Vec<Vec<u8>>,
    staged: Option<usize>,
    staged_duplicate: Option<bool>,
    previous: Option<Observed>,
    baseline: Option<Observed>,
    last_field: Option<(MotionField, FieldLayout)>,
    learner: RegionLearner,
    analysed: u32,
}

impl ScanSession {
    /// A scan over `width × height` native frames analysed at the integer `factor`.
    pub fn new(width: usize, height: usize, factor: usize) -> ScanSession {
        let factor = factor.max(1);
        let (analysis_width, analysis_height) = downscaled_size(width, height, factor);
        ScanSession {
            width,
            height,
            factor,
            analysis_width,
            analysis_height,
            slots: Vec::new(),
            staged: None,
            staged_duplicate: None,
            previous: None,
            baseline: None,
            last_field: None,
            learner: RegionLearner::new(analysis_width, analysis_height),
            analysed: 0,
        }
    }

    pub fn native_size(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    pub fn analysis_size(&self) -> (usize, usize) {
        (self.analysis_width, self.analysis_height)
    }

    /// The layer-learning state, for hosts and tests that read the accumulators back.
    pub fn learner(&self) -> &RegionLearner {
        &self.learner
    }

    /// The buffer the next frame's native RGBA (`width × height × 4` bytes) goes into. Asking again before `push`
    /// returns the same buffer.
    pub fn frame_buffer(&mut self) -> &mut [u8] {
        let slot = match self.staged {
            Some(slot) => slot,
            None => {
                let held = |s: usize| {
                    self.previous.as_ref().is_some_and(|p| p.slot == s)
                        || self.baseline.as_ref().is_some_and(|b| b.slot == s)
                };
                let slot = match (0..self.slots.len()).find(|&s| !held(s)) {
                    Some(slot) => slot,
                    None => {
                        self.slots.push(vec![0; self.width * self.height * 4]);
                        self.slots.len() - 1
                    }
                };
                self.staged = Some(slot);
                self.staged_duplicate = None;
                slot
            }
        };
        &mut self.slots[slot]
    }

    /// Whether the frame written into `frame_buffer` repeats the previous frame exactly (every RGBA byte). A
    /// duplicate needs no analysis gray.
    pub fn is_duplicate(&mut self) -> bool {
        let Some(slot) = self.staged else {
            return false;
        };
        if let Some(known) = self.staged_duplicate {
            return known;
        }
        let duplicate = self
            .previous
            .as_ref()
            .is_some_and(|p| self.slots[p.slot] == self.slots[slot]);
        self.staged_duplicate = Some(duplicate);
        duplicate
    }

    /// Analyses the frame written into `frame_buffer`. `gray` is the host's analysis gray for it (for example from
    /// WebGPU), which must equal the box-filtered luma at the session's factor; without one the session computes it.
    pub fn push(&mut self, meta: FrameMeta, gray: Option<&[u8]>) -> Result<ScanStep, ScanError> {
        let Some(slot) = self.staged else {
            return Err(ScanError::NoFrame);
        };
        let duplicate = self.is_duplicate();
        let (aw, ah) = (self.analysis_width, self.analysis_height);
        let (g, features) = match (&self.previous, duplicate) {
            (Some(previous), true) => (previous.gray.clone(), previous.features.clone()),
            _ => {
                let g = match gray {
                    Some(g) if g.len() != aw * ah => {
                        return Err(ScanError::GrayGeometry {
                            expected: aw * ah,
                            actual: g.len(),
                        })
                    }
                    Some(g) => g.to_vec(),
                    None => {
                        let mut out = vec![0; aw * ah];
                        downscale_gray(
                            &self.slots[slot],
                            self.width,
                            self.height,
                            self.factor,
                            &mut out,
                        );
                        out
                    }
                };
                let features = features_of(&g, aw, ah);
                (Rc::new(g), Rc::new(features))
            }
        };
        self.staged = None;
        self.staged_duplicate = None;
        self.analysed += 1;
        let current = Observed {
            slot,
            gray: g,
            features,
            index: meta.index,
        };
        let (field, layout, first) = match &self.last_field {
            Some((last, layout)) if duplicate => (
                duplicate_field(last, current.features.len()),
                *layout,
                false,
            ),
            _ if self.previous.is_some() => {
                (self.step_motion(&current)?, FieldLayout::Estimated, false)
            }
            _ => {
                self.baseline = Some(current.clone());
                (
                    initial_field(aw, ah, current.features.len()),
                    FieldLayout::Initial,
                    true,
                )
            }
        };
        let diagnostics = frame_diagnostics(&meta, current.features.len(), &field);
        let features = (!duplicate).then(|| CompactFeatures::encode(&current.features));
        self.last_field = Some((field.clone(), layout));
        self.previous = Some(current);
        Ok(ScanStep {
            record: ScanRecord {
                index: meta.index,
                time: meta.time,
                duration: meta.duration,
                field,
                layout,
                duplicate,
            },
            features,
            first,
            diagnostics,
        })
    }

    /// Estimates motion against the previous frame and feeds an informative field to the learner; when the single
    /// step is not informative, retries against the long-baseline reference, whose displacement accumulated over
    /// several frames can be.
    fn step_motion(&mut self, current: &Observed) -> Result<MotionField, ScanError> {
        let (aw, ah) = (self.analysis_width, self.analysis_height);
        let previous = self
            .previous
            .clone()
            .expect("step_motion runs with a previous frame");
        let field = estimate(&previous, current, aw, ah)?;
        if informative_field(&field) {
            self.learn(&field, &previous, current, true);
            self.baseline = Some(current.clone());
        } else if let Some(baseline) = self.baseline.clone() {
            let gap = current.index - baseline.index;
            if gap >= LONG_BASELINE_MIN_GAP {
                let long = estimate(&baseline, current, aw, ah)?;
                if informative_field(&long) {
                    self.learn(&long, &baseline, current, false);
                    self.baseline = Some(current.clone());
                } else if gap > LONG_BASELINE_MAX_GAP {
                    self.baseline = Some(current.clone());
                }
            }
        }
        Ok(field)
    }

    /// Feeds one field to the region learner; `consecutive` when it spans two consecutive frames (not a long baseline).
    fn learn(&mut self, field: &MotionField, from: &Observed, to: &Observed, consecutive: bool) {
        let motions: Vec<FieldMotion> = field
            .motions
            .iter()
            .map(|m| FieldMotion {
                x: m.x,
                y: m.y,
                support: m.support,
                confidence: m.confidence,
            })
            .collect();
        let learner_field = Field {
            motions: &motions,
            labels: &field.labels,
            confidence: &field.confidence,
            dynamic: &field.dynamic,
            cols: field.cols,
            rows: field.rows,
            difference: field.difference,
            unknown: field.unknown,
        };
        let native = Some((
            self.slots[from.slot].as_slice(),
            self.slots[to.slot].as_slice(),
            self.width,
            self.height,
        ));
        if consecutive {
            self.learner
                .add_consecutive(to.index, &learner_field, &from.gray, &to.gray, native);
        } else {
            self.learner
                .add(&learner_field, &from.gray, &to.gray, native);
        }
    }

    /// Builds the run's regions (none when no frame was analysed) from the learned evidence, or from `manual` when
    /// the run has hand-placed regions, and the diagnostics about the resulting layout.
    pub fn finish(&self, manual: &[ManualRegion]) -> ScanRegions {
        let regions = if self.analysed == 0 {
            Vec::new()
        } else {
            self.learner.finish(
                self.width as f64,
                self.height as f64,
                manual,
                self.factor as u32,
            )
        };
        let diagnostics = region_diagnostics(&regions, manual.len());
        ScanRegions {
            regions,
            diagnostics,
        }
    }
}

/// Features of one analysis gray, with their scores at the f32 precision every stored or exchanged copy has.
fn features_of(gray: &[u8], width: usize, height: usize) -> Vec<Feature> {
    let mut features = extract_features(gray, width, height, MAX_FEATURES_DEFAULT, None);
    for f in &mut features {
        f.score = f.score as f32 as f64;
    }
    features
}

fn estimate(
    a: &Observed,
    b: &Observed,
    width: usize,
    height: usize,
) -> Result<MotionField, ScanError> {
    fn gray(data: &[u8], width: usize, height: usize) -> Gray<'_> {
        Gray {
            width,
            height,
            data,
        }
    }
    estimate_motion(
        gray(&a.gray, width, height),
        gray(&b.gray, width, height),
        Some(&a.features),
        Some(&b.features),
    )
}

/// Motion from analysis frame `a` to `b`, matching the given features (extracted here when absent). A paused pair
/// (mean change below 0.12) skips feature matching altogether.
pub fn estimate_motion(
    a: Gray<'_>,
    b: Gray<'_>,
    a_features: Option<&[Feature]>,
    b_features: Option<&[Feature]>,
) -> Result<MotionField, ScanError> {
    if a.width != b.width || a.height != b.height {
        return Err(ScanError::FrameGeometryChanged);
    }
    if mean_difference(a.data, b.data) < PAUSED_DIFFERENCE {
        return Ok(motion::estimate_motion(a, b, &[], 0));
    }
    let extracted_a;
    let fa = match a_features {
        Some(f) => f,
        None => {
            extracted_a = features_of(a.data, a.width, a.height);
            &extracted_a
        }
    };
    let extracted_b;
    let fb = match b_features {
        Some(f) => f,
        None => {
            extracted_b = features_of(b.data, b.width, b.height);
            &extracted_b
        }
    };
    let points: Vec<MatchPoints> = if fa.is_empty() || fb.is_empty() {
        Vec::new()
    } else {
        match_features(fa, fb, true)
            .iter()
            .map(|m| {
                let (p, q) = (&fa[m.a as usize], &fb[m.b as usize]);
                MatchPoints {
                    ax: p.x as f64,
                    ay: p.y as f64,
                    bx: q.x as f64,
                    by: q.y as f64,
                    unique: m.unique,
                }
            })
            .collect()
    };
    Ok(motion::estimate_motion(a, b, &points, fb.len() as u32))
}

/// A field carries real evidence only once some model moved more than analysis jitter and is reasonably well
/// matched. Squared length against 1, not a hypot: plain IEEE multiply and add, identical on every engine.
pub fn informative_field(field: &MotionField) -> bool {
    !field.unknown
        && field.difference >= 0.2
        && field
            .motions
            .iter()
            .any(|m| m.x * m.x + m.y * m.y > 1.0 && m.confidence > 0.3)
}

fn still(support: usize) -> Motion {
    Motion {
        x: 0.0,
        y: 0.0,
        support: support as u32,
        unique: support as u32,
        confidence: 1.0,
        error: 0.0,
        ambiguous: false,
    }
}

/// The first frame has nothing to compare against: a zero-motion field over the analysis grid stands in.
fn initial_field(width: usize, height: usize, features: usize) -> MotionField {
    let (cols, rows) = (width.div_ceil(MOTION_CELL), height.div_ceil(MOTION_CELL));
    MotionField {
        motions: vec![still(features)],
        labels: vec![0; cols * rows],
        confidence: vec![255; cols * rows],
        dynamic: vec![0; cols * rows],
        cols,
        rows,
        cell: MOTION_CELL,
        difference: 0.0,
        feature_count: features as u32,
        unknown: false,
        zoom: 1.0,
    }
}

/// A duplicate frame moved nothing: the previous field's layout, confidence and feature count, no labels or
/// dynamic cells.
fn duplicate_field(last: &MotionField, features: usize) -> MotionField {
    MotionField {
        motions: vec![still(features)],
        labels: vec![0; last.labels.len()],
        dynamic: vec![0; last.labels.len()],
        difference: 0.0,
        unknown: false,
        zoom: 1.0,
        ..(*last).clone()
    }
}

fn frame_diagnostics(meta: &FrameMeta, features: usize, field: &MotionField) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let at = |code, severity| Diagnostic::new(code, severity).at(meta.index, meta.time);
    if features < 8 && meta.index == 0 {
        out.push(at("LOW_TEXTURE_UNOBSERVABLE", Severity::Warning));
    }
    if field.unknown {
        out.push(at("UNRESOLVED_MOTION", Severity::Warning));
    }
    if field
        .motions
        .first()
        .is_some_and(|m| m.ambiguous && m.support >= 6)
    {
        out.push(at("AMBIGUOUS_PATTERN", Severity::Warning));
    }
    if meta.duration > UNDERSAMPLED_DURATION {
        out.push(at("TEMPORAL_UNDERSAMPLING", Severity::Info));
    }
    out
}

fn region_diagnostics(regions: &[RegionOut], manual: usize) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    if regions.iter().any(|r| r.unassigned) {
        out.push(Diagnostic::new("MANUAL_UNASSIGNED", Severity::Warning));
    }
    if regions.iter().any(|r| r.kind == Kind::Ignore) {
        out.push(Diagnostic::new(
            "EXPLICITLY_EXCLUDED_REGION",
            Severity::Warning,
        ));
    }
    if manual > 0 {
        out.push(Diagnostic::new("MANUAL_REGION_PRIORITY", Severity::Info));
    }
    let count = |kind| regions.iter().filter(|r| r.kind == kind).count() as f64;
    let (moving, fixed) = (count(Kind::Moving), count(Kind::Fixed));
    if manual == 0 {
        out.push(
            Diagnostic::new("AUTOMATIC_LAYER_MASK", Severity::Info)
                .param("moving", moving)
                .param("fixed", fixed),
        );
    }
    if moving > 1.0 {
        out.push(Diagnostic::new("MULTIPLE_SCROLL_LAYERS", Severity::Info));
    }
    out
}

#[cfg(test)]
mod tests;
