/** One-shot CRC32 (`crc32fast`, hardware-accelerated where available) via the Rust core. `src/codec/png.ts::
 *  chunk()` (its only production caller) always has its type+body contiguous in memory already, so a single
 *  call here is enough — no incremental (see-the-data-in-bounded-pieces) form is needed. `src/export/zip.ts`'s
 *  ZIP writer does not use this module — it streams through `client-zip`, which computes its own CRC32 in JS. */
import { core } from '../core/wasm.ts';
export function crc32(data: Uint8Array): number {
  return core().crc32(data);
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
