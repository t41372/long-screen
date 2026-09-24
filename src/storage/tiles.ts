import type { KV, Row } from './db.ts';
import type { CanvasMeta, RGBA, TilePayload } from '../types.ts';
import { deletePrefix, iterate } from './db.ts';
import { decodePNG, encodeRGBA } from '../codec/png.ts';
import { core } from '../core/wasm.ts';
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
export class TileStore {
  private cache = new Map<string, Tile>();
  maxTiles: number;
  encodedTiles = 0;
  decodedTiles = 0;
  evictions = 0;
  peakResidentTiles = 0;
  constructor(readonly db: KV, readonly size = 512, memoryMB = 128, readonly codec: TileCodec = pngTileCodec) {
    if (!Number.isInteger(size) || size < QUALITY_BLOCK || size % QUALITY_BLOCK) {
      throw new Error(`Tile size must be a positive multiple of ${QUALITY_BLOCK}.`);
    }
    // Reserve most requested working memory for native frames, decoder surfaces, features, and UI.
    this.maxTiles = Math.max(2, Math.floor(memoryMB * 1024 * 1024 * .30 / (size * size * 4.3)));
  }
  /** Rebalance the same working-memory budget between passes. Rendering no longer holds solve-reference frames. */
  configureBudget(memoryMB: number, reservedBytes: number): void {
    const available = Math.max(0, memoryMB * 1024 * 1024 - reservedBytes);
    this.maxTiles = Math.max(2, Math.floor(available * .8 / (this.size * this.size * 4.3)));
  }
  /** Tiles one frame of `width`×`height` can touch at any integer pose (a partial tile on each side). */
  footprint(width: number, height: number): number {
    return (Math.ceil(width / this.size) + 1) * (Math.ceil(height / this.size) + 1);
  }
  /** Raises the cache limit to at least one frame footprint. An LRU cache smaller than the set a frame touches
   *  every pass turns each frame into a full miss cycle (measured: 13,800 decodes / 29,220 encodes over 935
   *  frames at 3456×2234 with a 38-tile limit), so the budget yields here; returns the tiles added, 0 if none. */
  ensureFootprint(width: number, height: number): number {
    const needed = this.footprint(width, height) + 2;
    if (this.maxTiles >= needed) return 0;
    const added = needed - this.maxTiles;
    this.maxTiles = needed;
    return added;
  }
  /** Checks residency without touching LRU order; callers can schedule hits before cold loads. */
  isResident(canvasId: string, x: number, y: number, level = 0): boolean {
    return this.cache.has(tileKey(canvasId, level, x, y));
  }
  async get(canvasId: string, x: number, y: number, level = 0): Promise<Tile> {
    const key = tileKey(canvasId, level, x, y);
    let t = this.cache.get(key);
    if (t) {
      this.cache.delete(key);
      this.cache.set(key, t);
      return t;
    }
    while (this.cache.size >= this.maxTiles) {
      const [oldKey, old] = this.cache.entries().next().value!;
      await this.save(old);
      this.evictions++;
      this.cache.delete(oldKey);
    }
    const stored = await this.db.get<StoredTile>(`tile/${key}`),
      n = this.size * this.size,
      blocks = Math.ceil(this.size / QUALITY_BLOCK) ** 2;
    if (stored) this.decodedTiles++;
    const pixels = stored ? await this.codec.decode(stored.blob, this.size) : new Uint8ClampedArray(n * 4);
    t = {
      canvasId,
      x,
      y,
      level,
      pixels,
      coverage: stored?.coverage || new Uint8Array(Math.ceil(n / 8)),
      provisional: stored?.provisional || new Uint8Array(Math.ceil(n / 8)),
      quality: stored?.quality || new Uint8Array(blocks),
      conflicts: stored?.conflicts || new Uint8Array(blocks),
      owner: stored?.owner || new Uint32Array(blocks),
      score: stored?.score || new Float32Array(blocks),
      frozen: stored?.frozen || new Uint8Array(blocks),
      dirty: false,
      existed: !!stored,
    };
    this.cache.set(key, t);
    this.peakResidentTiles = Math.max(this.peakResidentTiles, this.cache.size);
    return t;
  }
  /** Encodes one dirty tile into its two KV rows without writing them, so flush() can batch a whole pass into one putMany. */
  private async encodeRows(t: Tile): Promise<Row[]> {
    this.encodedTiles++;
    const blob = await this.codec.encode({ width: this.size, height: this.size, data: t.pixels }),
      key = tileKey(t.canvasId, t.level, t.x, t.y);
    const stored: StoredTile = {
      blob,
      coverage: t.coverage,
      provisional: t.provisional,
      quality: t.quality,
      conflicts: t.conflicts,
      owner: t.owner,
      score: t.score,
      frozen: t.frozen,
      level: t.level,
      x: t.x,
      y: t.y,
    };
    return [{ key: `tile/${key}`, value: stored }, {
      key: `tile-index/${key}`,
      value: { canvasId: t.canvasId, level: t.level, x: t.x, y: t.y, observed: countCovered(t.coverage) } satisfies TileIndex,
    }];
  }
  async save(t: Tile): Promise<void> {
    if (!t.dirty) {
      return;
    }
    await this.db.putMany(await this.encodeRows(t));
    t.dirty = false;
    t.existed = true;
  }
  /** Encodes and writes dirty resident tiles in one batch. With `settledBefore`, only tiles whose last write
   *  precedes that timestamp are written: tiles still being painted every frame are left for a later flush or
   *  for eviction, instead of being re-encoded on every periodic checkpoint. */
  async flush(settledBefore?: number): Promise<void> {
    const dirty = [...this.cache.values()].filter((t) => t.dirty && (settledBefore === undefined || (t.touched ?? 0) < settledBefore)),
      rows: Row[] = [];
    for (const t of dirty) {
      rows.push(...await this.encodeRows(t));
    }
    if (rows.length) {
      await this.db.putMany(rows);
    }
    for (const t of dirty) {
      t.dirty = false;
      t.existed = true;
    }
  }
  async clear(): Promise<void> {
    await this.flush();
    this.cache.clear();
  }
  async payload(canvasId: string, level: number, x: number, y: number): Promise<TilePayload | undefined> {
    const key = tileKey(canvasId, level, x, y), cached = this.cache.get(key);
    if (cached) {
      await this.save(cached);
    }
    return this.db.get<StoredTile>(`tile/${key}`);
  }
  /** Small image pyramids are previews only. Level zero remains at source resolution. */
  async buildPyramid(meta: CanvasMeta, onProgress: () => Promise<void>): Promise<void> {
    await this.clear();
    // A previous attempt on this same canvas that crashed mid-level can leave a stale work queue; start from a
    // clean one rather than resuming into (possibly inconsistent) leftovers.
    await deletePrefix(this.db, `pyramid-todo/${meta.id}/`);
    const size = this.size;
    // How many times `size` must double to reach or pass the larger bound dimension — `ceil(log2(dimension /
    // size))` (clamped to 0), computed by repeated doubling instead of `Math.log2`: a floating-point log/exp
    // implementation is not guaranteed bit-identical across engines, and a wrong level count here would change
    // how many pyramid levels get built, not just round a display value. Loop count is small in practice (tile
    // sizes are at least tens of pixels; `size` doubles each step) and bounded by `POSE_BOUND`'s addressable
    // canvas range regardless.
    const maxDimension = Math.max(meta.bounds.width, meta.bounds.height);
    let maxLevel = 0;
    for (let scale = size; scale < maxDimension; scale *= 2) maxLevel++;
    try {
      for (let level = 1; level <= maxLevel; level++) {
        for await (const row of iterate<TileIndex>(this.db, `tile-index/${meta.id}/${level - 1}/`)) {
          const t = row.value, x = Math.floor(t.x / 2), y = Math.floor(t.y / 2);
          await this.db.put(`pyramid-todo/${meta.id}/${level}/${x}_${y}`, { x, y });
        }
        for await (const row of iterate<{ x: number; y: number }>(this.db, `pyramid-todo/${meta.id}/${level}/`)) {
          const { x, y } = row.value;
          // Quadrant order [dx=0,dy=0], [dx=1,dy=0], [dx=0,dy=1], [dx=1,dy=1] — row-major over the 2×2 grid,
          // matching rust/core/src/pyramid.rs::assemble_parent.
          const children: (Uint8ClampedArray | undefined)[] = [];
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const child = await this.db.get<StoredTile>(`tile/${tileKey(meta.id, level - 1, x * 2 + dx, y * 2 + dy)}`);
              children.push(child ? await this.codec.decode(child.blob, size) : undefined);
            }
          }
          const any = children.some((c) => c);
          if (any) {
            const parent = core().assemblePyramidParent(children, size);
            const blob = await this.codec.encode(parent), key = tileKey(meta.id, level, x, y);
            await this.db.putMany([{
              key: `tile/${key}`,
              value: { blob, x, y, level, owner: new Uint32Array(), score: new Float32Array() },
            }, { key: `tile-index/${key}`, value: { canvasId: meta.id, level, x, y, observed: 0 } satisfies TileIndex }]);
          }
          await this.db.delete(row.key);
          await onProgress();
        }
        meta.maxLevel = level;
        await this.db.put(`canvas/${meta.id}`, meta);
      }
    } finally {
      // Best-effort: never leave a half-drained work queue behind on a thrown error either.
      try {
        await deletePrefix(this.db, `pyramid-todo/${meta.id}/`);
      } catch { /* already unwinding */ }
    }
  }
}
