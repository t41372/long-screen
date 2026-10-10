import { assert, assertEquals, assertMatch } from '@std/assert';
import { harness } from './support.ts';

// Recording formats beyond plain 8-bit SDR, decoded by the shipped converter (`frameConverter`) in Chrome and WebKit and
// compared with the synthetic frames they were encoded from (scripts/make-fixtures.ts). Failure cases: an HDR
// recording handed back with its coded values as if they were sRGB (WebKit tags PQ frames as sRGB: white came out
// at 129) or with the browser's tone mapping (Chrome's canvas and copyTo: background 13 instead of 34); Chrome's
// 10-bit HEVC frames, which have no copyable format, falling to the ~350 ms canvas; a GPU route chosen without its
// first frame agreeing with WebGL's reading of the coded values; a colour that leaves BT.2020 and comes back as
// another (Chrome's external texture also converts primaries); and a recording no browser decodes failing with an
// English codec string instead of the localized reason and advice.
const HDR = ['hdr-pq.mp4', 'hdr-hlg.mp4', 'hdr-pq.webm'];
for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser (${browser}): HDR and 10-bit recordings convert to the screen's sRGB pixels through a checked route`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const results = await h.page.evaluate(async (names: string[]) => {
          // deno-lint-ignore no-explicit-any
          const kit = (window as any).longScreenKit, scenario = kit.buildScenario('fixture');
          const out: Record<string, unknown> = {};
          for (const name of names) {
            const file = new File([await (await fetch('/fixtures/' + name)).blob()], name);
            const source = await kit.openMedia(file);
            let frames = 0, sum = 0, far = 0, n = 0;
            for await (const f of source.frames()) {
              const truth = kit.renderFrame(scenario, f.index).image.data, data = f.image.data;
              for (let k = 0; k < data.length; k += 4) {
                for (let c = 0; c < 3; c++) {
                  const d = Math.abs(data[k + c] - truth[k + c]);
                  sum += d;
                  if (d > 24) far++;
                  n++;
                }
              }
              frames++;
            }
            out[name] = { frames, meanDiff: sum / n, farShare: far / n, report: source.conversionReport(), colour: source.info.colour };
            source.dispose();
          }
          return out;
        }, [...HDR, 'hevc-10bit.mp4']) as Record<
          string,
          {
            frames: number;
            meanDiff: number;
            farShare: number;
            report: { method: string; hdr?: { transfer: string; verified: boolean; aboveShare?: number } };
          }
        >;
        for (const [name, r] of Object.entries(results)) {
          const what = `${name}: ${r.report.method}`;
          assertEquals(r.frames, 43, what);
          // The codec's own loss: an exact 10-bit decode of these files lands at 1.2–1.9 levels on average, 0.2–0.5 %
          // of channel values more than 24 levels off; WebKit's 8-bit planes and the GPU routes add a little.
          assert(r.meanDiff <= 5, `${what}: mean difference ${r.meanDiff.toFixed(2)} from the frames encoded`);
          assert(r.farShare <= 0.01, `${what}: ${(r.farShare * 100).toFixed(2)} % of values more than 24 levels off`);
          if (HDR.includes(name)) {
            assertEquals(r.report.hdr?.transfer, name.includes('hlg') ? 'hlg' : 'pq', what);
            assert(r.report.hdr?.verified, `${what}: route not checked against WebGL's coded values`);
            assert((r.report.hdr?.aboveShare ?? 0) < 0.01, `${what}: SDR content counted above white`);
          } else {
            assertEquals(r.report.hdr, undefined, what);
          }
        }
        if (browser === 'chromium') {
          // Hardware-decoded 10-bit HEVC has no copyable format: read through the GPU, never the 2D canvas.
          for (const name of ['hdr-pq.mp4', 'hdr-hlg.mp4', 'hevc-10bit.mp4']) {
            assertMatch(results[name].report.method, /^(WebGPU external texture|WebGL readback)/, name);
          }
        } else {
          // WebKit's 8-bit planes, tagged as sRGB, go through the core's HDR conversion.
          for (const name of ['hdr-pq.mp4', 'hdr-hlg.mp4']) {
            assertMatch(results[name].report.method, /^planar copyTo \+ core (PQ|HLG)→sRGB \(colour code \d+, first frame/, name);
          }
        }
        assertEquals(h.errors, []);
      } finally {
        await h.close();
      }
    },
  });
  // Compatibility mode (native seeks of a <video>, src/ui/main.ts's frame bridge) on the same HDR recordings. Failure
  // case: frames captured in the browser's colours — an iPhone recording's white came out at 184 in Chrome and 140 in
  // Safari — instead of their coded values converted in the core.
  Deno.test({
    name: `browser (${browser}): compatibility mode converts an HDR recording from its coded values`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const results = await h.page.evaluate(async (names: string[]) => {
          // deno-lint-ignore no-explicit-any
          const kit = (window as any).longScreenKit, scenario = kit.buildScenario('fixture');
          const out: Record<string, unknown> = {};
          for (const name of names) {
            const blob = await (await fetch('/fixtures/' + name)).blob(), probe = await kit.openMedia(new File([blob], name));
            const info = { ...probe.info };
            probe.dispose();
            const video = document.createElement('video');
            video.muted = true;
            video.src = URL.createObjectURL(blob);
            await new Promise((resolve, reject) => {
              video.onloadeddata = resolve;
              video.onerror = () => reject(new Error(`${name}: <video> error ${video.error?.code}`));
            });
            const request = async (time: number, coded: boolean) => {
              video.currentTime = time;
              await new Promise((resolve) => (video.onseeked = resolve));
              return coded ? kit.captureCodedFrame(video) : { bitmap: await kit.captureFrame(video), coded: false };
            };
            // The fixture's own rate, so a seek lands on an encoded frame; a seek can still land one frame early, so
            // each capture is compared with the nearest of three encoded frames.
            const source = new kit.CompatibilitySource(info, 30, request);
            let frames = 0, sum = 0, n = 0;
            for await (const f of source.frames()) {
              let best = Infinity;
              for (const k of [f.index - 1, f.index, f.index + 1]) {
                if (k < 0 || k >= scenario.frames.length) continue;
                const truth = kit.renderFrame(scenario, k).image.data, data = f.image.data;
                let s = 0;
                for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(data[i + c] - truth[i + c]);
                best = Math.min(best, s);
              }
              sum += best;
              n += f.image.width * f.image.height * 3;
              frames++;
            }
            out[name] = { frames, meanDiff: sum / n, report: source.conversionReport() };
            source.dispose();
            URL.revokeObjectURL(video.src);
          }
          return out;
        }, HDR.filter((name) => browser === 'chromium' || name.endsWith('.mp4'))) as Record<
          string,
          { frames: number; meanDiff: number; report?: { method: string; hdr?: { transfer: string; verified: boolean } } }
        >;
        for (const [name, r] of Object.entries(results)) {
          const what = `${name}: ${r.report?.method}`;
          console.log(`${browser} compatibility ${name}: ${r.frames} frames, mean difference ${r.meanDiff.toFixed(2)}`);
          assert(r.frames >= 40, `${what}: ${r.frames} frames`);
          assertEquals(r.report?.hdr?.transfer, name.includes('hlg') ? 'hlg' : 'pq', what);
          assert(r.report?.hdr?.verified, `${what}: read in the browser's colours`);
          assert(r.meanDiff <= 6, `${what}: mean difference ${r.meanDiff.toFixed(2)} from the frames encoded`);
        }
        assertEquals(h.errors, []);
      } finally {
        await h.close();
      }
    },
  });
  Deno.test({
    name: `browser (${browser}): a codec the browser cannot decode is refused with the reason and what to do`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        const results = await h.page.evaluate(async (names: string[]) => {
          // deno-lint-ignore no-explicit-any
          const kit = (window as any).longScreenKit, out: Record<string, string> = {};
          for (const name of names) {
            try {
              const source = await kit.openMedia(new File([await (await fetch('/fixtures/' + name)).blob()], name));
              let frames = 0;
              for await (const _ of source.frames()) frames++;
              source.dispose();
              out[name] = `decoded ${frames}`;
            } catch (error) {
              out[name] = String(error);
            }
          }
          return out;
        }, ['prores.mov', 'h264-444.mp4']);
        // The harness pages run in zh: the reason and the advice come from the catalogue, not an English codec string.
        assertMatch(results['prores.mov'], /UNSUPPORTED_CODEC: 这个浏览器解不了这段录屏的编码（apc[a-z]）。ProRes 没有浏览器能解/);
        if (browser === 'chromium') {
          assertEquals(results['h264-444.mp4'], 'decoded 43');
        } else {
          assertMatch(results['h264-444.mp4'], /UNSUPPORTED_CODEC: .*（avc1\.f4[0-9a-f]+）。这种 H\.264（4:4:4 或 10 位）只有 Chrome 能解/);
        }
        assertEquals(h.errors, []);
      } finally {
        await h.close();
      }
    },
  });
}
