import '../support/core.ts';
import { assert, assertThrows } from '@std/assert';
import { core } from '../../src/core/wasm.ts';
import type { Region, RGBA } from '../../src/types.ts';

Deno.test(
  'framing: openFramingSession frees what it already allocated when a later step throws (final-review item 5)',
  () => {
    // Regression: openFramingSession (src/core/wasm/framing.ts) makes several PERSISTENT core allocations
    // (sourceFrame, bgRows, bgColumns, and — via uploadRegions — one descriptor plus per-region
    // exclusions/crop/mask buffers) before returning a FramingSession whose dispose() frees them all. A throw
    // partway through — a bad ls_frame_backgrounds status, or (here) uploadRegions rejecting a region whose
    // mask byte length does not match its declared maskWidth*maskHeight — used to leave every allocation made
    // so far unfreed: nothing was ever returned for a caller to call dispose() on.
    const c = core();
    const source: RGBA = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) };
    const layout = c.frameLayout(source, { x: 0, y: 0, width: 16, height: 16 }, 16, 16);
    const badRegion: Region = {
      id: 'bad',
      name: 'bad',
      kind: 'moving',
      rect: { x: 0, y: 0, width: 4, height: 4 },
      mask: new Uint8Array(3),
      maskWidth: 4,
      maskHeight: 4,
    };
    const before = c.memoryBytes;
    for (let i = 0; i < 64; i++) {
      assertThrows(() => c.openFramingSession(source, layout, [badRegion], 16));
    }
    const after = c.memoryBytes;
    // One leaked call grows memory by a region descriptor plus a tiny mask buffer (tens of bytes); 64 leaked
    // calls would need at least one fresh 64KiB wasm page if the fix regresses. Fixed, ls_alloc/ls_free reuse
    // the same freed block on every iteration and memory stays flat.
    assert(after - before < 65536, `openFramingSession leaked memory across repeated throws: ${before} -> ${after}`);
  },
);
