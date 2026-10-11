import type { KV, Row } from './db.ts';
import type { CanvasMeta, RGBA, TilePayload } from '../types.ts';
import { deletePrefix, iterate } from './db.ts';
import { decodePNG, encodeRGBA } from '../codec/png.ts';
import { core, TILE_PLANES, type TileCacheHandle, type TileCacheStats } from '../core/wasm.ts';
export const QUALITY_BLOCK = 16;
export interface Tile {
  canvasId: string;
  level: number;
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  /** Same bit layout as `coverage`, level 0 only (pyramid tiles never set it — see TileStore.buildPyramid). A set
   *  bit is a covered pixel the world-consistency mask could not corroborate against a neighbouring frame when it
   *  was written; Compositor.add() clears it once a consistent observation overwrites that pixel. */
  provisional: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen: Uint8Array;
  dirty: boolean;
  existed: boolean;
  /** `performance.now()` of the last write that dirtied this tile; lets flush() skip tiles still being painted. */
  touched?: number;
}
export interface StoredTile extends TilePayload {
  coverage: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen?: Uint8Array;
}
export interface TileIndex {
  canvasId: string;
  level: number;
  x: number;
  y: number;
  observed: number;
}
/** Lossless tile serialisation. PNG in every runtime, so Deno tests exercise the shipped code path. */
export interface TileCodec {
  encode(image: RGBA): Promise<Blob>;
  decode(blob: Blob, size: number): Promise<Uint8ClampedArray>;
}
export const pngTileCodec: TileCodec = {
  encode: async (image) => new Blob([await encodeRGBA(image)], { type: 'image/png' }),
  decode: async (blob, size) => {
    const image = await decodePNG(new Uint8Array(await blob.arrayBuffer()));
    if (image.width !== size || image.height !== size) {
      throw new Error(`Stored tile is ${image.width}×${image.height}; expected ${size}×${size}.`);
    }
    return image.data;
  },
};
export function tileKey(canvasId: string, level: number, x: number, y: number): string {
  return `${canvasId}/${level}/${x}_${y}`;
}
export const covered = (tile: Tile, p: number): boolean => !!(tile.coverage[p >> 3] & (1 << (p & 7)));
export const markCovered = (tile: Tile, p: number): void => {
  tile.coverage[p >> 3] |= 1 << (p & 7);
};
export const provisional = (tile: Tile, p: number): boolean => !!(tile.provisional[p >> 3] & (1 << (p & 7)));
export function countCovered(coverage: Uint8Array): number {
  let observed = 0;
  for (const byte of coverage) {
    let v = byte;
    while (v) {
      observed++;
      v &= v - 1;
    }
  }
  return observed;
}
/** Typed-array constructor per plane, in `TILE_PLANES` order. */
const PLANE_TYPES = [Uint8ClampedArray, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint32Array, Float32Array, Uint8Array] as const;
type PlaneArray = Uint8ClampedArray | Uint8Array | Uint32Array | Float32Array;

/** A tile `TileStore.get` hands out. While the tile is resident its planes live in core memory (the engine's tile
 *  cache) and every read returns a fresh view, so a view must not be kept across a core call (one may grow memory and
 *  detach it); `dirty`/`touched` write through to the engine. When the cache evicts the tile, the view keeps a copy
 *  of its planes, so a caller still holding it can finish writing and `save()` it, as with a plain object. */
class TileView implements Tile {
  #ptrs: number[];
  #lens: number[];
  #detached: { planes: PlaneArray[]; dirty: boolean; existed: boolean; touched?: number } | undefined;
  #dropped = false;
  constructor(
    private readonly cache: TileCacheHandle,
    readonly canvasId: string,
    readonly level: number,
    readonly x: number,
    readonly y: number,
    readonly id: number,
  ) {
    const planes = cache.planes(id)!;
    this.#ptrs = planes.ptrs;
    this.#lens = planes.lens;
  }
  #plane(i: number): PlaneArray {
    if (this.#detached) return this.#detached.planes[i];
    if (this.#dropped) {
      throw new Error(`Tile ${tileKey(this.canvasId, this.level, this.x, this.y)} was dropped by TileStore.clear() or free().`);
    }
    const Type = PLANE_TYPES[i];
    return new Type(core().exports.memory.buffer, this.#ptrs[i], this.#lens[i] / Type.BYTES_PER_ELEMENT);
  }
  get pixels(): Uint8ClampedArray {
    return this.#plane(0) as Uint8ClampedArray;
  }
  get coverage(): Uint8Array {
    return this.#plane(1) as Uint8Array;
  }
  get provisional(): Uint8Array {
    return this.#plane(2) as Uint8Array;
  }
  get quality(): Uint8Array {
    return this.#plane(3) as Uint8Array;
  }
  get conflicts(): Uint8Array {
    return this.#plane(4) as Uint8Array;
  }
  get owner(): Uint32Array {
    return this.#plane(5) as Uint32Array;
  }
  get score(): Float32Array {
    return this.#plane(6) as Float32Array;
  }
  get frozen(): Uint8Array {
    return this.#plane(7) as Uint8Array;
  }
  get dirty(): boolean {
    return this.#detached ? this.#detached.dirty : this.cache.planes(this.id)!.dirty;
  }
  set dirty(dirty: boolean) {
    if (this.#detached) this.#detached.dirty = dirty;
    else this.cache.setDirty(this.id, dirty);
  }
  get existed(): boolean {
    return this.#detached ? this.#detached.existed : this.cache.planes(this.id)!.existed;
  }
  set existed(existed: boolean) {
    if (this.#detached) this.#detached.existed = existed;
    else if (existed !== this.existed) throw new Error('A resident tile only becomes stored through TileStore.');
  }
  get touched(): number | undefined {
    return this.#detached ? this.#detached.touched : this.cache.planes(this.id)!.touched;
  }
  set touched(touched: number | undefined) {
    if (this.#detached) this.#detached.touched = touched;
    else this.cache.setTouched(this.id, touched);
  }
  /** Still held by the engine's cache (not evicted, not cleared). */
  get resident(): boolean {
    return !this.#detached && !this.#dropped;
  }
  /** The cache evicted this tile: keep a copy of its planes and state. */
  detach(): void {
    const { dirty, existed, touched } = this.cache.planes(this.id)!;
    this.#detached = { planes: TILE_PLANES.map((_, i) => this.#plane(i).slice()), dirty, existed, touched };
  }
  /** The cache dropped every tile (`TileStore.clear()`). */
  drop(): void {
    this.#dropped = true;
  }
}

const releaseCache = new FinalizationRegistry((cache: TileCacheHandle) => cache.free());

/** The tile cache: the engine's (`long_screen::engine::tiles`: residency, LRU eviction, budget, dirty bookkeeping and
 *  counters, with the planes in core memory) plus the storage it does not do itself — loading and decoding a stored
 *  tile it asks for, and encoding and writing the tiles it evicts or flushes. */
export class TileStore {
  /** The engine's cache; the compositor drives it directly. */
  readonly engine: TileCacheHandle;
  private readonly resident = new Map<string, TileView>();
  private readonly byId = new Map<number, TileView>();
  constructor(readonly db: KV, readonly size = 512, memoryMB = 128, readonly codec: TileCodec = pngTileCodec) {
    if (!Number.isInteger(size) || size < QUALITY_BLOCK || size % QUALITY_BLOCK) {
      throw new Error(`Tile size must be a positive multiple of ${QUALITY_BLOCK}.`);
    }
    this.engine = core().tileCache(size, memoryMB);
    releaseCache.register(this, this.engine, this);
  }
  /** The limit and counters as they stood when `free()` released the engine's cache. */
  private released: { maxTiles: number; stats: TileCacheStats } | undefined;
  get maxTiles(): number {
    return this.released?.maxTiles ?? this.engine.maxTiles;
  }
  set maxTiles(max: number) {
    this.engine.maxTiles = max;
  }
  private stats(): TileCacheStats {
    return this.released?.stats ?? this.engine.stats();
  }
  get encodedTiles(): number {
    return this.stats().encoded;
  }
  get decodedTiles(): number {
    return this.stats().decoded;
  }
  get evictions(): number {
    return this.stats().evictions;
  }
  get peakResidentTiles(): number {
    return this.stats().peakResident;
  }
  /** Releases the engine's cache and its tiles without storing them (the run flushes first; a failed run leaves
   *  unflushed tiles, as it always has). The counters stay readable; anything else throws afterwards. Safe to call
   *  again. */
  free(): void {
    if (this.released) return;
    this.released = { maxTiles: this.engine.maxTiles, stats: this.engine.stats() };
    for (const t of this.byId.values()) t.drop();
    this.byId.clear();
    this.resident.clear();
    releaseCache.unregister(this);
    this.engine.free();
  }
  /** Checks residency without touching LRU order; callers can schedule hits before cold loads. */
  isResident(canvasId: string, x: number, y: number, level = 0): boolean {
    return this.resident.has(tileKey(canvasId, level, x, y));
  }
  async get(canvasId: string, x: number, y: number, level = 0): Promise<Tile> {
    const t = this.resident.get(tileKey(canvasId, level, x, y));
    if (t) {
      this.engine.touch(canvasId, level, x, y);
      return t;
    }
    return await this.load(canvasId, x, y, level);
  }
  /** Brings a tile the cache does not hold into it: evicts until there is room, then loads and decodes its stored
   *  copy, if any. The compositor calls this for each tile the engine asks for. An evicted tile is stored, when it
   *  is dirty, while the cache still holds it: a write that fails leaves it cached and dirty for a later flush. */
  async load(canvasId: string, x: number, y: number, level = 0): Promise<Tile> {
    for (let id = this.engine.victim(); id; id = this.engine.victim()) {
      const old = this.byId.get(id)!;
      await this.save(old);
      this.engine.evict(id);
      old.detach();
      this.engine.release(id);
      this.byId.delete(id);
      this.resident.delete(tileKey(old.canvasId, old.level, old.x, old.y));
    }
    const key = tileKey(canvasId, level, x, y), stored = await this.db.get<StoredTile>(`tile/${key}`);
    const pixels = stored ? await this.codec.decode(stored.blob, this.size) : undefined;
    const id = this.engine.insert(canvasId, level, x, y, stored && { ...stored, pixels: pixels! });
    const t = new TileView(this.engine, canvasId, level, x, y, id);
    this.resident.set(key, t);
    this.byId.set(id, t);
    return t;
  }
  /** Encodes one dirty tile into its two KV rows without writing them, so flush() can batch a whole pass into one
   *  putMany. A resident tile's planes are copied out of core memory: a row must not hold a view of it. */
  private async encodeRows(t: Tile): Promise<Row[]> {
    this.engine.encoded();
    const live = t instanceof TileView && t.resident, copy = <T extends PlaneArray>(a: T): T => (live ? a.slice() as T : a);
    const blob = await this.codec.encode({ width: this.size, height: this.size, data: copy(t.pixels) }),
      key = tileKey(t.canvasId, t.level, t.x, t.y);
    const stored: StoredTile = {
      blob,
      coverage: copy(t.coverage),
      provisional: copy(t.provisional),
      quality: copy(t.quality),
      conflicts: copy(t.conflicts),
      owner: copy(t.owner),
      score: copy(t.score),
      frozen: copy(t.frozen),
      level: t.level,
      x: t.x,
      y: t.y,
    };
    return [{ key: `tile/${key}`, value: stored }, {
      key: `tile-index/${key}`,
      value: { canvasId: t.canvasId, level: t.level, x: t.x, y: t.y, observed: countCovered(stored.coverage) } satisfies TileIndex,
    }];
  }
  /** Marks a tile stored: clean, with a stored copy. */
  private stored(t: Tile): void {
    if (t instanceof TileView && t.resident) {
      this.engine.saved(t.id);
    } else {
      t.dirty = false;
      t.existed = true;
    }
  }
  /** Stores a resident tile by its cache id (one an engine session wrote into the cache and marked dirty). */
  async saveResident(id: number): Promise<void> {
    const t = this.byId.get(id);
    if (!t) throw new Error(`CORE_BAD_ARGUMENT: tile ${id} is not resident.`);
    await this.save(t);
  }
  async save(t: Tile): Promise<void> {
    if (!t.dirty) {
      return;
    }
    await this.db.putMany(await this.encodeRows(t));
    this.stored(t);
  }
  /** Encodes and writes dirty resident tiles in one batch. With `settledBefore`, only tiles whose last write
   *  precedes that timestamp are written: tiles still being painted every frame are left for a later flush or
   *  for eviction, instead of being re-encoded on every periodic checkpoint. */
  async flush(settledBefore?: number): Promise<void> {
    const dirty = this.engine.dirty(settledBefore).map((id) => this.byId.get(id)!),
      rows: Row[] = [];
    for (const t of dirty) {
      rows.push(...await this.encodeRows(t));
    }
    if (rows.length) {
      await this.db.putMany(rows);
    }
    for (const t of dirty) this.stored(t);
  }
  async clear(): Promise<void> {
    await this.flush();
    for (const t of this.byId.values()) t.drop();
    this.byId.clear();
    this.resident.clear();
    this.engine.clear();
  }
  async payload(canvasId: string, level: number, x: number, y: number): Promise<TilePayload | undefined> {
    const key = tileKey(canvasId, level, x, y), cached = this.resident.get(key);
    if (cached) {
      await this.save(cached);
    }
    return this.db.get<StoredTile>(`tile/${key}`);
  }
  /** Small image pyramids are previews only. Level zero remains at source resolution. The engine's pyramid session
   *  (`long_screen::engine::pyramid`) decides the levels, the parents each level queues and their order, and
   *  assembles each parent; this host reads the stored rows it asks for and writes what it returns, straight to
   *  storage (the pyramid does not go through the tile cache). The `pyramid-todo/` rows record the queued parents
   *  while a level is built. */
  async buildPyramid(meta: CanvasMeta, onProgress: () => Promise<void>): Promise<void> {
    await this.clear();
    // A previous attempt on this same canvas that crashed mid-level can leave a stale work queue; start from a
    // clean one rather than resuming into (possibly inconsistent) leftovers.
    await deletePrefix(this.db, `pyramid-todo/${meta.id}/`);
    const size = this.size, session = core().pyramidSession(meta.id, meta.bounds.width, meta.bounds.height, size);
    try {
      for (let step = session.step(); step.kind !== 'done'; step = session.step()) {
        if (step.kind === 'index') {
          for await (const row of iterate<TileIndex>(this.db, `tile-index/${meta.id}/${step.level - 1}/`)) {
            const { x, y } = session.queue(row.value.x, row.value.y);
            await this.db.put(`pyramid-todo/${meta.id}/${step.level}/${x}_${y}`, { x, y });
          }
        } else if (step.kind === 'children') {
          const children: (Uint8ClampedArray | undefined)[] = [];
          for (const c of step.children) {
            const child = await this.db.get<StoredTile>(`tile/${tileKey(meta.id, c.level, c.x, c.y)}`);
            children.push(child ? await this.codec.decode(child.blob, size) : undefined);
          }
          session.provide(children);
        } else if (step.kind === 'parent') {
          const { level, x, y } = step;
          if (step.pixels) {
            const blob = await this.codec.encode({ width: size, height: size, data: step.pixels }), key = tileKey(meta.id, level, x, y);
            await this.db.putMany([{
              key: `tile/${key}`,
              value: { blob, x, y, level, owner: new Uint32Array(), score: new Float32Array() },
            }, { key: `tile-index/${key}`, value: { canvasId: meta.id, level, x, y, observed: 0 } satisfies TileIndex }]);
          }
          await this.db.delete(`pyramid-todo/${meta.id}/${level}/${x}_${y}`);
          await onProgress();
        } else {
          meta.maxLevel = step.level;
          await this.db.put(`canvas/${meta.id}`, meta);
        }
      }
    } finally {
      session.free();
      // Best-effort: never leave a half-drained work queue behind on a thrown error either.
      try {
        await deletePrefix(this.db, `pyramid-todo/${meta.id}/`);
      } catch { /* already unwinding */ }
    }
  }
}
