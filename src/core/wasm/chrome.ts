/** Persistent-chrome detection: stationary boundaries and sticky occlusion bands (mirrors
 *  `rust/core/src/abi/chrome.rs`). */
import type { Point, Rect } from '../../types.ts';
import type { Core } from './core.ts';
import { type FrameInput, ResidentFrame } from './memory.ts';

export function stationaryBoundary(
  core: Core,
  image: FrameInput,
  axis: 'x' | 'y',
  from: number,
  to: number,
  crossFrom: number,
  crossTo: number,
  choose: 'first' | 'last',
): number | undefined {
  const [scratch] = core.scratch([image instanceof ResidentFrame ? 0 : image.width * image.height * 4]);
  const rgba = core.placeFrame(image, scratch);
  const result = core.exports.ls_stationary_boundary(
    rgba,
    image.width,
    image.height,
    axis === 'x' ? 0 : 1,
    from,
    to,
    crossFrom,
    crossTo,
    choose === 'first' ? 0 : 1,
  );
  if (result <= -2) core.check(-1, 'stationaryBoundary');
  return result < 0 ? undefined : result;
}
export function stickyOcclusions(
  core: Core,
  previous: FrameInput,
  current: FrameInput,
  region: Rect,
  motion: Point,
  carry: Rect[],
): Rect[] {
  const bytes = current.width * current.height * 4, capacity = Math.max(carry.length, 1);
  const [pPrev, pCur, pRegion, pCarry, out] = core.scratch([
    previous instanceof ResidentFrame ? 0 : bytes,
    current instanceof ResidentFrame ? 0 : bytes,
    32,
    carry.length * 32,
    capacity * 32,
  ]);
  const prev = core.placeFrame(previous, pPrev), cur = core.placeFrame(current, pCur);
  core.writeRect(pRegion, region);
  carry.forEach((r, i) => core.writeRect(pCarry + i * 32, r));
  const count = core.check(
    core.exports.ls_sticky_occlusions(prev, cur, current.width, current.height, pRegion, motion.x, motion.y, pCarry, carry.length, out),
    'stickyOcclusions',
  );
  const view = new DataView(core.exports.memory.buffer, out, count * 32);
  return Array.from({ length: count }, (_, i) => ({
    x: view.getFloat64(i * 32, true),
    y: view.getFloat64(i * 32 + 8, true),
    width: view.getFloat64(i * 32 + 16, true),
    height: view.getFloat64(i * 32 + 24, true),
  }));
}
