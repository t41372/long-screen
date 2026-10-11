import type { CanvasMeta, Region, RGBA } from '../types.ts';
import type { KV } from '../storage/db.ts';
import { iterate } from '../storage/db.ts';
import type { TileIndex, TileStore } from '../storage/tiles.ts';
import { decodePNG } from '../codec/png.ts';
import { core, type FrameLayout } from './wasm.ts';
import { intersect } from './math.ts';

export type { FrameLayout } from './wasm.ts';

/** Planned output tiles a framed canvas may have before it is skipped (`long_screen_engine::framing::DEFAULT_MAX_TILES`). */
const MAX_TILES = 20000;

/** Presentation is deliberately separate from reconstruction. No toolbar is translated into world coordinates,
 * no sidebar icons are stretched or repeated, and background extensions never count as observed evidence.
 * The framed canvas is built by the engine's framing session (rust/engine/src/framing.rs, docs/ARCHITECTURE.md §十
 * "呈现画布"); this module is its host — the frame-reference row and its PNG decode, the source canvas's tile index,
 * bringing tiles into the cache and storing the ones it fills, the pause/stop checkpoint before each output tile,
 * and the canvas row. */
export function frameLayout(source: RGBA, region: Region, canvas: CanvasMeta): FrameLayout {
  return core().frameLayout(
    source,
    region.crop ? intersect(region.rect, region.crop) : region.rect,
    canvas.bounds.width,
    canvas.bounds.height,
  );
}
/** Native source coordinate for a context pixel; undefined is a decorative extension, null is reconstructed
 * content. Test/diagnostic use only — the framing session classifies pixels inline in Rust. */
export function frameCoordinate(layout: FrameLayout, x: number, y: number): { x: number; y: number } | undefined | null {
  return core().frameCoordinate(layout, x, y);
}

/**
 * Composites the framed presentation canvas: native chrome plus decorative background-extension bands wrapped
 * around the live content rect. Cost is O(perimeter tiles + observed source tiles) by construction, never
 * O(bounding-box area / tile²): the session plans the output tiles that can be non-empty before touching any, and
 * `options.maxTiles` bounds that plan, so a pathological aspect ratio is rejected before any tile work starts.
 */
export async function buildFramedCanvas(
  store: KV,
  tiles: TileStore,
  sourceCanvas: CanvasMeta,
  region: Region,
  regions: Region[],
  checkpoint: () => Promise<void>,
  options?: { maxTiles?: number; onSkipped?: (reason: string) => void },
): Promise<CanvasMeta | undefined> {
  const session = core().framingSession(
    { id: sourceCanvas.id, bounds: sourceCanvas.bounds, tileCount: sourceCanvas.tileCount || 0, attached: !!sourceCanvas.attachedTo },
    region.crop ? intersect(region.rect, region.crop) : region.rect,
    regions.filter((r) => r.kind === 'ignore'),
    tiles.size,
    options?.maxTiles ?? MAX_TILES,
  );
  try {
    for (;;) {
      const step = session.step(tiles.engine, performance.now());
      switch (step.kind) {
        case 'reference': {
          const reference = await store.get<{ frame: number; image: Blob }>('frame-reference');
          session.reference(
            reference && { frame: reference.frame, image: await decodePNG(new Uint8Array(await reference.image.arrayBuffer())) },
          );
          break;
        }
        case 'index':
          for await (const row of iterate<TileIndex>(store, `tile-index/${sourceCanvas.id}/0/`)) {
            session.index(row.value.x, row.value.y, row.value.observed);
          }
          break;
        case 'next':
          await checkpoint();
          break;
        case 'tile':
          await tiles.load(step.canvas, step.x, step.y, step.level);
          break;
        case 'save':
          await tiles.saveResident(step.id);
          break;
        case 'saveDetached':
          await tiles.save(step.tile);
          break;
        case 'unframed':
          return undefined;
        case 'skipped':
          options?.onSkipped?.(
            `Framed canvas exceeded the ${step.diagnostics[0].params.maxTiles} tile limit; skipped before allocating output tiles.`,
          );
          return undefined;
        case 'framed': {
          const framed = step.canvas;
          const meta: CanvasMeta = {
            ...sourceCanvas,
            id: framed.id,
            name: `${sourceCanvas.name} · 保留外框`,
            kind: 'presentation',
            bounds: { x: 0, y: 0, width: framed.width, height: framed.height },
            tileCount: framed.tileCount,
            maxLevel: 0,
            // Recounted from the level-zero mask copied into this view; the source count includes pixels that may
            // not land in it.
            observedPixels: framed.observedPixels,
            provisionalPixels: framed.provisionalPixels,
            // These counters are aggregate source-run diagnostics rather than tile-local masks. The framed canvas is a
            // presentation of the same reconstructed content, so preserve them instead of claiming that the evidence
            // vanished.
            uncertainPixels: sourceCanvas.uncertainPixels,
            conflictPixels: sourceCanvas.conflictPixels,
            presentation: {
              sourceCanvas: sourceCanvas.id,
              sourceRegion: framed.sourceRegion,
              referenceFrame: framed.referenceFrame,
              offset: framed.offset,
              extension:
                'Native-scale reference chrome shown once; flat background-only extensions are presentation, NOT observed world content. Other panes in the frame are reference snapshots, NOT merged trajectories. Coverage bits mark copied evidence; opaque extension pixels are deliberately not covered.',
            },
          };
          await store.put(`canvas/${meta.id}`, meta);
          return meta;
        }
      }
    }
  } finally {
    session.free();
  }
}
