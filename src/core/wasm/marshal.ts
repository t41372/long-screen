/** Small marshalling primitives every domain module uses to write its inputs into core memory. */
import type { Rect, Region } from '../../types.ts';
import { type CoreExports, VOTING_REGION_BYTES } from './exports.ts';
import { type FrameInput, ResidentFrame } from './memory.ts';

export function writeRect(exports: CoreExports, ptr: number, r: Rect): void {
  const view = new DataView(exports.memory.buffer, ptr, 32);
  view.setFloat64(0, r.x, true);
  view.setFloat64(8, r.y, true);
  view.setFloat64(16, r.width, true);
  view.setFloat64(24, r.height, true);
}

/** Writes one region's `VOTING_REGION_BYTES`-byte wire descriptor at `base + o`: rect, exclusions, crop, solid
 *  flag and mask — the format `ls_voting_new`, `ls_regions_label_atlas`, `ls_track_odometry` and
 *  `ls_frame_paint_tile` all read. `exclusionsPtr`/`cropPtr`/`maskPtr` must already be allocated (scratch or
 *  persistent, whichever the caller uses) with room for the region's exclusions rects, crop rect and mask
 *  bytes respectively; pass 0 for whichever the region has none of. */
export function writeRegionDescriptor(
  exports: CoreExports,
  base: number,
  o: number,
  r: Region,
  exclusionsPtr: number,
  cropPtr: number,
  maskPtr: number,
): void {
  writeRect(exports, base + o, r.rect);
  (r.exclusions || []).forEach((e, k) => writeRect(exports, exclusionsPtr + k * 32, e));
  const view = new DataView(exports.memory.buffer, base + o, VOTING_REGION_BYTES);
  view.setUint32(32, r.exclusions?.length ? exclusionsPtr : 0, true);
  view.setUint32(36, r.exclusions?.length || 0, true);
  if (r.crop) writeRect(exports, cropPtr, r.crop);
  view.setUint32(40, r.crop ? cropPtr : 0, true);
  view.setUint32(44, r.solid ? 1 : 0, true);
  const useMask = !!r.mask && !r.solid;
  if (useMask) {
    if (!r.maskWidth || !r.maskHeight || r.mask!.byteLength !== r.maskWidth * r.maskHeight) {
      throw new Error(`CORE_BAD_ARGUMENT: region ${r.id} mask does not match its declared ${r.maskWidth}×${r.maskHeight}.`);
    }
    new Uint8Array(exports.memory.buffer).set(r.mask!, maskPtr);
  }
  view.setUint32(48, useMask ? maskPtr : 0, true);
  view.setUint32(52, useMask ? r.maskWidth! : 0, true);
  view.setUint32(56, useMask ? r.maskHeight! : 0, true);
  view.setUint32(60, useMask ? r.factor || 0 : 0, true);
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
