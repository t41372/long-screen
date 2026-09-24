/** Pyramid parent-tile assembly (mirrors `rust/core/src/abi/pyramid.rs`): halves up to four `size × size` RGBA
 *  child tiles and packs them into one parent tile in a single core call, replacing the per-quadrant
 *  halve+copy loop `TileStore.buildPyramid` (src/storage/tiles.ts) used to run in TS. */
import type { RGBA } from '../../types.ts';
import type { Core } from './core.ts';

/** `children[i]` is quadrant `i` (`dx = i & 1`, `dy = i >> 1`, row-major over the 2×2 grid); `undefined` means
 *  that child tile was never observed and its quadrant comes back zeroed. */
export function assemblePyramidParent(core: Core, children: (Uint8ClampedArray | undefined)[], size: number): RGBA {
  const bytes = size * size * 4;
  const scratchSizes = children.map((c) => (c ? bytes : 0));
  scratchSizes.push(bytes);
  const ptrs = core.scratch(scratchSizes);
  const out = ptrs[4];
  let present = 0;
  for (let i = 0; i < 4; i++) {
    const child = children[i];
    if (child) {
      core.writeBytes(ptrs[i], child);
      present |= 1 << i;
    }
  }
  core.check(
    core.exports.ls_assemble_pyramid_parent(ptrs[0], ptrs[1], ptrs[2], ptrs[3], present, size, out),
    'assemblePyramidParent',
  );
  return { width: size, height: size, data: new Uint8ClampedArray(core.readBytes(out, bytes).buffer) };
}
