/** The engine's reveal session (`long_screen::engine::reveal::RevealSession`, mirrors `rust/wasm/src/reveal.rs`) that
 *  `src/pipeline/reveal.ts` drives: overlay-aware block selection after the compositor. The algorithm is
 *  `rust/long-screen/src/kernels/reveal/`; the run around it — which decisions count, the memory check, the passes, the tile writes —
 *  is the session's. */
import type { Rect } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { ByteReader, ByteWriter } from './bytes.ts';
import { type EngineDiagnostic, readDiagnostic } from './diagnostic.ts';
import { FreeGuard, type Resident } from './memory.ts';
import type { TileCacheHandle } from './tiles.ts';

/** The four frame-major passes, in order. */
export const REVEAL_PASSES = ['learn', 'agree', 'relearn', 'write'] as const;
export type RevealPass = typeof REVEAL_PASSES[number];

/** What a reveal session covers: the moving layers (screen rectangle and atlas code) and the moving canvases. */
export interface RevealInput {
  width: number;
  height: number;
  noise: number;
  tileSize: number;
  /** Frames the run decoded. */
  frames: number;
  layers: { id: string; rect: Rect; code: number }[];
  canvases: { id: string; bounds: Rect }[];
}
/** One decision of a stored `observation/` row, as the session reads it. */
export interface RevealObservedDecision {
  canvasId: string;
  placement: { layer: string; x: number; y: number; skip?: boolean; occlusions?: Rect[] };
  skipped?: boolean;
}
/** The counters of the `reveal-summary` row, in its field order. */
export interface RevealSummary {
  objects: number;
  components: number;
  coherentBlocks: number;
  componentBlocks: number;
  provisionalBlocks: number;
  fallbackBlocks: number;
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
/** One step of a reveal session (`long_screen::engine::reveal::Step`). */
export type RevealStep =
  /** Answer with `memory()`: can `bytes` more be allocated? */
  | { kind: 'memory'; bytes: number; stage: 'canvases' | 'fallback' }
  /** Pass every stored `observation/` row to `observation()`. */
  | { kind: 'observations' }
  /** Bring this tile into the cache. */
  | { kind: 'tile'; canvas: string; level: number; x: number; y: number }
  /** A compositor tile went into the reference: check for pause and stop. */
  | { kind: 'checkpoint' }
  /** Decode the recording for `pass`; `wanted[i]` is 1 for the frames whose pixels it reads. */
  | { kind: 'decode'; pass: RevealPass; wanted: Uint8Array }
  /** The pushed frame is done. */
  | { kind: 'nextFrame' }
  /** The pass is over. */
  | { kind: 'passDone'; pass: RevealPass }
  /** Store this canvas's `reveal/<canvas>` row. */
  | { kind: 'provenance'; canvas: string; provenance: RevealProvenance }
  | { kind: 'nothing' }
  | { kind: 'skipped'; diagnostic: EngineDiagnostic }
  | { kind: 'revealed'; summary: RevealSummary };

/** `ls_reveal_step`: stepped after a `tile` step without the tile being inserted. */
const NOT_PROVIDED = -2;

/** One reveal run in core memory. `free()` releases it; one nobody frees is released when it is garbage collected. */
export class RevealSessionHandle {
  private static readonly registry = new FinalizationRegistry<{ exports: CoreExports; handle: number }>(({ exports, handle }) =>
    exports.ls_reveal_free(handle)
  );
  private readonly freeGuard = new FreeGuard();
  private readonly token = {};
  constructor(private readonly core: Core, private readonly exports: CoreExports, private readonly handle: number) {
    RevealSessionHandle.registry.register(this, { exports, handle }, this.token);
  }
  /** Whether the bytes of the last `memory` step fit, and the core's size in bytes. */
  memory(fits: boolean, coreBytes: number): void {
    this.core.check(this.exports.ls_reveal_memory(this.handle, fits ? 1 : 0, coreBytes), 'reveal memory');
  }
  /** One stored `observation/` row. */
  observation(frame: number, decisions: RevealObservedDecision[]): void {
    const w = new ByteWriter().u32(frame).u32(decisions.length);
    for (const d of decisions) {
      const p = d.placement, occlusions = p.occlusions || [];
      w.str(d.canvasId ?? '').str(p.layer ?? '').f64(p.x).f64(p.y).bool(!!p.skip).bool(!!d.skipped).u32(occlusions.length);
      for (const r of occlusions) w.f64(r.x).f64(r.y).f64(r.width).f64(r.height);
    }
    const [ptr, len] = w.place(this.core);
    this.core.check(this.exports.ls_reveal_observation(this.handle, ptr, len), 'reveal observation');
  }
  /** Where the next wanted frame's RGBA goes: a pointer into core memory, valid until the session is freed. */
  frameBuffer(): number {
    const ptr = this.exports.ls_reveal_frame(this.handle);
    if (!ptr) throw new Error('CORE_BAD_ARGUMENT: reveal frame buffer.');
    return ptr;
  }
  /** Frame `index` was decoded (into `frameBuffer()` when the pass wanted it). */
  push(index: number, labels: Resident | undefined): void {
    this.core.check(this.exports.ls_reveal_push(this.handle, index, labels?.ptr || 0, labels?.length || 0), 'reveal frame');
  }
  /** The decode for this pass is over. */
  end(labels: Resident | undefined): void {
    this.core.check(this.exports.ls_reveal_end(this.handle, labels?.ptr || 0, labels?.length || 0), 'reveal end');
  }
  step(tiles: TileCacheHandle, now: number): RevealStep {
    const length = this.exports.ls_reveal_step(this.handle, tiles.handle, now);
    if (length === NOT_PROVIDED) throw new Error('CORE_BAD_ARGUMENT: reveal stepped before the tile it asked for was brought in.');
    this.core.check(length, 'reveal step');
    const [out] = this.core.scratch([length]);
    this.core.check(this.exports.ls_reveal_take(this.handle, out, length), 'reveal step result');
    const r = new ByteReader(this.core.readBytes(out, length));
    switch (r.u8()) {
      case 0:
        return { kind: 'memory', bytes: r.f64(), stage: r.u8() === 0 ? 'canvases' : 'fallback' };
      case 1:
        return { kind: 'observations' };
      case 2:
        return { kind: 'tile', canvas: r.str(), level: r.u32(), x: r.i32(), y: r.i32() };
      case 3:
        return { kind: 'checkpoint' };
      case 4: {
        const pass = REVEAL_PASSES[r.u8()];
        return { kind: 'decode', pass, wanted: r.take(r.u32()) };
      }
      case 5:
        return { kind: 'nextFrame' };
      case 6:
        return { kind: 'passDone', pass: REVEAL_PASSES[r.u8()] };
      case 7: {
        const canvas = r.str(), gx = r.i32(), gy = r.i32(), bw = r.u32(), bh = r.u32();
        // A copy in an ArrayBuffer of its own, aligned for the i32 view.
        const source = new Int32Array(r.take(bw * bh * 4).slice().buffer);
        return { kind: 'provenance', canvas, provenance: { gx, gy, bw, bh, source } };
      }
      case 8:
        return { kind: 'nothing' };
      case 9:
        return { kind: 'skipped', diagnostic: readDiagnostic(r) };
      default:
        return {
          kind: 'revealed',
          summary: {
            objects: r.u32(),
            components: r.u32(),
            coherentBlocks: r.u32(),
            componentBlocks: r.u32(),
            provisionalBlocks: r.u32(),
            fallbackBlocks: r.u32(),
          },
        };
    }
  }
  free(): void {
    this.freeGuard.once(() => {
      RevealSessionHandle.registry.unregister(this.token);
      this.exports.ls_reveal_free(this.handle);
    });
  }
}

/** A reveal session over `input`'s layers and canvases; the caller frees it. */
export function revealSession(core: Core, exports: CoreExports, input: RevealInput): RevealSessionHandle {
  const w = new ByteWriter().u32(input.width).u32(input.height).f64(input.noise).u32(input.tileSize).u32(input.frames)
    .u32(input.layers.length);
  for (const l of input.layers) w.str(l.id).f64(l.rect.x).f64(l.rect.y).f64(l.rect.width).f64(l.rect.height).u32(l.code);
  w.u32(input.canvases.length);
  for (const c of input.canvases) w.str(c.id).f64(c.bounds.x).f64(c.bounds.y).f64(c.bounds.width).f64(c.bounds.height);
  const [ptr, len] = w.place(core);
  return new RevealSessionHandle(core, exports, core.check(exports.ls_reveal_new(ptr, len), 'reveal session'));
}
