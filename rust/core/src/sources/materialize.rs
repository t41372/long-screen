//! Copy selected observations into the ordinary tile. Decisions and byte/bit traversal stay native;
//! the caller owns tile persistence and canvas counters.
use super::{analysis::TileAnalysis, Reason, SIDE};
use serde::Serialize;
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub added: i64,
    pub provisional: i64,
    pub changed: usize,
    pub reasons: [usize; 7],
}
pub struct TargetTile<'a> {
    pub size: usize,
    pub x: i32,
    pub y: i32,
    pub rgba: &'a mut [u8],
    pub coverage: &'a mut [u8],
    pub provisional: &'a mut [u8],
    pub owner: &'a mut [u32],
}
impl TileAnalysis {
    pub fn apply(&self, tile: TargetTile<'_>) -> Applied {
        let TargetTile {
            size,
            x: tx,
            y: ty,
            rgba,
            coverage,
            provisional,
            owner,
        } = tile;
        let mut out = Applied::default();
        let n = self.size / SIDE;
        for (&block, analysis) in &self.blocks {
            let bx =
                self.tx * self.size as i32 + (block as usize % n * SIDE) as i32 - tx * size as i32;
            let by =
                self.ty * self.size as i32 + (block as usize / n * SIDE) as i32 - ty * size as i32;
            let result = analysis.resolution();
            for y in 0..SIDE {
                for x in 0..SIDE {
                    let (dx, dy) = (bx + x as i32, by + y as i32);
                    if dx < 0 || dy < 0 || dx >= size as i32 || dy >= size as i32 {
                        continue;
                    }
                    let i = y * SIDE + x;
                    let p = dy as usize * size + dx as usize;
                    let bit = 1 << (p & 7);
                    let byte = p / 8;
                    let reason = result.reasons[i];
                    out.reasons[reason as usize] += 1;
                    // Unobserved halo pixels are not a reason to erase the initial reconstruction.
                    // Only a selected dynamic epoch can establish that this part is missing in that state.
                    if reason == Reason::Unobserved && analysis.epoch.is_none() {
                        continue;
                    }
                    let present = reason != Reason::Unobserved
                        && (!matches!(reason, Reason::NoCleanSource | Reason::ContextSource)
                            || coverage[byte] & bit != 0);
                    let source = &result.rgba[i * 4..i * 4 + 4];
                    let unchanged = rgba[p * 4..p * 4 + 4] == *source;
                    // `provisional` remains the existing compositor's world-consistency plane. New
                    // source uncertainty is always persisted in the separate per-pixel reason plane;
                    // an unresolved classification alone does not rewrite unchanged legacy evidence.
                    let uncertain = present
                        && matches!(
                            reason,
                            Reason::Ambiguous
                                | Reason::NoCleanSource
                                | Reason::DynamicPartial
                                | Reason::ContextSource
                        )
                        && (!unchanged || provisional[byte] & bit != 0);
                    out.added += present as i64 - ((coverage[byte] & bit) != 0) as i64;
                    out.provisional += uncertain as i64 - ((provisional[byte] & bit) != 0) as i64;
                    if rgba[p * 4..p * 4 + 4] != *source {
                        out.changed += 1;
                    }
                    if present {
                        rgba[p * 4..p * 4 + 4].copy_from_slice(source);
                    } else {
                        rgba[p * 4..p * 4 + 4].fill(0);
                    }
                    if present {
                        coverage[byte] |= bit;
                    } else {
                        coverage[byte] &= !bit;
                    }
                    if uncertain {
                        provisional[byte] |= bit;
                    } else {
                        provisional[byte] &= !bit;
                    }
                    owner[dy as usize / SIDE * (size / SIDE) + dx as usize / SIDE] =
                        result.sources[i].wrapping_add(1);
                }
            }
        }
        out
    }
}

#[derive(Serialize)]
pub struct Shard {
    pub x: i32,
    pub y: i32,
    pub disputes: Vec<u8>,
}
pub fn shards(size: usize, tx: i32, ty: i32, side: usize, disputes: &[u8]) -> Vec<Shard> {
    let mut out = std::collections::BTreeMap::<(i32, i32), Vec<u8>>::new();
    let n = size / SIDE;
    let m = side / SIDE;
    for (i, &v) in disputes.iter().enumerate().filter(|(_, v)| **v != 0) {
        let x = tx * n as i32 + (i % n) as i32;
        let y = ty * n as i32 + (i / n) as i32;
        // Include the ring across physical tile boundaries too. Storage tiles do not define components.
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (x, y) = (x + dx, y + dy);
                let key = (x.div_euclid(m as i32), y.div_euclid(m as i32));
                out.entry(key).or_insert_with(|| vec![0; m * m])
                    [y.rem_euclid(m as i32) as usize * m + x.rem_euclid(m as i32) as usize] |= v;
            }
        }
    }
    out.into_iter()
        .map(|((x, y), disputes)| Shard { x, y, disputes })
        .collect()
}
