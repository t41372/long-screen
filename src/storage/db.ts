export interface Row<T = unknown> {
  key: string;
  value: T;
}
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  putMany(rows: Row[]): Promise<void>;
  delete(key: string): Promise<void>;
  scan<T>(prefix: string, options?: {
    after?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Row<T>[]>;
}
/** Transactions are acknowledged on commit, not merely when individual requests succeed. */
export class Database implements KV {
  private constructor(private db: IDBDatabase) {}
  static async open(): Promise<Database> {
    const request = indexedDB.open('long-screen-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('Local database upgrade is blocked by another Long Screen tab. Close that tab and retry.'));
    });
    db.onversionchange = () => db.close();
    return new Database(db);
  }
  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').get(key);
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result?.value as T | undefined);
      r.onerror = () => reject(r.error);
    });
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.putMany([{ key, value }]);
  }
  async putMany(rows: Row[]): Promise<void> {
    if (!rows.length) {
      return;
    }
    const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Local storage transaction failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
    });
    for (const row of rows) {
      store.put(row);
    }
    await done;
  }
  async delete(key: string): Promise<void> {
    const tx = this.db.transaction('records', 'readwrite');
    tx.objectStore('records').delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
  async scan<T>(prefix: string, options: {
    after?: string;
    limit?: number;
    reverse?: boolean;
  } = {}): Promise<Row<T>[]> {
    const { after, limit = 16, reverse = false } = options;
    const range = reverse
      ? IDBKeyRange.bound(prefix, after || prefix + '\uffff', false, !!after)
      : IDBKeyRange.bound(after || prefix, prefix + '\uffff', !!after, false);
    const tx = this.db.transaction('records', 'readonly'), request = tx.objectStore('records').openCursor(range, reverse ? 'prev' : 'next');
    return new Promise((resolve, reject) => {
      const rows: Row<T>[] = [];
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) {
          resolve(rows);
          return;
        }
        rows.push(cursor.value as Row<T>);
        if (rows.length >= limit) {
          resolve(rows);
        } else {
          cursor.continue();
        }
      };
    });
  }
  close(): void {
    this.db.close();
  }
}
export class Namespace implements KV {
  constructor(readonly base: KV, readonly prefix: string) {}
  get<T>(key: string): Promise<T | undefined> {
    return this.base.get<T>(this.prefix + key);
  }
  put(key: string, value: unknown): Promise<void> {
    return this.base.put(this.prefix + key, value);
  }
  putMany(rows: Row[]): Promise<void> {
    return this.base.putMany(rows.map((r) => ({ key: this.prefix + r.key, value: r.value })));
  }
  delete(key: string): Promise<void> {
    return this.base.delete(this.prefix + key);
  }
  async scan<T>(prefix: string, options: {
    after?: string;
    limit?: number;
    reverse?: boolean;
  } = {}): Promise<Row<T>[]> {
    const rows = await this.base.scan<T>(this.prefix + prefix, {
      ...options,
      after: options.after ? this.prefix + options.after : undefined,
    });
    return rows.map((r) => ({ key: r.key.slice(this.prefix.length), value: r.value }));
  }
}
export async function* iterate<T>(db: KV, prefix: string, reverse = false, pageSize = 16): AsyncGenerator<Row<T>> {
  let after: string | undefined;
  while (true) {
    const rows = await db.scan<T>(prefix, { after, limit: pageSize, reverse });
    if (!rows.length) {
      return;
    }
    for (const row of rows) {
      yield row;
    }
    after = rows[rows.length - 1].key;
  }
}
export async function deletePrefix(db: KV, prefix: string): Promise<void> {
  for await (const row of iterate(db, prefix)) {
    await db.delete(row.key);
  }
}
/** In-memory adapter (tests, Deno). Sorted keys with binary search so word-posting scans stay cheap. Production never keeps tiles in JS RAM. */
export class MemoryKV implements KV {
  data = new Map<string, unknown>();
  private keys: string[] = [];
  private lowerBound(key: string): number {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < key) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    if (!this.data.has(key)) {
      this.keys.splice(this.lowerBound(key), 0, key);
    }
    this.data.set(key, structuredClone(value));
  }
  async putMany(rows: Row[]): Promise<void> {
    for (const r of rows) {
      await this.put(r.key, r.value);
    }
  }
  async delete(key: string): Promise<void> {
    if (!this.data.delete(key)) {
      return;
    }
    const i = this.lowerBound(key);
    if (this.keys[i] === key) {
      this.keys.splice(i, 1);
    }
  }
  async scan<T>(prefix: string, options: { after?: string; limit?: number; reverse?: boolean } = {}): Promise<Row<T>[]> {
    const limit = options.limit || 16, out: Row<T>[] = [];
    if (options.reverse) {
      let i = (options.after ? this.lowerBound(options.after) : this.lowerBound(prefix + '\uffff')) - 1;
      for (; i >= 0 && out.length < limit; i--) {
        const key = this.keys[i];
        if (!key.startsWith(prefix)) {
          break;
        }
        out.push({ key, value: structuredClone(this.data.get(key)) as T });
      }
      return out;
    }
    let i = options.after ? this.lowerBound(options.after) : this.lowerBound(prefix);
    if (options.after && this.keys[i] === options.after) {
      i++;
    }
    for (; i < this.keys.length && out.length < limit; i++) {
      const key = this.keys[i];
      if (!key.startsWith(prefix)) {
        break;
      }
      out.push({ key, value: structuredClone(this.data.get(key)) as T });
    }
    return out;
  }
}
