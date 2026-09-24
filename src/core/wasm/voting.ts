/** Stateful displacement-spread consistency voting ring living in core memory (mirrors
 *  `rust/core/src/abi/voting.rs`). */
import type { Gray, Point, Region } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { VOTING_REGION_BYTES } from './exports.ts';

/** Analysis-resolution voting box of one moving region, in that region's own local cell coordinates. */
export interface VotingBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}
/** Finalised verdict for one region of one frame: `bits` inconsistent, `clean` confidently consistent (LSB-first). */
export type VotingVerdict = VotingBox & { bits: Uint8Array; clean: Uint8Array };
export interface VotingRecord {
  index: number;
  /** Per region id; absent when no region had a verdict cell. */
  record: Record<string, VotingVerdict> | undefined;
  votedLayers: number;
  thinLayers: number;
}

/** Stateful displacement-spread consistency voting ring living in core memory (rust/core/src/voting.rs). One
 *  per solve pass: `observe()` each moving region's final pose, `pushFrame()` once per frame, read whatever
 *  finalised records come out, `drain()` at the end, `free()` always. */
export class VotingRing {
  private canvasIds: string[] = [];
  private canvasSlots = new Map<string, number>();
  readonly boxes: VotingBox[];
  private grayBytes: number;
  private grayPtr: number;
  private readonly peekBytes: number;
  private freed = false;
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly regions: Region[],
    analysisPixels: number,
  ) {
    this.grayBytes = analysisPixels;
    this.grayPtr = exports.ls_alloc(analysisPixels);
    if (!this.grayPtr) throw new Error('CORE_OUT_OF_MEMORY: voting ring frame buffer.');
    this.peekBytes = 16 + 4 * regions.length;
    this.boxes = regions.map((_, slot) => {
      const [out] = core.scratch([16]);
      core.check(exports.ls_voting_box(handle, slot, out), 'voting box');
      const view = new DataView(exports.memory.buffer, out, 16);
      return { x0: view.getInt32(0, true), y0: view.getInt32(4, true), w: view.getInt32(8, true), h: view.getInt32(12, true) };
    });
  }
  /** Interior-cell mask (w×h bytes) of a region slot; exposed for parity tests. */
  interior(slot: number): Uint8Array {
    const box = this.boxes[slot], [out] = this.core.scratch([box.w * box.h]);
    this.core.check(this.exports.ls_voting_interior(this.handle, slot, out), 'voting interior');
    return this.core.readBytes(out, box.w * box.h);
  }
  private canvasSlot(canvasId: string): number {
    let slot = this.canvasSlots.get(canvasId);
    if (slot === undefined) {
      slot = this.canvasIds.push(canvasId) - 1;
      this.canvasSlots.set(canvasId, slot);
    }
    return slot;
  }
  /** Adds one region's evidence for the frame under construction. `gray` is the whole analysis frame; it is
   *  copied into the core once per frame (the first `observe()` of a frame uploads, later ones reuse). */
  observe(slot: number, canvasId: string, pose: Point, gray: Gray, uploaded: boolean): void {
    if (gray.data.byteLength !== this.grayBytes) throw new Error('CORE_BAD_ARGUMENT: analysis frame size differs from the voting ring.');
    if (!uploaded) this.core.writeBytes(this.grayPtr, gray.data);
    this.core.check(
      this.exports.ls_voting_observe(this.handle, slot, this.canvasSlot(canvasId), pose.x, pose.y, this.grayPtr),
      'voting observe',
    );
  }
  pushFrame(index: number): VotingRecord[] {
    this.core.check(this.exports.ls_voting_push(this.handle, index), 'voting push');
    return this.collect();
  }
  drain(): VotingRecord[] {
    this.core.check(this.exports.ls_voting_drain(this.handle), 'voting drain');
    return this.collect();
  }
  private collect(): VotingRecord[] {
    const out: VotingRecord[] = [];
    while (true) {
      const [head] = this.core.scratch([this.peekBytes]);
      const count = this.exports.ls_voting_peek(this.handle, head);
      if (count === -2) break;
      this.core.check(count, 'voting peek');
      const view = new DataView(this.exports.memory.buffer, head, this.peekBytes);
      const index = view.getUint32(0, true), votedLayers = view.getUint32(8, true), thinLayers = view.getUint32(12, true);
      const slots = Array.from({ length: count }, (_, i) => view.getUint32(16 + i * 4, true));
      let record: Record<string, VotingVerdict> | undefined;
      for (let which = 0; which < count; which++) {
        const slot = slots[which], box = this.boxes[slot], bytes = Math.ceil(box.w * box.h / 8);
        const [bits, clean] = this.core.scratch([bytes, bytes]);
        this.core.check(this.exports.ls_voting_read(this.handle, which, bits, clean), 'voting read');
        (record ??= {})[this.regions[slot].id] = {
          ...box,
          bits: this.core.readBytes(bits, bytes),
          clean: this.core.readBytes(clean, bytes),
        };
      }
      this.exports.ls_voting_pop(this.handle);
      out.push({ index, record, votedLayers, thinLayers });
    }
    return out;
  }
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.exports.ls_voting_free(this.handle);
    this.exports.ls_free(this.grayPtr, this.grayBytes);
    this.handle = 0;
  }
}

/** Creates a voting ring over `regions` (moving regions, in slot order). Region masks are copied once. */
export function votingRing(
  core: Core,
  exports: CoreExports,
  regions: Region[],
  options: {
    factor: number;
    noise: number;
    nativeWidth: number;
    nativeHeight: number;
    analysisWidth: number;
    analysisHeight: number;
    budgetBytes: number;
  },
): VotingRing {
  const sizes: number[] = [regions.length * VOTING_REGION_BYTES];
  for (const r of regions) {
    sizes.push((r.exclusions?.length || 0) * 32, r.crop ? 32 : 0, r.mask && !r.solid ? r.mask.byteLength : 0);
  }
  const ptr = core.scratch(sizes),
    base = ptr[0],
    view = new DataView(exports.memory.buffer, base, regions.length * VOTING_REGION_BYTES);
  regions.forEach((r, i) => {
    const [exclusions, crop, mask] = ptr.slice(1 + i * 3, 4 + i * 3), o = i * VOTING_REGION_BYTES;
    core.writeRect(base + o, r.rect);
    (r.exclusions || []).forEach((e, k) => core.writeRect(exclusions + k * 32, e));
    view.setUint32(o + 32, r.exclusions?.length ? exclusions : 0, true);
    view.setUint32(o + 36, r.exclusions?.length || 0, true);
    if (r.crop) core.writeRect(crop, r.crop);
    view.setUint32(o + 40, r.crop ? crop : 0, true);
    view.setUint32(o + 44, r.solid ? 1 : 0, true);
    const useMask = !!r.mask && !r.solid;
    if (useMask) {
      if (!r.maskWidth || !r.maskHeight || r.mask!.byteLength !== r.maskWidth * r.maskHeight) {
        throw new Error(`CORE_BAD_ARGUMENT: region ${r.id} mask does not match its declared ${r.maskWidth}×${r.maskHeight}.`);
      }
      core.writeBytes(mask, r.mask!);
    }
    view.setUint32(o + 48, useMask ? mask : 0, true);
    view.setUint32(o + 52, useMask ? r.maskWidth! : 0, true);
    view.setUint32(o + 56, useMask ? r.maskHeight! : 0, true);
    view.setUint32(o + 60, useMask ? r.factor || 0 : 0, true);
  });
  const handle = core.check(
    exports.ls_voting_new(
      options.factor,
      options.noise,
      options.nativeWidth,
      options.nativeHeight,
      options.analysisWidth,
      options.analysisHeight,
      options.budgetBytes,
      base,
      regions.length,
    ),
    'voting ring',
  );
  return new VotingRing(core, exports, handle, regions, options.analysisWidth * options.analysisHeight);
}
