//! Streaming analysis of immutable candidate pages. Raw histories are not rehydrated together.
//! Pixel choices have fixed size; epoch metadata can be drained separately from the native payload.
use super::tile::{SpillEntry, TileHistory};
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelChoice {
    pub rgba: [u8; 4],
    pub frame: u32,
    pub rank: u8,
    pub quality: u16,
    pub footprints: u64,
    pub exact_footprints: u64,
    pub positions: u64,
    pub visible_positions: u64,
    pub occluded_positions: u64,
    pub visible_disagreement: bool,
    pub unknown_disagreement: bool,
    pub raster_disagreement: bool,
    pub baseline_disagreement: bool,
    pub occluded_twin: bool,
    pub context: bool,
    pub affiliation_supported: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct EpochOption {
    pub page: i32,
    pub entry: u32,
    pub frame: u32,
    pub frames: Vec<FrameSpan>,
    pub visible: u16,
    pub present: u16,
    pub quality: u16,
}
struct LastObservation {
    rgba: super::pixels::Pixels,
    visibility: Vec<Visibility>,
    frame: u32,
    quality: u16,
    noise: u8,
    footprint: u64,
    positions: u64,
    native: u64,
}
#[derive(Default, Serialize, Deserialize)]
pub struct BlockAnalysis {
    #[serde(skip)]
    last: Option<LastObservation>,
    raster_references: Vec<super::phase::Reference>,
    pub baseline: Vec<PixelChoice>,
    pub baseline_coverage: Vec<bool>,
    pub refutations: Vec<Option<[u8; 4]>>,
    pub pixels: Vec<PixelChoice>,
    pub candidates: u32,
    pub options: Vec<EpochOption>,
    pub epoch: Option<u32>,
    pub component: Option<u32>,
    pub complete: bool,
}
#[derive(Serialize, Deserialize)]
pub struct TileAnalysis {
    pub size: usize,
    pub tx: i32,
    pub ty: i32,
    pub noise: u8,
    pub blocks: BTreeMap<u16, BlockAnalysis>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSummary {
    pub block: u16,
    pub x: i32,
    pub y: i32,
    pub kind: ContentKind,
    pub candidates: u32,
    pub expected: u16,
    pub options: Vec<EpochOption>,
}

fn rank(v: Visibility) -> u8 {
    match v {
        Visibility::Outside | Visibility::ContextExcluded => 0,
        Visibility::Occluded
        | Visibility::PlacementOccluded
        | Visibility::ContextOccluded
        | Visibility::ContextPlacementOccluded => 1,
        Visibility::Unknown
        | Visibility::Context
        | Visibility::Background
        | Visibility::ContextBackground
        | Visibility::ContextSurface => 2,
        Visibility::Visible => 3,
    }
}
fn close(a: [u8; 4], b: [u8; 4], noise: u8) -> bool {
    a[3] == b[3] && (0..3).map(|c| a[c].abs_diff(b[c]) as u32).sum::<u32>() <= noise as u32 * 3
}
fn exposures(c: &Candidate) -> u64 {
    c.exposures.iter().fold(0, |bits, e| {
        let mut b = [0u8; 12];
        b[..4].copy_from_slice(&e.x.to_le_bytes());
        b[4..8].copy_from_slice(&e.y.to_le_bytes());
        b[8..].copy_from_slice(&e.visibility.to_le_bytes());
        bits | (1u64 << (crc32fast::hash(&b) % 64))
    })
}
fn position_support(c: &Candidate) -> u64 {
    c.exposures.iter().fold(0, |bits, e| {
        let mut pose = [0u8; 8];
        pose[..4].copy_from_slice(&e.x.to_le_bytes());
        pose[4..].copy_from_slice(&e.y.to_le_bytes());
        bits | (1u64 << (crc32fast::hash(&pose) % 64))
    })
}

fn native_positions(c: &Candidate) -> u64 {
    c.frames.iter().fold(0, |bits, span| {
        let mut pose = [0u8; 8];
        pose[..4].copy_from_slice(&span.pose_x.to_le_bytes());
        pose[4..].copy_from_slice(&span.pose_y.to_le_bytes());
        bits | (1u64 << (crc32fast::hash(&pose) % 64))
    })
}

impl BlockAnalysis {
    fn unrefuted_baseline(&self, index: usize, choice: &PixelChoice) -> bool {
        choice.occluded_twin
            && choice.rank >= 2
            && choice.baseline_disagreement
            && self.baseline.get(index).is_some_and(|p| p.rank >= 2)
    }

    fn affiliation_conflict(p: &PixelChoice) -> bool {
        p.rank == 2
            && p.affiliation_supported
            && !p.context
            && (p.unknown_disagreement || p.baseline_disagreement)
    }
    fn refutable(&self, i: usize, p: &PixelChoice) -> bool {
        let weak_affiliation = Self::affiliation_conflict(p)
            && (p.positions.count_ones() < 3
                || p.occluded_positions.count_ones() >= p.positions.count_ones());
        let page_witness = p.rank == 3
            && p.baseline_disagreement
            && self.baseline.get(i).is_some_and(|b| b.rank >= 2);
        weak_affiliation
            || page_witness && p.positions.count_ones() < 3 && p.visible_positions.count_ones() < 3
    }
    pub fn corroborate(&mut self, candidate: &Candidate, noise: u8) {
        self.last = None;
        let native = native_positions(candidate);
        let coarse = position_support(candidate);
        for (i, selected) in self.pixels.iter_mut().enumerate() {
            let visibility = candidate.visibility[i];
            let candidate_rank = rank(visibility);
            let rgba = candidate.rgba[i * 4..i * 4 + 4].try_into().unwrap();
            if visibility.is_context() != selected.context || !close(selected.rgba, rgba, noise) {
                continue;
            }
            if candidate_rank == 1 {
                selected.occluded_positions |= coarse;
                continue;
            }
            if candidate_rank < 2 {
                continue;
            }
            let affiliated = matches!(
                visibility,
                Visibility::Background | Visibility::ContextBackground | Visibility::ContextSurface
            );
            if selected.rank == 3 && (candidate_rank == 3 || affiliated) {
                selected.visible_positions |= native;
            }
            if selected.rank == 2 && selected.affiliation_supported {
                selected.positions |= coarse;
            }
        }
    }
    pub fn needs_refutation(&self) -> bool {
        self.pixels
            .iter()
            .enumerate()
            .any(|(i, p)| Self::affiliation_conflict(p) || self.refutable(i, p))
    }
    pub fn refute(&mut self, candidate: &Candidate, noise: u8) -> usize {
        self.last = None;
        if !self.needs_refutation() {
            return 0;
        }
        let eligible: [bool; PIXELS] = std::array::from_fn(|i| {
            self.refutable(i, &self.pixels[i]) && candidate.frame > self.pixels[i].frame
        });
        if !eligible.iter().any(|v| *v)
            || candidate
                .visibility
                .iter()
                .filter(|v| matches!(v, Visibility::Occluded | Visibility::PlacementOccluded))
                .count()
                < 8
        {
            return 0;
        }
        let textured = (0..PIXELS)
            .filter(|&i| {
                [
                    i.checked_sub(1).filter(|_| i % SIDE != 0),
                    i.checked_sub(SIDE),
                ]
                .into_iter()
                .flatten()
                .any(|j| {
                    self.pixels[i].rank > 0
                        && self.pixels[j].rank > 0
                        && (0..3)
                            .map(|c| self.pixels[i].rgba[c].abs_diff(self.pixels[j].rgba[c]) as u32)
                            .sum::<u32>()
                            > noise as u32 * 3 + 6
                })
            })
            .count()
            >= 8;
        let mut best: Vec<usize> = Vec::new();
        let mut best_score = (0usize, 0usize, 0usize, std::cmp::Reverse(i32::MAX));
        for dy in -4i32..=4 {
            for dx in -4i32..=4 {
                if (dx != 0 || dy != 0) && !textured {
                    continue;
                }
                let mut compared = 0;
                let mut matched = 0;
                let mut conflicts = Vec::new();
                for (i, p) in self.pixels.iter().enumerate() {
                    let (x, y) = ((i % SIDE) as i32 + dx, (i / SIDE) as i32 + dy);
                    if x < 0 || y < 0 || x >= SIDE as i32 || y >= SIDE as i32 || p.rank == 0 {
                        continue;
                    }
                    let j = y as usize * SIDE + x as usize;
                    if candidate.visibility[j] == Visibility::Outside {
                        continue;
                    }
                    compared += 1;
                    let rgba = candidate.rgba[j * 4..j * 4 + 4].try_into().unwrap();
                    if !close(p.rgba, rgba, noise) {
                        if (dx != 0 || dy != 0) && compared - matched > PIXELS / 10 {
                            break;
                        }
                        continue;
                    }
                    matched += 1;
                    if matches!(
                        candidate.visibility[j],
                        Visibility::Occluded | Visibility::PlacementOccluded
                    ) {
                        conflicts.push(i);
                    }
                }
                if compared < PIXELS / 4 || conflicts.len() < 8 {
                    continue;
                }
                // A displaced mask needs one common native translation explaining the patch, not
                // independently chosen nearby colours. Direct matching runs retain their local test.
                if (dx != 0 || dy != 0) && matched * 10 < compared * 9 {
                    continue;
                }
                let refutable_matches = conflicts.iter().filter(|&&i| eligible[i]).count();
                if refutable_matches == 0 {
                    continue;
                }
                let score = (
                    refutable_matches,
                    conflicts.len(),
                    matched,
                    std::cmp::Reverse(dx.abs() + dy.abs()),
                );
                if score > best_score {
                    best_score = score;
                    best = conflicts;
                }
            }
        }
        let conflicts = best;
        if conflicts.len() < 8 {
            return 0;
        }
        let mut changed = 0;
        let mut remaining = [false; PIXELS];
        for i in conflicts {
            remaining[i] = true;
        }
        // A coherent native run is contradictory evidence; isolated colour coincidences are not.
        // Only matching pixels are weakened. This neither dilates an object nor transfers its RGB.
        for seed in 0..PIXELS {
            if !remaining[seed] {
                continue;
            }
            remaining[seed] = false;
            let mut component = vec![seed];
            let mut at = 0;
            while at < component.len() {
                let i = component[at];
                at += 1;
                let (x, y) = (i % SIDE, i / SIDE);
                for yy in y.saturating_sub(1)..=(y + 1).min(SIDE - 1) {
                    for xx in x.saturating_sub(1)..=(x + 1).min(SIDE - 1) {
                        let next = yy * SIDE + xx;
                        if remaining[next] {
                            remaining[next] = false;
                            component.push(next);
                        }
                    }
                }
            }
            if component.len() < 8 {
                continue;
            }
            if self.refutations.is_empty() {
                self.refutations.resize(PIXELS, None);
            }
            for i in component {
                if !eligible[i] {
                    continue;
                }
                changed += (!self.pixels[i].occluded_twin) as usize;
                self.pixels[i].occluded_twin = true;
                self.refutations[i] = Some(self.pixels[i].rgba);
            }
        }
        changed
    }
    pub fn set_baseline(&mut self, rgba: &[u8], coverage: &[bool]) {
        self.last = None;
        self.baseline = rgba
            .chunks_exact(4)
            .map(|p| PixelChoice {
                rgba: p.try_into().unwrap(),
                ..PixelChoice::default()
            })
            .collect();
        self.baseline_coverage = coverage.to_vec();
    }

    pub fn kind(&self) -> ContentKind {
        if self.pixels.iter().any(|p| p.visible_disagreement) {
            ContentKind::Dynamic
        } else if self.pixels.iter().enumerate().any(|(i, p)| {
            p.unknown_disagreement
                || p.raster_disagreement
                || p.occluded_twin
                || self.unrefuted_baseline(i, p)
        }) {
            ContentKind::Ambiguous
        } else {
            ContentKind::Static
        }
    }
    pub(super) fn feed(&mut self, c: &Candidate, noise: u8, page: i32, entry: u32) {
        self.feed_inner(c, noise, page, entry, true);
    }
    fn feed_inner(&mut self, c: &Candidate, noise: u8, page: i32, entry: u32, allow_uniform: bool) {
        if self.pixels.is_empty() {
            self.pixels.resize(PIXELS, PixelChoice::default());
        }
        let footprint = exposures(c);
        let positions = position_support(c);
        let native = native_positions(c);
        // Only the computation is idempotent. Keep this observation's epoch option and archive
        // identity even when another part of the frame changed the global source_state.
        let repeated = allow_uniform
            && self.last.as_ref().is_some_and(|last| {
                noise == last.noise
                    && c.frame >= last.frame
                    && c.quality == last.quality
                    && footprint == last.footprint
                    && positions == last.positions
                    && native == last.native
                    && c.rgba == last.rgba
                    && c.visibility == last.visibility
            });
        if repeated {
            self.record_option(c, page, entry);
            return;
        }
        if allow_uniform {
            if let Some(last) = &mut self.last {
                last.rgba.clone_from(&c.rgba);
                last.visibility.clone_from(&c.visibility);
                last.frame = c.frame;
                last.quality = c.quality;
                last.noise = noise;
                last.footprint = footprint;
                last.positions = positions;
                last.native = native;
            } else {
                self.last = Some(LastObservation {
                    rgba: c.rgba.clone(),
                    visibility: c.visibility.clone(),
                    frame: c.frame,
                    quality: c.quality,
                    noise,
                    footprint,
                    positions,
                    native,
                });
            }
        }
        let contradictory = self.pixels.iter().enumerate().any(|(i, p)| {
            p.rank == 3
                && c.visibility[i] == Visibility::Visible
                && !close(p.rgba, c.rgba[i * 4..i * 4 + 4].try_into().unwrap(), noise)
        });
        let raster = contradictory
            && self
                .raster_references
                .iter()
                .any(|r| r.explains(c, noise) || r.incomplete_raster_evidence(c, noise));
        // A flat patch still carries every frame, exposure and visibility decision. When all
        // per-pixel inputs AND accumulated states agree, execute that decision once and copy it.
        // One unlike pixel (including alpha, coverage or a refutation) forces the ordinary path.
        fn uniform<T: PartialEq>(values: &[T]) -> bool {
            values.windows(2).all(|pair| pair[0] == pair[1])
        }
        let flat = allow_uniform
            && uniform(&c.visibility)
            && c.rgba.chunks_exact(4).all(|rgba| rgba == &c.rgba[..4])
            && uniform(&self.pixels)
            && (self.baseline.is_empty()
                || self.baseline.len() == PIXELS && uniform(&self.baseline))
            && (self.baseline_coverage.is_empty()
                || self.baseline_coverage.len() == PIXELS && uniform(&self.baseline_coverage))
            && (self.refutations.is_empty()
                || self.refutations.len() == PIXELS && uniform(&self.refutations));
        let count = if flat { 1 } else { PIXELS };
        for (i, old) in self.pixels.iter_mut().take(count).enumerate() {
            let rgba = c.rgba[i * 4..i * 4 + 4].try_into().unwrap();
            let nominal = rank(c.visibility[i]);
            let refuted = self
                .refutations
                .get(i)
                .and_then(|r| *r)
                .is_some_and(|value| close(value, rgba, noise));
            let r = nominal;
            let context = c.visibility[i].is_context();
            let affiliation_supported = matches!(
                c.visibility[i],
                Visibility::Background | Visibility::ContextBackground | Visibility::ContextSurface
            );
            let foreign = c.visibility[i].is_context();
            if r == 0 {
                continue;
            }
            if r >= 1 && !foreign && self.baseline_coverage.get(i) == Some(&true) {
                if r >= 2 {
                    if let Some(prior) = self
                        .baseline
                        .get_mut(i)
                        .filter(|p| close(p.rgba, rgba, noise))
                    {
                        prior.positions |= positions;
                    }
                }
                if let Some(prior) = self.baseline.get_mut(i).filter(|p| p.rgba == rgba) {
                    if r > prior.rank || r == prior.rank && c.quality > prior.quality {
                        prior.rank = r;
                        prior.frame = c.frame;
                        prior.quality = c.quality;
                    }
                    prior.affiliation_supported |= affiliation_supported;
                    prior.occluded_twin |= refuted;
                    if r >= 2 {
                        prior.exact_footprints |= positions;
                    }
                }
            }
            let agrees = close(old.rgba, rgba, noise);
            if r == 3 && old.rank == 3 && !agrees {
                if raster {
                    old.raster_disagreement = true;
                } else {
                    old.visible_disagreement = true;
                }
            }
            if r == old.rank && r < 3 && context == old.context && !agrees {
                old.unknown_disagreement = true;
            }
            if r > old.rank || r == old.rank && old.context && !context {
                old.unknown_disagreement = false;
            }
            let supporting = if r == old.rank && agrees {
                old.footprints | footprint
            } else {
                footprint
            };
            let position_support = if r == old.rank && agrees {
                old.positions | positions
            } else {
                positions
            };
            let visible_support = if r == 3 {
                if old.rank == 3 && agrees {
                    old.visible_positions | native
                } else {
                    native
                }
            } else {
                0
            };
            let exact_support = if r == old.rank && old.rgba == rgba {
                old.exact_footprints | positions
            } else {
                positions
            };
            let better = (
                r,
                !refuted,
                affiliation_supported,
                !context,
                footprint.count_ones().min(8),
                c.quality,
                std::cmp::Reverse(c.frame),
            ) > (
                old.rank,
                !old.occluded_twin,
                old.affiliation_supported,
                !old.context,
                old.footprints.count_ones().min(8),
                old.quality,
                std::cmp::Reverse(old.frame),
            );
            if better || old.rank == 0 {
                old.rgba = rgba;
                old.occluded_positions = 0;
                old.frame = c.frame;
                old.rank = r;
                old.context = context;
                old.affiliation_supported = affiliation_supported;
                old.quality = c.quality;
                old.footprints = supporting;
                old.positions = position_support;
                old.visible_positions = visible_support;
                old.exact_footprints = exact_support;
            } else if r == old.rank && agrees {
                old.affiliation_supported |= affiliation_supported;
                old.footprints = supporting;
                old.positions = position_support;
                old.visible_positions = visible_support;
                if old.rgba == rgba {
                    old.exact_footprints = exact_support;
                }
            }
            // A supported surface can corroborate already visible ink at another native pose;
            // it cannot create a Visible witness on its own, and ordinary unknowns add no support.
            if old.rank == 3 && r == 2 && affiliation_supported && agrees {
                old.visible_positions |= native;
            }
            old.baseline_disagreement = self
                .baseline
                .get(i)
                .is_some_and(|p| !close(p.rgba, old.rgba, noise));
            old.occluded_twin = self
                .refutations
                .get(i)
                .and_then(|r| *r)
                .is_some_and(|rgba| close(rgba, old.rgba, noise));
        }
        if flat {
            let choice = self.pixels[0];
            self.pixels.fill(choice);
            if let Some(&baseline) = self.baseline.first() {
                self.baseline.fill(baseline);
            }
        }
        if let Some(reference) = super::phase::Reference::from_candidate(c) {
            if let Some(old) = self
                .raster_references
                .iter_mut()
                .find(|r| r.same_phase(&reference, noise))
            {
                if reference.coverage() > old.coverage() {
                    *old = reference;
                }
            } else if self.raster_references.len() < 4 {
                self.raster_references.push(reference);
            } else if let Some((i, old)) = self
                .raster_references
                .iter()
                .enumerate()
                .min_by_key(|(_, r)| r.coverage())
            {
                if reference.coverage() > old.coverage() {
                    self.raster_references[i] = reference;
                }
            }
        }
        self.record_option(c, page, entry);
    }
    fn record_option(&mut self, c: &Candidate, page: i32, entry: u32) {
        self.candidates += 1;
        self.options.push(EpochOption {
            page,
            entry,
            frame: c.frame,
            frames: c.frames.clone(),
            visible: c
                .visibility
                .iter()
                .filter(|v| **v == Visibility::Visible)
                .count() as u16,
            present: c
                .visibility
                .iter()
                .filter(|v| **v != Visibility::Outside && !v.is_context())
                .count() as u16,
            quality: c.quality,
        });
    }
    pub fn resolution(&self) -> BlockResolution {
        let mut rgba = Vec::with_capacity(PIXELS * 4);
        let mut sources = Vec::with_capacity(PIXELS);
        let mut reasons = Vec::with_capacity(PIXELS);
        let static_choice = self.epoch.is_none() && self.kind() != ContentKind::Dynamic;
        for (i, p) in self.pixels.iter().enumerate() {
            let baseline_conflict = static_choice && self.unrefuted_baseline(i, p);
            let reason = if p.context && self.baseline_coverage.get(i) == Some(&false) {
                Reason::Unobserved
            } else if p.context && p.rank >= 2 {
                Reason::ContextSource
            } else if self.epoch.is_some() && !self.complete && p.rank > 0 && p.rank < 3 {
                Reason::DynamicPartial
            } else {
                match p.rank {
                    0 => Reason::Unobserved,
                    1 => Reason::NoCleanSource,
                    2 => {
                        if p.unknown_disagreement || p.occluded_twin || baseline_conflict {
                            Reason::Ambiguous
                        } else {
                            Reason::SingleObservation
                        }
                    }
                    _ => {
                        if p.visible_disagreement
                            || p.raster_disagreement
                            || p.occluded_twin
                            || baseline_conflict
                        {
                            Reason::Ambiguous
                        } else {
                            Reason::VisibleWitness
                        }
                    }
                }
            };
            // An unresolved tie is not new evidence against the already selected source. Retain it
            // only if an actual, non-occluded archived observation reproduces its exact bytes.
            // The first compositor already compared native visual quality. Registration confidence
            // is not a reason to repaint an unrefuted equivalent source with different codec noise.
            let compatible = static_choice
                && p.rank >= 2
                && !p.baseline_disagreement
                && self.baseline.get(i).is_some_and(|b| b.rank >= p.rank);
            // Within the noise envelope, repeated exact bytes at distinct poses are stronger than
            // a rare sharpness winner. This breaks only an uncertain photometric tie; it cannot
            // outvote a clean observation or combine colours from different frames.
            let corroborated = compatible
                && p.rank == 2
                && self.baseline[i].rank == 2
                && p.exact_footprints.count_ones() >= 3
                && p.exact_footprints.count_ones() > self.baseline[i].exact_footprints.count_ones();
            let selected = if corroborated {
                p
            } else if compatible {
                &self.baseline[i]
            } else if self.epoch.is_none()
                && (p.rank == 2 || p.raster_disagreement || baseline_conflict)
                && reason == Reason::Ambiguous
                && !(p.affiliation_supported
                    && !p.occluded_twin
                    && self.baseline.get(i).is_some_and(|b| {
                        b.rank <= p.rank
                            && ((!b.affiliation_supported
                                && (b.positions.count_ones() < 3 || p.positions.count_ones() >= 3))
                                || (b.affiliation_supported
                                    && p.positions.count_ones() > b.positions.count_ones()))
                    }))
            {
                self.baseline
                    .get(i)
                    .filter(|b| b.rank >= 2 && !b.occluded_twin)
                    .unwrap_or(p)
            } else if self.epoch.is_none() && reason == Reason::NoCleanSource {
                self.baseline.get(i).filter(|b| b.rank >= 1).unwrap_or(p)
            } else {
                p
            };
            rgba.extend_from_slice(if reason == Reason::Unobserved {
                &[0; 4]
            } else {
                &selected.rgba
            });
            sources.push(if selected.rank == 0 || reason == Reason::Unobserved {
                u32::MAX
            } else {
                selected.frame
            });
            reasons.push(
                if compatible && reason == Reason::VisibleWitness && selected.rank < 3 {
                    Reason::SingleObservation
                } else {
                    reason
                },
            );
        }
        BlockResolution {
            kind: self.kind(),
            rgba,
            sources,
            reasons,
        }
    }
}
/// Bounded, exact observable-state comparison across corroboration. Internal support counters may
/// grow without changing pixels, source frames, reasons or component classification.
pub struct SelectionSnapshot(Vec<(u16, BlockResolution)>);
impl SelectionSnapshot {
    pub fn matches(&self, analysis: &TileAnalysis) -> bool {
        self.0.len() == analysis.blocks.len()
            && self.0.iter().all(|(block, selected)| {
                analysis
                    .blocks
                    .get(block)
                    .is_some_and(|b| b.resolution() == *selected)
            })
    }
}
impl TileAnalysis {
    pub fn selection(&self) -> SelectionSnapshot {
        SelectionSnapshot(
            self.blocks
                .iter()
                .map(|(&block, b)| (block, b.resolution()))
                .collect(),
        )
    }

    pub fn new(size: usize, tx: i32, ty: i32, noise: u8) -> Self {
        Self {
            size,
            tx,
            ty,
            noise,
            blocks: BTreeMap::new(),
        }
    }
    pub fn corroborate(&mut self, entries: &[SpillEntry]) {
        for entry in entries {
            if let Some(block) = self.blocks.get_mut(&entry.block) {
                block.corroborate(&entry.candidate, self.noise);
            }
        }
    }
    pub fn needs_refutation(&self) -> bool {
        self.blocks.values().any(BlockAnalysis::needs_refutation)
    }
    pub fn refute(&mut self, entries: &[SpillEntry]) -> usize {
        let mut changed = 0;
        for e in entries {
            if let Some(b) = self.blocks.get_mut(&e.block) {
                changed += b.refute(&e.candidate, self.noise);
            }
        }
        changed
    }
    pub fn copy_baseline(&mut self, other: &Self) {
        for (&block, b) in &other.blocks {
            if b.baseline.is_empty() {
                continue;
            }
            let next = self.blocks.entry(block).or_default();
            next.last = None;
            next.baseline = b
                .baseline
                .iter()
                .map(|p| PixelChoice {
                    rgba: p.rgba,
                    ..PixelChoice::default()
                })
                .collect();
            next.baseline_coverage = b.baseline_coverage.clone();
            next.refutations = b.refutations.clone();
        }
    }
    pub fn baseline_tile(
        &mut self,
        history: &TileHistory,
        size: usize,
        tx: i32,
        ty: i32,
        rgba: &[u8],
        coverage: &[u8],
    ) {
        let n = self.size / SIDE;
        for (&block, h) in &history.blocks {
            if h.resident.is_empty() {
                continue;
            }
            let bx =
                self.tx * self.size as i32 + (block as usize % n * SIDE) as i32 - tx * size as i32;
            let by =
                self.ty * self.size as i32 + (block as usize / n * SIDE) as i32 - ty * size as i32;
            let b = self.blocks.entry(block).or_default();
            b.last = None;
            if b.baseline.is_empty() {
                b.baseline.resize(PIXELS, PixelChoice::default());
                b.baseline_coverage.resize(PIXELS, false);
            }
            for y in 0..SIDE {
                for x in 0..SIDE {
                    let (dx, dy) = (bx + x as i32, by + y as i32);
                    if dx < 0 || dy < 0 || dx >= size as i32 || dy >= size as i32 {
                        continue;
                    }
                    let p = dy as usize * size + dx as usize;
                    let i = y * SIDE + x;
                    b.baseline[i].rgba = rgba[p * 4..p * 4 + 4].try_into().unwrap();
                    b.baseline_coverage[i] = coverage[p / 8] & (1 << (p & 7)) != 0;
                }
            }
        }
    }
    pub fn feed_page(&mut self, entries: &[SpillEntry], page: i32) {
        for (i, e) in entries.iter().enumerate() {
            self.blocks
                .entry(e.block)
                .or_default()
                .feed(&e.candidate, self.noise, page, i as u32);
        }
    }
    pub fn feed_state(&mut self, state: &TileHistory) {
        let mut entry = 0;
        for (&block, h) in &state.blocks {
            for c in &h.resident {
                self.blocks
                    .entry(block)
                    .or_default()
                    .feed(c, self.noise, -1, entry);
                entry += 1;
            }
        }
    }
    pub fn summaries(&self) -> Vec<BlockSummary> {
        let n = self.size / SIDE;
        self.blocks
            .iter()
            .map(|(&block, b)| BlockSummary {
                block,
                x: self.tx * n as i32 + (block as usize % n) as i32,
                y: self.ty * n as i32 + (block as usize / n) as i32,
                kind: b.kind(),
                candidates: b.candidates,
                expected: b
                    .pixels
                    .iter()
                    .enumerate()
                    .filter(|(i, p)| {
                        b.baseline_coverage.get(*i) == Some(&true) || p.rank > 0 && !p.context
                    })
                    .count() as u16,
                options: if b.kind() == ContentKind::Static {
                    Vec::new()
                } else {
                    b.options.clone()
                },
            })
            .collect()
    }
    pub fn take_options(&mut self) -> BTreeMap<u16, Vec<EpochOption>> {
        self.blocks
            .iter_mut()
            .filter_map(|(&id, b)| {
                if b.options.is_empty() {
                    None
                } else {
                    Some((id, std::mem::take(&mut b.options)))
                }
            })
            .collect()
    }
    pub fn select(
        &mut self,
        block: u16,
        candidate: Option<&Candidate>,
        frame: u32,
        component: u32,
        complete: bool,
    ) {
        let Some(b) = self.blocks.get_mut(&block) else {
            return;
        };
        b.epoch = Some(frame);
        b.component = Some(component);
        b.complete = complete;
        b.last = None;
        b.pixels.clear();
        b.pixels.resize(PIXELS, PixelChoice::default());
        if let Some(c) = candidate {
            for (i, p) in b.pixels.iter_mut().enumerate() {
                if c.visibility[i] == Visibility::Outside {
                    continue;
                }
                p.rgba = c.rgba[i * 4..i * 4 + 4].try_into().unwrap();
                p.frame = c.frame;
                p.rank = rank(c.visibility[i]);
                p.context = c.visibility[i].is_context();
                p.quality = c.quality;
                p.footprints = exposures(c);
                p.positions = position_support(c);
            }
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, postcard::Error> {
        archive::encode(&(1u32, self))
    }
    pub fn decode(data: &[u8]) -> Result<Self, postcard::Error> {
        let (v, t): (u32, Self) = archive::decode(data)?;
        if v != 1 {
            return Err(postcard::Error::DeserializeBadEncoding);
        }
        Ok(t)
    }
}

#[cfg(test)]
mod uniform_tests {
    use super::*;
    #[test]
    fn repeated_observations_keep_epochs_and_reconsider_earlier_or_changed_sources() {
        let mut fast = BlockAnalysis::default();
        let mut scalar = BlockAnalysis::default();
        let pixels: Vec<_> = (0..PIXELS).flat_map(|i| [i as u8, 40, 90, 255]).collect();
        for (at, frame) in [20, 21, 22, 1, 23, 24, 25, 26].into_iter().enumerate() {
            let mut c = Candidate::new(
                frame,
                frame as f64,
                0,
                0,
                pixels.clone(),
                vec![Visibility::Visible; PIXELS],
                90,
            );
            c.exposures.push(Exposure {
                x: 0,
                y: 0,
                visibility: 1,
            });
            if at == 4 {
                c.visibility[255] = Visibility::Occluded;
            }
            if at == 6 {
                c.rgba[0] += 1;
            }
            if at == 7 {
                fast.set_baseline(&pixels, &vec![true; PIXELS]);
                scalar.set_baseline(&pixels, &vec![true; PIXELS]);
            }
            fast.feed(&c, 2, 3, at as u32);
            scalar.feed_inner(&c, 2, 3, at as u32, false);
            assert_eq!(
                postcard::to_allocvec(&fast).unwrap(),
                postcard::to_allocvec(&scalar).unwrap()
            );
        }
    }
    // The fast path must agree with independent per-pixel execution. Include changing ranks,
    // baseline support, refuted colours, clipped coverage and a single unlike edge pixel.
    #[test]
    fn repeated_observations_recheck_a_changed_noise_parameter() {
        let mut fast = BlockAnalysis::default();
        let mut scalar = BlockAnalysis::default();
        let mut c = Candidate::new(
            0,
            0.,
            0,
            0,
            [50, 50, 50, 255].repeat(PIXELS),
            vec![Visibility::Visible; PIXELS],
            100,
        );
        fast.feed(&c, 2, 0, 0);
        scalar.feed_inner(&c, 2, 0, 0, false);
        c.rgba[0] += 1;
        c.frame = 1;
        c.quality = 90;
        for noise in [2, 0] {
            fast.feed(&c, noise, 0, 1);
            scalar.feed_inner(&c, noise, 0, 1, false);
            assert_eq!(
                postcard::to_allocvec(&fast).unwrap(),
                postcard::to_allocvec(&scalar).unwrap()
            );
        }
    }

    #[test]
    fn selection_snapshot_checks_pixels_provenance_reasons_and_block_membership() {
        let mut analysis = TileAnalysis::new(16, 0, 0, 0);
        analysis.blocks.insert(
            0,
            BlockAnalysis {
                pixels: vec![
                    PixelChoice {
                        rgba: [30, 40, 50, 255],
                        rank: 3,
                        frame: 7,
                        ..PixelChoice::default()
                    };
                    PIXELS
                ],
                ..BlockAnalysis::default()
            },
        );
        let snapshot = analysis.selection();
        assert!(snapshot.matches(&analysis));
        analysis.blocks.get_mut(&0).unwrap().pixels[255].positions = 8;
        assert!(snapshot.matches(&analysis));
        for field in 0..3 {
            let pixel = &mut analysis.blocks.get_mut(&0).unwrap().pixels[255];
            let old = *pixel;
            match field {
                0 => pixel.rgba[0] += 1,
                1 => pixel.frame += 1,
                _ => pixel.rank = 2,
            }
            assert!(!snapshot.matches(&analysis));
            analysis.blocks.get_mut(&0).unwrap().pixels[255] = old;
        }
        analysis.blocks.clear();
        assert!(!snapshot.matches(&analysis));
    }

    #[test]
    fn uniform_selection_matches_per_pixel_execution() {
        let states = [
            Visibility::Unknown,
            Visibility::Visible,
            Visibility::Background,
            Visibility::Occluded,
            Visibility::Context,
            Visibility::Outside,
        ];
        for perturbation in 0..5 {
            let mut fast = BlockAnalysis::default();
            let mut scalar = BlockAnalysis::default();
            let mut baseline = [70, 70, 70, 255].repeat(PIXELS);
            let mut coverage = vec![true; PIXELS];
            if perturbation == 1 {
                baseline[PIXELS * 4 - 4] = 71;
            }
            if perturbation == 2 {
                coverage[PIXELS - 1] = false;
            }
            fast.set_baseline(&baseline, &coverage);
            scalar.set_baseline(&baseline, &coverage);
            for frame in 0..36 {
                let colour = [70, 70, 71, 100, 30, 71][frame % 6];
                let mut c = Candidate::new(
                    frame as u32,
                    frame as f64,
                    frame as i32 * 16,
                    0,
                    [colour, colour, colour, 255].repeat(PIXELS),
                    vec![states[frame % states.len()]; PIXELS],
                    100 - frame as u16,
                );
                c.exposures.push(Exposure {
                    x: frame as i32,
                    y: 0,
                    visibility: frame as u32,
                });
                if perturbation == 3 {
                    c.rgba[PIXELS * 4 - 4] = colour + 1;
                }
                if perturbation == 4 {
                    c.visibility[PIXELS - 1] = Visibility::Outside;
                }
                if frame == 12 {
                    fast.refutations = vec![Some([100, 100, 100, 255]); PIXELS];
                    scalar.refutations = fast.refutations.clone();
                }
                fast.feed(&c, 2, 0, frame as u32);
                scalar.feed_inner(&c, 2, 0, frame as u32, false);
                assert_eq!(
                    postcard::to_allocvec(&fast).unwrap(),
                    postcard::to_allocvec(&scalar).unwrap()
                );
            }
        }
    }
}
