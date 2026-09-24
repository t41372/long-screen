/** CRC32 (`crc32fast`, hardware-accelerated where available) via the Rust core — replaces the hand-rolled JS
 *  CRC32 table this module used to carry. `src/codec/png.ts::chunk()` (its only production caller) always has
 *  its type+body contiguous in memory already, so one call here is enough — no incremental class is needed
 *  (there used to be one; final-review item 8 deleted it along with the incremental core-side handle it wrapped,
 *  since nothing needed the "see the data in bounded pieces" case it existed for). `src/export/zip.ts`'s ZIP
 *  writer does not use this module — it streams through `client-zip`, which computes its own CRC32 in JS. */
import { core } from '../core/wasm.ts';
export function crc32(data: Uint8Array): number {
  return core().crc32(data);
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
