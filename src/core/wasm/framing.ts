/** Presentation canvases (mirrors `rust/wasm/src/framing.rs`): the engine's framing session
 *  (`long_screen_engine::framing::FramingSession`) that `src/core/framing.ts::buildFramedCanvas` drives for one framed
 *  canvas, plus the layout/coordinate mapping the parity tests check on their own. */
import type { Rect, Region, RGBA } from '../../types.ts';
import type { Core } from './core.ts';
import type { CoreExports } from './exports.ts';
import { LAYOUT_BYTES, VOTING_REGION_BYTES } from './exports.ts';
import { writeRegionDescriptor } from './marshal.ts';
import { FreeGuard, type Resident } from './memory.ts';
import { ByteReader, ByteWriter } from './bytes.ts';
import { type EngineDiagnostic, readDiagnostics } from './diagnostic.ts';
import type { TileCacheHandle } from './tiles.ts';

export interface FrameLayout {
  width: number;
  height: number;
  pane: Rect;
  content: Rect;
  dx: number;
  dy: number;
  seamX: number;
}

function writeLayout(view: DataView, layout: FrameLayout): void {
  view.setFloat64(0, layout.pane.x, true);
  view.setFloat64(8, layout.pane.y, true);
  view.setFloat64(16, layout.pane.width, true);
  view.setFloat64(24, layout.pane.height, true);
  view.setFloat64(32, layout.content.x, true);
  view.setFloat64(40, layout.content.y, true);
  view.setFloat64(48, layout.content.width, true);
  view.setFloat64(56, layout.content.height, true);
  view.setFloat64(64, layout.dx, true);
  view.setFloat64(72, layout.dy, true);
  view.setFloat64(80, layout.seamX, true);
  view.setFloat64(88, layout.width, true);
  view.setFloat64(96, layout.height, true);
}
function readLayout(view: DataView): FrameLayout {
  return {
    pane: { x: view.getFloat64(0, true), y: view.getFloat64(8, true), width: view.getFloat64(16, true), height: view.getFloat64(24, true) },
    content: {
      x: view.getFloat64(32, true),
      y: view.getFloat64(40, true),
      width: view.getFloat64(48, true),
      height: view.getFloat64(56, true),
    },
    dx: view.getFloat64(64, true),
    dy: view.getFloat64(72, true),
    seamX: view.getFloat64(80, true),
    width: view.getFloat64(88, true),
    height: view.getFloat64(96, true),
  };
}

/** `frameLayout()`: test use (the session computes its own layout). */
export function frameLayout(
  core: Core,
  exports: CoreExports,
  source: { width: number; height: number },
  pane: Rect,
  boundsWidth: number,
  boundsHeight: number,
): FrameLayout {
  const [paneP, outP] = core.scratch([32, LAYOUT_BYTES]);
  core.writeRect(paneP, pane);
  core.check(exports.ls_frame_layout(source.width, source.height, paneP, boundsWidth, boundsHeight, outP), 'frameLayout');
  return readLayout(new DataView(exports.memory.buffer, outP, LAYOUT_BYTES));
}
/** `frameCoordinate()`: test/diagnostic use only — the session classifies pixels inline. */
export function frameCoordinate(
  core: Core,
  exports: CoreExports,
  layout: FrameLayout,
  x: number,
  y: number,
): { x: number; y: number } | undefined | null {
  const [layoutP, outP] = core.scratch([LAYOUT_BYTES, 16]);
  writeLayout(new DataView(exports.memory.buffer, layoutP, LAYOUT_BYTES), layout);
  const kind = core.check(exports.ls_frame_coordinate(layoutP, x, y, outP), 'frameCoordinate');
  if (kind === 0) return null;
  if (kind === 1) return undefined;
  const view = new DataView(exports.memory.buffer, outP, 16);
  return { x: view.getFloat64(0, true), y: view.getFloat64(8, true) };
}

/** Uploads `regions` (ignore regions here) for `ls_framing_new`, which copies them. Caller frees the returned
 *  residents exactly once; on a throw partway (e.g. a mask that does not match its declared size) this frees what
 *  it already allocated before rethrowing. */
function uploadRegions(core: Core, exports: CoreExports, regions: Region[]): { ptr: number; count: number; residents: Resident[] } {
  if (!regions.length) return { ptr: 0, count: 0, residents: [] };
  const residents: Resident[] = [];
  try {
    const alloc = (len: number): number => {
      if (!len) return 0;
      const r = core.alloc(len);
      residents.push(r);
      return r.ptr;
    };
    const descriptor = core.alloc(regions.length * VOTING_REGION_BYTES);
    residents.push(descriptor);
    regions.forEach((r, i) => {
      const exclusionsPtr = alloc((r.exclusions?.length || 0) * 32);
      const cropPtr = alloc(r.crop ? 32 : 0);
      const maskPtr = alloc(!!r.mask && !r.solid ? r.mask!.byteLength : 0);
      writeRegionDescriptor(exports, descriptor.ptr, i * VOTING_REGION_BYTES, r, exclusionsPtr, cropPtr, maskPtr);
    });
    return { ptr: descriptor.ptr, count: regions.length, residents };
  } catch (error) {
    for (const r of residents) r.free();
    throw error;
  }
}

/** The canvas a framing session frames. */
export interface FramingSource {
  id: string;
  bounds: Rect;
  tileCount: number;
  attached: boolean;
}
/** A framed canvas the session built (`long_screen_engine::framing::FramedCanvas`). */
export interface FramedCanvas {
  id: string;
  width: number;
  height: number;
  sourceRegion: Rect;
  referenceFrame: number;
  offset: { x: number; y: number };
  tileCount: number;
  observedPixels: number;
  provisionalPixels: number;
}
/** An output tile the cache evicted while its source tiles came in, as the session kept it: copies of its planes. */
export interface DetachedTile {
  canvasId: string;
  level: number;
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  coverage: Uint8Array;
  provisional: Uint8Array;
  quality: Uint8Array;
  conflicts: Uint8Array;
  owner: Uint32Array;
  score: Float32Array;
  frozen: Uint8Array;
  dirty: boolean;
  existed: boolean;
  touched?: number;
}
/** One step of a framing session (`long_screen_engine::framing::Step`). */
export type FramingStep =
  /** Read the reference frame and pass it to `reference()`. */
  | { kind: 'reference' }
  /** Pass every stored level-0 `tile-index/` row of the source canvas to `index()`. */
  | { kind: 'index' }
  /** The next output tile starts: check for pause and stop. */
  | { kind: 'next' }
  /** Bring this tile into the cache. */
  | { kind: 'tile'; canvas: string; level: number; x: number; y: number }
  /** Store this resident tile now. */
  | { kind: 'save'; id: number }
  /** Store this tile, which the cache evicted while the session still worked on it, now. */
  | { kind: 'saveDetached'; tile: DetachedTile }
  | { kind: 'unframed' }
  | { kind: 'skipped'; diagnostics: EngineDiagnostic[] }
  | { kind: 'framed'; canvas: FramedCanvas };

/** `ls_framing_step`: stepped after a `tile` step without the tile being inserted. */
const NOT_PROVIDED = -2;
/** Plane layout `ls_framing_detached` reports (`ls_tiles_planes`'s). */
const PLANES_BYTES = 80;
const PLANE_TYPES = [Uint8ClampedArray, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint32Array, Float32Array, Uint8Array] as const;

/** One framed canvas in progress in core memory. `free()` releases it; one nobody frees is released when it is
 *  garbage collected. */
export class FramingSessionHandle {
  private static readonly registry = new FinalizationRegistry<{ exports: CoreExports; handle: number }>(({ exports, handle }) =>
    exports.ls_framing_free(handle)
  );
  private readonly freeGuard = new FreeGuard();
  private readonly token = {};
  constructor(private readonly core: Core, private readonly exports: CoreExports, private readonly handle: number) {
    FramingSessionHandle.registry.register(this, { exports, handle }, this.token);
  }
  /** The decoded reference frame and its frame number, or nothing when none is stored. */
  reference(reference?: { frame: number; image: RGBA }): void {
    if (!reference) {
      this.core.check(this.exports.ls_framing_reference(this.handle, 0, 0, 0, 0), 'framing reference');
      return;
    }
    const { frame, image } = reference, pixels = this.core.upload(image.data);
    try {
      this.core.check(this.exports.ls_framing_reference(this.handle, frame, pixels.ptr, image.width, image.height), 'framing reference');
    } finally {
      pixels.free();
    }
  }
  /** One stored level-0 tile-index row of the source canvas. */
  index(x: number, y: number, observed: number): void {
    this.core.check(this.exports.ls_framing_index(this.handle, x, y, observed), 'framing index');
  }
  step(tiles: TileCacheHandle, now: number): FramingStep {
    const length = this.exports.ls_framing_step(this.handle, tiles.handle, now);
    if (length === NOT_PROVIDED) throw new Error('CORE_BAD_ARGUMENT: framing stepped before the tile it asked for was brought in.');
    this.core.check(length, 'framing step');
    const [out] = this.core.scratch([length]);
    this.core.check(this.exports.ls_framing_take(this.handle, out, length), 'framing step result');
    const r = new ByteReader(this.core.readBytes(out, length)), kind = r.u8();
    const key = () => ({ canvas: r.str(), level: r.u32(), x: r.u32() | 0, y: r.u32() | 0 });
    switch (kind) {
      case 0:
        return { kind: 'reference' };
      case 1:
        return { kind: 'index' };
      case 2:
        return { kind: 'next' };
      case 3:
        return { kind: 'tile', ...key() };
      case 4:
        return { kind: 'save', id: r.u32() };
      case 5: {
        const { canvas, level, x, y } = key(), existed = r.bool(), touched = r.f64();
        return { kind: 'saveDetached', tile: this.detached(canvas, level, x, y, existed, touched) };
      }
      case 6:
        return { kind: 'unframed' };
      case 7:
        return { kind: 'skipped', diagnostics: readDiagnostics(r) };
      default: {
        const id = r.str(), width = r.f64(), height = r.f64();
        const sourceRegion = { x: r.f64(), y: r.f64(), width: r.f64(), height: r.f64() }, referenceFrame = r.u32();
        const offset = { x: r.f64(), y: r.f64() };
        return {
          kind: 'framed',
          canvas: {
            id,
            width,
            height,
            sourceRegion,
            referenceFrame,
            offset,
            tileCount: r.f64(),
            observedPixels: r.f64(),
            provisionalPixels: r.f64(),
          },
        };
      }
    }
  }
  /** Copies the detached tile's planes out of core memory (a stored row must not hold a view of it). */
  private detached(canvasId: string, level: number, x: number, y: number, existed: boolean, touched: number): DetachedTile {
    const [out] = this.core.scratch([PLANES_BYTES]);
    this.core.check(this.exports.ls_framing_detached(this.handle, out), 'framing detached tile');
    const view = new DataView(this.exports.memory.buffer, out, PLANES_BYTES);
    const planes = PLANE_TYPES.map((Type, i) => {
      const ptr = view.getUint32(i * 8, true), len = view.getUint32(i * 8 + 4, true);
      // A copy in an ArrayBuffer of its own: never shared memory, and aligned for the wider plane types.
      return new Type(new Uint8Array(this.exports.memory.buffer, ptr, len).slice().buffer);
    });
    const dirty = view.getUint32(64, true) !== 0;
    return {
      canvasId,
      level,
      x,
      y,
      pixels: planes[0] as Uint8ClampedArray,
      coverage: planes[1] as Uint8Array,
      provisional: planes[2] as Uint8Array,
      quality: planes[3] as Uint8Array,
      conflicts: planes[4] as Uint8Array,
      owner: planes[5] as Uint32Array,
      score: planes[6] as Float32Array,
      frozen: planes[7] as Uint8Array,
      dirty,
      existed,
      ...(Number.isNaN(touched) ? {} : { touched }),
    };
  }
  free(): void {
    this.freeGuard.once(() => {
      FramingSessionHandle.registry.unregister(this.token);
      this.exports.ls_framing_free(this.handle);
    });
  }
}

/** A framing session for `source` seen through `pane` of the reference frame, leaving `ignoreRegions` out of the
 *  chrome, over `tileSize`-pixel tiles, skipped when it would plan more than `maxTiles` output tiles. */
export function framingSession(
  core: Core,
  exports: CoreExports,
  source: FramingSource,
  pane: Rect,
  ignoreRegions: Region[],
  tileSize: number,
  maxTiles: number,
): FramingSessionHandle {
  const w = new ByteWriter().str(source.id).f64(source.bounds.x).f64(source.bounds.y).f64(source.bounds.width).f64(source.bounds.height)
    .f64(source.tileCount).bool(source.attached).f64(pane.x).f64(pane.y).f64(pane.width).f64(pane.height).u32(tileSize).u32(maxTiles);
  const regions = uploadRegions(core, exports, ignoreRegions);
  try {
    const [ptr, len] = w.place(core);
    const handle = core.check(exports.ls_framing_new(ptr, len, regions.ptr, regions.count), 'framing session');
    return new FramingSessionHandle(core, exports, handle);
  } finally {
    for (const r of regions.residents) r.free();
  }
}
