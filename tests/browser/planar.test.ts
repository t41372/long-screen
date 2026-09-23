import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
const truth = JSON.parse(await Deno.readTextFile(new URL('../fixtures/truth.json', import.meta.url)));
// The planar path (copyTo in the frame's own layout + the core's YUV→RGBA) replaces the canvas readback in browsers
// whose copyTo cannot convert to RGB. Ways it could go wrong, each checked below: wrong coefficients or rounding for
// a matrix/range; chroma sampled at the wrong position, or lost on an odd last column/row; U and V swapped in NV12;
// the wrong chroma subsampling for I422/I444; a layout decoders do not produce (RGB, alpha) taken instead of left to
// the canvas; BT.2020 converted by a matrix alone although browsers also map its gamut; a browser's native-layout copyTo
// misplacing planes (WebKit's GStreamer copyTo does on a cropped H.264 frame) and the planar path trusting it; a
// planar frame mixed with canvas frames in one run; a prefetched conversion in flight when a pass stops.
Deno.test({
  name: "browser: planar conversion is byte-identical to Chrome's copyTo(RGBA) on real frames and every layout, matrix and range",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        const firstDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          if (a.length !== b.length) return -2;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
          return -1;
        };
        const decoded: Record<string, unknown> = {};
        for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'negative-cts.mov', 'scroll.webm']) {
          const blob = await (await fetch('/fixtures/' + name)).blob();
          const grab = async (convert: unknown) => {
            const source = await kit.openMedia(new File([blob], name), convert);
            const images: { data: Uint8ClampedArray }[] = [];
            for await (const f of source.frames()) images.push(f.image);
            source.dispose();
            return images;
          };
          let canvasCalls = 0;
          const canvas = kit.canvasConverter();
          const planar = kit.planarConverter((frame: VideoFrame, info: unknown) => (canvasCalls++, canvas(frame, info)));
          const direct = await grab(kit.directConverter()), mine = await grab(planar);
          decoded[name] = {
            frames: mine.length,
            canvasCalls,
            planar: planar.planar,
            check: planar.check,
            firstDiff: direct.map((d, i) => firstDiff(d.data, mine[i].data)).find((x) => x !== -1) ?? -1,
          };
        }
        // Frames Chrome builds from buffers, with Chrome's own conversion of the same frame as the reference. The
        // fallback stands in for the canvas with that reference, so the first-frame check passes exactly when the
        // core's result is close; the frame returned is then the core's, compared byte for byte.
        const W = 67, H = 45, cw = Math.ceil(W / 2), ch = Math.ceil(H / 2);
        let seed = 11;
        const bytes = (n: number) => Uint8Array.from({ length: n }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
        const Y = bytes(W * H), U = bytes(cw * ch), V = bytes(cw * ch), U2 = bytes(cw * H), V2 = bytes(cw * H);
        const U4 = bytes(W * H), V4 = bytes(W * H), RGB = bytes(W * H * 4);
        const nv12 = new Uint8Array(W * H + cw * ch * 2);
        nv12.set(Y);
        for (let i = 0; i < cw * ch; i++) nv12.set([U[i], V[i]], W * H + i * 2);
        const layouts: [string, Uint8Array][] = [
          ['I420', new Uint8Array([...Y, ...U, ...V])],
          ['NV12', nv12],
          ['I422', new Uint8Array([...Y, ...U2, ...V2])],
          ['I444', new Uint8Array([...Y, ...U4, ...V4])],
          ['BGRA', RGB],
          ['RGBX', RGB],
        ];
        const info = { codedWidth: W, codedHeight: H, rotation: 0, width: W, height: H };
        const built: Record<string, unknown> = {};
        for (const [format, data] of layouts) {
          const rgb = /^(BGRA|RGBX)$/.test(format);
          for (const matrix of rgb ? ['rgb'] : ['bt709', 'smpte170m', 'bt470bg', 'bt2020-ncl']) {
            for (const fullRange of rgb ? [true] : [false, true]) {
              const primaries = matrix === 'bt2020-ncl' ? 'bt2020' : matrix === 'smpte170m' || matrix === 'bt470bg' ? 'smpte170m' : 'bt709';
              const colorSpace = rgb
                ? { matrix, fullRange, primaries, transfer: 'iec61966-2-1' }
                : { matrix, fullRange, primaries, transfer: 'bt709' };
              const frame = new VideoFrame(data, { format, codedWidth: W, codedHeight: H, timestamp: 0, colorSpace } as any);
              const reference = new Uint8ClampedArray(W * H * 4);
              await frame.copyTo(reference, { format: 'RGBA', colorSpace: 'srgb' } as any);
              let canvasCalls = 0;
              const planar = kit.planarConverter(() => (canvasCalls++, { width: W, height: H, data: reference.slice() }));
              const mine = await planar(frame, info);
              built[`${format} ${matrix} full=${fullRange}`] = {
                planar: planar.planar,
                canvasCalls,
                firstDiff: firstDiff(reference, mine.data),
              };
              frame.close();
            }
          }
        }
        return { decoded, built };
      });
      for (const [name, v] of Object.entries(r.decoded) as [string, any][]) {
        assertEquals(v.frames, truth.frames, name);
        // One canvas conversion: the first-frame agreement check, never a returned frame.
        assertEquals([v.planar, v.canvasCalls], [true, 1], `${name}: planar path not taken (${JSON.stringify(v.check)})`);
        assertEquals(v.firstDiff, -1, `${name}: first differing byte`);
      }
      assertEquals(Object.keys(r.built).length, 4 * 8 + 2);
      for (const [key, v] of Object.entries(r.built) as [string, any][]) {
        if (key.includes('bt2020') || /^(BGRA|RGBX)/.test(key)) {
          assertEquals([v.planar, v.canvasCalls], [false, 1], `${key}: must be left to the canvas`);
        } else {
          assertEquals([v.planar, v.canvasCalls, v.firstDiff], [true, 1, -1], key);
        }
      }
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser (WebKit): without copyTo(RGBA) the core converts every frame unless the first one disagrees with the canvas',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness({ browser: 'webkit' });
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit', undefined, { timeout: 60000 });
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        const scenario = kit.buildScenario('fixture');
        const results: Record<string, unknown> = {};
        for (const name of ['scroll.mp4', 'scroll.webm', 'negative-cts.mov', 'scroll-384.mp4']) {
          const blob = await (await fetch('/fixtures/' + name)).blob();
          // The shipped default chain, with the canvas at its end counting every call.
          let canvasCalls = 0;
          const canvas = kit.canvasConverter();
          const planar = kit.planarConverter((frame: VideoFrame, info: unknown) => (canvasCalls++, canvas(frame, info)));
          const chain = kit.workerConverter(new URL('./assets/convert-worker.js', location.href), kit.directConverter(planar));
          const source = await kit.openMedia(new File([blob], name), chain);
          const pass = async (limit = Infinity) => {
            const images: { width: number; data: Uint8ClampedArray }[] = [];
            for await (const f of source.frames()) {
              images.push(f.image);
              if (images.length >= limit) break;
            }
            return images;
          };
          const first = await pass(), stopped = await pass(3), again = await pass();
          source.dispose();
          const same = (a: { data: Uint8ClampedArray }[], b: { data: Uint8ClampedArray }[]) =>
            a.length === b.length && a.every((x, i) => x.data.every((v, j) => v === b[i].data[j]));
          // Distance from the synthetic world the fixture was rendered from: whichever path ran must be faithful.
          // scroll-384.mp4 is the same world padded with black on the right; the padding must stay (near) black.
          let sum = 0, n = 0, opaque = true, padding = 0;
          first.forEach((img, i) => {
            const t = kit.renderFrame(scenario, i).image, w = img.width;
            for (let y = 0; y < t.height; y++) {
              for (let x = 0; x < w; x++) {
                const k = (y * w + x) * 4;
                if (img.data[k + 3] !== 255) opaque = false;
                for (let c = 0; c < 3; c++) {
                  if (x < t.width) {
                    sum += Math.abs(img.data[k + c] - t.data[(y * t.width + x) * 4 + c]);
                    n++;
                  } else padding = Math.max(padding, x < t.width + 8 ? 0 : img.data[k + c]);
                }
              }
            }
          });
          results[name] = {
            frames: first.length,
            planar: planar.planar,
            check: planar.check,
            canvasCalls,
            worker: chain.counts.worker,
            stoppedPrefix: same(stopped, first.slice(0, 3)),
            secondPass: same(again, first),
            meanVsTruth: sum / n,
            padding,
            opaque,
          };
        }
        return results;
      });
      for (const [name, v] of Object.entries(r) as [string, any][]) {
        console.log(
          `${name}: planar ${v.planar} ${JSON.stringify(v.check)}, canvas calls ${v.canvasCalls}, mean vs truth ${
            v.meanVsTruth.toFixed(2)
          }`,
        );
        assertEquals(v.frames, truth.frames, name);
        assertEquals(v.worker, 0, `${name}: WebKit has no copyTo(RGBA), so the worker must not claim frames`);
        // Either the core took the run after one agreeing check, or the check failed and the canvas took all of it.
        // Three passes (full, stopped after 3, full); the stopped one may have prefetched one more frame.
        if (v.planar) assertEquals(v.canvasCalls, 1, `${name}: canvas calls`);
        else {assert(
            v.canvasCalls >= 2 * truth.frames + 3 && v.canvasCalls <= 2 * truth.frames + 4,
            `${name}: canvas calls ${v.canvasCalls}`,
          );}
        assert(v.stoppedPrefix && v.secondPass, `${name}: a stopped pass or the pass after it differs`);
        assert(v.opaque, `${name}: RGBA must be opaque`);
        assert(v.meanVsTruth <= 4, `${name}: mean channel distance from the rendered world ${v.meanVsTruth}`);
      }
      // WebKit's GStreamer copyTo drops the padded stride of 320-wide frames (rows really 384 bytes apart): the check
      // must catch it. At 384 wide there is no padding, so the core must take the run.
      assertEquals(
        [(r as any)['scroll.mp4'].planar, (r as any)['negative-cts.mov'].planar],
        [false, false],
        'misplaced rows must be caught',
      );
      assertEquals((r as any)['scroll-384.mp4'].planar, true, 'the unpadded frames must take the planar path');
      assert((r as any)['scroll-384.mp4'].padding <= 24, 'the black padding must stay black');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
