// Shell: a storage encoding, not an algorithm. Nothing here is awaiting a Rust port.
import type { Feature } from '../types.ts';
/** On-disk form of a frame's Feature[] under scan-features/<frame>: three flat typed arrays instead of n small
 * objects each carrying an 8-element descriptor as a JSON array of decimals. Analysis-resolution coordinates fit
 * an Int16Array; only solve() ever reads this, and it is deleted once solve() has consumed the whole run. */
export interface CompactFeatures {
  xy: Int16Array;
  score: Float32Array;
  descriptors: Uint32Array;
}
export function encodeFeatures(features: Feature[]): CompactFeatures {
  const n = features.length, xy = new Int16Array(n * 2), score = new Float32Array(n), descriptors = new Uint32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const f = features[i];
    xy[i * 2] = f.x;
    xy[i * 2 + 1] = f.y;
    score[i] = f.score;
    descriptors.set(f.descriptor, i * 8);
  }
  return { xy, score, descriptors };
}
export function decodeFeatures(c: CompactFeatures): Feature[] {
  const n = c.score.length, out: Feature[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: c.xy[i * 2], y: c.xy[i * 2 + 1], score: c.score[i], descriptor: c.descriptors.subarray(i * 8, i * 8 + 8) as Uint32Array };
  }
  return out;
}
