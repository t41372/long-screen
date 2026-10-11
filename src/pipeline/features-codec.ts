// Shell: a storage decoding, not an algorithm. The scan session (rust/engine/src/scan.rs) writes these rows.
import type { CompactFeatures, Feature } from '../types.ts';
export type { CompactFeatures } from '../types.ts';
/** A scan-features/<frame> row back as the Feature[] solve() matches against. */
export function decodeFeatures(c: CompactFeatures): Feature[] {
  const n = c.score.length, out: Feature[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: c.xy[i * 2], y: c.xy[i * 2 + 1], score: c.score[i], descriptor: c.descriptors.subarray(i * 8, i * 8 + 8) as Uint32Array };
  }
  return out;
}
