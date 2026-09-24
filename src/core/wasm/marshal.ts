/** Small marshalling primitives every domain module uses to write its inputs into core memory. */
import type { Rect } from '../../types.ts';
import type { CoreExports } from './exports.ts';
import { type FrameInput, ResidentFrame } from './memory.ts';

export function writeRect(exports: CoreExports, ptr: number, r: Rect): void {
  const view = new DataView(exports.memory.buffer, ptr, 32);
  view.setFloat64(0, r.x, true);
  view.setFloat64(8, r.y, true);
  view.setFloat64(16, r.width, true);
  view.setFloat64(24, r.height, true);
}

/** Pointer to `frame`'s pixels: its own resident pointer, or `scratch` after copying it there. The "0 bytes if
 *  resident, else copy into scratch" arena-planning half of this lives at each call site (the resident case
 *  plans a 0-byte slot), so the two must be used together. */
export function placeFrame(exports: CoreExports, frame: FrameInput, scratch: number): number {
  if (frame instanceof ResidentFrame) return frame.ptr;
  new Uint8Array(exports.memory.buffer).set(
    new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    scratch,
  );
  return scratch;
}
