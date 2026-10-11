/** The engine's tile cache (`long_screen_engine::tiles`, via `rust/wasm/src/tiles.rs`): residency, LRU eviction,
 *  the memory budget, dirty bookkeeping and the encode/decode counters. Tile planes live in core memory; `planes()`
 *  reports where, and those pointers stay valid while the tile is resident (or, once evicted, until `release()`). */
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { FreeGuard } from './memory.ts';

/** `ls_tiles_planes` output and `ls_tiles_insert` input layouts (`rust/wasm/src/tiles.rs`). */
const PLANES_BYTES = 80, STORED_BYTES = 64;
/** `ls_tiles_planes`: the id is neither resident nor evicted-and-unreleased. */
const NO_TILE = -2;

/** Plane order shared by both layouts. */
export const TILE_PLANES = ['pixels', 'coverage', 'provisional', 'quality', 'conflicts', 'owner', 'score', 'frozen'] as const;
export type TilePlane = typeof TILE_PLANES[number];

export interface TilePlanes {
  /** Byte pointer and byte length of each plane, in `TILE_PLANES` order. */
  ptrs: number[];
  lens: number[];
  dirty: boolean;
  existed: boolean;
  touched: number | undefined;
}

/** A stored tile's decoded pixels and whichever side planes its row carries. */
export interface StoredPlanes {
  pixels: ArrayBufferView;
  coverage?: ArrayBufferView;
  provisional?: ArrayBufferView;
  quality?: ArrayBufferView;
  conflicts?: ArrayBufferView;
  owner?: ArrayBufferView;
  score?: ArrayBufferView;
  frozen?: ArrayBufferView;
}

export interface TileCacheStats {
  encoded: number;
  decoded: number;
  evictions: number;
  peakResident: number;
}

const encoder = new TextEncoder();

export class TileCacheHandle {
  private readonly freeGuard = new FreeGuard();
  constructor(private readonly core: Core, private readonly exports: CoreExports, readonly handle: number) {}
  /** Writes `canvas`'s UTF-8 bytes (plus `extra` more scratch bytes) into transient scratch. */
  private key(canvas: string, extra: number[] = []): [number, number, ...number[]] {
    const bytes = encoder.encode(canvas), [ptr, ...rest] = this.core.scratch([Math.max(1, bytes.length), ...extra]);
    this.core.writeBytes(ptr, bytes);
    return [ptr, bytes.length, ...rest];
  }
  get maxTiles(): number {
    return this.core.check(this.exports.ls_tiles_max(this.handle), 'tilesMax');
  }
  set maxTiles(max: number) {
    this.core.check(this.exports.ls_tiles_set_max(this.handle, max), 'tilesSetMax');
  }
  stats(): TileCacheStats {
    const [out] = this.core.scratch([32]);
    this.core.check(this.exports.ls_tiles_stats(this.handle, out), 'tilesStats');
    const view = new DataView(this.exports.memory.buffer, out, 32);
    return {
      encoded: view.getFloat64(0, true),
      decoded: view.getFloat64(8, true),
      evictions: view.getFloat64(16, true),
      peakResident: view.getFloat64(24, true),
    };
  }
  /** Makes a resident tile the most recently used one; returns its id, 0 when it is not resident. */
  touch(canvas: string, level: number, x: number, y: number): number {
    const [ptr, len] = this.key(canvas);
    return this.core.check(this.exports.ls_tiles_touch(this.handle, ptr, len, level, x, y), 'tilesTouch');
  }
  /** The tile to let go to make room for one more (the least recently used one while the cache is full), without
   *  changing anything; 0 when there is room. Store it if it is dirty, then `evict()` it. */
  victim(): number {
    return this.core.check(this.exports.ls_tiles_victim(this.handle), 'tilesVictim');
  }
  /** Evicts a resident tile; its planes stay readable until `release()`. */
  evict(id: number): void {
    this.core.check(this.exports.ls_tiles_evict(this.handle, id), 'tilesEvict');
  }
  /** Frees an evicted tile's planes. */
  release(id: number): void {
    this.exports.ls_tiles_release(this.handle, id);
  }
  /** Adds a tile as the most recently used one, from `stored` or empty. Returns its id. */
  insert(canvas: string, level: number, x: number, y: number, stored?: StoredPlanes): number {
    const planes = stored ? TILE_PLANES.map((p) => stored[p]) : [];
    const [ptr, len, desc, ...slots] = this.key(canvas, stored ? [STORED_BYTES, ...planes.map((p) => p?.byteLength ?? 0)] : []);
    if (stored) {
      const view = new DataView(this.exports.memory.buffer);
      planes.forEach((p, i) => {
        if (p) this.core.writeBytes(slots[i], p);
        // A present but empty plane still needs a non-zero pointer: 0 means "absent".
        view.setUint32(desc + i * 8, p ? slots[i] || desc : 0, true);
        view.setUint32(desc + i * 8 + 4, p?.byteLength ?? 0, true);
      });
    }
    return this.core.check(this.exports.ls_tiles_insert(this.handle, ptr, len, level, x, y, stored ? desc : 0), 'tilesInsert');
  }
  /** Where a tile's planes are; undefined once it is neither resident nor evicted-and-unreleased. */
  planes(id: number): TilePlanes | undefined {
    const [out] = this.core.scratch([PLANES_BYTES]);
    const status = this.exports.ls_tiles_planes(this.handle, id, out);
    if (status === NO_TILE) return undefined;
    this.core.check(status, 'tilesPlanes');
    const view = new DataView(this.exports.memory.buffer, out, PLANES_BYTES), touched = view.getFloat64(72, true);
    return {
      ptrs: TILE_PLANES.map((_, i) => view.getUint32(i * 8, true)),
      lens: TILE_PLANES.map((_, i) => view.getUint32(i * 8 + 4, true)),
      dirty: view.getUint32(64, true) !== 0,
      existed: view.getUint32(68, true) !== 0,
      touched: Number.isNaN(touched) ? undefined : touched,
    };
  }
  setDirty(id: number, dirty: boolean): void {
    this.core.check(this.exports.ls_tiles_set_dirty(this.handle, id, dirty ? 1 : 0), 'tilesSetDirty');
  }
  setTouched(id: number, touched: number | undefined): void {
    this.core.check(this.exports.ls_tiles_set_touched(this.handle, id, touched ?? NaN), 'tilesSetTouched');
  }
  /** Dirty resident tiles a flush stores, least recently used first; with `settledBefore`, only those last written
   *  before it. */
  dirty(settledBefore?: number): number[] {
    const count = this.core.check(this.exports.ls_tiles_dirty(this.handle, settledBefore ?? NaN, 0, 0), 'tilesDirty');
    if (!count) return [];
    const [out] = this.core.scratch([count * 4]);
    this.core.check(this.exports.ls_tiles_dirty(this.handle, settledBefore ?? NaN, out, count), 'tilesDirty');
    return Array.from(new Uint32Array(this.exports.memory.buffer, out, count));
  }
  /** Counts one tile encoded for storage. */
  encoded(): void {
    this.exports.ls_tiles_encoded(this.handle);
  }
  /** A resident tile was stored: clean, with a stored copy. */
  saved(id: number): void {
    this.exports.ls_tiles_saved(this.handle, id);
  }
  observed(id: number): number {
    return this.core.check(this.exports.ls_tiles_observed(this.handle, id), 'tilesObserved');
  }
  clear(): void {
    this.exports.ls_tiles_clear(this.handle);
  }
  free(): void {
    this.freeGuard.once(() => this.exports.ls_tiles_free(this.handle));
  }
}

export function newTileCache(core: Core, exports: CoreExports, size: number, memoryMB: number): TileCacheHandle {
  return new TileCacheHandle(core, exports, core.check(exports.ls_tiles_new(size, memoryMB), 'tilesNew'));
}
