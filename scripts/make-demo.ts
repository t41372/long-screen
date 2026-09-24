/** Records the app's one built-in demo, static/demo/sample.mp4: a screen recording whose viewport wanders over a page
 *  2.5 viewports wide and 2.5 tall, which the demo button feeds through the whole pipeline so a visitor sees a messy
 *  recording go in and one big screenshot come out. The page is scripts/demo-page.html (a trip-planning whiteboard
 *  drawn in HTML, CSS and inline SVG); headless Chrome renders it, the viewport follows a seeded hand-made path
 *  (pans, a diagonal run, a zigzag, two pauses, a burst of hand shake, a revisit) and every frame is a screenshot
 *  at an integer scroll offset. ffmpeg encodes the frames; like scripts/make-fixtures.ts, ffmpeg and Chrome are
 *  dev-time dependencies only and nothing here ships to the browser except the video itself.
 *
 *  Deterministic: the path comes from a fixed seed and the page from a seeded doodle generator, and x264 runs with a
 *  fixed thread count, so re-running on the same machine rewrites the same bytes (fonts are the repo's own Baloo 2).
 *
 *  `deno task demo-video` writes static/demo/sample.mp4. `--out <file>` writes the video elsewhere, and
 *  `--truth <file>` also saves the full page as a PNG: the ground truth a reconstruction of the video should equal. */
import { chromium } from 'playwright';
import { dirname, fromFileUrl } from '@std/path';

// CRF 14 (about 1.2 MB): at 15 and 16 compression residue on one early frame was enough for the app to report a
// TEMPORAL_OR_ALIGNMENT_CONFLICT (6 pixels) and an INCOMPLETE_TEMPORAL_PATCH; at 14 the run is clean.
const VIEW = { width: 960, height: 600 }, PAGE = { width: 2400, height: 1500 }, FPS = 30, CRF = 14;
/** Per-frame movement stays within 5% of the viewport on each axis, so consecutive frames overlap by 95%. */
const MAX_STEP = { x: Math.round(VIEW.width * 0.05), y: Math.round(VIEW.height * 0.05) };
const RANGE = { x: PAGE.width - VIEW.width, y: PAGE.height - VIEW.height };

function flag(name: string): string | undefined {
  const at = Deno.args.indexOf(name);
  return at < 0 ? undefined : Deno.args[at + 1];
}
const out = flag('--out') ?? fromFileUrl(new URL('../static/demo/sample.mp4', import.meta.url));
const truth = flag('--truth');

/** mulberry32: a small seeded PRNG, so the hand shake is the same on every run. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(0x5eed);

type Ease = (t: number) => number;
const easeIn: Ease = (t) => t * t;
const easeOut: Ease = (t) => 1 - (1 - t) * (1 - t);
const easeInOut: Ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
/** A move to `to` over `frames`, bowed sideways by `bow` px at its middle so it curves like a hand-dragged pan;
 *  or a hold for `frames`, with `shake` px of hand jitter over its first `shakeFrames` frames. */
type Step =
  | { to: [number, number]; frames: number; ease: Ease; bow?: number }
  | { hold: number; shake?: number; shakeFrames?: number };

// Scroll offsets of the viewport's top-left corner, in page pixels; x runs 0..1440 and y 0..900. Starting at (0, 0)
// puts the page's origin at the first frame's origin, so a reconstruction lines up with the ground truth directly.
const STEPS: Step[] = [
  { hold: 9 },
  { to: [720, 0], frames: 34, ease: easeIn, bow: 30 }, // pan right along the top, dipping a little
  { to: [1440, 0], frames: 34, ease: easeOut, bow: 20 }, // ... to the top-right corner
  { to: [1440, 440], frames: 28, ease: easeInOut, bow: 36 }, // down the right side
  { to: [1440, 900], frames: 28, ease: easeInOut, bow: 24 }, // ... to the bottom-right corner
  { hold: 12 }, // a short stop
  { to: [1080, 730], frames: 15, ease: easeInOut }, // zigzag left along the bottom
  { to: [720, 900], frames: 15, ease: easeInOut },
  { to: [360, 730], frames: 15, ease: easeInOut },
  { to: [0, 900], frames: 15, ease: easeInOut },
  { to: [24, 300], frames: 36, ease: easeInOut, bow: -40 }, // back up the left side
  { hold: 24, shake: 4, shakeFrames: 15 }, // pause; the hand shakes
  { to: [600, 40], frames: 30, ease: easeInOut, bow: -20 }, // revisit the title and the lake photo
  { to: [1060, 500], frames: 34, ease: easeInOut, bow: -30 }, // diagonal run down through the middle
  { hold: 14 },
];

/** Offsets are whole even pixels, as in a Retina recording, where every CSS pixel scrolled moves two device pixels.
 *  The app analyses a 960-wide frame at half size, and an odd step is a half-pixel shift there: measured on this
 *  demo, 57 of 192 odd steps left the feature matcher without a motion estimate (UNRESOLVED_MOTION) while none of
 *  the even ones did. The print came out right either way, but the demo should not open on a list of warnings. */
function buildPath(): [number, number][] {
  const path: [number, number][] = [];
  let at: [number, number] = [0, 0];
  const even = (v: number, max: number) => Math.min(max, Math.max(0, 2 * Math.round(v / 2)));
  const push = (x: number, y: number) => path.push([even(x, RANGE.x), even(y, RANGE.y)]);
  for (const step of STEPS) {
    if ('hold' in step) {
      for (let i = 0; i < step.hold; i++) {
        const shaking = step.shake && i < (step.shakeFrames ?? step.hold);
        const jitter = () => shaking ? (random() * 2 - 1) * step.shake! : 0;
        push(at[0] + jitter(), at[1] + jitter());
      }
      continue;
    }
    const [x0, y0] = at, [x1, y1] = step.to, length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const normal = [-(y1 - y0) / length, (x1 - x0) / length];
    for (let i = 1; i <= step.frames; i++) {
      const t = i / step.frames, s = step.ease(t), bend = (step.bow ?? 0) * Math.sin(Math.PI * t);
      push(x0 + (x1 - x0) * s + normal[0] * bend, y0 + (y1 - y0) * s + normal[1] * bend);
    }
    at = step.to;
  }
  return path;
}

/** Fraction of the page some frame saw, on a 10 px grid; anything short of all of it leaves a hole in the print. */
function coverage(path: [number, number][]): number {
  const cell = 10, cols = PAGE.width / cell, rows = PAGE.height / cell, seen = new Uint8Array(cols * rows);
  for (const [x, y] of path) {
    for (let r = Math.ceil(y / cell); r < Math.floor((y + VIEW.height) / cell); r++) {
      seen.fill(1, r * cols + Math.ceil(x / cell), r * cols + Math.floor((x + VIEW.width) / cell));
    }
  }
  return seen.reduce((sum, v) => sum + v, 0) / seen.length;
}

const path = buildPath();
for (let i = 1; i < path.length; i++) {
  const dx = Math.abs(path[i][0] - path[i - 1][0]), dy = Math.abs(path[i][1] - path[i - 1][1]);
  if (dx > MAX_STEP.x || dy > MAX_STEP.y) throw new Error(`frame ${i} moves ${dx}×${dy} px, more than ${MAX_STEP.x}×${MAX_STEP.y}`);
}
const covered = coverage(path);
if (covered < 1) throw new Error(`the path leaves ${((1 - covered) * 100).toFixed(2)}% of the page unseen`);
console.log(`${path.length} frames (${(path.length / FPS).toFixed(1)} s), whole page covered`);

// Encode next to the target and rename on success, so a failed run never leaves a truncated video in its place.
const partial = `${out}.partial.mp4`;
await Deno.mkdir(dirname(out), { recursive: true });
const ffmpeg = new Deno.Command('ffmpeg', {
  args: [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', 'pipe:0', '-an'],
    // Tag and convert as BT.709 limited range: an untagged stream under 720 lines is read as BT.601 by the app.
    ...[
      '-vf',
      'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,' +
      'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
    ],
    ...['-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0', '-preset', 'veryslow', '-crf', String(CRF), '-threads', '4'],
    // A keyframe every 2 s keeps seeking cheap; no scene-cut keyframes, so the interval is fixed. No B-frames: WebKit's
    // WebCodecs decoder (Playwright WebKit 2248) returned every B-frame out of presentation order, one
    // NONMONOTONIC_TIMESTAMP per B-frame, so the demo keeps decode order and presentation order identical.
    ...['-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0', '-bf', '0', '-fps_mode', 'cfr', '-r', String(FPS)],
    ...['-movflags', '+faststart', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', partial],
  ],
  stdin: 'piped',
  stdout: 'inherit',
  stderr: 'inherit',
}).spawn();
const frames = ffmpeg.stdin.getWriter();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(new URL('demo-page.html', import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  const size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
  if (size[0] !== PAGE.width || size[1] !== PAGE.height) {
    throw new Error(`demo-page.html is ${size.join('×')}, expected ${PAGE.width}×${PAGE.height}`);
  }
  for (const [x, y] of path) {
    // Scroll, then wait two animation frames so the screenshot shows the new offset rather than a stale frame.
    const at = await page.evaluate(([x, y]) =>
      new Promise<number[]>((resolve) => {
        window.scrollTo(x, y);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve([window.scrollX, window.scrollY])));
      }), [x, y]);
    if (at[0] !== x || at[1] !== y) throw new Error(`scrolled to ${at.join(',')} instead of ${x},${y}`);
    await frames.write(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
  }
  if (truth) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: truth, type: 'png', fullPage: true });
    console.log(`wrote ${truth}`);
  }
} finally {
  await browser.close();
  await frames.close();
}
if (!(await ffmpeg.status).success) throw new Error('ffmpeg failed');
await Deno.rename(partial, out);
console.log(`wrote ${out} (${((await Deno.stat(out)).size / 1e6).toFixed(2)} MB)`);
