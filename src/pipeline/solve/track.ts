// The pose bound the solve session validates every pose against (rust/engine/src/solve/mod.rs `is_valid_pose`),
// kept here for render.ts's mirror of that check until the render pass moves into the engine.
import type { Point } from '../../types.ts';
import { CANVAS_PIXEL_BOUND } from '../../core/compositor.ts';
/** compositor.ts's `CANVAS_PIXEL_BOUND` less a margin larger than any supported frame side (2^16): a pose outside it
 * can never be tiled, so it is treated like a non-finite one. */
const MAX_SUPPORTED_FRAME_DIMENSION = 2 ** 16;
export const POSE_BOUND = CANVAS_PIXEL_BOUND - MAX_SUPPORTED_FRAME_DIMENSION;
export function isValidPose(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < POSE_BOUND && Math.abs(p.y) < POSE_BOUND;
}
