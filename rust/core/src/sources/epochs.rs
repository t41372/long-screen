use super::analysis::EpochOption;
use super::scene::EpochSweep;
use super::*;

/// Uses the same interval sweep as the disk-backed component solver. Completeness means all
/// observed pixels of each block, including narrow panes and partial viewport boundary blocks.
pub fn choose_component_epoch(blocks: &[Vec<Candidate>], policy: TemporalPolicy) -> EpochChoice {
    let mut sweep = EpochSweep::default();
    for cs in blocks {
        let expected = (0..PIXELS)
            .filter(|&i| cs.iter().any(|c| c.visibility[i] != Visibility::Outside))
            .count() as u16;
        let options: Vec<_> = cs
            .iter()
            .enumerate()
            .map(|(i, c)| EpochOption {
                page: -1,
                entry: i as u32,
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
                    .filter(|v| **v != Visibility::Outside)
                    .count() as u16,
                quality: c.quality,
            })
            .collect();
        sweep.add(expected, &options);
    }
    let result = sweep.choose(policy);
    EpochChoice {
        frame: result.frame,
        complete: result.complete,
        missing_blocks: blocks
            .iter()
            .enumerate()
            .filter(|(_, cs)| result.frame.is_none_or(|f| at_epoch(cs, f).is_none()))
            .map(|(i, _)| i)
            .collect(),
    }
}
pub fn at_epoch(candidates: &[Candidate], frame: u32) -> Option<&Candidate> {
    candidates
        .iter()
        .filter(|c| c.contains_frame(frame))
        .max_by_key(|c| {
            (
                c.visibility
                    .iter()
                    .filter(|v| **v == Visibility::Visible)
                    .count(),
                c.visibility
                    .iter()
                    .filter(|v| **v != Visibility::Outside)
                    .count(),
                c.quality,
            )
        })
}
