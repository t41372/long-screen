import type { FrameImage, FrameSource, MediaInfo, MediaNotice, RGBA } from '../types.ts';
import type { Demuxer } from './reader.ts';
import { MP4Demuxer } from './mp4.ts';
import { WebMDemuxer } from './webm.ts';
import { core } from '../core/wasm.ts';
/** Converts one decoded VideoFrame into plain RGBA (applying container rotation). Injected so the decoding pipeline is testable without a canvas. */
export type FrameConverter = ((frame: VideoFrame, info: MediaInfo) => RGBA | Promise<RGBA>) & {
  /** Conversions run off the calling thread, so the source may start the next decoded frame's early. */
  prefetch?: boolean;
  dispose?(): void;
  /** Which conversion this converter has settled on so far, for diagnostics. */
  describe?(): string;
};
const RGBA_COPY = { format: 'RGBA' as VideoPixelFormat, colorSpace: 'srgb' as PredefinedColorSpace };
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
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    if (info.rotation !== 0 || direct === false || typeof frame.copyTo !== 'function') {
      return fallback(frame, info);
    }
    const width = info.codedWidth, height = info.codedHeight;
    try {
      const options = { format: 'RGBA' as VideoPixelFormat, colorSpace: 'srgb' as PredefinedColorSpace };
      if (direct === undefined) {
        // Probe: a browser that ignores `format` reports the native (e.g. I420) size instead, and a frame with a
        // null format throws. Both mean "no direct path", not "corrupt frame".
        const size = frame.allocationSize(options);
        if (size !== width * height * 4) throw new Error(`allocationSize ${size} ≠ ${width * height * 4}`);
      }
      const data = new Uint8ClampedArray(width * height * 4);
      const layout = await frame.copyTo(data, options);
      if (layout.length !== 1 || layout[0].offset !== 0 || layout[0].stride !== width * 4) {
        throw new Error(`unexpected RGBA layout ${JSON.stringify(layout)}`);
      }
      direct = true;
      return { width, height, data };
    } catch (error) {
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
 *  the canvas). An untagged frame is taken as BT.709 when HD and BT.601 otherwise. */
function matrixCode(colorSpace: VideoColorSpace | undefined, height: number): number | undefined {
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
  const convert = async (frame: VideoFrame, info: MediaInfo): Promise<RGBA> => {
    const format = frame.format ? FRAME_FORMATS[frame.format] : undefined, width = info.codedWidth, height = info.codedHeight;
    const matrix = matrixCode(frame.colorSpace ?? undefined, height);
    if (planar === false || info.rotation !== 0 || format === undefined || matrix === undefined || typeof frame.copyTo !== 'function') {
      if (planar) throw new Error(`planar conversion cannot take a ${frame.format} frame after taking earlier ones`);
      planar = false;
      return fallback(frame, info);
    }
    const own = !busy;
    let data: Uint8ClampedArray;
    try {
      const rect = frame.visibleRect;
      if (rect && (rect.width !== width || rect.height !== height)) {
        throw new Error(`visible ${rect.width}×${rect.height} ≠ ${width}×${height}`);
      }
      const size = frame.allocationSize();
      if (own && (!scratch || scratch.byteLength < size)) scratch = new ArrayBuffer(size);
      busy = true;
      const planes = own ? new Uint8Array(scratch!, 0, size) : new Uint8Array(size), layout = await frame.copyTo(planes);
      data = core().frameToRGBA(planes, format, layout, width, height, matrix);
    } catch (error) {
      if (planar) throw error;
      planar = false;
      return fallback(frame, info);
    } finally {
      if (own) busy = false;
    }
    if (planar === undefined) {
      const reference = await fallback(frame, info);
      check = agreement(reference.data, data);
      planar = check.meanDiff <= PLANAR_MAX_MEAN && check.farShare <= PLANAR_MAX_FAR_SHARE;
      if (!planar) return reference;
    }
    return { width, height, data };
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
    const width = info.codedWidth, height = info.codedHeight, data = new Uint8ClampedArray(width * height * 4);
    const layout = await frame.copyTo(data, RGBA_COPY);
    if (layout.length !== 1 || layout[0].offset !== 0 || layout[0].stride !== width * 4) {
      throw new Error(`unexpected RGBA layout ${JSON.stringify(layout)}`);
    }
    return { width, height, data };
  };
  const takes = (frame: VideoFrame, info: MediaInfo): boolean => {
    if (retired || info.rotation !== 0 || typeof frame.copyTo !== 'function' || typeof frame.clone !== 'function') return false;
    try {
      return frame.allocationSize(RGBA_COPY) === info.codedWidth * info.codedHeight * 4;
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
      return { width, height, data: new Uint8ClampedArray(buffer) };
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
export async function openDemuxer(file: Blob): Promise<Demuxer> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return await new WebMDemuxer(file).init();
  }
  return await new MP4Demuxer(file).init();
}
export async function openMedia(
  file: File,
  convert: FrameConverter = workerConverter(new URL('./convert-worker.js', import.meta.url)),
): Promise<FrameSource> {
  if (typeof VideoDecoder === 'undefined') {
    throw new Error(
      'WEBCODECS_UNAVAILABLE: This browser cannot provide frame-accurate decoding. Select the explicitly labelled compatibility mode, or use a browser with WebCodecs.',
    );
  }
  const demux = await openDemuxer(file);
  let support: VideoDecoderSupport;
  try {
    support = await VideoDecoder.isConfigSupported(demux.config);
  } catch (e) {
    throw new Error(`Unsupported codec configuration ${demux.config.codec}: ${String(e)}`);
  }
  if (!support.supported) {
    throw new Error(
      `UNSUPPORTED_CODEC: ${demux.config.codec} is not decodable by this browser/device. No frames were silently skipped. Try compatibility mode or an H.264/VP9 recording.`,
    );
  }
  return new PreciseSource(file, demux, convert);
}
export class Signal {
  private waiters: (() => void)[] = [];
  notify(): void {
    for (const w of this.waiters.splice(0)) {
      w();
    }
  }
  wait(timeout = 1000): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(done);
        if (i >= 0) {
          this.waiters.splice(i, 1);
        }
        resolve();
      };
      this.waiters.push(done);
      const timer = setTimeout(done, timeout);
    });
  }
}
/** Expected per-channel decode noise of real compressed video, in RGB levels (`MediaInfo.noise`). Two decodings of
 *  the same source pixel — the same world content seen in two different frames — are not bit-identical once the
 *  material has been through H.264 or VP9: ringing around a sharp edge and 4:2:0 chroma reconstruction both move
 *  individual channels by several levels, and the amount depends on the quantiser, not on anything this code does.
 *  10 is the headroom the world-consistency mask has always used for decoded video and it stays exactly that for
 *  every real recording; what is new is that a LOSSLESS source no longer has to pay for it (see MediaInfo.noise).
 *  It is not a similarity threshold for "close enough looking" content — it is the floor below which a difference
 *  carries no information at all, so raising it to paper over a registration error would be the wrong fix. */
export const DECODED_VIDEO_NOISE = 10;
export class PreciseSource implements FrameSource {
  info: MediaInfo;
  private cancelled = false;
  /** Milliseconds without decoder output before the run is declared stalled. Overridable for tests. */
  stallTimeout = 30000;
  constructor(file: Blob & { name?: string }, private demux: Demuxer, private convert: FrameConverter) {
    const rotated = demux.rotation === 90 || demux.rotation === 270;
    this.info = {
      name: file.name || 'video',
      size: file.size,
      width: rotated ? demux.height : demux.width,
      height: rotated ? demux.width : demux.height,
      codedWidth: demux.width,
      codedHeight: demux.height,
      rotation: demux.rotation,
      duration: demux.duration,
      codec: demux.config.codec,
      frameCount: demux.frameCount,
      mode: 'Frame-accurate WebCodecs',
      noise: DECODED_VIDEO_NOISE,
      warnings: demux.warnings,
      notices: [],
    };
  }
  dispose(): void {
    this.cancelled = true;
    this.demux.reader.clear();
    this.convert.dispose?.();
  }
  /** How decoded frames are being turned into RGBA, for diagnostics. */
  conversion(): string {
    return this.convert.describe?.() ?? 'custom converter';
  }
  private notice(code: string, message: string): void {
    const list = this.info.notices ??= [];
    const existing = list.find((n) => n.code === code);
    if (existing) {
      existing.count++;
    } else {
      list.push({ code, message, count: 1 } satisfies MediaNotice);
    }
  }
  async *frames(): AsyncGenerator<FrameImage> {
    const { demux, info } = this, queue: VideoFrame[] = [], signal = new Signal();
    // Engine calls frames() multiple times (scan, solve, render) on the same PreciseSource; each pass reports its
    // own diagnostic counts. Without this, notices from earlier passes silently accumulate into later ones, and
    // since project.media is this exact object by reference, an exported manifest ends up N× over-reporting.
    info.notices = [];
    let ended = false, producerDone = false, failure: unknown = null, submitted = 0, received = 0, lastOutput = performance.now();
    const decoder = new VideoDecoder({
      output: (frame) => {
        received++;
        lastOutput = performance.now();
        if (ended) {
          frame.close();
        } else {
          queue.push(frame);
        }
        signal.notify();
      },
      error: (e) => {
        failure = e;
        signal.notify();
      },
    });
    decoder.configure(demux.config);
    decoder.ondequeue = () => signal.notify();
    const producer = (async () => {
      try {
        for await (const packet of demux.packets()) {
          while (!ended && !failure && (queue.length >= 2 || decoder.decodeQueueSize >= 2 || submitted - received >= 32)) {
            await signal.wait(100);
            if (!queue.length && performance.now() - lastOutput > this.stallTimeout) {
              throw new Error(
                `DECODER_STALLED: No decoded frame arrived for ${
                  Math.round(this.stallTimeout / 1000)
                } seconds. The committed prefix is retained.`,
              );
            }
            if (this.cancelled) {
              ended = true;
            }
          }
          if (ended || this.cancelled || failure) {
            break;
          }
          const data = await demux.reader.read(packet.offset, packet.size);
          const init: EncodedVideoChunkInit = { type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data };
          if (packet.duration > 0) {
            init.duration = packet.duration;
          }
          decoder.decode(new EncodedVideoChunk(init));
          submitted++;
        }
        if (!ended && !failure && decoder.state === 'configured') {
          // flush() has no native deadline: if it never settles (a stuck decoder), race it against the same
          // stall timeout used elsewhere, and close the decoder on timeout so the orphaned flush promise
          // (real WebCodecs decoders reject pending flushes on close()) can never keep this loop alive forever.
          let timer: number | undefined;
          const settled = await Promise.race([
            decoder.flush().then(() => 'flushed' as const),
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), this.stallTimeout);
            }),
          ]);
          clearTimeout(timer);
          if (settled === 'timeout') {
            failure = new Error(
              `DECODER_STALLED: flush did not complete within ${Math.round(this.stallTimeout / 1000)} s. The committed prefix is retained.`,
            );
            try {
              // Closing rejects/abandons the orphaned flush() promise. state is statically 'configured'
              // here, but a concurrent decoder error could have already closed it for real; ignore that.
              decoder.close();
            } catch {
              // already closed
            }
          }
        }
      } catch (e) {
        if (!ended) {
          failure = e;
        }
      } finally {
        producerDone = true;
        signal.notify();
      }
    })();
    let index = 0, lastTimestamp = -Infinity;
    // An off-thread converter is handed the next decoded frame while the pipeline works on the current one. This is
    // speculative only: that frame's checks below still run, in order, when it is taken, and a frame they skip or
    // reject just drops its early conversion.
    let ahead: { frame: VideoFrame; image: Promise<RGBA> } | undefined;
    try {
      while (!producerDone || queue.length) {
        if (failure) {
          throw failure;
        }
        if (!queue.length) {
          // Mirrors the producer's own stall check (above): if some future producer hang were not caught
          // there, an empty queue with no decoder output for stallTimeout ms is stuck, not merely slow.
          if (!producerDone && performance.now() - lastOutput > this.stallTimeout) {
            throw new Error(
              `DECODER_STALLED: No decoded frame arrived for ${
                Math.round(this.stallTimeout / 1000)
              } seconds. The committed prefix is retained.`,
            );
          }
          await signal.wait();
          continue;
        }
        const frame = queue.shift()!;
        const early = ahead?.frame === frame ? ahead.image : undefined;
        ahead = undefined;
        signal.notify();
        try {
          if (frame.timestamp < 0) {
            // Samples before the movie edit are not presented by any player; they are counted, not hidden.
            this.notice('NEGATIVE_TIMESTAMP_SKIPPED', '解码器输出了位于编辑列表起点之前（负时间戳）的帧；按容器语义不展示这些帧。');
            continue;
          }
          if (frame.timestamp < lastTimestamp) {
            // WebCodecs emits presentation order; a backwards timestamp is a container-metadata anomaly. Keep the
            // decoder's order and report it rather than abandoning the rest of the recording.
            this.notice('NONMONOTONIC_TIMESTAMP', '容器时间戳出现倒退；已按解码器的展示顺序继续处理，未丢弃观察。');
          } else {
            lastTimestamp = frame.timestamp;
          }
          // displayWidth/Height are scaled by the track's pixel aspect ratio (pasp); for an anamorphic
          // recording they do not describe the stored sample grid. visibleRect does (it is the coded
          // picture's own crop rect, before any PAR correction), so geometry is checked against that —
          // not against displayWidth/Height — to avoid mistaking non-square pixels for a real mismatch
          // and stretching the stored pixels while "fixing" it.
          const bitstreamWidth = frame.visibleRect ? frame.visibleRect.width : frame.displayWidth;
          const bitstreamHeight = frame.visibleRect ? frame.visibleRect.height : frame.displayHeight;
          if (bitstreamWidth !== info.codedWidth || bitstreamHeight !== info.codedHeight) {
            if (index === 0) {
              // Nothing has been observed yet: the bitstream, not the container header, defines the pixel grid.
              this.notice(
                'CONTAINER_SIZE_MISMATCH',
                `容器声明 ${info.codedWidth}×${info.codedHeight}，码流实际为 ${bitstreamWidth}×${bitstreamHeight}；以码流尺寸为准。`,
              );
              info.codedWidth = bitstreamWidth;
              info.codedHeight = bitstreamHeight;
              const rotated = info.rotation === 90 || info.rotation === 270;
              info.width = rotated ? bitstreamHeight : bitstreamWidth;
              info.height = rotated ? bitstreamWidth : bitstreamHeight;
            } else {
              throw new Error(
                `FRAME_GEOMETRY_CHANGED: ${bitstreamWidth}×${bitstreamHeight}; expected ${info.codedWidth}×${info.codedHeight}. The already decoded prefix will be retained; this run does not merge resolution changes.`,
              );
            }
          }
          if (frame.displayWidth !== bitstreamWidth || frame.displayHeight !== bitstreamHeight) {
            // Non-square pixels (pasp ≠ 1:1): stored samples are kept at bitstream size, unscaled — canvasConverter
            // already draws into codedWidth×codedHeight, so leaving codedWidth/Height alone is what preserves them.
            this.notice(
              'NON_SQUARE_PIXELS',
              `该录屏声明非方形像素长宽比（显示尺寸 ${frame.displayWidth}×${frame.displayHeight}，存储尺寸 ${bitstreamWidth}×${bitstreamHeight}）；保留原始存储像素，不做缩放。`,
            );
          }
          const image = await (early ?? this.convert(frame, info)), time = frame.timestamp / 1e6, duration = (frame.duration || 0) / 1e6;
          if (this.convert.prefetch && queue.length && !this.cancelled) {
            const next = queue[0];
            ahead = { frame: next, image: (async () => await this.convert(next, info))() };
            ahead.image.catch(() => {});
          }
          frame.close();
          yield { image, time, duration, index: index++ };
        } finally {
          frame.close();
        }
      }
      if (failure) {
        throw failure;
      }
    } finally {
      ended = true;
      signal.notify();
      if (decoder.state !== 'closed') {
        decoder.close();
      }
      for (const frame of queue) {
        frame.close();
      }
      queue.length = 0;
      // Bounded by the converter's own timeout; a stopped pass leaves no conversion running into the next one.
      await ahead?.image.catch(() => {});
      ahead = undefined;
      await producer;
    }
  }
}
/** Explicitly approximate fallback. Main thread performs native video seeks; worker stays backpressured. */
export class CompatibilitySource implements FrameSource {
  private cancelled = false;
  constructor(
    public info: MediaInfo,
    private fps: number,
    private request: (time: number) => Promise<ImageBitmap>,
    private read: (bitmap: ImageBitmap) => RGBA = bitmapReader(),
  ) {
    info.mode = `Approximate native seek (${fps} Hz)`;
    info.frameCount = Math.ceil(info.duration * fps);
    // Same compressed material as PreciseSource, one more resampling step removed (the browser's own seek and
    // bitmap path), so it can only be noisier — never tighter.
    info.noise ??= DECODED_VIDEO_NOISE;
    info.notices ??= [];
  }
  dispose(): void {
    this.cancelled = true;
  }
  async *frames(): AsyncGenerator<FrameImage> {
    for (let index = 0; index < this.info.frameCount! && !this.cancelled; index++) {
      const time = index / this.fps;
      const bitmap = await this.request(time);
      let image: RGBA;
      try {
        if (bitmap.width !== this.info.width || bitmap.height !== this.info.height) {
          throw new Error(
            `FRAME_GEOMETRY_CHANGED: native seek returned ${bitmap.width}×${bitmap.height}, expected ${this.info.width}×${this.info.height}. The prefix is retained; no resizing was performed.`,
          );
        }
        image = this.read(bitmap);
      } finally {
        bitmap.close();
      }
      yield { image, time, duration: 1 / this.fps, index };
    }
  }
}
export function bitmapReader(): (bitmap: ImageBitmap) => RGBA {
  let canvas: OffscreenCanvas | undefined, ctx: OffscreenCanvasRenderingContext2D | null = null;
  return (bitmap) => {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx!.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: ctx!.getImageData(0, 0, bitmap.width, bitmap.height).data };
  };
}
