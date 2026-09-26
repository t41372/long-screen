/** Bounded active candidate tiles. Every evicted alternative is written to an immutable archive page;
 * state and newly appended pages commit together. No image or source-selection algorithm lives here. */
import type { KV, Row } from './db.ts';
import {
  type BytesInput,
  core,
  type FrameInput,
  type Resident,
  type SourceCapture,
  type SourceTile,
  type SourceTileStats,
} from '../core/wasm.ts';

export interface SourceTileAddress {
  canvasId: string;
  x: number;
  y: number;
}
export interface StoredSourceTile extends SourceTileAddress {
  version: 1;
  state: Uint8Array;
  pages: number;
  residentBytes: number;
}
interface Entry {
  address: SourceTileAddress;
  native: SourceTile;
  bytes: number;
  dirty: boolean;
  pending: Row[];
}
export const sourceKey = (a: SourceTileAddress): string => `${a.canvasId}/${a.x}_${a.y}`;
export class SourceStore {
  private cache = new Map<string, Entry>();
  private resident = 0;
  peakResidentBytes = 0;
  largestTileBytes = 0;
  archivePages = 0;
  archiveBytes = 0;
  stateWrites = 0;
  constructor(readonly db: KV, readonly size: number, readonly noise: number, readonly budgetBytes = 12 * 1024 * 1024) {}
  private async get(address: SourceTileAddress, disputes: Uint8Array): Promise<SourceTile> {
    const key = sourceKey(address);
    let entry = this.cache.get(key);
    if (entry) {
      if (entry.pending.length) await this.save(entry);
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.native;
    }
    const stored = await this.db.get<StoredSourceTile>(`source-state/${key}`);
    await this.reserve(stored?.residentBytes ?? disputes.length * 128);
    const native = core().sourceTile(this.size, address.x, address.y, this.noise, disputes, stored?.state);
    entry = { address, native, bytes: native.stats().residentBytes, dirty: !stored, pending: [] };
    this.cache.set(key, entry);
    this.resident += entry.bytes;
    this.measure();
    return native;
  }
  async capture(
    address: SourceTileAddress,
    disputes: Uint8Array,
    image: FrameInput,
    labels: BytesInput,
    visibility: BytesInput,
    input: SourceCapture,
    ownership?: Resident,
    contextVisibility?: Resident,
  ): Promise<SourceTileStats> {
    const native = await this.get(address, disputes), key = sourceKey(address), entry = this.cache.get(key)!;
    // One new native patch plus vector growth per indexed block. Reserving before capture/load makes
    // the measured peak include transients, rather than reporting only the post-eviction cache size.
    await this.reserve(native.stats().blocks * 4096, key);
    native.capture(image, labels, visibility, input, ownership, contextVisibility);
    const stats = native.stats();
    this.resident += stats.residentBytes - entry.bytes;
    entry.bytes = stats.residentBytes;
    entry.dirty = true;
    this.measure();
    if (entry.bytes > this.budgetBytes / 2) await this.save(entry);
    return stats;
  }
  private measure(): void {
    this.peakResidentBytes = Math.max(this.peakResidentBytes, this.resident);
    for (const entry of this.cache.values()) this.largestTileBytes = Math.max(this.largestTileBytes, entry.bytes);
  }
  private async reserve(extra: number, held?: string): Promise<void> {
    for (const [key, entry] of this.cache) {
      if (this.resident + extra <= this.budgetBytes) break;
      if (key === held) continue;
      await this.save(entry);
      this.resident -= entry.bytes;
      this.cache.delete(key);
      entry.native.free();
    }
  }
  private async save(entry: Entry): Promise<void> {
    if (!entry.dirty && !entry.pending.length) return;
    const key = sourceKey(entry.address);
    // A failed transaction retains these immutable payloads for the retry; take_spill is never repeated
    // before its previous batch commits, so an interrupted flush cannot lose an archive page silently.
    if (!entry.pending.length) {
      const page = entry.native.spill(), stats = entry.native.stats();
      if (page) entry.pending.push({ key: `source-page/${key}/${String(stats.pages - 1).padStart(10, '0')}`, value: page });
      entry.pending.push({
        key: `source-state/${key}`,
        value: {
          ...entry.address,
          version: 1,
          state: entry.native.state(),
          pages: stats.pages,
          residentBytes: stats.residentBytes,
        } satisfies StoredSourceTile,
      });
    }
    await this.db.putMany(entry.pending);
    for (const row of entry.pending) {
      if (row.key.startsWith('source-page/')) {
        this.archivePages++;
        this.archiveBytes += (row.value as Uint8Array).byteLength;
      }
    }
    this.stateWrites++;
    entry.pending = [];
    entry.dirty = false;
    const bytes = entry.native.stats().residentBytes;
    this.resident += bytes - entry.bytes;
    entry.bytes = bytes;
  }
  async flush(): Promise<void> {
    for (const entry of this.cache.values()) await this.save(entry);
  }
  free(): void {
    for (const entry of this.cache.values()) entry.native.free();
    this.cache.clear();
    this.resident = 0;
  }
}

/** Immutable candidate pages, followed by the four hot representatives. Missing pages are errors,
 * never silently treated as an empty history. */
export async function* sourcePages(db: KV, row: StoredSourceTile): AsyncGenerator<{ page: number; data: Uint8Array; key: string }> {
  const key = sourceKey(row);
  for (let page = 0; page < row.pages; page++) {
    const path = `source-page/${key}/${String(page).padStart(10, '0')}`, data = await db.get<Uint8Array>(path);
    if (!data) throw new Error(`Missing source archive ${path}.`);
    yield { page, data, key: path };
  }
  yield { page: -1, data: row.state, key: `source-state/${key}` };
}
