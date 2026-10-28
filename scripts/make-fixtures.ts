/** Deterministic encoded fixtures. ffmpeg is a test-time dependency only; nothing here ships to the browser. */
// encodeRGBA calls the Rust core (core()); load the workspace build the tests use before it runs, or regenerating
// world.png throws CORE_NOT_LOADED (see tests/support/core.ts, and scripts/inspect-recording.ts for the same fix).
import '../tests/support/core.ts';
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
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
/** Fixtures already on disk back truth.json-based byte-identity tests, so re-running this script must never touch
 *  them: every output is written only when its file does not already exist yet. Adding a new fixture to this file
 *  therefore only ever creates new files; `git status tests/fixtures` after a run should show nothing else. */
async function ensure(path: string, build: () => Promise<void>): Promise<void> {
  if (await exists(path)) {
    console.log(`skip ${path.split('/').pop()}: already present`);
    return;
  }
  await build();
  console.log(`wrote ${path.split('/').pop()}`);
}
await ensure(
  out('scroll.mp4'),
  () =>
    ffmpeg([
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
    ], raw),
);
await ensure(
  out('fragmented.mp4'),
  () =>
    ffmpeg([
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
    ], raw),
);
// Same content as fragmented.mp4 but without default_base_moof: ffmpeg then has tfhd set base-data-offset-present
// instead, exercising the (already-correct) explicit-offset trun path that real encoders always take (F13).
await ensure(
  out('fragmented-bdo.mp4'),
  () =>
    ffmpeg([
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
      'frag_keyframe+empty_moov',
      out('fragmented-bdo.mp4'),
    ], raw),
);
// The first 90 frames of the demo recording at 320×200 with up to three B-frames in a pyramid, so a frame can wait
// behind two later-decoded ones. Playwright WebKit's WebCodecs decoder hands 35 of these frames back out of
// presentation order, which the source must put right. Not every such stream shows it (scroll.mp4's B-frames never
// wait behind more than one; the same encode at a higher level did not show it either), so this one stays as found.
await ensure(
  out('bframes-pyramid.mp4'),
  () =>
    ffmpeg([
      ...['-i', new URL('../static/demo/sample.mp4', import.meta.url).pathname, '-frames:v', '90', '-vf', 'scale=320:200'],
      ...['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '16', '-bf', '3', '-g', '60', '-pix_fmt', 'yuv420p'],
      ...['-threads', '1', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', out('bframes-pyramid.mp4')],
    ]),
);
await ensure(out('scroll.webm'), () => ffmpeg([...rawInput, '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', out('scroll.webm')], raw));
await ensure(out('scroll.mov'), () => ffmpeg(['-i', out('scroll.mp4'), '-c', 'copy', out('scroll.mov')]));
// QuickTime-style negative composition offsets (version 1 ctts, signed), as written by modern encoders.
await ensure(
  out('negative-cts.mov'),
  () =>
    ffmpeg([
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
    ], raw),
);
// Declares container rotation 90° via the tkhd display matrix, from a stream copy (no pixel is transposed): exercises
// the F18 rotation path end to end (PreciseSource swaps width/height; canvasConverter rotates the drawn canvas).
// -display_rotation is an input-side option (ffmpeg then writes the equivalent tkhd matrix on stream copy); 270
// counter-clockwise here is what yields a +90 clockwise rotation as this demuxer reports it (verified empirically).
await ensure(out('rotated.mp4'), () => ffmpeg(['-display_rotation', '270', '-i', out('scroll.mp4'), '-c', 'copy', out('rotated.mp4')]));
// ReplayKit writes the same signed offsets in a version-0 ctts box; reproduce that by patching the version byte.
await ensure(out('negative-cts-v0.mov'), async () => {
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
});
// The same frames padded with black on the right to 384 px: a width whose decoded rows have no padding in WebKit's
// GStreamer decoder, whose native-layout copyTo drops a padded buffer's stride (every 320-wide fixture above hits
// that). Browser tests use it to show the planar conversion path being taken where copyTo is trustworthy.
await ensure(
  out('scroll-384.mp4'),
  () =>
    ffmpeg([
      ...rawInput,
      '-vf',
      'pad=384:240:0:0:black',
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
      out('scroll-384.mp4'),
    ], raw),
);
await ensure(out('truth.json'), async () => {
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
});
await ensure(out('world.png'), async () => {
  await Deno.writeFile(
    out('world.png'),
    await encodeRGBA({
      width: scenario.layers[0].world.width,
      height: scenario.layers[0].world.height,
      data: scenario.layers[0].world.data,
    }),
  );
});
// Formats screen recorders write that the fixtures above do not cover, from the same frames (so the same truth): HDR
// as iPhones and Macs with HDR displays record it (HEVC Main 10, BT.2020, PQ with SDR white at 100 nits), HLG (SDR
// white at 75 % signal), 10-bit SDR HEVC (Chrome hands its frames back without a copyable format), VP9 Profile 2 PQ
// (10-bit planes in Chrome, RGB frames in Firefox), and two that browsers refuse: H.264 High 4:4:4 (WebKit, Firefox)
// and ProRes (all of them). The PQ/HLG coded values are computed here from the sRGB frames, so a converter that
// gets them back to within the codec's loss has undone the transfer correctly.
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const TO_2020 = [[0.627404, 0.329282, 0.043314], [0.069097, 0.91954, 0.011361], [0.016392, 0.088013, 0.895595]];
const pqOetf = (nits: number) => {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875, p = (Math.max(0, nits) / 10000) ** m1;
  return ((c1 + c2 * p) / (1 + c3 * p)) ** m2;
};
const HLG_A = 0.17883277, HLG_B = 1 - 4 * HLG_A, HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
const hlgOetf = (e: number) => (e <= 1 / 12 ? Math.sqrt(3 * e) : HLG_A * Math.log(12 * e - HLG_B) + HLG_C);
// Scene light of HLG's reference white (the inverse OETF at 75 %).
const HLG_WHITE = (Math.exp((0.75 - HLG_C) / HLG_A) + HLG_B) / 12;
/** Every frame as 10-bit limited-range BT.2020 Y'CbCr 4:2:0 (yuv420p10le), coding `transfer`. */
function hdrFrames(transfer: 'pq' | 'hlg'): Uint8Array {
  const n = width * height, cw = width / 2, ch = height / 2, out = new Uint16Array(frames.length * n * 3 / 2);
  const kr = 0.2627, kb = 0.0593, kg = 1 - kr - kb;
  frames.forEach((rgb, f) => {
    const Y = new Uint16Array(n), Cb = new Float64Array(n), Cr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const l = [0, 1, 2].map((c) => srgbToLinear(rgb[3 * i + c] / 255));
      const [r, g, b] = TO_2020.map((row) => row[0] * l[0] + row[1] * l[1] + row[2] * l[2]).map((v) =>
        transfer === 'pq' ? pqOetf(v * 100) : hlgOetf(v * HLG_WHITE)
      );
      const y = kr * r + kg * g + kb * b;
      Y[i] = Math.round(64 + 876 * y);
      Cb[i] = (b - y) / (2 * (1 - kb));
      Cr[i] = (r - y) / (2 * (1 - kr));
    }
    const base = f * n * 3 / 2;
    out.set(Y, base);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const k = [2 * y * width + 2 * x, 2 * y * width + 2 * x + 1, (2 * y + 1) * width + 2 * x, (2 * y + 1) * width + 2 * x + 1];
        out[base + n + y * cw + x] = Math.round(512 + 896 * k.reduce((s, j) => s + Cb[j], 0) / 4);
        out[base + n + n / 4 + y * cw + x] = Math.round(512 + 896 * k.reduce((s, j) => s + Cr[j], 0) / 4);
      }
    }
  });
  return new Uint8Array(out.buffer);
}
const hdrInput = [
  '-f',
  'rawvideo',
  '-pixel_format',
  'yuv420p10le',
  '-video_size',
  `${width}x${height}`,
  '-framerate',
  String(fps),
  '-i',
  'pipe:0',
  '-an',
];
// Colour tags go on the frames: the encoder writes what the frames carry.
const tags = (trc: string, matrix = 'bt2020nc', primaries = 'bt2020') =>
  `setparams=range=tv:color_primaries=${primaries}:color_trc=${trc}:colorspace=${matrix}`;
const x265 = (trc: string) =>
  `colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited:hdr10=1:repeat-headers=1:log-level=error:` +
  'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,5):max-cll=100,0';
await ensure(
  out('hdr-pq.mp4'),
  () =>
    ffmpeg([
      ...hdrInput,
      '-vf',
      tags('smpte2084'),
      '-c:v',
      'libx265',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p10le',
      '-tag:v',
      'hvc1',
      '-x265-params',
      x265('smpte2084'),
      out('hdr-pq.mp4'),
    ], hdrFrames('pq')),
);
await ensure(
  out('hdr-hlg.mp4'),
  () =>
    ffmpeg([
      ...hdrInput,
      '-vf',
      tags('arib-std-b67'),
      '-c:v',
      'libx265',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p10le',
      '-tag:v',
      'hvc1',
      '-x265-params',
      x265('arib-std-b67'),
      out('hdr-hlg.mp4'),
    ], hdrFrames('hlg')),
);
await ensure(
  out('hdr-pq.webm'),
  () =>
    ffmpeg([
      ...hdrInput,
      '-vf',
      tags('smpte2084'),
      '-c:v',
      'libvpx-vp9',
      '-profile:v',
      '2',
      '-crf',
      '12',
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p10le',
      out('hdr-pq.webm'),
    ], hdrFrames('pq')),
);
const sdr709 = `scale=out_color_matrix=bt709:out_range=limited,${tags('bt709', 'bt709', 'bt709')}`;
await ensure(
  out('hevc-10bit.mp4'),
  () =>
    ffmpeg([
      ...rawInput,
      '-vf',
      sdr709,
      '-c:v',
      'libx265',
      '-crf',
      '14',
      '-pix_fmt',
      'yuv420p10le',
      '-tag:v',
      'hvc1',
      '-x265-params',
      'log-level=error',
      out('hevc-10bit.mp4'),
    ], raw),
);
await ensure(
  out('h264-444.mp4'),
  () => ffmpeg([...rawInput, '-vf', sdr709, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv444p', out('h264-444.mp4')], raw),
);
// Three frames are enough to be refused.
await ensure(
  out('prores.mov'),
  () =>
    ffmpeg(
      [...rawInput, '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le', out('prores.mov')],
      raw.subarray(0, 3 * width * height * 3),
    ),
);
console.log(`Done: ${scenario.frames.length} frames × synthetic scenario; tests/fixtures now has all fixtures (existing ones untouched).`);
