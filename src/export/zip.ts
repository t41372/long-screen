import type { KV } from '../storage/db.ts';
import { deletePrefix, iterate } from '../storage/db.ts';
import { CRC32, utf8 } from './crc.ts';
import { pad } from '../core/math.ts';
import { createId } from '../core/id.ts';
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
function record(size: number): {
  data: Uint8Array;
  view: DataView;
} {
  const data = new Uint8Array(size);
  return { data, view: new DataView(data.buffer) };
}
/** Always-ZIP64, stored entries, data descriptors. Central-directory records are disk-spooled. */
export class ZipWriter {
  private offset = 0n;
  private count = 0;
  private prefix = `export-index/${createId()}/`;
  constructor(private sink: ByteSink, private db: KV) {}
  private async write(data: Uint8Array): Promise<void> {
    await this.sink.write(data);
    this.offset += BigInt(data.byteLength);
  }
  async add(name: string, input: AsyncIterable<Uint8Array> | Blob | Uint8Array): Promise<void> {
    const bytes = utf8(name), start = this.offset, { data, view } = record(30 + bytes.length + 20);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 45, true);
    view.setUint16(6, 0x808, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(18, 0xffffffff, true);
    view.setUint32(22, 0xffffffff, true);
    view.setUint16(26, bytes.length, true);
    view.setUint16(28, 20, true);
    data.set(bytes, 30);
    const extra = 30 + bytes.length;
    view.setUint16(extra, 1, true);
    view.setUint16(extra + 2, 16, true);
    await this.write(data);
    let size = 0n;
    const crc = new CRC32();
    const stream = input instanceof Blob ? blobChunks(input) : input instanceof Uint8Array ? single(input) : input;
    for await (const chunk of stream) {
      crc.update(chunk);
      size += BigInt(chunk.length);
      await this.write(chunk);
    }
    const desc = record(24);
    desc.view.setUint32(0, 0x08074b50, true);
    desc.view.setUint32(4, crc.digest(), true);
    desc.view.setBigUint64(8, size, true);
    desc.view.setBigUint64(16, size, true);
    await this.write(desc.data);
    const central = record(46 + bytes.length + 28), v = central.view;
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 45, true);
    v.setUint16(6, 45, true);
    v.setUint16(8, 0x808, true);
    v.setUint16(14, 0x21, true);
    v.setUint32(16, crc.digest(), true);
    v.setUint32(20, 0xffffffff, true);
    v.setUint32(24, 0xffffffff, true);
    v.setUint16(28, bytes.length, true);
    v.setUint16(30, 28, true);
    v.setUint32(42, 0xffffffff, true);
    central.data.set(bytes, 46);
    const e = 46 + bytes.length;
    v.setUint16(e, 1, true);
    v.setUint16(e + 2, 24, true);
    v.setBigUint64(e + 4, size, true);
    v.setBigUint64(e + 12, size, true);
    v.setBigUint64(e + 20, start, true);
    await this.db.put(`${this.prefix}${pad(this.count++)}`, central.data);
  }
  async finish(): Promise<void> {
    const start = this.offset;
    for await (const row of iterate<Uint8Array>(this.db, this.prefix)) {
      await this.write(row.value);
      await this.db.delete(row.key);
    }
    const size = this.offset - start, zip64Offset = this.offset, z = record(56);
    z.view.setUint32(0, 0x06064b50, true);
    z.view.setBigUint64(4, 44n, true);
    z.view.setUint16(12, 45, true);
    z.view.setUint16(14, 45, true);
    z.view.setBigUint64(24, BigInt(this.count), true);
    z.view.setBigUint64(32, BigInt(this.count), true);
    z.view.setBigUint64(40, size, true);
    z.view.setBigUint64(48, start, true);
    await this.write(z.data);
    const locator = record(20);
    locator.view.setUint32(0, 0x07064b50, true);
    locator.view.setBigUint64(8, zip64Offset, true);
    locator.view.setUint32(16, 1, true);
    await this.write(locator.data);
    const end = record(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, 0xffff, true);
    end.view.setUint16(10, 0xffff, true);
    end.view.setUint32(12, 0xffffffff, true);
    end.view.setUint32(16, 0xffffffff, true);
    await this.write(end.data);
    await this.sink.close();
  }
  /** Deletes any of this writer's own export-index/<uuid>/ central-directory rows left staged by a failed export;
   * finish() already drains them all on success, so this is only ever needed on the failure path. */
  async dispose(): Promise<void> {
    await deletePrefix(this.db, this.prefix);
  }
}
