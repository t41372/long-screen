import type { Gray, Motion, MotionField, Rect, Region, RGBA } from '../types.ts';
import { clamp, contains, DisjointSet, norm } from './math.ts';
import { core, type LearnerAccumulators, type LearnerHandle, ResidentFrame } from './wasm.ts';
/** A field carries real evidence only once some model moved more than analysis jitter and is reasonably well matched;
 * shared by per-frame and long-baseline (frame t−k vs t) evidence so both are held to the same bar. */
export function informativeField(field: MotionField): boolean {
  return !field.unknown && field.difference >= .2 && field.motions.some((m) => norm(m) > 1 && m.confidence > .3);
}
/** Learns screen-space motion discontinuities across the WHOLE recording. Per-frame accumulation runs in the
 *  Rust core (rust/core/src/layers.rs) through a `LearnerHandle`; `finish()` reads the accumulators back once and
 *  builds the regions here. The last native frame is kept for appearance checks in `finish()`. */
export class LayerLearner {
  readonly cols: number;
  readonly rows: number;
  readonly cell = 24;
  private handle?: LearnerHandle;
  private snapshot?: LearnerAccumulators;
  private reference?: RGBA;
  /** Core-resident copy of the latest reference frame when the scan pass keeps frames in the core. */
  private residentReference?: ResidentFrame;
  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    this.handle = core().learner(width, height);
  }
  /** Accumulators as of the last `add()`; reading them ends accumulation (the snapshot is cached). */
  private get acc(): LearnerAccumulators {
    if (!this.snapshot) {
      if (!this.handle) throw new Error('LayerLearner was disposed before finish().');
      this.snapshot = this.handle.read();
      this.handle.free();
      this.handle = undefined;
    }
    return this.snapshot;
  }
  private get informativeFrames(): number {
    return this.acc.informativeFrames;
  }
  private get nativeFrames(): number {
    return this.acc.nativeFrames;
  }
  private get rowChange(): Float64Array {
    return this.acc.rowChange;
  }
  private get colChange(): Float64Array {
    return this.acc.colChange;
  }
  private get colMean(): Float64Array {
    return this.acc.colMean;
  }
  private get colGain(): Float64Array {
    return this.acc.colGain;
  }
  private get horizontalGain(): Float64Array {
    return this.acc.horizontalGain;
  }
  private get split(): Float64Array {
    return this.acc.split;
  }
  private get evidence(): Float64Array {
    return this.acc.evidence;
  }
  private get activity(): Float64Array {
    return this.acc.activity;
  }
  private get observations(): Float64Array {
    return this.acc.observations;
  }
  private get nativeRowChange(): Float64Array | undefined {
    return this.acc.nativeRowChange;
  }
  private get nativeColChange(): Float64Array | undefined {
    return this.acc.nativeColChange;
  }
  /** `prevNative`/`currentNative` may be frames already resident in the core (the scan pass keeps a ring). */
  add(field: MotionField, prev: Gray, current: Gray, prevNative?: RGBA | ResidentFrame, currentNative?: RGBA | ResidentFrame): void {
    if (!this.handle) throw new Error('LayerLearner cannot accumulate after finish().');
    const informative = this.handle.add(field, prev, current, prevNative, currentNative);
    if (
      informative && prevNative && currentNative && prevNative.width === currentNative.width && prevNative.height === currentNative.height
    ) {
      // finish() samples the last informative native frame for appearance evidence. A resident frame is copied
      // inside core memory (its ring slot will be reused) and read out once, by finish().
      if (currentNative instanceof ResidentFrame) {
        if (
          this.residentReference &&
          (this.residentReference.width !== currentNative.width || this.residentReference.height !== currentNative.height)
        ) {
          this.residentReference.free();
          this.residentReference = undefined;
        }
        this.residentReference ??= core().frame(currentNative.width, currentNative.height);
        this.residentReference.copyFrom(currentNative);
        this.reference = undefined;
      } else {
        this.residentReference?.free();
        this.residentReference = undefined;
        this.reference = currentNative;
      }
    }
  }
  /** Releases the core-resident accumulators without finishing (a run that stops before regions are built). */
  dispose(): void {
    this.handle?.free();
    this.handle = undefined;
    this.residentReference?.free();
    this.residentReference = undefined;
  }
  /** Locates a stationary/moving edge on native rows near the analysis estimate; falls back to the scaled estimate. */
  private nativeEdge(
    stats: Float64Array | undefined,
    estimate: number,
    scale: number,
    direction: 1 | -1,
    limit: number,
    threshold = .9,
  ): number {
    const guess = Math.round(estimate * scale);
    if (!stats || !this.nativeFrames) {
      return guess;
    }
    const window = Math.ceil(2 * scale) + 1, lo = Math.max(0, guess - window), hi = Math.min(limit, guess + window);
    let edge = guess;
    if (direction === 1) {
      // First changing row/column at or after the window start.
      edge = lo;
      while (edge < hi && stats[edge] / this.nativeFrames < threshold) {
        edge++;
      }
    } else {
      edge = hi;
      while (edge > lo && stats[edge - 1] / this.nativeFrames < threshold) {
        edge--;
      }
    }
    return Math.abs(edge - guess) <= window ? edge : guess;
  }
  finish(nativeWidth: number, nativeHeight: number, manual: Region[] = [], factor = 1): Region[] {
    if (this.residentReference) {
      const frame = this.residentReference;
      this.reference = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.bytes().buffer) };
      frame.free();
      this.residentReference = undefined;
    }
    if (manual.length) {
      const regions = manual.map((r, i) => ({
        ...r,
        id: `layer-${i}`,
        manual: true,
        maskWidth: this.width,
        maskHeight: this.height,
        factor,
        exclusions: [...manual.slice(i + 1).map((v) => v.rect), ...manual.filter((v) => v.kind === 'ignore').map((v) => v.rect)],
      }));
      let uncovered = false;
      for (let y = 0; y < nativeHeight && !uncovered; y++) {
        for (let x = 0; x < nativeWidth; x++) {
          if (!manual.some((r) => contains(r.rect, x, y))) {
            uncovered = true;
            break;
          }
        }
      }
      if (uncovered) {
        regions.push(
          {
            id: `layer-${regions.length}`,
            name: '未指定区域 · 屏幕坐标观察',
            kind: 'fixed',
            rect: { x: 0, y: 0, width: nativeWidth, height: nativeHeight },
            manual: true,
            unassigned: true,
            maskWidth: this.width,
            maskHeight: this.height,
            factor,
            exclusions: manual.map((r) => r.rect),
          } as Region & {
            exclusions: Rect[];
            maskWidth: number;
            maskHeight: number;
            factor: number;
            manual: boolean;
          },
        );
      }
      return regions;
    }
    const n = this.cols * this.rows, ds = new DisjointSet(n);
    let top = 0, bottom = this.height;
    if (this.informativeFrames >= 2) {
      while (top < this.height * .45 && this.rowChange[top] / this.informativeFrames < .9) {
        top++;
      }
      while (bottom > this.height * .55 && this.rowChange[bottom - 1] / this.informativeFrames < .9) {
        bottom--;
      }
      if (top < 6 || top >= this.height * .45) {
        top = 0;
      }
      if (this.height - bottom < 6 || bottom <= this.height * .55) {
        bottom = this.height;
      }
    }
    // Stationary side columns can be a real side panel, or just the page's blank margin. Only a band that carries its own
    // visible structure is treated as separate UI; a uniform margin belongs to the page, so the export keeps it.
    // Chrome above/below a pane must not make a uniform page gutter look like a textured sidebar.
    const middleMean = new Float64Array(this.width);
    if (this.reference) {
      const img = this.reference, scaleX = factor, scaleY = factor;
      for (let x = 0; x < this.width; x++) {
        let sum = 0, count = 0;
        for (let y = top + 2; y < bottom - 2; y += 3) {
          const i = (Math.min(img.height - 1, Math.floor(y * scaleY)) * img.width + Math.min(img.width - 1, Math.floor(x * scaleX))) * 4;
          sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
          count++;
        }
        middleMean[x] = sum / Math.max(1, count);
      }
    }
    const textured = (from: number, to: number): boolean => {
      if (to - from < 6 || !this.informativeFrames) {
        return false;
      }
      let lo = Infinity, hi = -Infinity;
      for (let x = from; x < to; x++) {
        const mean = this.reference ? middleMean[x] : this.colMean[x] / this.informativeFrames;
        lo = Math.min(lo, mean);
        hi = Math.max(hi, mean);
      }
      if (!this.reference && hi - lo <= 6) return false;
      if (this.reference) {
        const img = this.reference, sx = factor, sy = factor;
        let structure = 0, samples = 0;
        for (let y = top + 3; y < bottom - 3; y += 2) {
          for (let x = from + 1; x < to - 1; x += 2) {
            const nx = Math.floor(x * sx), ny = Math.floor(y * sy), step = Math.max(1, Math.round(sy));
            const i = (ny * img.width + nx) * 4, a = i - step * img.width * 4, b = i + step * img.width * 4;
            if (a < 0 || b >= img.data.length) continue;
            if (Math.abs(img.data[a] - img.data[b]) > 12) structure++;
            samples++;
          }
        }
        // A different-coloured but otherwise empty margin is still page geometry, not a sidebar.
        return structure >= 8 && structure / Math.max(1, samples) > .003;
      }
      return true;
    };
    let left = 0, right = this.width;
    let exactLeft: number | undefined, exactRight: number | undefined;
    if (this.informativeFrames >= 2) {
      while (left < this.width * .45 && this.colChange[left] / this.informativeFrames < .7) {
        left++;
      }
      while (right > this.width * .55 && this.colChange[right - 1] / this.informativeFrames < .7) {
        right--;
      }
      // Refine appearance edges BEFORE testing texture, otherwise wide empty page gutters dilute the
      // sidebar's visible structure and cause asymmetrical left/right classifications.
      if (this.reference) {
        const scale = factor;
        exactLeft = left > 0 && left < this.width * .45
          ? stationaryBoundary(
            this.reference,
            'x',
            0,
            Math.ceil(left * scale),
            Math.min(nativeHeight, Math.ceil(top * factor)),
            Math.min(nativeHeight, Math.floor(bottom * factor)),
            'last',
          )
          : undefined;
        exactRight = right < this.width && right > this.width * .55
          ? stationaryBoundary(
            this.reference,
            'x',
            Math.floor(right * scale),
            nativeWidth,
            Math.min(nativeHeight, Math.ceil(top * factor)),
            Math.min(nativeHeight, Math.floor(bottom * factor)),
            'first',
          )
          : undefined;
        if (exactLeft !== undefined) left = Math.floor(exactLeft / scale);
        if (exactRight !== undefined) right = Math.ceil(exactRight / scale);
      }
      if (left < 6 || left >= this.width * .45 || !textured(0, left)) {
        left = 0;
        exactLeft = undefined;
      }
      if (this.width - right < 6 || right <= this.width * .55 || !textured(right, this.width)) {
        right = this.width;
        exactRight = undefined;
      }
    }
    const strongestCut = (g: Float64Array) => {
      let best = 0;
      for (let k = 2; k < g.length - 2; k++) {
        if (g[k] > g[best]) {
          best = k;
        }
      }
      return this.informativeFrames >= 4 && g[best] / this.informativeFrames > .12 ? best : 0;
    };
    const verticalCut = strongestCut(this.colGain), horizontalCut = strongestCut(this.horizontalGain);
    const band = (i: number) => {
      const y = Math.min(this.height - 1, (Math.floor(i / this.cols) + .5) * this.cell),
        x = Math.min(this.width - 1, ((i % this.cols) + .5) * this.cell);
      return y < top ? 1 : y >= bottom ? 2 : x < left ? 3 : x >= right ? 4 : 0;
    };
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        for (const [j, k] of [[x + 1 < this.cols ? i + 1 : -1, 0], [y + 1 < this.rows ? i + this.cols : -1, 1]]) {
          if (j < 0) {
            continue;
          }
          const bi = band(i), bj = band(j);
          if (bi !== bj) {
            continue;
          }
          if (
            !bi &&
            ((verticalCut && ((i % this.cols < verticalCut) !== (j % this.cols < verticalCut))) ||
              (horizontalCut && ((Math.floor(i / this.cols) < horizontalCut) !== (Math.floor(j / this.cols) < horizontalCut))))
          ) {
            continue;
          }
          const e = this.evidence[i * 2 + k], s = this.split[i * 2 + k];
          if (bi > 0 || e < Math.max(2, this.informativeFrames * .04) || s / e < .32) {
            ds.join(i, j);
          }
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = ds.find(i);
      let group = groups.get(root);
      if (!group) {
        groups.set(root, group = []);
      }
      group.push(i);
    }
    // Tiny isolated cells are dynamic/ambiguous, not automatically independent scroll containers.
    const minimum = Math.max(3, Math.floor(n * .025));
    const large = [...groups.values()].filter((g) => g.length >= minimum).sort((a, b) => b.length - a.length);
    if (!large.length) {
      large.push(Array.from({ length: n }, (_, i) => i));
    }
    const labels = new Int32Array(n).fill(-1);
    large.forEach((g, k) => g.forEach((i) => labels[i] = k));
    for (let i = 0; i < n; i++) {
      if (labels[i] < 0) {
        const x = i % this.cols, y = Math.floor(i / this.cols);
        let best = Infinity, choice = 0;
        large.forEach((g, k) => {
          for (const j of g) {
            const d = Math.abs(x - j % this.cols) + Math.abs(y - Math.floor(j / this.cols));
            if (d < best) {
              best = d;
              choice = k;
            }
          }
        });
        labels[i] = choice;
        large[choice].push(i);
      }
    }
    const activity = large.map((g) =>
      g.reduce((s, i) => s + this.activity[i], 0) / Math.max(1, g.reduce((s, i) => s + this.observations[i], 0))
    );
    // The downscale grid is ceil(native/factor); the final analysis cell is a smaller partial box when needed.
    const maxActivity = Math.max(...activity, 1), sx = factor, sy = factor;
    const regions = large.map((cells, k): Region => {
      const xs = cells.map((i) => i % this.cols), ys = cells.map((i) => Math.floor(i / this.cols));
      const ax = Math.min(...xs) * this.cell,
        ay = Math.min(...ys) * this.cell,
        bx = Math.min(this.width, (Math.max(...xs) + 1) * this.cell),
        by = Math.min(this.height, (Math.max(...ys) + 1) * this.cell);
      const fixed = cells.some((i) => band(i) > 0) || this.informativeFrames >= 2 && activity[k] < maxActivity * .08 && large.length > 1;
      return {
        id: `layer-${k}`,
        name: fixed ? '固定界面' : `内容画布 ${k + 1}`,
        kind: fixed ? 'fixed' : 'moving',
        cells,
        rect: {
          x: Math.round(ax * sx),
          y: Math.round(ay * sy),
          width: Math.round(bx * sx) - Math.round(ax * sx),
          height: Math.round(by * sy) - Math.round(ay * sy),
        },
        mask: new Uint8Array(this.width * this.height),
        maskWidth: this.width,
        maskHeight: this.height,
        factor,
      };
    });
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        regions[labels[Math.floor(y / this.cell) * this.cols + Math.floor(x / this.cell)]].mask![y * this.width + x] = 1;
      }
    }
    // A persistent global cut closes weak, textureless bridges that would otherwise merge independent panes.
    let dividerStart = 0, dividerEnd = 0;
    if (verticalCut) {
      const coarse = verticalCut * this.cell;
      const run = lowChangeRun(this.colChange, this.informativeFrames, coarse, 48, this.width);
      const start = run ? run[0] : coarse, end = run ? run[1] : coarse;
      dividerStart = start;
      dividerEnd = end;
      let divider: Region | undefined;
      if (end > start) {
        divider = {
          id: `layer-${regions.length}`,
          name: '固定分隔界面',
          kind: 'fixed',
          rect: { x: 0, y: 0, width: 0, height: 0 },
          mask: new Uint8Array(this.width * this.height),
          maskWidth: this.width,
          maskHeight: this.height,
          factor,
        };
        regions.push(divider);
      }
      for (let y = top; y < bottom; y++) {
        const row = Math.min(this.rows - 1, Math.floor(y / this.cell)),
          left = regions[labels[row * this.cols + Math.max(0, verticalCut - 3)]],
          right = regions[labels[row * this.cols + Math.min(this.cols - 1, verticalCut + 2)]];
        if (left === right) {
          continue;
        }
        for (let x = Math.max(0, Math.min(start, coarse) - this.cell); x < Math.min(this.width, Math.max(end, coarse) + this.cell); x++) {
          const i = y * this.width + x;
          for (const r of regions) {
            r.mask![i] = 0;
          }
          (x < start ? left : x >= end ? right : divider || right).mask![i] = 1;
        }
      }
    }
    // Expand proven stationary edge bands through featureless pixels. A blank toolbar still belongs to the toolbar.
    const bandRect = (which: number): [number, number, number, number] =>
      which === 1
        ? [0, 0, this.width, top]
        : which === 2
        ? [0, bottom, this.width, this.height]
        : which === 3
        ? [0, top, left, bottom]
        : [right, top, this.width, bottom];
    for (const which of [1, 2, 3, 4]) {
      const [x0, y0, x1, y1] = bandRect(which);
      if (x1 <= x0 || y1 <= y0) {
        continue;
      }
      let fixed = regions.find((r) => r.kind === 'fixed' && r.cells?.some((i) => band(i) === which));
      if (!fixed) {
        fixed = {
          id: `layer-${regions.length}`,
          name: '固定界面',
          kind: 'fixed',
          rect: { x: 0, y: 0, width: nativeWidth, height: nativeHeight },
          mask: new Uint8Array(this.width * this.height),
          maskWidth: this.width,
          maskHeight: this.height,
          cells: [],
          factor,
        };
        regions.push(fixed);
      }
      (fixed as Region & { bandSide?: number }).bandSide = which;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * this.width + x;
          for (const r of regions) {
            r.mask![i] = 0;
          }
          fixed.mask![i] = 1;
        }
      }
    }
    // Cell granularity: rows/columns between a band edge and the next cell boundary belong to the content beside them, not to the band.
    const cellTop = Math.ceil(top / this.cell) * this.cell,
      cellBottom = Math.floor(bottom / this.cell) * this.cell,
      cellLeft = Math.ceil(left / this.cell) * this.cell,
      cellRight = Math.floor(right / this.cell) * this.cell;
    const copyRow = (from: number, to: number) => {
      if (from < 0 || from >= this.height || to === from) {
        return;
      }
      for (const r of regions) {
        r.mask!.copyWithin(to * this.width, from * this.width, (from + 1) * this.width);
      }
    };
    const copyColumn = (from: number, to: number) => {
      if (from < 0 || from >= this.width || to === from) {
        return;
      }
      for (const r of regions) {
        for (let y = top; y < bottom; y++) {
          r.mask![y * this.width + to] = r.mask![y * this.width + from];
        }
      }
    };
    if (top > 0) {
      for (let y = top; y < Math.min(cellTop, bottom); y++) {
        copyRow(Math.min(this.height - 1, cellTop), y);
      }
    }
    if (bottom < this.height) {
      for (let y = Math.max(cellBottom, top); y < bottom; y++) {
        copyRow(Math.max(0, cellBottom - 1), y);
      }
    }
    if (left > 0) {
      for (let x = left; x < Math.min(cellLeft, right); x++) {
        copyColumn(Math.min(this.width - 1, cellLeft), x);
      }
    }
    if (right < this.width) {
      for (let x = Math.max(cellRight, left); x < right; x++) {
        copyColumn(Math.max(0, cellRight - 1), x);
      }
    }
    // Native-precision band edges and pane divider; analysis masks only decide membership inside these crops.
    const nativeTop = top > 0 ? this.nativeEdge(this.nativeRowChange, top, sy, 1, nativeHeight) : 0;
    const nativeBottom = bottom < this.height ? this.nativeEdge(this.nativeRowChange, bottom, sy, -1, nativeHeight) : nativeHeight;
    const nativeLeft = exactLeft ?? (left > 0 ? this.nativeEdge(this.nativeColChange, left, sx, 1, nativeWidth, .7) : 0);
    const nativeRight = exactRight ??
      (right < this.width ? this.nativeEdge(this.nativeColChange, right, sx, -1, nativeWidth, .7) : nativeWidth);
    const content: Rect = {
      x: nativeLeft,
      y: nativeTop,
      width: Math.max(0, nativeRight - nativeLeft),
      height: Math.max(0, nativeBottom - nativeTop),
    };
    for (const r of regions) {
      const side = (r as Region & { bandSide?: number }).bandSide ??
        (r.cells?.length
          ? (r.cells.some((i) => band(i) === 1)
            ? 1
            : r.cells.some((i) => band(i) === 2)
            ? 2
            : r.cells.some((i) => band(i) === 3)
            ? 3
            : r.cells.some((i) => band(i) === 4)
            ? 4
            : 0)
          : 0);
      if (side === 1) {
        r.crop = { x: 0, y: 0, width: nativeWidth, height: nativeTop };
      } else if (side === 2) {
        r.crop = { x: 0, y: nativeBottom, width: nativeWidth, height: nativeHeight - nativeBottom };
      } else if (side === 3) {
        r.crop = { x: 0, y: nativeTop, width: nativeLeft, height: content.height };
      } else if (side === 4) {
        r.crop = { x: nativeRight, y: nativeTop, width: nativeWidth - nativeRight, height: content.height };
      } else {
        r.crop = content;
      }
      r.solid = side > 0;
    }
    if (verticalCut) {
      const coarse = verticalCut * this.cell;
      const leftRegions = regions.filter((r) => !r.solid && r.cells?.length && r.cells.every((i) => i % this.cols < verticalCut));
      const rightRegions = regions.filter((r) => !r.solid && r.cells?.length && r.cells.every((i) => i % this.cols >= verticalCut));
      const analysisStart = Math.min(dividerStart, coarse), analysisEnd = Math.max(dividerEnd, coarse);
      // The divider is the low-change column run nearest the analysis cut, measured on native columns when available.
      const nativeRun = this.nativeColChange && this.nativeFrames
        ? lowChangeRun(
          this.nativeColChange,
          this.nativeFrames,
          Math.round((analysisStart + analysisEnd) / 2 * sx),
          Math.ceil(48 * sx),
          nativeWidth,
        )
        : undefined;
      const nStart = nativeRun ? nativeRun[0] : Math.round(analysisStart * sx),
        nEnd = nativeRun ? nativeRun[1] : Math.round(analysisEnd * sx);
      for (const r of leftRegions) {
        r.crop = { x: content.x, y: nativeTop, width: Math.max(0, nStart - content.x), height: content.height };
      }
      for (const r of rightRegions) {
        r.crop = { x: nEnd, y: nativeTop, width: Math.max(0, content.x + content.width - nEnd), height: content.height };
      }
      const divider = regions.find((r) => r.name === '固定分隔界面');
      if (divider) {
        divider.crop = { x: nStart, y: nativeTop, width: Math.max(0, nEnd - nStart), height: content.height };
        divider.solid = nEnd > nStart;
      }
    }
    // Recompute bounding boxes after pixel-level refinements.
    for (const r of regions) {
      if (r.solid) {
        r.rect = { ...r.crop! };
        continue;
      }
      let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          if (r.mask![y * this.width + x]) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      // A mask bbox touching the last analysis row/column may stop short of the native edge because the final box
      // is partial. Extend the raw rect all the way to the native (or crop) edge there, so no native pixel goes unowned.
      const right = maxX === this.width - 1 ? nativeWidth : Math.round((maxX + 1) * sx),
        bottom = maxY === this.height - 1 ? nativeHeight : Math.round((maxY + 1) * sy);
      const raw = {
        x: Math.round(minX * sx),
        y: Math.round(minY * sy),
        width: right - Math.round(minX * sx),
        height: bottom - Math.round(minY * sy),
      };
      r.rect = maxX < 0 ? { x: 0, y: 0, width: 0, height: 0 } : r.crop ? clipRect(raw, r.crop) : raw;
    }
    // Partial motion cells along a chrome edge are not evidence for a 16px-tall independent pane, and neither is a
    // sliver beside a floating button: a genuine nested scroll container occupies a meaningful share of the frame.
    const valid = regions.filter((r) => r.rect.width > 0 && r.rect.height > 0);
    const largestMoving = Math.max(0, ...valid.filter((r) => r.kind === 'moving').map((r) => r.rect.width * r.rect.height));
    for (
      const small of valid.filter((r) =>
        r.kind === 'moving' && (r.rect.width < 30 * sx || r.rect.height < 30 * sy || r.rect.width * r.rect.height < largestMoving * .08)
      )
    ) {
      const other = valid.filter((r) =>
        r !== small && r.kind === 'moving' && r.rect.width * r.rect.height > small.rect.width * small.rect.height * 3
      ).sort((a, b) => {
        const distance = (r: Region) =>
          Math.max(0, Math.max(r.rect.x - small.rect.x - small.rect.width, small.rect.x - r.rect.x - r.rect.width)) +
          Math.max(0, Math.max(r.rect.y - small.rect.y - small.rect.height, small.rect.y - r.rect.y - r.rect.height));
        return distance(a) - distance(b);
      })[0];
      if (other) {
        for (let i = 0; i < small.mask!.length; i++) {
          if (small.mask![i]) {
            other.mask![i] = 1;
            small.mask![i] = 0;
          }
        }
        const x = Math.min(other.rect.x, small.rect.x), y = Math.min(other.rect.y, small.rect.y);
        other.rect = {
          x,
          y,
          width: Math.max(other.rect.x + other.rect.width, small.rect.x + small.rect.width) - x,
          height: Math.max(other.rect.y + other.rect.height, small.rect.y + small.rect.height) - y,
        };
        small.rect.width = 0;
      }
    }
    // An edge component whose cell bounding box substantially overlaps the main pane is not evidence for
    // another rectangular viewport. Sticky/collapsing headers commonly produce precisely this signature.
    const main = valid.filter((r) => r.kind === 'moving').sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
    if (main) {
      for (
        const edge of valid.filter((r) =>
          r !== main && r.kind === 'moving' && r.rect.width > content.width * .8 && r.rect.height < content.height * .3
        )
      ) {
        const overlap = clipRect(edge.rect, main.rect);
        if (
          (edge.rect.y <= content.y + sy || edge.rect.y + edge.rect.height >= content.y + content.height - sy) &&
          overlap.height >= this.cell * sy * .8 &&
          (!this.reference ||
            stationaryBoundary(
                this.reference,
                'y',
                overlap.y,
                overlap.y + overlap.height,
                content.x,
                content.x + content.width,
                'first',
              ) === undefined)
        ) {
          for (let i = 0; i < edge.mask!.length; i++) if (edge.mask![i]) main.mask![i] = 1;
          edge.rect.width = 0;
        }
      }
    }
    const result = valid.filter((r) => r.rect.width > 0);
    const moving = result.filter((r) => r.kind === 'moving');
    if (
      moving.length === 1 &&
      result.every((r) =>
        r === moving[0] || r.kind === 'fixed' && r.solid && clipRect(r.rect, content).width * clipRect(r.rect, content).height === 0
      )
    ) {
      // A blank gutter has no flow, but it still belongs to the pane. Cell masks identify motion evidence,
      // NOT the output geometry. Fill the entire proven rectangular pane, including its natural margins.
      moving[0].crop = content;
      moving[0].rect = { ...content };
      moving[0].solid = true;
    }
    return result;
  }
}
/** Nearest run of columns whose per-frame change stays below the stationary threshold; [start, end) or undefined.
 * Width is not limited: blank margins beside a divider never change either, and pixels that never change are stationary by observation. */
function lowChangeRun(stats: Float64Array, frames: number, centre: number, window: number, limit: number): [number, number] | undefined {
  let best: [number, number] | undefined, bestDistance = Infinity;
  for (let x = Math.max(1, centre - window); x < Math.min(limit - 1, centre + window); x++) {
    if (stats[x] / frames >= .7) {
      continue;
    }
    let a = x;
    while (a > 0 && stats[a - 1] / frames < .7) {
      a--;
    }
    while (x + 1 < limit && stats[x + 1] / frames < .7) {
      x++;
    }
    const b = x + 1, d = centre >= a && centre < b ? 0 : Math.min(Math.abs(a - centre), Math.abs(b - centre));
    if (d < bestDistance) {
      best = [a, b];
      bestDistance = d;
    }
  }
  return best;
}
function clipRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}
export function regionContains(region: Region, x: number, y: number, nativeWidth: number, nativeHeight: number): boolean {
  if (!contains(region.rect, x, y) || region.exclusions?.some((r) => contains(r, x, y))) {
    return false;
  }
  if (region.crop && !contains(region.crop, x, y)) {
    return false;
  }
  if (region.solid || !region.mask) {
    return true;
  }
  // The downscale truth is floor(x/factor), including the final partial cell; fall back to the ratio only for
  // regions built before `factor` was recorded (e.g. hand-built test masks).
  const xx = region.factor
    ? clamp(Math.floor(x / region.factor), 0, region.maskWidth! - 1)
    : clamp(Math.floor(x * region.maskWidth! / nativeWidth), 0, region.maskWidth! - 1);
  const yy = region.factor
    ? clamp(Math.floor(y / region.factor), 0, region.maskHeight! - 1)
    : clamp(Math.floor(y * region.maskHeight! / nativeHeight), 0, region.maskHeight! - 1);
  return !!region.mask[yy * region.maskWidth! + xx];
}
export function regionMotion(field: MotionField, region: Region, width: number, height: number): Motion {
  if (region.kind === 'fixed') {
    return { x: 0, y: 0, support: 100, unique: 100, confidence: 1, error: 0, ambiguous: false };
  }
  const votes = new Float64Array(field.motions.length);
  let total = 0;
  for (let y = 0; y < field.rows; y++) {
    for (let x = 0; x < field.cols; x++) {
      const px = Math.min(width - 1, (x + .5) * field.cell * width / (field.cols * field.cell)),
        py = Math.min(height - 1, (y + .5) * field.cell * height / (field.rows * field.cell));
      // Map by actual analysis dimensions when available, not by padded grid dimensions.
      const nx = region.maskWidth ? Math.min(width - 1, (x + .5) * field.cell * width / region.maskWidth) : px;
      const ny = region.maskHeight ? Math.min(height - 1, (y + .5) * field.cell * height / region.maskHeight) : py;
      if (!regionContains(region, nx, ny, width, height)) {
        continue;
      }
      const i = y * field.cols + x, w = field.confidence[i] / 255;
      votes[field.labels[i]] += w;
      total += w;
    }
  }
  let best = 0;
  for (let i = 1; i < votes.length; i++) {
    if (votes[i] > votes[best]) {
      best = i;
    }
  }
  const m = field.motions[best];
  return { ...m, confidence: field.difference < .12 ? .98 : m.confidence * clamp(votes[best] / Math.max(.01, total) * 1.3, .25, 1) };
}

/** Native-resolution pixel ownership computed once per run: compositing loops index a byte instead of calling regionContains per pixel. */
export class RegionAtlas {
  /** 0 = owned by no region; otherwise index + 1 into `regions`. The first region containing a pixel wins, matching regionContains semantics. */
  readonly labels: Uint8Array;
  /** Per-code pixel counts accumulated once during construction, so count() is O(1) instead of a full label scan. */
  private readonly counts: Uint32Array;
  constructor(readonly regions: Region[], readonly width: number, readonly height: number) {
    if (regions.length > 254) {
      throw new Error('Too many regions for the pixel atlas.');
    }
    this.labels = new Uint8Array(width * height);
    this.counts = new Uint32Array(regions.length + 1);
    regions.forEach((region, index) => {
      const code = index + 1,
        r = region.rect,
        x0 = Math.max(0, Math.floor(r.x)),
        y0 = Math.max(0, Math.floor(r.y)),
        x1 = Math.min(width, Math.ceil(r.x + r.width)),
        y1 = Math.min(height, Math.ceil(r.y + r.height));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          if (!this.labels[i] && regionContains(region, x, y, width, height)) {
            this.labels[i] = code;
            this.counts[code]++;
          }
        }
      }
    });
  }
  code(region: Region): number {
    const index = this.regions.indexOf(region);
    if (index < 0) {
      throw new Error(`Region ${region.id} is not part of this atlas.`);
    }
    return index + 1;
  }
  contains(code: number, x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.labels[y * this.width + x] === code;
  }
  /** Pixel count owned by a region (used for coverage accounting and tests). */
  count(code: number): number {
    return this.counts[code] || 0;
  }
}

/** Strong persistent appearance boundary within a stationary run (Rust core, rust/core/src/chrome.rs). Never infer a
 * pane edge from its first glyph. Returns the boundary coordinate in native pixels, or undefined if the image offers no
 * boundary evidence. */
export function stationaryBoundary(
  image: RGBA | ResidentFrame,
  axis: 'x' | 'y',
  from: number,
  to: number,
  crossFrom: number,
  crossTo: number,
  choose: 'first' | 'last',
): number | undefined {
  return core().stationaryBoundary(image, axis, from, to, crossFrom, crossTo, choose);
}

/** A sticky navigation band can move initially and become screen-fixed later. Its geometry is per-observation,
 * not a second scroll world. Only exclude an edge band when native texture agrees with zero motion and clearly
 * disagrees with the accepted page translation; uniform gutters alone never provide this evidence. (Rust core.) */
export function stickyOcclusions(
  previous: RGBA | ResidentFrame,
  current: RGBA | ResidentFrame,
  region: Region,
  motion: { x: number; y: number },
  previousOcclusions: Rect[] = [],
): Rect[] {
  if (previous.width !== current.width || previous.height !== current.height) return [];
  return core().stickyOcclusions(previous, current, region.crop || region.rect, motion, previousOcclusions);
}
