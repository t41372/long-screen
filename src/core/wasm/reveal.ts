/** Overlay-aware block selection after the compositor, living in core memory (mirrors
 *  `rust/wasm/src/reveal.rs`; the algorithm is `rust/core/src/reveal/`). */
import type { Rect } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { REVEAL_DECISION_BYTES, REVEAL_DEFERRED_BYTES, REVEAL_PROVENANCE_HEADER_BYTES, REVEAL_WRITE_BYTES } from './exports.ts';
import { FreeGuard, type Resident, type ResidentFrame } from './memory.ts';

/** The four frame-major passes, in order. */
export const REVEAL_PASSES = ['learn', 'agree', 'relearn', 'write'] as const;
export type RevealPass = typeof REVEAL_PASSES[number];

/** One moving-layer placement of a frame, at its integer raster pose. */
export interface RevealDecision {
  layer: number;
  canvas: number;
  x: number;
  y: number;
  occlusions?: Rect[];
}
/** A 16×16 block to copy from a vote frame: world block (gx, gy) from screen (sx, sy) of `frame`. */
export interface RevealWrite {
  canvas: number;
  gx: number;
  gy: number;
  sx: number;
  sy: number;
  frame: number;
  kind: number;
}
/** A block written after the last pass; `rgba` alpha 0 keeps the canvas pixel. */
export interface RevealDeferred {
  gx: number;
  gy: number;
  frame: number;
  kind: number;
  rgba: Uint8Array;
}
/** Where each 16-pixel block of a canvas takes its pixels from after the write pass: the frame a whole block was
 *  copied from, `-2` for per-pixel values from several frames, `-1` where the compositor's pixels stand. Blocks
 *  `(gx + i % bw, gy + floor(i / bw))` in world block coordinates. */
export interface RevealProvenance {
  gx: number;
  gy: number;
  bw: number;
  bh: number;
  source: Int32Array;
}
export interface RevealSummary {
  objects: number;
  components: number;
  coherentBlocks: number;
  componentBlocks: number;
  provisionalBlocks: number;
  fallbackBlocks: number;
}

/** Integer pixel span of a float rectangle: pixel p is inside iff x ≤ p < x + width. */
function pixelSpan(start: number, size: number): [number, number] {
  const a = Math.ceil(start);
  return [a, Math.max(0, Math.ceil(start + size) - a)];
}

/** Core memory a reveal canvas with these world bounds holds, its write pass's fallback state aside. */
export function revealCanvasBytes(exports: CoreExports, bounds: Rect): number {
  const [, w] = pixelSpan(bounds.x, bounds.width), [, h] = pixelSpan(bounds.y, bounds.height);
  return exports.ls_reveal_canvas_bytes(w, h);
}
/** Core memory a reveal layer over this screen rectangle holds. */
export function revealLayerBytes(exports: CoreExports, rect: Rect): number {
  const [, w] = pixelSpan(rect.x, rect.width), [, h] = pixelSpan(rect.y, rect.height);
  return exports.ls_reveal_layer_bytes(w, h);
}
export class RevealRun {
  private readonly freeGuard = new FreeGuard();
  constructor(
    private readonly core: Core,
    private readonly exports: CoreExports,
    private handle: number,
    readonly width: number,
    readonly height: number,
  ) {}
  /** Adds a moving layer: its screen rectangle and atlas code (0 when it owns the whole rectangle). */
  layer(rect: Rect, code: number): number {
    const [x, w] = pixelSpan(rect.x, rect.width), [y, h] = pixelSpan(rect.y, rect.height);
    return this.core.check(this.exports.ls_reveal_layer(this.handle, x, y, w, h, code), 'reveal layer');
  }
  /** Adds a moving canvas by its world bounds. */
  canvas(bounds: Rect): number {
    return this.core.check(this.exports.ls_reveal_canvas(this.handle, bounds.x, bounds.y, bounds.width, bounds.height), 'reveal canvas');
  }
  /** Adds one tile of the compositor's canvas to that canvas's reference (world origin `x`, `y`). */
  /** `tile`'s planes are read after scratch is planned: a cached tile's planes are views of core memory. */
  ingest(
    canvas: number,
    x: number,
    y: number,
    size: number,
    tile: { readonly pixels: Uint8ClampedArray; readonly coverage: Uint8Array },
  ): void {
    const [rgba, cov] = this.core.scratch([tile.pixels.byteLength, tile.coverage.byteLength]);
    this.core.writeBytes(rgba, tile.pixels);
    this.core.writeBytes(cov, tile.coverage);
    this.core.check(this.exports.ls_reveal_ingest(this.handle, canvas, x, y, size, size, rgba, cov), 'reveal ingest');
  }
  begin(pass: RevealPass): void {
    this.core.check(this.exports.ls_reveal_begin(this.handle, REVEAL_PASSES.indexOf(pass)), 'reveal begin');
  }
  /** The write pass's per-pixel fallback state at most; known once the agree pass has run. */
  fallbackBytes(): number {
    return this.core.check(this.exports.ls_reveal_fallback_bytes(this.handle), 'reveal fallback bytes');
  }
  /** World blocks of `canvas` whose compositor pixels `setMain` must supply before the write pass. */
  fallbacks(canvas: number): [number, number][] {
    const count = this.core.check(this.exports.ls_reveal_fallbacks(this.handle, canvas, 0, 0), 'reveal fallbacks');
    if (!count) return [];
    const [out] = this.core.scratch([count * 8]);
    this.core.check(this.exports.ls_reveal_fallbacks(this.handle, canvas, out, count), 'reveal fallbacks');
    const view = new DataView(this.exports.memory.buffer, out, count * 8);
    return Array.from({ length: count }, (_, k) => [view.getInt32(k * 8, true), view.getInt32(k * 8 + 4, true)]);
  }
  setMain(canvas: number, gx: number, gy: number, rgba: Uint8Array): void {
    const [ptr] = this.core.scratch([16 * 16 * 4]);
    this.core.writeBytes(ptr, rgba);
    this.core.check(this.exports.ls_reveal_set_main(this.handle, canvas, gx, gy, ptr), 'reveal set main');
  }
  /** Which frames the current pass reads pixels of, given every decoded frame's decisions in order. */
  wanted(plans: RevealDecision[][]): Uint8Array {
    const [counts, desc, out] = this.writePlans(plans, Math.max(1, plans.length));
    this.core.check(this.exports.ls_reveal_wanted(this.handle, plans.length, counts, desc, out), 'reveal wanted');
    return this.core.readBytes(out, plans.length);
  }
  /** Which decisions the passes use, given every decoded frame's decisions in order and, alongside, whether each is
   *  blind (the solve held the layer's pose and painted nothing): `rust/core/src/reveal/run.rs::admitted`. */
  admitted(plans: RevealDecision[][], blind: boolean[][]): boolean[][] {
    const total = plans.reduce((n, p) => n + p.length, 0);
    const [counts, desc, flags, out] = this.writePlans(plans, Math.max(1, total), Math.max(1, total));
    this.core.writeBytes(flags, Uint8Array.from(blind.flat(), (b) => b ? 1 : 0));
    this.core.check(this.exports.ls_reveal_admitted(this.handle, plans.length, counts, desc, flags, out), 'reveal admitted');
    const bytes = this.core.readBytes(out, total);
    let k = 0;
    return plans.map((p) => p.map(() => bytes[k++] === 1));
  }
  /** Scratch with every frame's decision count and descriptors (occlusions left out), then `extra` more buffers. */
  private writePlans(plans: RevealDecision[][], ...extra: number[]): number[] {
    const total = plans.reduce((n, p) => n + p.length, 0);
    const [counts, desc, ...rest] = this.core.scratch([
      Math.max(1, plans.length) * 4,
      Math.max(1, total) * REVEAL_DECISION_BYTES,
      ...extra,
    ]);
    const view = new DataView(this.exports.memory.buffer);
    let at = desc;
    plans.forEach((p, i) => {
      view.setUint32(counts + i * 4, p.length, true);
      for (const d of p) {
        view.setUint32(at, d.layer, true);
        view.setUint32(at + 4, d.canvas, true);
        view.setInt32(at + 8, d.x, true);
        view.setInt32(at + 12, d.y, true);
        view.setUint32(at + 16, 0, true);
        view.setUint32(at + 20, 0, true);
        at += REVEAL_DECISION_BYTES;
      }
    });
    return [counts, desc, ...rest];
  }
  /** One decoded frame (resident unless the pass does not read it) with the two before it and this frame's
   *  moving-layer decisions. */
  frame(
    index: number,
    current: ResidentFrame | undefined,
    prev: ResidentFrame | undefined,
    prev2: ResidentFrame | undefined,
    labels: Resident | undefined,
    decisions: RevealDecision[],
  ): void {
    const occlusions = decisions.reduce((n, d) => n + (d.occlusions?.length || 0), 0);
    const [desc, occ] = this.core.scratch([Math.max(1, decisions.length) * REVEAL_DECISION_BYTES, occlusions * 16]);
    const view = new DataView(this.exports.memory.buffer);
    let o = occ;
    decisions.forEach((d, k) => {
      const at = desc + k * REVEAL_DECISION_BYTES, list = d.occlusions || [];
      view.setUint32(at, d.layer, true);
      view.setUint32(at + 4, d.canvas, true);
      view.setInt32(at + 8, d.x, true);
      view.setInt32(at + 12, d.y, true);
      view.setUint32(at + 16, list.length, true);
      view.setUint32(at + 20, list.length ? o : 0, true);
      for (const r of list) {
        const [x, w] = pixelSpan(r.x, r.width), [y, h] = pixelSpan(r.y, r.height);
        view.setInt32(o, x, true);
        view.setInt32(o + 4, y, true);
        view.setInt32(o + 8, w, true);
        view.setInt32(o + 12, h, true);
        o += 16;
      }
    });
    this.core.check(
      this.exports.ls_reveal_frame(
        this.handle,
        index,
        current?.ptr || 0,
        prev?.ptr || 0,
        prev2?.ptr || 0,
        labels?.ptr || 0,
        desc,
        decisions.length,
      ),
      'reveal frame',
    );
  }
  /** Ends a selection pass: open runs vote with the last frame (`before` is the frame ahead of it). */
  end(last: ResidentFrame | undefined, before: ResidentFrame | undefined, labels: Resident | undefined): void {
    this.core.check(this.exports.ls_reveal_end(this.handle, last?.ptr || 0, before?.ptr || 0, labels?.ptr || 0), 'reveal end');
  }
  /** Drains the block copies owed so far. */
  writes(): RevealWrite[] {
    const out: RevealWrite[] = [];
    const batch = 4096;
    while (true) {
      const [ptr] = this.core.scratch([batch * REVEAL_WRITE_BYTES]);
      const n = this.core.check(this.exports.ls_reveal_writes(this.handle, ptr, batch), 'reveal writes');
      const view = new DataView(this.exports.memory.buffer, ptr, n * REVEAL_WRITE_BYTES);
      for (let k = 0; k < n; k++) {
        const at = k * REVEAL_WRITE_BYTES;
        out.push({
          canvas: view.getUint32(at, true),
          gx: view.getInt32(at + 4, true),
          gy: view.getInt32(at + 8, true),
          sx: view.getInt32(at + 12, true),
          sy: view.getInt32(at + 16, true),
          frame: view.getUint32(at + 20, true),
          kind: view.getUint32(at + 24, true),
        });
      }
      if (n < batch) return out;
    }
  }
  /** The blocks of `canvas` written after the last pass. */
  finish(canvas: number): RevealDeferred[] {
    const count = this.core.check(this.exports.ls_reveal_finish(this.handle, canvas), 'reveal finish');
    const out: RevealDeferred[] = [];
    for (let k = 0; k < count; k++) {
      const [ptr] = this.core.scratch([REVEAL_DEFERRED_BYTES]);
      this.core.check(this.exports.ls_reveal_deferred(this.handle, k, ptr), 'reveal deferred');
      const view = new DataView(this.exports.memory.buffer, ptr, 16);
      out.push({
        gx: view.getInt32(0, true),
        gy: view.getInt32(4, true),
        frame: view.getUint32(8, true),
        kind: view.getUint32(12, true),
        rgba: this.core.readBytes(ptr + 16, REVEAL_DEFERRED_BYTES - 16),
      });
    }
    return out;
  }
  /** The block provenance of `canvas`, after `finish(canvas)`; undefined when it had no output. */
  provenance(canvas: number): RevealProvenance | undefined {
    const count = this.core.check(this.exports.ls_reveal_provenance(this.handle, canvas, 0, 0), 'reveal provenance');
    if (!count) return undefined;
    const bytes = REVEAL_PROVENANCE_HEADER_BYTES + count * 4, [ptr] = this.core.scratch([bytes]);
    this.core.check(this.exports.ls_reveal_provenance(this.handle, canvas, ptr, count), 'reveal provenance');
    const raw = this.core.readBytes(ptr, bytes), view = new DataView(raw.buffer, raw.byteOffset, bytes);
    return {
      gx: view.getInt32(0, true),
      gy: view.getInt32(4, true),
      bw: view.getInt32(8, true),
      bh: view.getInt32(12, true),
      source: new Int32Array(raw.buffer.slice(raw.byteOffset + REVEAL_PROVENANCE_HEADER_BYTES, raw.byteOffset + bytes)),
    };
  }
  summary(): RevealSummary {
    const [ptr] = this.core.scratch([24]);
    this.core.check(this.exports.ls_reveal_summary(this.handle, ptr), 'reveal summary');
    const v = new DataView(this.exports.memory.buffer, ptr, 24), at = (k: number) => v.getUint32(k * 4, true);
    return {
      objects: at(0),
      components: at(1),
      coherentBlocks: at(2),
      componentBlocks: at(3),
      provisionalBlocks: at(4),
      fallbackBlocks: at(5),
    };
  }
  free(): void {
    this.freeGuard.once(() => {
      this.exports.ls_reveal_free(this.handle);
      this.handle = 0;
    });
  }
}

/** Starts a reveal run for frames of `width × height` decoded with `noise` (the source's decode noise). */
export function revealRun(core: Core, exports: CoreExports, width: number, height: number, noise: number): RevealRun {
  const handle = core.check(exports.ls_reveal_new(width, height, noise), 'reveal new');
  return new RevealRun(core, exports, handle, width, height);
}
