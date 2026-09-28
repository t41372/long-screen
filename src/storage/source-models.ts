/** Bounded decoded model cache. A model is serialized only on eviction or the final flush, not once
 * per source page. Keeping model math native avoids changing the selected samples or colours. */
import type { KV } from './db.ts';
import { core } from '../core/wasm.ts';
import type { OpacityField, OpacityLearning } from '../core/wasm/sources-opacity.ts';
export interface StoredOpacityField {
  data: Uint8Array;
  validPixels: number;
  residentBytes?: number;
}
interface Entry {
  native: OpacityField;
  bytes: number;
  dirty: boolean;
}
export class SourceModels {
  private entries = new Map<string, Entry>();
  private resident = 0;
  peakBytes = 0;
  writes = 0;
  constructor(private db: KV, private prefix: string, private noise: number, private budget: number) {}
  private async save(key: string, entry: Entry): Promise<void> {
    if (!entry.dirty) return;
    await this.db.put(
      this.prefix + key,
      { data: entry.native.state(), validPixels: 0, residentBytes: entry.bytes } satisfies StoredOpacityField,
    );
    entry.dirty = false;
    this.writes++;
  }
  private async reserve(bytes: number, held?: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.resident + bytes <= this.budget) break;
      if (key === held) continue;
      await this.save(key, entry);
      entry.native.free();
      this.entries.delete(key);
      this.resident -= entry.bytes;
    }
  }
  async merge(learning: OpacityLearning, key: string): Promise<void> {
    let entry = this.entries.get(key);
    if (!entry) {
      const old = await this.db.get<StoredOpacityField>(this.prefix + key);
      await this.reserve(old?.residentBytes ?? 1024 * 1024);
      const native = core().sourceOpacityField(old?.data);
      entry = { native, bytes: native.bytes(), dirty: false };
      this.entries.set(key, entry);
      this.resident += entry.bytes;
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    await this.reserve(2 * 1024 * 1024, key);
    const changed = entry.native.merge(learning, key, this.noise);
    const bytes = entry.native.bytes();
    this.resident += bytes - entry.bytes;
    entry.bytes = bytes;
    entry.dirty ||= changed;
    this.peakBytes = Math.max(this.peakBytes, this.resident);
  }
  async flush(): Promise<void> {
    for (const [key, entry] of this.entries) await this.save(key, entry);
  }
  free(): void {
    for (const entry of this.entries.values()) entry.native.free();
    this.entries.clear();
    this.resident = 0;
  }
}

/** Read-only fit cache: application needs coefficients, not the much larger training sample arrays. */
export class SourceModelFits {
  private entries = new Map<string, import('../core/wasm/sources-opacity.ts').FittedOpacityField | undefined>();
  private resident = 0;
  peakBytes = 0;
  constructor(private db: KV, private prefix: string, private noise: number, private budget: number) {}
  async get(key: string): Promise<import('../core/wasm/sources-opacity.ts').FittedOpacityField | undefined> {
    if (this.entries.has(key)) {
      const hit = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const stored = await this.db.get<StoredOpacityField>(this.prefix + key);
    if (!stored?.validPixels) {
      this.entries.set(key, undefined);
      if (this.entries.size > 512) this.evict();
      return undefined;
    }
    // One 64px field has at most 4096 fits, including conservative B-tree accounting.
    while (this.entries.size && this.resident + 4096 * 64 > this.budget) this.evict();
    const field = core().sourceFittedOpacityField(stored.data, this.noise);
    this.entries.set(key, field);
    this.resident += field.bytes();
    this.peakBytes = Math.max(this.peakBytes, this.resident);
    return field;
  }
  private evict(): void {
    const key = this.entries.keys().next().value!;
    const field = this.entries.get(key);
    if (field) {
      this.resident -= field.bytes();
      field.free();
    }
    this.entries.delete(key);
  }
  free(): void {
    for (const field of this.entries.values()) field?.free();
    this.entries.clear();
    this.resident = 0;
  }
}
