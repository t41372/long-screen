import { BlobReader, type Demuxer, type Packet } from './reader.ts';
interface Box {
  type: string;
  start: number;
  data: number;
  end: number;
  size: number;
}
const text = (a: Uint8Array) => new TextDecoder().decode(a);
async function boxAt(r: BlobReader, offset: number, parentEnd = r.file.size): Promise<Box> {
  const h = await r.read(offset, 8);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let size = v.getUint32(0), header = 8;
  const type = text(h.subarray(4, 8));
  if (size === 1) {
    size = await r.u64(offset + 8);
    header = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }
  if (size < header || offset + size > parentEnd) {
    throw new Error(`Invalid MP4 box ${type} at ${offset}.`);
  }
  return { type, start: offset, data: offset + header, end: offset + size, size };
}
async function* children(
  r: BlobReader,
  parent: Box | {
    data: number;
    end: number;
  },
): AsyncGenerator<Box> {
  for (let p = parent.data; p + 8 <= parent.end;) {
    const b = await boxAt(r, p, parent.end);
    yield b;
    p = b.end;
  }
}
async function child(r: BlobReader, parent: Box, type: string): Promise<Box | undefined> {
  for await (const b of children(r, parent)) {
    if (b.type === type) {
      return b;
    }
  }
}
async function required(r: BlobReader, parent: Box, type: string): Promise<Box> {
  const b = await child(r, parent, type);
  if (!b) {
    throw new Error(`MP4 ${parent.type} has no ${type}.`);
  }
  return b;
}
const hex = (n: number) => n.toString(16).padStart(2, '0');
function reverse32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (n & 1);
    n >>>= 1;
  }
  return r >>> 0;
}
export class MP4Demuxer implements Demuxer {
  reader: BlobReader;
  config!: VideoDecoderConfig;
  width = 0;
  height = 0;
  rotation = 0;
  duration = 0;
  frameCount = 0;
  warnings: string[] = [];
  private timescale = 1;
  private movieTimescale = 1;
  private timeOffset = 0;
  private trackId = 0;
  private stbl!: Box;
  private stts?: Box;
  private ctts?: Box;
  private stss?: Box;
  private stsz?: Box;
  private stz2?: Box;
  private stsc?: Box;
  private offsets?: Box;
  private fragmented = false;
  private defaults = { duration: 0, size: 0, flags: 0 };
  constructor(file: Blob) {
    this.reader = new BlobReader(file);
  }
  async init(): Promise<this> {
    const r = this.reader;
    let moov: Box | undefined;
    for await (const b of children(r, { data: 0, end: r.file.size })) {
      if (b.type === 'moov') {
        moov = b;
      }
      if (b.type === 'moof') {
        this.fragmented = true;
      }
    }
    if (!moov) {
      throw new Error('MP4/MOV has no movie metadata (moov). The recording may be unfinished.');
    }
    const mvhd = await child(r, moov, 'mvhd');
    if (mvhd) {
      const version = (await r.read(mvhd.data, 1))[0];
      this.movieTimescale = await r.u32(mvhd.data + (version === 1 ? 20 : 12));
    }
    let trak: Box | undefined;
    for await (const t of children(r, moov)) {
      if (t.type === 'trak') {
        const mdia = await child(r, t, 'mdia'), hdlr = mdia && await child(r, mdia, 'hdlr');
        if (hdlr && text(await r.read(hdlr.data + 8, 4)) === 'vide') {
          trak = t;
          break;
        }
      }
    }
    if (!trak) {
      throw new Error('No video track exists in this file.');
    }
    const tkhd = await required(r, trak, 'tkhd'), version = (await r.read(tkhd.data, 1))[0];
    this.trackId = await r.u32(tkhd.data + (version === 1 ? 20 : 12));
    const matrix = await r.view(tkhd.data + (version === 1 ? 52 : 40), 36), a = matrix.getInt32(0) / 65536, b = matrix.getInt32(4) / 65536;
    this.rotation = ((Math.round(Math.atan2(b, a) * 180 / Math.PI / 90) * 90) % 360 + 360) % 360;
    const mdia = await required(r, trak, 'mdia'), mdhd = await required(r, mdia, 'mdhd'), mv = (await r.read(mdhd.data, 1))[0];
    this.timescale = await r.u32(mdhd.data + (mv === 1 ? 20 : 12));
    if (!this.timescale) {
      throw new Error('Invalid video time scale.');
    }
    this.duration = (mv === 1 ? await r.u64(mdhd.data + 24) : await r.u32(mdhd.data + 16)) / this.timescale;
    const edts = await child(r, trak, 'edts'), elst = edts && await child(r, edts, 'elst');
    if (elst) {
      const ver = (await r.read(elst.data, 1))[0], count = await r.u32(elst.data + 4), stride = ver === 1 ? 20 : 12;
      let empty = 0, valid = 0;
      for (let i = 0; i < count; i++) {
        const v = await r.view(elst.data + 8 + i * stride, stride),
          duration = ver === 1 ? Number(v.getBigUint64(0)) : v.getUint32(0),
          time = ver === 1 ? Number(v.getBigInt64(8)) : v.getInt32(4),
          rate = v.getInt16(ver === 1 ? 16 : 8);
        if (rate !== 1) {
          throw new Error('A non-unit MOV edit playback rate needs compatibility mode.');
        }
        if (time === -1) {
          empty += duration / this.movieTimescale;
        } else {
          this.timeOffset = empty - time / this.timescale;
          this.duration = empty + duration / this.movieTimescale;
          valid++;
        }
      }
      if (valid > 1) {
        throw new Error('Multiple discontinuous movie edits need compatibility mode; they will not be silently flattened.');
      }
    }
    const minf = await required(r, mdia, 'minf');
    this.stbl = await required(r, minf, 'stbl');
    const stsd = await required(r, this.stbl, 'stsd'), entry = await boxAt(r, stsd.data + 8, stsd.end);
    this.width = await r.u16(entry.start + 32);
    this.height = await r.u16(entry.start + 34);
    let codec = entry.type, description: Uint8Array | undefined;
    if (codec === 'encv') {
      throw new Error('Encrypted video is not supported.');
    }
    for await (const c of children(r, { data: entry.start + 86, end: entry.end })) {
      if (c.type === 'avcC') {
        description = (await r.read(c.data, c.end - c.data)).slice();
        codec = `${entry.type}.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
      } else if (c.type === 'hvcC') {
        description = (await r.read(c.data, c.end - c.data)).slice();
        const d = description, v = new DataView(d.buffer);
        const space = ['', 'A', 'B', 'C'][d[1] >> 6],
          profile = d[1] & 31,
          compat = reverse32(v.getUint32(2)).toString(16),
          tier = d[1] & 32 ? 'H' : 'L';
        const constraint = Array.from(d.subarray(6, 12));
        while (constraint.length && constraint[constraint.length - 1] === 0) {
          constraint.pop();
        }
        codec = `${entry.type}.${space}${profile}.${compat}.${tier}${d[12]}${
          constraint.length ? '.' + constraint.map((x) => hex(x).toUpperCase()).join('.') : ''
        }`;
      } else if (c.type === 'vpcC') {
        const d = await r.read(c.data, 8);
        codec = `vp09.${String(d[4]).padStart(2, '0')}.${String(d[5]).padStart(2, '0')}.${String(d[6] >> 4).padStart(2, '0')}`;
      } else if (c.type === 'av1C') {
        const d = await r.read(c.data, 4);
        codec = `av01.${d[1] >> 5}.${String(d[1] & 31).padStart(2, '0')}${d[2] & 128 ? 'H' : 'M'}.${
          d[2] & 64 ? (d[2] & 32 ? '12' : '10') : '08'
        }`;
      } else if (c.type === 'pasp') {
        const v = await r.view(c.data, 8);
        if (v.getUint32(0) !== v.getUint32(4)) {
          this.warnings.push('Non-square pixel aspect ratio: stored sample pixels are preserved; display aspect may differ.');
        }
      } else if (c.type === 'colr') {
        const v = await r.view(c.data, Math.min(12, c.end - c.data));
        if (v.byteLength >= 10 && ['nclx', 'nclc'].includes(text(await r.read(c.data, 4))) && [16, 18].includes(v.getUint16(6))) {
          this.warnings.push('HDR recording: browser canvas conversion produces 8-bit sRGB, not HDR-preserving output.');
        }
      }
    }
    if (codec === 'vp09') {
      codec = 'vp09.00.10.08';
    }
    if (codec === 'vp08') {
      codec = 'vp8';
    }
    this.config = { codec, codedWidth: this.width, codedHeight: this.height, optimizeForLatency: false };
    if (description) {
      this.config.description = description;
    }
    for await (const b of children(r, this.stbl)) {
      if (b.type === 'stts') {
        this.stts = b;
      }
      if (b.type === 'ctts') {
        this.ctts = b;
      }
      if (b.type === 'stss') {
        this.stss = b;
      }
      if (b.type === 'stsz') {
        this.stsz = b;
      }
      if (b.type === 'stz2') {
        this.stz2 = b;
      }
      if (b.type === 'stsc') {
        this.stsc = b;
      }
      if (b.type === 'stco' || b.type === 'co64') {
        this.offsets = b;
      }
    }
    if (this.stsz) {
      this.frameCount = await r.u32(this.stsz.data + 8);
    } else if (this.stz2) {
      this.frameCount = await r.u32(this.stz2.data + 8);
    }
    const mvex = await child(r, moov, 'mvex');
    if (mvex) {
      for await (const b of children(r, mvex)) {
        if (b.type === 'trex' && await r.u32(b.data + 4) === this.trackId) {
          this.defaults = { duration: await r.u32(b.data + 12), size: await r.u32(b.data + 16), flags: await r.u32(b.data + 20) };
        }
      }
    }
    if (this.fragmented && (!this.duration || !this.frameCount)) {
      let count = 0, end = 0;
      for await (const p of this.fragmentPackets()) {
        count++;
        end = Math.max(end, (p.timestamp + p.duration) / 1e6);
      }
      this.frameCount += count;
      this.duration = Math.max(this.duration, end);
    }
    if (!this.frameCount) {
      throw new Error('No decodable video samples were found.');
    }
    return this;
  }
  async *packets(): AsyncGenerator<Packet> {
    if (this.stsz || this.stz2) {
      yield* this.tablePackets();
    }
    if (this.fragmented) {
      yield* this.fragmentPackets();
    }
  }
  private async *tablePackets(): AsyncGenerator<Packet> {
    const r = this.reader, stsz = this.stsz, stz2 = this.stz2;
    const count = stsz ? await r.u32(stsz.data + 8) : await r.u32(stz2!.data + 8);
    if (!count) {
      return;
    }
    if (!this.stts || !this.stsc || !this.offsets) {
      throw new Error('Missing MP4 sample tables.');
    }
    const constant = stsz ? await r.u32(stsz.data + 4) : 0, bits = stz2 ? (await r.read(stz2.data + 7, 1))[0] : 0;
    const chunkCount = await r.u32(this.offsets.data + 4),
      scCount = await r.u32(this.stsc.data + 4),
      ctCount = this.ctts ? await r.u32(this.ctts.data + 4) : 0;
    let tt = 0,
      ttLeft = 0,
      delta = 0,
      ct = 0,
      ctLeft = 0,
      composition = 0,
      ss = 0,
      nextSync = this.stss ? await r.u32(this.stss.data + 8) : Infinity;
    const syncCount = this.stss ? await r.u32(this.stss.data + 4) : 0;
    let sample = 0, dts = 0, sc = 0, nextSC = scCount > 1 ? await r.u32(this.stsc.data + 20) : Infinity;
    for (let chunk = 1; chunk <= chunkCount && sample < count; chunk++) {
      if (chunk >= nextSC) {
        sc++;
        nextSC = sc + 1 < scCount ? await r.u32(this.stsc.data + 8 + (sc + 1) * 12) : Infinity;
      }
      const perChunk = await r.u32(this.stsc.data + 12 + sc * 12), descriptionIndex = await r.u32(this.stsc.data + 16 + sc * 12);
      if (descriptionIndex !== 1) {
        throw new Error('Sample-description/codec changes require compatibility mode.');
      }
      let offset = this.offsets.type === 'co64'
        ? await r.u64(this.offsets.data + 8 + (chunk - 1) * 8)
        : await r.u32(this.offsets.data + 8 + (chunk - 1) * 4);
      for (let k = 0; k < perChunk && sample < count; k++, sample++) {
        if (ttLeft === 0) {
          ttLeft = await r.u32(this.stts.data + 8 + tt * 8);
          delta = await r.u32(this.stts.data + 12 + tt * 8);
          tt++;
        }
        if (this.ctts && ctLeft === 0 && ct < ctCount) {
          ctLeft = await r.u32(this.ctts.data + 8 + ct * 8);
          // Always signed. ISO 14496-12 only makes version 1 signed, but QuickTime/ReplayKit
          // recordings (and FFmpeg's reader) use negative offsets in version 0 boxes; reading
          // them unsigned yields ~7,158,278-second timestamps and breaks presentation order.
          composition = (await r.view(this.ctts.data + 12 + ct * 8, 4)).getInt32(0);
          ct++;
        }
        let size = constant;
        if (!size && stsz) {
          size = await r.u32(stsz.data + 12 + sample * 4);
        } else if (stz2) {
          if (bits === 4) {
            const byte = (await r.read(stz2.data + 12 + (sample >> 1), 1))[0];
            size = sample & 1 ? byte & 15 : byte >> 4;
          } else if (bits === 8) {
            size = (await r.read(stz2.data + 12 + sample, 1))[0];
          } else if (bits === 16) {
            size = await r.u16(stz2.data + 12 + sample * 2);
          } else {
            throw new Error('Invalid compact sample-size table.');
          }
        }
        const key = !this.stss || sample + 1 === nextSync;
        yield {
          offset,
          size,
          timestamp: Math.round(((dts + composition) / this.timescale + this.timeOffset) * 1e6),
          duration: Math.round(delta / this.timescale * 1e6),
          key,
        };
        if (key && this.stss) {
          ss++;
          nextSync = ss < syncCount ? await r.u32(this.stss.data + 8 + ss * 4) : Infinity;
        }
        offset += size;
        dts += delta;
        ttLeft--;
        if (ctLeft > 0) {
          ctLeft--;
        }
      }
    }
    if (sample !== count) {
      throw new Error(`Sample table declared ${count} frames but located ${sample}.`);
    }
  }
  private async *fragmentPackets(): AsyncGenerator<Packet> {
    const r = this.reader;
    let implicitDTS = 0;
    for await (const moof of children(r, { data: 0, end: r.file.size })) {
      if (moof.type !== 'moof') {
        continue;
      }
      for await (const traf of children(r, moof)) {
        if (traf.type !== 'traf') {
          continue;
        }
        const tfhd = await required(r, traf, 'tfhd');
        const v = await r.view(tfhd.data, 8), flags = v.getUint32(0) & 0xffffff;
        if (v.getUint32(4) !== this.trackId) {
          continue;
        }
        let p = tfhd.data + 8, base = moof.start;
        const defaults = { ...this.defaults };
        if (flags & 1) {
          base = await r.u64(p);
          p += 8;
        }
        if (flags & 2) {
          p += 4;
        }
        if (flags & 8) {
          defaults.duration = await r.u32(p);
          p += 4;
        }
        if (flags & 16) {
          defaults.size = await r.u32(p);
          p += 4;
        }
        if (flags & 32) {
          defaults.flags = await r.u32(p);
        }
        const tfdt = await child(r, traf, 'tfdt');
        let dts = tfdt ? ((await r.read(tfdt.data, 1))[0] === 1 ? await r.u64(tfdt.data + 4) : await r.u32(tfdt.data + 4)) : implicitDTS;
        let dataCursor = moof.end + 8;
        for await (const run of children(r, traf)) {
          if (run.type !== 'trun') {
            continue;
          }
          const header = await r.view(run.data, 8), f = header.getUint32(0) & 0xffffff, n = header.getUint32(4);
          let q = run.data + 8, firstFlags = defaults.flags;
          if (f & 1) {
            dataCursor = base + (await r.view(q, 4)).getInt32(0);
            q += 4;
          }
          if (f & 4) {
            firstFlags = await r.u32(q);
            q += 4;
          }
          for (let i = 0; i < n; i++) {
            let duration = defaults.duration, size = defaults.size, sampleFlags = i === 0 ? firstFlags : defaults.flags, cto = 0;
            if (f & 0x100) {
              duration = await r.u32(q);
              q += 4;
            }
            if (f & 0x200) {
              size = await r.u32(q);
              q += 4;
            }
            if (f & 0x400) {
              sampleFlags = await r.u32(q);
              q += 4;
            }
            if (f & 0x800) {
              cto = (await r.view(q, 4)).getInt32(0);
              q += 4;
            }
            if (!size || !duration) {
              throw new Error('Fragment has no sample size or duration.');
            }
            yield {
              offset: dataCursor,
              size,
              timestamp: Math.round(((dts + cto) / this.timescale + this.timeOffset) * 1e6),
              duration: Math.round(duration / this.timescale * 1e6),
              key: !(sampleFlags & 0x10000),
            };
            dataCursor += size;
            dts += duration;
          }
        }
        implicitDTS = dts;
      }
    }
  }
}
