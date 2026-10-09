/** Frame conversion worker for `workerConverter` (src/media/convert.ts): converts a transferred frame and transfers
 *  the RGBA buffer back, so the pipeline thread works on the previous frame meanwhile. The conversion is WebGPU's
 *  (src/media/gpu-convert.ts) when its first frame agrees with `VideoFrame.copyTo({ format: 'RGBA' })` and is faster,
 *  otherwise that same copyTo the in-thread converter runs — decided here, on this thread, where it runs. Bundled on
 *  its own (scripts/build.ts's `entries`), so this must stay dependency-free — no src/core/wasm.ts.
 *
 *  Buffer pool: the same explicit-release discipline as the main-thread pool (src/media/pool.ts), just split
 *  across the postMessage boundary. `workerConverter` transfers a released reply buffer back here (a `release`
 *  message) instead of letting it get GC'd on the main thread, so the NEXT conversion can reuse it instead of
 *  allocating a fresh 30 MB buffer — the worker path would otherwise re-pay the fresh-allocation cost this whole
 *  pool exists to avoid. A `release` for a buffer whose size no longer matches (a geometry change) is simply
 *  dropped by `BufferPool.releaseBuffer`, not kept as a wrongly-sized spare. */
import type { MediaInfo, RGBA, Settings } from '../types.ts';
import { copyFrameToRGBA } from './rgba-copy.ts';
import { BufferPool } from './pool.ts';
import { gpuConverter } from './gpu-convert.ts';
interface ConvertRequest {
  id: number;
  frame: VideoFrame;
  width: number;
  height: number;
  compute?: Settings['compute'];
}
interface ReleaseMessage {
  release: ArrayBuffer;
}
const pool = new BufferPool();
/** copyTo(RGBA) into this worker's pool, the GPU converter's fallback. */
const copyTo = Object.assign(async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
  const width = info.codedWidth, height = info.codedHeight, buffer = pool.takeBuffer(width * height * 4);
  try {
    return Object.assign({ width, height, data: await copyFrameToRGBA(frame, width, height, new Uint8ClampedArray(buffer)) }, {
      release: () => pool.releaseBuffer(buffer),
    });
  } catch (error) {
    pool.releaseBuffer(buffer);
    throw error;
  }
}, { describe: () => 'copyTo(RGBA)' });
let convert: ReturnType<typeof gpuConverter> | undefined;
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<ConvertRequest | ReleaseMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = async ({ data }) => {
  if ('release' in data) {
    pool.releaseBuffer(data.release);
    return;
  }
  const { id, frame, width, height } = data;
  convert ??= gpuConverter(copyTo, data.compute, undefined, pool);
  try {
    // Every buffer here comes from `pool` (both conversions take from it), and the main thread transfers it back
    // with a `release` message once its holder lets go.
    const out = await convert(frame, { codedWidth: width, codedHeight: height, width, height, rotation: 0 } as MediaInfo);
    scope.postMessage({ id, buffer: out.data.buffer, describe: convert.describe?.() }, [out.data.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    frame.close();
  }
};
