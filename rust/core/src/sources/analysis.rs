//! Streaming analysis of immutable candidate pages. Raw histories are not rehydrated together.
//! Pixel choices have fixed size; epoch metadata can be drained separately from the native payload.
use super::tile::{SpillEntry, TileHistory};
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
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
#[derive(Default, Serialize, Deserialize)]
pub struct BlockAnalysis {
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
        if self.pixels.is_empty() {
            self.pixels.resize(PIXELS, PixelChoice::default());
        }
        let footprint = exposures(c);
        let positions = position_support(c);
        let native = native_positions(c);
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
        for (i, old) in self.pixels.iter_mut().enumerate() {
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
impl TileAnalysis {
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
