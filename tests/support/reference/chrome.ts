/** FROZEN TypeScript chrome evidence (`stationaryBoundary`, `stickyOcclusions`), lifted verbatim as the parity
 *  oracle for rust/core/src/chrome.rs (tests/unit/core-parity.test.ts). Not used by production code. Do not "fix". */
import type { Rect, Region, RGBA } from '../../../src/types.ts';
/** Strong persistent appearance boundary within a stationary run. Never infer a pane edge from its first glyph.
 * Returns the boundary coordinate in native pixels, or undefined if the image offers no boundary evidence. */
export function stationaryBoundary(
  image: RGBA,
  axis: 'x' | 'y',
  from: number,
  to: number,
  crossFrom: number,
  crossTo: number,
  choose: 'first' | 'last',
): number | undefined {
  const { width, height, data } = image, limit = axis === 'x' ? width : height;
  const crossLimit = axis === 'x' ? height : width;
  const step = Math.max(1, Math.floor((crossTo - crossFrom) / 160));
  let found: number | undefined;
  for (let v = Math.max(1, from); v < Math.min(limit, to + 1); v++) {
    let strong = 0, count = 0, sum = 0;
    for (let c = Math.max(0, crossFrom + 2); c < Math.min(crossLimit, crossTo - 2); c += step) {
      const i = (axis === 'x' ? c * width + v : v * width + c) * 4;
      const j = i - (axis === 'x' ? 4 : width * 4);
      const d = (Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2])) / 3;
      if (d > 3) strong++;
      sum += d;
      count++;
    }
    if (count && strong / count > .68 && sum / count > 3) {
      found = v;
      if (choose === 'first') break;
    }
  }
  return found;
}

/** A sticky navigation band can move initially and become screen-fixed later. Its geometry is per-observation,
 * not a second scroll world. Only exclude an edge band when native texture agrees with zero motion and clearly
 * disagrees with the accepted page translation; uniform gutters alone never provide this evidence. */
export function stickyOcclusions(
  previous: RGBA,
  current: RGBA,
  region: Region,
  motion: { x: number; y: number },
  previousOcclusions: Rect[] = [],
): Rect[] {
  if (previous.width !== current.width || previous.height !== current.height) return [];
  // A clock/cursor elsewhere may change a paused frame. Retain an already-proven sticky band only while
  // ALL its native RGBA pixels are unchanged; do not drop the mask just because the page stops scrolling.
  const carry = previousOcclusions.filter((o) => {
    if (o.x < 0 || o.y < 0 || o.x + o.width > current.width || o.y + o.height > current.height) return false;
    for (let y = Math.ceil(o.y); y < o.y + o.height; y++) {
      const end = (y * current.width + Math.ceil(o.x + o.width)) * 4;
      for (let i = (y * current.width + Math.ceil(o.x)) * 4; i < end; i++) if (previous.data[i] !== current.data[i]) return false;
    }
    return true;
  });
  if (Math.hypot(motion.x, motion.y) < 2) return carry;
  const r = region.crop || region.rect, w = current.width, h = current.height, a = previous.data, b = current.data;
  const dx = Math.round(motion.x), dy = Math.round(motion.y);
  const end = Math.min(h - 2, Math.floor(r.y + Math.min(288, r.height * .23))), start = Math.max(2, Math.floor(r.y));
  const step = Math.max(1, Math.floor(r.width / 700));
  let lastFixed = -1, strongRows = 0, matched = 0;
  for (let y = start; y < end; y++) {
    if (y + dy < 2 || y + dy >= h - 2) continue;
    let n = 0, zero = 0, shifted = 0;
    for (let x = Math.max(2, Math.ceil(r.x)); x < Math.min(w - 2, r.x + r.width); x += step) {
      if (x + dx < 2 || x + dx >= w - 2) continue;
      const i = (y * w + x) * 4;
      if (Math.abs(b[i - 4] - b[i + 4]) < 24) continue;
      const j = ((y + dy) * w + x + dx) * 4;
      zero += Math.abs(a[i] - b[i]);
      shifted += Math.abs(a[j] - b[i]);
      n++;
    }
    if (n >= 8 && zero / n < 6 && shifted / n > 18) {
      lastFixed = y;
      strongRows++;
      matched += n;
    }
  }
  if (strongRows < 4 || matched < 64 || lastFixed < 0) return carry;
  const edge = stationaryBoundary(current, 'y', lastFixed + 1, Math.min(end, lastFixed + 80), r.x, r.x + r.width, 'first');
  if (edge === undefined || edge - start > r.height * .23) return carry;
  return [{ x: r.x, y: r.y, width: r.width, height: edge - r.y + 1 }];
}
