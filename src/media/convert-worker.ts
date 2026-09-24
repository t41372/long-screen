/** Frame conversion worker for `workerConverter` (src/media/convert.ts): runs the same `VideoFrame.copyTo({ format:
 *  'RGBA' })` the in-thread converter runs, on a transferred frame, and transfers the RGBA buffer back. Converting
 *  here lets the pipeline thread work on the previous frame meanwhile; the pixels are the browser's either way.
 *  Bundled on its own (scripts/build.ts's `entries`), so this must stay dependency-free — no src/core/wasm.ts. */
import { copyFrameToRGBA } from './rgba-copy.ts';
interface ConvertRequest {
  id: number;
  frame: VideoFrame;
  width: number;
  height: number;
}
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<ConvertRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = async ({ data: { id, frame, width, height } }) => {
  try {
    const data = await copyFrameToRGBA(frame, width, height);
    scope.postMessage({ id, buffer: data.buffer }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    frame.close();
  }
};
