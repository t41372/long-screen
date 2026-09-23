import { type CanvasMeta, DEFAULT_SETTINGS, type Diagnostic, type MediaInfo, type Project, type Settings } from './types.ts';
import { Database, deletePrefix, iterate, Namespace } from './storage/db.ts';
import { Engine } from './pipeline/engine.ts';
import { CompatibilitySource, openMedia, PreciseSource } from './media/source.ts';
import { DemoSource } from './media/demo.ts';
import type { StoredTile } from './storage/tiles.ts';
import { exportCanvas, exportProject } from './export/project.ts';
import { cleanupExport } from './export/target.ts';
import { core, coreLoaded, loadPlannedCore, planCore } from './core/wasm.ts';
const scope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const post = (message: unknown, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
let database: Promise<Database> | undefined, active: Engine | undefined, exporting = false, starting = false, probing = false, frameId = 0;
const frames = new Map<number, {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const db = () => database ??= Database.open();
// The Rust core is fetched once, next to this bundle. Every command waits for it: there is no TS fallback,
// so a load failure surfaces as an explicit error on the first command instead of a silently slower run.
let coreReady: Promise<void> | undefined;
const ensureCore = () =>
  coreReady ??= coreLoaded()
    ? Promise.resolve()
    : loadPlannedCore(planCore(), new URL('./core-helper.js', import.meta.url)).then(() => {}, (error) => {
      coreReady = undefined;
      throw new Error(
        `CORE_UNAVAILABLE: the reconstruction core (core.wasm) failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
function requestFrame(time: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const id = ++frameId;
    const timer = setTimeout(() => {
      frames.delete(id);
      reject(new Error('Native video seek did not finish within 30 seconds.'));
    }, 30000);
    frames.set(id, { resolve, reject, timer });
    post({ event: 'frame-request', id, time });
  });
}
async function dispatch(type: string, payload: Record<string, any>): Promise<unknown> {
  await ensureCore();
  const database = await db();
  if (type === 'capabilities') {
    return {
      worker: true,
      offscreen: typeof OffscreenCanvas !== 'undefined',
      webcodecs: typeof VideoDecoder !== 'undefined',
      opfs: !!navigator.storage?.getDirectory,
      compression: typeof CompressionStream !== 'undefined',
      webgpu: !!(navigator as unknown as { gpu?: unknown }).gpu,
      privateStorage: !database.storesBlobs,
    };
  }
  if (type === 'projects') {
    // project-index/<created ISO>/<id> is written on a run's first persist and gives cheap newest-first order;
    // pre-existing projects have no index row, so the legacy project/ scan below fills those in once the index
    // is exhausted. A scan returning fewer rows than the requested limit has genuinely reached the end of that
    // keyspace (IndexedDB's cursor only stops early when there is nothing left), not merely "this page was
    // short", so it is a reliable exhaustion signal on every page, not only the first.
    const after = payload.after as string | undefined, legacyContinuation = after?.startsWith('project/');
    const indexRows = legacyContinuation ? [] : await database.scan<string>('project-index/', { after, limit: 30, reverse: true });
    const seen = new Set<string>(), rows: { key: string; value: Project }[] = [];
    for (const row of indexRows) {
      const project = await database.get<Project>(`project/${row.value}`);
      if (project) {
        rows.push({ key: row.key, value: project });
        seen.add(row.value);
      }
    }
    if (indexRows.length < 30) {
      // project/ holds every project's record, indexed or not, so this legacy scan can re-surface projects an
      // earlier index page already returned; resolve the account's complete indexed-id set here (not just
      // this page's `seen`) so dedup carries across pages instead of resetting on every call.
      for await (const row of iterate<string>(database, 'project-index/', false, 256)) {
        seen.add(row.value);
      }
      const legacyAfter = legacyContinuation ? after : undefined;
      const legacy = await database.scan<Project>('project/', { after: legacyAfter, limit: 30 - rows.length, reverse: true });
      for (const row of legacy) {
        if (!seen.has(row.value.id)) {
          rows.push(row);
        }
      }
    }
    return rows;
  }
  if (type === 'probe') {
    // Frame-accurate metadata and the first decoded frame, without relying on the <video> element being able to render.
    if (active || exporting || starting || probing) {
      throw new Error('A reconstruction, export or probe is already running.');
    }
    probing = true;
    try {
      const source = await openMedia(payload.file as File);
      try {
        for await (const frame of source.frames()) {
          const bitmap = await createImageBitmap(
            new ImageData(frame.image.data as Uint8ClampedArray<ArrayBuffer>, frame.image.width, frame.image.height),
          );
          return { info: source.info, bitmap };
        }
        throw new Error('The decoder produced no frames for this file.');
      } finally {
        source.dispose();
      }
    } finally {
      probing = false;
    }
  }
  if (type === 'start') {
    if (active || exporting || starting || probing) {
      throw new Error('A reconstruction, export or probe is already running.');
    }
    starting = true;
    try {
      if (typeof OffscreenCanvas === 'undefined') {
        throw new Error(
          'OFFSCREEN_CANVAS_UNAVAILABLE: This browser cannot run the worker renderer. No silent main-thread fallback is used.',
        );
      }
      const settings: Settings = { ...DEFAULT_SETTINGS, ...payload.settings };
      if (
        ![320, 480, 640, 960, 1280].includes(settings.analysisSize) || ![64, 128, 256, 512].includes(settings.memoryMB) ||
        ![256, 512, 1024].includes(settings.tileSize)
      ) {
        throw new Error('Invalid analysis/cache/tile settings.');
      }
      if (
        !['auto', 'cpu', 'webgpu'].includes(settings.compute || DEFAULT_SETTINGS.compute!) ||
        !['context', 'region'].includes(settings.framing || DEFAULT_SETTINGS.framing!)
      ) throw new Error('Invalid compute/framing setting.');
      let source;
      if (payload.demo) {
        source = new DemoSource(payload.demo);
      } else if (settings.decoder === 'compatibility') {
        if (!payload.info) {
          throw new Error('Native video metadata is missing.');
        }
        source = new CompatibilitySource(payload.info as MediaInfo, settings.compatibilityFPS, requestFrame);
      } else {
        source = await openMedia(payload.file as File);
      }
      for (const region of settings.regions) {
        const r = region.rect;
        if (r.x < 0 || r.y < 0 || r.width < 4 || r.height < 4 || r.x + r.width > source.info.width || r.y + r.height > source.info.height) {
          throw new Error('A manual region is empty or outside the source frame.');
        }
      }
      const engine = new Engine(database, source, settings, {
        // Memory and conversion path ride along for the page's crash recorder (src/ui/flight.ts).
        progress: (p) =>
          post({
            event: 'progress',
            data: {
              ...p,
              memoryMB: Math.round(core().memoryBytes / 1048576),
              conversion: source instanceof PreciseSource ? source.conversion() : 'native seek',
            },
          }),
        diagnostic: (d) => post({ event: 'diagnostic', data: d }),
        project: (p) => post({ event: 'project', data: p }),
      });
      active = engine;
      void engine.run().then((result) => post({ event: 'finished', data: result })).catch((error) =>
        post({ event: 'fatal', error: String(error) })
      ).finally(() => {
        active = undefined;
      });
      return engine.project;
    } finally {
      starting = false;
    }
  }
  if (type === 'pause') {
    if (!active) {
      throw new Error('No active reconstruction.');
    }
    active.setPaused(!!payload.paused);
    return { paused: active.paused };
  }
  if (type === 'stop') {
    if (!active) {
      throw new Error('No active reconstruction.');
    }
    active.stopRequested = true;
    active.setPaused(false);
    return { requested: true };
  }
  const id = payload.projectId as string;
  if (!id && type !== 'cleanup-export') {
    throw new Error('Project ID is required.');
  }
  const store = new Namespace(database, `run/${id}/`);
  if (type === 'open') {
    const project = await database.get<Project>(`project/${id}`);
    if (!project) {
      throw new Error('Project not found in this browser.');
    }
    return {
      project,
      canvases: await store.scan<CanvasMeta>('canvas/', { limit: 100 }),
      interrupted: active?.project.id !== id && !['complete', 'partial', 'error'].includes(project.status),
    };
  }
  if (type === 'canvases') {
    return store.scan<CanvasMeta>('canvas/', { after: payload.after, limit: 100 });
  }
  if (type === 'diagnostics') {
    return store.scan<Diagnostic>('diagnostic/', { after: payload.after, limit: 100 });
  }
  if (type === 'tile') {
    const t = await store.get<StoredTile>(`tile/${payload.canvasId}/${payload.level}/${payload.x}_${payload.y}`);
    return t
      ? {
        blob: t.blob,
        quality: t.quality,
        conflicts: t.conflicts,
        coverage: t.coverage,
        owner: t.owner,
        provisional: t.provisional,
        level: t.level,
        x: t.x,
        y: t.y,
      }
      : null;
  }
  if (type === 'delete') {
    if (active?.project.id === id || exporting) {
      throw new Error('Finish processing/export before deleting this project.');
    }
    const project = await database.get<Project>(`project/${id}`);
    await deletePrefix(database, `run/${id}/`);
    await database.delete(`project/${id}`);
    if (project) {
      await database.delete(`project-index/${project.created}/${id}`);
    }
    return true;
  }
  if (type === 'export') {
    if (active || exporting || starting || probing) {
      throw new Error('Finish processing before exporting committed tiles.');
    }
    exporting = true;
    try {
      const project = await database.get<Project>(`project/${id}`);
      if (!project) {
        throw new Error('Project not found.');
      }
      const progress = (message: string, fraction: number) => post({ event: 'export-progress', data: { message, fraction } });
      if (payload.format === 'project') {
        return await exportProject(store, project, progress, payload.handle);
      }
      const meta = await store.get<CanvasMeta>(`canvas/${payload.canvasId}`);
      if (!meta || !meta.tileCount) {
        throw new Error('This canvas has no committed pixels.');
      }
      return await exportCanvas(store, project, meta, progress, payload.handle, payload.layout === 'single' ? 'single' : 'auto');
    } finally {
      exporting = false;
    }
  }
  if (type === 'cleanup-export') {
    await cleanupExport(payload.key);
    return true;
  }
  throw new Error(`Unknown worker command: ${type}`);
}
scope.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'frame-response') {
    const pending = frames.get(m.id);
    if (!pending) {
      m.bitmap?.close();
      return;
    }
    frames.delete(m.id);
    clearTimeout(pending.timer);
    if (m.error) {
      pending.reject(new Error(m.error));
    } else {
      pending.resolve(m.bitmap);
    }
    return;
  }
  void dispatch(m.type, m.payload || {}).then((result) => {
    const transfer: Transferable[] = [];
    if (result && typeof result === 'object' && 'bitmap' in result && (result as { bitmap: unknown }).bitmap instanceof ImageBitmap) {
      transfer.push((result as { bitmap: ImageBitmap }).bitmap);
    }
    post({ id: m.id, result }, transfer);
  }).catch((error) => post({ id: m.id, error: error instanceof Error ? error.message : String(error) }));
};
