import type {
  ConversionReport,
  FrameImage,
  FramePlanes,
  FrameSource,
  MediaInfo,
  MediaNotice,
  PlanarFrame,
  RGBA,
  Settings,
  SkippedFrame,
  SourceStats,
} from '../types.ts';
import type { Demuxer } from './reader.ts';
import { MediabunnyDemuxer } from './mediabunny-demux.ts';
import { directConverter, type FrameConverter, planarConverter, workerConverter } from './convert.ts';
import { releaseUnlessHeld } from './pool.ts';
import type { Capture } from './capture.ts';
import { hdrTransfer } from './conversion-check.ts';
import { WebGLReader } from './texture-convert.ts';
import { core } from '../core/wasm.ts';
import { t } from '../i18n/index.ts';
/** Decoded frames an off-thread converter may be converting ahead of the one the pipeline is on; the decoder
 *  buffers two (the producer's backpressure in `PreciseSource`). */
const PREFETCH = 2;
export async function openDemuxer(file: Blob): Promise<Demuxer> {
  return await new MediabunnyDemuxer(file).init();
}
/** The shipped conversion chain: a worker converting with WebGPU when its first frame agrees with `copyTo(RGBA)` and
 *  measures faster (or `compute` asks for it), otherwise with `copyTo(RGBA)`; frames the worker cannot take convert
 *  in-thread (src/media/convert.ts). */
export function frameConverter(compute: Settings['compute'] = 'auto'): FrameConverter {
  const planar = planarConverter();
  return workerConverter(new URL('./convert-worker.js', import.meta.url), directConverter(planar), compute, planar);
}
export async function openMedia(file: File, convert: FrameConverter = frameConverter()): Promise<FrameSource> {
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
    demux.dispose();
    throw new Error(`Unsupported codec configuration ${demux.config.codec}: ${String(e)}`);
  }
  if (!support.supported) {
    demux.dispose();
    throw new Error(
      t('media.UNSUPPORTED_CODEC', { codec: demux.config.codec, advice: t(`media.UNSUPPORTED_ADVICE.${codecFamily(demux.config.codec)}`) }),
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
/** Which advice an undecodable codec string gets: HEVC (iPhone and Mac recordings), ProRes, the H.264 profiles only
 *  Chrome decodes (High 10, High 4:2:2, High 4:4:4: profile_idc 110, 122, 244), AV1, or anything else. */
function codecFamily(codec: string): 'hevc' | 'prores' | 'h264' | 'av1' | 'other' {
  if (/^(hev1|hvc1)/.test(codec)) return 'hevc';
  if (/^(apc[nhso]|ap4[hx])/.test(codec)) return 'prores';
  if (/^avc[13]\.(6e|7a|f4)/i.test(codec)) return 'h264';
  if (/^av01/.test(codec)) return 'av1';
  return 'other';
}
/** The container's colour as a plain object (MediaInfo is persisted and posted between threads), when it says any. */
function colourOf(c: VideoColorSpaceInit | undefined): { colour?: VideoColorSpaceInit } {
  const colour = Object.fromEntries(
    (['primaries', 'transfer', 'matrix', 'fullRange'] as const).flatMap((k) => c?.[k] === undefined || c?.[k] === null ? [] : [[k, c[k]]]),
  ) as VideoColorSpaceInit;
  return Object.keys(colour).length ? { colour } : {};
}
export class PreciseSource implements FrameSource {
  info: MediaInfo;
  stats: SourceStats = { frames: 0, converted: 0, decodeMS: 0, convertMS: 0 };
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
      ...colourOf(demux.config.colorSpace),
    };
  }
  dispose(): void {
    this.cancelled = true;
    this.demux.dispose();
    this.convert.dispose?.();
  }
  /** How decoded frames are being turned into RGBA, for diagnostics. */
  conversion(): string {
    return this.convert.describe?.() ?? 'custom converter';
  }
  /** The converter's first-frame report (src/media/conversion-report.ts turns it into diagnostics). */
  conversionReport(): ConversionReport | undefined {
    return this.convert.report?.() ?? (this.stats.converted ? { method: this.conversion() } : undefined);
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
  /** Reconciles one decoded frame's actual geometry against `this.info` before it is converted: the bitstream
   *  (not the container header) defines the pixel grid, a resolution change mid-run is rejected rather than
   *  merged, and a non-square pixel aspect ratio is reported but never used to resize the stored pixels. Only the
   *  first frame (`index === 0`) may correct `info`; every later mismatch is a real change and throws. Pure aside
   *  from `this.notice`/`info` mutation — no decoder or queue state — which is what makes it safe to pull out of
   *  the frames() generator's backpressure loop. */
  private checkFrameGeometry(frame: VideoFrame, index: number): void {
    const info = this.info;
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
          t('media.CONTAINER_SIZE_MISMATCH', {
            codedWidth: info.codedWidth,
            codedHeight: info.codedHeight,
            bitstreamWidth,
            bitstreamHeight,
          }),
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
        t('media.NON_SQUARE_PIXELS', {
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
          bitstreamWidth,
          bitstreamHeight,
        }),
      );
    }
  }
  async *frames(): AsyncGenerator<FrameImage> {
    yield* this.decode() as AsyncGenerator<FrameImage>;
  }
  /** Every frame is decoded (later frames depend on it); the ones `want` declines are closed unconverted. */
  async *sparseFrames(
    want: (index: number) => boolean,
    options: { planes?: boolean } = {},
  ): AsyncGenerator<FrameImage | SkippedFrame | PlanarFrame> {
    yield* this.decode(want, options.planes);
  }
  private async *decode(want?: (index: number) => boolean, planes = false): AsyncGenerator<FrameImage | SkippedFrame | PlanarFrame> {
    const { demux, info } = this, queue: VideoFrame[] = [], signal = new Signal();
    /** How many decoded frames ahead the converter wants converting (`FrameConverter.prefetch`). */
    const depth = () => this.convert.prefetch === true ? PREFETCH : this.convert.prefetch || 0;
    // Engine calls frames() multiple times (scan, solve, render) on the same PreciseSource; each pass reports its
    // own diagnostic counts. Without this, notices from earlier passes silently accumulate into later ones, and
    // since project.media is this exact object by reference, an exported manifest ends up N× over-reporting.
    info.notices = [];
    const stats: SourceStats = this.stats = { frames: 0, converted: 0, decodeMS: 0, convertMS: 0 };
    let ended = false, producerDone = false, failure: unknown = null, submitted = 0, received = 0, lastOutput = performance.now();
    // WebCodecs promises presentation order, but WebKit's decoder hands some B-frames back in decode order (35 of
    // the 90 frames of tests/fixtures/bframes-pyramid.mp4). Holding back as many frames as the stream ever reorders
    // (`reorderDepth`, 0 without B-frames) and releasing the earliest restores the order; on a decoder that already
    // keeps it, the frames only leave a few frames later.
    const held: VideoFrame[] = [], reorder = demux.reorderDepth ?? 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        received++;
        lastOutput = performance.now();
        if (ended) {
          frame.close();
        } else {
          let at = held.length;
          while (at > 0 && held[at - 1].timestamp > frame.timestamp) at--;
          held.splice(at, 0, frame);
          while (held.length > reorder) queue.push(held.shift()!);
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
          // Decoded frames wait here for as many conversions as the converter runs ahead (at least two).
          while (
            !ended && !failure && (queue.length >= Math.max(2, depth()) || decoder.decodeQueueSize >= 2 || submitted - received >= 32)
          ) {
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
          const init: EncodedVideoChunkInit = { type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: packet.data };
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
        // A disposed source's demuxer throws on its next read; that is the cancellation, not a decode failure.
        if (!ended && !this.cancelled) {
          failure = e;
        }
      } finally {
        // Every frame still held for reordering has arrived once the decoder has flushed or the stream has failed.
        for (const frame of held.splice(0)) {
          if (ended || this.cancelled) {
            frame.close();
          } else {
            queue.push(frame);
          }
        }
        producerDone = true;
        signal.notify();
      }
    })();
    let index = 0, lastTimestamp = -Infinity;
    // An off-thread converter is handed the next decoded frames (as many as the decoder has buffered, at most
    // PREFETCH) while the pipeline works on the current one, so their round trips overlap. This is speculative only:
    // each frame's checks below still run, in order, when it is taken, and a frame they skip or reject just drops
    // its early conversion.
    const ahead = new Map<VideoFrame, Promise<RGBA>>();
    // The same for planes handed out to a caller that converts them itself (`planes`): a worker copies the next frames'
    // planes while the caller works.
    const aheadPlanes = new Map<VideoFrame, Promise<FramePlanes | undefined>>();
    const dropPlanes = async (early?: Promise<FramePlanes | undefined>) => await early?.then((p) => p?.release()).catch(() => {});
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
          const waiting = performance.now();
          await signal.wait();
          stats.decodeMS += performance.now() - waiting;
          continue;
        }
        const frame = queue.shift()!;
        const early = ahead.get(frame), earlyPlanes = aheadPlanes.get(frame);
        ahead.delete(frame);
        aheadPlanes.delete(frame);
        signal.notify();
        let closed = false;
        try {
          if (frame.timestamp < 0) {
            // Samples before the movie edit are not presented by any player; they are counted, not hidden. This
            // frame is never yielded, so its already-started prefetch (`early`, if the source was one step ahead
            // of the decoder) would otherwise convert into an image nothing ever releases.
            await early?.then((image) => releaseUnlessHeld(image)).catch(() => {});
            await dropPlanes(earlyPlanes);
            this.notice('NEGATIVE_TIMESTAMP_SKIPPED', t('media.NEGATIVE_TIMESTAMP_SKIPPED'));
            continue;
          }
          if (frame.timestamp < lastTimestamp) {
            // WebCodecs emits presentation order; a backwards timestamp is a container-metadata anomaly. Keep the
            // decoder's order and report it rather than abandoning the rest of the recording.
            this.notice('NONMONOTONIC_TIMESTAMP', t('media.NONMONOTONIC_TIMESTAMP'));
          } else {
            lastTimestamp = frame.timestamp;
          }
          this.checkFrameGeometry(frame, index);
          const time = frame.timestamp / 1e6, duration = (frame.duration || 0) / 1e6;
          if (want && !want(index)) {
            await early?.then((image) => releaseUnlessHeld(image)).catch(() => {});
            await dropPlanes(earlyPlanes);
            frame.close();
            closed = true;
            stats.frames++;
            yield { time, duration, index: index++ };
            continue;
          }
          const converting = performance.now();
          // The caller converts planes itself when the run converts on the CPU (`FrameConverter.planes`).
          const own = planes && !early ? (await earlyPlanes) ?? await this.convert.planes?.(frame, info) : undefined;
          if (own) {
            stats.convertMS += performance.now() - converting;
            if (depth() && !this.cancelled) {
              for (let k = 0; k < Math.min(queue.length, depth()); k++) {
                const next = queue[k];
                if (aheadPlanes.has(next) || ahead.has(next) || (want && !want(index + 1 + k))) continue;
                const copy = this.convert.planes!(next, info);
                copy.catch(() => {});
                aheadPlanes.set(next, copy);
              }
            }
            frame.close();
            closed = true;
            stats.frames++;
            stats.converted++;
            yield { planes: own, time, duration, index: index++ };
            continue;
          }
          const image = await (early ?? this.convert(frame, info));
          stats.convertMS += performance.now() - converting;
          if (depth() && !this.cancelled) {
            for (let k = 0; k < Math.min(queue.length, depth()); k++) {
              const next = queue[k];
              if (ahead.has(next) || (want && !want(index + 1 + k))) continue;
              const image = (async () => await this.convert(next, info))();
              image.catch(() => {});
              ahead.set(next, image);
            }
          }
          frame.close();
          closed = true;
          stats.frames++;
          stats.converted++;
          yield { image, time, duration, index: index++ };
        } finally {
          if (!closed) {
            frame.close();
          }
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
      // Bounded by the converter's own timeout; a stopped pass leaves no conversion running into the next one. A
      // frame that did convert here was never yielded to any pass, so nothing else can be holding its pool
      // buffer — release it now or it (and the buffer behind it) is simply lost, not reused.
      for (const image of ahead.values()) await image.then((image) => releaseUnlessHeld(image)).catch(() => {});
      for (const copy of aheadPlanes.values()) await dropPlanes(copy);
      aheadPlanes.clear();
      ahead.clear();
      await producer;
    }
  }
}
/** Explicitly approximate fallback. Main thread performs native video seeks; worker stays backpressured. */
export class CompatibilitySource implements FrameSource {
  private cancelled = false;
  /** An HDR recording's transfer (from the container's tag): its frames are captured as coded values and converted
   *  in the core, as the checked routes of PreciseSource do. */
  private readonly hdr: 'pq' | 'hlg' | undefined;
  /** Set on the first frame of an HDR recording: whether its frames are read as coded values. */
  private coded?: boolean;
  private report?: ConversionReport;
  constructor(
    public info: MediaInfo,
    private fps: number,
    private request: (time: number, coded: boolean) => Promise<Capture>,
    private read: (bitmap: ImageBitmap) => RGBA = bitmapReader(),
    private readCoded: (bitmap: ImageBitmap) => Uint8Array | undefined = codedReader(),
  ) {
    info.mode = `Approximate native seek (${fps} Hz)`;
    info.frameCount = Math.ceil(info.duration * fps);
    // Same compressed material as PreciseSource, one more resampling step removed (the browser's own seek and
    // bitmap path), so it can only be noisier — never tighter.
    info.noise ??= DECODED_VIDEO_NOISE;
    info.notices ??= [];
    this.hdr = hdrTransfer(info.colour);
  }
  dispose(): void {
    this.cancelled = true;
  }
  /** For an HDR recording, once a frame has been read: how, and whether its colours are the core's or the browser's. */
  conversionReport(): ConversionReport | undefined {
    return this.report;
  }
  async *frames(): AsyncGenerator<FrameImage> {
    for (let index = 0; index < this.info.frameCount! && !this.cancelled; index++) {
      const time = index / this.fps;
      const { bitmap, coded } = await this.request(time, !!this.hdr && this.coded !== false);
      let image: RGBA;
      try {
        if (bitmap.width !== this.info.width || bitmap.height !== this.info.height) {
          throw new Error(
            `FRAME_GEOMETRY_CHANGED: native seek returned ${bitmap.width}×${bitmap.height}, expected ${this.info.width}×${this.info.height}. The prefix is retained; no resizing was performed.`,
          );
        }
        image = this.hdr ? this.readHdr(bitmap, coded, this.hdr, time) : this.read(bitmap);
      } finally {
        bitmap.close();
      }
      yield { image, time, duration: 1 / this.fps, index };
    }
  }
  private readHdr(bitmap: ImageBitmap, coded: boolean, transfer: 'pq' | 'hlg', time: number): RGBA {
    const { width, height } = bitmap, values = coded && this.coded !== false ? this.readCoded(bitmap) : undefined;
    if (this.coded === undefined) {
      this.coded = !!values;
      this.report = {
        method: values
          ? `video snapshot's coded values (WebGL) + core ${transfer.toUpperCase()}→sRGB`
          : "video snapshot in the browser's colours",
        hdr: { transfer, verified: !!values },
      };
    } else if (this.coded !== !!values) {
      // A run mixing the core's colours with the browser's would put two versions of every colour on one canvas.
      throw new Error(
        `HDR_CAPTURE_CHANGED: the frame at ${time.toFixed(3)} s could not be read the way the first one was. The prefix is retained.`,
      );
    }
    if (!values) return this.read(bitmap);
    const above = core().hdrToRGBA(values, 'rgba8', width, height, transfer);
    if (this.report?.hdr && this.report.hdr.aboveShare === undefined) this.report.hdr.aboveShare = above / (width * height);
    return { width, height, data: new Uint8ClampedArray(values.buffer, values.byteOffset, values.byteLength) };
  }
}
/** Reads a captured bitmap's values back unchanged (WebGL, no colour conversion); undefined where there is no WebGL2,
 *  which leaves the browser's colours. */
export function codedReader(): (bitmap: ImageBitmap) => Uint8Array | undefined {
  let reader: WebGLReader | null | undefined;
  return (bitmap) => {
    if (reader === undefined) reader = WebGLReader.create() ?? null;
    return reader?.read(bitmap, bitmap.width, bitmap.height);
  };
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
