/** Device check (static/device-check.html): what this browser and device offer the pipeline and what the GPU path
 *  costs here, as one JSON report to paste back. Nothing leaves the device; a chosen recording is processed
 *  locally and its stored run is deleted afterwards. Not loaded by the app. */
import { translatePage } from './i18n/page.ts';
import { AnalysisComputer } from './core/compute.ts';
import { core, coreBuild, loadPlannedCore, planCore } from './core/wasm.ts';
import { analysisFactor, downscaleGray } from './core/raster.ts';
import { Engine } from './pipeline/engine.ts';
import { Database, iterate } from './storage/db.ts';
import { deleteProject } from './storage/projects.ts';
import { openMedia } from './media/source.ts';
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

translatePage();
const out = document.getElementById('report') as HTMLPreElement;
const report: Record<string, unknown> = {};
const show = () => (out.textContent = JSON.stringify(report, null, 2));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (ms: number) => Math.round(ms * 100) / 100;
// deno-lint-ignore no-explicit-any
type AnyGPU = any;

function noise(width: number, height: number, seed: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let x = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    data[i] = x >>> 24;
  }
  return { width, height, data };
}

async function environment(): Promise<AnyGPU | undefined> {
  const gpu = (navigator as AnyGPU).gpu;
  report.environment = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    secureContext: globalThis.isSecureContext,
    core: coreBuild(),
    webgpu: gpu ? 'navigator.gpu present' : 'navigator.gpu absent (needs a secure context: localhost or HTTPS)',
  };
  if (!gpu) return undefined;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    (report.environment as Record<string, unknown>).adapter = null;
    return undefined;
  }
  const info = adapter.info || {};
  (report.environment as Record<string, unknown>).adapter = {
    vendor: info.vendor,
    architecture: info.architecture,
    description: info.description,
    fallback: info.isFallbackAdapter,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
  return adapter;
}

/** Raw transfer costs, which bound any per-frame GPU offload: upload of one native RGBA frame and one readback. */
async function transfers(adapter: AnyGPU, sizes: [number, number][]) {
  const device = await adapter.requestDevice();
  const rows = [];
  for (const [width, height] of sizes) {
    const bytes = width * height * 4, frame = noise(width, height, 7);
    const buffer = device.createBuffer({ size: bytes, usage: 8 | 4 }), read = device.createBuffer({ size: bytes, usage: 1 | 8 });
    const upload: number[] = [], readback: number[] = [];
    for (let i = 0; i < 6; i++) {
      let t = performance.now();
      device.queue.writeBuffer(buffer, 0, frame.data);
      await device.queue.onSubmittedWorkDone();
      upload.push(performance.now() - t);
      t = performance.now();
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(1);
      new Uint8Array(read.getMappedRange()).slice(0, 16);
      read.unmap();
      readback.push(performance.now() - t);
    }
    buffer.destroy();
    read.destroy();
    rows.push({
      size: `${width}×${height}`,
      MB: round(bytes / 1048576),
      uploadMS: round(median(upload.slice(1))),
      fullReadbackMS: round(median(readback.slice(1))),
    });
  }
  device.destroy();
  return rows;
}

/** The one GPU kernel the pipeline ships (analysis box-luma) against the core, on frame-sized synthetic images. */
async function analysis(sizes: [number, number][]) {
  const rows = [];
  for (const [width, height] of sizes) {
    const factor = analysisFactor(width, height, DEFAULT_SETTINGS.analysisSize), image = noise(width, height, width ^ height);
    const frame = core().frame(width, height);
    try {
      frame.write(image.data);
      const cpu: number[] = [];
      let expected = downscaleGray(frame, factor);
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        expected = downscaleGray(frame, factor);
        cpu.push(performance.now() - t);
      }
      const computer = new AnalysisComputer('webgpu');
      let gpu = await computer.gray(frame, factor), exact = gpu.data.every((v, i) => v === expected.data[i]);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        gpu = await computer.gray(frame, factor);
        times.push(performance.now() - t);
        exact &&= gpu.data.length === expected.data.length && gpu.data.every((v, j) => v === expected.data[j]);
      }
      rows.push({
        size: `${width}×${height}`,
        factor,
        cpuMS: round(median(cpu)),
        gpuMS: computer.stats.gpuFrames ? round(median(times)) : null,
        bitExact: computer.stats.gpuFrames ? exact : null,
        backend: computer.stats.backend,
        reason: computer.stats.reason,
        autoWouldPick: computer.stats.gpuFrames ? (median(times) < median(cpu) * .9 ? 'GPU' : 'CPU') : 'CPU',
      });
      computer.dispose();
    } finally {
      frame.free();
    }
  }
  return rows;
}

async function fingerprint(store: Engine['store']): Promise<{ tiles: number; sha256: string }> {
  const digest = async (bytes: BufferSource) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const rows: unknown[] = [];
  // deno-lint-ignore no-explicit-any
  for await (const { key, value } of iterate<any>(store, 'tile/')) {
    const hashes: Record<string, string> = { png: await digest(await value.blob.arrayBuffer()) };
    for (const field of ['coverage', 'provisional', 'quality', 'conflicts', 'owner', 'score', 'frozen']) {
      const data = value[field] as ArrayBufferView | undefined;
      if (data) hashes[field] = await digest(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    }
    rows.push({ key, hashes });
  }
  return { tiles: rows.length, sha256: await digest(new TextEncoder().encode(JSON.stringify(rows))) };
}

/** Full pipeline on a local recording with the analysis downscale forced to each backend; outputs must match. */
async function pipeline(file: File) {
  const db = await Database.open(), runs: Record<string, unknown>[] = [];
  // `?analysisSize=` lets a small test recording reach an analysis factor above 1 (factor 1 never uses the GPU).
  const analysisSize = Number(new URLSearchParams(location.search).get('analysisSize')) || DEFAULT_SETTINGS.analysisSize;
  for (const compute of ['cpu', 'webgpu'] as Settings['compute'][]) {
    const source = await openMedia(file);
    let backend: unknown;
    const engine = new Engine(db, source, { ...DEFAULT_SETTINGS, analysisSize, compute }, {
      progress: (p: { phase: string; frames: number }) => {
        out.dataset.status = `${compute}: ${p.phase} ${p.frames}`;
        document.title = out.dataset.status;
      },
      diagnostic: (d: { code: string; detail?: unknown }) => {
        if (d.code === 'COMPUTE_BACKEND') backend = d.detail;
      },
      project: () => {},
    });
    const started = performance.now();
    try {
      const project = await engine.run();
      runs.push({
        compute,
        analysisSize,
        status: project.status,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        backend,
        ...(await fingerprint(engine.store)),
      });
    } finally {
      source.dispose();
      // Deletes the `project/<id>` record alongside `run/<id>/` (src/storage/projects.ts); the app's own sweep would
      // otherwise only catch it on its next load.
      await deleteProject(db, engine.project.id);
    }
    report.pipeline = runs;
    show();
  }
  report.pipelineIdentical = runs.length === 2 && runs[0].sha256 === runs[1].sha256;
}

await loadPlannedCore(planCore(), new URL('./core-helper.js', import.meta.url));
const sizes: [number, number][] = [[1418, 1590], [3456, 2234], [1179, 2556], [2556, 1179]];
const run = document.getElementById('run') as HTMLButtonElement, input = document.getElementById('recording') as HTMLInputElement;
run.onclick = async () => {
  run.disabled = true;
  try {
    const adapter = await environment();
    show();
    if (adapter) {
      report.transfers = await transfers(adapter, sizes);
      show();
    }
    report.analysisDownscale = await analysis(sizes);
    show();
    if (input.files?.[0]) await pipeline(input.files[0]);
  } catch (error) {
    report.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    show();
    run.disabled = false;
    document.title = 'Device check — done';
  }
};
