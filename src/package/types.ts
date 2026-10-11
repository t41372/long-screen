/** The public types of the npm package. Declarations only, with no imports and no runtime code, so
 *  scripts/build-package.ts publishes this file as is as the package's `index.d.ts` (plus the `reconstruct`
 *  declaration). src/package/index.ts checks at compile time that these match what the worker sends. */
/** The language of diagnostic and progress messages and of print labels. */
export type Locale = 'en' | 'zh';

/** How serious a diagnostic is. */
export type Severity = 'info' | 'warning' | 'error';

/** A rectangle in pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something the run noticed, kept in the order it happened. */
export interface Diagnostic {
  /** Stable machine-readable code, e.g. `LOW_CONFIDENCE_PLACEMENT`. */
  code: string;
  severity: Severity;
  /** What happened, in the call's `locale`. */
  message: string;
  /** What to do about it, when there is something to do. */
  action?: string;
  /** Source time in seconds. */
  time?: number;
  /** Source frame index. */
  frame?: number;
  /** The print (`Print.id`) it concerns. */
  canvasId?: string;
  /** Where on the print, in print pixels. */
  region?: Rect;
  /** Heuristic confidence in 0..1; not a probability of being correct. */
  confidence?: number;
  /** Structured values behind the message, for the codes that record them. */
  detail?: unknown;
  /** This event's own count, when the event stands for several. */
  count?: number;
  /** Live events only: how many times this code has fired so far in the run. */
  occurrences?: number;
}

/** Where a run is. Sent at most every few hundred milliseconds. */
export interface Progress {
  /** `scanning`, `solving`, `rendering`, `pyramid`, `complete`, `partial`, `export`, … */
  phase: string;
  /** Overall share done, 0..1. */
  fraction: number;
  /** Frames handled so far in this phase. */
  frames: number;
  /** Frames in the recording, once known. */
  total?: number;
  /** Source time reached, in seconds. */
  time: number;
  /** A human-readable line in the call's `locale`. */
  message: string;
}

/** Knobs of the reconstruction. Every field is optional; the defaults are the app's. */
export interface ReconstructSettings {
  /** Long side of the frames motion is analysed at, in pixels. Default 640. */
  analysisSize?: 320 | 480 | 640 | 960 | 1280;
  /** Tile cache budget in MB. Default 128. */
  memoryMB?: 64 | 128 | 256 | 512;
  /** Side of a stored tile in pixels. Default 512. */
  tileSize?: 256 | 512 | 1024;
  /** When the same spot shows different content over time: keep what stayed (`stable`, default) or the latest. */
  temporalPolicy?: 'stable' | 'latest';
  /** `context` (default) also composes a print that keeps the fixed screen chrome around the moving content;
   *  `region` gives the moving content alone. */
  framing?: 'context' | 'region';
  /** Where frame analysis runs: `auto` (default), `cpu` or `webgpu`. */
  compute?: 'auto' | 'cpu' | 'webgpu';
}

/** Options for {@link reconstruct}. */
export interface ReconstructOptions {
  /** Language of messages and labels. Default `en`. */
  locale?: Locale;
  settings?: ReconstructSettings;
  /** Called as the run moves on, and while the prints are encoded (`phase: 'export'`). */
  onProgress?: (progress: Progress) => void;
  /** Called for diagnostics as they happen, at most one per code every 750 ms; the full list is in the result. */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

/** One composed picture: a moving pane, a fixed part of the screen, a separate fragment, or a framed view. */
export interface Print {
  id: string;
  /** The name the engine gave it (a fixed Chinese vocabulary, the same in every locale). */
  name: string;
  /** `name` in the call's `locale`. */
  label: string;
  /** `moving` (content that travelled), `fixed` (screen parts that stayed), `presentation` (a moving print framed
   *  with the fixed parts around it), or another kind the engine adds later. */
  kind: string;
  /** Unplaced-fragment number: 0 for a main print, 1+ for a piece the run could not place against it. */
  fragment: number;
  width: number;
  height: number;
  /** Where the print sits in its own world coordinates. */
  bounds: Rect;
  /** Pixels some frame showed. Transparent pixels in `png` were never observed. */
  observedPixels: number;
  /** The print at native resolution, as one PNG. */
  png: Blob;
}

/** What a run produced. */
export interface ReconstructResult {
  /** `complete`; `partial` when stopped early or when a later step failed after pixels were committed (see
   *  `error`); `error` when nothing could be composed. */
  status: 'complete' | 'partial' | 'error';
  error?: string;
  /** Frames composed into the prints. */
  frames: number;
  /** Main prints first, then fixed parts; within a kind, the most observed first. */
  prints: Print[];
  /** Every diagnostic the run recorded, in order. */
  diagnostics: Diagnostic[];
}

/** A running reconstruction. */
export interface Reconstruction {
  /** Settles once the prints are encoded and the call's storage is deleted. Rejects when the worker cannot run
   *  (no WebCodecs, an unreadable file, a failed core load), and with an `AbortError` after `cancel()`. */
  readonly result: Promise<ReconstructResult>;
  /** Holds the run between two frames. Does nothing once the run has finished. */
  pause(): Promise<void>;
  /** Continues a paused run. */
  resume(): Promise<void>;
  /** Finishes early: `result` still resolves, with what was composed so far (`status: 'partial'`). */
  stop(): Promise<void>;
  /** Abandons the run: the worker is terminated, its storage deleted, and `result` rejects with an `AbortError`. */
  cancel(): void;
}

/**
 * Reconstructs one big screenshot from a screen recording (MP4, MOV or WebM that the browser's WebCodecs can
 * decode). Runs in a Worker; the page stays responsive.
 *
 * @param source The recording.
 * @param options Language, settings and progress callbacks.
 * @returns The running reconstruction; await its `result`.
 */
export type Reconstruct = (source: Blob, options?: ReconstructOptions) => Reconstruction;
