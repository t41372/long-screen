import { createId } from '../core/id.ts';
import type { KV } from '../storage/db.ts';
import { deletePrefix, iterate } from '../storage/db.ts';
import type { CanvasMeta, Project, Rect, Region } from '../types.ts';
import { type StoredTile, type TileIndex, TileStore } from '../storage/tiles.ts';
import { ZipWriter } from './zip.ts';
import { utf8 } from '../codec/crc.ts';
import { createTarget } from './target.ts';
import { offlineViewer } from './offline.ts';
import { encodePNG } from '../codec/png.ts';
import { rasterRows } from './png.ts';
export interface ExportResult {
  blob?: Blob;
  name: string;
  temporary?: string;
  message: string;
}
async function* jsonLines(db: KV, prefix: string): AsyncGenerator<Uint8Array> {
  for await (const row of iterate(db, prefix)) {
    yield utf8(
      JSON.stringify(row.value, (_, value) => ArrayBuffer.isView(value) ? Array.from(value as unknown as number[]) : value) + '\n',
    );
  }
}
/** Base64, chunked so a large mask never blows the argument-count limit of String.fromCharCode(...bytes). */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
export async function exportProject(
  db: KV,
  project: Project,
  onProgress: (message: string, fraction: number) => void,
  handle?: FileSystemFileHandle,
): Promise<ExportResult> {
  const target = await createTarget('long-screen-project.zip', handle), zip = new ZipWriter(target.sink), canvases: CanvasMeta[] = [];
  try {
    for await (const { value } of iterate<CanvasMeta>(db, 'canvas/')) {
      canvases.push(value);
    }
    const manifest = {
      format: 'long-screen/sparse-canvas',
      version: 2,
      presentation:
        'Canvases with kind=presentation are framed views, not independent reconstructed worlds. Their opaque decorative extensions have NO evidence coverage; see canvas.presentation. Original moving and fixed canvases are retained.',
      tileSize: project.settings.tileSize,
      coordinates: 'Native source pixels. Each independent canvas has its own origin.',
      holes: 'Transparent pixels were not observed; the enclosing bounding rectangle is not a coverage guarantee.',
      levels: 'Level 0 is native resolution; levels 1+ are explicitly downsampled previews.',
      confidence: 'Heuristic, uncalibrated, not a correctness probability.',
      sourceIncluded: false,
      project,
      canvases,
    };
    await zip.add('manifest.json', utf8(JSON.stringify(manifest, null, 2)));
    await zip.add('index.html', utf8(offlineViewer(manifest)));
    await zip.add(
      'README.txt',
      utf8(
        'Long Screen — offline reconstruction\n\nUnzip everything, then open index.html. Level-zero PNG tiles preserve native output resolution. Missing tiles and transparent pixels are unobserved holes, not white page content. Independent fragments are not asserted to be adjacent. The original video is NOT included: retain it for source-time comparisons. observations.jsonl records every processed source frame and chosen placement; diagnostics.jsonl contains warnings. quality/*.json stores 16px-block heuristic quality, conflict markers, and source-frame ownership. provisional/*.bin marks covered pixels the world-consistency mask could not corroborate against a neighbouring frame (screen-space overlay/dynamic burn-in still awaiting a later consistent observation), same bit layout as coverage/*.bin. Pixel coverage bits are least-significant-bit first. Pyramids are previews only. regions.json holds the full region definitions (including their masks, base64-encoded) that produced canvases[].layer.\n',
      ),
    );
    const regions = (await db.get<Region[]>('regions')) || [];
    // analysis.jsonl (built from scan/ below) carries no per-feature descriptors any more — features live only
    // transiently under scan-features/ during solve() and are deleted once it finishes with them — so region
    // masks are this export's one remaining large binary payload; base64 keeps them out of a decimal JSON array.
    await zip.add('regions.json', utf8(JSON.stringify(regions.map((r) => ({ ...r, mask: r.mask ? base64(r.mask) : undefined })), null, 2)));
    let n = 0;
    for await (const row of iterate<TileIndex>(db, 'tile-index/')) {
      const t = row.value, key = `${t.canvasId}/${t.level}/${t.x}_${t.y}`, tile = await db.get<StoredTile>(`tile/${key}`);
      if (!tile) {
        throw new Error(`Missing committed tile ${key}; export was not marked complete.`);
      }
      await zip.add(`tiles/${key}.png`, tile.blob);
      if (t.level === 0) {
        await zip.add(`coverage/${t.canvasId}/${t.x}_${t.y}.bin`, tile.coverage);
        // Same bit layout as coverage/ (LSB-first). A set bit is a covered pixel the world-consistency mask
        // (docs/ARCHITECTURE.md §七) could not corroborate against a neighbouring frame: screen-space
        // overlay/dynamic burn-in still awaiting a later consistent observation to heal it.
        await zip.add(`provisional/${t.canvasId}/${t.x}_${t.y}.bin`, tile.provisional || new Uint8Array(tile.coverage.length));
        await zip.add(
          `quality/${t.canvasId}/${t.x}_${t.y}.json`,
          utf8(
            JSON.stringify({
              blockSize: 16,
              quality: [...(tile.quality || [])],
              conflicts: [...(tile.conflicts || [])],
              frozen: [...(tile.frozen || [])],
              ownerFrameEncoding:
                '0 = unassigned; otherwise zero-based source frame index + 1. Block-level representative, not per-pixel provenance.',
              ownerFrame: [...tile.owner],
            }),
          ),
        );
      }
      if (++n % 8 === 0) {
        onProgress(`导出原图与预览瓦片 ${n}`, Math.min(.90, n / Math.max(1, project.tiles * 1.5)));
      }
    }
    for (
      const [name, prefix] of [
        ['observations', 'observation/'],
        ['diagnostics', 'diagnostic/'],
        ['poses', 'node/'],
        ['pose-edges', 'edge/'],
        ['analysis', 'scan/'],
        ['temporal', 'temporal/'],
        ['attachments', 'attach/'],
      ]
    ) {
      await zip.add(`${name}.jsonl`, jsonLines(db, prefix));
    }
    for (const key of ['graph-summary', 'memory-stats', 'performance']) {
      await zip.add(`${key}.json`, utf8(JSON.stringify(await db.get(key) || {}, null, 2)));
    }
    onProgress('写入 ZIP64 目录并提交文件', .98);
    await zip.finish();
    return { ...await target.result(), message: '已导出原尺寸瓦片、离线查看器、覆盖与质量数据、源帧记录和完整诊断。' };
  } catch (error) {
    await target.sink.abort?.(error);
    // A failed export must stop the ZIP writer's still-running internal pump so it never writes into a sink
    // `abort()` has already closed out from under it.
    await zip.dispose();
    throw error;
  }
}
/** `single`: always one PNG of the whole canvas at native size (the PNG format allows 2³¹−1 per side and rows are
 *  streamed, so size only costs time); `auto`: one PNG when it stays within common viewer limits, otherwise
 *  overlapping native-size sheets in a ZIP; `sheets`: always the paged ZIP, even when the canvas would fit one PNG
 *  (a canvas that fits one page still yields a ZIP, with exactly one sheet plus its manifest). */
export type CanvasLayout = 'single' | 'auto' | 'sheets';
export async function exportCanvas(
  db: KV,
  project: Project,
  meta: CanvasMeta,
  onProgress: (message: string, fraction: number) => void,
  handle?: FileSystemFileHandle,
  layout: CanvasLayout = 'auto',
): Promise<ExportResult> {
  const left = Math.floor(meta.bounds.x),
    top = Math.floor(meta.bounds.y),
    right = Math.ceil(meta.bounds.x + meta.bounds.width),
    bottom = Math.ceil(meta.bounds.y + meta.bounds.height);
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  // These are viewer/interoperability and cache limits, not false claims about the PNG specification.
  const sheetWidth = Math.min(
      4096,
      Math.max(512, Math.floor(project.settings.memoryMB * 1024 * 1024 * .20 / (project.settings.tileSize * 4) / 512) * 512),
    ),
    sheetHeight = 8192;
  const single = layout === 'single' ||
    (layout === 'auto' && rect.width <= sheetWidth && rect.height <= 32767 && rect.width * rect.height <= 100000000);
  const name = single ? 'long-screen.png' : 'long-screen-sheets.zip',
    target = await createTarget(name, handle),
    tiles = new TileStore(db, project.settings.tileSize, project.settings.memoryMB);
  // Declared here (not inside the try) so a failure partway through the sheet branch can still find them to clean up.
  let zip: ZipWriter | undefined, sheetPrefix: string | undefined;
  try {
    if (single) {
      for await (
        const bytes of encodePNG(
          rect.width,
          rect.height,
          rasterRows(tiles, meta.id, rect, (row) => onProgress(`无缩放编码 ${row} / ${rect.height} 行`, row / rect.height)),
        )
      ) {
        await target.sink.write(bytes);
      }
      await target.sink.close();
      return { ...await target.result(), message: `已导出 ${rect.width} × ${rect.height} 原尺寸 PNG，缺口保持透明。` };
    }
    const overlap = 32;
    zip = new ZipWriter(target.sink);
    sheetPrefix = `sheet-export/${createId()}/`;
    const prefix = sheetPrefix;
    for await (const { value: t } of iterate<TileIndex>(db, `tile-index/${meta.id}/0/`)) {
      const x1 = Math.floor((t.x * tiles.size - rect.x) / sheetWidth),
        x2 = Math.floor(((t.x + 1) * tiles.size - 1 - rect.x) / sheetWidth),
        y1 = Math.floor((t.y * tiles.size - rect.y) / sheetHeight),
        y2 = Math.floor(((t.y + 1) * tiles.size - 1 - rect.y) / sheetHeight);
      for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
          if (x >= 0 && y >= 0) {
            await db.put(`${prefix}${x}_${y}`, { x, y });
          }
        }
      }
    }
    let count = 0;
    for await (
      const row of iterate<{
        x: number;
        y: number;
      }>(db, prefix)
    ) {
      const { x, y } = row.value,
        bounds: Rect = {
          x: rect.x + x * sheetWidth,
          y: rect.y + y * sheetHeight,
          width: Math.min(sheetWidth + overlap, rect.width - x * sheetWidth),
          height: Math.min(sheetHeight + overlap, rect.height - y * sheetHeight),
        };
      if (bounds.width < 1 || bounds.height < 1) {
        await db.delete(row.key);
        continue;
      }
      await zip.add(`sheet_${x}_${y}.png`, encodePNG(bounds.width, bounds.height, rasterRows(tiles, meta.id, bounds)));
      await zip.add(`sheet_${x}_${y}.json`, utf8(JSON.stringify(bounds)));
      await db.delete(row.key);
      onProgress(`已编码 ${++count} 张原尺寸分页图片`, 0);
    }
    await zip.add(
      'manifest.json',
      utf8(
        JSON.stringify(
          {
            canvas: meta,
            tileSize: tiles.size,
            sheetWidth,
            sheetHeight,
            overlap,
            notice:
              'No resizing. Only sheets intersecting observed tiles are emitted. Per-sheet JSON contains native world coordinates. Overlap is intentional; do not append sheets without removing overlap.',
          },
          null,
          2,
        ),
      ),
    );
    await zip.finish();
    return {
      ...await target.result(),
      // 'sheets' is an explicit choice (it always pages, even when the canvas would fit one PNG under 'auto'),
      // so its message must not claim the canvas "exceeded" anything; 'auto' falling into this branch really
      // did exceed the compatible single-image size.
      message: layout === 'sheets'
        ? `已按分页导出为 ${count} 张原尺寸图片；相邻页最多重叠 ${overlap}px，坐标见 manifest。`
        : `画布超过单张兼容尺寸，已明确改为 ${count} 张原尺寸图片；相邻页最多重叠 ${overlap}px，坐标见 manifest。`,
    };
  } catch (error) {
    await target.sink.abort?.(error);
    // A failed export must stop the ZIP writer's still-running internal pump (never write into an aborted sink)
    // and must not leave this function's own sheet-export/<uuid>/ work queue behind.
    await zip?.dispose();
    if (sheetPrefix) await deletePrefix(db, sheetPrefix);
    throw error;
  } finally {
    await tiles.clear();
  }
}
