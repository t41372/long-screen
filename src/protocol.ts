/** The typed page↔worker protocol. Command names are frozen strings (browser tests call `longScreen.rpc('tile'|
 *  'open'|'capabilities')` directly), but every payload and reply is now a real type instead of `any`, so the
 *  compiler — not a runtime shape mismatch — catches a worker.ts handler that forgets a command or a main.ts call
 *  site that sends the wrong payload. */
import type { CanvasMeta, Diagnostic, MediaInfo, Progress, Project, Settings } from './types.ts';
import type { Row } from './storage/db.ts';
import type { CanvasLayout, ExportResult } from './export/project.ts';
import type { StoredTile } from './storage/tiles.ts';

export interface Capabilities {
  worker: true;
  offscreen: boolean;
  webcodecs: boolean;
  opfs: boolean;
  compression: boolean;
  webgpu: boolean;
  privateStorage: boolean;
}

/** Extras the worker adds on top of the engine's own `Progress` (src/pipeline/engine.ts never sets these): core
 *  linear memory in MB and the frame conversion path, both read by the crash recorder (src/ui/flight.ts). Kept out
 *  of `Progress` itself so the pipeline's type does not carry app-worker-only fields. */
export interface WorkerProgress extends Progress {
  memoryMB: number;
  conversion: string;
}

export interface ProbeResult {
  info: MediaInfo;
  bitmap: ImageBitmap;
}

export interface OpenResult {
  project: Project;
  canvases: Row<CanvasMeta>[];
  interrupted: boolean;
}

/** Same fields worker.ts has always re-derived from `StoredTile` by hand; reused here instead of duplicated. */
export type TileResult = Pick<StoredTile, 'blob' | 'quality' | 'conflicts' | 'coverage' | 'owner' | 'provisional' | 'level' | 'x' | 'y'>;

export interface PauseResult {
  paused: boolean;
}
export interface StopResult {
  requested: true;
}

/** Request/response map, one entry per worker command. worker.ts's handler table is typed `{ [K in
 *  keyof Commands]: (payload) => Promise<res> }`, so the compiler proves every command is handled and every
 *  handler returns the shape its callers expect. */
export interface Commands {
  capabilities: { req: Record<string, never>; res: Capabilities };
  projects: { req: { after?: string }; res: Row<Project>[] };
  probe: { req: { file: File }; res: ProbeResult };
  start: { req: { file?: File; demo?: string; settings: Settings; info?: MediaInfo }; res: Project };
  pause: { req: { paused: boolean }; res: PauseResult };
  stop: { req: Record<string, never>; res: StopResult };
  open: { req: { projectId: string }; res: OpenResult };
  canvases: { req: { projectId: string; after?: string }; res: Row<CanvasMeta>[] };
  diagnostics: { req: { projectId: string; after?: string }; res: Row<Diagnostic>[] };
  tile: { req: { projectId?: string; canvasId: string; level: number; x: number; y: number }; res: TileResult | null };
  delete: { req: { projectId: string }; res: true };
  export: {
    req: { projectId: string; canvasId?: string; format: 'project' | 'png'; layout?: CanvasLayout; handle?: FileSystemFileHandle };
    res: ExportResult;
  };
  'cleanup-export': { req: { key: string }; res: true };
}
export type CommandName = keyof Commands;

export interface FrameRequestEvent {
  event: 'frame-request';
  id: number;
  time: number;
}
/** Discriminated union of everything the worker can push to the page unprompted. */
export type WorkerEvent =
  | { event: 'progress'; data: WorkerProgress }
  | { event: 'project'; data: Project }
  | { event: 'diagnostic'; data: Diagnostic }
  | { event: 'finished'; data: Project }
  | { event: 'fatal'; error: string }
  | { event: 'export-progress'; data: { message: string; fraction: number } }
  | FrameRequestEvent;
export type WorkerEventName = WorkerEvent['event'];

/** Reply envelope for an `id`-tagged request; `event` distinguishes it from a `WorkerEvent` on the same channel. */
export type WorkerReply<K extends CommandName = CommandName> =
  | { id: number; result: Commands[K]['res'] }
  | { id: number; error: string };

/** The page answers a worker `frame-request` on this same channel, by posted `type` rather than `event`. */
export type FrameResponse =
  | { type: 'frame-response'; id: number; bitmap: ImageBitmap }
  | { type: 'frame-response'; id: number; error: string };
