/** Deterministic encoded fixtures. ffmpeg is a test-time dependency only; nothing here ships to the browser. */
import { buildScenario } from '../src/synthetic/scenarios.ts';
import { renderFrame } from '../src/synthetic/world.ts';
import { encodeRGBA } from '../src/codec/png.ts';
const root = new URL('../tests/fixtures/', import.meta.url);
await Deno.mkdir(root, { recursive: true });
const scenario = buildScenario('fixture'), { width, height } = scenario, fps = 30;
const frames: Uint8Array[] = [];
for (let i = 0; i < scenario.frames.length; i++) {
  const { image } = renderFrame(scenario, i), rgb = new Uint8Array(width * height * 3);
  for (let p = 0, q = 0; p < image.data.length; p += 4, q += 3) {
    rgb[q] = image.data[p];
    rgb[q + 1] = image.data[p + 1];
    rgb[q + 2] = image.data[p + 2];
  }
  frames.push(rgb);
}
const raw = new Uint8Array(frames.length * width * height * 3);
frames.forEach((f, i) => raw.set(f, i * f.length));
async function ffmpeg(args: string[], input?: Uint8Array): Promise<void> {
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  const cmd = new Deno.Command('ffmpeg', {
    args: [...base, ...args],
    stdin: input ? 'piped' : 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const child = cmd.spawn();
  if (input) {
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const status = await child.status;
  if (!status.success) {
    throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  }
}
const rawInput = [
  '-f',
  'rawvideo',
  '-pixel_format',
  'rgb24',
  '-video_size',
  `${width}x${height}`,
  '-framerate',
  String(fps),
  '-i',
  'pipe:0',
  '-an',
];
const out = (name: string) => new URL(name, root).pathname;
await ffmpeg([
  ...rawInput,
  '-c:v',
  'libx264',
  '-crf',
  '16',
  '-pix_fmt',
  'yuv420p',
  '-bf',
  '2',
  '-g',
  '30',
  '-movflags',
  '+faststart',
  out('scroll.mp4'),
], raw);
await ffmpeg([
  ...rawInput,
  '-c:v',
  'libx264',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-bf',
  '2',
  '-g',
  '15',
  '-movflags',
  'frag_keyframe+empty_moov+default_base_moof',
  out('fragmented.mp4'),
], raw);
await ffmpeg([...rawInput, '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', out('scroll.webm')], raw);
await ffmpeg(['-i', out('scroll.mp4'), '-c', 'copy', out('scroll.mov')]);
// QuickTime-style negative composition offsets (version 1 ctts, signed), as written by modern encoders.
await ffmpeg([
  ...rawInput,
  '-c:v',
  'libx264',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-bf',
  '2',
  '-g',
  '30',
  '-movflags',
  'negative_cts_offsets',
  out('negative-cts.mov'),
], raw);
// ReplayKit writes the same signed offsets in a version-0 ctts box; reproduce that by patching the version byte.
const bytes = await Deno.readFile(out('negative-cts.mov'));
const view = new DataView(bytes.buffer);
function walk(start: number, end: number, path: string[]): number {
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p), header = 8;
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (type === path[0]) {
      if (path.length === 1) {
        return p + header;
      }
      const found = walk(p + header, p + size, path.slice(1));
      if (found >= 0) {
        return found;
      }
    }
    p += size;
  }
  return -1;
}
let patched = 0;
for (let p = 0; p + 8 <= bytes.length;) {
  const size = view.getUint32(p), type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
  if (type === 'moov') {
    for (let t = p + 8; t + 8 <= p + size;) {
      const ts = view.getUint32(t), tt = String.fromCharCode(bytes[t + 4], bytes[t + 5], bytes[t + 6], bytes[t + 7]);
      if (tt === 'trak') {
        const ctts = walk(t + 8, t + ts, ['mdia', 'minf', 'stbl', 'ctts']);
        if (ctts >= 0 && bytes[ctts] === 1) {
          bytes[ctts] = 0;
          patched++;
        }
      }
      t += ts;
    }
  }
  p += size;
}
if (!patched) {
  throw new Error('negative-cts.mov has no version-1 ctts box to patch; fixture would not reproduce the ReplayKit layout.');
}
await Deno.writeFile(out('negative-cts-v0.mov'), bytes);
const truth = {
  width,
  height,
  fixedTop: 32,
  fps,
  frames: scenario.frames.length,
  path: scenario.layers[0].path.map((p) => [p.x, p.y]),
  scenario: 'fixture',
  note: 'negative-cts-v0.mov is negative-cts.mov with the ctts version byte set to 0 (ReplayKit layout).',
};
await Deno.writeTextFile(out('truth.json'), JSON.stringify(truth, null, 2));
await Deno.writeFile(
  out('world.png'),
  await encodeRGBA({ width: scenario.layers[0].world.width, height: scenario.layers[0].world.height, data: scenario.layers[0].world.data }),
);
console.log(`Wrote ${scenario.frames.length} frames × 6 encoded files + truth.json to tests/fixtures`);
