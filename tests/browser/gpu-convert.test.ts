import { assert, assertEquals } from '@std/assert';
import { harness } from './support.ts';
const truth = JSON.parse(await Deno.readTextFile(new URL('../fixtures/truth.json', import.meta.url)));
// The WebGPU converter (the frame's planes copied out and uploaded, the YUV matrix applied in one compute dispatch,
// a mapped readback) replaces copyTo(RGBA) when it measures faster. Ways it could go wrong, each checked below: colours
// off (a wrong plane, matrix or range, U and V swapped, colour management lifting mid-tones, chroma point-sampled at
// sharp edges) or pixels shifted (texel centres, odd sizes, plane strides) relative to the browser's own conversion;
// a layout or matrix it does not convert (BT.2020) taken instead of left to the fallback; a frame lost or duplicated when a pass stops
// with a prefetched conversion in flight; a GPU path taken where it must not be (no WebGPU, no adapter, a rotated
// container, a first frame that disagrees with the fallback, a GPU that measures slower, the CPU-only setting); a run
// that mixes GPU and fallback frames, including after the device is lost mid-run, when it must fail instead.
Deno.test({
  name: "browser: the WebGPU converter matches Chrome's copyTo(RGBA) closely and is taken only when it agrees and is faster",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const h = await harness();
    try {
      await h.page.goto(h.base + '/harness.html');
      await h.page.waitForFunction('!!window.longScreenKit');
      const r = await h.page.evaluate(async () => {
        const kit = (window as any).longScreenKit;
        const stats = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
          let sum = 0, signed = 0, max = 0, far = 0, n = 0, opaque = true;
          for (let i = 0; i < a.length; i += 4) {
            if (b[i + 3] !== 255) opaque = false;
            for (let c = 0; c < 3; c++) {
              const d = b[i + c] - a[i + c];
              sum += Math.abs(d);
              signed += d;
              max = Math.max(max, Math.abs(d));
              if (Math.abs(d) > 48) far++;
              n++;
            }
          }
          return { mean: sum / n, signed: signed / n, max, far: far / n, opaque, sameLength: a.length === b.length };
        };
        const vsTruth = (images: { width: number; data: Uint8ClampedArray }[]) => {
          const scenario = kit.buildScenario('fixture');
          let sum = 0, n = 0;
          images.forEach((img, i) => {
            const t = kit.renderFrame(scenario, i).image;
            for (let p = 0; p < t.data.length; p += 4) for (let c = 0; c < 3; c++) (sum += Math.abs(img.data[p + c] - t.data[p + c])), n++;
          });
          return sum / n;
        };
        const counted = (inner: any) => {
          const f: any = (frame: VideoFrame, info: unknown) => (f.calls++, inner(frame, info));
          f.calls = 0;
          return f;
        };
        const grab = async (name: string, convert: unknown, limit = Infinity) => {
          const blob = await (await fetch('/fixtures/' + name)).blob();
          const source = await kit.openMedia(new File([blob], name), convert);
          const images: { width: number; height: number; data: Uint8ClampedArray; time: number }[] = [];
          let error = '';
          try {
            for await (const f of source.frames()) {
              images.push({ width: f.image.width, height: f.image.height, data: f.image.data.slice(), time: f.time });
              if (images.length >= limit) break;
            }
          } catch (e) {
            error = String(e);
          }
          return { source, images, error };
        };
        const out: Record<string, unknown> = {};
        // Real decoded frames, GPU forced past the speed calibration (fixtures are small enough that copyTo can win
        // it), so the fallback converts the first frame once, for the agreement check: close to the browser's own
        // conversion and to the world the fixture was rendered from.
        for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'negative-cts.mov']) {
          const direct = await grab(name, kit.directConverter());
          direct.source.dispose();
          const fallback = counted(kit.directConverter());
          const gpu = kit.gpuConverter(fallback, 'webgpu');
          const mine = await grab(name, gpu);
          // A stopped pass with a prefetched conversion in flight, then another full pass, on the same source.
          const stopped: typeof mine.images = [], again: typeof mine.images = [];
          for await (const f of mine.source.frames()) {
            stopped.push({ width: f.image.width, height: f.image.height, data: f.image.data.slice(), time: f.time });
            if (stopped.length >= 3) break;
          }
          for await (const f of mine.source.frames()) {
            again.push({ width: f.image.width, height: f.image.height, data: f.image.data.slice(), time: f.time });
          }
          mine.source.dispose();
          const per = direct.images.map((d, i) => stats(d.data, mine.images[i].data));
          out[name] = {
            frames: mine.images.length,
            gpu: gpu.gpu,
            check: gpu.check,
            fallbackCalls: fallback.calls,
            mean: Math.max(...per.map((s) => s.mean)),
            signed: per.reduce((a, s) => a + s.signed, 0) / per.length,
            max: Math.max(...per.map((s) => s.max)),
            far: Math.max(...per.map((s) => s.far)),
            opaque: per.every((s) => s.opaque && s.sameLength),
            meanVsTruth: vsTruth(mine.images),
            stoppedPrefix: stopped.every((s, i) => s.data.every((v, j) => v === mine.images[i].data[j])),
            secondPass: again.length === mine.images.length && again.every((s, i) => s.data.every((v, j) => v === mine.images[i].data[j])),
            error: mine.error,
          };
        }
        // The shipped chain: the conversion worker decides and converts on its own thread.
        {
          const direct = await grab('scroll.mp4', kit.directConverter());
          direct.source.dispose();
          for (const compute of ['webgpu', 'cpu']) {
            const run = await grab('scroll.mp4', kit.frameConverter(compute));
            const conversion = run.source.conversion();
            run.source.dispose();
            const per = direct.images.map((d, i) => stats(d.data, run.images[i].data));
            out[`worker ${compute}`] = {
              conversion,
              frames: run.images.length,
              mean: Math.max(...per.map((s) => s.mean)),
              max: Math.max(...per.map((s) => s.max)),
              far: Math.max(...per.map((s) => s.far)),
              error: run.error,
            };
          }
        }
        // Frames built from buffers at an odd size (no row of the output is a multiple of the workgroup or of 256
        // bytes), against Chrome's own conversion of the same frame.
        const W = 67, H = 45, cw = Math.ceil(W / 2), ch = Math.ceil(H / 2);
        let seed = 7;
        const bytes = (n: number) => Uint8Array.from({ length: n }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
        // Smooth planes: random noise would make every pixel a sharp chroma edge, where any two filters differ.
        const smooth = (w: number, h: number) => {
          const base = bytes(4);
          return Uint8Array.from(
            { length: w * h },
            (_, i) => base[0] / 2 + 64 + 40 * Math.sin((i % w) / 9 + base[1]) + 30 * Math.cos(Math.floor(i / w) / 7 + base[2]),
          );
        };
        const Y = smooth(W, H), U = smooth(cw, ch), V = smooth(cw, ch);
        const nv12 = new Uint8Array(W * H + cw * ch * 2);
        nv12.set(Y);
        for (let i = 0; i < cw * ch; i++) nv12.set([U[i], V[i]], W * H + i * 2);
        const info = { codedWidth: W, codedHeight: H, rotation: 0, width: W, height: H };
        for (const [format, data] of [['I420', new Uint8Array([...Y, ...U, ...V])], ['NV12', nv12]] as [string, Uint8Array][]) {
          for (
            const [matrix, fullRange] of [['bt709', false], ['bt709', true], ['smpte170m', false], ['smpte170m', true], [
              'bt2020-ncl',
              false,
            ]] as [string, boolean][]
          ) {
            const primaries = matrix === 'bt2020-ncl' ? 'bt2020' : matrix === 'smpte170m' ? 'smpte170m' : 'bt709';
            const colorSpace = { matrix, fullRange, primaries, transfer: 'bt709' };
            const frame = new VideoFrame(data, { format, codedWidth: W, codedHeight: H, timestamp: 0, colorSpace } as any);
            const reference = new Uint8ClampedArray(W * H * 4);
            await frame.copyTo(reference, { format: 'RGBA', colorSpace: 'srgb' } as any);
            const gpu = kit.gpuConverter(() => ({ width: W, height: H, data: reference.slice() }), 'webgpu');
            const mine = await gpu(frame, info);
            out[`${format} ${matrix} full=${fullRange}`] = {
              gpu: gpu.gpu,
              size: [mine.width, mine.height],
              ...stats(reference, mine.data),
            };
            frame.close();
            gpu.dispose();
          }
        }
        // Where the GPU path must not be taken: every frame then comes from the fallback.
        const declined = async (label: string, name: string, make: (fallback: unknown) => any) => {
          const fallback = counted(kit.directConverter());
          const gpu = make(fallback);
          const run = await grab(name, gpu);
          run.source.dispose();
          out[label] = {
            gpu: gpu.gpu,
            fallbackCalls: fallback.calls,
            frames: run.images.length,
            describe: gpu.describe(),
            error: run.error,
          };
        };
        await declined('no WebGPU', 'scroll.mp4', (f) => kit.gpuConverter(f, 'auto', null));
        await declined('no adapter', 'scroll.mp4', (f) => kit.gpuConverter(f, 'auto', { requestAdapter: async () => null }));
        await declined('CPU only', 'scroll.mp4', (f) => kit.gpuConverter(f, 'cpu'));
        await declined('rotated', 'rotated.mp4', (f) => kit.gpuConverter(f, 'webgpu'));
        {
          // A first frame the fallback converts differently (here: flat grey) rejects the GPU for the whole run.
          let calls = 0;
          const grey = (_frame: VideoFrame, i: { codedWidth: number; codedHeight: number }) => {
            calls++;
            return { width: i.codedWidth, height: i.codedHeight, data: new Uint8ClampedArray(i.codedWidth * i.codedHeight * 4).fill(128) };
          };
          const gpu = kit.gpuConverter(grey, 'webgpu');
          const run = await grab('scroll.mp4', gpu);
          run.source.dispose();
          out['disagreeing first frame'] = {
            gpu: gpu.gpu,
            fallbackCalls: calls,
            frames: run.images.length,
            allGrey: run.images.every((im) => im.data.every((v, j) => (j & 3) === 3 || v === 128)),
          };
        }
        {
          // A fallback that answers instantly (each frame's own copyTo, converted ahead of time and found by its
          // timestamp) agrees with the GPU but beats its round trip, so the measured choice is the fallback.
          const direct = await grab('scroll.mp4', kit.directConverter());
          direct.source.dispose();
          const instant = (frame: VideoFrame) => direct.images.find((im) => Math.abs(im.time - frame.timestamp / 1e6) < 1e-3)!;
          const gpu = kit.gpuConverter(instant, 'auto');
          const run = await grab('scroll.mp4', gpu);
          run.source.dispose();
          out['slower GPU'] = { gpu: gpu.gpu, check: gpu.check, frames: run.images.length };
        }
        {
          // The device lost after the GPU was chosen: the run fails rather than continuing on the fallback.
          let device: { destroy(): void } | undefined;
          const real = (navigator as any).gpu;
          const provider = {
            requestAdapter: async (o: unknown) => {
              const adapter = await real.requestAdapter(o);
              return {
                features: adapter.features,
                limits: adapter.limits,
                info: adapter.info,
                requestDevice: async (d: unknown) => (device = await adapter.requestDevice(d)),
              };
            },
          };
          const fallback = counted(kit.directConverter());
          const gpu = kit.gpuConverter(fallback, 'webgpu', provider);
          const blob = await (await fetch('/fixtures/scroll.mp4')).blob();
          const source = await kit.openMedia(new File([blob], 'scroll.mp4'), gpu);
          let n = 0, error = '';
          try {
            for await (const _f of source.frames()) {
              if (++n === 5) device!.destroy();
            }
          } catch (e) {
            error = String(e);
          }
          source.dispose();
          out['device lost'] = { gpu: gpu.gpu, frames: n, fallbackCalls: fallback.calls, error, describe: gpu.describe() };
        }
        return out;
      });
      for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'negative-cts.mov']) {
        const v = r[name] as any;
        console.log(
          `${name}: mean ${v.mean.toFixed(3)} signed ${v.signed.toFixed(3)} max ${v.max} far ${v.far.toFixed(5)}, vs truth ${
            v.meanVsTruth.toFixed(2)
          }`,
        );
        assertEquals([v.frames, v.gpu, v.fallbackCalls, v.error], [truth.frames, true, 1, ''], `${name}: ${JSON.stringify(v.check)}`);
        // Chrome decodes these small fixtures in software and its copyTo then point-samples chroma, so a hard
        // synthetic colour edge differs from the GPU's interpolated chroma by tens of levels in a few pixels: the
        // bound is on the mean, the bias and the share of far-off values (the planar converter's own gate).
        assert(v.mean <= 2 && Math.abs(v.signed) <= 1 && v.far <= 0.01, `${name}: ${v.mean} / ${v.signed} / ${v.far} from copyTo(RGBA)`);
        assert(v.opaque, `${name}: RGBA must be opaque and full size`);
        assert(v.meanVsTruth <= 4, `${name}: mean channel distance from the rendered world ${v.meanVsTruth}`);
        assert(v.stoppedPrefix && v.secondPass, `${name}: a stopped pass or the pass after it differs`);
      }
      const viaGPU = r['worker webgpu'] as any, viaCopy = r['worker cpu'] as any;
      console.log(`worker webgpu: ${viaGPU.conversion}; worker cpu: ${viaCopy.conversion}`);
      assertEquals([viaGPU.frames, viaGPU.error], [truth.frames, ''], 'worker webgpu');
      assert(/^WebGPU planes .* in a worker/.test(viaGPU.conversion), `worker webgpu: ${viaGPU.conversion}`);
      assert(viaGPU.mean <= 2 && viaGPU.far <= 0.01, `worker webgpu: ${viaGPU.mean} / ${viaGPU.far} from copyTo(RGBA)`);
      assertEquals([viaCopy.frames, viaCopy.error, viaCopy.max], [truth.frames, '', 0], `worker cpu: ${viaCopy.conversion}`);
      // On the CPU the converter may spread frames over several workers (src/media/convert.ts).
      assert(
        /^copyTo\(RGBA\)( \(WebGPU declined: CPU only\))? in (a worker|\d workers)/.test(viaCopy.conversion),
        `worker cpu: ${viaCopy.conversion}`,
      );
      for (const format of ['I420', 'NV12']) {
        for (const range of ['bt709 full=false', 'bt709 full=true', 'smpte170m full=false', 'smpte170m full=true']) {
          const key = `${format} ${range}`, v = r[key] as any;
          console.log(`${key}: mean ${v.mean.toFixed(3)} signed ${v.signed.toFixed(3)} max ${v.max}`);
          assertEquals([v.gpu, v.size, v.opaque, v.sameLength], [true, [67, 45], true, true], key);
          assert(v.mean <= 2 && v.max <= 16 && Math.abs(v.signed) <= 1, `${key}: ${v.mean} / ${v.signed} / ${v.max} from copyTo(RGBA)`);
        }
        // BT.2020's gamut is mapped by browsers, not by a matrix alone: left to the fallback (which returns the reference).
        const v = r[`${format} bt2020-ncl full=false`] as any;
        assertEquals([v.gpu, v.max], [false, 0], `${format} bt2020`);
      }
      for (const key of ['no WebGPU', 'no adapter', 'CPU only']) {
        const v = r[key] as any;
        assertEquals([v.gpu, v.fallbackCalls, v.frames, v.error], [false, truth.frames, truth.frames, ''], `${key}: ${v.describe}`);
      }
      const rotated = r['rotated'] as any;
      assertEquals([rotated.gpu, rotated.fallbackCalls === rotated.frames, rotated.error], [false, true, ''], 'rotated');
      const grey = r['disagreeing first frame'] as any;
      assertEquals([grey.gpu, grey.frames, grey.allGrey], [false, truth.frames, true], 'disagreeing first frame');
      assert(grey.fallbackCalls >= truth.frames, `disagreeing first frame: ${grey.fallbackCalls} fallback calls`);
      const slower = r['slower GPU'] as any;
      assertEquals([slower.gpu, slower.frames], [false, truth.frames], `slower GPU: ${JSON.stringify(slower.check)}`);
      assert(
        slower.check.meanDiff <= 2 && slower.check.fallbackMS < slower.check.gpuMS,
        `slower GPU: declined for speed (${JSON.stringify(slower.check)})`,
      );
      const lost = r['device lost'] as any;
      assertEquals(lost.gpu, true, `device lost: the GPU had been chosen (${lost.describe})`);
      assert(/GPU/.test(lost.error) && lost.frames < truth.frames, `device lost: ${lost.frames} frames, error ${lost.error}`);
      assertEquals(lost.fallbackCalls, 1, 'device lost: no frame after the loss may come from the fallback');
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
Deno.test({
  name: 'browser (WebKit): the WebGPU converter is either taken and faithful or declined cleanly',
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
        const blob = await (await fetch('/fixtures/scroll.mp4')).blob();
        const chain = kit.workerConverter(new URL('./assets/convert-worker.js', location.href), kit.directConverter());
        const gpu = kit.gpuConverter(chain, 'webgpu');
        const source = await kit.openMedia(new File([blob], 'scroll.mp4'), gpu);
        let sum = 0, n = 0, frames = 0;
        for await (const f of source.frames()) {
          const t = kit.renderFrame(scenario, frames++).image;
          for (let p = 0; p < t.data.length; p += 4) {
            for (let c = 0; c < 3; c++) (sum += Math.abs(f.image.data[p + c] - t.data[p + c])), n++;
          }
        }
        source.dispose();
        return { gpu: gpu.gpu, describe: gpu.describe(), frames, meanVsTruth: sum / n, webgpu: !!(navigator as any).gpu };
      });
      console.log(`WebKit: WebGPU ${r.webgpu}, converter: ${r.describe}, mean vs truth ${r.meanVsTruth.toFixed(2)}`);
      assertEquals(r.frames, (JSON.parse(await Deno.readTextFile(new URL('../fixtures/truth.json', import.meta.url)))).frames);
      assert(r.meanVsTruth <= 4, `mean channel distance from the rendered world ${r.meanVsTruth}`);
      assertEquals(h.errors, []);
    } finally {
      await h.close();
    }
  },
});
