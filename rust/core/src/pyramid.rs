//! Pyramid parent-tile assembly: four child tiles (2×2, possibly with holes where a child tile was never
//! observed) halved and packed into one `size × size` parent tile. The halving itself is `raster::halve_rgba`
//! (alpha-weighted 2:1 reduction); this module only adds the "which quadrant" bookkeeping `TileStore.buildPyramid`
//! (src/storage/tiles.ts) does in TS, one Rust call per parent instead of one per child.

use crate::raster::halve_rgba;

/// Halves each present child (`size × size` RGBA, quadrant order `[dx=0,dy=0]`, `[dx=1,dy=0]`, `[dx=0,dy=1]`,
/// `[dx=1,dy=1]` — i.e. row-major over the 2×2 grid) and copies it into its quadrant of `out` (`size × size`
/// RGBA). A missing child (`None`) leaves its quadrant zeroed, matching the all-zero starting point the frozen
/// TS reference (tests/unit/parity/pyramid.test.ts) uses for a parent tile and never touches for an absent child.
pub fn assemble_parent(children: [Option<&[u8]>; 4], size: usize, out: &mut [u8]) {
    let half = size / 2;
    let mut small = vec![0u8; half * half * 4];
    for (i, child) in children.into_iter().enumerate() {
        let (dx, dy) = (i % 2, i / 2);
        small.fill(0);
        if let Some(child) = child {
            halve_rgba(child, size, size, &mut small);
        }
        for r in 0..half {
            let dst = ((dy * half + r) * size + dx * half) * 4;
            out[dst..dst + half * 4].copy_from_slice(&small[r * half * 4..(r + 1) * half * 4]);
        }
    }
}
