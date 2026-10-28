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
/** Extra exclusions a region carries from frame `from` on, until its next epoch starts: its ownership changes during
 *  the run while its rect stays put (rust/long-screen/src/kernels/regions/epochs.rs). */
export interface RegionEpoch {
  from: number;
  exclusions: Rect[];
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
  /** Integer analysis factor the mask was built at; native→analysis mask lookups use floor(x/factor), not a rounded ratio. */
  factor?: number;
  /** Ownership changes during the run, ascending by `from`; absent when the region owns the same pixels throughout. */
  epochs?: RegionEpoch[];
  /** Candidate sticky blocks of a moving region, native pixels: blocks that stand still for part of the recording (a
   *  table of contents shown some of the time), excluded in the observations whose page motion does not explain them. */
  sticky?: Rect[];
  /** A nested scroll container: the id of the region it scrolls inside. It shares that region's rect and atlas code
   *  and owns, frame by frame, only its footprint there. */
  parent?: string;
  /** Where a nested container is: the parent's canvas, its footprint there (native pixels) and the sides on which it
   *  may continue past it (1 left, 2 right, 4 top, 8 bottom). */
  nest?: { canvas: string; footprint: Rect; open: number };
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
  framing: 'context',
  compute: 'auto',
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
  /** The colour the container declares for the video track (its `colr`/Colour element), when it declares one. Decoded
   *  frames carry their own tags, but WebKit tags an HDR frame as sRGB, so this is what says a recording is HDR. */
  colour?: VideoColorSpaceInit;
}
/** How a source's frames are being turned into RGBA, as far as the converter knows after the first frame. */
export interface ConversionReport {
  /** `FrameConverter.describe()`. */
  method: string;
  /** Milliseconds per frame of the chosen conversion, measured on the first frame, where the converter measures it. */
  ms?: number;
  /** For an HDR recording: its transfer; whether the conversion was checked against the frame's coded values (false
   *  means the browser's own colours were kept); and the share of the first frame's pixels above SDR white. */
  hdr?: { transfer: 'pq' | 'hlg'; verified: boolean; aboveShare?: number };
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
  /** This event's own count, when the emitter supplies one (e.g. a decoder notice already tallied upstream). */
  count?: number;
  /** Cumulative number of times this diagnostic code has fired in the run so far; separate from `count` so an
   * explicit per-event count is never clobbered by the running total. */
  occurrences?: number;
}
/** A frame's Feature[] as stored under scan-features/<frame>: three flat typed arrays instead of n small objects
 * each carrying an 8-element descriptor. Analysis-resolution coordinates fit an Int16Array; only solve() reads this,
 * and the run deletes it once solve() has consumed it. Built by the scan session (rust/long-screen/src/engine/scan.rs). */
export interface CompactFeatures {
  xy: Int16Array;
  score: Float32Array;
  descriptors: Uint32Array;
}
export interface ScanRecord {
  index: number;
  time: number;
  duration: number;
  field: MotionField;
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
  /** A nested container's screen rectangle this frame, which its parent's placement must leave out. Moved onto the
   *  parent's placement by the solve pass; never stored. */
  clip?: Rect;
}
/** A fragment that later evidence tied to another canvas: every placement on `id` maps rigidly onto `target`. */
export interface Attachment {
  id: string;
  target: string;
  dx: number;
  dy: number;
  frame: number;
  confidence: number;
  /** The matched target keyframe's pose-graph node id; lets a later correction to that node keep the attached fragment aligned. */
  node: string;
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
  /** Net count of pixels currently flagged provisional (world-consistency mask found no supporting neighbour and at
   *  least one contradicting one): screen-space overlay/dynamic burn-in still awaiting a consistent observation to
   *  heal it. Rises and falls as later frames confirm or replace these pixels; it is not a cumulative total. */
  provisionalPixels: number;
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
  /** Highest severity seen per diagnostic code, mirroring Diagnostics.severities; lets a badge computed from
   * `diagnostics` totals alone know a code's real severity instead of defaulting one. */
  severities?: Record<string, Severity>;
  regions: Region[];
  error?: string;
  decodedBytes?: number;
  /** Storage layout version. 2: scan-time features live under scan-features/<frame> as compact typed arrays
   * (not inline on ScanRecord), and keyframe/ and scan-features/ rows are deleted once solve() finishes with them. */
  schema?: number;
}
export interface Progress {
  phase: string;
  fraction: number;
  frames: number;
  total?: number;
  time: number;
  message: string;
  canvas?: CanvasMeta;
}
/** One decoded observation. Pixels are plain RGBA so every stage after decoding runs identically in a browser worker and in Deno. */
export interface FrameImage {
  image: RGBA;
  time: number;
  duration: number;
  index: number;
}
/** A decoded frame in its own YUV layout, as `VideoFrame.copyTo` wrote it, with what converting it needs: the core's
 *  format and matrix codes (rust/long-screen/src/kernels/yuv.rs). `release()` returns the buffer to the source's pool. */
export interface FramePlanes {
  data: Uint8Array;
  layout: { offset: number; stride: number }[];
  format: number;
  matrix: number;
  width: number;
  height: number;
  release(): void;
}
/** A frame handed out as planes instead of RGBA (`FrameSource.sparseFrames` with `planes`). */
export interface PlanarFrame {
  planes: FramePlanes;
  image?: undefined;
  time: number;
  duration: number;
  index: number;
}
/** A decoded frame a caller declined (`FrameSource.sparseFrames`): decoded, because later frames depend on it, but
 *  never converted to RGBA. */
export interface SkippedFrame {
  image?: undefined;
  time: number;
  duration: number;
  index: number;
}
/** Where one decode of the source spent its time, as the consumer saw it (benchmark diagnostics). */
export interface SourceStats {
  /** Frames handed out, with or without pixels. */
  frames: number;
  /** Frames handed out with pixels. */
  converted: number;
  /** Waiting for the decoder to produce the next frame. */
  decodeMS: number;
  /** Waiting for a frame's conversion to RGBA (only the part not already overlapped by a prefetch). */
  convertMS: number;
}
export interface FrameSource {
  info: MediaInfo;
  /** The latest decode's timing, replaced (not reset in place) when the next decode starts. */
  readonly stats?: SourceStats;
  frames(): AsyncGenerator<FrameImage>;
  /** Like `frames()`, but frames `want` declines are yielded without pixels, which saves converting them. With
   *  `planes`, a frame the run converts on the CPU from its YUV planes comes as those planes, for a caller that converts
   *  them straight into core memory (the same conversion, minus two copies of the RGBA); other frames still come as
   *  RGBA. Optional: a source without it is read with `frames()`. */
  sparseFrames?(
    want: (index: number) => boolean,
    options?: { planes?: boolean },
  ): AsyncGenerator<FrameImage | SkippedFrame | PlanarFrame>;
  /** How decoded frames are being converted, once one has been (decoding sources only). */
  conversionReport?(): ConversionReport | undefined;
  dispose(): void;
}
export interface TilePayload {
  blob: Blob;
  quality?: Uint8Array;
  conflicts?: Uint8Array;
  coverage?: Uint8Array;
  owner?: Uint32Array;
  /** Level-0 only: same bitmap layout as `coverage` (LSB-first). A set bit is an unhealed world-consistency
   *  provisional pixel — content painted from an observation the render pass could not corroborate against a
   *  neighbouring frame (screen-space overlay/dynamic burn-in), kept because a hole would be worse. */
  provisional?: Uint8Array;
  level: number;
  x: number;
  y: number;
}
