/** Little-endian records with strings, for the engine's row types (mirrors `rust/wasm/src/bytes.rs`): a string is a
 *  u32 byte length followed by its UTF-8 bytes, a blob a u32 byte length followed by its bytes, numbers are
 *  unpadded little-endian. */
import type { Core } from './core.ts';

const encoder = new TextEncoder(), decoder = new TextDecoder();

/** Builds one input record, then hands it to an export through core scratch memory. */
export class ByteWriter {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  /** Claims `n` bytes and returns where they start. It may replace `bytes`/`view`, so callers read those after. */
  private reserve(n: number): number {
    const at = this.length;
    if (at + n > this.bytes.length) {
      const grown = new Uint8Array(Math.max(at + n, this.bytes.length * 2));
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = at + n;
    return at;
  }
  u8(v: number): this {
    const at = this.reserve(1);
    this.view.setUint8(at, v);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u32(v: number): this {
    const at = this.reserve(4);
    this.view.setUint32(at, v, true);
    return this;
  }
  i32(v: number): this {
    const at = this.reserve(4);
    this.view.setInt32(at, v, true);
    return this;
  }
  /** A u32 byte length followed by the bytes. */
  blob(v: ArrayBufferView): this {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    this.u32(bytes.length);
    const at = this.reserve(bytes.length);
    this.bytes.set(bytes, at);
    return this;
  }
  f64(v: number): this {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
    return this;
  }
  /** Raw bytes, no length prefix. */
  raw(v: Uint8Array): this {
    const at = this.reserve(v.length);
    this.bytes.set(v, at);
    return this;
  }
  str(v: string): this {
    const utf8 = encoder.encode(v);
    this.u32(utf8.length);
    const at = this.reserve(utf8.length);
    this.bytes.set(utf8, at);
    return this;
  }
  /** Copies the record into core scratch memory, planned together with `extra` output buffers (scratch plans
   *  share one arena, so everything one call uses is planned at once): `[ptr, length, ...extra pointers]`. */
  place(core: Core, extra: number[] = []): number[] {
    const [ptr, ...outputs] = core.scratch([this.length, ...extra]);
    core.writeBytes(ptr, this.bytes.subarray(0, this.length));
    return [ptr, this.length, ...outputs];
  }
}

/** Reads one result record copied out of core memory. */
export class ByteReader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get done(): boolean {
    return this.at >= this.bytes.length;
  }
  u8(): number {
    return this.view.getUint8(this.at++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }
  /** A copy of a u32-length-prefixed byte run. */
  blob(): Uint8Array<ArrayBuffer> {
    const n = this.u32(), v = this.bytes.slice(this.at, this.at + n) as Uint8Array<ArrayBuffer>;
    this.at += n;
    return v;
  }
  str(): string {
    const n = this.u32(), v = decoder.decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return v;
  }
  /** A copy of the next `n` bytes, in a buffer of its own (so typed-array views over it are aligned). */
  take(n: number): Uint8Array<ArrayBuffer> {
    const v = this.bytes.slice(this.at, this.at + n) as Uint8Array<ArrayBuffer>;
    this.at += n;
    return v;
  }
}

/** Fetches the result a handle holds after an export returned its `length` (error convention 6): plans `length`
 *  bytes of scratch, calls the domain's `_take` export into it, and reads it. */
export function takeResult(core: Core, length: number, take: (out: number, length: number) => number, what: string): ByteReader {
  const [out] = core.scratch([length]);
  core.check(take(out, length), what);
  return new ByteReader(core.readBytes(out, length));
}
