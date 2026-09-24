import '../support/core.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { BlobReader, type Packet } from '../../src/media/reader.ts';
import { av01CodecString, MP4Demuxer } from '../../src/media/mp4.ts';
import { vp09CodecString, WebMDemuxer } from '../../src/media/webm.ts';
import { bitmapReader, CompatibilitySource, openDemuxer, openMedia, PreciseSource, Signal } from '../../src/media/source.ts';
import { canvasConverter } from '../../src/media/convert.ts';
import { BufferPool, releaseUnlessHeld } from '../../src/media/pool.ts';
import type { MediaInfo, RGBA } from '../../src/types.ts';
const fixtures = new URL('../fixtures/', import.meta.url);
const truth = JSON.parse(await Deno.readTextFile(new URL('truth.json', fixtures)));
async function fixture(name: string): Promise<File> {
  return new File([await Deno.readFile(new URL(name, fixtures))], name);
}
for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'scroll.webm', 'negative-cts.mov', 'negative-cts-v0.mov']) {
  Deno.test(`demux ${name}: exact packet count, B-frame presentation order, bounded sizes`, async () => {
    const file = await fixture(name), d = await (name.endsWith('webm') ? new WebMDemuxer(file) : new MP4Demuxer(file)).init();
    assertEquals(d.width, 320);
    assertEquals(d.height, 240);
    const packets: Packet[] = [];
    for await (const p of d.packets()) {
      assert(p.size > 0 && p.offset >= 0 && p.offset + p.size <= file.size);
      packets.push(p);
    }
    assertEquals(packets.length, truth.frames);
    assert(packets[0].key);
    const ordered = packets.map((p) => p.timestamp).sort((a, b) => a - b);
    const expectedStart = name === 'fragmented.mp4' ? 2e6 / 30 : 0;
    assert(Math.abs(ordered[0] - expectedStart) < 1000, `first pts ${ordered[0]}`);
    assert(
      Math.abs(ordered[ordered.length - 1] - expectedStart - (truth.frames - 1) * 1e6 / 30) < 1500,
      `last pts ${ordered[ordered.length - 1]}`,
    );
    assert(d.duration > 1.3 && d.duration < 1.6, `duration ${d.duration}`);
    // Distinct, strictly increasing presentation timestamps: nothing 7,158,278 seconds away.
    for (let i = 1; i < ordered.length; i++) {
      assert(ordered[i] > ordered[i - 1] && ordered[i] < 10e6, `pts ${ordered[i]}`);
    }
    // scroll.webm carries a Segment Info Duration, so init() skips the full-file packet walk and leaves
    // frameCount undefined (see the dedicated webm-duration tests below); every other container computes it.
    if (name === 'scroll.webm') {
      assertEquals(d.frameCount, undefined);
    } else {
      assertEquals(d.frameCount, truth.frames);
    }
    if (name.startsWith('negative')) {
      assert(packets.some((p, i) => i > 0 && p.timestamp < packets[i - 1].timestamp), 'negative composition offsets must reorder packets');
    }
  });
}
Deno.test('demux: ReplayKit-style version-0 ctts yields the same timeline as the signed version-1 box', async () => {
  const a = await new MP4Demuxer(await fixture('negative-cts.mov')).init(),
    b = await new MP4Demuxer(await fixture('negative-cts-v0.mov')).init();
  const ta: number[] = [], tb: number[] = [];
  for await (const p of a.packets()) {
    ta.push(p.timestamp);
  }
  for await (const p of b.packets()) {
    tb.push(p.timestamp);
  }
  assertEquals(ta, tb);
});
Deno.test('demux: a version-0 ctts with negative (high-bit) offsets is flagged NONSTANDARD_SIGNED_CTTS_V0; version 1 and ordinary files are not', async () => {
  const v0 = await new MP4Demuxer(await fixture('negative-cts-v0.mov')).init();
  assert(v0.warnings.some((w) => w.startsWith('NONSTANDARD_SIGNED_CTTS_V0')), JSON.stringify(v0.warnings));
  const v1 = await new MP4Demuxer(await fixture('negative-cts.mov')).init();
  assert(!v1.warnings.some((w) => w.startsWith('NONSTANDARD_SIGNED_CTTS_V0')));
  const scroll = await new MP4Demuxer(await fixture('scroll.mp4')).init();
  assert(!scroll.warnings.some((w) => w.startsWith('NONSTANDARD_SIGNED_CTTS_V0')));
});
Deno.test('demux: malformed and unsupported containers are rejected explicitly', async () => {
  await assertRejects(() => new MP4Demuxer(new File([new Uint8Array(64)], 'bad.mp4')).init(), Error);
  await assertRejects(() => new MP4Demuxer(new File([new Uint8Array(4)], 'tiny.mp4')).init(), Error, 'moov');
  await assertRejects(() => new WebMDemuxer(new File([new Uint8Array(64)], 'bad.webm')).init(), Error);
  const header = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
  await assertRejects(() => new WebMDemuxer(new File([header], 'nosegment.webm')).init(), Error);
  await assertRejects(() => openDemuxer(new File([new Uint8Array(32)], 'x.bin')), Error);
  assert((await openDemuxer(await fixture('scroll.webm'))) instanceof WebMDemuxer);
  assert((await openDemuxer(await fixture('scroll.mp4'))) instanceof MP4Demuxer);
});
Deno.test('demux: moov without a video track, an audio-only file and a truncated table are reported', async () => {
  const file = await fixture('scroll.mp4'), bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes), hdlr = text.indexOf('vide');
  assert(hdlr > 0);
  const noVideo = bytes.slice();
  noVideo.set(new TextEncoder().encode('soun'), hdlr);
  await assertRejects(() => new MP4Demuxer(new File([noVideo], 'audio.mp4')).init(), Error, 'No video track');
  const stsz = text.indexOf('stsz');
  const zeroSamples = bytes.slice();
  new DataView(zeroSamples.buffer).setUint32(stsz + 12, 0);
  await assertRejects(() => new MP4Demuxer(new File([zeroSamples], 'empty.mp4')).init(), Error, 'No decodable video samples');
});
// --- Minimal hand-built MP4 boxes, for demuxer edge cases too specific to reproduce by patching a real fixture. ---
function ascii(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}
function beU32(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function beI32(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
}
function mkBox(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function concatAll(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** 86-byte VisualSampleEntry ('avc1'): the demuxer only reads width/height (@+32/+34) and looks for children past +86; none are given. */
function sampleEntry(width: number, height: number): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(78), v = new DataView(body.buffer);
  v.setUint16(6, 1); // data_reference_index
  v.setUint16(24, width);
  v.setUint16(26, height);
  v.setInt16(74, 24); // depth
  v.setInt16(76, -1); // pre_defined
  return mkBox('avc1', body);
}
function stsdBox(width: number, height: number): Uint8Array<ArrayBuffer> {
  return mkBox('stsd', beU32(0), beU32(1), sampleEntry(width, height));
}
function mdhdBox(timescale: number, durationTicks: number): Uint8Array<ArrayBuffer> {
  return mkBox('mdhd', beU32(0), beU32(0), beU32(0), beU32(timescale), beU32(durationTicks), beU32(0));
}
function hdlrBox(): Uint8Array<ArrayBuffer> {
  return mkBox('hdlr', beU32(0), beU32(0), ascii('vide'), new Uint8Array(12), new Uint8Array(1));
}
/** version-0 tkhd with an identity matrix (rotation 0), 84-byte body. */
function tkhdBox(trackId: number): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(84), v = new DataView(body.buffer);
  v.setUint32(12, trackId);
  v.setInt32(40, 0x00010000); // matrix a
  v.setInt32(56, 0x00010000); // matrix d
  v.setInt32(72, 0x40000000); // matrix w
  return mkBox('tkhd', body);
}
function sttsBox(entries: [count: number, delta: number][]): Uint8Array<ArrayBuffer> {
  const parts = [beU32(0), beU32(entries.length)];
  for (const [count, delta] of entries) {
    parts.push(beU32(count), beU32(delta));
  }
  return mkBox('stts', ...parts);
}
function cttsBox(entries: [count: number, offset: number][]): Uint8Array<ArrayBuffer> {
  const parts = [beU32(0), beU32(entries.length)];
  for (const [count, offset] of entries) {
    parts.push(beU32(count), beI32(offset));
  }
  return mkBox('ctts', ...parts);
}
function stscBox(entries: [firstChunk: number, perChunk: number, descriptionIndex: number][]): Uint8Array<ArrayBuffer> {
  const parts = [beU32(0), beU32(entries.length)];
  for (const [firstChunk, perChunk, descriptionIndex] of entries) {
    parts.push(beU32(firstChunk), beU32(perChunk), beU32(descriptionIndex));
  }
  return mkBox('stsc', ...parts);
}
function stcoBox(offsets: number[]): Uint8Array<ArrayBuffer> {
  return mkBox('stco', beU32(0), beU32(offsets.length), ...offsets.map(beU32));
}
function stszBox(sizes: number[]): Uint8Array<ArrayBuffer> {
  return mkBox('stsz', beU32(0), beU32(0), beU32(sizes.length), ...sizes.map(beU32));
}
function stssBox(syncSamples: number[]): Uint8Array<ArrayBuffer> {
  return mkBox('stss', beU32(0), beU32(syncSamples.length), ...syncSamples.map(beU32));
}
/** A minimal single-track, non-fragmented MP4 driving tablePackets(): only the sample-table shape under test matters. */
function minimalTableMP4(
  opts: { count: number; timescale?: number; stts: [number, number][]; ctts?: [number, number][]; stss?: number[]; sizes?: number[] },
): Uint8Array<ArrayBuffer> {
  const timescale = opts.timescale ?? 1000;
  const stblParts = [stsdBox(16, 16), sttsBox(opts.stts)];
  if (opts.ctts) {
    stblParts.push(cttsBox(opts.ctts));
  }
  stblParts.push(stscBox([[1, opts.count, 1]]), stcoBox([1000]), stszBox(opts.sizes ?? Array(opts.count).fill(4)));
  if (opts.stss) {
    stblParts.push(stssBox(opts.stss));
  }
  const minf = mkBox('minf', mkBox('stbl', ...stblParts));
  const mdia = mkBox('mdia', mdhdBox(timescale, opts.count * 1000), hdlrBox(), minf);
  return mkBox('moov', mkBox('trak', tkhdBox(1), mdia));
}
/** tfhd flags: 1 base-data-offset-present, 2 sample-description-index-present, 8/16/32 default duration/size/flags. */
function tfhdBox(
  trackId: number,
  flags: number,
  opts: { descriptionIndex?: number; duration?: number; size?: number; sampleFlags?: number } = {},
): Uint8Array<ArrayBuffer> {
  const parts = [beU32(flags & 0xffffff), beU32(trackId)];
  if (flags & 2) {
    parts.push(beU32(opts.descriptionIndex ?? 1));
  }
  if (flags & 8) {
    parts.push(beU32(opts.duration ?? 0));
  }
  if (flags & 16) {
    parts.push(beU32(opts.size ?? 0));
  }
  if (flags & 32) {
    parts.push(beU32(opts.sampleFlags ?? 0));
  }
  return mkBox('tfhd', ...parts);
}
function tfdtBox(dts: number): Uint8Array<ArrayBuffer> {
  return mkBox('tfdt', beU32(0), beU32(dts));
}
/** trun flags: 1 data-offset, 4 first-sample-flags, 0x100/0x200/0x400/0x800 per-sample duration/size/flags/cto. */
function trunBox(
  flags: number,
  samples: { duration?: number; size?: number; flags?: number; cto?: number }[],
  opts: { dataOffset?: number; firstFlags?: number } = {},
): Uint8Array<ArrayBuffer> {
  const parts = [beU32(flags & 0xffffff), beU32(samples.length)];
  if (flags & 1) {
    parts.push(beI32(opts.dataOffset ?? 0));
  }
  if (flags & 4) {
    parts.push(beU32(opts.firstFlags ?? 0));
  }
  for (const s of samples) {
    if (flags & 0x100) {
      parts.push(beU32(s.duration ?? 0));
    }
    if (flags & 0x200) {
      parts.push(beU32(s.size ?? 0));
    }
    if (flags & 0x400) {
      parts.push(beU32(s.flags ?? 0));
    }
    if (flags & 0x800) {
      parts.push(beI32(s.cto ?? 0));
    }
  }
  return mkBox('trun', ...parts);
}
/** A minimal single-track fragmented MP4 (moov with an empty stbl + one moof/traf) driving fragmentPackets(). */
function minimalFragmentedMP4(trackId: number, traf: Uint8Array): Uint8Array<ArrayBuffer> {
  const minf = mkBox('minf', mkBox('stbl', stsdBox(16, 16)));
  const mdia = mkBox('mdia', mdhdBox(1000, 0), hdlrBox(), minf);
  const moov = mkBox('moov', mkBox('trak', tkhdBox(trackId), mdia));
  return concatAll([moov, mkBox('moof', traf)]);
}
Deno.test('demux: MP4 E2 — an stss box with entry_count 0 does not read a stray sync-sample index (or run off the box)', async () => {
  const bytes = minimalTableMP4({ count: 3, stts: [[3, 1000]], stss: [] });
  const d = await new MP4Demuxer(new File([bytes], 'e2.mp4')).init();
  const packets: Packet[] = [];
  for await (const p of d.packets()) {
    packets.push(p);
  }
  assertEquals(packets.length, 3);
  assert(packets.every((p) => !p.key), 'an empty stss table declares no sync samples');
});
Deno.test('demux: MP4 E3 — fragmentPackets rejects a tfhd sample-description-index other than 1, like tablePackets does', async () => {
  const traf = mkBox('traf', tfhdBox(1, 2, { descriptionIndex: 2 }));
  await assertRejects(
    () => new MP4Demuxer(new File([minimalFragmentedMP4(1, traf)], 'e3.mp4')).init(),
    Error,
    'Sample-description/codec changes require compatibility mode.',
  );
  // Absent (no flag 2 at all) must NOT throw: the implicit default description index is 1.
  const fine = mkBox('traf', tfhdBox(1, 0), tfdtBox(0), trunBox(0x1 | 0x200, [{ size: 4 }], { dataOffset: 100 }));
  const d = await new MP4Demuxer(new File([minimalFragmentedMP4(1, fine)], 'e3-ok.mp4')).init();
  const packets: Packet[] = [];
  for await (const p of d.packets()) {
    packets.push(p);
  }
  assertEquals(packets.length, 1);
});
Deno.test('demux: MP4 E4 — composition offset pads with 0 once the ctts table is exhausted, not the last entry repeated', async () => {
  // 4 samples, stts delta 1000 (timescale 1000 => 1s apart); ctts only covers the first 2 samples with +500.
  const bytes = minimalTableMP4({ count: 4, stts: [[4, 1000]], ctts: [[2, 500]] });
  const d = await new MP4Demuxer(new File([bytes], 'e4.mp4')).init();
  const packets: Packet[] = [];
  for await (const p of d.packets()) {
    packets.push(p);
  }
  assertEquals(packets.map((p) => p.timestamp), [500000, 1500000, 2000000, 3000000]);
});
Deno.test('demux: MP4 E5 — a fragment sample with zero duration is allowed (duration: 0); zero size still throws', async () => {
  const okTraf = mkBox('traf', tfhdBox(1, 0), tfdtBox(0), trunBox(0x1 | 0x100 | 0x200, [{ duration: 0, size: 4 }], { dataOffset: 100 }));
  const ok = await new MP4Demuxer(new File([minimalFragmentedMP4(1, okTraf)], 'e5-ok.mp4')).init();
  const packets: Packet[] = [];
  for await (const p of ok.packets()) {
    packets.push(p);
  }
  assertEquals(packets.length, 1);
  assertEquals(packets[0].duration, 0);
  assertEquals(packets[0].size, 4);
  const badTraf = mkBox(
    'traf',
    tfhdBox(1, 0),
    tfdtBox(0),
    trunBox(0x1 | 0x100 | 0x200, [{ duration: 1000, size: 0 }], { dataOffset: 100 }),
  );
  await assertRejects(
    () => new MP4Demuxer(new File([minimalFragmentedMP4(1, badTraf)], 'e5-bad.mp4')).init(),
    Error,
    'Fragment has no sample size.',
  );
});
Deno.test('demux: WebM skips the full-file frame-count walk when Segment Info Duration is present, and falls back to it when absent', async () => {
  const withDuration = await new WebMDemuxer(await fixture('scroll.webm')).init();
  assertEquals(withDuration.frameCount, undefined);
  assert(withDuration.duration > 1.3 && withDuration.duration < 1.6, `duration ${withDuration.duration}`);
  // Rename the Duration element's 2-byte EBML ID (0x4489 -> the unused-but-same-length-class 0x4400), leaving its
  // size/content bytes untouched: init() then never learns a Segment Info duration and must fall back to the walk.
  const bytes = await Deno.readFile(new URL('scroll.webm', fixtures));
  let patched = -1;
  for (let i = 0; i + 1 < Math.min(bytes.length, 1024); i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
      patched = i;
      break;
    }
  }
  assert(patched >= 0, 'fixture must actually carry a Segment Info Duration element to make this test meaningful');
  const noDuration = bytes.slice();
  noDuration[patched + 1] = 0x00;
  const fallback = await new WebMDemuxer(new File([noDuration], 'no-duration.webm')).init();
  assertEquals(fallback.frameCount, truth.frames);
  assert(fallback.duration > 1.3 && fallback.duration < 1.6, `duration ${fallback.duration}`);
});
Deno.test('vp09CodecString: builds vp09.PP.LL.DD from Matroska feature records; missing fields keep the caller default', () => {
  // [id:1][len:1][value]: 1=profile, 2=level, 3=bit depth, 4=chroma subsampling (present but unused in the string).
  assertEquals(vp09CodecString(new Uint8Array([1, 1, 2, 2, 1, 10, 3, 1, 10, 4, 1, 1])), 'vp09.02.10.10');
  assertEquals(vp09CodecString(new Uint8Array([1, 1, 0, 2, 1, 0])), undefined); // no bit-depth record
  assertEquals(vp09CodecString(new Uint8Array([])), undefined);
  assertEquals(vp09CodecString(new Uint8Array([1, 5, 0])), undefined); // truncated record (len exceeds buffer)
});
Deno.test('av01CodecString: builds av01.P.LLT.DD from the AV1 Codec Configuration Record (shared with the av1C box)', () => {
  assertEquals(av01CodecString(new Uint8Array([0x81, 0x04, 0x40])), 'av01.0.04M.10'); // profile 0, level 4, main tier, 10-bit
  assertEquals(av01CodecString(new Uint8Array([0x81, 0x20, 0x80])), 'av01.1.00H.08'); // profile 1, level 0, high tier, 8-bit
  assertEquals(av01CodecString(new Uint8Array([0x81, 0x00, 0x60])), 'av01.0.00M.12'); // 12-bit (high_bitdepth + twelve_bit)
});
Deno.test('demux: F13 — fragmented-bdo.mp4 (no default_base_moof, so tfhd uses base-data-offset-present) matches fragmented.mp4 exactly', async () => {
  const withDefaultBase = await new MP4Demuxer(await fixture('fragmented.mp4')).init();
  const withoutDefaultBase = await new MP4Demuxer(await fixture('fragmented-bdo.mp4')).init();
  const a: Packet[] = [], b: Packet[] = [];
  for await (const p of withDefaultBase.packets()) {
    a.push(p);
  }
  for await (const p of withoutDefaultBase.packets()) {
    b.push(p);
  }
  assertEquals(a.length, truth.frames);
  assertEquals(b.length, truth.frames);
  assertEquals(a.map((p) => p.timestamp), b.map((p) => p.timestamp));
  assertEquals(a.map((p) => p.duration), b.map((p) => p.duration));
  assertEquals(a.map((p) => p.key), b.map((p) => p.key));
  const fileSize = (await fixture('fragmented-bdo.mp4')).size;
  for (const p of b) {
    assert(
      p.offset >= 0 && p.size > 0 && p.offset + p.size <= fileSize,
      `packet at ${p.offset}+${p.size} must lie inside the file (${fileSize})`,
    );
  }
});
Deno.test('demux: F18 — a container that declares rotation 90 via the tkhd matrix (no pixel transposed) swaps PreciseSource.info width/height', async () => {
  const d = await new MP4Demuxer(await fixture('rotated.mp4')).init();
  assertEquals(d.rotation, 90);
  assertEquals(d.width, 320); // coded/stored size is untouched by rotation metadata
  assertEquals(d.height, 240);
  const fake = installFakeDecoder();
  try {
    const source = await openMedia(await fixture('rotated.mp4'), fakeConvert as never);
    assertEquals(source.info.rotation, 90);
    assertEquals(source.info.codedWidth, 320);
    assertEquals(source.info.codedHeight, 240);
    assertEquals(source.info.width, 240); // swapped relative to codedWidth/Height
    assertEquals(source.info.height, 320);
    let count = 0;
    for await (const f of source.frames()) {
      assertEquals(f.image.width, 240);
      assertEquals(f.image.height, 320);
      count++;
    }
    assertEquals(count, truth.frames);
  } finally {
    fake.restore();
  }
});
Deno.test('demux: real recordings in test_case/ (skipped when absent) parse with ffprobe-verified facts', async () => {
  const expected: Record<string, { frames: number; width: number; height: number; keys: number; duration: number }> = {
    '0.mov': { frames: 394, width: 1418, height: 1590, keys: 7, duration: 9.788 },
    'c.mov': { frames: 170, width: 3456, height: 2234, keys: 3, duration: 3.453 },
  };
  for (const [name, facts] of Object.entries(expected)) {
    const path = new URL(`../../test_case/${name}`, import.meta.url);
    let file: Blob;
    try {
      file = (await Deno.open(path)).readable ? new File([await Deno.readFile(path)], name) : new Blob();
    } catch {
      console.log(`skip ${name}: not present`);
      continue;
    }
    const d = await new MP4Demuxer(file).init();
    assertEquals([d.width, d.height, d.frameCount], [facts.width, facts.height, facts.frames]);
    assert(Math.abs(d.duration - facts.duration) < .01);
    assert(d.config.codec.startsWith('avc1.4d00'));
    let count = 0, keys = 0, max = 0;
    const pts: number[] = [];
    for await (const p of d.packets()) {
      count++;
      if (p.key) {
        keys++;
      }
      max = Math.max(max, p.timestamp);
      pts.push(p.timestamp);
    }
    assertEquals([count, keys], [facts.frames, facts.keys]);
    assert(max / 1e6 < facts.duration + .05, `max pts ${max / 1e6}s must stay inside the recording`);
    pts.sort((a, b) => a - b);
    for (let i = 1; i < pts.length; i++) {
      assert(pts[i] > pts[i - 1], 'presentation timestamps must be distinct');
    }
    d.reader.clear();
  }
});
Deno.test('BlobReader reads bounded pages, splits boundary reads, evicts, and rejects out-of-range requests', async () => {
  class TrackedBlob extends Blob {
    reads: [number, number][] = [];
    override slice(a?: number, b?: number, type?: string): Blob {
      this.reads.push([a!, b!]);
      return super.slice(a, b, type);
    }
    override arrayBuffer(): Promise<ArrayBuffer> {
      throw new Error('whole-file read forbidden');
    }
  }
  const blob = new TrackedBlob([new Uint8Array(12 * 1024 * 1024)]), reader = new BlobReader(blob);
  await reader.read(400000, 32);
  await reader.read(400010, 16);
  await reader.read(800000, 32);
  assert(blob.reads.length <= 4);
  assert(blob.reads.every(([a, b]) => b - a <= 262144));
  assertEquals((await reader.read(262144 - 4, 8)).length, 8);
  assertEquals((await reader.read(0, 0)).length, 0);
  assertEquals((await reader.read(100, 300000)).length, 300000);
  await assertRejects(() => reader.read(-1, 4), Error, 'Truncated');
  await assertRejects(() => reader.read(blob.size - 2, 4), Error, 'Truncated');
  for (let i = 0; i < 12; i++) {
    await reader.read(i * 262144, 4);
  }
  assert(reader.bytesRead > 0);
  const small = new BlobReader(new Blob([new Uint8Array([0, 0, 0, 5, 0, 7, 255, 255, 255, 255, 255, 255, 255, 255])]));
  assertEquals(await small.u32(0), 5);
  assertEquals(await small.u16(4), 7);
  await assertRejects(() => small.u64(6), Error, 'safe-integer');
  reader.clear();
});
/** A fake WebCodecs decoder: emits frames in presentation order with controllable timestamps, sizes and failures. */
interface FakeFrame {
  timestamp: number;
  duration: number | null;
  displayWidth: number;
  displayHeight: number;
  visibleRect?: { width: number; height: number };
  codedWidth?: number;
  codedHeight?: number;
  closed: boolean;
  close(): void;
}
function installFakeDecoder(
  options: {
    reorder?: (ts: number[]) => number[];
    width?: number;
    height?: number;
    visibleRect?: [number, number];
    fail?: number;
    stall?: boolean;
    hangFlush?: boolean;
    sizes?: Record<number, [number, number]>;
    unsupported?: boolean;
  } = {},
) {
  const chunks: { timestamp: number; duration?: number; type: string }[] = [];
  const flags = { closeCalled: false };
  class FakeVideoDecoder {
    state = 'unconfigured';
    decodeQueueSize = 0;
    ondequeue: (() => void) | null = null;
    private pending: { timestamp: number; duration?: number }[] = [];
    constructor(private init: { output: (f: FakeFrame) => void; error: (e: Error) => void }) {}
    static isConfigSupported(config: { codec: string }) {
      return Promise.resolve({ supported: !options.unsupported && !config.codec.startsWith('xx'), config });
    }
    configure() {
      this.state = 'configured';
    }
    decode(chunk: { timestamp: number; duration?: number; type: string }) {
      chunks.push(chunk);
      if (options.fail !== undefined && chunks.length === options.fail) {
        this.init.error(new Error('DECODE_FAILURE: simulated codec error'));
        return;
      }
      if (options.stall) {
        return;
      }
      this.pending.push(chunk);
      this.emit(3);
    }
    /** Like WebCodecs, output is in presentation order: the reorder window releases the earliest timestamp first. */
    private emit(keep: number) {
      while (this.pending.length > keep) {
        this.pending.sort((a, b) => a.timestamp - b.timestamp);
        const c = this.pending.shift()!, size = options.sizes?.[c.timestamp] || [options.width ?? 320, options.height ?? 240];
        const frame: FakeFrame = {
          timestamp: c.timestamp,
          duration: c.duration ?? null,
          displayWidth: size[0],
          displayHeight: size[1],
          closed: false,
          close() {
            this.closed = true;
          },
        };
        if (options.visibleRect) {
          frame.visibleRect = { width: options.visibleRect[0], height: options.visibleRect[1] };
        }
        this.init.output(frame);
      }
      this.ondequeue?.();
    }
    flush() {
      if (options.hangFlush) {
        return new Promise<void>(() => {}); // a stuck decoder: this promise never settles
      }
      this.emit(0);
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      flags.closeCalled = true;
    }
  }
  const g = globalThis as unknown as Record<string, unknown>,
    previous = { VideoDecoder: g.VideoDecoder, EncodedVideoChunk: g.EncodedVideoChunk };
  g.VideoDecoder = FakeVideoDecoder;
  g.EncodedVideoChunk = class {
    constructor(public init: { timestamp: number; duration?: number; type: string; data: Uint8Array }) {
      return { ...init } as unknown as this;
    }
  };
  return {
    chunks,
    flags,
    restore: () => {
      g.VideoDecoder = previous.VideoDecoder;
      g.EncodedVideoChunk = previous.EncodedVideoChunk;
    },
  };
}
const fakeConvert = (frame: { displayWidth: number; displayHeight: number; timestamp: number }, info: MediaInfo): RGBA => ({
  width: info.width,
  height: info.height,
  data: new Uint8ClampedArray(info.width * info.height * 4).fill(frame.timestamp & 255),
});
Deno.test('source: decoding pipeline yields every packet in presentation order with pixels, durations and disposal', async () => {
  const fake = installFakeDecoder();
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    assertEquals(source.info.mode, 'Frame-accurate WebCodecs');
    assertEquals(source.info.frameCount, truth.frames);
    const times: number[] = [];
    let index = 0;
    for await (const f of source.frames()) {
      assertEquals(f.index, index++);
      assertEquals(f.image.width, 320);
      times.push(f.time);
      assert(f.duration > 0);
    }
    assertEquals(times.length, truth.frames);
    assertEquals(fake.chunks.length, truth.frames);
    assertEquals(source.info.notices, []);
    source.dispose();
  } finally {
    fake.restore();
  }
});
Deno.test('source: negative timestamps are skipped with a notice; backwards timestamps continue with a notice', async () => {
  const fake = installFakeDecoder();
  try {
    const demux = await new MP4Demuxer(await fixture('scroll.mp4')).init();
    const shifted = {
      ...demux,
      reader: demux.reader,
      config: demux.config,
      warnings: [],
      async *packets() {
        for await (const p of demux.packets()) yield { ...p, timestamp: p.timestamp - 100000 };
      },
    };
    const source = new PreciseSource(await fixture('scroll.mp4'), shifted as never, fakeConvert as never);
    let count = 0;
    for await (const _ of source.frames()) {
      count++;
    }
    assert(count < truth.frames && count > 0);
    assertEquals(source.info.notices![0].code, 'NEGATIVE_TIMESTAMP_SKIPPED');
    assertEquals(source.info.notices![0].count, truth.frames - count);
    const scrambled = {
      ...demux,
      reader: demux.reader,
      config: demux.config,
      warnings: [],
      async *packets() {
        let i = 0;
        for await (const p of demux.packets()) yield { ...p, timestamp: i++ % 7 === 6 ? p.timestamp - 200000 : p.timestamp };
      },
    };
    const second = new PreciseSource(await fixture('scroll.mp4'), scrambled as never, fakeConvert as never);
    let n = 0;
    for await (const _ of second.frames()) {
      n++;
    }
    assertEquals(n, truth.frames);
    assert(second.info.notices!.some((x) => x.code === 'NONMONOTONIC_TIMESTAMP' && x.count > 0));
  } finally {
    fake.restore();
  }
});
Deno.test('source: F20 — notices reset at the start of each frames() pass, so calling it repeatedly on one PreciseSource does not accumulate counts', async () => {
  const fake = installFakeDecoder();
  try {
    const demux = await new MP4Demuxer(await fixture('scroll.mp4')).init();
    const shifted = {
      ...demux,
      reader: demux.reader,
      config: demux.config,
      warnings: [],
      async *packets() {
        for await (const p of demux.packets()) yield { ...p, timestamp: p.timestamp - 100000 };
      },
    };
    // Engine calls frames() up to three times (scan/solve/render) on the same PreciseSource; project.media IS
    // source.info by reference, so without a reset each pass's counts would silently pile onto the last.
    const source = new PreciseSource(await fixture('scroll.mp4'), shifted as never, fakeConvert as never);
    let first = 0;
    for await (const _ of source.frames()) {
      first++;
    }
    const firstCount = source.info.notices!.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')!.count;
    assertEquals(source.info.notices!.length, 1);
    let second = 0;
    for await (const _ of source.frames()) {
      second++;
    }
    const secondCount = source.info.notices!.find((n) => n.code === 'NEGATIVE_TIMESTAMP_SKIPPED')!.count;
    assertEquals(second, first);
    assertEquals(secondCount, firstCount);
    assertEquals(source.info.notices!.length, 1);
  } finally {
    fake.restore();
  }
});
Deno.test('source: bitstream size wins over container metadata on the first frame; later geometry changes stop the run with the prefix retained', async () => {
  const fake = installFakeDecoder({ width: 322, height: 242 });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    let count = 0;
    for await (const f of source.frames()) {
      assertEquals(f.image.width, 322);
      count++;
    }
    assertEquals(count, truth.frames);
    assertEquals(source.info.width, 322);
    assertEquals(source.info.notices![0].code, 'CONTAINER_SIZE_MISMATCH');
  } finally {
    fake.restore();
  }
  const demux = await new MP4Demuxer(await fixture('scroll.mp4')).init();
  const packets = [];
  for await (const p of demux.packets()) {
    packets.push(p);
  }
  const sorted = packets.map((p) => p.timestamp).sort((a, b) => a - b);
  const later = installFakeDecoder({ sizes: { [sorted[5]]: [200, 100] } });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    let count = 0;
    await assertRejects(
      async () => {
        for await (const _ of source.frames()) count++;
      },
      Error,
      'FRAME_GEOMETRY_CHANGED',
    );
    assertEquals(count, 5);
  } finally {
    later.restore();
  }
});
Deno.test('source: F17 — non-square pixels (pasp) do not trigger CONTAINER_SIZE_MISMATCH and are reported separately; stored pixels are kept unscaled', async () => {
  // Anamorphic: the bitstream/coded picture is 320×240 (matches the container's stsd size exactly), but the
  // decoder reports a PAR-corrected display size of 480×240 (pasp ≠ 1:1). Only visibleRect — the coded picture's
  // own crop rect — should be compared against the container's declared size, not the PAR-corrected displayWidth.
  const fake = installFakeDecoder({ width: 480, height: 240, visibleRect: [320, 240] });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    let count = 0;
    for await (const f of source.frames()) {
      assertEquals(f.image.width, 320); // storage size, not the PAR-corrected display size
      assertEquals(f.image.height, 240);
      count++;
    }
    assertEquals(count, truth.frames);
    assertEquals(source.info.codedWidth, 320);
    assertEquals(source.info.width, 320);
    assert(!source.info.notices!.some((n) => n.code === 'CONTAINER_SIZE_MISMATCH'), JSON.stringify(source.info.notices));
    const nonSquare = source.info.notices!.find((n) => n.code === 'NON_SQUARE_PIXELS');
    assert(nonSquare, JSON.stringify(source.info.notices));
    assertEquals(nonSquare!.count, truth.frames);
  } finally {
    fake.restore();
  }
});
Deno.test('source: decoder errors, stalls, cancellation and missing WebCodecs are explicit', async () => {
  const failing = installFakeDecoder({ fail: 3 });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    await assertRejects(
      async () => {
        for await (const _ of source.frames()) void _;
      },
      Error,
      'DECODE_FAILURE',
    );
  } finally {
    failing.restore();
  }
  const stalled = installFakeDecoder({ stall: true });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never) as PreciseSource;
    source.stallTimeout = 150;
    await assertRejects(
      async () => {
        for await (const _ of source.frames()) void _;
      },
      Error,
      'DECODER_STALLED',
    );
  } finally {
    stalled.restore();
  }
  // F15: decoder.flush() never settling must not hang the run forever — it is raced against the stall deadline.
  const hung = installFakeDecoder({ hangFlush: true });
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never) as PreciseSource;
    source.stallTimeout = 150;
    const started = performance.now();
    await assertRejects(
      async () => {
        for await (const _ of source.frames()) void _;
      },
      Error,
      'DECODER_STALLED',
    );
    assert(performance.now() - started < 5000, 'must resolve near stallTimeout, not hang');
    assert(hung.flags.closeCalled, 'decoder.close() must be called so the orphaned flush() promise is abandoned cleanly');
  } finally {
    hung.restore();
  }
  const cancelled = installFakeDecoder();
  try {
    const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
    let count = 0;
    for await (const _ of source.frames()) {
      if (++count === 2) {
        source.dispose();
      }
    }
    assert(count < truth.frames);
  } finally {
    cancelled.restore();
  }
  const unsupported = installFakeDecoder({ unsupported: true });
  try {
    await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'UNSUPPORTED_CODEC');
  } finally {
    unsupported.restore();
  }
  const g = globalThis as unknown as Record<string, unknown>, previous = g.VideoDecoder;
  g.VideoDecoder = undefined;
  try {
    await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'WEBCODECS_UNAVAILABLE');
  } finally {
    g.VideoDecoder = previous;
  }
  const throwing = installFakeDecoder();
  (globalThis as unknown as { VideoDecoder: { isConfigSupported: () => Promise<never> } }).VideoDecoder.isConfigSupported = () =>
    Promise.reject(new Error('boom'));
  try {
    await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'Unsupported codec configuration');
  } finally {
    throwing.restore();
  }
});
Deno.test('source: Signal resolves waiters on notify and on timeout without leaking', async () => {
  const s = new Signal();
  const waited = s.wait(10000);
  s.notify();
  await waited;
  const started = performance.now();
  await s.wait(20);
  assert(performance.now() - started >= 15);
});
Deno.test('source: compatibility source samples native seeks at the configured rate and rejects geometry changes', async () => {
  const info: MediaInfo = {
    name: 'x',
    size: 1,
    width: 4,
    height: 2,
    codedWidth: 4,
    codedHeight: 2,
    rotation: 0,
    duration: .5,
    frameCount: 15,
    codec: 'native',
    mode: '',
    warnings: [],
  };
  const bitmap = (w: number, h: number) =>
    ({
      width: w,
      height: h,
      closed: false,
      close() {
        (this as { closed: boolean }).closed = true;
      },
    }) as unknown as ImageBitmap;
  const requested: number[] = [];
  const source = new CompatibilitySource(info, 10, (t) => {
    requested.push(t);
    return Promise.resolve(bitmap(4, 2));
  }, (b) => ({ width: b.width, height: b.height, data: new Uint8ClampedArray(b.width * b.height * 4) }));
  assert(info.mode.includes('10 Hz'));
  assertEquals(info.frameCount, 5, 'seek samples replace the original encoded packet count');
  let count = 0;
  for await (const f of source.frames()) {
    assertEquals(f.image.width, 4);
    assertEquals(f.duration, .1);
    count++;
  }
  assertEquals(count, 5);
  assertEquals(requested.length, 5);
  const bad = new CompatibilitySource({ ...info, notices: undefined }, 10, () => Promise.resolve(bitmap(5, 2)), () => {
    throw new Error('unreachable');
  });
  await assertRejects(
    async () => {
      for await (const _ of bad.frames()) void _;
    },
    Error,
    'FRAME_GEOMETRY_CHANGED',
  );
  const stopped = new CompatibilitySource(
    info,
    10,
    () => Promise.resolve(bitmap(4, 2)),
    () => ({ width: 4, height: 2, data: new Uint8ClampedArray(32) }),
  );
  let n = 0;
  for await (const _ of stopped.frames()) {
    n++;
    stopped.dispose();
  }
  assertEquals(n, 1);
});
Deno.test('source: canvas-backed converters require an OffscreenCanvas runtime', () => {
  const convert = canvasConverter();
  let threw = false;
  try {
    convert({} as VideoFrame, {
      name: '',
      size: 0,
      width: 2,
      height: 2,
      codedWidth: 2,
      codedHeight: 2,
      rotation: 0,
      duration: 0,
      codec: '',
      mode: '',
      warnings: [],
    });
  } catch {
    threw = true;
  }
  assert(threw, 'no OffscreenCanvas in Deno');
  const read = bitmapReader();
  let readThrew = false;
  try {
    read({ width: 1, height: 1 } as ImageBitmap);
  } catch {
    readThrew = true;
  }
  assert(readThrew);
});
// R3-2: explicit-release conversion buffer pool (src/media/pool.ts). No fixed rotation — a buffer comes back
// ONLY when its holder calls release(), and an unreleased buffer is never handed out again (the worst case is
// today's allocate-per-frame, never silent corruption of a still-live buffer).
Deno.test('BufferPool: without release, every take() gets a fresh buffer; outstanding tracks the unreleased count', () => {
  const pool = new BufferPool();
  const a = pool.take(2, 2), b = pool.take(2, 2);
  assertEquals(pool.outstanding, 2);
  assert(a.data.buffer !== b.data.buffer, 'two live buffers must never alias');
  a.data[0] = 7;
  b.data[0] = 9;
  assertEquals(a.data[0], 7, 'writing through one buffer must not touch the other');
});
Deno.test('BufferPool: release() returns the buffer to the pool, and only the next take() reuses it', () => {
  const pool = new BufferPool();
  const a = pool.take(4, 4);
  const buffer = a.data.buffer;
  a.release();
  assertEquals(pool.outstanding, 0);
  const b = pool.take(4, 4);
  assertEquals(pool.outstanding, 1);
  assert(b.data.buffer === buffer, 'a released buffer must be the next one handed out');
  // release() is idempotent: a double release must not hand the same live buffer out twice.
  a.release();
  a.release();
  assertEquals(pool.outstanding, 1, 'double-releasing an already-released buffer must not double the free count');
});
Deno.test('BufferPool: a buffer released after a geometry change is dropped, not handed out at the wrong size', () => {
  const pool = new BufferPool();
  const a = pool.take(4, 4);
  a.release();
  const b = pool.take(8, 8); // different byte length: the 4×4 free list is discarded, not reused wrong-sized.
  assertEquals(b.data.length, 8 * 8 * 4);
  b.release();
  const c = pool.take(8, 8);
  assertEquals(c.data.length, 8 * 8 * 4);
});
Deno.test('releaseUnlessHeld: releases only when the image is not aliased by another live holder', () => {
  const pool = new BufferPool();
  const shared = pool.take(2, 2); // e.g. scan's previousImage and baseline.image pointing at the same frame
  releaseUnlessHeld(shared, shared); // still held by "the other field" — must not go back to the pool
  assertEquals(pool.outstanding, 1);
  releaseUnlessHeld(shared); // no longer held anywhere — now it may return
  assertEquals(pool.outstanding, 0);
});
Deno.test('releaseUnlessHeld: a no-op on an image with no release() (e.g. the compatibility source, or undefined)', () => {
  releaseUnlessHeld(undefined);
  releaseUnlessHeld({ width: 1, height: 1, data: new Uint8ClampedArray(4) } as RGBA);
});
