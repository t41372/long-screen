/** Storage failures in deferred processing retain the same public error classification as the
 * original passes. Native computation and decoding errors do not pass through this boundary. */
import type { KV, Row } from '../storage/db.ts';
import { StorageError } from './context.ts';
export class SourceStorage implements KV {
  constructor(private inner: KV) {}
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw error instanceof StorageError ? error : new StorageError(error);
    }
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.io(() => this.inner.get<T>(key));
  }
  put(key: string, value: unknown): Promise<void> {
    return this.io(() => this.inner.put(key, value));
  }
  putMany(rows: Row[]): Promise<void> {
    return this.io(() => this.inner.putMany(rows));
  }
  delete(key: string): Promise<void> {
    return this.io(() => this.inner.delete(key));
  }
  deleteMany(keys: string[]): Promise<void> {
    return this.io(() => this.inner.deleteMany(keys));
  }
  scan<T>(prefix: string, options?: Parameters<KV['scan']>[1]): Promise<Row<T>[]> {
    return this.io(() => this.inner.scan<T>(prefix, options));
  }
}

/** Bounded write batches for unmaterialized archives/options. Output tiles use their separate
 * atomic commit path; these rows only become inputs to the next phase after flush succeeds. */
export class SourceWrites {
  private rows: Row[] = [];
  private bytes = 0;
  constructor(private store: KV) {}
  async add(rows: Row[], bytes: number): Promise<void> {
    this.rows.push(...rows);
    this.bytes += bytes;
    if (this.rows.length >= 64 || this.bytes >= 2 * 1024 * 1024) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.rows.length) return;
    await this.store.putMany(this.rows);
    this.rows = [];
    this.bytes = 0;
  }
}
