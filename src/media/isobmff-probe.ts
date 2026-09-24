import { BlobReader } from './reader.ts';
/** A trimmed ISOBMFF box walk that runs ahead of mediabunny. It never reads sample data, only the small moov/moof
 *  metadata boxes, via `BlobReader`'s bounded page cache — the file this reads can be gigabytes long, and this
 *  still does many small random-offset reads across it. It covers three things mediabunny's own demuxer does not:
 *  - a handful of conditions mediabunny accepts (warns and keeps going, or has no representation for at all) that
 *    this project has always treated as a hard stop or a diagnostic: multiple/rate-shifted movie edits, a
 *    sample-description index other than 1, an encrypted (`encv`) sample entry, and a version-0 `ctts` box carrying
 *    non-standard signed offsets;
 *  - `MediaInfo.duration`, computed the same way ISO 14496-12 §8.6.6 and QuickTime's edit list always have been
 *    here: `mdhd`'s duration/timescale, overridden by the single edit-list entry's own timescale-converted duration
 *    when a `elst` is present. mediabunny's own duration accessors don't apply an edit list this way;
 *  - a file that ends inside its `mdat`/`moof` (`truncated`), which mediabunny demuxes without comment up to the
 *    last sample the file still holds.
 *  It is never stricter than mediabunny about the file's top-level layout (see `topLevel`). */
interface Box {
  type: string;
  start: number;
  data: number;
  end: number;
  size: number;
}
const text = (a: Uint8Array) => new TextDecoder().decode(a);
/** A box header as written, unchecked: `end` may lie past `parentEnd` and `size` may be smaller than the header. */
async function headerAt(r: BlobReader, offset: number, parentEnd: number): Promise<Box> {
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
  return { type, start: offset, data: offset + header, end: offset + size, size };
}
async function boxAt(r: BlobReader, offset: number, parentEnd = r.file.size): Promise<Box> {
  const b = await headerAt(r, offset, parentEnd);
  if (b.size < b.data - b.start || b.end > parentEnd) {
    throw new Error(`Invalid MP4 box ${b.type} at ${offset}.`);
  }
  return b;
}
/** The file's top-level boxes, walked the way mediabunny's own `readMetadata` walks them: a header that does not
 *  parse, or a box that runs past the end of the file, ends the walk instead of failing it. Recordings carry both —
 *  bytes after the last box, or an `mdat` the file ends inside of because the recording or its transfer was cut
 *  off — and mediabunny demuxes such a file from its moov regardless, so failing here would reject a recording the
 *  demuxer itself reads. Boxes inside moov/moof stay strict (`children`). */
async function topLevel(r: BlobReader): Promise<{ boxes: Box[]; cut?: Box }> {
  const boxes: Box[] = [];
  for (let p = 0; p + 8 <= r.file.size;) {
    const b = await headerAt(r, p, r.file.size).catch(() => undefined);
    if (!b || b.size < b.data - b.start) {
      break;
    }
    if (b.end > r.file.size) {
      return { boxes, cut: b.type === 'mdat' || b.type === 'moof' ? b : undefined };
    }
    boxes.push(b);
    p = b.end;
  }
  return { boxes };
}
async function* children(r: BlobReader, parent: Box | { data: number; end: number }): AsyncGenerator<Box> {
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
export interface IsobmffProbeResult {
  /** Whether a video track's `ctts` box is version 0 but carries a high-bit (negative, if read signed) offset —
   *  ReplayKit/QuickTime's non-standard layout. mediabunny reads it correctly either way; this only decides whether
   *  the NONSTANDARD_SIGNED_CTTS_V0 diagnostic fires. */
  signedCttsV0: boolean;
  /** The video track's presentation duration in seconds (`mdhd` duration/timescale, edit-list-adjusted when a
   *  single valid `elst` entry is present), or `undefined` when no video track was found — the caller then leaves
   *  duration to mediabunny's own `getPrimaryVideoTrack()` returning null and its frozen error text. */
  duration?: number;
  /** The `mdat`/`moof` box the file ends inside of, when that is where the top-level walk stopped: its type and the
   *  byte offset its size field says it ends at. Samples past the file's end are not there to decode. */
  truncated?: { box: string; declaredEnd: number };
}
/** Runs the pre-check. Throws with the same frozen error text the hand-written MP4Demuxer used to, for conditions
 *  mediabunny does not reject on its own. A file with no moov and no video track is left to mediabunny's own
 *  `getPrimaryVideoTrack()` returning null — the caller maps that to the same frozen messages. */
export async function probeIsobmff(file: Blob): Promise<IsobmffProbeResult> {
  const r = new BlobReader(file);
  const top = await topLevel(r);
  let moov: Box | undefined;
  for (const b of top.boxes) {
    if (b.type === 'moov') {
      moov = b;
    }
  }
  if (!moov) {
    throw new Error('MP4/MOV has no movie metadata (moov). The recording may be unfinished.');
  }
  let movieTimescale = 1;
  const mvhd = await child(r, moov, 'mvhd');
  if (mvhd) {
    const version = (await r.read(mvhd.data, 1))[0];
    movieTimescale = await r.u32(mvhd.data + (version === 1 ? 20 : 12)) || 1;
  }
  let trak: Box | undefined, trackId = 0;
  for await (const t of children(r, moov)) {
    if (t.type !== 'trak') {
      continue;
    }
    const mdia = await child(r, t, 'mdia'), hdlr = mdia && await child(r, mdia, 'hdlr');
    if (hdlr && text(await r.read(hdlr.data + 8, 4)) === 'vide') {
      trak = t;
      const tkhd = await child(r, t, 'tkhd');
      if (tkhd) {
        const version = (await r.read(tkhd.data, 1))[0];
        trackId = await r.u32(tkhd.data + (version === 1 ? 20 : 12));
      }
      break;
    }
  }
  const truncated = top.cut && { box: top.cut.type, declaredEnd: top.cut.end };
  if (!trak) {
    return { signedCttsV0: false, truncated };
  }
  const mdia = await child(r, trak, 'mdia'), mdhd = mdia && await child(r, mdia, 'mdhd');
  let timescale = 1, duration = 0;
  if (mdhd) {
    const mv = (await r.read(mdhd.data, 1))[0];
    timescale = await r.u32(mdhd.data + (mv === 1 ? 20 : 12)) || 1;
    duration = (mv === 1 ? await r.u64(mdhd.data + 24) : await r.u32(mdhd.data + 16)) / timescale;
  }
  const edts = await child(r, trak, 'edts'), elst = edts && await child(r, edts, 'elst');
  if (elst) {
    const ver = (await r.read(elst.data, 1))[0], count = await r.u32(elst.data + 4), stride = ver === 1 ? 20 : 12;
    let empty = 0, valid = 0;
    for (let i = 0; i < count; i++) {
      const v = await r.view(elst.data + 8 + i * stride, stride),
        segmentDuration = ver === 1 ? Number(v.getBigUint64(0)) : v.getUint32(0),
        time = ver === 1 ? Number(v.getBigInt64(8)) : v.getInt32(4),
        rate = v.getInt16(ver === 1 ? 16 : 8);
      if (rate !== 1) {
        throw new Error('A non-unit MOV edit playback rate needs compatibility mode.');
      }
      if (time === -1) {
        empty += segmentDuration / movieTimescale;
      } else {
        duration = empty + segmentDuration / movieTimescale;
        valid++;
      }
    }
    if (valid > 1) {
      throw new Error('Multiple discontinuous movie edits need compatibility mode; they will not be silently flattened.');
    }
  }
  const minf = mdia && await child(r, mdia, 'minf'), stbl = minf && await child(r, minf, 'stbl');
  let signedCttsV0 = false;
  if (stbl) {
    const stsd = await child(r, stbl, 'stsd');
    if (stsd) {
      const entry = await boxAt(r, stsd.data + 8, stsd.end);
      if (entry.type === 'encv') {
        throw new Error('Encrypted video is not supported.');
      }
    }
    const stsc = await child(r, stbl, 'stsc');
    if (stsc) {
      const count = await r.u32(stsc.data + 4);
      for (let i = 0; i < count; i++) {
        if (await r.u32(stsc.data + 16 + i * 12) !== 1) {
          throw new Error('Sample-description/codec changes require compatibility mode.');
        }
      }
    }
    const ctts = await child(r, stbl, 'ctts');
    if (ctts) {
      const version = (await r.read(ctts.data, 1))[0];
      if (version === 0) {
        const count = await r.u32(ctts.data + 4);
        for (let i = 0; i < count && !signedCttsV0; i++) {
          if (await r.u32(ctts.data + 12 + i * 8) >= 0x80000000) {
            signedCttsV0 = true;
          }
        }
      }
    }
  }
  for (const moof of top.boxes) {
    if (moof.type !== 'moof') {
      continue;
    }
    for await (const traf of children(r, moof)) {
      if (traf.type !== 'traf') {
        continue;
      }
      const tfhd = await child(r, traf, 'tfhd');
      if (!tfhd) {
        continue;
      }
      const v = await r.view(tfhd.data, 8), flags = v.getUint32(0) & 0xffffff, tid = v.getUint32(4);
      if (tid === trackId && flags & 2 && await r.u32(tfhd.data + 8) !== 1) {
        throw new Error('Sample-description/codec changes require compatibility mode.');
      }
    }
  }
  return { signedCttsV0, duration, truncated };
}
