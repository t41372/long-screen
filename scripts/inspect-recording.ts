/** Offline layer inspection for a real recording: streams native frames from ffmpeg, runs the scan pass, prints the learned regions.
 *  Usage: deno run --allow-read --allow-run --allow-write scripts/inspect-recording.ts test_case/c.mov [everyNth=4] [analysisSize=640] */
import { analysisFactor, downscaleGray } from '../src/core/raster.ts';
import { extractFeatures } from '../src/core/features.ts';
import { estimateMotion } from '../src/core/motion.ts';
import { LayerLearner } from '../src/core/layers.ts';
import type { Feature, Gray, MotionField, RGBA } from '../src/types.ts';
const file = Deno.args[0], every = Number(Deno.args[1] || 4), analysisSize = Number(Deno.args[2] || 640);
if (!file) {
  throw new Error('usage: inspect-recording.ts <video> [everyNth] [analysisSize]');
}
const probe = new Deno.Command('ffprobe', {
  args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', file],
  stdout: 'piped',
});
const [width, height, frames] = new TextDecoder().decode((await probe.output()).stdout).trim().split(',').map(Number);
const factor = analysisFactor(width, height, analysisSize);
console.log({ file, width, height, frames, factor, every });
const ffmpeg = new Deno.Command('ffmpeg', {
  args: [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `select=not(mod(n\\,${every}))`,
    '-fps_mode',
    'vfr',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ],
  stdout: 'piped',
  stderr: 'inherit',
}).spawn();
const reader = ffmpeg.stdout.getReader(), frameBytes = width * height * 4;
let buffer = new Uint8Array(0),
  previous: Gray | undefined,
  previousImage: RGBA | undefined,
  previousFeatures: Feature[] | undefined,
  lastField: MotionField | undefined,
  learner: LayerLearner | undefined,
  index = 0;
const motions: string[] = [];
while (true) {
  while (buffer.length < frameBytes) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer);
    next.set(value, buffer.length);
    buffer = next;
  }
  if (buffer.length < frameBytes) {
    break;
  }
  const image: RGBA = { width, height, data: new Uint8ClampedArray(buffer.buffer.slice(0, frameBytes)) };
  buffer = buffer.slice(frameBytes);
  const g = downscaleGray(image, factor), features = extractFeatures(g);
  learner ??= new LayerLearner(g.width, g.height);
  if (previous) {
    const field = estimateMotion(previous, g, lastField, previousFeatures, features);
    learner.add(field, previous, g, previousImage, image);
    lastField = field;
    const m = field.motions[0];
    motions.push(`${index * every}:${m.x * factor},${m.y * factor}(${m.support})`);
  }
  previous = g;
  previousImage = image;
  previousFeatures = features;
  index++;
}
await ffmpeg.status;
console.log('sampled frames', index);
console.log('dominant motion per sampled frame (native px, support):', motions.join(' '));
const regions = learner!.finish(width, height, []);
for (const r of regions) {
  console.log(r.id, r.kind, r.name, JSON.stringify(r.rect), 'crop', JSON.stringify(r.crop), r.solid ? 'solid' : '');
}
const internals = learner as unknown as {
  colGain: Float64Array;
  horizontalGain: Float64Array;
  informativeFrames: number;
  rowChange: Float64Array;
  colChange: Float64Array;
  nativeColChange?: Float64Array;
  nativeFrames: number;
};
const top = (arr: Float64Array, n: number) =>
  [...arr].map((v, i) => [i, v / internals.informativeFrames] as const).sort((a, b) => b[1] - a[1]).slice(0, n).map(([i, v]) =>
    `${i}:${v.toFixed(2)}`
  );
console.log(
  'informative frames',
  internals.informativeFrames,
  'strongest column gains (analysis px)',
  top(internals.colGain, 5).join(' '),
  'row gains',
  top(internals.horizontalGain, 5).join(' '),
);
const rows = [...internals.rowChange].map((v) => v / internals.informativeFrames);
console.log('analysis rows with change < .9:', rows.map((v, i) => v < .9 ? i : -1).filter((i) => i >= 0).join(','));
const cols = [...internals.colChange].map((v) => v / internals.informativeFrames);
console.log('analysis cols with change < .7:', cols.map((v, i) => v < .7 ? i : -1).filter((i) => i >= 0).join(','));
