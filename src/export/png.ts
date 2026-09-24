import type { TileStore } from '../storage/tiles.ts';
import type { Rect } from '../types.ts';
/** Streams native-resolution rows out of disk tiles; unobserved pixels stay transparent. */
export async function* rasterRows(
  tiles: TileStore,
  canvasId: string,
  rect: Rect,
  onProgress?: (row: number) => void,
): AsyncGenerator<Uint8Array> {
  const size = tiles.size, width = Math.ceil(rect.width), height = Math.ceil(rect.height), x0 = Math.floor(rect.x), y0 = Math.floor(rect.y);
  for (let row = 0; row < height; row++) {
    const rgba = new Uint8Array(width * 4), worldY = y0 + row, ty = Math.floor(worldY / size), localY = worldY - ty * size;
    for (let x = 0; x < width;) {
      const worldX = x0 + x, tx = Math.floor(worldX / size), localX = worldX - tx * size, length = Math.min(size - localX, width - x);
      const t = await tiles.get(canvasId, tx, ty);
      rgba.set(t.pixels.subarray((localY * size + localX) * 4, (localY * size + localX + length) * 4), x * 4);
      x += length;
    }
    if (row % 64 === 0) {
      onProgress?.(row);
    }
    yield rgba;
  }
}
