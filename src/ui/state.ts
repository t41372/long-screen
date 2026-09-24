/** Fields more than one feature module reads or writes. Everything else (draft regions, diagnostic rows, history
 *  pagination cursors, …) stays private inside the module that owns it. */
import type { CanvasMeta, MediaInfo, Project, Region } from '../types.ts';
import type { Capabilities } from '../protocol.ts';
import type { TiledViewer } from './viewer.ts';
import { $ } from './dom.ts';

export interface AppState {
  project?: Project;
  canvases: CanvasMeta[];
  busy: boolean;
  selectedFile?: File;
  selectedFileHash?: Promise<string | undefined>;
  firstBitmap?: ImageBitmap;
  mediaInfo?: MediaInfo;
  /** Whether the native <video> element can play this source (compatibility-mode decoding and source-time review). */
  nativeReady: boolean;
  manualRegions: Region[];
  capabilities?: Capabilities;
}

export function createState(): AppState {
  return { canvases: [], busy: false, nativeReady: false, manualRegions: [] };
}

/** The enablement logic that used to live three times over (setBusy, selectCanvas, doExport) and now lives once:
 *  every control whose disabled state depends only on `state.busy` plus one other current-value check. Called
 *  directly from `run.ts`'s `setBusy` and `canvases.ts`'s `selectCanvas`; `export.ts`'s `doExport` reaches it
 *  through `run.setBusy` instead of re-deriving the same checks. */
export function syncControls(state: AppState, viewer: TiledViewer): void {
  const busy = state.busy;
  $<HTMLButtonElement>('start-btn').disabled = busy || !state.selectedFile;
  $<HTMLButtonElement>('demo-btn').disabled = busy;
  $<HTMLButtonElement>('regions-btn').disabled = busy || !state.firstBitmap;
  $<HTMLButtonElement>('export-project').disabled = busy || !state.project?.renderedFrames;
  $<HTMLButtonElement>('export-png').disabled = busy || !viewer.current?.tileCount;
  $<HTMLButtonElement>('export-sheets').disabled = busy || !viewer.current?.tileCount;
  $<HTMLButtonElement>('copy-png').disabled = busy || !viewer.current?.tileCount;
}
