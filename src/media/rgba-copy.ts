/** `VideoFrame.copyTo({ format: 'RGBA' })` options and the resulting layout check, shared by every converter that
 *  takes this path (src/media/convert.ts's `directConverter`/`workerConverter`, src/media/convert-worker.ts). Kept
 *  dependency-free — convert-worker.ts is bundled on its own and must not pull in src/core/wasm.ts. */
export const RGBA_COPY_OPTIONS = { format: 'RGBA' as VideoPixelFormat, colorSpace: 'srgb' as PredefinedColorSpace };
/** `frame.copyTo(data, RGBA_COPY_OPTIONS)` plus the one layout every caller here requires: a single contiguous
 *  plane, tightly packed rows. Throws if the browser's copyTo produced anything else. */
export async function copyFrameToRGBA(frame: VideoFrame, width: number, height: number): Promise<Uint8ClampedArray> {
  const data = new Uint8ClampedArray(width * height * 4);
  const layout = await frame.copyTo(data, RGBA_COPY_OPTIONS);
  if (layout.length !== 1 || layout[0].offset !== 0 || layout[0].stride !== width * 4) {
    throw new Error(`unexpected RGBA layout ${JSON.stringify(layout)}`);
  }
  return data;
}
