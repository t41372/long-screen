import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
// Frames a run converts on the CPU can be handed out as their YUV planes, which the reveal stage converts straight
// into a core-resident frame slot (src/media/convert.ts `planes`, src/core/wasm/yuv.ts `frameToCore`). Ways it could go
// wrong, each checked below: the slot holds different pixels than the planar converter's RGBA for the same frame
// (a wrong format or matrix code, scratch buffers overlapping the output); planes offered before the planar path has
// passed its first-frame agreement check; planes offered on a run that converts another way (Chrome's own RGBA copy);
// the plane pool handing one buffer to two frames still held; a declined frame converted anyway.
for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser (${browser}): planes converted into core memory are byte-identical to the planar converter's RGBA`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const r = await h.page.evaluate(async () => {
          const kit = (window as any).longScreenKit, core = kit.core();
          const blob = await (await fetch('/fixtures/scroll.mp4')).blob();
          const planar = kit.planarConverter();
          const source = await kit.openMedia(new File([blob], 'scroll.mp4'), planar);
          // A fresh run: the first frame must come as RGBA (it settles the planar path), the rest as planes.
          const kinds: string[] = [];
          for await (const f of source.sparseFrames(() => true, { planes: true })) {
            kinds.push(f.planes ? 'planes' : f.image ? 'image' : 'skipped');
            f.planes?.release();
            f.image?.release?.();
          }
          // Reference RGBA of every frame through the settled planar converter.
          const reference: Uint8Array[] = [];
          for await (const f of source.frames()) {
            reference.push(new Uint8Array(f.image.data));
            f.image.release?.();
          }
          // Planes of the even frames, all held before any is converted, then converted into ring slots.
          const held: { index: number; planes: any }[] = [];
          const skipped: number[] = [];
          for await (const f of source.sparseFrames((i: number) => i % 2 === 0, { planes: true })) {
            if (f.planes) held.push({ index: f.index, planes: f.planes });
            else if (!f.image) skipped.push(f.index);
            else f.image.release?.();
          }
          const { width, height } = source.info;
          const ring = core.frameRing(held.length, width, height);
          const mismatched: number[] = [];
          for (const { index, planes } of held) {
            const slot = ring.fill(index, width, height, (s: any) => core.planesToCore(planes, s.ptr));
            const bytes = slot.bytes(), want = reference[index];
            if (bytes.length !== want.length || bytes.some((v: number, i: number) => v !== want[i])) mismatched.push(index);
          }
          held.forEach(({ planes }) => planes.release());
          ring.free();
          source.dispose();
          // A run on the browser's own RGBA copy (Chrome) must never be offered planes.
          const direct = kit.directConverter();
          const other = await kit.openMedia(new File([blob], 'scroll.mp4'), direct);
          const directKinds: string[] = [];
          for await (const f of other.sparseFrames(() => true, { planes: true })) {
            directKinds.push(f.planes ? 'planes' : 'image');
            f.planes?.release();
            f.image?.release?.();
          }
          other.dispose();
          return {
            kinds,
            frames: reference.length,
            held: held.map((x) => x.index),
            skipped,
            mismatched,
            directDescribe: direct.describe(),
            directKinds: [...new Set(directKinds)],
          };
        });
        assert(r.frames > 4, `fixture decoded ${r.frames} frames`);
        assertEquals(r.kinds[0], 'image', 'the first frame of a fresh run settles the planar path, so it cannot be planes');
        assertEquals([...new Set(r.kinds.slice(1))], ['planes'], `after it, every frame comes as planes: ${r.kinds}`);
        assertEquals(r.held, Array.from({ length: Math.ceil(r.frames / 2) }, (_, i) => i * 2), 'only wanted frames as planes');
        assertEquals(r.skipped, Array.from({ length: Math.floor(r.frames / 2) }, (_, i) => i * 2 + 1), 'declined frames carry no pixels');
        assertEquals(r.mismatched, [], 'planes converted into core memory must equal the planar RGBA byte for byte');
        if (r.directDescribe === 'copyTo(RGBA)') assertEquals(r.directKinds, ['image'], 'no planes on a run using copyTo(RGBA)');
      } finally {
        await h.close();
      }
    },
  });
}

// In WebKit (no RGBA copy) the shipped converter chain copies planes in the conversion worker and converts them on
// the pipeline thread. Failure cases: worker-copied planes or the RGBA made from them differing from the in-thread
// planar conversion; frames out of order once copies run ahead; the worker never actually used; a broken worker
// changing the output instead of falling back in-thread; plane buffers given back to the wrong pool (a later frame
// would come out corrupted).
Deno.test({
  name: 'browser (webkit): planes copied in the conversion worker give the same frames as the in-thread planar path',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ browser: 'webkit' });
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit, core = kit.core();
        const blob = await (await fetch('/fixtures/scroll.mp4')).blob();
        const digest = async (bytes: Uint8Array | Uint8ClampedArray) =>
          Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)).slice(0, 8)).join('.');
        const run = async (make: () => any) => {
          const convert = make(), source = await kit.openMedia(new File([blob], 'scroll.mp4'), convert);
          const rgba: string[] = [], ring: string[] = [];
          for await (const f of source.frames()) {
            rgba.push(`${f.index}:${await digest(f.image.data)}`);
            kit.releaseUnlessHeld(f.image);
          }
          const { width, height } = source.info, slots = core.frameRing(2, width, height);
          for await (const f of source.sparseFrames(() => true, { planes: true })) {
            if (f.planes) {
              const slot = slots.fill(f.index, width, height, (s: any) => core.planesToCore(f.planes, s.ptr));
              ring.push(`${f.index}:${await digest(slot.bytes())}`);
              f.planes.release();
            } else {
              ring.push(`${f.index}:${await digest(f.image.data)}`);
              kit.releaseUnlessHeld(f.image);
            }
          }
          slots.free();
          source.dispose();
          return { rgba, ring, counts: convert.counts ? { ...convert.counts } : undefined, describe: convert.describe?.() };
        };
        const url = new URL('./assets/convert-worker.js', location.href);
        const inThread = await run(() => kit.planarConverter());
        const viaWorker = await run(() => {
          const planar = kit.planarConverter();
          return kit.workerConverter(url, kit.directConverter(planar), 'auto', planar);
        });
        const broken = await run(() => {
          const planar = kit.planarConverter();
          return kit.workerConverter(
            new URL('./assets/missing-convert-worker.js', location.href),
            kit.directConverter(planar),
            'auto',
            planar,
          );
        });
        return { inThread, viaWorker, broken };
      });
      assert(r.inThread.rgba.length > 4, `${r.inThread.rgba.length} frames`);
      assertEquals(r.viaWorker.rgba, r.inThread.rgba, 'RGBA from worker-copied planes');
      assertEquals(r.viaWorker.ring, r.inThread.rgba, 'planes copied in the worker, converted into core memory');
      assert(
        r.viaWorker.counts.planes >= r.inThread.rgba.length,
        `worker copied ${r.viaWorker.counts.planes} frames: ${r.viaWorker.describe}`,
      );
      assertEquals([r.broken.rgba, r.broken.ring], [r.inThread.rgba, r.inThread.rgba], 'a broken worker falls back in-thread');
      assertEquals(r.broken.counts.planes, 0);
      assert(/conversion worker/.test(r.broken.counts.reason), r.broken.counts.reason);
    } finally {
      await h.close();
    }
  },
});
