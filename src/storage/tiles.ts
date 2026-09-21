import type { KV } from './db.ts';
import type { CanvasMeta, RGBA, TilePayload } from '../types.ts';
import { iterate } from './db.ts';
import { decodePNG, encodeRGBA } from '../codec/png.ts';
import { halveRGBA } from '../core/raster.ts';
export const QUALITY_BLOCK = 16;
export interface Tile {
  canvasId: string;
  level: number;
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen: Uint8Array;
  dirty: boolean;
  existed: boolean;
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
  async save(t: Tile): Promise<void> {
    if (!t.dirty) {
      return;
    }
    this.encodedTiles++;
    const blob = await this.codec.encode({ width: this.size, height: this.size, data: t.pixels }),
      key = tileKey(t.canvasId, t.level, t.x, t.y);
    const stored: StoredTile = {
      blob,
      coverage: t.coverage,
      quality: t.quality,
      conflicts: t.conflicts,
      owner: t.owner,
      score: t.score,
      frozen: t.frozen,
      level: t.level,
      x: t.x,
      y: t.y,
    };
    await this.db.putMany([{ key: `tile/${key}`, value: stored }, {
      key: `tile-index/${key}`,
      value: { canvasId: t.canvasId, level: t.level, x: t.x, y: t.y, observed: countCovered(t.coverage) } satisfies TileIndex,
    }]);
    t.dirty = false;
    t.existed = true;
  }
  async flush(): Promise<void> {
    for (const t of this.cache.values()) {
      await this.save(t);
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
    const size = this.size, half = size / 2;
    const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(meta.bounds.width, meta.bounds.height) / size)));
    for (let level = 1; level <= maxLevel; level++) {
      for await (const row of iterate<TileIndex>(this.db, `tile-index/${meta.id}/${level - 1}/`)) {
        const t = row.value, x = Math.floor(t.x / 2), y = Math.floor(t.y / 2);
        await this.db.put(`pyramid-todo/${meta.id}/${level}/${x}_${y}`, { x, y });
      }
      for await (const row of iterate<{ x: number; y: number }>(this.db, `pyramid-todo/${meta.id}/${level}/`)) {
        const { x, y } = row.value, parent = new Uint8ClampedArray(size * size * 4);
        let any = false;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const child = await this.db.get<StoredTile>(`tile/${tileKey(meta.id, level - 1, x * 2 + dx, y * 2 + dy)}`);
            if (!child) {
              continue;
            }
            const small = halveRGBA({ width: size, height: size, data: await this.codec.decode(child.blob, size) });
            for (let r = 0; r < half; r++) {
              parent.set(small.data.subarray(r * half * 4, (r + 1) * half * 4), ((dy * half + r) * size + dx * half) * 4);
            }
            any = true;
          }
        }
        if (any) {
          const blob = await this.codec.encode({ width: size, height: size, data: parent }), key = tileKey(meta.id, level, x, y);
          await this.db.putMany([{
            key: `tile/${key}`,
            value: { blob, x, y, level, coverage: new Uint8Array(), owner: new Uint32Array(), score: new Float32Array() },
          }, { key: `tile-index/${key}`, value: { canvasId: meta.id, level, x, y, observed: 0 } satisfies TileIndex }]);
        }
        await this.db.delete(row.key);
        await onProgress();
      }
      meta.maxLevel = level;
      await this.db.put(`canvas/${meta.id}`, meta);
    }
  }
}
