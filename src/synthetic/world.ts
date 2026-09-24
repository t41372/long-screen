import type { Point, Rect, RGBA, Settings } from '../types.ts';
import { rng } from '../core/math.ts';
export type RGB = [number, number, number];
/** A lossless procedural page. Every pixel is known, so reconstructions can be checked for identity, not similarity. */
export class World {
  readonly data: Uint8ClampedArray;
  readonly patches: { atFrame: number; rect: Rect; pixels: Uint8ClampedArray }[] = [];
  constructor(readonly width: number, readonly height: number, background: RGB = [251, 250, 246]) {
    this.data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = background[0];
      this.data[i + 1] = background[1];
      this.data[i + 2] = background[2];
      this.data[i + 3] = 255;
    }
  }
  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }
  fill(r: Rect, c: RGB): void {
    for (let y = Math.max(0, r.y); y < Math.min(this.height, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(this.width, r.x + r.width); x++) {
        this.set(x, y, c);
      }
    }
  }
  stroke(r: Rect, c: RGB): void {
    this.fill({ x: r.x, y: r.y, width: r.width, height: 1 }, c);
    this.fill({ x: r.x, y: r.y + r.height - 1, width: r.width, height: 1 }, c);
    this.fill({ x: r.x, y: r.y, width: 1, height: r.height }, c);
    this.fill({ x: r.x + r.width - 1, y: r.y, width: 1, height: r.height }, c);
  }
  /** Photograph-like block: smooth gradient plus seeded noise, rich in distinct corners. */
  picture(r: Rect, seed: number): void {
    const random = rng(seed), base: RGB = [90 + random() * 120, 90 + random() * 120, 90 + random() * 120], grain = 18 + random() * 40;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const t = x / Math.max(1, r.width), u = y / Math.max(1, r.height), n = (random() - .5) * grain;
        this.set(
          r.x + x,
          r.y + y,
          [base[0] + 60 * t + n, base[1] + 50 * u + n, base[2] - 40 * t * u + n].map((v) => Math.max(0, Math.min(255, v))) as RGB,
        );
      }
    }
    // A few crisp shapes so features exist at several scales.
    for (let k = 0; k < 6; k++) {
      const w = 6 + Math.floor(random() * Math.max(6, r.width / 5)), h = 6 + Math.floor(random() * Math.max(6, r.height / 5));
      this.fill({
        x: r.x + Math.floor(random() * Math.max(1, r.width - w)),
        y: r.y + Math.floor(random() * Math.max(1, r.height - h)),
        width: w,
        height: h,
      }, [random() * 255, random() * 255, random() * 255]);
    }
  }
  /** Pseudo-text: words made of glyph boxes with varying widths, heights and ascenders. Looks like text at analysis scale and has corners. */
  textLine(x: number, y: number, width: number, seed: number, colour: RGB = [48, 50, 46], size = 1): number {
    const random = rng(seed);
    let cx = x;
    const lineHeight = Math.round(12 * size);
    while (cx < x + width) {
      const letters = 2 + Math.floor(random() * 8);
      for (let l = 0; l < letters && cx < x + width; l++) {
        const w = Math.round((3 + Math.floor(random() * 4)) * size),
          ascender = random() < .3 ? Math.round(3 * size) : 0,
          descender = random() < .15 ? Math.round(3 * size) : 0;
        const h = Math.round(6 * size) + ascender;
        const shade: RGB = [colour[0] + random() * 30, colour[1] + random() * 30, colour[2] + random() * 30];
        this.fill({ x: cx, y: y + lineHeight - Math.round(3 * size) - h, width: w, height: h + descender }, shade);
        if (random() < .5) {
          this.fill({
            x: cx + 1,
            y: y + lineHeight - Math.round(5 * size),
            width: Math.max(1, w - 2),
            height: Math.max(1, Math.round(2 * size)),
          }, [250, 250, 246]);
        }
        cx += w + Math.round(size);
      }
      cx += Math.round(4 * size);
    }
    return lineHeight + Math.round(6 * size);
  }
  paragraph(x: number, y: number, width: number, lines: number, seed: number, size = 1): number {
    let cy = y;
    for (let l = 0; l < lines; l++) {
      cy += this.textLine(x, cy, l === lines - 1 ? width * (.4 + (seed % 5) * .1) : width, seed * 31 + l, [48, 50, 46], size);
    }
    return cy - y;
  }
  barChart(r: Rect, seed: number): void {
    const random = rng(seed), bars = Math.max(2, Math.floor(r.width / 14));
    this.fill(r, [255, 255, 255]);
    this.stroke(r, [200, 205, 195]);
    for (let b = 0; b < bars; b++) {
      const h = Math.floor(6 + random() * (r.height - 12));
      this.fill({ x: r.x + 6 + b * 14, y: r.y + r.height - 6 - h, width: 9, height: h }, b % 3 ? [203, 211, 197] : [214, 136, 112]);
    }
  }
  /** Applies a content change that becomes visible from `atFrame` on (lazy-loaded image, edited text, live counter). */
  patch(atFrame: number, rect: Rect, draw: (scratch: World) => void): void {
    const scratch = new World(rect.width, rect.height);
    for (let y = 0; y < rect.height; y++) {
      scratch.data.set(
        this.data.subarray(((rect.y + y) * this.width + rect.x) * 4, ((rect.y + y) * this.width + rect.x + rect.width) * 4),
        y * rect.width * 4,
      );
    }
    draw(scratch);
    this.patches.push({ atFrame, rect, pixels: scratch.data });
  }
  /** World pixels as of a frame index, honouring patches. */
  at(frame: number): Uint8ClampedArray {
    const active = this.patches.filter((p) => p.atFrame <= frame);
    if (!active.length) {
      return this.data;
    }
    const data = this.data.slice();
    for (const p of active) {
      for (let y = 0; y < p.rect.height; y++) {
        data.set(p.pixels.subarray(y * p.rect.width * 4, (y + 1) * p.rect.width * 4), ((p.rect.y + y) * this.width + p.rect.x) * 4);
      }
    }
    return data;
  }
  /** Every value a pixel may legitimately show across all content versions. */
  versions(x: number, y: number): RGB[] {
    const out: RGB[] = [this.rgb(this.data, x, y)];
    for (const p of this.patches) {
      if (x >= p.rect.x && y >= p.rect.y && x < p.rect.x + p.rect.width && y < p.rect.y + p.rect.height) {
        const i = ((y - p.rect.y) * p.rect.width + x - p.rect.x) * 4;
        out.push([p.pixels[i], p.pixels[i + 1], p.pixels[i + 2]]);
      }
    }
    return out;
  }
  rgb(data: Uint8ClampedArray, x: number, y: number): RGB {
    const i = (y * this.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  }
}
export type WorldStyle = 'article' | 'cards' | 'list' | 'comic' | 'sparse';
/** Deterministic page layouts covering the content families in the requirements. */
export function makeWorld(width: number, height: number, seed: number, style: WorldStyle = 'article', columns = 1): World {
  const world = new World(width, height), random = rng(seed);
  const columnWidth = Math.floor(width / columns);
  for (let col = 0; col < columns; col++) {
    const x0 = col * columnWidth + 20, w = columnWidth - 40;
    let y = 24;
    if (style === 'list') {
      // Identical rows: exactly repeated pixels, the hardest case for feature uniqueness.
      const rowSeed = Math.floor(random() * 1e6);
      for (let row = 0; y + 44 < height - 200; row++) {
        world.fill({ x: x0, y, width: w, height: 40 }, [255, 255, 255]);
        world.stroke({ x: x0, y, width: w, height: 40 }, [214, 217, 210]);
        world.fill({ x: x0 + 8, y: y + 8, width: 24, height: 24 }, [110, 140, 120]);
        world.textLine(x0 + 42, y + 8, w - 60, rowSeed);
        world.textLine(x0 + 42, y + 22, w * .5, rowSeed + 1, [140, 142, 136], .8);
        y += 44;
      }
      // Distinct content below so the recording can re-anchor after the repetitive section.
      world.paragraph(x0, y + 12, w, 6, seed + 77);
      continue;
    }
    while (y < height - 40) {
      const roll = random();
      if (style === 'sparse' && roll < .5) {
        y += 120 + Math.floor(random() * 240);
        continue;
      }
      if (style === 'comic') {
        const panelH = 160 + Math.floor(random() * 220);
        world.picture({ x: x0, y, width: w, height: Math.min(panelH, height - y - 8) }, Math.floor(random() * 1e9));
        y += panelH + 12;
        continue;
      }
      if (style === 'cards') {
        const cardH = 150;
        world.fill({ x: x0, y, width: w, height: cardH }, [255, 255, 255]);
        world.stroke({ x: x0, y, width: w, height: cardH }, [230, 229, 223]);
        world.fill(
          { x: x0 + 14, y: y + 16, width: 6, height: 18 },
          [[207, 103, 80], [111, 135, 116], [102, 133, 154], [165, 130, 86]][Math.floor(random() * 4)] as RGB,
        );
        world.textLine(x0 + 30, y + 14, w - 60, Math.floor(random() * 1e6), [48, 52, 47], 1.3);
        world.paragraph(x0 + 14, y + 44, w - 28, 3, Math.floor(random() * 1e6), .9);
        world.barChart({ x: x0 + 14, y: y + 100, width: Math.min(220, w - 28), height: 40 }, Math.floor(random() * 1e6));
        y += cardH + 18;
        continue;
      }
      // article
      if (roll < .15) {
        world.textLine(x0, y, w * .7, Math.floor(random() * 1e6), [30, 34, 30], 1.8);
        y += 36;
      } else if (roll < .35) {
        const h = 90 + Math.floor(random() * 120);
        world.picture(
          { x: x0, y, width: Math.min(w, 260 + Math.floor(random() * (w - 260))), height: Math.min(h, height - y - 8) },
          Math.floor(random() * 1e9),
        );
        y += h + 14;
      } else if (roll < .42) {
        world.fill({ x: x0, y: y + 6, width: w, height: 1 }, [205, 205, 198]);
        y += 20;
      } else {
        y += world.paragraph(x0, y, w, 2 + Math.floor(random() * 5), Math.floor(random() * 1e6)) + 10;
      }
    }
  }
  return world;
}
export interface Layer {
  id: string;
  /** Screen rectangle this layer occupies in every frame. */
  viewport: Rect;
  world: World;
  /** World offset of the viewport's top-left per frame. */
  path: Point[];
  /** Per-frame magnification (1 = native pixels). Values ≠ 1 resample the world, so pixel identity is not expected there. */
  zoom?: number[];
  /** World-space rectangles redrawn every frame (animation, playing video, live counters). */
  dynamics?: { rect: Rect; draw: (scratch: World, frame: number, time: number) => void; every?: number }[];
}
export interface Overlay {
  id: string;
  kind: 'fixed' | 'dynamic';
  /** Draws in screen space and returns the rectangles it touched. */
  draw: (frame: RGBA, index: number, time: number) => Rect[];
}
export interface Scenario {
  name: string;
  description: string;
  width: number;
  height: number;
  layers: Layer[];
  overlays: Overlay[];
  frames: { time: number; duration: number; width?: number; height?: number }[];
  background: RGB;
  expect: Expectations;
  /** Engine settings overrides this scenario's checkScenario() run must apply (e.g. a non-default analysisSize
   *  needed to hit a declared `expect.factor`), so the catalogue stays the single source of truth instead of the
   *  override living at each individual test-file call site. */
  settings?: Partial<Settings>;
}
export interface Expectations {
  /** Expected number of unplaced fragments per layer id (0 = one continuous canvas). */
  fragments: Record<string, number>;
  diagnostics: { present: string[]; absent: string[] };
  /** Maximum allowed placement error in native pixels on the main canvas. */
  maxError: number;
  /** Project status. */
  status: 'complete' | 'partial';
  /** Frames the run is expected to render. */
  frames?: number;
  /** Declared pixel-level ambiguity: placements may differ from truth only by multiples of this period (identical repeated rows). */
  ambiguousPeriod?: number;
  /** Known limitation: the run must complete and report conflicts, but pixel-set equality is not asserted. */
  limitation?: boolean;
  /** Exact integer analysis downscale factor (`Engine.factor`) this scenario's frame size and settings must produce, when declared. */
  factor?: number;
  /** Ratchets on ground-truth pixel discrepancies, asserted in addition to the branch above (main canvas and every pixel-checked
   *  fragment). Each defaults to 0 (exact) when not declared; a nonzero value records a measured, known deviation, not a target. */
  maxMissing?: number;
  maxInvented?: number;
  maxMismatched?: number;
  /** Pixels that differ from the page but sat under an overlay/dynamic region in some observing frame: recorded contamination
   *  from screen chrome (cursor, FAB, toast, video), not accepted behaviour. Kept for backward compatibility as the SUM of
   *  maxContaminatedOverlay + maxContaminatedDynamic when a scenario declares the split explicitly; defaults to 0. */
  maxContaminated?: number;
  /** Ratchet on contaminatedOverlay alone: pixels explained only by a screen-space overlay (FAB, scrollbar, cursor,
   *  toast — never moves with the page). The world-consistency mask targets this at 0; every scenario with an
   *  overlay must declare it explicitly (0 is the default, so most scenarios need not declare it at all). */
  maxContaminatedOverlay?: number;
  /** Ratchet on contaminatedDynamic alone: pixels explained only by a page-space dynamic (animated widget, live
   *  counter, caret, playing video), which is legitimately allowed to keep one moment (docs/ARCHITECTURE.md §七). */
  maxContaminatedDynamic?: number;
  /** Ratchet on contaminatedOverlayRecoverable: overlay-attributed pixels whose world position WAS observed clean
   *  at least once on the main canvas, so the world-consistency mask/voting should have healed them. This is the
   *  real target — 0 by default — distinct from maxContaminatedOverlay, which a scenario with any genuinely
   *  unobservable content (see below) cannot drive to 0 even once every recoverable pixel is healed. */
  maxContaminatedOverlayRecoverable?: number;
  /** Ratchet on the scenario's ANALYTIC unobservable count (every ever-visible main-canvas world pixel of this
   *  layer's region that was never, in any recorded frame, both on screen and clear of every overlay/dynamic rect
   *  at once) — a property of the scenario's geometry and overlay/dynamic placement alone, not of engine
   *  behaviour, computed identically whether or not the pixel actually ended up contaminated. Guards against this
   *  ceiling silently growing (e.g. a scenario edit that makes more content genuinely unrecoverable) even though
   *  the measured contaminatedOverlayUnobservable can never exceed it regardless of this ratchet (asserted
   *  unconditionally in scenario-check.ts). Defaults to 0 — a scenario with real unobservable content records
   *  the analytic number as a comment where it declares this. */
  maxContaminatedOverlayUnobservable?: number;
  /** Net provisional-pixel count (CanvasMeta.provisionalPixels) the main canvas must end at or below once the run
   *  finishes: unhealed world-consistency mask flags still standing in the final result. Defaults to 0 (exact) —
   *  a scenario with overlays/dynamics that a one-frame lookahead cannot fully heal declares a measured value. */
  maxProvisional?: number;
}
export interface RenderedFrame {
  image: RGBA;
  /** The same frame one step earlier: page and page-space dynamics composited, before any overlay drew into it.
   *  An overlay's `overlayRects` are bounding boxes, and several overlays only paint part of their own box (a
   *  mouse pointer is an arrow inside a 10×16 rect), so "inside an overlay rect" and "painted by an overlay" are
   *  different questions. Ground-truth attribution needs the second one: a pixel the pointer's box merely
   *  contained still shows the page (or a page-space dynamic), and blaming a later mismatch there on the pointer
   *  credits a screen overlay with content it never touched. */
  beneath: Uint8ClampedArray;
  /** Screen-space rectangles covered by overlays this frame (pixels there are not page content). */
  overlayRects: Rect[];
  /** World-space rectangles per layer that were dynamic this frame. */
  dynamicRects: Record<string, Rect[]>;
}
function blit(target: RGBA, x: number, y: number, source: Uint8ClampedArray, sw: number, sr: Rect): void {
  for (let row = 0; row < sr.height; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) {
      continue;
    }
    const sy = sr.y + row;
    if (sy < 0 || sy >= source.length / (sw * 4)) {
      continue;
    }
    const x0 = Math.max(0, -x), x1 = Math.min(sr.width, target.width - x);
    if (x1 <= x0) {
      continue;
    }
    target.data.set(source.subarray((sy * sw + sr.x + x0) * 4, (sy * sw + sr.x + x1) * 4), (ty * target.width + x + x0) * 4);
  }
}
export function fillRGBA(target: RGBA, r: Rect, c: RGB): void {
  for (let y = Math.max(0, r.y); y < Math.min(target.height, r.y + r.height); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(target.width, r.x + r.width); x++) {
      const i = (y * target.width + x) * 4;
      target.data[i] = c[0];
      target.data[i + 1] = c[1];
      target.data[i + 2] = c[2];
      target.data[i + 3] = 255;
    }
  }
}
/** Renders one frame with lossless crops, patches, zoom resampling, world dynamics and screen overlays. */
export function renderFrame(s: Scenario, index: number): RenderedFrame {
  const spec = s.frames[index], width = spec.width ?? s.width, height = spec.height ?? s.height;
  const image: RGBA = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  fillRGBA(image, { x: 0, y: 0, width, height }, s.background);
  const dynamicRects: Record<string, Rect[]> = {};
  for (const layer of s.layers) {
    const p = layer.path[index], zoom = layer.zoom?.[index] ?? 1, v = layer.viewport;
    let data = layer.world.at(index);
    dynamicRects[layer.id] = [];
    for (const d of layer.dynamics || []) {
      if (d.every && index % d.every) {
        continue;
      }
      if (data === layer.world.data) {
        data = data.slice();
      }
      const scratch = new World(d.rect.width, d.rect.height);
      for (let y = 0; y < d.rect.height; y++) {
        scratch.data.set(
          data.subarray(
            ((d.rect.y + y) * layer.world.width + d.rect.x) * 4,
            ((d.rect.y + y) * layer.world.width + d.rect.x + d.rect.width) * 4,
          ),
          y * d.rect.width * 4,
        );
      }
      d.draw(scratch, index, spec.time);
      for (let y = 0; y < d.rect.height; y++) {
        data.set(
          scratch.data.subarray(y * d.rect.width * 4, (y + 1) * d.rect.width * 4),
          ((d.rect.y + y) * layer.world.width + d.rect.x) * 4,
        );
      }
      dynamicRects[layer.id].push(d.rect);
    }
    if (zoom === 1) {
      blit(image, v.x, v.y, data, layer.world.width, { x: p.x, y: p.y, width: v.width, height: v.height });
    } else {
      for (let y = 0; y < v.height; y++) {
        for (let x = 0; x < v.width; x++) {
          // Bilinear resample: a magnified page is a different pixel grid, not the native canvas.
          const wx = p.x + x / zoom,
            wy = p.y + y / zoom,
            x0 = Math.floor(wx),
            y0 = Math.floor(wy),
            fx = wx - x0,
            fy = wy - y0,
            o = ((v.y + y) * width + v.x + x) * 4;
          if (x0 < 0 || y0 < 0 || x0 + 1 >= layer.world.width || y0 + 1 >= layer.world.height) {
            continue;
          }
          for (let c = 0; c < 3; c++) {
            const i = (y0 * layer.world.width + x0) * 4 + c, j = i + layer.world.width * 4;
            image.data[o + c] = (data[i] * (1 - fx) + data[i + 4] * fx) * (1 - fy) + (data[j] * (1 - fx) + data[j + 4] * fx) * fy;
          }
          image.data[o + 3] = 255;
        }
      }
    }
  }
  const beneath = image.data.slice();
  const overlayRects: Rect[] = [];
  for (const overlay of s.overlays) {
    overlayRects.push(...overlay.draw(image, index, spec.time));
  }
  return { image, beneath, overlayRects, dynamicRects };
}
export function linearPath(waypoints: Point[], stepsBetween: number | number[]): Point[] {
  const out: Point[] = [];
  for (let k = 1; k < waypoints.length; k++) {
    const a = waypoints[k - 1], b = waypoints[k], n = Array.isArray(stepsBetween) ? stepsBetween[k - 1] : stepsBetween;
    for (let i = 0; i < n; i++) {
      out.push({ x: Math.round(a.x + (b.x - a.x) * i / n), y: Math.round(a.y + (b.y - a.y) * i / n) });
    }
  }
  out.push(waypoints[waypoints.length - 1]);
  return out;
}
export const constantFrames = (count: number, fps = 30, start = 0): Scenario['frames'] =>
  Array.from({ length: count }, (_, i) => ({ time: start + i / fps, duration: 1 / fps }));
