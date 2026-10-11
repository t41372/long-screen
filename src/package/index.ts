/**
 * Long Screen as a library: turn a screen recording into one big screenshot inside your own page.
 *
 * The reconstruction runs in a Worker next to this module (`worker.js`), on the same Rust/WebAssembly engine and the
 * same worker protocol (src/protocol.ts) the Long Screen app uses; this module only drives it. The worker picks the
 * fastest core its page allows: the threaded build on a cross-origin-isolated page (COOP `same-origin` + COEP
 * `require-corp`), otherwise the single-thread SIMD build (or the scalar build without SIMD). The results are the
 * same either way.
 *
 * Storage: each call keeps its working rows in an IndexedDB database of its own and deletes that database before
 * `result` settles, whatever the outcome. Nothing stays behind after a call. A database left by a page that closed
 * mid-run is deleted by the next call on the same origin.
 *
 * @example
 * ```ts
 * import { reconstruct } from 'long-screen';
 *
 * const run = reconstruct(file, { onProgress: (p) => console.log(p.phase, p.fraction) });
 * const { status, prints, diagnostics } = await run.result;
 * if (prints[0]) img.src = URL.createObjectURL(prints[0].png);
 * ```
 *
 * @module
 */
import { createWorkerClient } from '../rpc-client.ts';
import { type CommandName, type Commands, PACKAGE_DB_PREFIX, type StorageMessage } from '../protocol.ts';
import type { LocaleMessage, WorkerProgress } from '../protocol.ts';
import type { CanvasMeta, Diagnostic as EngineDiagnostic, Project, Settings } from '../types.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import type { Row } from '../storage/db.ts';
import { createId } from '../core/id.ts';
import { displayName } from '../i18n/names.ts';
import { setLocale } from '../i18n/index.ts';
import type { Diagnostic, Locale, Print, Progress, Reconstruct, Reconstruction, ReconstructOptions, ReconstructResult } from './types.ts';
export type * from './types.ts';

/** Web Lock each call holds while its database exists, so another call's cleanup leaves the database alone. */
const LOCK_PREFIX = 'long-screen-package:';

/**
 * Reconstructs one big screenshot from a screen recording (MP4, MOV or WebM that the browser's WebCodecs can
 * decode). Runs in a Worker; the page stays responsive.
 *
 * @param source The recording.
 * @param options Language, settings and progress callbacks.
 * @returns The running reconstruction; await its `result`.
 */
export function reconstruct(source: Blob, options: ReconstructOptions = {}): Reconstruction {
  const locale: Locale = options.locale === 'zh' ? 'zh' : 'en';
  const settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings, decoder: 'precise', regions: [] };
  const file = source instanceof File ? source : new File([source], 'video', { type: source.type });
  let worker: Worker | undefined, cancelled = false, running = false;
  let abort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => abort = reject);
  aborted.catch(() => {});
  let started: () => void = () => {};
  const startedRun = new Promise<void>((resolve) => started = resolve);
  let client: ReturnType<typeof createWorkerClient> | undefined;
  const call = <K extends CommandName>(type: K, payload: Commands[K]['req']): Promise<Commands[K]['res']> =>
    Promise.race([(client!.call as (type: K, payload: Commands[K]['req']) => Promise<Commands[K]['res']>)(type, payload), aborted]);
  const control = async (type: 'pause' | 'stop', payload: Commands['pause']['req'] | Commands['stop']['req']) => {
    await Promise.race([startedRun, aborted]);
    if (running) await call(type, payload as never);
  };

  const result = (async (): Promise<ReconstructResult> => {
    const name = PACKAGE_DB_PREFIX + createId();
    const release = await holdLock(LOCK_PREFIX + name);
    try {
      await deleteAbandoned();
      if (cancelled) throw abortError();
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'locale', locale } satisfies LocaleMessage);
      worker.postMessage({ type: 'storage', name } satisfies StorageMessage);
      client = createWorkerClient(worker);
      const finished = new Promise<Project>((resolve, reject) => {
        client!.on('finished', (m) => resolve(m.data));
        client!.on('fatal', (m) => reject(new Error(m.error)));
        worker!.onerror = (event) => {
          event.preventDefault();
          const error = new Error(event.message || 'The Long Screen worker failed to start.');
          client!.rejectPending(error);
          reject(error);
        };
      });
      finished.catch(() => {});
      let last: Progress = { phase: 'scanning', fraction: 0, frames: 0, time: 0, message: '' };
      client.on('progress', (m) => {
        last = publicProgress(m.data);
        options.onProgress?.(last);
      });
      client.on('diagnostic', (m) => options.onDiagnostic?.(m.data));
      client.on(
        'export-progress',
        (m) => options.onProgress?.({ ...last, phase: 'export', fraction: m.data.fraction, message: m.data.message }),
      );
      // Only the app's approximate decoder asks the page for frames, and this module never selects it.
      client.on('frame-request', (m) => worker!.postMessage({ type: 'frame-response', id: m.id, error: 'No page-side video element.' }));

      const project = await call('start', { file, settings });
      running = true;
      started();
      const done = await Promise.race([finished, aborted]).finally(() => running = false);
      const canvases = await pages((after) => call('canvases', { projectId: project.id, after }));
      const diagnostics = await pages((after) => call('diagnostics', { projectId: project.id, after }));
      const prints: Print[] = [];
      for (const meta of printable(canvases, settings)) {
        prints.push(await exportPrint(call, project.id, meta, locale));
      }
      return {
        status: done.status === 'complete' ? 'complete' : done.status === 'error' ? 'error' : 'partial',
        ...(done.error ? { error: done.error } : {}),
        frames: done.renderedFrames,
        prints,
        diagnostics,
      };
    } finally {
      running = false;
      started();
      // Deleted while the worker still runs: its connection closes on the version change, so the delete completes.
      await deleteDatabase(name);
      worker?.terminate();
      release();
    }
  })();

  return {
    result,
    pause: () => control('pause', { paused: true }),
    resume: () => control('pause', { paused: false }),
    stop: () => control('stop', {}),
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const error = abortError();
      worker?.terminate();
      client?.rejectPending(error);
      abort(error);
    },
  };
}

function publicProgress(p: WorkerProgress): Progress {
  return {
    phase: p.phase,
    fraction: p.fraction,
    frames: p.frames,
    ...(p.total === undefined ? {} : { total: p.total }),
    time: p.time,
    message: p.message,
  };
}

/** The canvases worth a PNG, in the order the app lists them: a framed view first (only with `framing: 'context'`),
 *  then moving content, then fixed parts, each by observed pixels. A fragment that later evidence merged into
 *  another canvas holds no tiles of its own and is left out. */
function printable(canvases: CanvasMeta[], settings: Settings): CanvasMeta[] {
  const rank = (c: CanvasMeta) => c.kind === 'presentation' ? (settings.framing === 'context' ? -1 : 0) : c.kind === 'fixed' ? 1 : 0;
  return canvases
    .filter((c) => c.tileCount > 0 && !c.attachedTo && Number.isFinite(c.bounds.width) && Number.isFinite(c.bounds.height))
    .sort((a, b) => rank(a) - rank(b) || b.observedPixels - a.observedPixels);
}

async function exportPrint(
  call: <K extends CommandName>(type: K, payload: Commands[K]['req']) => Promise<Commands[K]['res']>,
  projectId: string,
  meta: CanvasMeta,
  locale: Locale,
): Promise<Print> {
  const out = await call('export', { projectId, canvasId: meta.id, format: 'png', layout: 'single' });
  if (!out.blob) throw new Error(`The worker returned no PNG for ${meta.id}.`);
  let png = out.blob;
  if (out.temporary) {
    // The worker wrote the PNG to a temporary file in the origin private file system. Reading a File whose entry is
    // removed fails, so the bytes are copied out before the file goes.
    png = new Blob([await out.blob.arrayBuffer()], { type: 'image/png' });
    await call('cleanup-export', { key: out.temporary });
  }
  setLocale(locale);
  return {
    id: meta.id,
    name: meta.name,
    label: displayName(meta.name),
    kind: meta.kind,
    fragment: meta.fragment,
    width: Math.round(meta.bounds.width),
    height: Math.round(meta.bounds.height),
    bounds: { ...meta.bounds },
    observedPixels: meta.observedPixels,
    png,
  };
}

/** Every row behind a paged command (100 rows per page). */
async function pages<T>(page: (after?: string) => Promise<Row<T>[]>): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  while (true) {
    const rows = await page(after);
    out.push(...rows.map((r) => r.value));
    if (rows.length < 100) return out;
    after = rows[rows.length - 1].key;
  }
}

/** Holds a Web Lock until the returned function runs. Without Web Locks (an insecure HTTP page) nothing is held. */
async function holdLock(name: string): Promise<() => void> {
  if (!navigator.locks) return () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => release = resolve);
  await new Promise<void>((granted) => {
    void navigator.locks.request(name, () => {
      granted();
      return held;
    });
  });
  return release;
}

/** Deletes the databases of calls whose page went away mid-run: those no live call holds the lock of. */
async function deleteAbandoned(): Promise<void> {
  if (!navigator.locks || !indexedDB.databases) return;
  const [databases, locks] = await Promise.all([indexedDB.databases(), navigator.locks.query()]);
  const held = new Set((locks.held ?? []).map((lock) => lock.name));
  await Promise.all(
    databases.map((db) => db.name).filter((name): name is string =>
      !!name && name.startsWith(PACKAGE_DB_PREFIX) && !held.has(LOCK_PREFIX + name)
    ).map(deleteDatabase),
  );
}

/** Resolves once the database is gone. Open connections (the worker's) close themselves on the version change. */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    // `blocked`: a connection is still open (a terminated worker's, until the browser closes it). The delete stays
    // queued and finishes when that connection goes, so there is nothing more to wait for here.
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

function abortError(): Error {
  return new DOMException('The reconstruction was cancelled.', 'AbortError');
}

// The public types (./types.ts) are written out so the published declarations stand alone. These fail to compile if
// they drift from what the worker sends (diagnostics, progress) or accepts (settings, merged into `Settings` above),
// or if `reconstruct` stops matching the `Reconstruct` signature index.d.ts declares.
type Assignable<From, To> = [From] extends [To] ? true : never;
const _drift: [
  Assignable<EngineDiagnostic, Diagnostic>,
  Assignable<WorkerProgress, Progress>,
  Assignable<typeof reconstruct, Reconstruct>,
  Assignable<Reconstruct, typeof reconstruct>,
] = [
  true,
  true,
  true,
  true,
];
void _drift;
