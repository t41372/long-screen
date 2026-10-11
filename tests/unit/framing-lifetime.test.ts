import '../support/core.ts';
import { assert, assertThrows } from '@std/assert';
import { core } from '../../src/core/wasm.ts';
import type { Region } from '../../src/types.ts';

Deno.test(
  'framing: opening a framing session frees what it already allocated when a region upload throws',
  () => {
    // Regression: the framing session's ignore regions are uploaded into PERSISTENT core allocations (one
    // descriptor plus per-region exclusions/crop/mask buffers) for `ls_framing_new` to copy. A throw partway —
    // here a region whose mask byte length does not match its declared maskWidth*maskHeight — must not leave the
    // allocations made so far unfreed: nothing is returned for a caller to free in that case.
    const c = core();
    const badRegion: Region = {
      id: 'bad',
      name: 'bad',
      kind: 'moving',
      rect: { x: 0, y: 0, width: 4, height: 4 },
      mask: new Uint8Array(3),
      maskWidth: 4,
      maskHeight: 4,
    };
    const source = { id: 'c', bounds: { x: 0, y: 0, width: 16, height: 16 }, tileCount: 1, attached: false };
    const open = () => c.framingSession(source, { x: 0, y: 0, width: 16, height: 16 }, [badRegion], 16, 20000);
    // The first call may grow the heap once (the allocator's first block of this size); measure from after it.
    assertThrows(open);
    const before = c.memoryBytes;
    for (let i = 0; i < 64; i++) {
      assertThrows(open);
    }
    const after = c.memoryBytes;
    // One leaked call grows memory by a region descriptor plus a tiny mask buffer (tens of bytes); 64 leaked
    // calls would need at least one fresh 64KiB wasm page if the fix regresses. Fixed, ls_alloc/ls_free reuse
    // the same freed block on every iteration and memory stays flat.
    assert(after - before < 65536, `framingSession leaked memory across repeated throws: ${before} -> ${after}`);
  },
);
