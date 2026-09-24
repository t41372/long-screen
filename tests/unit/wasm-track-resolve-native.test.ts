import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { resolveNative } from '../../src/core/wasm/track.ts';
import { core } from '../../src/core/wasm.ts';
import { makeWorld } from '../../src/synthetic/world.ts';

// `resolveNative`'s three branches: (1) a resident current frame with a filled native plane, which the fused-call
// callers use every frame; (2) `native()` itself handing back a `ResidentGray` (the mode-0 fallback bug fixed in
// 474fb81 — a caller with no resident `current`/`nativePlane` can still close over a resident plane); (3) `native()`
// handing back a plain `Gray` (the rare geometry-mismatch fallback documented on the function). Only (1) is reached
// by the synthetic scenarios today (see the function's doc comment), so (2) and (3) need a direct test.
Deno.test('wasm/track resolveNative: current/nativePlane both absent, native() returns a ResidentGray', () => {
  const page = makeWorld(64, 64, 3, 'article'), g = core().gray(64, 64);
  g.write(core().grayscale(page.data, 64, 64).data);
  const result = resolveNative(undefined, undefined, () => g);
  assertEquals(result.mode, 1);
  assertEquals(result.ptr, g.ptr);
  assertEquals(result.currentFramePtr, 0);
  assertEquals(result.width, 64);
  assertEquals(result.height, 64);
  assertEquals(result.scratchBytes, 0);
  assert(result.alreadyFilled, 'a ResidentGray from native() must be reported as already filled');
  assertEquals(result.fallback, undefined);
});

Deno.test('wasm/track resolveNative: current/nativePlane both absent, native() returns a plain Gray', () => {
  const page = makeWorld(48, 40, 7, 'article'), g = core().grayscale(page.data, 48, 40);
  const result = resolveNative(undefined, undefined, () => g);
  assertEquals(result.mode, 0);
  assertEquals(result.ptr, 0);
  assertEquals(result.currentFramePtr, 0);
  assertEquals(result.width, 48);
  assertEquals(result.height, 40);
  assertEquals(result.scratchBytes, g.data.byteLength);
  assertEquals(result.alreadyFilled, false);
  assertEquals(result.fallback, g);
});

// `ResidentGray.window()` reads an arbitrary sub-rectangle out of a resident luma plane without copying the whole
// plane; it lost its only production caller when `extractPatches` moved to Rust (see `scripts/coverage.ts`'s header
// for `core/wasm/memory.ts`), so nothing in the synthetic scenarios reaches it any more.
Deno.test('wasm/memory ResidentGray.window: reads a sub-rectangle at an offset', () => {
  const width = 10, height = 6, data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = i;
  const plane = core().gray(width, height);
  plane.write(data);
  const w = plane.window(3, 2, 4, 3);
  assertEquals(w.length, 12);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      assertEquals(w[row * 4 + col], data[(row + 2) * width + (col + 3)]);
    }
  }
});
