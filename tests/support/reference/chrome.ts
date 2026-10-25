/** FROZEN TypeScript chrome evidence (`stationaryBoundary`, `stickyOcclusions`), lifted verbatim as the parity
 *  oracle for rust/long-screen/src/kernels/chrome.rs (tests/unit/parity/). Not used by production code. Do not "fix".
 *  Two deliberate changes since the freeze, each made in Rust first and mirrored here: a sticky band may also agree with
 *  the previous frame at a small vertical shift of its own (a header collapsing at its own speed, new_ip_8); and a row
 *  the page's motion explains while standing still does not, above rows that stand still, leaves the frame without a
 *  band, since a band runs down from the region's top (a pointer resting in a blank gap under scrolling text was a
 *  band, new_mac_4). A third, the same way: a region's candidate sticky blocks (Region.sticky) are excluded in the
 *  observations whose page motion does not explain them (new_mac_3's table of contents). */
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
  blockMotion: { x: number; y: number } | null = motion,
): Rect[] {
  if (previous.width !== current.width || previous.height !== current.height) return [];
  // With a step to weigh them by, blocks are decided below, not carried for their pixels.
  const same = (p: Rect, q: Rect) => p.x === q.x && p.y === q.y && p.width === q.width && p.height === q.height;
  const blocks = region.sticky ?? [];
  const bandCarry = blockMotion ? previousOcclusions.filter((o) => !blocks.some((b) => same(b, o))) : previousOcclusions;
  const out = stickyBands(previous, current, region, motion, bandCarry);
  // The blocks are weighed with the pose's own step (blockMotion); without one they keep only the carry.
  if (!blockMotion) return out;
  for (const block of blocks) {
    const before = previousOcclusions.some((o) => same(o, block));
    if (!out.some((o) => same(o, block)) && blockUnexplained(previous, current, region.crop || region.rect, block, blockMotion, before)) {
      out.push(block);
    }
  }
  return out;
}
/** A candidate sticky block (Region.sticky) is excluded when the page's step leaves its textured samples more than 18
 *  apart on average, or 2 % of all its pixels more than 12 apart; while the page stands still, when the previous
 *  observation excluded it or a tenth of its textured samples changed by more than 12. */
function blockUnexplained(
  previous: RGBA,
  current: RGBA,
  r: Rect,
  block: Rect,
  motion: { x: number; y: number },
  excludedBefore: boolean,
): boolean {
  const w = current.width, h = current.height, a = previous.data, b = current.data;
  const moving = Math.hypot(motion.x, motion.y) >= 2, dx = Math.round(motion.x), dy = Math.round(motion.y);
  const step = Math.max(1, Math.floor(block.width / 350));
  const x0 = Math.max(2, Math.ceil(block.x)), x1 = Math.min(w - 2, Math.floor(block.x + block.width));
  const y0 = Math.max(2, Math.ceil(block.y)), y1 = Math.min(h - 2, Math.floor(block.y + block.height));
  if (!moving && excludedBefore) return true;
  let changed = 0, n = 0, shifted = 0, ns = 0, off = 0, total = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4, px = x + dx, py = y + dy;
      const partner = moving && px >= 2 && px < w - 2 && py >= 2 && py < h - 2 && px >= r.x && px < r.x + r.width && py >= r.y &&
        py < r.y + r.height;
      // Every pixel the page's step brings a partner for, textured or not: a panel too faint for textured samples.
      if (partner) {
        const j = (py * w + px) * 4;
        // Only where the page brings a flat partner (a blank margin); page edges a pixel off are no faint panel.
        if (Math.abs(a[j - 4] - a[j + 4]) < 12) {
          total++;
          if (Math.abs(a[j] - b[i]) > 12) off++;
        }
      }
      if (Math.abs(b[i - 4] - b[i + 4]) < 24) continue;
      if (Math.abs(a[i] - b[i]) > 12) changed++;
      n++;
      if (partner) {
        shifted += Math.abs(a[(py * w + px) * 4] - b[i]);
        ns++;
      }
    }
  }
  if (!moving) return n >= 64 && changed >= .1 * n;
  return (ns >= 64 && shifted / ns > 18) || (total >= 64 && off >= .02 * total);
}
function stickyBands(
  previous: RGBA,
  current: RGBA,
  region: Region,
  motion: { x: number; y: number },
  previousOcclusions: Rect[],
): Rect[] {
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
  let lastFixed = -1, strongRows = 0, matched = 0, belowPage = false;
  for (let y = start; y < end; y++) {
    if (y + dy < 2 || y + dy >= h - 2) continue;
    let zero = 0, shifted = 0;
    const samples: number[] = [];
    for (let x = Math.max(2, Math.ceil(r.x)); x < Math.min(w - 2, r.x + r.width); x += step) {
      if (x + dx < 2 || x + dx >= w - 2) continue;
      const i = (y * w + x) * 4;
      if (Math.abs(b[i - 4] - b[i + 4]) < 24) continue;
      const j = ((y + dy) * w + x + dx) * 4;
      zero += Math.abs(a[i - 4] - b[i - 4]) + Math.abs(a[i] - b[i]) + Math.abs(a[i + 4] - b[i + 4]);
      shifted += Math.abs(a[j] - b[i]);
      samples.push(i);
    }
    const n = samples.length;
    if (n < 8) continue;
    const page = shifted / n <= 18;
    // Standing still is judged on the sample and the two neighbours whose difference made it one (Rust
    // `texture_difference`): the sample alone is often the white beside a glyph edge.
    let still = zero / (3 * n) < 6;
    const pageInside = y + dy >= r.y && y + dy < r.y + r.height;
    for (let k = pageInside ? -window : window + 1; !still && k <= window; k++) {
      if (k === 0 || Math.abs(dy - k) < 8 || y + k < 2 || y + k >= h - 2) continue;
      let sum = 0;
      for (const i of samples) {
        for (const p of [i - 4, i, i + 4]) sum += Math.abs(a[p + k * w * 4] - b[p]);
      }
      still = sum / (3 * n) < 6;
    }
    // A row the page explains and no standing still does is page content; a band runs down from the region's top, so
    // a frame with rows standing still below page content has no band of its own.
    if (page) {
      if (!still && pageInside) belowPage = true;
      continue;
    }
    if (still) {
      if (belowPage) return carry;
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
