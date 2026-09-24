/** Core-memory ownership: the bump arena kernel calls plan their scratch space from, and the resident wrappers
 *  (buffers, frames, luma planes, frame rings) that outlive a single call. */
import type { RGBA } from '../../types.ts';
import type { CoreExports } from './exports.ts';

const CHUNK = 4 * 1024 * 1024;

/** Bump arena over one `ls_alloc` block. Each kernel call plans all of its buffers up front, so the block
 *  can only be replaced between calls and offsets handed out for one call stay valid throughout it. */
export class Arena {
  private base = 0;
  private capacity = 0;
  constructor(private readonly exports: CoreExports) {}
  plan(sizes: number[]): number[] {
    const aligned = sizes.map((size) => (size + 7) & ~7), total = aligned.reduce((sum, size) => sum + size, 0);
    if (total > this.capacity) {
      const next = Math.max(total, this.capacity * 2, CHUNK);
      if (this.base) this.exports.ls_free(this.base, this.capacity);
      this.base = this.exports.ls_alloc(next);
      if (!this.base) {
        this.capacity = 0;
        throw new Error(`CORE_OUT_OF_MEMORY: the reconstruction core could not reserve ${next} bytes.`);
      }
      this.capacity = next;
    }
    let offset = 0;
    return aligned.map((size) => {
      const ptr = this.base + offset;
      offset += size;
      return ptr;
    });
  }
}

/** `ls_alloc` plus the null-pointer-means-OOM check, inlined at every persistent allocation site. */
export function allocOrThrow(exports: CoreExports, length: number, label: string): number {
  const ptr = exports.ls_alloc(length);
  if (!ptr) throw new Error(`CORE_OUT_OF_MEMORY: ${label}.`);
  return ptr;
}

/** Runs its cleanup at most once, so every resident wrapper's `free()` shares this "already freed" check
 *  instead of hand-rolling its own. */
export class FreeGuard {
  private done = false;
  once(dispose: () => void): void {
    if (this.done) return;
    this.done = true;
    dispose();
  }
}

/** Bytes that stay in core memory across kernel calls. Pointers survive memory growth (linear memory grows in
 *  place); only JS views do not, so nothing here holds a view — `bytes()` re-derives one on demand. */
export class Resident {
  private readonly freeGuard = new FreeGuard();
  constructor(protected readonly exports: CoreExports, readonly ptr: number, readonly length: number) {}
  /** Copy of the current contents. */
  bytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.exports.memory.buffer).slice(this.ptr, this.ptr + this.length) as Uint8Array<ArrayBuffer>;
  }
  /** Zero-copy view of the current contents. Only valid until the next core call (which may grow memory and detach
   *  it), so it must be used synchronously and never stored. */
  view(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, this.ptr, this.length);
  }
  /** Copies another resident buffer of the same length into this one without leaving core memory. */
  copyFrom(source: Resident): void {
    if (source.length !== this.length) {
      throw new Error(`CORE_BAD_ARGUMENT: resident buffer holds ${this.length} bytes, not ${source.length}.`);
    }
    new Uint8Array(this.exports.memory.buffer).copyWithin(this.ptr, source.ptr, source.ptr + source.length);
  }
  write(bytes: ArrayBufferView): void {
    if (bytes.byteLength !== this.length) {
      throw new Error(`CORE_BAD_ARGUMENT: resident buffer holds ${this.length} bytes, not ${bytes.byteLength}.`);
    }
    new Uint8Array(this.exports.memory.buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), this.ptr);
  }
  free(): void {
    this.freeGuard.once(() => this.exports.ls_free(this.ptr, this.length));
  }
}
/** A native RGBA frame resident in core memory. */
export class ResidentFrame extends Resident {
  constructor(exports: CoreExports, ptr: number, readonly width: number, readonly height: number) {
    super(exports, ptr, width * height * 4);
  }
}
/** A fixed number of resident frame slots keyed by frame index; the slot uploaded longest ago is replaced first.
 *  Frames arrive in index order, so with two slots the previous frame always survives the next upload and with
 *  three (render: previous, current, lookahead) each decoded frame enters core memory exactly once. `get()` is a
 *  pure lookup and never reorders slots. */
export class FrameRing {
  private readonly slots: { frame: ResidentFrame; index: number; used: number }[] = [];
  private tick = 0;
  constructor(private readonly exports: CoreExports, readonly capacity: number, readonly width: number, readonly height: number) {}
  get(index: number): ResidentFrame | undefined {
    return this.slots.find((s) => s.index === index)?.frame;
  }
  upload(index: number, image: RGBA): ResidentFrame {
    if (image.width !== this.width || image.height !== this.height) {
      throw new Error(`CORE_BAD_ARGUMENT: frame ${image.width}×${image.height} does not fit a ${this.width}×${this.height} ring.`);
    }
    const existing = this.get(index);
    if (existing) return existing;
    let slot = this.slots.length < this.capacity ? undefined : this.slots.reduce((a, b) => a.used < b.used ? a : b);
    if (!slot) {
      const ptr = allocOrThrow(this.exports, this.width * this.height * 4, 'resident frame slot');
      slot = { frame: new ResidentFrame(this.exports, ptr, this.width, this.height), index, used: 0 };
      this.slots.push(slot);
    }
    slot.index = index;
    slot.used = ++this.tick;
    slot.frame.write(image.data);
    return slot.frame;
  }
  free(): void {
    for (const slot of this.slots.splice(0)) slot.frame.free();
  }
}
/** A full-resolution luma plane resident in the core (the solve pass reuses one per run). Small windows are read
 *  out with `window()`; the plane itself never leaves core memory. */
export class ResidentGray extends Resident {
  constructor(exports: CoreExports, ptr: number, readonly width: number, readonly height: number) {
    super(exports, ptr, width * height);
  }
  /** Copy of the `w × h` window at (x, y), row-major; the caller keeps it inside the plane. */
  window(x: number, y: number, w: number, h: number): Uint8Array {
    const memory = new Uint8Array(this.exports.memory.buffer), out = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      const start = this.ptr + (y + row) * this.width + x;
      out.set(memory.subarray(start, start + w), row * w);
    }
    return out;
  }
}
/** Either a JS image or one already resident in the core. */
export type FrameInput = RGBA | ResidentFrame;
/** Either JS bytes or bytes already resident in the core. */
export type BytesInput = Uint8Array | Resident;
