// A page that uses the built package the way a third-party site would: it imports `long-screen` (an import map in
// consumer.html, or a bundler) and knows nothing of Long Screen's sources. tests/browser/package.test.ts drives it.
import { reconstruct } from 'long-screen';

const status = document.querySelector('#status');
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const packageDatabases = async () =>
  indexedDB.databases
    ? (await indexedDB.databases()).map((db) => db.name).filter((name) => name?.startsWith('long-screen-package-'))
    : null;

/** Reconstructs the recording at `url` with `settings` and reports what a test can compare: PNG hashes, sizes, diagnostics. */
globalThis.runSample = async (url, settings) => {
  const source = await (await fetch(url)).blob();
  const phases = [];
  const started = performance.now();
  const run = reconstruct(source, {
    locale: 'en',
    settings,
    onProgress: (p) => {
      if (phases.at(-1) !== p.phase) phases.push(p.phase);
      status.textContent = `${p.phase} ${Math.round(p.fraction * 100)}% · ${p.message}`;
    },
  });
  const result = await run.result;
  const ms = Math.round(performance.now() - started);
  const prints = [];
  for (const print of result.prints) {
    const { png, ...meta } = print;
    prints.push({ ...meta, type: png.type, bytes: png.size, sha256: hex(await crypto.subtle.digest('SHA-256', await png.arrayBuffer())) });
  }
  if (result.prints[0]) {
    const img = document.querySelector('#print');
    img.src = URL.createObjectURL(result.prints[0].png);
    await img.decode();
  }
  status.textContent = `${result.status}: ${result.frames} frames, ${result.prints.length} print(s) in ${ms} ms`;
  const codes = {};
  for (const d of result.diagnostics) codes[d.code] = (codes[d.code] ?? 0) + 1;
  return {
    status: result.status,
    error: result.error,
    frames: result.frames,
    ms,
    prints,
    codes,
    core: result.diagnostics.find((d) => d.code === 'COMPUTE_BACKEND')?.detail?.core,
    backend: result.diagnostics.find((d) => d.code === 'COMPUTE_BACKEND')?.message,
    conversion: result.diagnostics.find((d) => d.code === 'FRAME_CONVERSION')?.message,
    phases,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    leftDatabases: await packageDatabases(),
  };
};

/** Starts a run, cancels it at its first progress event and reports how `result` settled. */
globalThis.cancelSample = async (url) => {
  const source = await (await fetch(url)).blob();
  let run;
  const first = new Promise((resolve) => {
    run = reconstruct(source, { onProgress: resolve });
  });
  await first;
  run.cancel();
  const outcome = await run.result.then(() => 'resolved', (error) => error.name);
  // The terminated worker's connection closes when the browser gets to it; the queued delete finishes then.
  let left = await packageDatabases();
  for (let i = 0; i < 50 && left?.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    left = await packageDatabases();
  }
  return { outcome, leftDatabases: left };
};

globalThis.consumerReady = true;
status.textContent = 'Ready.';
