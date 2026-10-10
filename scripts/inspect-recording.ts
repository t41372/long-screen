/** Offline region inspection for a real recording: runs the pipeline's own scan pass (the Engine, stopped as solving
 *  starts) on the frames ffmpeg decodes, then prints the regions it learned and the scan's diagnostics, for checking by
 *  hand which parts of the screen it took for scrolling content, fixed UI or ignored overlays.
 *  An HDR recording (PQ or HLG) is converted as the browser's checked routes do: ffmpeg writes the coded BT.2020
 *  R'G'B', and the core turns it into sRGB.
 *  Usage: deno run --allow-read --allow-run --allow-write --allow-env scripts/inspect-recording.ts test_case/c.mov [analysisSize=640] */
import '../tests/support/core.ts';
import { core } from '../src/core/wasm.ts';
import { hdrToRGBA } from '../src/core/wasm/yuv.ts';
import { Engine } from '../src/pipeline/engine.ts';
import { MemoryKV, Namespace } from '../src/storage/db.ts';
import { DEFAULT_SETTINGS, type FrameImage, type FrameSource, type MediaInfo, type Region } from '../src/types.ts';

const file = Deno.args[0], analysisSize = Number(Deno.args[1] || 640);
if (!file) {
  throw new Error('usage: inspect-recording.ts <video> [analysisSize]');
}
async function run(command: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(command, { args, stdout: 'piped', stderr: 'inherit' }).output();
  if (!out.success) throw new Error(`${command} ${args.join(' ')} failed`);
  return new TextDecoder().decode(out.stdout);
}
const stream = JSON.parse(
  await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,color_transfer:format=duration',
    '-of',
    'json',
    file,
  ]),
);
const { width, height, codec_name: codec, color_transfer: colourTransfer } = stream.streams[0];
const transfer = colourTransfer === 'smpte2084' ? 'pq' : colourTransfer === 'arib-std-b67' ? 'hlg' : undefined;
// Presentation times, in the order ffmpeg's passthrough output delivers the frames (the recordings are variable rate).
const times = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]))
  .trim().split('\n').map(Number).sort((a, b) => a - b);

class FfmpegSource implements FrameSource {
  info: MediaInfo = {
    name: file.split('/').pop()!,
    size: Deno.statSync(file).size,
    width,
    height,
    codedWidth: width,
    codedHeight: height,
    rotation: 0,
    duration: Number(stream.format.duration),
    frameCount: times.length,
    codec,
    mode: 'ffmpeg (inspect-recording.ts)',
    // DECODED_VIDEO_NOISE in src/media/source.ts.
    noise: 10,
    warnings: [],
    notices: [],
  };
  private stopped = false;
  async *frames(): AsyncGenerator<FrameImage> {
    const ffmpeg = new Deno.Command('ffmpeg', {
      args: [
        '-v',
        'error',
        '-i',
        file,
        ...(transfer ? ['-vf', 'scale=in_color_matrix=bt2020:in_range=tv:out_range=pc'] : []),
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      stdout: 'piped',
      // Closed early once the scan is done, ffmpeg reports a broken pipe; its errors are shown only for a read that failed.
      stderr: 'piped',
    }).spawn();
    const errors = new Response(ffmpeg.stderr).text();
    const reader = ffmpeg.stdout.getReader(), frameBytes = width * height * 4;
    let frame = new Uint8ClampedArray(frameBytes), filled = 0, index = 0, carry: Uint8Array | undefined;
    try {
      while (!this.stopped) {
        while (filled < frameBytes) {
          const chunk = carry ?? (await reader.read()).value;
          carry = undefined;
          if (!chunk) break;
          const take = Math.min(chunk.length, frameBytes - filled);
          frame.set(chunk.subarray(0, take), filled);
          filled += take;
          if (take < chunk.length) carry = chunk.subarray(take);
        }
        if (filled < frameBytes) {
          if (index < times.length) throw new Error(`ffmpeg stopped after ${index} of ${times.length} frames: ${await errors}`);
          break;
        }
        if (transfer) hdrToRGBA(core(), frame, 'rgba8', width, height, transfer);
        const time = times[index] ?? index / 60, next = times[index + 1] ?? time + 1 / 60;
        yield { image: { width, height, data: frame }, time, duration: next - time, index: index++ };
        frame = new Uint8ClampedArray(frameBytes);
        filled = 0;
      }
    } finally {
      await reader.cancel().catch(() => {});
      ffmpeg.kill();
      await ffmpeg.status;
      await errors;
    }
  }
  dispose(): void {
    this.stopped = true;
  }
}

const db = new MemoryKV(), diagnostics = new Map<string, number>(), started = performance.now();
const engine: Engine = new Engine(db, new FfmpegSource(), { ...DEFAULT_SETTINGS, analysisSize }, {
  progress: (p) => {
    if (p.phase !== 'scanning' && p.frames > 0) engine.stop();
  },
  diagnostic: (d) => void diagnostics.set(d.code, (diagnostics.get(d.code) ?? 0) + 1),
  project: () => {},
});
const project = await engine.run();
const regions = (await new Namespace(db, `run/${project.id}/`).get<Region[]>('regions')) ?? [];
console.log(
  `${file}: ${width}×${height} ${codec}${transfer ? ` (${transfer.toUpperCase()})` : ''}, ${times.length} frames, analysis ` +
    `${analysisSize}, scanned in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
for (const r of regions) {
  const crop = r.crop && JSON.stringify(r.crop) !== JSON.stringify(r.rect) ? ` crop ${JSON.stringify(r.crop)}` : '';
  console.log(`${r.id} ${r.kind} ${r.name} ${JSON.stringify(r.rect)}${crop}${r.solid ? ' solid' : ''}${r.unassigned ? ' unassigned' : ''}`);
}
console.log('scan diagnostics:', [...diagnostics].map(([code, n]) => `${code}×${n}`).join(' '));
