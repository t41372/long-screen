export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface RGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Feature extends Point {
  score: number;
  descriptor: Uint32Array;
}
export interface Match {
  a: Feature;
  b: Feature;
  distance: number;
  unique: boolean;
}
/** Maps current image coordinates to previous image coordinates. */
export interface Motion extends Point {
  support: number;
  unique: number;
  confidence: number;
  error: number;
  ambiguous: boolean;
}
export interface MotionField {
  motions: Motion[];
  labels: Uint8Array;
  confidence: Uint8Array;
  dynamic: Uint8Array;
  cols: number;
  rows: number;
  cell: number;
  difference: number;
  featureCount: number;
  unknown: boolean;
  zoom: number;
}
export interface Region {
  id: string;
  name: string;
  kind: 'moving' | 'fixed' | 'ignore';
  rect: Rect;
  cells?: number[];
  mask?: Uint8Array;
  maskWidth?: number;
  maskHeight?: number;
  manual?: boolean;
  unassigned?: boolean;
  exclusions?: Rect[];
  /** Native-pixel rectangle that bounds membership; band edges are measured on native rows/columns, not analysis cells. */
  crop?: Rect;
  /** Membership is exactly `crop` (a stationary band or divider) regardless of the analysis-resolution mask. */
  solid?: boolean;
}
export interface Settings {
  analysisSize: number;
  memoryMB: number;
  tileSize: number;
  regions: Region[];
  temporalPolicy: 'stable' | 'latest';
  decoder: 'precise' | 'compatibility';
  compatibilityFPS: number;
  /** Context is a presentation of the source chrome, never part of the moving world's geometry. */
  framing?: 'context' | 'region';
  compute?: 'auto' | 'cpu' | 'webgpu';
}
export const DEFAULT_SETTINGS: Settings = {
  analysisSize: 640,
  memoryMB: 128,
  tileSize: 512,
  regions: [],
  temporalPolicy: 'stable',
  decoder: 'precise',
  compatibilityFPS: 60,
};
export interface MediaInfo {
  name: string;
  size: number;
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  duration: number;
  codec: string;
  frameCount?: number;
  mode: string;
  warnings: string[];
  /** Expected per-channel decode noise, in RGB levels: how far two decodings of the SAME source pixel may differ
   *  before the difference means anything. It is a property of where the frames came from, not of the algorithm,
   *  and it is the single knob behind every "are these two pixels the same content?" comparison in the pipeline
   *  (see DECODED_VIDEO_NOISE in src/media/source.ts and the world-consistency mask in src/pipeline/engine.ts).
   *  A lossless source (the synthetic scenarios, the built-in demos) declares 0 and is compared exactly; a
   *  decoded video declares the headroom H.264/VP9 ringing and chroma subsampling need around a sharp edge.
   *  Omitted means "unknown source" and is treated as decoded video — the conservative reading. */
  noise?: number;
  /** Decoder-time anomalies (skipped or reordered observations). Collected during decoding and surfaced as diagnostics, never swallowed. */
  notices?: MediaNotice[];
}
export interface MediaNotice {
  code: string;
  message: string;
  count: number;
}
export type Severity = 'info' | 'warning' | 'error';
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  action?: string;
  time?: number;
  frame?: number;
  canvasId?: string;
  region?: Rect;
  confidence?: number;
  detail?: unknown;
  count?: number;
}
export interface ScanRecord {
  index: number;
  time: number;
  duration: number;
  field: MotionField;
  /** Cached once, reused by the solve pass. */
  features?: Feature[];
  /** Exact native RGBA equality with the previous observation, not perceptual similarity. */
  duplicate?: boolean;
}
export interface Placement {
  layer: string;
  canvasId: string;
  node: string;
  x: number;
  y: number;
  confidence: number;
  uncertain: boolean;
  time: number;
  /** True when the observation carries no positional information (textureless pane); its pixels are not painted anywhere. */
  skip?: boolean;
  /** Native-screen sticky occluders for this observation; not missing page margins. */
  occlusions?: Rect[];
}
/** A fragment that later evidence tied to another canvas: every placement on `id` maps rigidly onto `target`. */
export interface Attachment {
  id: string;
  target: string;
  dx: number;
  dy: number;
  frame: number;
  confidence: number;
}
export interface FramePlan {
  index: number;
  time: number;
  placements: Placement[];
  duplicate?: boolean;
}
export interface CanvasMeta {
  id: string;
  layer: string;
  name: string;
  kind: string;
  bounds: Rect;
  tileCount: number;
  observedPixels: number;
  uncertainPixels: number;
  conflictPixels: number;
  maxLevel: number;
  fragment: number;
  firstTime: number;
  lastTime: number;
  /** Set when this fragment was merged into another canvas by revisit evidence; it then holds no tiles of its own. */
  attachedTo?: string;
  presentation?: { sourceCanvas: string; sourceRegion: Rect; referenceFrame: number; offset: Point; extension: string };
}
export interface Project {
  id: string;
  created: string;
  updated: string;
  name: string;
  settings: Settings;
  media?: MediaInfo;
  status: 'scanning' | 'solving' | 'rendering' | 'pyramid' | 'complete' | 'partial' | 'error';
  frames: number;
  renderedFrames: number;
  canvasCount: number;
  tiles: number;
  observedPixels: number;
  diagnostics: Record<string, number>;
  regions: Region[];
  error?: string;
  decodedBytes?: number;
}
export interface Progress {
  phase: string;
  fraction: number;
  frames: number;
  total?: number;
  time: number;
  message: string;
  canvas?: CanvasMeta;
  project?: Project;
}
/** One decoded observation. Pixels are plain RGBA so every stage after decoding runs identically in a browser worker and in Deno. */
export interface FrameImage {
  image: RGBA;
  time: number;
  duration: number;
  index: number;
}
export interface FrameSource {
  info: MediaInfo;
  frames(): AsyncGenerator<FrameImage>;
  dispose(): void;
}
export interface WorkerCommand {
  type: string;
  id?: number;
  [key: string]: unknown;
}
export interface TilePayload {
  blob: Blob;
  quality?: Uint8Array;
  conflicts?: Uint8Array;
  level: number;
  x: number;
  y: number;
}
