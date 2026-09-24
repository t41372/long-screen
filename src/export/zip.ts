import { makeZip } from 'client-zip';
export interface ByteSink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
export async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) {
        break;
      }
      yield r.value;
    }
  } finally {
    reader.releaseLock();
  }
}
export async function* single(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}
// A fixed timestamp keeps two exports of identical content byte-identical (client-zip defaults an entry's
// `lastModified` to `new Date()`, which would otherwise make every archive's bytes non-reproducible run to run).
// Matches the previous hand-rolled writer, which always stamped MS-DOS date/time 0 (1980-01-01 00:00:00).
const FIXED_MTIME = new Date(1980, 0, 1);
interface Entry {
  name: string;
  input: AsyncIterable<Uint8Array>;
  lastModified: Date;
}
interface Pending {
  entry: Entry;
  /** Resolved once `client-zip` has pulled the *next* entry from `source()`, i.e. once this one has been fully
   *  produced into its output stream — the point past which `add()` is safe to call again with a new entry. */
  resolveConsumed: () => void;
}
/** Store-only ZIP, automatically ZIP64 when needed, streamed through `client-zip` (npm, MIT, 0 deps) straight into
 *  `sink`. `add()` hands one entry at a time to a single-slot mailbox that `client-zip`'s internal generator pulls
 *  from, so callers get the same one-entry-in-flight backpressure and memory profile as the old writer without this
 *  module buffering entries itself. */
export class ZipWriter {
  private pending: Pending | undefined;
  private wake: (() => void) | undefined;
  private finished = false;
  private aborted: unknown;
  private readonly pump: Promise<void>;
  constructor(private sink: ByteSink) {
    this.pump = this.run();
    // Attaches a handler immediately so a rejection here is never reported as unhandled; the same rejection still
    // reaches add()/finish() callers via the await/race below.
    this.pump.catch(() => {});
  }
  private async *source(): AsyncGenerator<Entry> {
    while (true) {
      if (this.pending) {
        const { entry, resolveConsumed } = this.pending;
        this.pending = undefined;
        yield entry;
        resolveConsumed();
        continue;
      }
      if (this.aborted !== undefined) {
        throw this.aborted;
      }
      if (this.finished) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
  private async run(): Promise<void> {
    // A plain reader loop, not `for await…of` — WebKit (Safari, at least through the version this project ships
    // against) has no `ReadableStream.prototype[Symbol.asyncIterator]`, so `for await` over `makeZip`'s stream
    // throws immediately there (`TypeError: … is not async iterable`), which silently failed every export in
    // Safari/WebKit private browsing: the export rejected before ever touching the sink, so no download fired and
    // the UI just hung. `getReader().read()` is the WHATWG-streams primitive under both forms and has no such gap.
    const reader = makeZip(this.source(), { buffersAreUTF8: true }).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.sink.write(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  async add(name: string, input: AsyncIterable<Uint8Array> | Blob | Uint8Array): Promise<void> {
    if (this.pending) {
      throw new Error('ZipWriter.add() called before the previous entry finished streaming.');
    }
    const stream = input instanceof Blob ? blobChunks(input) : input instanceof Uint8Array ? single(input) : input;
    await Promise.race([
      new Promise<void>((resolveConsumed) => {
        this.pending = { entry: { name, input: stream, lastModified: FIXED_MTIME }, resolveConsumed };
        this.wake?.();
        this.wake = undefined;
      }),
      // A failed sink (disk full, aborted export…) must not hang add() forever waiting for an entry that will
      // never be consumed.
      this.pump,
    ]);
  }
  async finish(): Promise<void> {
    this.finished = true;
    this.wake?.();
    this.wake = undefined;
    await this.pump;
    await this.sink.close();
  }
  /** No staged storage rows to clean up any more (client-zip's central directory is built in-stream, from tiny
   *  metadata, never disk-spooled) — this only stops a still-running pump so a failed export's sink is never
   *  written to after `sink.abort()` has already run. Safe to call more than once and safe to call when nothing
   *  was ever added. */
  async dispose(): Promise<void> {
    if (this.finished) return;
    this.aborted = new Error('ZipWriter disposed before finish().');
    this.finished = true;
    this.wake?.();
    this.wake = undefined;
    await this.pump.catch(() => {});
  }
}
