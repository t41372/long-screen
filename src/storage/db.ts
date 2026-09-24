export interface Row<T = unknown> {
  key: string;
  value: T;
}
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  putMany(rows: Row[]): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  scan<T>(prefix: string, options?: {
    after?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Row<T>[]>;
}
/** How a Blob is kept where IndexedDB will not store Blobs (see `Database.storesBlobs`). */
interface StoredBlob {
  __longScreenBlob: true;
  type: string;
  bytes: ArrayBuffer;
}
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const isStoredBlob = (value: unknown): value is StoredBlob => isPlainObject(value) && value.__longScreenBlob === true;
/** Depth-first search for a typed array/`ArrayBuffer`/`DataView` backed by a `SharedArrayBuffer` (the threads
 *  build's `core.exports.memory.buffer`) anywhere inside `value`. `structuredClone` — what `MemoryKV.put` uses —
 *  happily "clones" one of these by handing back a second view of the SAME `SharedArrayBuffer`, not a copy, so
 *  it cannot catch a caller that persisted a live core view by mistake; real IndexedDB rejects a `put()` whose
 *  value contains a `SharedArrayBuffer` with a `DataCloneError`. `MemoryKV.put` (Deno's IndexedDB stand-in for
 *  tests) checks this explicitly so that bug class — e.g. `wasm/regions.ts`'s `exports.memory.buffer.slice()`,
 *  which on shared memory returns another `SharedArrayBuffer` instead of a copy (final-review item 6) — fails a
 *  `deno task test` run under `LONGSCREEN_CORE=threads` instead of only a real browser. Every value this store
 *  actually holds (tiles, temporal rows, diagnostics, features…) is a plain object/array tree of primitives,
 *  typed arrays and `Blob`s (`toStorable`'s doc comment above), so this only needs to walk those shapes — not
 *  every possible JS value. */
function containsSharedArrayBuffer(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => containsSharedArrayBuffer(v, seen));
  if (value instanceof Blob) return false;
  if (isPlainObject(value)) return Object.values(value).some((v) => containsSharedArrayBuffer(v, seen));
  return false;
}
async function blobToStored(blob: Blob): Promise<StoredBlob> {
  return { __longScreenBlob: true, type: blob.type, bytes: await blob.arrayBuffer() };
}
/** Blobs are only ever the value itself or a top-level field of a plain-object value (tiles, frame references). */
async function toStorable(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return await blobToStored(value);
  if (!isPlainObject(value) || !Object.values(value).some((v) => v instanceof Blob)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = v instanceof Blob ? await blobToStored(v) : v;
  return out;
}
function fromStored(value: unknown): unknown {
  if (isStoredBlob(value)) return new Blob([value.bytes], { type: value.type });
  if (!isPlainObject(value) || !Object.values(value).some(isStoredBlob)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = isStoredBlob(v) ? new Blob([v.bytes], { type: v.type }) : v;
  return out;
}
/** WebKit's ephemeral sessions (Safari Private Browsing) reject every Blob with "Error preparing Blob/File data to be
 *  stored in object store" while accepting plain bytes. The probe's transaction never commits. */
function probeBlobStorage(db: IDBDatabase): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('records', 'readwrite');
      const request = tx.objectStore('records').put({ key: '\u0000blob-probe', value: new Blob([new Uint8Array(1)]) });
      request.onsuccess = () => {
        resolve(true);
        tx.abort();
      };
      request.onerror = (event) => {
        event.preventDefault();
        resolve(false);
        tx.abort();
      };
      tx.onerror = (event) => event.preventDefault();
    } catch {
      resolve(false);
    }
  });
}
/** The specific error of a failed transaction: a failing request's error reaches `tx.onerror` before `tx.error` is set. */
const transactionError = (event: Event, tx: IDBTransaction, fallback: string) =>
  (event.target as IDBRequest | IDBTransaction | null)?.error ?? tx.error ?? new Error(fallback);
/** Transactions are acknowledged on commit, not merely when individual requests succeed. */
export class Database implements KV {
  /** False in sessions whose IndexedDB cannot hold Blobs (Safari Private Browsing): Blob values are then kept as
   *  bytes plus MIME type and handed back as Blobs, so callers never see the difference. Such a session keeps
   *  IndexedDB in memory and discards it when the window closes. */
  private constructor(private db: IDBDatabase, readonly storesBlobs: boolean) {}
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
    return new Database(db, await probeBlobStorage(db));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').get(key);
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve((this.storesBlobs ? r.result?.value : fromStored(r.result?.value)) as T | undefined);
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
    // Converted before the transaction opens: awaiting inside it would let it auto-commit.
    if (!this.storesBlobs) rows = await Promise.all(rows.map(async (row) => ({ key: row.key, value: await toStorable(row.value) })));
    const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(transactionError(event, tx, 'Local storage transaction failed.'));
      tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
    });
    for (const row of rows) {
      store.put(row);
    }
    await done;
  }
  async delete(key: string): Promise<void> {
    await this.deleteMany([key]);
  }
  async deleteMany(keys: string[]): Promise<void> {
    if (!keys.length) {
      return;
    }
    const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted.'));
      tx.onerror = (event) => reject(transactionError(event, tx, 'Local storage transaction failed.'));
    });
    for (const key of keys) {
      store.delete(key);
    }
    await done;
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
        const row = cursor.value as Row<T>;
        rows.push(this.storesBlobs ? row : { key: row.key, value: fromStored(row.value) as T });
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
  deleteMany(keys: string[]): Promise<void> {
    return this.base.deleteMany(keys.map((k) => this.prefix + k));
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
  // Page through with scan() (256 at a time) and delete each page in one deleteMany, instead of one delete
  // transaction per row: a keyframe/word/scan-features cleanup over tens of thousands of rows is one transaction
  // per 256 rows rather than one per row.
  while (true) {
    const rows = await db.scan(prefix, { limit: 256 });
    if (!rows.length) {
      return;
    }
    await db.deleteMany(rows.map((r) => r.key));
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
    // See `containsSharedArrayBuffer`'s doc comment: `structuredClone` below would silently hand back a second
    // view of the same `SharedArrayBuffer` instead of failing the way real IndexedDB does.
    if (containsSharedArrayBuffer(value)) {
      throw new Error(
        `CORE_BAD_ARGUMENT: put(${JSON.stringify(key)}) value is backed by a SharedArrayBuffer (a live core view on ` +
          `the threads build?) — IndexedDB would reject this too; copy it first (e.g. core.readBytes()).`,
      );
    }
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
  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.delete(key);
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
