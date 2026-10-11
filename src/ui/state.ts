/** Fields more than one feature module reads or writes. Everything else (draft regions, diagnostic rows, …) stays
 *  private inside the module that owns it. */
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
  /** Counts run.resetView() calls: a reply that arrives after the print was replaced or cleared can tell. */
  resets: number;
  /** The crop box is up (src/ui/crop.ts): exports wait until it is applied or cancelled. */
  cropping: boolean;
}

export function createState(): AppState {
  return { canvases: [], busy: false, nativeReady: false, manualRegions: [], resets: 0, cropping: false };
}

/** The one place every control whose disabled state depends only on `state.busy` plus one other current-value
 *  check gets synced, instead of `run.ts`'s `setBusy`, `canvases.ts`'s `selectCanvas` and `export.ts`'s
 *  `doExport` each re-deriving the same checks. Called directly from the first two; `doExport` reaches it
 *  through `run.setBusy`. */
export function syncControls(state: AppState, viewer: TiledViewer): void {
  const busy = state.busy;
  $<HTMLButtonElement>('start-btn').disabled = busy || !state.selectedFile;
  $<HTMLButtonElement>('demo-cta').disabled = busy;
  $<HTMLButtonElement>('clear-btn').disabled = busy;
  $<HTMLButtonElement>('regions-btn').disabled = busy || !state.firstBitmap;
  // While the crop box is up the exports wait: they take the kept crop, not the one still being dragged.
  const cropping = state.cropping;
  $<HTMLButtonElement>('export-png').disabled = busy || cropping || !viewer.current?.tileCount;
  $<HTMLButtonElement>('export-sheets').disabled = busy || cropping || !viewer.current?.tileCount;
  $<HTMLButtonElement>('copy-png').disabled = busy || cropping || !viewer.current?.tileCount;
  $<HTMLButtonElement>('export-project').disabled = busy || cropping || !state.project?.renderedFrames;
  $<HTMLButtonElement>('crop-btn').disabled = busy || !viewer.current?.tileCount;
  // Switching language reloads the page, which would kill a running reconstruction or export.
  $<HTMLSelectElement>('language-select').disabled = busy;
}
