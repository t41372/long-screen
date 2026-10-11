import { assert, assertEquals } from '@std/assert';
import { harness, root } from './support.ts';
// iPhone screen recordings (HEVC 10-bit PQ) list a sample at the end of their single edit that ffmpeg and
// AVFoundation do not present (test_6/7: it starts exactly where the edit ends; test_8: a hundredth of a tick
// before). mediabunny hands every sample to WebCodecs, so the app expects and decodes them all. This runs each
// recording through the shipped decode path and the whole Engine in Chrome and WebKit and records what the app
// counts, decodes and reports (test-results/frame-count/<browser>-<file>.json). test_6 only, unless
// LONGSCREEN_REAL=all; skipped when the recordings are absent (test_case/ is gitignored).
const dir = 'public_test_cases';
const cases = ['test_6_iphone_safari.MP4', 'test_7_iphone_chatgpt.MP4', 'test_8_iphone_signal.MP4'];
const results = `${root}test-results/frame-count/`;
async function present(): Promise<string[]> {
  const found: string[] = [];
  for (const name of Deno.env.get('LONGSCREEN_REAL') === 'all' ? cases : cases.slice(0, 1)) {
    try {
      await Deno.stat(`${root}test_case/${dir}/${name}`);
      found.push(name);
    } catch {
      // absent
    }
  }
  return found;
}
for (const browser of ['chromium', 'webkit'] as const) {
  Deno.test({
    name: `browser: iPhone recordings end complete with every listed frame decoded (${browser}; skipped when absent)`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const names = await present();
      if (!names.length) {
        console.log('skip: no iPhone recordings in test_case/public_test_cases/');
        return;
      }
      await Deno.mkdir(results, { recursive: true });
      const h = await harness({ browser });
      try {
        await h.page.goto(h.base + '/harness.html');
        await h.page.waitForFunction('!!window.longScreenKit');
        for (const name of names) {
          const r = await h.page.evaluate(async (path: string) => {
            const kit = (globalThis as any).longScreenKit, file = new File([await (await fetch(path)).blob()], path.split('/').pop()!);
            const demux = await kit.openDemuxer(file);
            let packets = 0;
            for await (const _ of demux.packets()) packets++;
            demux.dispose();
            const db = await kit.Database.open(), source = await kit.openMedia(file);
            // Frames each decode pass yielded, in pass order, and the last presentation times the first pass saw.
            const passes: number[] = [], tail: number[] = [];
            for (const method of ['frames', 'sparseFrames'] as const) {
              const original = source[method].bind(source);
              source[method] = async function* (...args: unknown[]) {
                const pass = passes.push(0) - 1;
                for await (const f of original(...args)) {
                  passes[pass]++;
                  if (pass === 0) {
                    tail.push(Math.round(f.time * 1e6));
                    if (tail.length > 3) tail.shift();
                  }
                  yield f;
                }
              };
            }
            const diagnostics: { code: string; severity: string; detail?: unknown }[] = [], phases: string[] = [];
            const engine = new kit.Engine(db, source, { ...kit.DEFAULT_SETTINGS }, {
              progress: (p: any) => {
                if (phases.at(-1) !== p.phase) phases.push(p.phase);
              },
              diagnostic: (d: any) => diagnostics.push({ code: d.code, severity: d.severity, detail: d.detail }),
              project: () => {},
            });
            const t0 = performance.now(), project = await engine.run();
            const reveal = await engine.store.get('reveal-summary');
            return {
              file: file.name,
              packets,
              frameCount: source.info.frameCount,
              duration: source.info.duration,
              notices: source.info.notices,
              warnings: source.info.warnings,
              passes,
              tail,
              status: project.status,
              error: project.error,
              frames: project.frames,
              renderedFrames: project.renderedFrames,
              revealRan: !!reveal || phases.includes('revealing'),
              reveal,
              phases,
              diagnostics,
              seconds: Math.round((performance.now() - t0) / 100) / 10,
            };
          }, `/test_case/${dir}/${name}`);
          console.log(browser, name, JSON.stringify({ ...r, diagnostics: r.diagnostics.map((d) => d.code) }));
          await Deno.writeTextFile(`${results}${browser}-${name}.json`, JSON.stringify(r, null, 2));
          assertEquals(r.frameCount, r.packets, `${name}: the expected count is the packets the demuxer hands the decoder`);
          assertEquals(r.frames, r.frameCount, `${name}: scan analysed every listed frame`);
          assert(!r.diagnostics.some((d) => d.code === 'PASS_FRAME_COUNT_MISMATCH'), `${name}: no frame-count mismatch`);
          assertEquals(r.status, 'complete', `${name}: ${r.error ?? ''}`);
          assert(r.revealRan, `${name}: the reveal stage ran`);
        }
      } finally {
        await h.close();
      }
    },
  });
}
