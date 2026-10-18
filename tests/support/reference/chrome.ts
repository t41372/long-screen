/** FROZEN TypeScript chrome evidence (`stationaryBoundary`, `stickyOcclusions`), lifted verbatim as the parity
 *  oracle for rust/long-screen/src/kernels/chrome.rs (tests/unit/parity/). Not used by production code. Do not "fix".
 *  One deliberate change since the freeze, made in Rust first and mirrored here: a sticky band may also agree with the
 *  previous frame at a small vertical shift of its own (a header collapsing at its own speed, new_ip_8). */
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
 * not a second scroll world. Only exclude an edge band when native texture agrees with the previous frame at zero
 * shift, or at a small shift of its own (|k| <= min(16, |dy| / 4) and |dy - k| >= 8, only where the row's page partner
 * y + dy lies inside the region), and clearly disagrees with the accepted page translation; uniform gutters alone
 * never provide this evidence. */
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
  const window = Math.min(16, Math.floor(Math.abs(dy) / 4));
  let lastFixed = -1, strongRows = 0, matched = 0;
  for (let y = start; y < end; y++) {
    if (y + dy < 2 || y + dy >= h - 2) continue;
    let zero = 0, shifted = 0;
    const samples: number[] = [];
    for (let x = Math.max(2, Math.ceil(r.x)); x < Math.min(w - 2, r.x + r.width); x += step) {
      if (x + dx < 2 || x + dx >= w - 2) continue;
      const i = (y * w + x) * 4;
      if (Math.abs(b[i - 4] - b[i + 4]) < 24) continue;
      const j = ((y + dy) * w + x + dx) * 4;
      zero += Math.abs(a[i] - b[i]);
      shifted += Math.abs(a[j] - b[i]);
      samples.push(i);
    }
    const n = samples.length;
    if (n < 8 || shifted / n <= 18) continue;
    let still = zero / n < 6;
    const pageInside = y + dy >= r.y && y + dy < r.y + r.height;
    for (let k = pageInside ? -window : window + 1; !still && k <= window; k++) {
      if (k === 0 || Math.abs(dy - k) < 8 || y + k < 2 || y + k >= h - 2) continue;
      let sum = 0;
      for (const i of samples) sum += Math.abs(a[i + k * w * 4] - b[i]);
      still = sum / n < 6;
    }
    if (still) {
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
/** Visible structure of a masked area on a native frame (rust/long-screen/src/kernels/chrome.rs, visible_structure):
 *  edge points across rows and across columns, sampled every 2nd analysis row and column where the analysis pixels
 *  on both sides are in the mask, and the distinct sampled rows and columns they lie on. */
export function visibleStructure(
  image: RGBA,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  factor: number,
): { vertical: number; horizontal: number; rows: number; cols: number } {
  const { width: w, height: h, data } = image;
  const step = Math.max(1, Math.round(factor));
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < maskWidth && y < maskHeight && mask[y * maskWidth + x] !== 0;
  const red = (x: number, y: number) => data[(y * w + x) * 4];
  let vertical = 0, horizontal = 0, rows = 0;
  const cols = new Uint8Array(maskWidth);
  for (let y = 1; y < maskHeight - 1; y += 2) {
    const ny = Math.floor(y * factor);
    let rowHit = false;
    for (let x = 1; x < maskWidth - 1; x += 2) {
      if (!inside(x, y)) continue;
      const nx = Math.floor(x * factor);
      let hit = false;
      if (inside(x, y - 1) && inside(x, y + 1) && ny - step >= 0 && ny + step < h && nx < w) {
        if (Math.abs(red(nx, ny - step) - red(nx, ny + step)) > 12) {
          vertical++;
          hit = true;
        }
      }
      if (inside(x - 1, y) && inside(x + 1, y) && nx - step >= 0 && nx + step < w && ny < h) {
        if (Math.abs(red(nx - step, ny) - red(nx + step, ny)) > 12) {
          horizontal++;
          hit = true;
        }
      }
      if (hit) {
        rowHit = true;
        cols[x] = 1;
      }
    }
    if (rowHit) rows++;
  }
  return { vertical, horizontal, rows, cols: cols.reduce((n, c) => n + c, 0) };
}
