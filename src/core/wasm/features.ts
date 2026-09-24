/** Feature extraction, matching, and visual-word hashing (mirrors `rust/core/src/abi/features.rs`). */
import type { Feature, Gray, Match, Rect } from '../../types.ts';
import type { Core } from './core.ts';

export function extractFeatures(core: Core, image: Gray, maxFeatures: number, roi?: Rect): Feature[] {
  const [input, rect, output] = core.scratch([image.data.byteLength, 32, maxFeatures * core.featureBytes]);
  core.writeBytes(input, image.data);
  if (roi) core.writeRect(rect, roi);
  const count = core.check(
    core.exports.ls_extract_features(input, image.width, image.height, maxFeatures, roi ? rect : 0, output),
    'extractFeatures',
  );
  return readFeatures(core, output, count);
}
export function readFeatures(core: Core, ptr: number, count: number): Feature[] {
  const bytes = core.readBytes(ptr, count * core.featureBytes), view = new DataView(bytes.buffer), out: Feature[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * core.featureBytes;
    out[i] = {
      x: view.getInt32(o, true),
      y: view.getInt32(o + 4, true),
      score: view.getFloat32(o + 8, true),
      descriptor: new Uint32Array(bytes.buffer.slice(o + 12, o + 44)),
    };
  }
  return out;
}
export function writeFeatures(core: Core, ptr: number, features: Feature[]): void {
  const view = new DataView(core.exports.memory.buffer, ptr, features.length * core.featureBytes);
  for (let i = 0; i < features.length; i++) {
    const f = features[i], o = i * core.featureBytes;
    view.setInt32(o, f.x, true);
    view.setInt32(o + 4, f.y, true);
    view.setFloat32(o + 8, f.score, true);
    for (let k = 0; k < 8; k++) view.setUint32(o + 12 + k * 4, f.descriptor[k], true);
  }
}
export function matchFeatures(core: Core, a: Feature[], b: Feature[], includeAmbiguous: boolean): Match[] {
  if (!a.length || !b.length) return [];
  const [pa, pb, output] = core.scratch([a.length * core.featureBytes, b.length * core.featureBytes, a.length * 2 * core.matchBytes]);
  writeFeatures(core, pa, a);
  writeFeatures(core, pb, b);
  const count = core.check(core.exports.ls_match_features(pa, a.length, pb, b.length, includeAmbiguous ? 1 : 0, output), 'matchFeatures');
  const bytes = core.readBytes(output, count * core.matchBytes), view = new DataView(bytes.buffer), out: Match[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * core.matchBytes;
    out[i] = {
      a: a[view.getUint32(o, true)],
      b: b[view.getUint32(o + 4, true)],
      distance: view.getUint16(o + 8, true),
      unique: bytes[o + 10] === 1,
    };
  }
  return out;
}
export function featureWords(core: Core, features: Feature[]): number[] {
  if (!features.length) return [];
  const [input, output] = core.scratch([features.length * core.featureBytes, features.length * 16]);
  writeFeatures(core, input, features);
  const count = core.check(core.exports.ls_feature_words(input, features.length, output), 'featureWords');
  return [...new Uint32Array(core.readBytes(output, count * 4).buffer)];
}
