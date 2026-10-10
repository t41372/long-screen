import type { ConversionReport, FramePlanes, MediaInfo, RGBA, Settings } from '../types.ts';
import { core } from '../core/wasm.ts';
import { copyFrameToRGBA, RGBA_COPY_OPTIONS } from './rgba-copy.ts';
import { BufferPool, type PooledRGBA } from './pool.ts';
import { agreement, agrees, hdrCandidates, hdrTransfer, matrixCode, type PlanarCheck } from './conversion-check.ts';
import { type Packing, type RawChoice, rawReader, WebGLReader } from './texture-convert.ts';
export { agreement, agrees, matrixCode, type PlanarCheck };
/** Converts one decoded VideoFrame into plain RGBA (applying container rotation). Injected so the decoding pipeline is testable without a canvas. */
export type FrameConverter = ((frame: VideoFrame, info: MediaInfo) => RGBA | Promise<RGBA>) & {
  /** Conversions run off the calling thread, so the source may start the next decoded frames' early: `true` for the
   *  source's default depth, or how many frames ahead. */
  prefetch?: boolean | number;
  dispose?(): void;
  /** Which conversion this converter has settled on so far, for diagnostics. */
  describe?(): string;
  /** What the first frame showed about the conversion (timing, HDR handling), for warnings and diagnostics. */
  report?(): ConversionReport;
  /** This frame's YUV planes, once the converter has settled on converting planes in the core (`planarConverter`):
   *  a caller can then run that same core conversion straight into core memory. Undefined while undecided, on any
   *  other conversion, and for a frame the planar path would not take. */
  planes?(frame: VideoFrame, info: MediaInfo): Promise<FramePlanes | undefined>;
};
/** Worst case for one conversion before the worker is written off (the frame then converts in-thread). */
const WORKER_CONVERSION_TIMEOUT = 10000;
export function canvasConverter(): FrameConverter {
  let canvas: OffscreenCanvas | undefined, ctx: OffscreenCanvasRenderingContext2D | null = null, ms: number | undefined;
  const convert = (frame: VideoFrame, info: MediaInfo): RGBA => {
    const t0 = performance.now();
    try {
      return draw(frame, info);
    } finally {
      ms ??= performance.now() - t0;
    }
  };
  const draw = (frame: VideoFrame, info: MediaInfo): RGBA => {
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
  const describe = () => '2D canvas drawImage + getImageData';
  return Object.assign(convert, { describe, report: () => ({ method: describe(), ms }) });
}
/** Direct `VideoFrame.copyTo({ format: 'RGBA' })`: the browser converts YUV→sRGB into a plain buffer, skipping the
 *  2D-canvas draw + `getImageData` readback that dominated decode-side CPU time. Capability is probed once on the
 *  first frame (Safari/Chrome versions differ in RGB conversion support); a throwing or wrong-sized probe falls back
 *  to the canvas path permanently for this source. Rotated containers always use the canvas, which already rotates. */
export function directConverter(fallback: FrameConverter = planarConverter()): FrameConverter {
  // `handedOver`: frames went to `fallback` without the direct path being tried (HDR), so it describes the run.
  let direct: boolean | undefined, handedOver = false;
  const pool = new BufferPool();
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    // An HDR frame's RGBA copy is the browser's tone mapping (Chrome) or its coded values (Firefox), never the
    // screen's pixels: the fallback (the planar converter) undoes the transfer in the core.
    if (info.rotation !== 0 || direct === false || typeof frame.copyTo !== 'function' || hdrTransfer(info.colour, frame.colorSpace)) {
      handedOver = true;
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
    describe: () => direct ? 'copyTo(RGBA)' : direct === false || handedOver ? fallback.describe?.() ?? 'fallback' : 'undecided',
    report: () => direct ? { method: 'copyTo(RGBA)' } : fallback.report?.() ?? { method: fallback.describe?.() ?? 'fallback' },
    planes: async (frame: VideoFrame, info: MediaInfo) =>
      direct === false || hdrTransfer(info.colour, frame.colorSpace) ? await fallback.planes?.(frame, info) : undefined,
  });
}
/** Coded R'G'B' read through the GPU on this thread (src/media/texture-convert.ts), with an HDR transfer undone in the
 *  core: for frames without a copyable format and HDR frames the planar path cannot take, when no conversion worker
 *  does it (`workerConverter`). */
export function rawConverter(compute: Settings['compute'] = 'auto', gpu?: unknown): FrameConverter {
  let reader: ReturnType<typeof rawReader> | undefined, transfer: 'pq' | 'hlg' | undefined, aboveShare: number | undefined;
  const pool = new BufferPool();
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    const width = info.codedWidth, height = info.codedHeight, image = pool.take(width, height);
    try {
      transfer ??= hdrTransfer(info.colour, frame.colorSpace);
      reader ??= rawReader(!!transfer, compute, gpu);
      const { packing } = await reader.read(
        frame,
        width,
        height,
        new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.length),
      );
      if (transfer) {
        const above = core().hdrToRGBA(image.data, packing, width, height, transfer);
        aboveShare ??= above / (width * height);
      }
      return image;
    } catch (error) {
      image.release();
      throw error;
    }
  };
  const describe = () => rawDescribe(reader?.choice(), transfer) ?? 'undecided';
  return Object.assign(convert, {
    describe,
    report: () => rawReport(describe(), reader?.choice(), transfer, aboveShare),
    dispose: () => reader?.dispose(),
  });
}
function rawDescribe(choice: RawChoice | undefined, transfer: 'pq' | 'hlg' | undefined): string | undefined {
  return choice && `${choice.route}${transfer ? ` + core ${transfer.toUpperCase()}→sRGB` : ''}`;
}
function rawReport(
  method: string,
  choice: RawChoice | undefined,
  transfer: 'pq' | 'hlg' | undefined,
  aboveShare?: number,
): ConversionReport {
  return { method, ms: choice?.ms, ...(transfer ? { hdr: { transfer, verified: choice?.verified ?? false, aboveShare } } : {}) };
}
/** Codes of rust/core/src/yuv.rs `Format::from_code`. */
const FRAME_FORMATS: Record<string, number> = { I420: 0, I422: 1, I444: 2, NV12: 3 };
/** `VideoFrame.copyTo` in the frame's own YUV layout (I420, I422, I444, NV12) plus the core's conversion to RGBA — libyuv's
 *  integer math, which is what Chrome's `copyTo({ format: 'RGBA' })` computes for a software-decoded frame — for
 *  browsers whose copyTo cannot convert to RGB (Safari through at least 27). It replaces a 2D-canvas drawImage +
 *  getImageData readback per frame, which is slower and on Safari routes every frame through a GPU-process
 *  conversion. The first frame is also converted by `fallback` and the planar path is only taken for the run when
 *  the two agree (a browser's native-layout copyTo can misplace planes); the choice is made before any frame is
 *  returned and never changes afterwards, so a run never mixes two conversions. Rotated containers keep the canvas.
 *
 *  An HDR recording (`hdrTransfer`) is never compared with the canvas, whose colours are the browser's (coded values in
 *  Safari, a tone mapping in Chrome). Its planes go through the core's HDR conversion under the colour code that,
 *  among `hdrCandidates`, agrees best with WebGL's reading of the same frame's coded values, itself put through the
 *  core's HDR conversion (src/media/texture-convert.ts); with no code agreeing, every frame is read through `raw`
 *  instead. Without WebGL2 the first candidate is taken unchecked and reported so. Frames with no copyable format
 *  (Chrome's hardware-decoded 10-bit HEVC) go to `raw` as well, SDR or not. */
/** How much closer to the reference (mean levels) a later HDR colour code must come to replace an earlier one. */
const CLEARLY_CLOSER = 0.25;
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
  /** Whether `convert` takes (or, undecided, would try) this HDR frame's planes. */
  takesHdr(frame: VideoFrame, info: MediaInfo): boolean;
};
export function planarConverter(
  fallback: FrameConverter = canvasConverter(),
  raw: FrameConverter = rawConverter(),
): PlanarConverter {
  // One reused buffer for the planes; a conversion that starts while another is still copying (a prefetched frame
  // the source then skipped) gets its own, so two copies never land in the same bytes.
  let scratch: ArrayBuffer | undefined, busy = false, planar: boolean | undefined, check: PlanarCheck | undefined;
  // HDR: the colour code chosen on the first frame (false: none agreed, frames go to `raw`), whether it was checked,
  // and what the first frame measured; `route` says where frames went when not to the planes.
  let hdrCode: number | false | undefined, hdrCheck: PlanarCheck | undefined, transfer: 'pq' | 'hlg' | undefined;
  let route: 'raw' | 'canvas' | undefined, hdrMS: number | undefined, aboveShare: number | undefined;
  const pool = new BufferPool();
  /** The frame's 8-bit planes, copied (reusing `scratch` when free), or undefined where they cannot be. */
  const copyPlanes = async (frame: VideoFrame, info: MediaInfo) => {
    const format = frame.format ? FRAME_FORMATS[frame.format] : undefined, rect = frame.visibleRect;
    if (format === undefined || typeof frame.copyTo !== 'function') return undefined;
    if (rect && (rect.width !== info.codedWidth || rect.height !== info.codedHeight)) return undefined;
    const size = frame.allocationSize(), own = !busy;
    if (own && (!scratch || scratch.byteLength < size)) scratch = new ArrayBuffer(size);
    busy ||= own;
    try {
      const data = own ? new Uint8Array(scratch!, 0, size) : new Uint8Array(size), layout = await frame.copyTo(data);
      return { data, layout, format };
    } finally {
      if (own) busy = false;
    }
  };
  const hdrConvert = async (frame: VideoFrame, info: MediaInfo, hdr: 'pq' | 'hlg'): Promise<RGBA> => {
    transfer = hdr;
    // The canvas rotates a rotated container's frames; nothing else here does. Its colours are the browser's.
    if (info.rotation !== 0) return (route = 'canvas', fallback(frame, info));
    if (hdrCode === false) return raw(frame, info);
    const width = info.codedWidth, height = info.codedHeight;
    let planes;
    try {
      planes = await copyPlanes(frame, info);
    } catch (error) {
      if (typeof hdrCode === 'number') throw error;
    }
    if (!planes) {
      if (typeof hdrCode === 'number') {
        throw new Error(`planar HDR conversion cannot take a ${frame.format} frame after taking earlier ones`);
      }
      hdrCode = false;
      return (route = 'raw', raw(frame, info));
    }
    if (hdrCode === undefined) {
      const candidates = hdrCandidates(hdr, info.colour, frame.colorSpace), gl = WebGLReader.create();
      if (!gl) {
        hdrCode = candidates[0];
      } else {
        let reference: Uint8Array;
        try {
          reference = gl.read(frame, width, height);
        } finally {
          gl.dispose();
        }
        core().hdrToRGBA(reference, 'rgba8', width, height, hdr);
        const expected = new Uint8ClampedArray(reference.buffer);
        // Candidates come most likely first; a later one replaces an earlier one only when clearly closer, because a
        // frame of greys (most of a screen) reads the same under every matrix and would otherwise pick by rounding.
        let best: { code: number; check: PlanarCheck } | undefined;
        for (const code of candidates) {
          const check = agreement(core().frameToRGBA(planes.data, planes.format, planes.layout, width, height, code), expected);
          if (agrees(check) && (!best || check.meanDiff < best.check.meanDiff - CLEARLY_CLOSER)) best = { code, check };
        }
        if (!best) {
          hdrCode = false;
          return (route = 'raw', raw(frame, info));
        }
        hdrCode = best.code;
        hdrCheck = best.check;
      }
    }
    const image = pool.take(width, height), seen = { above: 0 }, t0 = performance.now();
    core().frameToRGBA(planes.data, planes.format, planes.layout, width, height, hdrCode, image.data, seen);
    hdrMS ??= performance.now() - t0;
    aboveShare ??= seen.above / (width * height);
    return image;
  };
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    const hdr = hdrTransfer(info.colour, frame.colorSpace);
    if (hdr) return hdrConvert(frame, info, hdr);
    // A frame with no copyable format (Chrome's hardware-decoded 10-bit HEVC): its coded R'G'B' through the GPU.
    if (frame.format === null && info.rotation === 0 && !planar) return (route = 'raw', raw(frame, info));
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
    route === 'raw'
      ? raw.describe?.() ?? 'raw'
      : route === 'canvas'
      ? `${fallback.describe?.() ?? 'fallback'} (HDR, colours unchecked)`
      : typeof hdrCode === 'number'
      ? `planar copyTo + core ${transfer!.toUpperCase()}→sRGB (colour code ${hdrCode}, ${
        hdrCheck ? `first frame ${hdrCheck.meanDiff.toFixed(2)} from WebGL` : 'unchecked: no WebGL'
      })`
      : planar
      ? `planar copyTo + core YUV→RGBA (first frame ${check!.meanDiff.toFixed(2)} from canvas)`
      : planar === false
      ? `${fallback.describe?.() ?? 'fallback'}${check ? ` (planar rejected: ${check.meanDiff.toFixed(1)} from canvas)` : ''}`
      : 'undecided';
  const report = (): ConversionReport => {
    if (route === 'raw') return raw.report?.() ?? { method: describe() };
    const ms = route === 'canvas' || planar === false ? fallback.report?.().ms : hdrMS;
    return { method: describe(), ms, ...(transfer ? { hdr: { transfer, verified: !!hdrCheck, aboveShare } } : {}) };
  };
  const spec = (frame: VideoFrame, info: MediaInfo): PlaneSpec | undefined => {
    const format = frame.format ? FRAME_FORMATS[frame.format] : undefined, width = info.codedWidth, height = info.codedHeight;
    const hdr = hdrTransfer(info.colour, frame.colorSpace);
    const matrix = hdr
      ? (typeof hdrCode === 'number' ? hdrCode : undefined)
      : planar === true
      ? matrixCode(frame.colorSpace ?? undefined, frame.format ?? undefined, height)
      : undefined;
    const rect = frame.visibleRect;
    if (info.rotation !== 0 || format === undefined || matrix === undefined) return undefined;
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
  const takesHdr = (frame: VideoFrame, info: MediaInfo) =>
    info.rotation === 0 && hdrCode !== false && !!frame.format && FRAME_FORMATS[frame.format] !== undefined &&
    typeof frame.copyTo === 'function';
  return Object.defineProperties(
    Object.assign(convert, { describe, report, planes, spec, fromPlanes, takesHdr, dispose: () => raw.dispose?.() }),
    {
      planar: { get: () => planar },
      check: { get: () => check },
    },
  ) as PlanarConverter;
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
  /** Frames whose coded R'G'B' a worker read through the GPU. */
  raw: number;
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
 *  them here, exactly as it converts its own copy.
 *
 *  Frames whose coded R'G'B' must be read through the GPU (no copyable format, or an HDR frame `planar` does not take)
 *  go to the first worker, which settles that route on its first such frame (src/media/texture-convert.ts); an HDR
 *  transfer is then undone here, in the core, in the reply buffer itself. */
export function workerConverter(
  url: URL,
  fallback: FrameConverter = directConverter(),
  /** The acceleration setting: whether the worker may convert on the GPU (src/media/gpu-convert.ts). */
  compute: Settings['compute'] = 'auto',
  /** The planar converter inside `fallback`, when there is one (`frameConverter`). */
  planar?: PlanarConverter,
): FrameConverter & { counts: WorkerConversionCounts } {
  const counts: WorkerConversionCounts = { worker: 0, inThread: 0, workers: 0, planes: 0, raw: 0 };
  type Reply = { buffer: ArrayBuffer; layout?: { offset: number; stride: number }[]; packing?: Packing; choice?: RawChoice };
  // The raw route's choice (from the worker's replies), the HDR transfer it undoes here, and the first frame's share of
  // pixels above white.
  let rawChoice: RawChoice | undefined, rawTransfer: 'pq' | 'hlg' | undefined, aboveShare: number | undefined;
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
    if (hdrTransfer(info.colour, frame.colorSpace)) return false;
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
        if (data.buffer) pending?.resolve({ buffer: data.buffer, layout: data.layout, packing: data.packing, choice: data.choice });
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
  /** Sends a clone of `frame` to a worker and waits for its reply: RGBA, the frame's own planes, or its coded R'G'B'
   *  (always from the first worker, so one route reads the run). Throws on any failure; the caller retires the workers
   *  and converts in-thread. */
  const request = async (frame: VideoFrame, info: MediaInfo, mode: 'rgba' | 'planes' | 'raw'): Promise<Reply & { target: Worker }> => {
    const planes = mode === 'planes', target = mode === 'raw' ? workers[0] ?? start() : pick();
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
      const raw = mode === 'raw' ? { hdr: !!hdrTransfer(info.colour, frame.colorSpace) } : undefined;
      target.postMessage({ id, frame: clone, width, height, planes, raw, compute: target === workers[0] ? compute : 'cpu' }, [
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
      const { buffer, layout, target } = await request(frame, info, 'planes');
      if (!layout) throw new Error('conversion worker returned planes without their layout');
      counts.planes++;
      return { data: new Uint8Array(buffer), layout, ...spec, release: lender(target, buffer, true) };
    } catch (error) {
      retire(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  /** Whether this frame's coded R'G'B' is read through the GPU in the worker: no copyable format, or an HDR frame the
   *  planar path does not take (it settles HDR planes itself, in-thread, on the first frame). */
  const readsRaw = (frame: VideoFrame, info: MediaInfo): boolean => {
    if (retired || info.rotation !== 0 || typeof frame.clone !== 'function') return false;
    if (frame.format === null) return !planar?.planar;
    return !!hdrTransfer(info.colour, frame.colorSpace) && !planar?.takesHdr(frame, info);
  };
  const viaRaw = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    const width = info.codedWidth, height = info.codedHeight;
    try {
      const { buffer, target, packing, choice } = await request(frame, info, 'raw');
      if (buffer.byteLength !== width * height * 4 || !packing) throw new Error(`conversion worker returned ${buffer.byteLength} bytes`);
      rawChoice = choice;
      const data = new Uint8ClampedArray(buffer), transfer = hdrTransfer(info.colour, frame.colorSpace);
      if (transfer) {
        rawTransfer = transfer;
        const above = core().hdrToRGBA(data, packing, width, height, transfer);
        aboveShare ??= above / (width * height);
      }
      counts.raw++;
      return Object.assign({ width, height, data }, { release: lender(target, buffer, false) });
    } catch (error) {
      retire(error instanceof Error ? error.message : String(error));
      return inThread(frame, info);
    }
  };
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    if (readsRaw(frame, info)) return viaRaw(frame, info);
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
      const { buffer, target } = await request(frame, info, 'rgba');
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
    counts.raw
      ? `${rawDescribe(rawChoice, rawTransfer)} in a worker (${counts.raw} frames, ${counts.inThread} in-thread)`
      : counts.worker
      ? `${method} in ${
        counts.workers > 1 ? `${counts.workers} workers` : 'a worker'
      } (${counts.worker} frames, ${counts.inThread} in-thread)`
      : `${fallback.describe?.() ?? 'fallback'}${counts.planes ? ` (planes copied in a worker: ${counts.planes} frames)` : ''}`;
  const report = (): ConversionReport =>
    counts.raw
      ? rawReport(describe(), rawChoice, rawTransfer, aboveShare)
      : counts.worker
      ? { method: describe() }
      : { ...fallback.report?.() ?? { method: '' }, method: describe() };
  // Planes only where this frame would convert in-thread through `fallback` (never once the worker has converted).
  const planes = async (frame: VideoFrame, info: MediaInfo) =>
    succeeded || takes(frame, info) ? undefined : await workerPlanes(frame, info) ?? await fallback.planes?.(frame, info);
  return Object.defineProperties(Object.assign(convert, { counts, describe, report, planes, dispose: () => retire('disposed') }), {
    // One frame ahead per worker a CPU run may use, so they all have work; the default depth otherwise.
    prefetch: { get: () => cpu ? Math.max(2, maxWorkers()) : true },
  }) as FrameConverter & { counts: WorkerConversionCounts };
}
