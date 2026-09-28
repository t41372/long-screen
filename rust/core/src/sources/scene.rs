//! Connected dynamic components and a sweep over observed frame intervals. Pixel histories are
//! streamed separately; this index holds only world-block topology and source-availability metadata.
use super::analysis::{BlockSummary, EpochOption};
use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAddress {
    pub tx: i32,
    pub ty: i32,
    pub block: u16,
    pub x: i32,
    pub y: i32,
    pub expected: u16,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: u32,
    pub blocks: Vec<BlockAddress>,
}
#[derive(Default)]
pub struct Scene {
    blocks: BTreeMap<(i32, i32), BlockAddress>,
}
impl Scene {
    pub fn add(&mut self, tx: i32, ty: i32, summaries: &[BlockSummary]) {
        for s in summaries {
            if s.kind == ContentKind::Dynamic {
                self.blocks.insert(
                    (s.x, s.y),
                    BlockAddress {
                        tx,
                        ty,
                        block: s.block,
                        x: s.x,
                        y: s.y,
                        expected: s.expected,
                    },
                );
            }
        }
    }
    pub fn components(&self) -> Vec<Component> {
        let mut remaining: BTreeSet<_> = self.blocks.keys().copied().collect();
        let mut out = Vec::new();
        while let Some(seed) = remaining.pop_first() {
            let mut queue = VecDeque::from([seed]);
            let mut blocks = Vec::new();
            while let Some((x, y)) = queue.pop_front() {
                blocks.push(self.blocks[&(x, y)].clone());
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let point = (x + dx, y + dy);
                        if remaining.remove(&point) {
                            queue.push_back(point);
                        }
                    }
                }
            }
            out.push(Component {
                id: out.len() as u32,
                blocks,
            });
        }
        out
    }
}

#[derive(Default, Clone, Copy)]
struct Score {
    complete: i64,
    present: i64,
    visible: i64,
}
#[derive(Default)]
pub struct EpochSweep {
    events: BTreeMap<u32, Score>,
    pub blocks: usize,
    expected_pixels: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochSummary {
    pub frame: Option<u32>,
    pub complete: bool,
    pub complete_blocks: usize,
    pub visible_pixels: usize,
    pub present_pixels: usize,
}
impl EpochSweep {
    pub fn add(&mut self, expected: u16, options: &[EpochOption]) {
        self.blocks += 1;
        self.expected_pixels += expected as usize;
        self.add_options(expected, options);
    }
    pub fn add_options(&mut self, expected: u16, options: &[EpochOption]) {
        for option in options {
            let score = Score {
                complete: (option.visible == expected) as i64,
                present: option.present as i64,
                visible: option.visible as i64,
            };
            for span in &option.frames {
                let start = self.events.entry(span.first).or_default();
                start.complete += score.complete;
                start.present += score.present;
                start.visible += score.visible;
                if let Some(end) = span.last.checked_add(1) {
                    let stop = self.events.entry(end).or_default();
                    stop.complete -= score.complete;
                    stop.present -= score.present;
                    stop.visible -= score.visible;
                }
            }
        }
    }
    pub fn choose(&self, policy: TemporalPolicy) -> EpochSummary {
        let mut sum = Score::default();
        let mut best: Option<(u32, Score)> = None;
        let events: Vec<_> = self.events.iter().collect();
        for (i, (&frame, delta)) in events.iter().enumerate() {
            sum.complete += delta.complete;
            sum.present += delta.present;
            sum.visible += delta.visible;
            if sum.present == 0 {
                continue;
            }
            let at = match policy {
                TemporalPolicy::Stable => frame,
                TemporalPolicy::Latest => events.get(i + 1).map_or(frame, |(&next, _)| next - 1),
            };
            // Prefer an actual observation of the whole component before counting wholly clean
            // blocks. Otherwise one clean clipped block can erase content that another epoch did
            // observe. The selected epoch remains partial when its visibility is uncertain.
            let score = |s: Score| {
                (
                    s.present == self.expected_pixels as i64,
                    s.complete,
                    s.present,
                    s.visible,
                )
            };
            if best.is_none_or(|(f, s)| {
                score(sum) > score(s)
                    || (score(sum) == score(s)
                        && match policy {
                            TemporalPolicy::Stable => at < f,
                            TemporalPolicy::Latest => at > f,
                        })
            }) {
                best = Some((at, sum));
            }
        }
        let (frame, score) = best.map_or((None, Score::default()), |(f, s)| (Some(f), s));
        EpochSummary {
            frame,
            complete: score.complete == self.blocks as i64,
            complete_blocks: score.complete as usize,
            visible_pixels: score.visible as usize,
            present_pixels: score.present as usize,
        }
    }
}
