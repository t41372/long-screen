/** Frame conversion worker for `workerConverter` (src/media/source.ts): runs the same `VideoFrame.copyTo({ format:
 *  'RGBA' })` the in-thread converter runs, on a transferred frame, and transfers the RGBA buffer back. Converting
 *  here lets the pipeline thread work on the previous frame meanwhile; the pixels are the browser's either way. */
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
    const data = new Uint8ClampedArray(width * height * 4);
    const layout = await frame.copyTo(data, { format: 'RGBA' as VideoPixelFormat, colorSpace: 'srgb' as PredefinedColorSpace });
    if (layout.length !== 1 || layout[0].offset !== 0 || layout[0].stride !== width * 4) {
      throw new Error(`unexpected RGBA layout ${JSON.stringify(layout)}`);
    }
    scope.postMessage({ id, buffer: data.buffer }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    frame.close();
  }
};
