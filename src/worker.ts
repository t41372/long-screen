import { type CanvasMeta, DEFAULT_SETTINGS, type Diagnostic, type MediaInfo, type Project, type Rect, type Settings } from './types.ts';
import { Database, iterate } from './storage/db.ts';
import { keepLatest, projectKey, runStore, sweepProjects } from './storage/projects.ts';
import { Engine } from './pipeline/engine.ts';
import { CompatibilitySource, frameConverter, openMedia, PreciseSource } from './media/source.ts';
import type { Capture } from './media/capture.ts';
import { DemoSource } from './media/demo.ts';
import { type CanvasLayout, exportCanvas, exportProject } from './export/project.ts';
import { cleanupExport } from './export/target.ts';
import { clampCrop, coversCanvas, CROP_PREFIX } from './export/crop.ts';
import { core, coreLoaded, loadPlannedCore, planCore } from './core/wasm.ts';
import { tileKey } from './storage/tiles.ts';
import type { StoredTile } from './storage/tiles.ts';
import {
  type Capabilities,
  type CommandName,
  type Commands,
  type FrameResponse,
  type LocaleMessage,
  PRINT_LOCK,
  type StorageMessage,
} from './protocol.ts';
import { isLocale, setLocale } from './i18n/index.ts';
const scope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const post = (message: unknown, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
let database: Promise<Database> | undefined, active: Engine | undefined, exporting = false, starting = false, probing = false, frameId = 0;
const frames = new Map<number, {
  resolve: (capture: Capture) => void;
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
function requestFrame(time: number, coded: boolean): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const id = ++frameId;
    const timer = setTimeout(() => {
      frames.delete(id);
      reject(new Error('Native video seek did not finish within 30 seconds.'));
    }, 30000);
    frames.set(id, { resolve, reject, timer });
    post({ event: 'frame-request', id, time, coded });
  });
}
/** How long the browser keeps the last print: long enough to survive a reload, a closed tab or a run the browser
 *  killed, not long enough to become a history. */
const KEEP_MS = 24 * 60 * 60 * 1000;
/** Sweeps run one at a time, and a print starts only once the sweep before it is done: a sweep still walking `run/`
 *  would otherwise delete the rows the new print is writing. */
let sweeping: Promise<unknown> = Promise.resolve();
/** The prints some tab holds (PRINT_LOCK); sweeps keep them. Without Web Locks (an insecure LAN HTTP page) none. */
async function heldPrints(): Promise<Set<string>> {
  const locks = await navigator.locks?.query();
  return new Set(
    (locks?.held ?? []).map((lock) => lock.name ?? '').filter((name) => name.startsWith(PRINT_LOCK)).map((name) =>
      name.slice(PRINT_LOCK.length)
    ),
  );
}
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = sweeping.catch(() => {}).then(task);
  sweeping = next;
  return next;
}
function busyError(): never {
  throw new Error('A reconstruction, export or probe is already running.');
}
/** Every command below `pause`/`stop` in the protocol addresses one project's rows; `cleanup-export` is the only
 *  exception (it deletes a bare OPFS file by its own key, not a project). */
function requireProjectId(id: string | undefined): string {
  if (!id) {
    throw new Error('Project ID is required.');
  }
  return id;
}
/** One handler per command, typed against `Commands` so the compiler proves every command from the protocol is
 *  handled here and that each handler's return matches what its callers (main.ts's `rpc<K>()`) expect. */
type Handlers = { [K in CommandName]: (payload: Commands[K]['req'], database: Database) => Promise<Commands[K]['res']> };
const handlers: Handlers = {
  async capabilities(_payload, database): Promise<Capabilities> {
    return {
      worker: true,
      offscreen: typeof OffscreenCanvas !== 'undefined',
      webcodecs: typeof VideoDecoder !== 'undefined',
      opfs: !!navigator.storage?.getDirectory,
      compression: typeof CompressionStream !== 'undefined',
      webgpu: !!(navigator as unknown as { gpu?: unknown }).gpu,
      privateStorage: !database.storesBlobs,
    };
  },
  async probe(payload) {
    // Frame-accurate metadata and the first decoded frame, without relying on the <video> element being able to render.
    if (active || exporting || starting || probing) busyError();
    probing = true;
    try {
      const source = await openMedia(payload.file);
      try {
        for await (const frame of source.frames()) {
          const bitmap = await createImageBitmap(
            new ImageData(frame.image.data as Uint8ClampedArray<ArrayBuffer>, frame.image.width, frame.image.height),
          );
          return { info: source.info, bitmap, conversion: source.conversionReport?.() };
        }
        throw new Error('The decoder produced no frames for this file.');
      } finally {
        source.dispose();
      }
    } finally {
      probing = false;
    }
  },
  async start(payload, database) {
    if (active || exporting || starting || probing) busyError();
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
      // A new print replaces the last one: nothing earlier is kept, except prints other tabs hold. Done before any
      // source is opened, so a failed sweep leaves nothing to release.
      await serially(async () => sweepProjects(database, await heldPrints()));
      let source;
      if (payload.demo) {
        source = new DemoSource(payload.demo);
      } else if (settings.decoder === 'compatibility') {
        if (!payload.info) {
          throw new Error('Native video metadata is missing.');
        }
        source = new CompatibilitySource(payload.info as MediaInfo, settings.compatibilityFPS, requestFrame);
      } else {
        source = await openMedia(payload.file as File, frameConverter(settings.compute));
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
  },
  async pause(payload) {
    if (!active) {
      throw new Error('No active reconstruction.');
    }
    active.setPaused(!!payload.paused);
    return { paused: active.paused };
  },
  async stop() {
    if (!active) {
      throw new Error('No active reconstruction.');
    }
    active.stop();
    return { requested: true };
  },
  async open(payload, database) {
    const id = requireProjectId(payload.projectId);
    const project = await database.get<Project>(projectKey(id));
    if (!project) {
      throw new Error('Project not found in this browser.');
    }
    return { project, canvases: await runStore(database, id).scan<CanvasMeta>('canvas/', { limit: 100 }) };
  },
  canvases(payload, database) {
    return runStore(database, requireProjectId(payload.projectId)).scan<CanvasMeta>('canvas/', { after: payload.after, limit: 100 });
  },
  diagnostics(payload, database) {
    return runStore(database, requireProjectId(payload.projectId)).scan<Diagnostic>('diagnostic/', { after: payload.after, limit: 100 });
  },
  tile(payload, database) {
    return runStore(database, requireProjectId(payload.projectId)).get<StoredTile>(
      `tile/${tileKey(payload.canvasId, payload.level, payload.x, payload.y)}`,
    )
      .then((t) =>
        t
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
          : null
      );
  },
  async restore(_payload, database) {
    if (active || exporting || starting) busyError();
    const project = await serially(async () => keepLatest(database, { maxAgeMs: KEEP_MS, held: await heldPrints() }));
    return project ? { project, interrupted: !['complete', 'partial', 'error'].includes(project.status) } : null;
  },
  async sweep(_payload, database) {
    if (active || exporting || starting) busyError();
    await serially(async () => sweepProjects(database, await heldPrints()));
    return true;
  },
  async export(payload, database) {
    if (active || exporting || starting || probing) {
      throw new Error('Finish processing before exporting committed tiles.');
    }
    exporting = true;
    try {
      const id = requireProjectId(payload.projectId), project = await database.get<Project>(projectKey(id));
      if (!project) {
        throw new Error('Project not found.');
      }
      const store = runStore(database, id);
      const progress = (message: string, fraction: number) => post({ event: 'export-progress', data: { message, fraction } });
      if (payload.format === 'project') {
        return await exportProject(store, project, progress, payload.handle);
      }
      const meta = await store.get<CanvasMeta>(`canvas/${payload.canvasId}`);
      if (!meta || !meta.tileCount) {
        throw new Error('This canvas has no committed pixels.');
      }
      // payload.layout is typed as CanvasLayout, but the debug handle (globalThis.longScreen.rpc, src/ui/main.ts)
      // can post any string, so it is re-validated here rather than trusted straight through to exportCanvas.
      const layout: CanvasLayout = payload.layout === 'single' || payload.layout === 'sheets' ? payload.layout : 'auto';
      // The canvas's kept crop, if any, applies to every per-canvas export (PNG, sheets, the clipboard copy).
      const crop = await store.get<Rect>(`${CROP_PREFIX}${meta.id}`);
      return await exportCanvas(store, project, meta, progress, payload.handle, layout, crop);
    } finally {
      exporting = false;
    }
  },
  async crops(payload, database) {
    const crops: Record<string, Rect> = {};
    for await (const { key, value } of iterate<Rect>(runStore(database, requireProjectId(payload.projectId)), CROP_PREFIX)) {
      crops[key.slice(CROP_PREFIX.length)] = value;
    }
    return crops;
  },
  async crop(payload, database) {
    if (active || exporting || starting) busyError();
    const store = runStore(database, requireProjectId(payload.projectId)), key = `${CROP_PREFIX}${payload.canvasId}`;
    const meta = await store.get<CanvasMeta>(`canvas/${payload.canvasId}`);
    if (!meta) {
      throw new Error('Canvas not found.');
    }
    const rect = payload.rect ? clampCrop(payload.rect, meta.bounds) : undefined;
    if (payload.rect && !rect) {
      throw new Error(`The crop ${JSON.stringify(payload.rect)} leaves nothing of this canvas.`);
    }
    // A crop that keeps the whole canvas is no crop: nothing is kept, so the export stays exactly the uncropped one.
    if (!rect || coversCanvas(rect, meta.bounds)) {
      await store.delete(key);
      return null;
    }
    await store.put(key, rect);
    return rect;
  },
  async 'cleanup-export'(payload) {
    await cleanupExport(payload.key);
    return true;
  },
};
async function dispatch(type: CommandName, payload: Commands[CommandName]['req']): Promise<unknown> {
  await ensureCore();
  const database = await db();
  // Object.hasOwn, not a truthiness check on handlers[type]: a plain object literal inherits Object.prototype, so
  // an unrecognised command like 'constructor' or 'toString' would otherwise resolve to a real function and run
  // it instead of falling through to the error below.
  if (!Object.hasOwn(handlers, type)) {
    throw new Error(`Unknown worker command: ${type}`);
  }
  // deno-lint-ignore no-explicit-any
  return handlers[type](payload as any, database);
}
scope.onmessage = (event) => {
  const m = event.data as FrameResponse | LocaleMessage | StorageMessage | {
    id: number;
    type: CommandName;
    payload?: Record<string, unknown>;
  };
  if (m.type === 'storage') {
    // Sent before any command; once a command has opened a database, the worker keeps that one.
    if (!database) database = Database.open(m.name);
    return;
  }
  if (m.type === 'locale') {
    if (isLocale(m.locale)) setLocale(m.locale);
    return;
  }
  if (m.type === 'frame-response') {
    const pending = frames.get(m.id);
    if (!pending) {
      if ('bitmap' in m) m.bitmap?.close();
      return;
    }
    frames.delete(m.id);
    clearTimeout(pending.timer);
    if ('error' in m) {
      pending.reject(new Error(m.error));
    } else {
      pending.resolve({ bitmap: m.bitmap, coded: !!m.coded });
    }
    return;
  }
  void dispatch(m.type, (m as { payload?: Commands[CommandName]['req'] }).payload ?? {}).then((result) => {
    const transfer: Transferable[] = [];
    if (result && typeof result === 'object' && 'bitmap' in result && (result as { bitmap: unknown }).bitmap instanceof ImageBitmap) {
      transfer.push((result as { bitmap: ImageBitmap }).bitmap);
    }
    post({ id: m.id, result }, transfer);
  }).catch((error) => post({ id: m.id, error: error instanceof Error ? error.message : String(error) }));
};
