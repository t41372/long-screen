/** Preview pyramids (mirrors `rust/wasm/src/pyramid.rs`): the engine's pyramid session
 *  (`long_screen_engine::pyramid::PyramidSession`) that `TileStore.buildPyramid` (src/storage/tiles.ts) drives for
 *  one canvas, and the single parent-tile assembly kernel the parity test checks on its own. */
import type { RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { ByteReader } from './bytes.ts';
import { FreeGuard } from './memory.ts';

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

/** One step of a pyramid session (`long_screen_engine::pyramid::Step`). */
export type PyramidStep =
  /** Pass every stored `tile-index/` row of level `level - 1` to `queue()`, then step again. */
  | { kind: 'index'; level: number }
  /** Read the stored child tiles of parent `x_y` of `level` (quadrant order `[0,0]`, `[1,0]`, `[0,1]`, `[1,1]`) and
   *  hand their decoded pixels to `provide()`, then step again. */
  | { kind: 'children'; level: number; x: number; y: number; children: { level: number; x: number; y: number }[] }
  /** Parent `x_y` of `level` is done: store `pixels` when present, drop it from the queue, then step again. */
  | { kind: 'parent'; level: number; x: number; y: number; pixels?: Uint8ClampedArray<ArrayBuffer> }
  /** Every parent of `level` is done. */
  | { kind: 'level'; level: number }
  | { kind: 'done' };

const encoder = new TextEncoder();

/** One canvas's pyramid in core memory. `free()` releases it; one nobody frees is released when it is garbage
 *  collected. */
export class PyramidSessionHandle {
  private static readonly registry = new FinalizationRegistry<{ exports: CoreExports; handle: number }>(({ exports, handle }) =>
    exports.ls_pyramid_free(handle)
  );
  private readonly freeGuard = new FreeGuard();
  private readonly token = {};
  constructor(private readonly core: Core, private readonly exports: CoreExports, private readonly handle: number, readonly size: number) {
    PyramidSessionHandle.registry.register(this, { exports, handle }, this.token);
  }
  /** Queues the parent of stored index row `(x, y)`; returns the parent's coordinates. */
  queue(x: number, y: number): { x: number; y: number } {
    const [out] = this.core.scratch([8]);
    this.core.check(this.exports.ls_pyramid_queue(this.handle, x, y, out), 'pyramid queue');
    const view = new DataView(this.exports.memory.buffer, out, 8);
    return { x: view.getInt32(0, true), y: view.getInt32(4, true) };
  }
  /** The four children's decoded pixels, `undefined` for each one not stored. */
  provide(children: (Uint8ClampedArray | undefined)[]): void {
    const bytes = this.size * this.size * 4;
    const [table, ...slots] = this.core.scratch([16, ...children.map((c) => (c ? bytes : 0))]);
    const view = new DataView(this.exports.memory.buffer, table, 16);
    children.forEach((c, i) => {
      if (c) this.core.writeBytes(slots[i], c);
      view.setUint32(i * 4, c ? slots[i] : 0, true);
    });
    this.core.check(this.exports.ls_pyramid_provide(this.handle, table), 'pyramid provide');
  }
  step(): PyramidStep {
    const length = this.core.check(this.exports.ls_pyramid_step(this.handle), 'pyramid step');
    const [out] = this.core.scratch([length]);
    this.core.check(this.exports.ls_pyramid_take(this.handle, out, length), 'pyramid step result');
    const r = new ByteReader(this.core.readBytes(out, length)), kind = r.u8();
    const signed = () => r.u32() | 0;
    if (kind === 0) return { kind: 'index', level: r.u32() };
    if (kind === 1) {
      const level = r.u32(), x = signed(), y = signed();
      return { kind: 'children', level, x, y, children: [0, 1, 2, 3].map(() => ({ level: r.u32(), x: signed(), y: signed() })) };
    }
    if (kind === 2) {
      const level = r.u32(), x = signed(), y = signed();
      return r.bool()
        ? { kind: 'parent', level, x, y, pixels: new Uint8ClampedArray(r.take(this.size * this.size * 4).buffer) }
        : { kind: 'parent', level, x, y };
    }
    if (kind === 3) return { kind: 'level', level: r.u32() };
    return { kind: 'done' };
  }
  free(): void {
    this.freeGuard.once(() => {
      PyramidSessionHandle.registry.unregister(this.token);
      this.exports.ls_pyramid_free(this.handle);
    });
  }
}

/** A pyramid session for canvas `canvas` with bounds `width × height` over `size`-pixel tiles. */
export function pyramidSession(
  core: Core,
  exports: CoreExports,
  canvas: string,
  width: number,
  height: number,
  size: number,
): PyramidSessionHandle {
  const bytes = encoder.encode(canvas), [ptr] = core.scratch([Math.max(1, bytes.length)]);
  core.writeBytes(ptr, bytes);
  const handle = core.check(exports.ls_pyramid_new(ptr, bytes.length, width, height, size), 'pyramid session');
  return new PyramidSessionHandle(core, exports, handle, size);
}
