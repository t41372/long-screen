use super::*;

/// The same streaming accumulator used for archive pages; this convenience entry point is useful
/// when a caller already owns a small block history. It does not define a second selection algorithm.
pub fn resolve_block(candidates: &[Candidate], noise: u8) -> BlockResolution {
    let mut block = analysis::BlockAnalysis::default();
    for (i, c) in candidates.iter().enumerate() {
        block.feed(c, noise, -1, i as u32);
    }
    block.resolution()
}
