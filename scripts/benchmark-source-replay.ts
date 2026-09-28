/** Decode/upload-only cost of another sequential replay, plus independent exact RGBA replay parity.
 * Usage: deno run -A scripts/benchmark-source-replay.ts f.mov [chromium|webkit] [output.json]
 * Inputs remain under test_case/ and never leave the local browser/server. Hash passes are untimed. */
import { basename } from '@std/path';
import { harness, root } from '../tests/browser/support.ts';

const name = basename(Deno.args[0] ?? 'f.mov');
const browser = Deno.args[1] ?? 'chromium';
if (browser !== 'chromium' && browser !== 'webkit') throw new Error('Browser must be chromium or webkit.');
const out = Deno.args[2] ?? `${root}test-results/source-optimization/decode-${browser}-${name}.json`;
const h = await harness({ browser });
try {
  await h.page.goto(h.base + '/harness.html');
  await h.page.waitForFunction('!!window.longScreenKit');
  const report = await h.page.evaluate(async (name: string) => {
    const kit = (globalThis as any).longScreenKit;
    const file = new File([await (await fetch('/test_case/' + encodeURIComponent(name))).blob()], name);
    const source = await kit.openMedia(file), native = kit.core().frameRing(2, source.info.width, source.info.height);
    const timing = [], hashes: string[][] = [];
    try {
      for (let pass = 0; pass < 2; pass++) {
        let frames = 0;
        const started = performance.now();
        for await (const frame of source.frames()) {
          try {
            native.upload(frame.index, frame.image);
            frames++;
          } finally {
            kit.releaseUnlessHeld(frame.image);
          }
        }
        timing.push({ frames, seconds: (performance.now() - started) / 1000 });
      }
      for (let pass = 0; pass < 2; pass++) {
        const values: string[] = [];
        for await (const frame of source.frames()) {
          try {
            const rgba = frame.image.data;
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba));
            values.push([...hash].map((b) => b.toString(16).padStart(2, '0')).join(''));
          } finally {
            kit.releaseUnlessHeld(frame.image);
          }
        }
        hashes.push(values);
      }
      return { name, info: source.info, compressedBytes: file.size, core: kit.corePlan, timing, hashes };
    } finally {
      native.free();
      source.dispose();
    }
  }, name);
  const parity = report.hashes[0].length > 0 && report.hashes[0].length === report.hashes[1].length &&
    report.hashes[0].every((hash: string, i: number) => hash === report.hashes[1][i]);
  await Deno.mkdir(`${root}test-results/source-optimization`, { recursive: true });
  await Deno.writeTextFile(out, JSON.stringify({ browser, version: h.browser.version(), ...report, parity, errors: h.errors }, null, 2));
  if (!parity || h.errors.length) throw new Error('Sequential replay did not preserve every native RGBA frame.');
  console.log(JSON.stringify({ browser, name, timing: report.timing, parity, output: out }));
} finally {
  await h.close();
}
