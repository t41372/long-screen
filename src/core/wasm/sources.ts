import type { Rect, Region } from '../../types.ts';
/** Native source candidate marshalling. No source-selection or image algorithm lives here. */
import { type FittedOpacityField, type OpacityAnnotation, type OpacityDescriptor, OpacityLearning } from './sources-opacity.ts';
import type { Core } from './core.ts';
import { type BytesInput, type FrameInput, FreeGuard, Resident, ResidentFrame } from './memory.ts';

export interface SourceTileStats {
  blocks: number;
  candidates: number;
  residentBytes: number;
  pages: number;
}
export interface SourceCapture {
  occlusions?: Rect[];
  state?: number;
  frame: number;
  time: number;
  poseX: number;
  poseY: number;
  code: number;
  quality: number;
}
export function sourceBytes(core: Core, handle: number): Uint8Array<ArrayBuffer> {
  core.check(handle, 'source result');
  try {
    const length = core.check(core.exports.ls_sources_bytes_len(handle), 'source result length');
    const [out] = core.scratch([length]);
    core.check(core.exports.ls_sources_bytes_read(handle, out), 'source result read');
    return core.readBytes(out, length);
  } finally {
    core.exports.ls_sources_bytes_free(handle);
  }
}
export function sourceJSON<T>(core: Core, handle: number): T {
  return JSON.parse(new TextDecoder().decode(sourceBytes(core, handle)));
}
export class SourceTile {
  private readonly freeGuard = new FreeGuard();
  constructor(private core: Core, private handle: number) {}
  capture(
    image: FrameInput,
    labels: BytesInput,
    visibility: BytesInput,
    input: SourceCapture,
    ownership?: Resident,
    contextVisibility?: Resident,
  ): void {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...input, width: image.width, height: image.height }));
    const n = image.width * image.height;
    const [desc, rgba, lab, vis] = this.core.scratch([
      bytes.length,
      image instanceof ResidentFrame ? 0 : n * 4,
      labels instanceof Resident ? 0 : n,
      visibility instanceof Resident ? 0 : n,
    ]);
    this.core.writeBytes(desc, bytes);
    const frame = this.core.placeFrame(image, rgba);
    if (!(labels instanceof Resident)) this.core.writeBytes(lab, labels);
    if (!(visibility instanceof Resident)) this.core.writeBytes(vis, visibility);
    this.core.check(
      this.core.exports.ls_sources_tile_capture(
        this.handle,
        desc,
        bytes.length,
        frame,
        labels instanceof Resident ? labels.ptr : lab,
        visibility instanceof Resident ? visibility.ptr : vis,
        ownership?.ptr ?? 0,
        contextVisibility?.ptr ?? 0,
      ),
      'capture source',
    );
  }
  state(): Uint8Array<ArrayBuffer> {
    return sourceBytes(this.core, this.core.exports.ls_sources_tile_state(this.handle));
  }
  spill(): Uint8Array<ArrayBuffer> | undefined {
    const h = this.core.check(this.core.exports.ls_sources_tile_spill(this.handle), 'source spill');
    return h ? sourceBytes(this.core, h) : undefined;
  }
  stats(): SourceTileStats {
    return sourceJSON(this.core, this.core.exports.ls_sources_tile_stats(this.handle));
  }
  free(): void {
    this.freeGuard.once(() => this.core.exports.ls_sources_tile_free(this.handle));
  }
}
export function sourceTile(
  core: Core,
  size: number,
  tx: number,
  ty: number,
  noise: number,
  disputes: Uint8Array,
  state?: Uint8Array,
): SourceTile {
  const data = state || disputes, [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  const handle = state ? core.exports.ls_sources_tile_load(ptr, state.length) : core.exports.ls_sources_tile_new(size, tx, ty, noise, ptr);
  return new SourceTile(core, core.check(handle, 'source tile'));
}

export interface SourceFrameSpan {
  first: number;
  last: number;
  poseX: number;
  poseY: number;
}
export interface SourceEpochOption {
  page: number;
  entry: number;
  frame: number;
  frames: SourceFrameSpan[];
  visible: number;
  present: number;
  quality: number;
}
export interface SourceBlockSummary {
  block: number;
  x: number;
  y: number;
  kind: 'Static' | 'Dynamic' | 'Ambiguous';
  candidates: number;
  expected: number;
  options: SourceEpochOption[];
}
export interface SourceBlockAddress {
  tx: number;
  ty: number;
  block: number;
  x: number;
  y: number;
  expected: number;
}
export interface SourceComponent {
  id: number;
  blocks: SourceBlockAddress[];
}
export interface SourceEpoch {
  frame: number | null;
  complete: boolean;
  completeBlocks: number;
  visiblePixels: number;
  presentPixels: number;
}
function jsonInput(core: Core, value: unknown): [number, number] {
  const data = new TextEncoder().encode(JSON.stringify(value)), [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  return [ptr, data.length];
}
export class SourceAnalysis {
  private freeGuard = new FreeGuard();
  constructor(private core: Core, private handle: number) {}
  baseline(history: Uint8Array, tile: { x: number; y: number; pixels: Uint8ClampedArray; coverage: Uint8Array }, size: number): void {
    const [h, p, c] = this.core.scratch([history.length, tile.pixels.byteLength, tile.coverage.length]);
    this.core.writeBytes(h, history);
    this.core.writeBytes(p, new Uint8Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.pixels.byteLength));
    this.core.writeBytes(c, tile.coverage);
    this.core.check(
      this.core.exports.ls_sources_analysis_baseline(this.handle, h, history.length, size, tile.x, tile.y, p, c),
      'existing source baseline',
    );
  }
  copyBaseline(other: SourceAnalysis): void {
    this.core.check(this.core.exports.ls_sources_analysis_copy_baseline(this.handle, other.handle), 'copy existing sources');
  }
  needsRefutation(): boolean {
    return this.core.check(this.core.exports.ls_sources_analysis_refute_needed(this.handle), 'source confidence') !== 0;
  }
  corroborate(data: Uint8Array, page: number): void {
    const [ptr] = this.core.scratch([data.length]);
    this.core.writeBytes(ptr, data);
    this.core.check(this.core.exports.ls_sources_analysis_corroborate(this.handle, ptr, data.length, page), 'source corroboration');
  }
  refute(data: Uint8Array, page: number): number {
    const [ptr] = this.core.scratch([data.length]);
    this.core.writeBytes(ptr, data);
    return this.core.check(
      this.core.exports.ls_sources_analysis_refute(this.handle, ptr, data.length, page),
      'occluded appearance witness',
    );
  }
  opacityLearning(data: Uint8Array, page: number, desc: OpacityDescriptor): OpacityLearning {
    return new OpacityLearning(this.core, this.handle, data, page, desc);
  }
  applyFittedOpacity(annotation: OpacityAnnotation, key: string, field: FittedOpacityField, noise: number): number {
    return annotation.applyFitted(this.handle, key, field, noise);
  }
  /** Annotate and select while the decoded archive is resident in the core. */
  annotate(data: Uint8Array, page: number, size: number, tx: number, ty: number, evidence: SourceEvidence): Uint8Array<ArrayBuffer> {
    return sourceArchiveAnnotate(this.core, data, page, size, tx, ty, evidence, this.handle);
  }
  feedOpacity(annotation: OpacityAnnotation, page: number): void {
    annotation.feed(this.handle, page);
  }
  feed(data: Uint8Array, page: number): void {
    const [ptr] = this.core.scratch([data.length]);
    this.core.writeBytes(ptr, data);
    this.core.check(this.core.exports.ls_sources_analysis_feed(this.handle, ptr, data.length, page), 'analyze source page');
  }
  summary(): SourceBlockSummary[] {
    return sourceJSON(this.core, this.core.exports.ls_sources_analysis_summary(this.handle));
  }
  options(): Uint8Array<ArrayBuffer> {
    return sourceBytes(this.core, this.core.exports.ls_sources_analysis_options(this.handle));
  }
  state(): Uint8Array<ArrayBuffer> {
    return sourceBytes(this.core, this.core.exports.ls_sources_analysis_state(this.handle));
  }
  block(block: number): { rgba: Uint8Array<ArrayBuffer>; frames: Uint32Array; reasons: Uint8Array<ArrayBuffer> } {
    const [rgba, frames, reasons] = this.core.scratch([1024, 1024, 256]);
    this.core.check(this.core.exports.ls_sources_analysis_block(this.handle, block, rgba, frames, reasons), 'source block result');
    return {
      rgba: this.core.readBytes(rgba, 1024),
      frames: new Uint32Array(this.core.readBytes(frames, 1024).buffer),
      reasons: this.core.readBytes(reasons, 256),
    };
  }
  epoch(data: Uint8Array, page: number, targets: { block: number; frame: number; component: number; complete: boolean }[]): void {
    const meta = new TextEncoder().encode(JSON.stringify(targets)), [ptr, desc] = this.core.scratch([data.length, meta.length]);
    this.core.writeBytes(ptr, data);
    this.core.writeBytes(desc, meta);
    this.core.check(
      this.core.exports.ls_sources_analysis_epoch(this.handle, ptr, data.length, page, desc, meta.length),
      'source component epoch',
    );
  }
  apply(
    tile: { x: number; y: number; pixels: Uint8ClampedArray; coverage: Uint8Array; provisional: Uint8Array; owner: Uint32Array },
    size: number,
  ): SourceApplied {
    const planes = [tile.pixels, tile.coverage, tile.provisional, tile.owner], ptrs = this.core.scratch(planes.map((p) => p.byteLength));
    planes.forEach((p, i) => this.core.writeBytes(ptrs[i], new Uint8Array(p.buffer, p.byteOffset, p.byteLength)));
    const handle = this.core.exports.ls_sources_analysis_apply(this.handle, size, tile.x, tile.y, ptrs[0], ptrs[1], ptrs[2], ptrs[3]);
    // Copy before reading JSON, whose result arena may reuse these pointers.
    planes.forEach((p, i) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength).set(this.core.readBytes(ptrs[i], p.byteLength)));
    return sourceJSON(this.core, handle);
  }
  missing(block: number, frame: number, component: number): void {
    this.core.check(this.core.exports.ls_sources_analysis_missing(this.handle, block, frame, component), 'partial source epoch');
  }
  free(): void {
    this.freeGuard.once(() => this.core.exports.ls_sources_analysis_free(this.handle));
  }
}
export function sourceAnalysis(core: Core, size: number, tx: number, ty: number, noise: number, state?: Uint8Array): SourceAnalysis {
  let handle: number;
  if (state) {
    const [ptr] = core.scratch([state.length]);
    core.writeBytes(ptr, state);
    handle = core.exports.ls_sources_analysis_load(ptr, state.length);
  } else handle = core.exports.ls_sources_analysis_new(size, tx, ty, noise);
  return new SourceAnalysis(core, core.check(handle, 'source analysis'));
}
export class SourceScene {
  private freeGuard = new FreeGuard();
  private handle: number;
  constructor(private core: Core) {
    this.handle = core.check(core.exports.ls_sources_scene_new(), 'source components');
  }
  add(tx: number, ty: number, summary: SourceBlockSummary[]): void {
    const [ptr, len] = jsonInput(this.core, summary);
    this.core.check(this.core.exports.ls_sources_scene_add(this.handle, tx, ty, ptr, len), 'source component tile');
  }
  components(): SourceComponent[] {
    return sourceJSON(this.core, this.core.exports.ls_sources_scene_components(this.handle));
  }
  free(): void {
    this.freeGuard.once(() => this.core.exports.ls_sources_scene_free(this.handle));
  }
}
export class SourceEpochSweep {
  private freeGuard = new FreeGuard();
  private handle: number;
  constructor(private core: Core) {
    this.handle = core.check(core.exports.ls_sources_epoch_new(), 'source epoch');
  }
  add(expected: number, options: SourceEpochOption[], newBlock = true): void {
    const [ptr, len] = jsonInput(this.core, options);
    this.core.check(this.core.exports.ls_sources_epoch_add(this.handle, expected, ptr, len, newBlock ? 1 : 0), 'source epoch options');
  }
  addPage(data: Uint8Array, blocks: SourceBlockAddress[]): void {
    const meta = new TextEncoder().encode(JSON.stringify(blocks)), [ptr, json] = this.core.scratch([data.length, meta.length]);
    this.core.writeBytes(ptr, data);
    this.core.writeBytes(json, meta);
    this.core.check(this.core.exports.ls_sources_epoch_page(this.handle, ptr, data.length, json, meta.length), 'packed source epochs');
  }
  choose(latest: boolean): SourceEpoch {
    return sourceJSON(this.core, this.core.exports.ls_sources_epoch_choose(this.handle, latest ? 1 : 0));
  }
  free(): void {
    this.freeGuard.once(() => this.core.exports.ls_sources_epoch_free(this.handle));
  }
}

export interface SourceApplied {
  added: number;
  provisional: number;
  changed: number;
  reasons: number[];
}
export interface SourceObject {
  region: number;
  id: number;
  frame: number;
  bounds: { x: number; y: number; width: number; height: number };
  role: 'Unknown' | 'PageDynamic' | 'Screen' | 'Local' | 'Background' | 'PageSurface';
  core: { x: number; y: number; length: number }[];
  poseX: number;
  poseY: number;
}
export interface SourceObjectState {
  region: number;
  id: number;
  first: number;
  last: number;
  role: SourceObject['role'];
  observations: number;
}
export interface SourceObjectUpdate {
  evidence: { frame: number; data: Uint8Array<ArrayBuffer> }[];
  states: SourceObjectState[];
  overflow: boolean;
}
export class SourceTracker {
  private freeGuard = new FreeGuard();
  private handle: number;
  constructor(private core: Core) {
    this.handle = core.check(core.exports.ls_sources_tracker_new(), 'source object tracker');
  }
  observe(
    current: ResidentFrame,
    previous: ResidentFrame | undefined,
    labels: Resident,
    visibility: Resident,
    input: {
      auxiliary?: boolean;
      ownership?: Resident;
      frame: number;
      code: number;
      poseX: number;
      poseY: number;
      previousX: number;
      previousY: number;
      noise: number;
    },
  ): SourceObjectUpdate {
    const [desc, len] = jsonInput(this.core, { ...input, ownership: input.ownership?.ptr, width: current.width, height: current.height });
    const result = sourceJSON<{ evidence: { frame: number; handle: number }[]; states: SourceObjectState[]; overflow: boolean }>(
      this.core,
      this.core.exports.ls_sources_tracker_observe(this.handle, desc, len, current.ptr, previous?.ptr ?? 0, labels.ptr, visibility.ptr),
    );
    return { ...result, evidence: result.evidence.map((e) => ({ frame: e.frame, data: sourceBytes(this.core, e.handle) })) };
  }
  free(): void {
    this.freeGuard.once(() => this.core.exports.ls_sources_tracker_free(this.handle));
  }
}
export interface SourceShard {
  x: number;
  y: number;
  disputes: Uint8Array;
}
export function sourceShards(core: Core, size: number, tx: number, ty: number, side: number, disputes: Uint8Array): SourceShard[] {
  const [ptr] = core.scratch([disputes.length]);
  core.writeBytes(ptr, disputes);
  const rows = sourceJSON<{ x: number; y: number; disputes: number[] }[]>(core, core.exports.ls_sources_shards(size, tx, ty, side, ptr));
  return rows.map((s) => ({ ...s, disputes: Uint8Array.from(s.disputes) }));
}
export function sourceArchiveFrames(core: Core, data: Uint8Array, page: number): number[] {
  const [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  return sourceJSON(core, core.exports.ls_sources_archive_frames(ptr, data.length, page));
}
export function sourceArchiveAnnotate(
  core: Core,
  data: Uint8Array,
  page: number,
  size: number,
  tx: number,
  ty: number,
  evidence: SourceEvidence,
  analysis = 0,
): Uint8Array<ArrayBuffer> {
  const meta = new TextEncoder().encode(JSON.stringify({ size, tx, ty, evidence: evidence.handle })),
    [ptr, desc] = core.scratch([data.length, meta.length]);
  core.writeBytes(ptr, data);
  core.writeBytes(desc, meta);
  return sourceBytes(core, core.exports.ls_sources_archive_annotate(ptr, data.length, page, desc, meta.length, analysis));
}

export function sourceArchiveExport(core: Core, data: Uint8Array, page: number, png: boolean): Uint8Array<ArrayBuffer> {
  const [ptr] = core.scratch([data.length]);
  core.writeBytes(ptr, data);
  return sourceBytes(core, core.exports.ls_sources_archive_export(ptr, data.length, page, png ? 1 : 0));
}

export class SourceRoles {
  private guard = new FreeGuard();
  readonly handle: number;
  constructor(private core: Core, states: SourceObjectState[], region = 0) {
    const [ptr, len] = jsonInput(core, states);
    this.handle = core.check(core.exports.ls_sources_roles_new(ptr, len, region), 'source object roles');
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_roles_free(this.handle));
  }
}
export class SourceEvidence {
  private guard = new FreeGuard();
  readonly handle: number;
  constructor(private core: Core, chunks: Uint8Array[], states: SourceRoles) {
    const [desc, ...pointers] = core.scratch([chunks.length * 8, ...chunks.map((c) => c.length)]);
    chunks.forEach((chunk, i) => core.writeBytes(pointers[i], chunk));
    const table = new Uint32Array(chunks.length * 2);
    chunks.forEach((chunk, i) => {
      table[i * 2] = pointers[i];
      table[i * 2 + 1] = chunk.length;
    });
    core.writeBytes(desc, new Uint8Array(table.buffer));
    this.handle = core.check(core.exports.ls_sources_evidence_new(desc, chunks.length, states.handle), 'native object evidence');
  }
  free(): void {
    this.guard.once(() => this.core.exports.ls_sources_evidence_free(this.handle));
  }
}

export function parentLabels(core: Core, labels: Resident, regions: Region[], code: (region: Region) => number): Resident | undefined {
  const description = regions.map((r) => ({ code: code(r), fixed: r.kind === 'fixed', rect: r.rect, crop: r.crop ?? r.rect }));
  const [ptr, len] = jsonInput(core, description), out = core.alloc(labels.length);
  let keep = false;
  try {
    const changed = core.check(
      core.exports.ls_sources_parent_labels(labels.ptr, labels.length, ptr, len, out.ptr),
      'source parent ownership',
    );
    keep = changed > 0;
    return keep ? out : undefined;
  } finally {
    if (!keep) out.free();
  }
}

export function ownershipShards(core: Core, labels: Resident, parents: Resident, input: {
  width: number;
  height: number;
  code: number;
  side: number;
  poses: [number, number][];
}): SourceShard[] {
  const [ptr, len] = jsonInput(core, input);
  return sourceJSON<{ x: number; y: number; disputes: number[] }[]>(
    core,
    core.exports.ls_sources_ownership_shards(labels.ptr, parents.ptr, ptr, len),
  )
    .map((s) => ({ ...s, disputes: Uint8Array.from(s.disputes) }));
}
