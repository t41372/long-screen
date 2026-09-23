/** FROZEN TypeScript LayerLearner accumulation (`add`/`addNative`), lifted verbatim as the parity oracle for
 *  rust/core/src/layers.rs (tests/unit/core-parity.test.ts). `finish()` is not part of this oracle: production
 *  still runs it in TS over accumulators the core produces. Not used by production code. Do not "fix" this. */
import type { Gray, MotionField, RGBA } from '../../../src/types.ts';
import { norm } from '../../../src/core/math.ts';
export function informativeField(field: MotionField): boolean {
  return !field.unknown && field.difference >= .2 && field.motions.some((m) => norm(m) > 1 && m.confidence > .3);
}
/** Learns screen-space motion discontinuities across the WHOLE recording. */
export class ReferenceLayerLearner {
  readonly cols: number;
  readonly rows: number;
  readonly cell = 24;
  split: Float64Array;
  evidence: Float64Array;
  activity: Float64Array;
  observations: Float64Array;
  rowFixed: Float64Array;
  rowMoving: Float64Array;
  informativeFrames = 0;
  rowChange: Float64Array;
  colChange: Float64Array;
  colMean: Float64Array;
  colGain: Float64Array;
  horizontalGain: Float64Array;
  /** Native-resolution row/column change statistics: band edges are located to the pixel, not to the analysis factor. */
  nativeRowChange?: Float64Array;
  nativeColChange?: Float64Array;
  nativeColMean?: Float64Array;
  nativeFrames = 0;
  reference?: RGBA;
  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    const n = this.cols * this.rows;
    this.split = new Float64Array(n * 2);
    this.evidence = new Float64Array(n * 2);
    this.activity = new Float64Array(n);
    this.observations = new Float64Array(n);
    this.colChange = new Float64Array(width);
    this.colMean = new Float64Array(width);
    this.colGain = new Float64Array(this.cols);
    this.horizontalGain = new Float64Array(this.rows);
    this.rowChange = new Float64Array(height);
    this.rowFixed = new Float64Array(height);
    this.rowMoving = new Float64Array(height);
  }
  add(field: MotionField, prev: Gray, current: Gray, prevNative?: RGBA, currentNative?: RGBA): void {
    const { cols, rows } = this;
    if (!informativeField(field)) {
      return;
    }
    this.informativeFrames++;
    if (prevNative && currentNative && prevNative.width === currentNative.width && prevNative.height === currentNative.height) {
      this.addNative(prevNative, currentNative);
    }
    for (let y = 0; y < this.height; y++) {
      let sum = 0, n = 0;
      for (let x = 0; x < this.width; x += 3) {
        sum += Math.abs(prev.data[y * this.width + x] - current.data[y * this.width + x]);
        n++;
      }
      this.rowChange[y] += sum / Math.max(1, n);
    }
    for (let x = 0; x < this.width; x++) {
      let change = 0, mean = 0, n = 0;
      for (let y = 0; y < this.height; y += 3) {
        const i = y * this.width + x;
        change += Math.abs(prev.data[i] - current.data[i]);
        mean += current.data[i];
        n++;
      }
      this.colChange[x] += change / n;
      this.colMean[x] += mean / n;
    }
    const models = field.motions.length,
      columns = Array.from({ length: cols }, () => new Float64Array(models)),
      lines = Array.from({ length: rows }, () => new Float64Array(models));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x, py = Math.min(this.height - 1, Math.floor((y + .5) * this.cell));
        // A blank gutter assigned to the zero-motion model is not a second pane. Global cuts require
        // disagreement between independently MOVING populations; fixed chrome is learned separately.
        if (
          field.confidence[i] <= 110 || field.dynamic[i] || norm(field.motions[field.labels[i]]) <= 1 ||
          this.rowChange[py] / this.informativeFrames < .9
        ) {
          continue;
        }
        const w = field.confidence[i] / 255;
        columns[x][field.labels[i]] += w;
        lines[y][field.labels[i]] += w;
      }
    }
    const gain = (bins: Float64Array[], output: Float64Array) => {
      const total = new Float64Array(models), left = new Float64Array(models);
      let weight = 0;
      for (const bin of bins) {
        for (let m = 0; m < models; m++) {
          total[m] += bin[m];
          weight += bin[m];
        }
      }
      if (weight < 10) {
        return;
      }
      const all = Math.max(...total);
      for (let k = 1; k < bins.length; k++) {
        let a = 0, b = 0;
        for (let m = 0; m < models; m++) {
          left[m] += bins[k - 1][m];
          a = Math.max(a, left[m]);
          b = Math.max(b, total[m] - left[m]);
        }
        output[k] += (a + b - all) / weight;
      }
    };
    gain(columns, this.colGain);
    gain(lines, this.horizontalGain);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x, m = field.motions[field.labels[i]], c = field.confidence[i] / 255;
        if (c > .25 && !field.dynamic[i]) {
          this.activity[i] += norm(m) * c;
          this.observations[i] += c;
        }
        const neighbours = [x + 1 < cols ? i + 1 : -1, y + 1 < rows ? i + cols : -1];
        neighbours.forEach((j, k) => {
          if (j < 0 || field.dynamic[i] || field.dynamic[j]) {
            return;
          }
          const weight = Math.min(c, field.confidence[j] / 255);
          if (weight < .25) {
            return;
          }
          const other = field.motions[field.labels[j]], disagreement = Math.hypot(m.x - other.x, m.y - other.y);
          this.evidence[i * 2 + k] += weight;
          if (disagreement > 1.8) {
            this.split[i * 2 + k] += weight;
          }
        });
      }
    }
    // Sub-cell horizontal chrome boundaries: accumulate pixel evidence rather than cropping whole blocks.
    const moving = field.motions.filter((m) => norm(m) > 1 && m.support >= 4).sort((a, b) => b.support - a.support)[0];
    if (moving) {
      const dx = Math.round(moving.x), dy = Math.round(moving.y), w = this.width, h = this.height;
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x += 4) {
          if (x + dx < 1 || x + dx >= w - 1 || y + dy < 1 || y + dy >= h - 1) {
            continue;
          }
          const i = y * w + x, stationary = Math.abs(prev.data[i] - current.data[i]);
          const motion = Math.abs(prev.data[(y + dy) * w + x + dx] - current.data[i]);
          if (stationary + 6 < motion) {
            this.rowFixed[y]++;
          }
          if (motion + 6 < stationary) {
            this.rowMoving[y]++;
          }
        }
      }
    }
  }
  addNative(prev: RGBA, current: RGBA): void {
    this.reference = current;
    const w = prev.width, h = prev.height, a = prev.data, b = current.data;
    this.nativeRowChange ??= new Float64Array(h);
    this.nativeColChange ??= new Float64Array(w);
    this.nativeColMean ??= new Float64Array(w);
    this.nativeFrames++;
    const step = Math.max(1, Math.floor(w / 480));
    for (let y = 0; y < h; y++) {
      let sum = 0, n = 0;
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        n++;
      }
      this.nativeRowChange[y] += sum / Math.max(1, n);
    }
    const vstep = Math.max(1, Math.floor(h / 300));
    for (let x = 0; x < w; x++) {
      let change = 0, mean = 0, n = 0;
      for (let y = 0; y < h; y += vstep) {
        const i = (y * w + x) * 4;
        change += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        mean += (b[i] + b[i + 1] + b[i + 2]) / 3;
        n++;
      }
      this.nativeColChange[x] += change / Math.max(1, n);
      this.nativeColMean[x] += mean / Math.max(1, n);
    }
  }
}
