/** CRC32 (`crc32fast`, hardware-accelerated where available) via the Rust core — replaces the hand-rolled JS
 *  CRC32 table this module used to carry. `CRC32` keeps its old incremental class shape (`update()` any number
 *  of times, `digest()` any number of times, no explicit dispose) so `src/export/zip.ts` needed no call-site
 *  changes; `crc32()` is the one-shot convenience form. */
import { core } from '../core/wasm.ts';
export class CRC32 {
  private readonly stream = core().crc32Stream();
  update(data: Uint8Array): void {
    this.stream.update(data);
  }
  digest(): number {
    return this.stream.digest();
  }
}
export function crc32(data: Uint8Array): number {
  return core().crc32(data);
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
