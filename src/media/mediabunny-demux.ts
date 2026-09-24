import { BlobSource, EncodedPacketSink, Input, MATROSKA, MatroskaInputFormat, MP4, QTFF, WEBM } from 'mediabunny';
import type { Demuxer, Packet } from './reader.ts';
import { BlobReader } from './reader.ts';
import { probeIsobmff } from './isobmff-probe.ts';
import { t } from '../i18n/index.ts';
/** Container demuxing on top of mediabunny's packet-level API (`Input` + `BlobSource` + `EncodedPacketSink`).
 *  Decoding itself is still WebCodecs, driven from `source.ts` — but its *output* is not unchanged: mediabunny
 *  reports a video track's `VideoColorSpace` (`colorSpace` on the returned `VideoDecoderConfig`), which the hand-
 *  written demuxers never did, and passing it to `VideoDecoder.configure()` is what makes Chrome decode a 4:4:4
 *  VP9 stream (`scroll.webm`) into the right planes at all — see `convert.ts`'s GBR handling. Only `MP4`, `QTFF`,
 *  `WEBM` and `MATROSKA` are imported (never `ALL_FORMATS`) so an MP3/WAV/OGG/HLS demuxer never reaches the bundle.
 *
 *  mediabunny is more permissive than the old hand-written demuxers on a few conditions this project treats as
 *  hard failures — it warns and keeps going instead of throwing, or (for a fully-fragmented file whose Segment Info
 *  carries a Duration but whose sample data was truncated away) reports zero packets with no error at all.
 *  `isobmff-probe.ts` runs first for ISOBMFF files (MP4/MOV) to reproduce the former with the same frozen error
 *  text, to compute `MediaInfo.duration` the way an edit list has always been applied here (mediabunny's own
 *  duration accessors don't apply one), and to raise the NONSTANDARD_SIGNED_CTTS_V0 diagnostic mediabunny has no
 *  equivalent for. WebM/Matroska gets its own small check below for the latter (an empty file after the metadata
 *  duration is trusted). */
const EBML_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3];
async function isEbml(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return EBML_SIGNATURE.every((b, i) => head[i] === b);
}
/** Reads the CodecID (e.g. `V_MS/VFW/FOURCC`) of a WebM/Matroska file's first video TrackEntry, for the
 *  "Unsupported Matroska codec X" message only — mediabunny's own `getCodec()` returns `null` for a codec it does
 *  not translate to a WebCodecs string, discarding the raw id text this project's error message has always named. */
async function matroskaCodecId(file: Blob): Promise<string | undefined> {
  const r = new BlobReader(file);
  async function vint(p: number, id = false): Promise<{ value: number; length: number }> {
    const first = (await r.read(p, 1))[0];
    let length = 1, mask = 128;
    while (length <= 8 && !(first & mask)) {
      length++;
      mask >>= 1;
    }
    const a = await r.read(p, length);
    let value = id ? first : first & (mask - 1);
    for (let i = 1; i < length; i++) {
      value = value * 256 + a[i];
    }
    return { value, length };
  }
  async function* elements(p: number, end: number): AsyncGenerator<{ id: number; data: number; end: number }> {
    while (p < end) {
      const eid = await vint(p, true), size = await vint(p + eid.length), data = p + eid.length + size.length, elEnd = data + size.value;
      if (elEnd > end) {
        return;
      }
      yield { id: eid.value, data, end: elEnd };
      p = elEnd;
    }
  }
  try {
    for await (const seg of elements(0, r.file.size)) {
      if (seg.id !== 0x18538067) {
        continue;
      }
      for await (const e of elements(seg.data, seg.end)) {
        if (e.id !== 0x1654ae6b) {
          continue;
        }
        for await (const entry of elements(e.data, e.end)) {
          if (entry.id !== 0xae) {
            continue;
          }
          let type = 0, id = '';
          for await (const c of elements(entry.data, entry.end)) {
            if (c.id === 0x83) {
              type = (await r.read(c.data, c.end - c.data))[0];
            }
            if (c.id === 0x86) {
              id = new TextDecoder().decode(await r.read(c.data, c.end - c.data));
            }
          }
          if (type === 1 && id) {
            return id;
          }
        }
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
export class MediabunnyDemuxer implements Demuxer {
  config!: VideoDecoderConfig;
  width = 0;
  height = 0;
  rotation = 0;
  duration = 0;
  frameCount?: number;
  warnings: string[] = [];
  private input?: Input;
  private sink!: EncodedPacketSink;
  constructor(private file: Blob) {}
  async init(): Promise<this> {
    const ebml = await isEbml(this.file);
    let probeDuration: number | undefined;
    if (!ebml) {
      const probe = await probeIsobmff(this.file);
      probeDuration = probe.duration;
      if (probe.signedCttsV0) {
        this.warnings.push(t('media.NONSTANDARD_SIGNED_CTTS_V0'));
      }
      if (probe.truncated) {
        // mediabunny's packet walk ends quietly at the last sample the file still holds, so without this the only
        // sign would be the scan's PASS_FRAME_COUNT_MISMATCH at the end of a run.
        this.warnings.push(
          t('media.TRUNCATED_RECORDING', { box: probe.truncated.box, declaredEnd: probe.truncated.declaredEnd, size: this.file.size }),
        );
      }
    }
    let input: Input | undefined;
    try {
      input = new Input({ source: new BlobSource(this.file), formats: [MP4, QTFF, WEBM, MATROSKA] });
      this.input = input;
      let track;
      try {
        track = await input.getPrimaryVideoTrack();
      } catch {
        throw new Error(
          ebml ? 'Missing WebM segment.' : 'MP4/MOV has no movie metadata (moov). The recording may be unfinished.',
        );
      }
      if (!track) {
        throw new Error(ebml ? 'WebM contains no video track.' : 'No video track exists in this file.');
      }
      // Only a malformed/absent codec-configuration record (no avcC/hvcC — never seen on a real recording, only on
      // hand-built test containers that don't carry one) makes getDecoderConfig()/getCodec()/hasHighDynamicRange()
      // throw (the last one resolves a color space that itself needs the codec string); that is not fatal at demux
      // time here any more than it was in the hand-written demuxer, which built its codec string without ever
      // requiring one. openMedia()'s VideoDecoder.isConfigSupported() check is what actually rejects an undecodable
      // codec/config combination before any frame is read.
      const config = await track.getDecoderConfig().catch(() => null);
      const codec = config?.codec ?? await track.getCodec().catch(() => null) ?? undefined;
      if (!codec) {
        throw new Error(
          ebml
            ? `Unsupported Matroska codec ${await matroskaCodecId(this.file) ?? '(unknown)'}. Compatibility mode may support it.`
            : 'Encrypted video is not supported.',
        );
      }
      this.config = {
        ...config,
        codec,
        codedWidth: await track.getCodedWidth(),
        codedHeight: await track.getCodedHeight(),
      } as VideoDecoderConfig;
      this.config.optimizeForLatency = false;
      this.width = await track.getCodedWidth();
      this.height = await track.getCodedHeight();
      this.rotation = await track.getRotation();
      const par = await track.getPixelAspectRatio();
      if (par.num !== par.den) {
        this.warnings.push('Non-square pixel aspect ratio: stored sample pixels are preserved; display aspect may differ.');
      }
      if (await track.hasHighDynamicRange().catch(() => false)) {
        this.warnings.push('HDR recording: browser canvas conversion produces 8-bit sRGB, not HDR-preserving output.');
      }
      this.sink = new EncodedPacketSink(track);
      const format = await input.getFormat();
      // A zero-sample track makes mediabunny 1.59.0 throw an internal assertion (fetching any packet, even
      // metadata-only, from an empty ISOBMFF sample table) instead of returning null/empty — caught here and
      // treated the same as "no samples", which is what it is.
      const metaDuration = await input.getDurationFromMetadata([track]).catch(() => null);
      if (metaDuration !== null && format instanceof MatroskaInputFormat) {
        // Segment Info Duration is present: trust it for MediaInfo.duration (WebM carries no edit list, so there is
        // nothing here for isobmff-probe.ts's duration computation to do) and skip the full-file packet walk below,
        // which for a large (multi-GB) recording would otherwise stall the UI probe before any frame gets decoded.
        this.duration = metaDuration;
        // A file whose Segment Info still declares a duration but whose actual block data was cut away (e.g. a
        // recording truncated in transfer) must still fail here, not silently open with zero playable packets.
        let hasPacket = false;
        try {
          const first = await this.sink.packets(undefined, undefined, { metadataOnly: true }).next();
          hasPacket = !first.done;
        } catch {
          hasPacket = false;
        }
        if (!hasPacket) {
          throw new Error('No decodable video samples were found.');
        }
      } else {
        let count = 0, end = 0;
        try {
          for await (const p of this.sink.packets(undefined, undefined, { metadataOnly: true })) {
            if (p.byteLength === 0) {
              throw new Error('Fragment has no sample size.');
            }
            count++;
            end = Math.max(end, p.timestamp + p.duration);
          }
        } catch (e) {
          // Our own "Fragment has no sample size" always propagates; mediabunny's zero-sample-track internal
          // assertion (see above) is swallowed only when it fired on the very first packet, i.e. count stayed 0.
          if (count > 0 || e instanceof Error && e.message === 'Fragment has no sample size.') {
            throw e;
          }
        }
        this.frameCount = count;
        // ISOBMFF: isobmff-probe.ts's mdhd/elst-based duration always wins when present — it is deliberately
        // *shorter* than the walk's own end for an edit-trimmed recording (the edit list drops a leading pre-roll
        // that the sample table still lists), so Math.max would silently undo the trim. Only a fragmented file
        // (whose mdhd duration is commonly 0, with no elst either) falls back to the walk's own end. Matroska
        // without a Segment Info Duration: nothing computed one above, so fall back to the walk's end entirely.
        this.duration = ebml ? (metaDuration ?? end) : (probeDuration || end);
        if (!count) {
          throw new Error('No decodable video samples were found.');
        }
      }
      return this;
    } catch (e) {
      // init() failed after the Input existed: nothing else will ever call dispose() on this instance.
      input?.dispose();
      this.input = undefined;
      throw e;
    }
  }
  async *packets(): AsyncGenerator<Packet> {
    for await (const p of this.sink.packets()) {
      yield {
        data: p.data,
        timestamp: Math.round(p.timestamp * 1e6),
        duration: Math.round(p.duration * 1e6),
        key: p.type === 'key',
      };
    }
  }
  dispose(): void {
    this.input?.dispose();
  }
}
