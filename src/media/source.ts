import type { FrameImage, FrameSource, MediaInfo, MediaNotice, RGBA } from '../types.ts';
import type { Demuxer } from './reader.ts';
import { MP4Demuxer } from './mp4.ts';
import { WebMDemuxer } from './webm.ts';
/** Converts one decoded VideoFrame into plain RGBA (applying container rotation). Injected so the decoding pipeline is testable without a canvas. */
export type FrameConverter = (frame: VideoFrame, info: MediaInfo) => RGBA;
export function canvasConverter(): FrameConverter {
  let canvas: OffscreenCanvas | undefined, ctx: OffscreenCanvasRenderingContext2D | null = null;
  return (frame, info) => {
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
}
export async function openDemuxer(file: Blob): Promise<Demuxer> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return await new WebMDemuxer(file).init();
  }
  return await new MP4Demuxer(file).init();
}
export async function openMedia(file: File, convert: FrameConverter = canvasConverter()): Promise<FrameSource> {
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
          const image = this.convert(frame, info), time = frame.timestamp / 1e6, duration = (frame.duration || 0) / 1e6;
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
    // Same compressed material as PreciseSource, one more resampling step removed (the browser's own seek and
    // bitmap path), so it can only be noisier — never tighter.
    info.noise ??= DECODED_VIDEO_NOISE;
    info.notices ??= [];
  }
  dispose(): void {
    this.cancelled = true;
  }
  async *frames(): AsyncGenerator<FrameImage> {
    let index = 0;
    for (let time = 0; time < this.info.duration && !this.cancelled; time += 1 / this.fps) {
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
      yield { image, time, duration: 1 / this.fps, index: index++ };
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
