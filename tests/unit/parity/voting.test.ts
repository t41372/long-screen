/** Byte-exact parity between the Rust core and the historical TypeScript kernels it replaces.
 *  The TS versions in tests/support/reference are frozen oracles; production code calls the core only. */
import { assert, assertEquals } from '@std/assert';
import { ensureCore } from '../../support/core.ts';
import type { Gray, Region } from '../../../src/types.ts';
import { ReferenceVotingRing } from '../../support/reference/voting.ts';

/** Failure modes of a vectorised / parallel per-tile compositor that the small-tile parity above cannot reach:
 *  channel sums exactly at and one past the mismatch limit (75 vs 76), alpha-only differences (must never count),
 *  whole 16-pixel block rows next to rows clipped by the frame edge or cut by an occlusion band, label-masked
 *  lanes inside an otherwise full row, and tiles large enough that the threaded core splits block rows across
 *  pool chunks (conflict-block order and summed stats must not depend on the split). */
/** Failure modes the voting-ring parity must catch: `Math.hypot` vs libm hypot changing the dmin gate or the
 *  displacement sort; `Math.round` on negative half-cells; box-gray rounding (`Math.round(sum / 9)`); region masks
 *  looked up at floor(x/factor) vs ratio; exclusions/crop/solid; partner selection ties (equal pairs, equal d);
 *  saturating i8/u8 counters; eviction order under a byte budget; multi-canvas gating; slots with no evidence in a
 *  frame; and drain at the end of the pass. */
Deno.test('core parity: the voting ring matches the frozen TS ring record-for-record, including evictions and drain', async () => {
  const core = await ensureCore();
  const toRecord = (
    r: {
      index: number;
      record: Record<string, { x0: number; y0: number; w: number; h: number; bits: Uint8Array; clean: Uint8Array }> | undefined;
    },
  ) => ({
    index: r.index,
    record: r.record &&
      Object.fromEntries(
        Object.entries(r.record).map(([id, v]) => [id, { x0: v.x0, y0: v.y0, w: v.w, h: v.h, bits: [...v.bits], clean: [...v.clean] }]),
      ),
  });
  // Regions must be taller than dmin (64 native px) or no partner can ever overlap; that is a property of the
  // algorithm, not something the fixture should paper over.
  for (
    const [factor, noise, nativeW, nativeH] of [[1, 0, 96, 130], [2, 10, 190, 121], [4, 10, 257, 200], [1, 10, 128, 200]] as number[][]
  ) {
    const aw = Math.ceil(nativeW / factor), ah = Math.ceil(nativeH / factor);
    // Two moving regions: a masked one with an exclusion, and a cropped rectangular one; plus a fixed region that must be ignored.
    const mask = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) mask[y * aw + x] = x < aw * .6 && !(x < 4 && y < 6) ? 1 : 0;
    const regions: Region[] = [
      {
        id: 'a',
        name: 'a',
        kind: 'moving',
        rect: { x: 0, y: 8, width: Math.floor(nativeW * .6), height: nativeH - 8 },
        mask,
        maskWidth: aw,
        maskHeight: ah,
        factor,
        exclusions: [{ x: 10, y: 60, width: 30, height: 20 }],
      },
      {
        id: 'b',
        name: 'b',
        kind: 'moving',
        rect: { x: Math.floor(nativeW * .6), y: 8, width: nativeW - Math.floor(nativeW * .6), height: nativeH - 8 },
        crop: { x: Math.floor(nativeW * .6) + 2, y: 10, width: nativeW - Math.floor(nativeW * .6) - 4, height: nativeH - 20 },
        solid: true,
      },
    ];
    // Roughly ten frames resident (two regions × three planes each): partners clear dmin, and evictions still happen mid-run.
    const budget = 10 * (2 * 3 * aw * ah);
    const ring = core.votingRing(regions, {
      factor,
      noise,
      nativeWidth: nativeW,
      nativeHeight: nativeH,
      analysisWidth: aw,
      analysisHeight: ah,
      budgetBytes: budget,
    });
    const reference = new ReferenceVotingRing(factor, noise, nativeW, nativeH, regions, budget);
    try {
      for (let slot = 0; slot < regions.length; slot++) {
        assertEquals(ring.boxes[slot], reference.box.get(regions[slot].id));
        assertEquals(ring.interior(slot), reference.interior.get(regions[slot].id));
      }
      // Scrolling content: a textured world sampled at a drifting pose, with a screen-fixed overlay band and noise.
      const world = (x: number, y: number) => ((((x * 7) >> 3) + ((y * 5) >> 4)) * 37 + (x ^ y)) & 255;
      const got: unknown[] = [], want: unknown[] = [];
      let pose = { x: 0, y: 0 };
      for (let frame = 0; frame < 40; frame++) {
        pose = { x: pose.x + (frame % 7 === 3 ? -13.5 : 2.25), y: pose.y + (frame < 20 ? 31.5 : -47.25) + (frame % 5 === 0 ? .5 : 0) };
        const g: Gray = { width: aw, height: ah, data: new Uint8Array(aw * ah) };
        for (let y = 0; y < ah; y++) {
          for (let x = 0; x < aw; x++) {
            const overlay = y > ah * .4 && y < ah * .4 + 3 && x > aw * .1 && x < aw * .5;
            g.data[y * aw + x] = overlay
              ? 20
              : (world(Math.round(x + pose.x / factor), Math.round(y + pose.y / factor)) + ((x * y + frame) % 7 === 0 ? 30 : 0)) & 255;
          }
        }
        // Region b jumps canvases mid-run; region a skips some frames entirely.
        const canvasB = frame < 25 ? 'c0' : 'c1';
        let uploaded = false;
        if (frame % 9 !== 4) {
          ring.observe(0, 'c0', pose, g, uploaded);
          uploaded = true;
          reference.observe(regions[0], 'c0', pose, g);
        }
        if (frame % 11 !== 6) {
          ring.observe(1, canvasB, { x: -pose.x, y: pose.y * .5 }, g, uploaded);
          reference.observe(regions[1], canvasB, { x: -pose.x, y: pose.y * .5 }, g);
        }
        got.push(...ring.pushFrame(frame).map(toRecord));
        want.push(...reference.pushFrame(frame).map(toRecord));
      }
      got.push(...ring.drain().map(toRecord));
      want.push(...reference.drain().map(toRecord));
      assert(want.length >= 20, `expected evictions and drain to finalise frames (got ${want.length})`);
      assert(want.some((r: any) => r.record), 'the fixture should produce at least one verdict');
      assertEquals(got, want, `factor ${factor} noise ${noise}`);
    } finally {
      ring.free();
    }
  }
});
