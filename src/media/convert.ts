import type { MediaInfo, RGBA } from '../types.ts';
import { core } from '../core/wasm.ts';
import { copyFrameToRGBA, RGBA_COPY_OPTIONS } from './rgba-copy.ts';
import { BufferPool, type PooledRGBA } from './pool.ts';
/** Converts one decoded VideoFrame into plain RGBA (applying container rotation). Injected so the decoding pipeline is testable without a canvas. */
export type FrameConverter = ((frame: VideoFrame, info: MediaInfo) => RGBA | Promise<RGBA>) & {
  /** Conversions run off the calling thread, so the source may start the next decoded frame's early. */
  prefetch?: boolean;
  dispose?(): void;
  /** Which conversion this converter has settled on so far, for diagnostics. */
  describe?(): string;
};
/** Worst case for one conversion before the worker is written off (the frame then converts in-thread). */
const WORKER_CONVERSION_TIMEOUT = 10000;
export function canvasConverter(): FrameConverter {
  let canvas: OffscreenCanvas | undefined, ctx: OffscreenCanvasRenderingContext2D | null = null;
  const convert = (frame: VideoFrame, info: MediaInfo): RGBA => {
    if (!canvas || canvas.width !== info.width || canvas.height !== info.height) {
      canvas = new OffscreenCanvas(info.width, info.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('A 2D offscreen canvas could not be allocated for frame conversion.');
      }
    }
    const c = ctx!;
    c.save();
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.translate(canvas.width / 2, canvas.height / 2);
    c.rotate(info.rotation * Math.PI / 180);
    c.drawImage(frame, -info.codedWidth / 2, -info.codedHeight / 2, info.codedWidth, info.codedHeight);
    c.restore();
    return { width: canvas.width, height: canvas.height, data: c.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  return Object.assign(convert, { describe: () => '2D canvas drawImage + getImageData' });
}
/** Direct `VideoFrame.copyTo({ format: 'RGBA' })`: the browser converts YUV→sRGB into a plain buffer, skipping the
 *  2D-canvas draw + `getImageData` readback that dominated decode-side CPU time. Capability is probed once on the
 *  first frame (Safari/Chrome versions differ in RGB conversion support); a throwing or wrong-sized probe falls back
 *  to the canvas path permanently for this source. Rotated containers always use the canvas, which already rotates. */
export function directConverter(fallback: FrameConverter = planarConverter()): FrameConverter {
  let direct: boolean | undefined;
  const pool = new BufferPool();
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    if (info.rotation !== 0 || direct === false || typeof frame.copyTo !== 'function') {
      return fallback(frame, info);
    }
    const width = info.codedWidth, height = info.codedHeight;
    let image: PooledRGBA | undefined;
    try {
      if (direct === undefined) {
        // Probe: a browser that ignores `format` reports the native (e.g. I420) size instead, and a frame with a
        // null format throws. Both mean "no direct path", not "corrupt frame".
        const size = frame.allocationSize(RGBA_COPY_OPTIONS);
        if (size !== width * height * 4) throw new Error(`allocationSize ${size} ≠ ${width * height * 4}`);
      }
      image = pool.take(width, height);
      await copyFrameToRGBA(frame, width, height, image.data);
      direct = true;
      return image;
    } catch (error) {
      // Handed to nobody: this attempt's buffer must go back to the pool itself, not leak as "outstanding" forever.
      image?.release();
      if (direct === true) throw error;
      direct = false;
      return fallback(frame, info);
    }
  };
  return Object.assign(convert, {
    describe: () => direct ? 'copyTo(RGBA)' : direct === false ? fallback.describe?.() ?? 'fallback' : 'undecided',
  });
}
/** Codes of rust/core/src/yuv.rs `Format::from_code`. */
const FRAME_FORMATS: Record<string, number> = { I420: 0, I422: 1, I444: 2, NV12: 3 };
/** Index into rust/core/src/yuv.rs `MATRICES`, or undefined for BT.2020 (its gamut conversion to sRGB is left to
 *  the canvas) or for GBR/RGB-native planes (there is no YUV matrix to invert at all — a 4:4:4 stream whose colour
 *  space reports `matrix: 'rgb'`, or, measured on VP9 Profile 1's GBR planes decoded by Chrome, an I444 frame whose
 *  `VideoFrame.colorSpace.matrix` comes back `null`; declined here rather than left to the first-frame agreement
 *  check, which a genuinely close-but-wrong YUV-math conversion of RGB planes is not guaranteed to fail loudly
 *  enough to catch). A null/absent matrix on any *other* layout (I420/I422/NV12) is a real, ordinary untagged YUV
 *  stream — most H.264 recordings never tag one at all — and is still taken as BT.709 when HD and BT.601 otherwise. */
function matrixCode(colorSpace: VideoColorSpace | undefined, format: string | undefined, height: number): number | undefined {
  if (colorSpace && ((colorSpace.matrix as string) === 'rgb' || (colorSpace.matrix === null && format === 'I444'))) {
    return undefined;
  }
  const matrix: string = colorSpace?.matrix ?? (height >= 720 ? 'bt709' : 'smpte170m');
  if (matrix === 'bt2020-ncl' || matrix === 'bt2020-cl') return undefined;
  return (matrix === 'bt709' ? 0 : 2) + (colorSpace?.fullRange ? 1 : 0);
}
/** How far the first planar frame may be from the same frame through the canvas: both are conversions of one
 *  decoded surface, differing by rounding, chroma filtering and (on Safari) colour management — a few levels on
 *  average. A misplaced plane is tens of levels off (WebKit's GStreamer copyTo was measured at a mean of 67 on a
 *  cropped H.264 frame). */
const PLANAR_MAX_MEAN = 8, PLANAR_FAR = 48, PLANAR_MAX_FAR_SHARE = 0.01;
export interface PlanarCheck {
  meanDiff: number;
  farShare: number;
}
function agreement(a: Uint8ClampedArray, b: Uint8ClampedArray): PlanarCheck {
  let sum = 0, far = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      if (d > PLANAR_FAR) far++;
      n++;
    }
  }
  return { meanDiff: sum / n, farShare: far / n };
}
/** `VideoFrame.copyTo` in the frame's own YUV layout (I420, I422, I444, NV12) plus the core's conversion to RGBA — libyuv's
 *  integer math, which is what Chrome's `copyTo({ format: 'RGBA' })` computes for a software-decoded frame — for
 *  browsers whose copyTo cannot convert to RGB (Safari through at least 27). It replaces a 2D-canvas drawImage +
 *  getImageData readback per frame, which is slower and on Safari routes every frame through a GPU-process
 *  conversion. The first frame is also converted by `fallback` and the planar path is only taken for the run when
 *  the two agree (a browser's native-layout copyTo can misplace planes); the choice is made before any frame is
 *  returned and never changes afterwards, so a run never mixes two conversions. Rotated containers keep the canvas. */
export function planarConverter(
  fallback: FrameConverter = canvasConverter(),
): FrameConverter & { readonly planar?: boolean; readonly check?: PlanarCheck } {
  // One reused buffer for the planes; a conversion that starts while another is still copying (a prefetched frame
  // the source then skipped) gets its own, so two copies never land in the same bytes.
  let scratch: ArrayBuffer | undefined, busy = false, planar: boolean | undefined, check: PlanarCheck | undefined;
  const pool = new BufferPool();
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    const format = frame.format ? FRAME_FORMATS[frame.format] : undefined, width = info.codedWidth, height = info.codedHeight;
    const matrix = matrixCode(frame.colorSpace ?? undefined, frame.format ?? undefined, height);
    if (planar === false || info.rotation !== 0 || format === undefined || matrix === undefined || typeof frame.copyTo !== 'function') {
      if (planar) throw new Error(`planar conversion cannot take a ${frame.format} frame after taking earlier ones`);
      planar = false;
      return fallback(frame, info);
    }
    const own = !busy;
    let image: PooledRGBA | undefined;
    try {
      const rect = frame.visibleRect;
      if (rect && (rect.width !== width || rect.height !== height)) {
        throw new Error(`visible ${rect.width}×${rect.height} ≠ ${width}×${height}`);
      }
      const size = frame.allocationSize();
      if (own && (!scratch || scratch.byteLength < size)) scratch = new ArrayBuffer(size);
      busy = true;
      const planes = own ? new Uint8Array(scratch!, 0, size) : new Uint8Array(size), layout = await frame.copyTo(planes);
      image = pool.take(width, height);
      core().frameToRGBA(planes, format, layout, width, height, matrix, image.data);
    } catch (error) {
      image?.release();
      if (planar) throw error;
      planar = false;
      return fallback(frame, info);
    } finally {
      if (own) busy = false;
    }
    if (planar === undefined) {
      const reference = await fallback(frame, info);
      check = agreement(reference.data, image.data);
      planar = check.meanDiff <= PLANAR_MAX_MEAN && check.farShare <= PLANAR_MAX_FAR_SHARE;
      if (!planar) {
        image.release();
        return reference;
      }
    }
    return image;
  };
  const describe = () =>
    planar
      ? `planar copyTo + core YUV→RGBA (first frame ${check!.meanDiff.toFixed(2)} from canvas)`
      : planar === false
      ? `${fallback.describe?.() ?? 'fallback'}${check ? ` (planar rejected: ${check.meanDiff.toFixed(1)} from canvas)` : ''}`
      : 'undecided';
  return Object.defineProperties(Object.assign(convert, { describe }), { planar: { get: () => planar }, check: { get: () => check } });
}
/** Frames converted per path by a `workerConverter`, and why the worker path was abandoned, if it was. */
export interface WorkerConversionCounts {
  worker: number;
  inThread: number;
  reason?: string;
}
/** `copyTo({ format: 'RGBA' })` in a dedicated worker (src/media/convert-worker.ts): the same browser conversion as
 *  `directConverter`, so the same pixels, but off the pipeline thread, which lets PreciseSource convert the next
 *  decoded frame while the pipeline works on the current one. Frames the worker cannot take (rotated containers, no
 *  RGBA copy, a size the run does not expect) and every worker failure (no Worker, a frame that cannot be
 *  transferred, a failed or timed-out conversion) convert in-thread instead, and a failure retires the worker for
 *  this source. Until the worker has produced a frame the in-thread path is `fallback` (which may choose the canvas);
 *  afterwards it is the plain in-thread `copyTo`, never the canvas, so one run never mixes two YUV→RGB conversions. */
export function workerConverter(
  url: URL,
  fallback: FrameConverter = directConverter(),
): FrameConverter & { counts: WorkerConversionCounts } {
  const counts: WorkerConversionCounts = { worker: 0, inThread: 0 };
  const waiting = new Map<number, { resolve(buffer: ArrayBuffer): void; reject(error: Error): void }>();
  // In-thread fallback frames (the worker unavailable or not yet proven) get their own pool; the worker's own
  // reply buffers are pooled on ITS side (convert-worker.ts) and returned there by `release()` below — the two
  // never share a free list, so a buffer belonging to one side is never handed to the other's `postMessage`.
  const pool = new BufferPool();
  let worker: Worker | undefined, retired = typeof Worker === 'undefined', succeeded = false, sequence = 0;
  if (retired) counts.reason = 'Worker unavailable';
  const retire = (reason: string) => {
    if (!retired) counts.reason = reason;
    retired = true;
    worker?.terminate();
    worker = undefined;
    for (const pending of waiting.values()) pending.reject(new Error(reason));
    waiting.clear();
  };
  const inThread = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    counts.inThread++;
    if (!succeeded) return fallback(frame, info);
    const width = info.codedWidth, height = info.codedHeight, image = pool.take(width, height);
    try {
      await copyFrameToRGBA(frame, width, height, image.data);
      return image;
    } catch (error) {
      image.release();
      throw error;
    }
  };
  const takes = (frame: VideoFrame, info: MediaInfo): boolean => {
    if (retired || info.rotation !== 0 || typeof frame.copyTo !== 'function' || typeof frame.clone !== 'function') return false;
    try {
      return frame.allocationSize(RGBA_COPY_OPTIONS) === info.codedWidth * info.codedHeight * 4;
    } catch {
      return false;
    }
  };
  const start = (): Worker | undefined => {
    try {
      const w = new Worker(url, { type: 'module' });
      w.onmessage = ({ data }: MessageEvent<{ id: number; buffer?: ArrayBuffer; error?: string }>) => {
        const pending = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.buffer) pending?.resolve(data.buffer);
        else pending?.reject(new Error(data.error || 'no pixels'));
      };
      w.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        retire(`conversion worker failed: ${event.message || 'script error'}`);
      };
      w.onmessageerror = () => retire('conversion worker reply could not be deserialized');
      return w;
    } catch (error) {
      retire(`conversion worker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    if (!takes(frame, info)) return inThread(frame, info);
    const target = worker ??= start();
    if (!target) return inThread(frame, info);
    const width = info.codedWidth, height = info.codedHeight, id = sequence++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<ArrayBuffer>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      timer = setTimeout(() => retire('conversion worker timed out'), WORKER_CONVERSION_TIMEOUT);
    });
    // The worker gets its own reference; `frame` stays open here so a failed attempt can still convert in-thread.
    const clone = frame.clone();
    try {
      target.postMessage({ id, frame: clone, width, height }, [clone as unknown as Transferable]);
    } catch (error) {
      clearTimeout(timer);
      clone.close();
      waiting.delete(id);
      retire(`VideoFrame could not be transferred: ${error instanceof Error ? error.message : String(error)}`);
      return inThread(frame, info);
    }
    try {
      const buffer = await reply;
      if (buffer.byteLength !== width * height * 4) throw new Error(`conversion worker returned ${buffer.byteLength} bytes`);
      succeeded = true;
      counts.worker++;
      let released = false;
      // Released back across the postMessage boundary (transferred, not copied) so the worker's own pool
      // (convert-worker.ts) can reuse it for the next frame instead of allocating a fresh 30 MB buffer.
      const release = () => {
        if (released) return;
        released = true;
        try {
          target.postMessage({ release: buffer }, [buffer]);
        } catch {
          // The worker was retired (terminated) between this frame converting and its release; nothing to give
          // the buffer back to, and nothing to leak either — it is just GC'd like any other detached buffer.
        }
      };
      return Object.assign({ width, height, data: new Uint8ClampedArray(buffer) }, { release });
    } catch (error) {
      retire(error instanceof Error ? error.message : String(error));
      return inThread(frame, info);
    } finally {
      clearTimeout(timer);
    }
  };
  const describe = () =>
    counts.worker
      ? `copyTo(RGBA) in a worker (${counts.worker} frames, ${counts.inThread} in-thread)`
      : fallback.describe?.() ?? 'fallback';
  return Object.assign(convert, { prefetch: true, counts, describe, dispose: () => retire('disposed') });
}
