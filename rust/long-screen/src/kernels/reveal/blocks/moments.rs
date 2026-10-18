//! Join neighbouring dynamic groups only after witnessing a complete, compatible
//! observation of both. An unchanged bridge can separate the changing ends of one
//! widget; independently choosing their moments can invent a stretched widget.
//!
//! Growing every context ring before grouping has the opposite failure: roads and
//! labels become a group that no frame ever covers. A witnessed join has a complete
//! source now, and the ordinary component ranking keeps it complete afterwards.
use super::{
    compare, contradicts, settled, view, Component, Consensus, MomentRank, Output, BLOCK, CELLS,
    CENTRAL,
};
use crate::kernels::reveal::locate::TierMap;
use crate::kernels::reveal::{Footprint, Frame, TIER_CLEAN, TIER_VEIL};

// A union must not turn sparse membership into an arbitrarily large dense mask.
// The two masks then occupy at most 16 bytes per owned block. This scratch and
// component metadata fit the held-pixel allowance reserved for those blocks;
// component-owned blocks do not allocate a held static view.
const MAX_MASK_AREA_PER_BLOCK: usize = 8;

#[derive(Clone, Copy)]
pub(super) struct View<'a> {
    pub frame: &'a Frame<'a>,
    pub previous: Option<&'a Frame<'a>>,
    pub footprint: &'a Footprint<'a>,
    pub tiers: &'a TierMap<'a>,
    pub pose: (i64, i64),
    pub tau: i32,
    pub index: u32,
}

fn witness(component: &Component, consensus: &Consensus, input: &View<'_>) -> Option<MomentRank> {
    let View {
        frame,
        previous,
        footprint,
        tiers,
        pose,
        tau,
        index,
    } = *input;
    let grid = consensus.grid;
    let (x, y) = grid.origin(component.by * grid.bw + component.bx);
    let margins = [
        x - footprint.x - pose.0,
        y - footprint.y - pose.1,
        footprint.x + pose.0 + footprint.width as i64 - x - (component.bw * BLOCK) as i64,
        footprint.y + pose.1 + footprint.height as i64 - y - (component.bh * BLOCK) as i64,
    ];
    let inset = *margins.iter().min().unwrap();
    if inset < 0 {
        return None;
    }
    let mut signature = [[0u8; 3]; CELLS];
    let (mut tier, mut dynamic_index, mut compared, mut stable) = (TIER_CLEAN, 0, 0, true);
    for y in 0..component.bh {
        for x in 0..component.bw {
            let local = y * component.bw + x;
            if !component.mask[local] {
                continue;
            }
            let block = (component.by + y) * grid.bw + component.bx + x;
            let (wx, wy) = grid.origin(block);
            let observed = view(frame, footprint, tiers, pose, wx, wy, &mut signature)?;
            if observed < TIER_VEIL {
                return None;
            }
            tier = tier.min(observed);
            if !component.dynamic[local] {
                // As in emit: a cleaner relearned view is not contradicted by a weaker first-pass reference.
                if observed as i8 <= consensus.vote[block].tier
                    && contradicts(
                        &signature,
                        &consensus.sig[block * CELLS..(block + 1) * CELLS],
                        tau,
                        || settled(&signature, previous, footprint, tiers, pose, wx, wy, tau),
                    )
                {
                    return None;
                }
                continue;
            }
            let mut prior = [[0u8; 3]; CELLS];
            let reference = if let Some(before) = previous {
                view(before, footprint, tiers, pose, wx, wy, &mut prior).map(|_| &prior)
            } else {
                component.last_complete.get(dynamic_index)
            };
            if let Some(reference) = reference {
                let difference = compare(&signature, reference);
                compared += 1;
                stable &= difference.0 <= tau as u32 && difference.1 <= tau as u32;
            }
            dynamic_index += 1;
        }
    }
    let confirmed = compared > 0 && compared == dynamic_index && stable;
    let rank = MomentRank {
        complete: true,
        untainted: true,
        tier,
        corroborated: confirmed,
        interior: confirmed && inset >= CENTRAL,
        preference: index as usize,
    };
    // Joining is not a new opportunity to forget an established stronger moment.
    component
        .best
        .is_none_or(|best| best <= rank)
        .then_some(rank)
}

fn root(parents: &[usize], mut id: usize) -> usize {
    while parents[id] != id {
        id = parents[id];
    }
    id
}

/// The union owns exactly the original masks, including their uniquely assigned
/// context. No unobserved gap inside the bounding rectangle becomes owned.
fn join(
    parts: &[usize],
    old: &[Option<Component>],
    witnesses: &[Option<MomentRank>],
) -> Option<Component> {
    let part = |id: usize| old[id].as_ref().unwrap();
    // The first observation has no member history to lose. Once members have
    // chosen moments, a weaker member must not dilute another's evidence rank.
    if parts.iter().any(|&id| part(id).best.is_some())
        && parts.iter().any(|&id| witnesses[id] != witnesses[parts[0]])
    {
        return None;
    }

    let x0 = parts.iter().map(|&id| part(id).bx).min()?;
    let y0 = parts.iter().map(|&id| part(id).by).min()?;
    let x1 = parts.iter().map(|&id| part(id).bx + part(id).bw).max()?;
    let y1 = parts.iter().map(|&id| part(id).by + part(id).bh).max()?;
    let (width, height) = (x1 - x0, y1 - y0);
    let owned: usize = parts
        .iter()
        .map(|&id| part(id).mask.iter().filter(|&&set| set).count())
        .sum();
    if width * height > MAX_MASK_AREA_PER_BLOCK * owned {
        return None;
    }
    let mut mask = vec![false; width * height];
    let mut dynamic = vec![false; width * height];
    let mut prior = Vec::new();
    let mut have_history = true;
    for &id in parts {
        let p = part(id);
        let mut dynamic_index = 0;
        for y in 0..p.bh {
            for x in 0..p.bw {
                let source = y * p.bw + x;
                let target = (p.by + y - y0) * width + p.bx + x - x0;
                mask[target] |= p.mask[source];
                dynamic[target] |= p.dynamic[source];
                if p.dynamic[source] {
                    if let Some(signature) = p.last_complete.get(dynamic_index) {
                        prior.push((target, signature));
                    } else {
                        have_history = false;
                    }
                    dynamic_index += 1;
                }
            }
        }
    }
    // Preserve the compatible per-block witnesses until emit replaces them with
    // this actual complete observation. Dropping them would lose corroboration
    // again immediately after the join and admit the next single-frame pulse.
    let last_complete = if have_history {
        prior.sort_unstable_by_key(|(index, _)| *index);
        prior.into_iter().map(|(_, signature)| *signature).collect()
    } else {
        Vec::new()
    };
    Some(Component {
        bx: x0,
        by: y0,
        bw: width,
        bh: height,
        mask,
        dynamic,
        // The current, complete observation replaces all members together in emit.
        // Independent previous ranks are not evidence of a shared prior moment.
        best: None,
        last_complete,
    })
}

impl Output {
    pub(super) fn coobserve(&mut self, consensus: &Consensus, input: &View<'_>) {
        let count = self.components.len();
        if count < 2 {
            return;
        }
        let eligible: Vec<Option<MomentRank>> = self
            .components
            .iter()
            .map(|part| witness(part, consensus, input))
            .collect();
        let grid = consensus.grid;
        let mut parents: Vec<usize> = (0..count).collect();
        let mut merged = false;
        for y in 0..grid.bh {
            for x in 0..grid.bw {
                let id = self.component[y * grid.bw + x];
                if id < 0 || eligible[id as usize].is_none() {
                    continue;
                }
                // Each undirected edge of the eight-neighbour grid, once.
                for (nx, ny) in [
                    (x + 1, y),
                    (x.wrapping_sub(1), y + 1),
                    (x, y + 1),
                    (x + 1, y + 1),
                ] {
                    if nx >= grid.bw || ny >= grid.bh {
                        continue;
                    }
                    let other = self.component[ny * grid.bw + nx];
                    if other < 0 || other == id || eligible[other as usize].is_none() {
                        continue;
                    }
                    let (a, b) = (root(&parents, id as usize), root(&parents, other as usize));
                    if a != b {
                        parents[b] = a;
                        merged = true;
                    }
                }
            }
        }
        if !merged {
            return;
        }
        let mut members = vec![Vec::new(); count];
        for id in 0..count {
            members[root(&parents, id)].push(id);
        }
        let mut old: Vec<_> = std::mem::take(&mut self.components)
            .into_iter()
            .map(Some)
            .collect();
        let mut next = Vec::with_capacity(count);
        for ids in members.into_iter().filter(|ids| !ids.is_empty()) {
            let combined = (ids.len() > 1)
                .then(|| join(&ids, &old, &eligible))
                .flatten();
            if let Some(combined) = combined {
                next.push(combined);
                for id in ids {
                    old[id] = None;
                }
            } else {
                next.extend(ids.into_iter().map(|id| old[id].take().unwrap()));
            }
        }
        self.components = next;
        self.component.fill(-1);
        for (id, part) in self.components.iter().enumerate() {
            for y in 0..part.bh {
                for x in 0..part.bw {
                    if part.mask[y * part.bw + x] {
                        self.component[(part.by + y) * grid.bw + part.bx + x] = id as i32;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernels::reveal::blocks::{components, Grid};
    use crate::kernels::reveal::{TIER_CLEAN, TIER_OPAQUE};

    const WIDTH: usize = 128;
    const HEIGHT: usize = 64;

    fn scene() -> (Consensus, Output, Vec<u8>) {
        let mut consensus = Consensus::new(Grid::covering(0, 0, WIDTH, HEIGHT));
        consensus.sig.fill([80; 3]);
        for vote in &mut consensus.vote {
            vote.tier = TIER_CLEAN as i8;
            vote.clean_views = 4;
        }
        for block in [10, 12] {
            consensus.vote[block].changed_views = 4;
        }
        let output = Output::new(&consensus, components(&consensus));
        assert_eq!(output.components.len(), 2);
        (consensus, output, vec![80; WIDTH * HEIGHT * 4])
    }

    // Failure cases: touching context without a simultaneous observation; an
    // occlusion or contradictory static boundary mistaken for a complete witness;
    // claiming the unobserved gap when two real moments are coordinated.
    #[test]
    fn touching_context_requires_a_complete_admitted_observation() {
        for failure in ["partial", "hole", "opaque", "contradicted"] {
            let (consensus, mut output, mut rgba) = scene();
            let mut mask = vec![1; WIDTH * HEIGHT];
            let mut tier = vec![TIER_CLEAN; WIDTH * HEIGHT / 4];
            match failure {
                "hole" => mask[16 * WIDTH + 16] = 0,
                "opaque" => tier[8 * (WIDTH / 2) + 8] = TIER_OPAQUE,
                "contradicted" => {
                    // Signatures average 2×2 native pixels. Change a whole cell so
                    // this is contradictory structure, not sub-threshold noise.
                    for y in 16..18 {
                        for x in 16..18 {
                            rgba[(y * WIDTH + x) * 4..(y * WIDTH + x) * 4 + 3].fill(255);
                        }
                    }
                }
                _ => {}
            }
            let footprint = Footprint {
                x: 0,
                y: 0,
                width: if failure == "partial" { 64 } else { WIDTH },
                height: HEIGHT,
                mask: &mask,
            };
            let frame = Frame {
                rgba: &rgba,
                width: WIDTH,
                height: HEIGHT,
            };
            let tiers = TierMap {
                x: 0,
                y: 0,
                cw: WIDTH / 2,
                ch: HEIGHT / 2,
                tier: &tier,
            };
            output.coobserve(
                &consensus,
                &View {
                    frame: &frame,
                    previous: None,
                    footprint: &footprint,
                    tiers: &tiers,
                    pose: (0, 0),
                    tau: 24,
                    index: 0,
                },
            );
            assert_eq!(
                output.components.len(),
                2,
                "{failure} is not a joint moment"
            );
        }
    }

    // Failure case: a weaker first-pass context reference (veil residue) vetoes the
    // cleaner joint observation that emit itself would rank as untainted.
    #[test]
    fn a_weaker_context_reference_does_not_veto_a_cleaner_joint_view() {
        let (mut consensus, mut output, rgba) = scene();
        // Block 11 is the static bridge between the changing blocks 10 and 12.
        consensus.vote[11].tier = TIER_VEIL as i8;
        consensus.sig[11 * CELLS..12 * CELLS].fill([200; 3]);
        let mask = vec![1; WIDTH * HEIGHT];
        let tier = vec![TIER_CLEAN; WIDTH * HEIGHT / 4];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width: WIDTH,
            height: HEIGHT,
            mask: &mask,
        };
        let frame = Frame {
            rgba: &rgba,
            width: WIDTH,
            height: HEIGHT,
        };
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: WIDTH / 2,
            ch: HEIGHT / 2,
            tier: &tier,
        };
        output.coobserve(
            &consensus,
            &View {
                frame: &frame,
                previous: None,
                footprint: &footprint,
                tiers: &tiers,
                pose: (0, 0),
                tau: 24,
                index: 0,
            },
        );
        assert_eq!(output.components.len(), 1);
    }

    #[test]
    fn a_joint_observation_keeps_exactly_the_previously_owned_blocks() {
        let (consensus, mut output, rgba) = scene();
        let owned: Vec<bool> = output.component.iter().map(|&owner| owner >= 0).collect();
        let mask = vec![1; WIDTH * HEIGHT];
        let tier = vec![TIER_CLEAN; WIDTH * HEIGHT / 4];
        let footprint = Footprint {
            x: 0,
            y: 0,
            width: WIDTH,
            height: HEIGHT,
            mask: &mask,
        };
        let frame = Frame {
            rgba: &rgba,
            width: WIDTH,
            height: HEIGHT,
        };
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: WIDTH / 2,
            ch: HEIGHT / 2,
            tier: &tier,
        };
        output.coobserve(
            &consensus,
            &View {
                frame: &frame,
                previous: None,
                footprint: &footprint,
                tiers: &tiers,
                pose: (0, 0),
                tau: 24,
                index: 0,
            },
        );
        assert_eq!(output.components.len(), 1);
        assert_eq!(
            output
                .component
                .iter()
                .map(|&owner| owner >= 0)
                .collect::<Vec<_>>(),
            owned
        );
        assert!(
            output.components[0].best.is_none(),
            "the current complete frame must replace independent moments together"
        );
    }
    #[test]
    fn a_late_joint_view_keeps_temporal_evidence_before_and_after_joining() {
        use crate::kernels::reveal::stats::CellMap;
        let (consensus, mut output, base) = scene();
        let tier = vec![TIER_CLEAN; WIDTH * HEIGHT / 4];
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: WIDTH / 2,
            ch: HEIGHT / 2,
            tier: &tier,
        };
        let main = CellMap::covering(0, 0, WIDTH, HEIGHT);
        for index in 0..7u32 {
            let pose = (index as i64, 0);
            let mut mask = vec![1; WIDTH * HEIGHT];
            // The parts first have separate, twice-observed stable moments.
            // A moving obstruction then leaves both visible in the same frame.
            for y in 0..HEIGHT {
                for x in 0..WIDTH {
                    let wx = x as i64 + pose.0;
                    if (index < 2 && wx >= 64) || ((2..4).contains(&index) && wx < 64) {
                        mask[y * WIDTH + x] = 0;
                    }
                }
            }
            let footprint = Footprint {
                x: 0,
                y: 0,
                width: WIDTH,
                height: HEIGHT,
                mask: &mask,
            };
            let mut rgba = base.clone();
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
            if index >= 4 {
                // White is initially a single pulse, then a corroborated update;
                // the final black frame is a second, unsupported pulse.
                let colour = if index == 6 { 0 } else { 255 };
                for y in 16..32 {
                    for wx in 32..48 {
                        let x = wx - index as usize;
                        rgba[(y * WIDTH + x) * 4..(y * WIDTH + x) * 4 + 3].fill(colour);
                    }
                }
            }
            let frame = Frame {
                rgba: &rgba,
                width: WIDTH,
                height: HEIGHT,
            };
            output.emit(
                &consensus,
                &frame,
                None,
                &footprint,
                &tiers,
                pose,
                24,
                index,
                &main,
                &mut Vec::new(),
            );
            if index == 4 {
                assert!(
                    [0, 1].contains(&output.frame[10]),
                    "the first common view cannot promote a pulse over an established moment"
                );
            }
            if index >= 5 {
                assert!(
                    [4, 5].contains(&output.frame[10]),
                    "a confirmed update survives both the join and the next single-frame pulse"
                );
            }
        }
    }
    #[test]
    fn later_joins_use_the_current_component_ownership() {
        use crate::kernels::reveal::stats::CellMap;
        let (width, height) = (160, 64);
        let mut consensus = Consensus::new(Grid::covering(0, 0, width, height));
        consensus.sig.fill([80; 3]);
        for vote in &mut consensus.vote {
            vote.tier = TIER_CLEAN as i8;
            vote.clean_views = 4;
        }
        for block in [11, 14, 17] {
            consensus.vote[block].changed_views = 4;
        }
        let mut output = Output::new(&consensus, components(&consensus));
        assert_eq!(output.components.len(), 3);
        let rgba = vec![80; width * height * 4];
        let frame = Frame {
            rgba: &rgba,
            width,
            height,
        };
        let tier = vec![TIER_CLEAN; width * height / 4];
        let tiers = TierMap {
            x: 0,
            y: 0,
            cw: width / 2,
            ch: height / 2,
            tier: &tier,
        };
        let main = CellMap::covering(0, 0, width, height);
        for index in 0..3u32 {
            let mut mask = vec![1; width * height];
            if index == 0 {
                for y in 0..height {
                    mask[y * width + 96..(y + 1) * width].fill(0);
                }
            }
            let footprint = Footprint {
                x: 0,
                y: 0,
                width,
                height,
                mask: &mask,
            };
            output.emit(
                &consensus,
                &frame,
                None,
                &footprint,
                &tiers,
                (-(index as i64), 0),
                24,
                index,
                &main,
                &mut Vec::new(),
            );
            assert_eq!(
                output.components.len(),
                if index < 2 { 2 } else { 1 },
                "a second join uses the remapped owners and corroborated history"
            );
        }
    }
}
