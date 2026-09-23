import { assert, assertEquals } from '@std/assert';
import { harness, realRecordings } from './support.ts';
const truth = JSON.parse(await Deno.readTextFile(new URL('../fixtures/truth.json', import.meta.url)));
Deno.test({
  name: 'browser: WebCodecs decodes every fixture container in presentation order, including ReplayKit-style negative ctts',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'scroll.webm', 'negative-cts.mov', 'negative-cts-v0.mov']) {
        const r = await h.page.evaluate(async (name: string) => {
          const kit = (window as any).longScreenKit, blob = await (await fetch('/fixtures/' + name)).blob(), file = new File([blob], name);
          const source = await kit.openMedia(file);
          let count = 0, last = -Infinity, mono = true, first: number | undefined;
          for await (const f of source.frames()) {
            if (f.time < last) {
              mono = false;
            }
            first ??= f.time;
            last = f.time;
            if (f.image.width !== 320 || f.image.height !== 240 || f.image.data.length !== 320 * 240 * 4) {
              throw new Error('frame geometry');
            }
            count++;
          }
          source.dispose();
          return { frames: count, first, last, mono, codec: source.info.codec, notices: source.info.notices };
        }, name);
        assertEquals(r.frames, truth.frames, name);
        assert(r.mono, `${name}: presentation order`);
        assertEquals(r.notices, [], name);
        assert(r.last < 2, `${name}: last pts ${r.last}`);
      }
      assertEquals(h.errors, []);
      assertEquals(h.external, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name:
    'browser: the direct copyTo(RGBA) converter is taken (no silent canvas fallback) and agrees with the canvas path within decoder noise',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit, blob = await (await fetch('/fixtures/scroll.mp4')).blob();
        // A fallback that records being called: the direct path must never reach it for a plain H.264 recording.
        let fallbacks = 0;
        const canvas = kit.canvasConverter();
        const direct = kit.directConverter((frame: VideoFrame, info: unknown) => {
          fallbacks++;
          return canvas(frame, info);
        });
        const decode = async (convert: unknown) => {
          const source = await kit.openMedia(new File([blob], 'scroll.mp4'), convert);
          const frames: { width: number; height: number; data: Uint8ClampedArray }[] = [];
          for await (const f of source.frames()) frames.push(f.image);
          source.dispose();
          return frames;
        };
        const a = await decode(direct), b = await decode(kit.canvasConverter());
        let maxDiff = 0, sum = 0, n = 0, opaque = true;
        for (let i = 0; i < a.length; i++) {
          if (a[i].width !== b[i].width || a[i].height !== b[i].height) throw new Error('geometry differs between converters');
          const x = a[i].data, y = b[i].data;
          for (let k = 0; k < x.length; k += 4) {
            if (x[k + 3] !== 255) opaque = false;
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(x[k + c] - y[k + c]);
              if (d > maxDiff) maxDiff = d;
              sum += d;
              n++;
            }
          }
        }
        return { frames: a.length, fallbacks, maxDiff, meanDiff: sum / n, opaque };
      });
      assertEquals(r.frames, truth.frames);
      assertEquals(r.fallbacks, 0, 'direct copyTo path was not taken');
      assert(r.opaque, 'RGBA copy must be opaque');
      // Both paths are browser YUV→sRGB conversions of the same decoded surface; they may differ by rounding but
      // never by content. DECODED_VIDEO_NOISE (10) is the pipeline's own tolerance for exactly this class of difference.
      assert(r.meanDiff <= 1, `mean channel difference ${r.meanDiff}`);
      assert(r.maxDiff <= 10, `max channel difference ${r.maxDiff}`);
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name:
    'browser: off-thread conversion yields byte-identical frames in the same order, falls back in-thread on a broken worker, and survives a stopped pass',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        type Frame = { index: number; time: number; image: { width: number; height: number; data: Uint8ClampedArray } };
        const collect = async (source: any, limit = Infinity) => {
          const out: Frame[] = [];
          for await (const f of source.frames()) {
            out.push(f);
            if (out.length >= limit) break;
          }
          return out;
        };
        const digest = async (frames: Frame[]) => {
          const parts: string[] = [];
          for (const f of frames) {
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', f.image.data.slice().buffer));
            parts.push(`${f.index}@${f.time}:${f.image.width}x${f.image.height}:${Array.from(hash.slice(0, 8)).join('.')}`);
          }
          return parts;
        };
        const results: Record<string, unknown> = {};
        // negative-cts.mov starts with frames the source skips (negative timestamps): the frame converted ahead of
        // them is dropped, never yielded in their place.
        for (const name of ['scroll.mp4', 'negative-cts.mov']) {
          const blob = await (await fetch('/fixtures/' + name)).blob(),
            open = (convert: unknown) => kit.openMedia(new File([blob], name), convert);
          const direct = await open(kit.directConverter());
          const reference = await digest(await collect(direct));
          const referenceNotices = direct.info.notices;
          direct.dispose();
          const worker = kit.workerConverter(new URL('./assets/convert-worker.js', location.href));
          const source = await open(worker);
          const first = await digest(await collect(source));
          const firstNotices = source.info.notices;
          // A pass stopped after three frames (with the next frame's conversion in flight) must leave the
          // converter usable, and the next full pass on the same source must be identical again.
          const stopped = await digest(await collect(source, 3));
          const second = await digest(await collect(source));
          const counts = { ...worker.counts };
          source.dispose();
          const broken = kit.workerConverter(new URL('./assets/missing-convert-worker.js', location.href));
          const fallbackSource = await open(broken);
          const fallback = await digest(await collect(fallbackSource));
          fallbackSource.dispose();
          results[name] = {
            frames: reference.length,
            sameAsDirect: JSON.stringify(first) === JSON.stringify(reference),
            sameNotices: JSON.stringify(firstNotices) === JSON.stringify(referenceNotices),
            stoppedPrefix: JSON.stringify(stopped) === JSON.stringify(reference.slice(0, 3)),
            secondPass: JSON.stringify(second) === JSON.stringify(reference),
            counts,
            fallbackSame: JSON.stringify(fallback) === JSON.stringify(reference),
            fallbackCounts: { ...broken.counts },
          };
        }
        return results;
      });
      for (const [name, v] of Object.entries(r) as [string, any][]) {
        assertEquals(v.frames, truth.frames, name);
        assert(v.sameAsDirect, `${name}: worker frames differ from in-thread copyTo`);
        assert(v.sameNotices, `${name}: notices differ`);
        assert(v.stoppedPrefix && v.secondPass, `${name}: stopped pass or following pass differs`);
        // Every yielded frame of the three passes came from the worker (skipped frames may add early conversions).
        assert(v.counts.worker >= 2 * truth.frames + 3, `${name}: worker path not taken (${JSON.stringify(v.counts)})`);
        assertEquals(v.counts.inThread, 0, `${name}: in-thread conversions`);
        assertEquals(v.counts.reason, undefined, name);
        assert(v.fallbackSame, `${name}: in-thread fallback frames differ`);
        assertEquals(v.fallbackCounts.worker, 0, name);
        assert(/conversion worker/.test(v.fallbackCounts.reason), `${name}: fallback reason ${v.fallbackCounts.reason}`);
      }
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name:
    'browser: F18 — a container that declares rotation 90 (tkhd matrix, no pixel transposed) is rotated by canvasConverter with the stored pixels intact',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        const truth = kit.renderFrame(kit.buildScenario('fixture'), 0).image;
        const blob = await (await fetch('/fixtures/rotated.mp4')).blob(), file = new File([blob], 'rotated.mp4');
        const source = await kit.openMedia(file);
        const at = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
          const i = (y * img.width + x) * 4;
          return [img.data[i], img.data[i + 1], img.data[i + 2]];
        };
        let first: { width: number; height: number; data: Uint8ClampedArray } | undefined, count = 0;
        for await (const f of source.frames()) {
          if (f.index === 0) {
            first = f.image;
          }
          count++;
        }
        source.dispose();
        // 320×240 storage rotates to a 240×320 canvas. A source pixel (sx,sy) lands, under a 90° rotation as this
        // demuxer reports it, at (codedHeight-1-sy, sx); the opposite direction (270°) would instead put it at
        // (sy, codedWidth-1-sx) — checked too, so a wrong sign in the rotation math would not go unnoticed.
        const samples: [number, number][] = [[80, 60], [240, 150], [160, 200]];
        const results = samples.map(([sx, sy]) => {
          const truthColor = at(truth, sx, sy);
          const rightColor = at(first!, 239 - sy, sx);
          const wrongColor = at(first!, sy, 319 - sx);
          const diff = (a: number[], b: number[]) => Math.max(...a.map((c, i) => Math.abs(c - b[i])));
          return { sx, sy, diffRight: diff(truthColor, rightColor), diffWrong: diff(truthColor, wrongColor) };
        });
        return {
          frames: count,
          width: first!.width,
          height: first!.height,
          info: {
            width: source.info.width,
            height: source.info.height,
            codedWidth: source.info.codedWidth,
            codedHeight: source.info.codedHeight,
            rotation: source.info.rotation,
          },
          results,
        };
      });
      assertEquals(r.frames, truth.frames);
      assertEquals(r.width, 240);
      assertEquals(r.height, 320);
      assertEquals(r.info, { width: 240, height: 320, codedWidth: 320, codedHeight: 240, rotation: 90 });
      for (const s of r.results) {
        assert(s.diffRight <= 8, `sample (${s.sx},${s.sy}): rotated pixel differs by ${s.diffRight}`);
      }
      assert(
        r.results.some((s) => s.diffWrong > 20),
        'sanity check: the opposite rotation direction must not also match, or this test would be vacuous',
      );
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser: real recordings in test_case/ decode completely (skipped when absent)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const names = await realRecordings();
    if (!names.length) {
      console.log('skip: no recordings in test_case/');
      return;
    }
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      for (const name of names) {
        const r = await h.page.evaluate(async (name: string) => {
          const kit = (window as any).longScreenKit, blob = await (await fetch('/test_case/' + name)).blob(), file = new File([blob], name);
          const demux = await kit.openDemuxer(file);
          let packets = 0;
          for await (const _ of demux.packets()) {
            packets++;
          }
          const source = await kit.openMedia(file), t0 = performance.now();
          let count = 0, last = -Infinity, mono = true;
          for await (const f of source.frames()) {
            if (f.time < last) {
              mono = false;
            }
            last = f.time;
            count++;
          }
          source.dispose();
          return { packets, frames: count, mono, last, seconds: Math.round((performance.now() - t0) / 100) / 10, info: source.info };
        }, name);
        console.log(
          name,
          JSON.stringify({ ...r, info: { w: r.info.width, h: r.info.height, codec: r.info.codec, notices: r.info.notices } }),
        );
        assertEquals(r.frames, r.packets, `${name}: every packet became a frame`);
        assert(r.mono, `${name}: presentation order`);
        assert(r.last <= r.info.duration + .1, `${name}: timestamps inside the recording`);
      }
    } finally {
      await h.close();
    }
  },
});
