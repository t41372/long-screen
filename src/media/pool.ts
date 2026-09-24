/** Explicit-release pool of RGBA conversion buffers (docs/HANDOFF.md "下一步" #1): a fresh 30 MB `Uint8ClampedArray`
 *  per decoded frame page-faults and GCs enough to cost 25+ ms/frame at e.mov resolution (37.6–41 ms/frame fresh vs
 *  12.4 reused, measured on the first 150 frames, decode+convert only). A buffer returns to the pool only when its
 *  last holder calls `release()` — NEVER on a fixed rotation: any holder that keeps `image.data` longer than one
 *  frame (scan's previousImage/baseline.image, render's pending/pendingPrev, solve's previous) would otherwise have
 *  it silently overwritten by a later frame. A buffer nobody ever releases is simply never reused, so the worst
 *  case degrades to today's allocate-per-frame — never worse. */
import type { RGBA } from '../types.ts';

/** An RGBA frame whose backing buffer came from a `BufferPool`. `release()` is idempotent — only the first call
 *  returns the buffer, so a holder that races another (or that releases defensively) never double-frees. */
export interface PooledRGBA extends RGBA {
  release(): void;
}

/** One pool per converter instance (each converter closure owns its own, so two converters never hand out the
 *  same physical buffer). Buffers are keyed by byte length only: a source's geometry cannot change mid-run
 *  (`checkFrameGeometry` enforces it), so in practice every buffer in `free` is the current frame size; a stale
 *  size (left over from a previous, differently-sized source reusing this pool) is just dropped rather than
 *  handed out wrong-sized. */
export class BufferPool {
  private free: ArrayBuffer[] = [];
  private length = 0;
  private outstandingCount = 0;
  /** Buffers currently checked out and not yet released — a leak indicator for tests, and for the "stop mid-pass
   *  must release everything" gate. */
  get outstanding(): number {
    return this.outstandingCount;
  }
  takeBuffer(length: number): ArrayBuffer {
    if (length !== this.length) {
      this.free.length = 0;
      this.length = length;
    }
    const buffer = this.free.pop() ?? new ArrayBuffer(length);
    this.outstandingCount++;
    return buffer;
  }
  /** Idempotent per physical buffer only in the sense that pushing it twice would hand it out twice; callers
   *  (`take()`'s `release`, the worker's release-message handler) are responsible for calling this at most once
   *  per `takeBuffer`. */
  releaseBuffer(buffer: ArrayBuffer): void {
    this.outstandingCount--;
    if (buffer.byteLength === this.length) this.free.push(buffer);
  }
  /** A ready-to-fill RGBA of the given geometry, backed by a pooled buffer. */
  take(width: number, height: number): PooledRGBA {
    const buffer = this.takeBuffer(width * height * 4);
    let released = false;
    return {
      width,
      height,
      data: new Uint8ClampedArray(buffer),
      release: () => {
        if (released) return;
        released = true;
        this.releaseBuffer(buffer);
      },
    };
  }
}

/** Releases `image` back to its pool unless it is still aliased by one of `held` — same object, not just same
 *  bytes (`===`). Every pipeline holder of a converted frame (scan's previousImage/baseline.image, render's
 *  pending/pendingPrev, solve's previous) calls this exactly when it drops its own reference, passing every OTHER
 *  field that might alias the same RGBA object; a duplicate-frame shortcut can otherwise assign the same object to
 *  two fields (e.g. scan's baseline.image and previousImage), and releasing on one field's turnover alone would
 *  hand a still-referenced buffer back to the pool. A no-op when `image` did not come from a pool (`release` is
 *  undefined) — the compatibility (canvas-seek) source's frames, for instance. */
export function releaseUnlessHeld(image: RGBA | undefined, ...held: (RGBA | undefined)[]): void {
  if (!image || held.includes(image)) return;
  (image as Partial<PooledRGBA>).release?.();
}
