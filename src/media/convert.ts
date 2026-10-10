import type { FramePlanes, MediaInfo, RGBA, Settings } from '../types.ts';
import { core } from '../core/wasm.ts';
import { copyFrameToRGBA, RGBA_COPY_OPTIONS } from './rgba-copy.ts';
import { BufferPool, type PooledRGBA } from './pool.ts';
import { agreement, agrees, matrixCode, type PlanarCheck } from './conversion-check.ts';
export { agreement, agrees, matrixCode, type PlanarCheck };
/** Converts one decoded VideoFrame into plain RGBA (applying container rotation). Injected so the decoding pipeline is testable without a canvas. */
export type FrameConverter = ((frame: VideoFrame, info: MediaInfo) => RGBA | Promise<RGBA>) & {
  /** Conversions run off the calling thread, so the source may start the next decoded frames' early: `true` for the
   *  source's default depth, or how many frames ahead. */
  prefetch?: boolean | number;
  dispose?(): void;
  /** Which conversion this converter has settled on so far, for diagnostics. */
  describe?(): string;
  /** This frame's YUV planes, once the converter has settled on converting planes in the core (`planarConverter`):
   *  a caller can then run that same core conversion straight into core memory. Undefined while undecided, on any
   *  other conversion, and for a frame the planar path would not take. */
  planes?(frame: VideoFrame, info: MediaInfo): Promise<FramePlanes | undefined>;
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
    planes: async (frame: VideoFrame, info: MediaInfo) => direct === false ? await fallback.planes?.(frame, info) : undefined,
  });
}
/** Codes of rust/core/src/yuv.rs `Format::from_code`. */
const FRAME_FORMATS: Record<string, number> = { I420: 0, I422: 1, I444: 2, NV12: 3 };
/** `VideoFrame.copyTo` in the frame's own YUV layout (I420, I422, I444, NV12) plus the core's conversion to RGBA — libyuv's
 *  integer math, which is what Chrome's `copyTo({ format: 'RGBA' })` computes for a software-decoded frame — for
 *  browsers whose copyTo cannot convert to RGB (Safari through at least 27). It replaces a 2D-canvas drawImage +
 *  getImageData readback per frame, which is slower and on Safari routes every frame through a GPU-process
 *  conversion. The first frame is also converted by `fallback` and the planar path is only taken for the run when
 *  the two agree (a browser's native-layout copyTo can misplace planes); the choice is made before any frame is
 *  returned and never changes afterwards, so a run never mixes two conversions. Rotated containers keep the canvas. */
/** What converting a frame's planes in the core needs: the core's format and matrix codes and the frame size. */
export type PlaneSpec = Pick<FramePlanes, 'format' | 'matrix' | 'width' | 'height'>;
export type PlanarConverter = FrameConverter & {
  readonly planar?: boolean;
  readonly check?: PlanarCheck;
  /** This frame's `PlaneSpec` once the run has settled on the planar path; undefined while undecided, after the
   *  path was rejected, and for a frame `convert` would refuse. */
  spec(frame: VideoFrame, info: MediaInfo): PlaneSpec | undefined;
  /** RGBA of planes copied elsewhere (a worker), converted exactly as `convert` converts its own copy. */
  fromPlanes(planes: FramePlanes): RGBA;
};
export function planarConverter(
  fallback: FrameConverter = canvasConverter(),
): PlanarConverter {
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
      planar = agrees(check);
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
  const spec = (frame: VideoFrame, info: MediaInfo): PlaneSpec | undefined => {
    const format = frame.format ? FRAME_FORMATS[frame.format] : undefined, width = info.codedWidth, height = info.codedHeight;
    const matrix = matrixCode(frame.colorSpace ?? undefined, frame.format ?? undefined, height);
    const rect = frame.visibleRect;
    if (planar !== true || info.rotation !== 0 || format === undefined || matrix === undefined) return undefined;
    if (typeof frame.copyTo !== 'function' || (rect && (rect.width !== width || rect.height !== height))) return undefined;
    return { format, matrix, width, height };
  };
  const fromPlanes = (p: FramePlanes): RGBA => {
    const image = pool.take(p.width, p.height);
    core().frameToRGBA(p.data, p.format, p.layout, p.width, p.height, p.matrix, image.data);
    return image;
  };
  // The planes `convert` would convert, for a caller that runs the same core conversion into core memory itself. A
  // frame `convert` would refuse comes back undefined, so the caller's `convert` call reports it the same way.
  const planesPool = new BufferPool();
  const planes = async (frame: VideoFrame, info: MediaInfo): Promise<FramePlanes | undefined> => {
    const own = spec(frame, info);
    if (!own) return undefined;
    const buffer = planesPool.takeBuffer(frame.allocationSize());
    try {
      const data = new Uint8Array(buffer), layout = await frame.copyTo(data);
      return { data, layout, ...own, release: () => planesPool.releaseBuffer(buffer) };
    } catch {
      planesPool.releaseBuffer(buffer);
      return undefined;
    }
  };
  return Object.defineProperties(Object.assign(convert, { describe, planes, spec, fromPlanes }), {
    planar: { get: () => planar },
    check: { get: () => check },
  }) as PlanarConverter;
}
/** Frames converted per path by a `workerConverter`, and why the worker path was abandoned, if it was. */
export interface WorkerConversionCounts {
  worker: number;
  inThread: number;
  /** Conversion workers started. More than one only once the first has settled on `copyTo(RGBA)`: the same browser
   *  call in every worker, so the same pixels, with conversions that no longer queue behind each other. */
  workers: number;
  /** Frames whose planes a worker copied for the planar path (Safari). */
  planes: number;
  reason?: string;
}
/** Conversion workers a CPU-converting run may use: Firefox's copyTo(RGBA) of a retina frame takes ~16 ms, so one
 *  worker is what the light reveal passes wait for. Bounded by the cores, and by PREFETCH + 1 conversions in flight. */
const maxWorkers = () =>
  Math.max(
    1,
    Math.min(3, Math.floor(((globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency || 4) / 4)),
  );
/** `copyTo({ format: 'RGBA' })` in a dedicated worker (src/media/convert-worker.ts): the same browser conversion as
 *  `directConverter`, so the same pixels, but off the pipeline thread, which lets PreciseSource convert the next
 *  decoded frame while the pipeline works on the current one. Frames the worker cannot take (rotated containers, no
 *  RGBA copy, a size the run does not expect) and every worker failure (no Worker, a frame that cannot be
 *  transferred, a failed or timed-out conversion) convert in-thread instead, and a failure retires the worker for
 *  this source. Until the worker has produced a frame the in-thread path is `fallback` (which may choose the canvas);
 *  afterwards it is the plain in-thread `copyTo`, never the canvas, so one run never mixes two YUV→RGB conversions.
 *
 *  In a browser whose copyTo cannot produce RGBA (Safari), `fallback` settles on `planar`; from then on the worker
 *  copies each frame's own planes (a synchronous copy that otherwise blocks the pipeline thread) and `planar` converts
 *  them here, exactly as it converts its own copy. */
export function workerConverter(
  url: URL,
  fallback: FrameConverter = directConverter(),
  /** The acceleration setting: whether the worker may convert on the GPU (src/media/gpu-convert.ts). */
  compute: Settings['compute'] = 'auto',
  /** The planar converter inside `fallback`, when there is one (`frameConverter`). */
  planar?: PlanarConverter,
): FrameConverter & { counts: WorkerConversionCounts } {
  const counts: WorkerConversionCounts = { worker: 0, inThread: 0, workers: 0, planes: 0 };
  type Reply = { buffer: ArrayBuffer; layout?: { offset: number; stride: number }[] };
  const waiting = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  // In-thread fallback frames (the worker unavailable or not yet proven) get their own pool; the worker's own
  // reply buffers are pooled on ITS side (convert-worker.ts) and returned there by `release()` below — the two
  // never share a free list, so a buffer belonging to one side is never handed to the other's `postMessage`.
  const pool = new BufferPool();
  // `workers[0]` decides the conversion; the others are started with the CPU setting only after it chose copyTo, so a
  // run never mixes GPU and CPU frames. `inFlight` sends each frame to the least busy worker.
  const workers: Worker[] = [], inFlight = new Map<Worker, number>();
  let retired = typeof Worker === 'undefined', succeeded = false, cpu = false, sequence = 0, method = 'copyTo(RGBA)';
  if (retired) counts.reason = 'Worker unavailable';
  const retire = (reason: string) => {
    if (!retired) counts.reason = reason;
    retired = true;
    for (const w of workers.splice(0)) w.terminate();
    inFlight.clear();
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
      const w = new Worker(url, { type: 'module' }), first = !workers.length;
      w.onmessage = ({ data }: MessageEvent<{ id: number; error?: string; describe?: string } & Partial<Reply>>) => {
        const pending = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.describe && first) {
          method = data.describe;
          cpu = !method.startsWith('WebGPU');
        }
        if (data.buffer) pending?.resolve({ buffer: data.buffer, layout: data.layout });
        else pending?.reject(new Error(data.error || 'no pixels'));
      };
      w.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        retire(`conversion worker failed: ${event.message || 'script error'}`);
      };
      w.onmessageerror = () => retire('conversion worker reply could not be deserialized');
      workers.push(w);
      inFlight.set(w, 0);
      counts.workers = workers.length;
      return w;
    } catch (error) {
      retire(`conversion worker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const pick = (): Worker | undefined => {
    if (!workers.length) return start();
    const idle = workers.reduce((a, b) => inFlight.get(a)! <= inFlight.get(b)! ? a : b);
    return inFlight.get(idle)! > 0 && cpu && workers.length < maxWorkers() ? start() ?? idle : idle;
  };
  /** Sends a clone of `frame` to a worker and waits for its reply: RGBA, or with `planes` the frame's own planes.
   *  Throws on any failure; the caller retires the workers and converts in-thread. */
  const request = async (frame: VideoFrame, info: MediaInfo, planes: boolean): Promise<Reply & { target: Worker }> => {
    const target = pick();
    if (!target) throw new Error(counts.reason ?? 'conversion worker unavailable');
    const width = info.codedWidth, height = info.codedHeight, id = sequence++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Reply>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      timer = setTimeout(() => retire('conversion worker timed out'), WORKER_CONVERSION_TIMEOUT);
    });
    // The worker gets its own reference; `frame` stays open here so a failed attempt can still convert in-thread.
    const clone = frame.clone();
    try {
      // A worker after the first converts the way the first settled on: copyTo, never trying the GPU itself.
      target.postMessage({ id, frame: clone, width, height, planes, compute: target === workers[0] ? compute : 'cpu' }, [
        clone as unknown as Transferable,
      ]);
    } catch (error) {
      clearTimeout(timer);
      clone.close();
      waiting.delete(id);
      throw new Error(`VideoFrame could not be transferred: ${error instanceof Error ? error.message : String(error)}`);
    }
    inFlight.set(target, (inFlight.get(target) ?? 0) + 1);
    try {
      return { ...await reply, target };
    } finally {
      clearTimeout(timer);
      if (inFlight.has(target)) inFlight.set(target, inFlight.get(target)! - 1);
    }
  };
  /** Gives a reply buffer back to the worker that lent it (transferred, not copied), so its pool reuses it. */
  const lender = (target: Worker, buffer: ArrayBuffer, planes: boolean) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        target.postMessage({ release: buffer, planes }, [buffer]);
      } catch {
        // The worker was retired (terminated) between this frame converting and its release; nothing to give
        // the buffer back to, and nothing to leak either — it is just GC'd like any other detached buffer.
      }
    };
  };
  /** This frame's planes copied in a worker, once `planar` has settled; undefined otherwise or when the worker fails. */
  const workerPlanes = async (frame: VideoFrame, info: MediaInfo): Promise<FramePlanes | undefined> => {
    const spec = retired || typeof frame.clone !== 'function' ? undefined : planar?.spec(frame, info);
    if (!spec) return undefined;
    try {
      const { buffer, layout, target } = await request(frame, info, true);
      if (!layout) throw new Error('conversion worker returned planes without their layout');
      counts.planes++;
      return { data: new Uint8Array(buffer), layout, ...spec, release: lender(target, buffer, true) };
    } catch (error) {
      retire(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    if (!takes(frame, info)) {
      const planes = await workerPlanes(frame, info);
      if (!planes) return inThread(frame, info);
      try {
        return planar!.fromPlanes(planes);
      } finally {
        planes.release();
      }
    }
    const width = info.codedWidth, height = info.codedHeight;
    try {
      const { buffer, target } = await request(frame, info, false);
      if (buffer.byteLength !== width * height * 4) throw new Error(`conversion worker returned ${buffer.byteLength} bytes`);
      succeeded = true;
      counts.worker++;
      return Object.assign({ width, height, data: new Uint8ClampedArray(buffer) }, { release: lender(target, buffer, false) });
    } catch (error) {
      retire(error instanceof Error ? error.message : String(error));
      return inThread(frame, info);
    }
  };
  const describe = () =>
    counts.worker
      ? `${method} in ${
        counts.workers > 1 ? `${counts.workers} workers` : 'a worker'
      } (${counts.worker} frames, ${counts.inThread} in-thread)`
      : `${fallback.describe?.() ?? 'fallback'}${counts.planes ? ` (planes copied in a worker: ${counts.planes} frames)` : ''}`;
  // Planes only where this frame would convert in-thread through `fallback` (never once the worker has converted).
  const planes = async (frame: VideoFrame, info: MediaInfo) =>
    succeeded || takes(frame, info) ? undefined : await workerPlanes(frame, info) ?? await fallback.planes?.(frame, info);
  return Object.defineProperties(Object.assign(convert, { counts, describe, planes, dispose: () => retire('disposed') }), {
    // One frame ahead per worker a CPU run may use, so they all have work; the default depth otherwise.
    prefetch: { get: () => cpu ? Math.max(2, maxWorkers()) : true },
  }) as FrameConverter & { counts: WorkerConversionCounts };
}
