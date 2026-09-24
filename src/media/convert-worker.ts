/** Frame conversion worker for `workerConverter` (src/media/convert.ts): runs the same `VideoFrame.copyTo({ format:
 *  'RGBA' })` the in-thread converter runs, on a transferred frame, and transfers the RGBA buffer back. Converting
 *  here lets the pipeline thread work on the previous frame meanwhile; the pixels are the browser's either way.
 *  Bundled on its own (scripts/build.ts's `entries`), so this must stay dependency-free — no src/core/wasm.ts.
 *
 *  Buffer pool: the same explicit-release discipline as the main-thread pool (src/media/pool.ts), just split
 *  across the postMessage boundary. `workerConverter` transfers a released reply buffer back here (a `release`
 *  message) instead of letting it get GC'd on the main thread, so the NEXT conversion can reuse it instead of
 *  allocating a fresh 30 MB buffer — the worker path would otherwise re-pay the fresh-allocation cost this whole
 *  pool exists to avoid. A `release` for a buffer whose size no longer matches (a geometry change) is simply
 *  dropped by `BufferPool.releaseBuffer`, not kept as a wrongly-sized spare. */
import { copyFrameToRGBA } from './rgba-copy.ts';
import { BufferPool } from './pool.ts';
interface ConvertRequest {
  id: number;
  frame: VideoFrame;
  width: number;
  height: number;
}
interface ReleaseMessage {
  release: ArrayBuffer;
}
const pool = new BufferPool();
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
  const buffer = pool.takeBuffer(width * height * 4);
  try {
    const out = await copyFrameToRGBA(frame, width, height, new Uint8ClampedArray(buffer));
    scope.postMessage({ id, buffer: out.buffer }, [out.buffer]);
  } catch (error) {
    // The pooled buffer was never handed back to the caller, so it would otherwise leak from this pool forever.
    pool.releaseBuffer(buffer);
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    frame.close();
  }
};
