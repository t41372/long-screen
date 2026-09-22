/** FROZEN TypeScript displacement-spread consistency voting: the pre-migration `Engine.solve()` ring, lifted
 *  verbatim (box geometry, interior mask, partner selection, box gray, compare, finalize) as the parity oracle for
 *  rust/core/src/voting.rs (tests/unit/core-parity.test.ts). Not used by production code. Do not "fix" this. */
import type { Gray, Point, Region } from '../../../src/types.ts';
import { regionContains } from '../../../src/core/layers.ts';

export interface ConsistencyBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}
export interface ConsistencyLayer {
  canvasId: string;
  pose: Point;
  score: Int8Array;
  comparisons: Uint8Array;
  pairs: number;
  boxGray: Uint8Array;
}
export interface ConsistencyFrame {
  index: number;
  bytes: number;
  layers: Map<string, ConsistencyLayer>;
}
export type ConsistencyVote = ConsistencyBox & { bits: Uint8Array; clean: Uint8Array };
export type ConsistencyRecord = Record<string, ConsistencyVote>;
export interface FinalizedRecord {
  index: number;
  record: ConsistencyRecord | undefined;
  votedLayers: number;
  thinLayers: number;
}

export const CONSISTENCY_RING_BYTES = 24 * 1024 * 1024, CONSISTENCY_PARTNERS = 6, CONSISTENCY_VERDICT_MIN = 3;

export class ReferenceVotingRing {
  readonly tau: number;
  readonly radius: number;
  readonly box = new Map<string, ConsistencyBox>();
  readonly dmin = new Map<string, number>();
  readonly interior = new Map<string, Uint8Array>();
  private ring: ConsistencyFrame[] = [];
  private bytes = 0;
  private building = new Map<string, ConsistencyLayer>();
  constructor(
    readonly f: number,
    noise: number,
    private readonly nativeW: number,
    private readonly nativeH: number,
    readonly regions: Region[],
    private readonly budget = CONSISTENCY_RING_BYTES,
  ) {
    const CONSISTENCY_PHASE = 26;
    this.tau = Math.max(f === 1 ? 0 : CONSISTENCY_PHASE, Math.round(noise * 2.6));
    this.radius = f;
    for (const r of regions) {
      const rect = r.rect, x0 = Math.floor(rect.x / f) - 1, y0 = Math.floor(rect.y / f) - 1;
      this.box.set(r.id, { x0, y0, w: Math.ceil((rect.x + rect.width) / f) - x0 + 1, h: Math.ceil((rect.y + rect.height) / f) - y0 + 1 });
      this.dmin.set(r.id, Math.max(64, .25 * Math.min(rect.width, rect.height)));
    }
    for (const r of regions) {
      const box = this.box.get(r.id)!, mask = new Uint8Array(box.w * box.h);
      for (let ly = 0; ly < box.h; ly++) {
        for (let lx = 0; lx < box.w; lx++) {
          if (lx < this.radius || ly < this.radius || lx >= box.w - this.radius || ly >= box.h - this.radius) continue;
          let ok = true;
          for (let oy = -1; oy <= 1 && ok; oy++) {
            for (let ox = -1; ox <= 1 && ok; ox++) {
              ok = regionContains(r, (box.x0 + lx + ox) * f, (box.y0 + ly + oy) * f, nativeW, nativeH);
            }
          }
          mask[ly * box.w + lx] = ok ? 1 : 0;
        }
      }
      this.interior.set(r.id, mask);
    }
  }
  private partners(regionId: string, canvasId: string, pose: Point, dmin: number): { entry: ConsistencyFrame; layer: ConsistencyLayer }[] {
    const candidates: { entry: ConsistencyFrame; layer: ConsistencyLayer; d: number }[] = [];
    for (const entry of this.ring) {
      const layer = entry.layers.get(regionId);
      if (!layer || layer.canvasId !== canvasId) continue;
      const d = Math.hypot(pose.x - layer.pose.x, pose.y - layer.pose.y);
      if (d >= dmin) candidates.push({ entry, layer, d });
    }
    if (candidates.length <= CONSISTENCY_PARTNERS) return candidates;
    candidates.sort((a, b) => a.d - b.d);
    const n = candidates.length, seen = new Set<number>(), out: typeof candidates = [];
    const take = (c: typeof candidates[number] | undefined) => {
      if (c && !seen.has(c.entry.index)) {
        seen.add(c.entry.index);
        out.push(c);
      }
    };
    take(candidates[0]);
    take(candidates[1]);
    take(candidates[n - 1]);
    const bands = CONSISTENCY_PARTNERS - out.length, lo = 2, hi = n - 1;
    for (let band = 0; band < bands && hi > lo; band++) {
      const from = lo + Math.floor(band * (hi - lo) / bands), to = lo + Math.floor((band + 1) * (hi - lo) / bands);
      let best: typeof candidates[number] | undefined;
      for (let i = from; i < to; i++) {
        const c = candidates[i];
        if (seen.has(c.entry.index)) continue;
        if (!best || c.layer.pairs < best.layer.pairs || c.layer.pairs === best.layer.pairs && c.d > best.d) best = c;
      }
      take(best);
    }
    return out;
  }
  computeBoxGray(region: Region, box: ConsistencyBox, g: Gray): Uint8Array {
    const f = this.f, out = new Uint8Array(box.w * box.h);
    for (let ly = 0; ly < box.h; ly++) {
      const ay = box.y0 + ly;
      for (let lx = 0; lx < box.w; lx++) {
        const ax = box.x0 + lx;
        if (ax < 0 || ay < 0 || ax >= g.width || ay >= g.height) continue;
        const centre = g.data[ay * g.width + ax];
        if (f === 1) {
          out[ly * box.w + lx] = centre;
          continue;
        }
        let sum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ty = ay + oy;
          for (let ox = -1; ox <= 1; ox++) {
            const tx = ax + ox;
            sum +=
              tx < 0 || ty < 0 || tx >= g.width || ty >= g.height || !regionContains(region, tx * f, ty * f, this.nativeW, this.nativeH)
                ? centre
                : g.data[ty * g.width + tx];
          }
        }
        out[ly * box.w + lx] = Math.round(sum / 9);
      }
    }
    return out;
  }
  private compare(box: ConsistencyBox, interior: Uint8Array, layerT: ConsistencyLayer, layerS: ConsistencyLayer): void {
    const f = this.f, dx = (layerT.pose.x - layerS.pose.x) / f, dy = (layerT.pose.y - layerS.pose.y) / f;
    layerT.pairs++;
    layerS.pairs++;
    for (let ly = 0; ly < box.h; ly++) {
      for (let lx = 0; lx < box.w; lx++) {
        const i = ly * box.w + lx;
        if (!interior[i]) continue;
        const sx = Math.round(lx + dx), sy = Math.round(ly + dy), si = sy * box.w + sx;
        if (sx < 0 || sy < 0 || sx >= box.w || sy >= box.h || !interior[si]) continue;
        let best = 255;
        for (let oy = -this.radius; oy <= this.radius && best > this.tau; oy++) {
          const py = sy + oy;
          if (py < 0 || py >= box.h) continue;
          for (let ox = -this.radius; ox <= this.radius; ox++) {
            const px = sx + ox;
            if (px < 0 || px >= box.w) continue;
            const diff = Math.abs(layerT.boxGray[i] - layerS.boxGray[py * box.w + px]);
            if (diff < best) best = diff;
          }
        }
        const agree = best <= this.tau;
        layerT.comparisons[i] = Math.min(255, layerT.comparisons[i] + 1);
        layerT.score[i] = Math.max(-128, Math.min(127, layerT.score[i] + (agree ? 1 : -1)));
        layerS.comparisons[si] = Math.min(255, layerS.comparisons[si] + 1);
        layerS.score[si] = Math.max(-128, Math.min(127, layerS.score[si] + (agree ? 1 : -1)));
      }
    }
  }
  observe(region: Region, canvasId: string, pose: Point, g: Gray): void {
    const box = this.box.get(region.id)!, dmin = this.dmin.get(region.id)!;
    const layer: ConsistencyLayer = {
      canvasId,
      pose: { x: pose.x, y: pose.y },
      score: new Int8Array(box.w * box.h),
      comparisons: new Uint8Array(box.w * box.h),
      pairs: 0,
      boxGray: this.computeBoxGray(region, box, g),
    };
    for (const partner of this.partners(region.id, canvasId, pose, dmin)) {
      this.compare(box, this.interior.get(region.id)!, layer, partner.layer);
    }
    this.building.set(region.id, layer);
  }
  pushFrame(index: number): FinalizedRecord[] {
    const layers = this.building;
    this.building = new Map();
    if (!layers.size) return [];
    let bytes = 0;
    for (const layer of layers.values()) bytes += layer.boxGray.byteLength + layer.score.byteLength + layer.comparisons.byteLength;
    this.ring.push({ index, bytes, layers });
    this.bytes += bytes;
    const out: FinalizedRecord[] = [];
    while (this.bytes > this.budget && this.ring.length > 1) {
      const evicted = this.ring.shift()!;
      this.bytes -= evicted.bytes;
      out.push(this.finalize(evicted));
    }
    return out;
  }
  drain(): FinalizedRecord[] {
    return this.ring.splice(0).map((entry) => this.finalize(entry));
  }
  private finalize(entry: ConsistencyFrame): FinalizedRecord {
    const threshold = (comparisons: number): number => comparisons - 2 * Math.ceil(comparisons * .75);
    const record: ConsistencyRecord = {};
    let any = false, votedLayers = 0, thinLayers = 0;
    for (const [regionId, layer] of entry.layers) {
      const box = this.box.get(regionId)!;
      const bits = new Uint8Array(Math.ceil(box.w * box.h / 8)), clean = new Uint8Array(bits.length);
      let regionAny = false;
      votedLayers++;
      if (layer.pairs < CONSISTENCY_VERDICT_MIN) thinLayers++;
      for (let i = 0; i < layer.score.length; i++) {
        const comparisons = layer.comparisons[i];
        if (comparisons >= 2 && layer.score[i] <= threshold(comparisons)) {
          bits[i >> 3] |= 1 << (i & 7);
          regionAny = true;
        } else if (comparisons >= CONSISTENCY_VERDICT_MIN && layer.score[i] >= -threshold(comparisons)) {
          clean[i >> 3] |= 1 << (i & 7);
          regionAny = true;
        }
      }
      if (regionAny) {
        record[regionId] = { ...box, bits, clean };
        any = true;
      }
    }
    return { index: entry.index, record: any ? record : undefined, votedLayers, thinLayers };
  }
}
