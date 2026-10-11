/** Parity between the native driver (rust/long-screen) and the web Engine: the same frames into both, every persisted
 *  row compared by its fingerprint digest (scripts/fingerprint-scenarios.ts's format, compared with
 *  scripts/compare-fingerprints.ts).
 *
 *  Usage:
 *    deno run -A scripts/native-parity.ts export <dir> [scenario…]
 *      Writes each synthetic scenario's frames as raw RGBA (`<dir>/<name>/frames.rgba`) with `meta.json` (the
 *      source's MediaInfo, the run settings, each frame's time, duration and size), for
 *      `cargo run -p long-screen --release --example parity -- scenarios <dir> <out.json>`.
 *    deno run -A scripts/native-parity.ts recording <video> <out.json>
 *      Runs the web Engine on a recording decoded by ffmpeg exactly as the native harness's `recording` mode decodes
 *      it (rawvideo RGBA, `-fps_mode passthrough`, size from ffprobe, frame times from the sorted packet times, the
 *      core's HDR conversion for PQ/HLG), and writes the fingerprint of every row.
 *  The scenario side of the web fingerprint is scripts/fingerprint-scenarios.ts itself. */
import '../tests/support/core.ts';
import { core } from '../src/core/wasm.ts';
import { hdrToRGBA } from '../src/core/wasm/yuv.ts';
import { Engine } from '../src/pipeline/engine.ts';
import { MemoryKV } from '../src/storage/db.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';
import { buildScenario, SCENARIO_NAMES } from '../src/synthetic/scenarios.ts';
import { renderFrame } from '../src/synthetic/world.ts';
import { ScenarioSource } from '../src/synthetic/source.ts';

const [mode, ...args] = Deno.args;

async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

if (mode === 'export') {
  const [dir, ...only] = args;
  for (const name of only.length ? only : [...SCENARIO_NAMES, 'fixture']) {
    const scenario = buildScenario(name);
    const source = new ScenarioSource(scenario);
    const out = `${dir}/${name}`;
    await Deno.mkdir(out, { recursive: true });
    const file = await Deno.open(`${out}/frames.rgba`, { write: true, create: true, truncate: true });
    const frames: [number, number, number, number][] = [];
    for (let index = 0; index < scenario.frames.length; index++) {
      const f = scenario.frames[index], image = renderFrame(scenario, index).image;
      frames.push([f.time, f.duration, image.width, image.height]);
      const bytes = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      for (let at = 0; at < bytes.length;) at += await file.write(bytes.subarray(at));
    }
    file.close();
    const settings = { ...DEFAULT_SETTINGS, ...scenario.settings };
    await Deno.writeTextFile(`${out}/meta.json`, JSON.stringify({ info: source.info, settings, frames }));
    console.log(`${name}: ${frames.length} frames`);
  }
} else if (mode === 'recording') {
  const [file, out] = args;
  const run = async (command: string, a: string[]): Promise<string> => {
    const o = await new Deno.Command(command, { args: a, stdout: 'piped', stderr: 'inherit' }).output();
    if (!o.success) throw new Error(`${command} failed`);
    return new TextDecoder().decode(o.stdout);
  };
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
  const { width, height, codec_name: codec, color_transfer: ct } = stream.streams[0];
  const transfer = ct === 'smpte2084' ? 'pq' : ct === 'arib-std-b67' ? 'hlg' : undefined;
  const times =
    (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]))
      .trim().split('\n').map(Number).sort((a, b) => a - b);
  const info = {
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
    mode: 'ffmpeg (parity)',
    noise: 10,
    warnings: [],
    notices: [],
  };
  const source = {
    info,
    async *frames() {
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
        stderr: 'piped',
      }).spawn();
      const errors = new Response(ffmpeg.stderr).text();
      const reader = ffmpeg.stdout.getReader(), frameBytes = width * height * 4;
      let frame = new Uint8ClampedArray(frameBytes), filled = 0, index = 0, carry: Uint8Array | undefined;
      try {
        while (true) {
          while (filled < frameBytes) {
            const chunk = carry ?? (await reader.read()).value;
            carry = undefined;
            if (!chunk) break;
            const take = Math.min(chunk.length, frameBytes - filled);
            frame.set(chunk.subarray(0, take), filled);
            filled += take;
            if (take < chunk.length) carry = chunk.subarray(take);
          }
          if (filled < frameBytes) break;
          if (transfer) hdrToRGBA(core(), frame, 'rgba8', width, height, transfer);
          const time = times[index] ?? index / 60, next = times[index + 1] ?? time + 1 / 60;
          yield { image: { width, height, data: frame }, time, duration: next - time, index: index++ };
          frame = new Uint8ClampedArray(frameBytes);
          filled = 0;
        }
      } finally {
        await reader.cancel().catch(() => {});
        try {
          ffmpeg.kill();
        } catch { /* ffmpeg already exited */ }
        await ffmpeg.status;
        await errors;
      }
    },
    dispose() {},
  };
  const VOLATILE = new Set(['created', 'updated', 'compute', 'id']);
  const volatile = (k: string): boolean => VOLATILE.has(k) || k.endsWith('MS') || k === 'seconds';
  const canon = async (v: unknown, id: string): Promise<unknown> => {
    if (v instanceof Blob) return { blob: v.type, sha: await sha(new Uint8Array(await v.arrayBuffer())) };
    if (ArrayBuffer.isView(v)) return { [v.constructor.name]: await sha(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (typeof v === 'string') return v.split(id).join('<run>');
    if (Array.isArray(v)) return Promise.all(v.map((x) => canon(x, id)));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      const hostTimed = (v as { code?: string }).code === 'COMPUTE_BACKEND';
      for (const k of Object.keys(v)) {
        if (!volatile(k) && !(hostTimed && (k === 'message' || k === 'detail'))) o[k] = await canon((v as Record<string, unknown>)[k], id);
      }
      return o;
    }
    return v;
  };
  const db = new MemoryKV(), started = performance.now();
  const noop = () => {};
  const project = await new Engine(db, source, { ...DEFAULT_SETTINGS }, { progress: noop, diagnostic: noop, project: noop }).run();
  const seconds = +((performance.now() - started) / 1000).toFixed(1);
  const rows: Record<string, string> = {};
  for (const [key, value] of [...db.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    rows[key.split(project.id).join('<run>')] = await sha(new TextEncoder().encode(JSON.stringify(await canon(value, project.id))));
  }
  const name = file.split('/').pop()!;
  const result = {
    [name]: {
      rows,
      events: '',
      project: await sha(new TextEncoder().encode(JSON.stringify(await canon(project, project.id)))),
      seconds,
      status: project.status,
      frames: project.frames,
    },
  };
  await Deno.writeTextFile(out, JSON.stringify(result, null, 1));
  console.log(`${name}: ${Object.keys(rows).length} rows, ${project.status}, ${seconds}s`);
} else {
  console.error('usage: native-parity.ts export <dir> [scenario…] | recording <video> <out.json>');
  Deno.exit(2);
}
Deno.exit(0);
