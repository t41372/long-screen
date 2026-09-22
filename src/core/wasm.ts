/** Adapter for the Rust reconstruction core (`rust/core`, compiled to `assets/core.wasm`).
 *
 *  This is the only place TypeScript touches Wasm linear memory. Every kernel call follows one shape:
 *  reserve arena space, copy inputs in, call, copy outputs out, release the arena. The arena is a bump
 *  allocator on top of `ls_alloc`, grown in large chunks so per-frame calls never allocate in Rust.
 *  Kernels return negative status codes rather than trapping; those are surfaced as thrown errors. */
import type { Feature, Gray, Match, Motion, MotionField, Point, Rect, Region, RGBA } from '../types.ts';

export interface RefinementResult {
  x: number;
  y: number;
  error: number;
  samples: number;
  runnerUp: number;
}
export interface AuditResult {
  error: number;
  mismatch: number;
  overlap: number;
  samples: number;
  blocks: number;
  agreeing: number;
  agreement: number;
  agreeingError: number;
}
export interface PatchInput {
  x: number;
  y: number;
  size: number;
  data: Uint8Array;
}
/** Region-membership mask for native refinement: a pixel counts when `labels[y*w+x] === code`. */
export interface LabelMask {
  labels: Uint8Array;
  code: number;
}

interface CoreExports {
  memory: WebAssembly.Memory;
  ls_alloc(size: number): number;
  ls_free(ptr: number, size: number): void;
  ls_feature_bytes(): number;
  ls_match_bytes(): number;
  ls_grayscale(rgba: number, width: number, height: number, out: number): number;
  ls_downscale_gray(rgba: number, width: number, height: number, factor: number, out: number): number;
  ls_halve_rgba(rgba: number, width: number, height: number, out: number): number;
  ls_extract_features(gray: number, width: number, height: number, max: number, roi: number, out: number): number;
  ls_match_features(a: number, countA: number, b: number, countB: number, ambiguous: number, out: number): number;
  ls_feature_words(features: number, count: number, out: number): number;
  ls_consistency_mask(
    rgba: number,
    labels: number,
    width: number,
    height: number,
    region: number,
    code: number,
    poseX: number,
    poseY: number,
    prev: number,
    next: number,
    vote: number,
    factor: number,
    noise: number,
    out: number,
  ): number;
  ls_png_unfilter(raw: number, width: number, height: number, channels: number, out: number): number;
  ls_png_filter_sub(rgba: number, width: number, height: number, out: number): number;
  ls_mean_difference(a: number, b: number, len: number): number;
  ls_translation_hypotheses(matches: number, count: number, max: number, out: number): number;
  ls_detect_scale(matches: number, count: number): number;
  ls_verify_translation(a: number, aw: number, ah: number, b: number, bw: number, bh: number, dx: number, dy: number, roi: number): number;
  ls_audit_translation(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    dx: number,
    dy: number,
    roi: number,
    tolerant: number,
    out: number,
  ): number;
  ls_refine_translation(
    a: number,
    aw: number,
    ah: number,
    b: number,
    bw: number,
    bh: number,
    px: number,
    py: number,
    roi: number,
    radius: number,
    out: number,
  ): number;
  ls_estimate_motion(
    a: number,
    b: number,
    width: number,
    height: number,
    matches: number,
    count: number,
    featureCount: number,
    out: number,
  ): number;
  ls_refine_native(
    a: number,
    b: number,
    width: number,
    height: number,
    gx: number,
    gy: number,
    region: number,
    labels: number,
    code: number,
    radius: number,
    out: number,
  ): number;
  ls_refine_patches(
    patches: number,
    count: number,
    native: number,
    width: number,
    height: number,
    region: number,
    gx: number,
    gy: number,
    radius: number,
    out: number,
  ): number;
  ls_resample_gray(gray: number, width: number, height: number, scale: number, out: number): number;
  ls_composite_tile(tile: number, observation: number, world: number, ox: number, oy: number, tx: number, ty: number, out: number): number;
  ls_voting_new(
    factor: number,
    noise: number,
    nativeWidth: number,
    nativeHeight: number,
    analysisWidth: number,
    analysisHeight: number,
    budgetBytes: number,
    regions: number,
    count: number,
  ): number;
  ls_voting_free(handle: number): void;
  ls_voting_box(handle: number, slot: number, out: number): number;
  ls_voting_interior(handle: number, slot: number, out: number): number;
  ls_voting_observe(handle: number, slot: number, canvas: number, poseX: number, poseY: number, gray: number): number;
  ls_voting_push(handle: number, index: number): number;
  ls_voting_drain(handle: number): number;
  ls_voting_peek(handle: number, out: number): number;
  ls_voting_read(handle: number, which: number, bits: number, clean: number): number;
  ls_voting_pop(handle: number): number;
}

const MATCH_POINT_BYTES = 40, MOTION_BYTES = 48, MOTION_FIELD_HEADER = 40, REFINEMENT_BYTES = 32, PATCH_BYTES = 16, MOTION_CELL = 24;
const COMPOSITE_HEADER = 24, VOTING_REGION_BYTES = 64;

/** Analysis-resolution voting box of one moving region, in that region's own local cell coordinates. */
export interface VotingBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}
/** Finalised verdict for one region of one frame: `bits` inconsistent, `clean` confidently consistent (LSB-first). */
export type VotingVerdict = VotingBox & { bits: Uint8Array; clean: Uint8Array };
export interface VotingRecord {
  index: number;
  /** Per region id; absent when no region had a verdict cell. */
  record: Record<string, VotingVerdict> | undefined;
  votedLayers: number;
  thinLayers: number;
}

/** Stateful displacement-spread consistency voting ring living in core memory (rust/core/src/voting.rs). One
 *  per solve pass: `observe()` each moving region's final pose, `pushFrame()` once per frame, read whatever
 *  finalised records come out, `drain()` at the end, `free()` always. */
export class VotingRing {
  private canvasIds: string[] = [];
  private canvasSlots = new Map<string, number>();
  readonly boxes: VotingBox[];
  private grayBytes: number;
  private grayPtr: number;
  private readonly peekBytes: number;
  private freed = false;
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly regions: Region[],
    analysisPixels: number,
  ) {
    this.grayBytes = analysisPixels;
    this.grayPtr = exports.ls_alloc(analysisPixels);
    if (!this.grayPtr) throw new Error('CORE_OUT_OF_MEMORY: voting ring frame buffer.');
    this.peekBytes = 16 + 4 * regions.length;
    this.boxes = regions.map((_, slot) => {
      const [out] = core.scratch([16]);
      core.check(exports.ls_voting_box(handle, slot, out), 'voting box');
      const view = new DataView(exports.memory.buffer, out, 16);
      return { x0: view.getInt32(0, true), y0: view.getInt32(4, true), w: view.getInt32(8, true), h: view.getInt32(12, true) };
    });
  }
  /** Interior-cell mask (w×h bytes) of a region slot; exposed for parity tests. */
  interior(slot: number): Uint8Array {
    const box = this.boxes[slot], [out] = this.core.scratch([box.w * box.h]);
    this.core.check(this.exports.ls_voting_interior(this.handle, slot, out), 'voting interior');
    return this.core.readBytes(out, box.w * box.h);
  }
  private canvasSlot(canvasId: string): number {
    let slot = this.canvasSlots.get(canvasId);
    if (slot === undefined) {
      slot = this.canvasIds.push(canvasId) - 1;
      this.canvasSlots.set(canvasId, slot);
    }
    return slot;
  }
  /** Adds one region's evidence for the frame under construction. `gray` is the whole analysis frame; it is
   *  copied into the core once per frame (the first `observe()` of a frame uploads, later ones reuse). */
  observe(slot: number, canvasId: string, pose: Point, gray: Gray, uploaded: boolean): void {
    if (gray.data.byteLength !== this.grayBytes) throw new Error('CORE_BAD_ARGUMENT: analysis frame size differs from the voting ring.');
    if (!uploaded) this.core.writeBytes(this.grayPtr, gray.data);
    this.core.check(
      this.exports.ls_voting_observe(this.handle, slot, this.canvasSlot(canvasId), pose.x, pose.y, this.grayPtr),
      'voting observe',
    );
  }
  pushFrame(index: number): VotingRecord[] {
    this.core.check(this.exports.ls_voting_push(this.handle, index), 'voting push');
    return this.collect();
  }
  drain(): VotingRecord[] {
    this.core.check(this.exports.ls_voting_drain(this.handle), 'voting drain');
    return this.collect();
  }
  private collect(): VotingRecord[] {
    const out: VotingRecord[] = [];
    while (true) {
      const [head] = this.core.scratch([this.peekBytes]);
      const count = this.exports.ls_voting_peek(this.handle, head);
      if (count === -2) break;
      this.core.check(count, 'voting peek');
      const view = new DataView(this.exports.memory.buffer, head, this.peekBytes);
      const index = view.getUint32(0, true), votedLayers = view.getUint32(8, true), thinLayers = view.getUint32(12, true);
      const slots = Array.from({ length: count }, (_, i) => view.getUint32(16 + i * 4, true));
      let record: Record<string, VotingVerdict> | undefined;
      for (let which = 0; which < count; which++) {
        const slot = slots[which], box = this.boxes[slot], bytes = Math.ceil(box.w * box.h / 8);
        const [bits, clean] = this.core.scratch([bytes, bytes]);
        this.core.check(this.exports.ls_voting_read(this.handle, which, bits, clean), 'voting read');
        (record ??= {})[this.regions[slot].id] = {
          ...box,
          bits: this.core.readBytes(bits, bytes),
          clean: this.core.readBytes(clean, bytes),
        };
      }
      this.exports.ls_voting_pop(this.handle);
      out.push({ index, record, votedLayers, thinLayers });
    }
    return out;
  }
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.exports.ls_voting_free(this.handle);
    this.exports.ls_free(this.grayPtr, this.grayBytes);
    this.handle = 0;
  }
}

/** The mutable buffers of one resident tile, as `TileStore` holds them. */
export interface CompositeTile {
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  provisional: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen: Uint8Array;
}
export interface CompositeObservation {
  image: RGBA;
  /** Atlas labels and this region's code; omitted for a rectangular region that owns its whole rect. */
  mask?: LabelMask;
  occlusions?: Rect[];
  consistent?: Uint8Array;
  confidence: number;
  uncertain: boolean;
  frame: number;
}
export interface CompositeTileStats {
  added: number;
  conflicts: number;
  uncertain: number;
  provisionalPixels: number;
  changed: boolean;
  /** Tile-local block coordinates flagged conflicting by this call. */
  conflictBlocks: [number, number][];
}

/** Keeps one observation resident across the tiles of a frame so the frame is copied into Wasm memory once. */
export interface PreparedObservation {
  compositeTile(tile: CompositeTile, world: Rect, ox: number, oy: number, tx: number, ty: number): CompositeTileStats;
}

export interface ConsistencyVoteInput {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  clean: Uint8Array;
}
export interface ConsistencyNeighbourInput {
  image: RGBA;
  x: number;
  y: number;
  occlusions?: Rect[];
  voting?: ConsistencyVoteInput;
}
export interface ConsistencyMaskInput {
  image: RGBA;
  labels: Uint8Array;
  region: Rect;
  code: number;
  pose: { x: number; y: number };
  prev?: ConsistencyNeighbourInput;
  next?: ConsistencyNeighbourInput;
  voting?: ConsistencyVoteInput;
  factor: number;
  noise: number;
}

const STATUS: Record<number, string> = { [-1]: 'CORE_BAD_ARGUMENT' };
/** Rust reports an unknown PNG filter byte as −256 − byte; the message keeps naming the byte, as the TS decoder did. */
const BAD_FILTER = -256;
const CHUNK = 4 * 1024 * 1024;

/** Bump arena over one `ls_alloc` block. Each kernel call plans all of its buffers up front, so the block
 *  can only be replaced between calls and offsets handed out for one call stay valid throughout it. */
class Arena {
  private base = 0;
  private capacity = 0;
  constructor(private readonly exports: CoreExports) {}
  plan(sizes: number[]): number[] {
    const aligned = sizes.map((size) => (size + 7) & ~7), total = aligned.reduce((sum, size) => sum + size, 0);
    if (total > this.capacity) {
      const next = Math.max(total, this.capacity * 2, CHUNK);
      if (this.base) this.exports.ls_free(this.base, this.capacity);
      this.base = this.exports.ls_alloc(next);
      if (!this.base) {
        this.capacity = 0;
        throw new Error(`CORE_OUT_OF_MEMORY: the reconstruction core could not reserve ${next} bytes.`);
      }
      this.capacity = next;
    }
    let offset = 0;
    return aligned.map((size) => {
      const ptr = this.base + offset;
      offset += size;
      return ptr;
    });
  }
}

export class Core {
  /** Transient arena: every kernel call replans it. */
  private readonly arena: Arena;
  /** Frame arena: holds a prepared observation across the tile loop, during which transient calls
   *  (e.g. PNG encoding on tile eviction) must not clobber it. Only one observation is live at a time. */
  private readonly frameArena: Arena;
  readonly featureBytes: number;
  readonly matchBytes: number;
  private constructor(private readonly exports: CoreExports) {
    this.arena = new Arena(exports);
    this.frameArena = new Arena(exports);
    this.featureBytes = exports.ls_feature_bytes();
    this.matchBytes = exports.ls_match_bytes();
  }
  static async instantiate(bytes: BufferSource | Response | Promise<Response>): Promise<Core> {
    const source = bytes instanceof Promise ? await bytes : bytes;
    const result = source instanceof Response
      ? await WebAssembly.instantiateStreaming(source, {}).catch(async () => WebAssembly.instantiate(await source.arrayBuffer(), {}))
      : await WebAssembly.instantiate(source, {});
    return new Core(result.instance.exports as unknown as CoreExports);
  }
  private get memory(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }
  private write(ptr: number, bytes: ArrayBufferView): void {
    this.memory.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), ptr);
  }
  private read(ptr: number, length: number): Uint8Array<ArrayBuffer> {
    return this.memory.slice(ptr, ptr + length) as Uint8Array<ArrayBuffer>;
  }
  /** Transient scratch space for stateful-object wrappers (planned like any kernel call). */
  scratch(sizes: number[]): number[] {
    return this.arena.plan(sizes);
  }
  readBytes(ptr: number, length: number): Uint8Array<ArrayBuffer> {
    return this.read(ptr, length);
  }
  writeBytes(ptr: number, bytes: ArrayBufferView): void {
    this.write(ptr, bytes);
  }
  check(status: number, what: string): number {
    if (status <= BAD_FILTER && status > BAD_FILTER - 256) throw new Error(`Invalid PNG filter ${BAD_FILTER - status}.`);
    if (status < 0) throw new Error(`${STATUS[status] || 'CORE_FAILURE'}: ${what} (status ${status}).`);
    return status;
  }
  private writeRect(ptr: number, r: Rect): void {
    const view = new DataView(this.exports.memory.buffer, ptr, 32);
    view.setFloat64(0, r.x, true);
    view.setFloat64(8, r.y, true);
    view.setFloat64(16, r.width, true);
    view.setFloat64(24, r.height, true);
  }

  /** Creates a voting ring over `regions` (moving regions, in slot order). Region masks are copied once. */
  votingRing(
    regions: Region[],
    options: {
      factor: number;
      noise: number;
      nativeWidth: number;
      nativeHeight: number;
      analysisWidth: number;
      analysisHeight: number;
      budgetBytes: number;
    },
  ): VotingRing {
    const sizes: number[] = [regions.length * VOTING_REGION_BYTES];
    for (const r of regions) {
      sizes.push((r.exclusions?.length || 0) * 32, r.crop ? 32 : 0, r.mask && !r.solid ? r.mask.byteLength : 0);
    }
    const ptr = this.arena.plan(sizes),
      base = ptr[0],
      view = new DataView(this.exports.memory.buffer, base, regions.length * VOTING_REGION_BYTES);
    regions.forEach((r, i) => {
      const [exclusions, crop, mask] = ptr.slice(1 + i * 3, 4 + i * 3), o = i * VOTING_REGION_BYTES;
      this.writeRect(base + o, r.rect);
      (r.exclusions || []).forEach((e, k) => this.writeRect(exclusions + k * 32, e));
      view.setUint32(o + 32, r.exclusions?.length ? exclusions : 0, true);
      view.setUint32(o + 36, r.exclusions?.length || 0, true);
      if (r.crop) this.writeRect(crop, r.crop);
      view.setUint32(o + 40, r.crop ? crop : 0, true);
      view.setUint32(o + 44, r.solid ? 1 : 0, true);
      const useMask = !!r.mask && !r.solid;
      if (useMask) {
        if (!r.maskWidth || !r.maskHeight || r.mask!.byteLength !== r.maskWidth * r.maskHeight) {
          throw new Error(`CORE_BAD_ARGUMENT: region ${r.id} mask does not match its declared ${r.maskWidth}×${r.maskHeight}.`);
        }
        this.write(mask, r.mask!);
      }
      view.setUint32(o + 48, useMask ? mask : 0, true);
      view.setUint32(o + 52, useMask ? r.maskWidth! : 0, true);
      view.setUint32(o + 56, useMask ? r.maskHeight! : 0, true);
      view.setUint32(o + 60, useMask ? r.factor || 0 : 0, true);
    });
    const handle = this.check(
      this.exports.ls_voting_new(
        options.factor,
        options.noise,
        options.nativeWidth,
        options.nativeHeight,
        options.analysisWidth,
        options.analysisHeight,
        options.budgetBytes,
        base,
        regions.length,
      ),
      'voting ring',
    );
    return new VotingRing(this, this.exports, handle, regions, options.analysisWidth * options.analysisHeight);
  }

  grayscale(rgba: Uint8ClampedArray, width: number, height: number): Gray {
    const n = width * height;
    const [input, output] = this.arena.plan([n * 4, n]);
    this.write(input, rgba);
    this.check(this.exports.ls_grayscale(input, width, height, output), 'grayscale');
    return { width, height, data: this.read(output, n) };
  }
  downscaleGray(image: RGBA, factor: number): Gray {
    const width = Math.max(1, Math.ceil(image.width / factor)), height = Math.max(1, Math.ceil(image.height / factor));
    const [input, output] = this.arena.plan([image.data.byteLength, width * height]);
    this.write(input, image.data);
    this.check(this.exports.ls_downscale_gray(input, image.width, image.height, factor, output), 'downscaleGray');
    return { width, height, data: this.read(output, width * height) };
  }
  halveRGBA(image: RGBA): RGBA {
    const width = Math.max(1, image.width >> 1), height = Math.max(1, image.height >> 1);
    const [input, output] = this.arena.plan([image.data.byteLength, width * height * 4]);
    this.write(input, image.data);
    this.check(this.exports.ls_halve_rgba(input, image.width, image.height, output), 'halveRGBA');
    return { width, height, data: new Uint8ClampedArray(this.read(output, width * height * 4).buffer) };
  }
  extractFeatures(image: Gray, maxFeatures: number, roi?: Rect): Feature[] {
    const [input, rect, output] = this.arena.plan([image.data.byteLength, 32, maxFeatures * this.featureBytes]);
    this.write(input, image.data);
    if (roi) this.writeRect(rect, roi);
    const count = this.check(
      this.exports.ls_extract_features(input, image.width, image.height, maxFeatures, roi ? rect : 0, output),
      'extractFeatures',
    );
    return this.readFeatures(output, count);
  }
  private readFeatures(ptr: number, count: number): Feature[] {
    const bytes = this.read(ptr, count * this.featureBytes), view = new DataView(bytes.buffer), out: Feature[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * this.featureBytes;
      out[i] = {
        x: view.getInt32(o, true),
        y: view.getInt32(o + 4, true),
        score: view.getFloat32(o + 8, true),
        descriptor: new Uint32Array(bytes.buffer.slice(o + 12, o + 44)),
      };
    }
    return out;
  }
  private writeFeatures(ptr: number, features: Feature[]): void {
    const view = new DataView(this.exports.memory.buffer, ptr, features.length * this.featureBytes);
    for (let i = 0; i < features.length; i++) {
      const f = features[i], o = i * this.featureBytes;
      view.setInt32(o, f.x, true);
      view.setInt32(o + 4, f.y, true);
      view.setFloat32(o + 8, f.score, true);
      for (let k = 0; k < 8; k++) view.setUint32(o + 12 + k * 4, f.descriptor[k], true);
    }
  }
  matchFeatures(a: Feature[], b: Feature[], includeAmbiguous: boolean): Match[] {
    if (!a.length || !b.length) return [];
    const [pa, pb, output] = this.arena.plan([a.length * this.featureBytes, b.length * this.featureBytes, a.length * 2 * this.matchBytes]);
    this.writeFeatures(pa, a);
    this.writeFeatures(pb, b);
    const count = this.check(this.exports.ls_match_features(pa, a.length, pb, b.length, includeAmbiguous ? 1 : 0, output), 'matchFeatures');
    const bytes = this.read(output, count * this.matchBytes), view = new DataView(bytes.buffer), out: Match[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * this.matchBytes;
      out[i] = {
        a: a[view.getUint32(o, true)],
        b: b[view.getUint32(o + 4, true)],
        distance: view.getUint16(o + 8, true),
        unique: bytes[o + 10] === 1,
      };
    }
    return out;
  }
  featureWords(features: Feature[]): number[] {
    if (!features.length) return [];
    const [input, output] = this.arena.plan([features.length * this.featureBytes, features.length * 16]);
    this.writeFeatures(input, features);
    const count = this.check(this.exports.ls_feature_words(input, features.length, output), 'featureWords');
    return [...new Uint32Array(this.read(output, count * 4).buffer)];
  }
  consistencyMask(input: ConsistencyMaskInput): Uint8Array {
    const { width, height } = input.image, pixels = width * height;
    const voteBytes = (v?: ConsistencyVoteInput) => v ? Math.ceil(v.w * v.h / 8) : 0;
    const neighbourSizes = (n?: ConsistencyNeighbourInput) =>
      n ? [pixels * 4, 48, (n.occlusions?.length || 0) * 32, 24, voteBytes(n.voting), voteBytes(n.voting)] : [0, 0, 0, 0, 0, 0];
    const ptr = this.arena.plan([
      pixels * 4,
      pixels,
      32,
      pixels,
      24,
      voteBytes(input.voting),
      voteBytes(input.voting),
      ...neighbourSizes(input.prev),
      ...neighbourSizes(input.next),
    ]);
    const [rgba, labels, region, output, voteDesc, voteBits, voteClean] = ptr;
    this.write(rgba, input.image.data);
    this.write(labels, input.labels);
    this.writeRect(region, input.region);
    const writeVote = (desc: number, bits: number, clean: number, v?: ConsistencyVoteInput): number => {
      if (!v) return 0;
      const bytes = voteBytes(v);
      if (v.bits.length < bytes || v.clean.length < bytes) throw new Error('CORE_BAD_ARGUMENT: truncated consistency vote bitset.');
      this.write(bits, v.bits.subarray(0, bytes));
      this.write(clean, v.clean.subarray(0, bytes));
      const view = new DataView(this.exports.memory.buffer, desc, 24);
      view.setInt32(0, v.x0, true);
      view.setInt32(4, v.y0, true);
      view.setInt32(8, v.w, true);
      view.setInt32(12, v.h, true);
      view.setUint32(16, bits, true);
      view.setUint32(20, clean, true);
      return desc;
    };
    const vote = writeVote(voteDesc, voteBits, voteClean, input.voting);
    const writeNeighbour = (offset: number, n?: ConsistencyNeighbourInput): number => {
      if (!n) return 0;
      const [image, desc, occlusions, nVoteDesc, nBits, nClean] = ptr.slice(offset, offset + 6);
      if (n.image.width !== width || n.image.height !== height) throw new Error('CORE_BAD_ARGUMENT: neighbour frame size differs.');
      this.write(image, n.image.data);
      (n.occlusions || []).forEach((r, i) => this.writeRect(occlusions + i * 32, r));
      const view = new DataView(this.exports.memory.buffer, desc, 48);
      view.setUint32(0, image, true);
      view.setFloat64(8, n.x, true);
      view.setFloat64(16, n.y, true);
      view.setUint32(24, n.occlusions?.length ? occlusions : 0, true);
      view.setUint32(28, n.occlusions?.length || 0, true);
      view.setUint32(32, writeVote(nVoteDesc, nBits, nClean, n.voting), true);
      return desc;
    };
    const prev = writeNeighbour(7, input.prev), next = writeNeighbour(13, input.next);
    this.check(
      this.exports.ls_consistency_mask(
        rgba,
        labels,
        width,
        height,
        region,
        input.code,
        input.pose.x,
        input.pose.y,
        prev,
        next,
        vote,
        input.factor,
        input.noise,
        output,
      ),
      'consistencyMask',
    );
    return this.read(output, pixels);
  }
  pngUnfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8ClampedArray {
    const [input, output] = this.arena.plan([raw.byteLength, width * height * 4]);
    this.write(input, raw);
    this.check(this.exports.ls_png_unfilter(input, width, height, channels, output), 'PNG scanline reconstruction');
    return new Uint8ClampedArray(this.read(output, width * height * 4).buffer);
  }
  pngFilterSub(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const [input, output] = this.arena.plan([rgba.byteLength, (width * 4 + 1) * height]);
    this.write(input, rgba);
    this.check(this.exports.ls_png_filter_sub(input, width, height, output), 'PNG filtering');
    return this.read(output, (width * 4 + 1) * height);
  }

  meanDifference(a: Gray, b: Gray): number {
    if (a.width !== b.width || a.height !== b.height) return 255;
    const [pa, pb] = this.arena.plan([a.data.byteLength, b.data.byteLength]);
    this.write(pa, a.data);
    this.write(pb, b.data);
    return this.exports.ls_mean_difference(pa, pb, a.data.byteLength);
  }
  private writeMatches(ptr: number, matches: Match[]): void {
    const view = new DataView(this.exports.memory.buffer, ptr, matches.length * MATCH_POINT_BYTES);
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i], o = i * MATCH_POINT_BYTES;
      view.setFloat64(o, m.a.x, true);
      view.setFloat64(o + 8, m.a.y, true);
      view.setFloat64(o + 16, m.b.x, true);
      view.setFloat64(o + 24, m.b.y, true);
      view.setUint32(o + 32, m.unique ? 1 : 0, true);
      view.setUint32(o + 36, 0, true);
    }
  }
  private readMotions(ptr: number, count: number): Motion[] {
    const view = new DataView(this.exports.memory.buffer, ptr, count * MOTION_BYTES), out: Motion[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * MOTION_BYTES;
      out[i] = {
        x: view.getFloat64(o, true),
        y: view.getFloat64(o + 8, true),
        support: view.getUint32(o + 16, true),
        unique: view.getUint32(o + 20, true),
        confidence: view.getFloat64(o + 24, true),
        error: view.getFloat64(o + 32, true),
        ambiguous: view.getUint32(o + 40, true) === 1,
      };
    }
    return out;
  }
  translationHypotheses(matches: Match[], max: number): Motion[] {
    const [input, output] = this.arena.plan([matches.length * MATCH_POINT_BYTES, max * MOTION_BYTES]);
    this.writeMatches(input, matches);
    const count = this.check(this.exports.ls_translation_hypotheses(input, matches.length, max, output), 'translationHypotheses');
    return this.readMotions(output, count);
  }
  detectScale(matches: Match[]): number {
    const [input] = this.arena.plan([matches.length * MATCH_POINT_BYTES]);
    this.writeMatches(input, matches);
    return this.exports.ls_detect_scale(input, matches.length);
  }
  /** Plans two grey images plus an optional roi and extra buffers; returns their pointers in order. */
  private planGrays(a: Gray, b: Gray, roi: Rect | undefined, extra: number[]): { pa: number; pb: number; rect: number; extra: number[] } {
    const ptr = this.arena.plan([a.data.byteLength, b.data.byteLength, 32, ...extra]);
    this.write(ptr[0], a.data);
    this.write(ptr[1], b.data);
    if (roi) this.writeRect(ptr[2], roi);
    return { pa: ptr[0], pb: ptr[1], rect: roi ? ptr[2] : 0, extra: ptr.slice(3) };
  }
  verifyTranslation(a: Gray, b: Gray, dx: number, dy: number, roi?: Rect): number {
    const p = this.planGrays(a, b, roi, []);
    const result = this.exports.ls_verify_translation(p.pa, a.width, a.height, p.pb, b.width, b.height, dx, dy, p.rect);
    if (Number.isNaN(result)) throw new Error('CORE_BAD_ARGUMENT: verifyTranslation.');
    return result;
  }
  auditTranslation(a: Gray, b: Gray, dx: number, dy: number, roi: Rect | undefined, tolerant: boolean): AuditResult {
    const p = this.planGrays(a, b, roi, [64]);
    this.check(
      this.exports.ls_audit_translation(p.pa, a.width, a.height, p.pb, b.width, b.height, dx, dy, p.rect, tolerant ? 1 : 0, p.extra[0]),
      'auditTranslation',
    );
    const v = new Float64Array(this.read(p.extra[0], 64).buffer);
    return {
      error: v[0],
      mismatch: v[1],
      overlap: v[2],
      samples: v[3],
      blocks: v[4],
      agreeing: v[5],
      agreement: v[6],
      agreeingError: v[7],
    };
  }
  refineTranslation(a: Gray, b: Gray, p: { x: number; y: number }, roi: Rect | undefined, radius: number): { x: number; y: number } {
    const g = this.planGrays(a, b, roi, [8]);
    this.check(
      this.exports.ls_refine_translation(g.pa, a.width, a.height, g.pb, b.width, b.height, p.x, p.y, g.rect, radius, g.extra[0]),
      'refineTranslation',
    );
    const v = new Int32Array(this.read(g.extra[0], 8).buffer);
    return { x: v[0], y: v[1] };
  }
  estimateMotion(a: Gray, b: Gray, matches: Match[], featureCount: number): MotionField {
    if (a.width !== b.width || a.height !== b.height) throw new Error('FRAME_GEOMETRY_CHANGED');
    const cols = Math.ceil(b.width / MOTION_CELL), rows = Math.ceil(b.height / MOTION_CELL), n = cols * rows;
    const outBytes = MOTION_FIELD_HEADER + 8 * MOTION_BYTES + 3 * n;
    const [pa, pb, pm, output] = this.arena.plan([a.data.byteLength, b.data.byteLength, matches.length * MATCH_POINT_BYTES, outBytes]);
    this.write(pa, a.data);
    this.write(pb, b.data);
    this.writeMatches(pm, matches);
    this.check(this.exports.ls_estimate_motion(pa, pb, a.width, a.height, pm, matches.length, featureCount, output), 'estimateMotion');
    const bytes = this.read(output, outBytes), view = new DataView(bytes.buffer);
    const count = view.getUint32(12, true), base = MOTION_FIELD_HEADER + 8 * MOTION_BYTES;
    return {
      cols: view.getUint32(0, true),
      rows: view.getUint32(4, true),
      cell: view.getUint32(8, true),
      motions: this.readMotions(output + MOTION_FIELD_HEADER, count),
      difference: view.getFloat64(16, true),
      featureCount: view.getUint32(24, true),
      unknown: view.getUint32(28, true) === 1,
      zoom: view.getFloat64(32, true),
      labels: bytes.slice(base, base + n),
      confidence: bytes.slice(base + n, base + 2 * n),
      dynamic: bytes.slice(base + 2 * n, base + 3 * n),
    };
  }
  private readRefinement(ptr: number): RefinementResult {
    const view = new DataView(this.read(ptr, REFINEMENT_BYTES).buffer);
    return {
      x: view.getInt32(0, true),
      y: view.getInt32(4, true),
      error: view.getFloat64(8, true),
      samples: view.getUint32(16, true),
      runnerUp: view.getFloat64(24, true),
    };
  }
  refineNative(
    a: RGBA,
    b: RGBA,
    guess: { x: number; y: number },
    region: Rect,
    mask: LabelMask | undefined,
    radius: number,
  ): RefinementResult {
    if (a.width !== b.width || a.height !== b.height) {
      return { x: Math.round(guess.x), y: Math.round(guess.y), error: Infinity, samples: 0, runnerUp: Infinity };
    }
    const [pa, pb, rect, labels, output] = this.arena.plan([
      a.data.byteLength,
      b.data.byteLength,
      32,
      mask ? mask.labels.byteLength : 0,
      REFINEMENT_BYTES,
    ]);
    this.write(pa, a.data);
    this.write(pb, b.data);
    this.writeRect(rect, region);
    if (mask) this.write(labels, mask.labels);
    this.check(
      this.exports.ls_refine_native(pa, pb, a.width, a.height, guess.x, guess.y, rect, mask ? labels : 0, mask?.code ?? 0, radius, output),
      'refineNative',
    );
    return this.readRefinement(output);
  }
  refinePatches(patches: PatchInput[], native: Gray, region: Rect, guess: { x: number; y: number }, radius: number): RefinementResult {
    const ptr = this.arena.plan([
      native.data.byteLength,
      32,
      patches.length * PATCH_BYTES,
      REFINEMENT_BYTES,
      ...patches.map((p) => p.data.byteLength),
    ]);
    const [pn, rect, list, output] = ptr;
    this.write(pn, native.data);
    this.writeRect(rect, region);
    const view = new DataView(this.exports.memory.buffer, list, Math.max(1, patches.length * PATCH_BYTES));
    patches.forEach((p, i) => {
      if (p.data.byteLength !== p.size * p.size) throw new Error('CORE_BAD_ARGUMENT: patch data does not match its size.');
      this.write(ptr[4 + i], p.data);
      view.setInt32(i * PATCH_BYTES, p.x, true);
      view.setInt32(i * PATCH_BYTES + 4, p.y, true);
      view.setUint32(i * PATCH_BYTES + 8, p.size, true);
      view.setUint32(i * PATCH_BYTES + 12, ptr[4 + i], true);
    });
    this.check(
      this.exports.ls_refine_patches(list, patches.length, pn, native.width, native.height, rect, guess.x, guess.y, radius, output),
      'refinePatches',
    );
    return this.readRefinement(output);
  }
  resampleGray(g: Gray, scale: number): Gray {
    const width = Math.max(2, Math.round(g.width * scale)), height = Math.max(2, Math.round(g.height * scale));
    const [input, output] = this.arena.plan([g.data.byteLength, width * height]);
    this.write(input, g.data);
    this.check(this.exports.ls_resample_gray(input, g.width, g.height, scale, output), 'resampleGray');
    return { width, height, data: this.read(output, width * height) };
  }
  /** Plans the frame-wide observation buffers once; each `compositeTile` call then only moves one tile. */
  prepareObservation(obs: CompositeObservation, tileSize: number): PreparedObservation {
    const { width, height } = obs.image, pixels = width * height, n = tileSize * tileSize, blocks = (tileSize / 16) ** 2;
    const occlusions = obs.occlusions || [];
    const ptr = this.frameArena.plan([
      pixels * 4,
      obs.mask ? pixels : 0,
      occlusions.length * 32,
      obs.consistent ? pixels : 0,
      64,
      32,
      COMPOSITE_HEADER + 8 * blocks,
      40,
      n * 4,
      Math.ceil(n / 8),
      Math.ceil(n / 8),
      blocks,
      blocks,
      blocks * 4,
      blocks * 4,
      blocks,
    ]);
    const [
      rgba,
      labels,
      occ,
      consistent,
      desc,
      world,
      output,
      tileDesc,
      tPixels,
      tCoverage,
      tProvisional,
      tQuality,
      tConflicts,
      tOwner,
      tScore,
      tFrozen,
    ] = ptr;
    this.write(rgba, obs.image.data);
    if (obs.mask) this.write(labels, obs.mask.labels);
    occlusions.forEach((r, i) => this.writeRect(occ + i * 32, r));
    if (obs.consistent) this.write(consistent, obs.consistent);
    const view = new DataView(this.exports.memory.buffer, desc, 64);
    view.setUint32(0, rgba, true);
    view.setUint32(4, width, true);
    view.setUint32(8, height, true);
    view.setUint32(12, obs.mask ? labels : 0, true);
    view.setUint32(16, obs.mask?.code ?? 0, true);
    view.setUint32(20, occlusions.length ? occ : 0, true);
    view.setUint32(24, occlusions.length, true);
    view.setUint32(28, obs.consistent ? consistent : 0, true);
    view.setFloat64(32, obs.confidence, true);
    view.setUint32(40, obs.uncertain ? 1 : 0, true);
    view.setUint32(44, obs.frame, true);
    const tileView = new DataView(this.exports.memory.buffer, tileDesc, 40);
    [tPixels, tCoverage, tProvisional, tQuality, tConflicts, tOwner, tScore, tFrozen].forEach((p, i) => tileView.setUint32(i * 4, p, true));
    tileView.setUint32(32, tileSize, true);
    return {
      compositeTile: (tile, rect, ox, oy, tx, ty) => {
        if (tile.pixels.byteLength !== n * 4) throw new Error('CORE_BAD_ARGUMENT: tile size differs from the prepared observation.');
        this.write(tPixels, tile.pixels);
        this.write(tCoverage, tile.coverage);
        this.write(tProvisional, tile.provisional);
        this.write(tQuality, tile.quality);
        this.write(tConflicts, tile.conflicts);
        this.write(tOwner, tile.owner);
        this.write(tScore, tile.score);
        this.write(tFrozen, tile.frozen);
        this.writeRect(world, rect);
        this.check(this.exports.ls_composite_tile(tileDesc, desc, world, ox, oy, tx, ty, output), 'compositeTile');
        const result = new DataView(this.exports.memory.buffer, output, COMPOSITE_HEADER + 8 * blocks);
        const changed = result.getUint32(16, true) === 1, count = result.getUint32(20, true), mem = this.memory;
        if (changed) {
          tile.pixels.set(mem.subarray(tPixels, tPixels + n * 4));
          tile.coverage.set(mem.subarray(tCoverage, tCoverage + tile.coverage.byteLength));
          tile.provisional.set(mem.subarray(tProvisional, tProvisional + tile.provisional.byteLength));
        }
        // Block metadata can change without any pixel write (quality caps, ownership, conflicts).
        tile.quality.set(mem.subarray(tQuality, tQuality + blocks));
        tile.conflicts.set(mem.subarray(tConflicts, tConflicts + blocks));
        tile.owner.set(new Uint32Array(mem.buffer, tOwner, blocks));
        tile.score.set(new Float32Array(mem.buffer, tScore, blocks));
        const conflictBlocks: [number, number][] = [];
        for (let i = 0; i < count; i++) {
          conflictBlocks.push([result.getUint32(COMPOSITE_HEADER + i * 8, true), result.getUint32(COMPOSITE_HEADER + i * 8 + 4, true)]);
        }
        return {
          added: result.getUint32(0, true),
          conflicts: result.getUint32(4, true),
          uncertain: result.getUint32(8, true),
          provisionalPixels: result.getInt32(12, true),
          changed,
          conflictBlocks,
        };
      },
    };
  }
}

let active: Core | undefined;
/** The core must be loaded before any algorithm runs; there is deliberately no TypeScript fallback. */
export function core(): Core {
  if (!active) throw new Error('CORE_NOT_LOADED: call loadCore() before running the reconstruction pipeline.');
  return active;
}
export function coreLoaded(): boolean {
  return !!active;
}
export async function loadCore(source: BufferSource | Response | Promise<Response>): Promise<Core> {
  active = await Core.instantiate(source);
  return active;
}
/** Locates `core.wasm` next to the running bundle (browser) or the build output (Deno). */
export function coreURL(): URL {
  return new URL('./core.wasm', import.meta.url);
}
