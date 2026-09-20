import { assert, assertEquals, assertRejects } from '@std/assert';
import { BlobReader, type Packet } from '../../src/media/reader.ts';
import { MP4Demuxer } from '../../src/media/mp4.ts';
import { WebMDemuxer } from '../../src/media/webm.ts';
import { bitmapReader, canvasConverter, CompatibilitySource, openDemuxer, openMedia, PreciseSource, Signal } from '../../src/media/source.ts';
import type { MediaInfo, RGBA } from '../../src/types.ts';
const fixtures = new URL('../fixtures/', import.meta.url);
const truth = JSON.parse(await Deno.readTextFile(new URL('truth.json', fixtures)));
async function fixture(name: string): Promise<File> {
    return new File([await Deno.readFile(new URL(name, fixtures))], name);
}
for (const name of ['scroll.mp4', 'scroll.mov', 'fragmented.mp4', 'scroll.webm', 'negative-cts.mov', 'negative-cts-v0.mov'])
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
        const ordered = packets.map(p => p.timestamp).sort((a, b) => a - b);
        const expectedStart = name === 'fragmented.mp4' ? 2e6 / 30 : 0;
        assert(Math.abs(ordered[0] - expectedStart) < 1000, `first pts ${ordered[0]}`);
        assert(Math.abs(ordered[ordered.length - 1] - expectedStart - (truth.frames - 1) * 1e6 / 30) < 1500, `last pts ${ordered[ordered.length - 1]}`);
        assert(d.duration > 1.3 && d.duration < 1.6, `duration ${d.duration}`);
        // Distinct, strictly increasing presentation timestamps: nothing 7,158,278 seconds away.
        for (let i = 1; i < ordered.length; i++)
            assert(ordered[i] > ordered[i - 1] && ordered[i] < 10e6, `pts ${ordered[i]}`);
        assertEquals(d.frameCount, truth.frames);
        if (name.startsWith('negative'))
            assert(packets.some((p, i) => i > 0 && p.timestamp < packets[i - 1].timestamp), 'negative composition offsets must reorder packets');
    });
Deno.test('demux: ReplayKit-style version-0 ctts yields the same timeline as the signed version-1 box', async () => {
    const a = await new MP4Demuxer(await fixture('negative-cts.mov')).init(), b = await new MP4Demuxer(await fixture('negative-cts-v0.mov')).init();
    const ta: number[] = [], tb: number[] = [];
    for await (const p of a.packets())
        ta.push(p.timestamp);
    for await (const p of b.packets())
        tb.push(p.timestamp);
    assertEquals(ta, tb);
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
Deno.test('demux: real recordings in test_case/ (skipped when absent) parse with ffprobe-verified facts', async () => {
    const expected: Record<string, { frames: number; width: number; height: number; keys: number; duration: number }> = { '0.mov': { frames: 394, width: 1418, height: 1590, keys: 7, duration: 9.788 }, 'c.mov': { frames: 170, width: 3456, height: 2234, keys: 3, duration: 3.453 } };
    for (const [name, facts] of Object.entries(expected)) {
        const path = new URL(`../../test_case/${name}`, import.meta.url);
        let file: Blob;
        try {
            file = (await Deno.open(path)).readable ? new File([await Deno.readFile(path)], name) : new Blob();
        }
        catch {
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
            if (p.key)
                keys++;
            max = Math.max(max, p.timestamp);
            pts.push(p.timestamp);
        }
        assertEquals([count, keys], [facts.frames, facts.keys]);
        assert(max / 1e6 < facts.duration + .05, `max pts ${max / 1e6}s must stay inside the recording`);
        pts.sort((a, b) => a - b);
        for (let i = 1; i < pts.length; i++)
            assert(pts[i] > pts[i - 1], 'presentation timestamps must be distinct');
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
    for (let i = 0; i < 12; i++)
        await reader.read(i * 262144, 4);
    assert(reader.bytesRead > 0);
    const small = new BlobReader(new Blob([new Uint8Array([0, 0, 0, 5, 0, 7, 255, 255, 255, 255, 255, 255, 255, 255])]));
    assertEquals(await small.u32(0), 5);
    assertEquals(await small.u16(4), 7);
    await assertRejects(() => small.u64(6), Error, 'safe-integer');
    reader.clear();
});
/** A fake WebCodecs decoder: emits frames in presentation order with controllable timestamps, sizes and failures. */
interface FakeFrame { timestamp: number; duration: number | null; displayWidth: number; displayHeight: number; closed: boolean; close(): void }
function installFakeDecoder(options: { reorder?: (ts: number[]) => number[]; width?: number; height?: number; fail?: number; stall?: boolean; sizes?: Record<number, [number, number]>; unsupported?: boolean } = {}) {
    const chunks: { timestamp: number; duration?: number; type: string }[] = [];
    class FakeVideoDecoder {
        state = 'unconfigured';
        decodeQueueSize = 0;
        ondequeue: (() => void) | null = null;
        private pending: { timestamp: number; duration?: number }[] = [];
        constructor(private init: { output: (f: FakeFrame) => void; error: (e: Error) => void }) { }
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
            if (options.stall)
                return;
            this.pending.push(chunk);
            this.emit(3);
        }
        /** Like WebCodecs, output is in presentation order: the reorder window releases the earliest timestamp first. */
        private emit(keep: number) {
            while (this.pending.length > keep) {
                this.pending.sort((a, b) => a.timestamp - b.timestamp);
                const c = this.pending.shift()!, size = options.sizes?.[c.timestamp] || [options.width ?? 320, options.height ?? 240];
                const frame: FakeFrame = { timestamp: c.timestamp, duration: c.duration ?? null, displayWidth: size[0], displayHeight: size[1], closed: false, close() { this.closed = true; } };
                this.init.output(frame);
            }
            this.ondequeue?.();
        }
        flush() {
            this.emit(0);
            return Promise.resolve();
        }
        close() {
            this.state = 'closed';
        }
    }
    const g = globalThis as unknown as Record<string, unknown>, previous = { VideoDecoder: g.VideoDecoder, EncodedVideoChunk: g.EncodedVideoChunk };
    g.VideoDecoder = FakeVideoDecoder;
    g.EncodedVideoChunk = class { constructor(public init: { timestamp: number; duration?: number; type: string; data: Uint8Array }) { return { ...init } as unknown as this; } };
    return { chunks, restore: () => { g.VideoDecoder = previous.VideoDecoder; g.EncodedVideoChunk = previous.EncodedVideoChunk; } };
}
const fakeConvert = (frame: { displayWidth: number; displayHeight: number; timestamp: number }, info: MediaInfo): RGBA => ({ width: info.width, height: info.height, data: new Uint8ClampedArray(info.width * info.height * 4).fill(frame.timestamp & 255) });
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
    }
    finally {
        fake.restore();
    }
});
Deno.test('source: negative timestamps are skipped with a notice; backwards timestamps continue with a notice', async () => {
    const fake = installFakeDecoder();
    try {
        const demux = await new MP4Demuxer(await fixture('scroll.mp4')).init();
        const shifted = { ...demux, reader: demux.reader, config: demux.config, warnings: [], async *packets() { for await (const p of demux.packets()) yield { ...p, timestamp: p.timestamp - 100000 }; } };
        const source = new PreciseSource(await fixture('scroll.mp4'), shifted as never, fakeConvert as never);
        let count = 0;
        for await (const _ of source.frames())
            count++;
        assert(count < truth.frames && count > 0);
        assertEquals(source.info.notices![0].code, 'NEGATIVE_TIMESTAMP_SKIPPED');
        assertEquals(source.info.notices![0].count, truth.frames - count);
        const scrambled = { ...demux, reader: demux.reader, config: demux.config, warnings: [], async *packets() { let i = 0; for await (const p of demux.packets()) yield { ...p, timestamp: i++ % 7 === 6 ? p.timestamp - 200000 : p.timestamp }; } };
        const second = new PreciseSource(await fixture('scroll.mp4'), scrambled as never, fakeConvert as never);
        let n = 0;
        for await (const _ of second.frames())
            n++;
        assertEquals(n, truth.frames);
        assert(second.info.notices!.some(x => x.code === 'NONMONOTONIC_TIMESTAMP' && x.count > 0));
    }
    finally {
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
    }
    finally {
        fake.restore();
    }
    const demux = await new MP4Demuxer(await fixture('scroll.mp4')).init();
    const packets = [];
    for await (const p of demux.packets())
        packets.push(p);
    const sorted = packets.map(p => p.timestamp).sort((a, b) => a - b);
    const later = installFakeDecoder({ sizes: { [sorted[5]]: [200, 100] } });
    try {
        const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
        let count = 0;
        await assertRejects(async () => { for await (const _ of source.frames()) count++; }, Error, 'FRAME_GEOMETRY_CHANGED');
        assertEquals(count, 5);
    }
    finally {
        later.restore();
    }
});
Deno.test('source: decoder errors, stalls, cancellation and missing WebCodecs are explicit', async () => {
    const failing = installFakeDecoder({ fail: 3 });
    try {
        const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
        await assertRejects(async () => { for await (const _ of source.frames()) void _; }, Error, 'DECODE_FAILURE');
    }
    finally {
        failing.restore();
    }
    const stalled = installFakeDecoder({ stall: true });
    try {
        const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never) as PreciseSource;
        source.stallTimeout = 150;
        await assertRejects(async () => { for await (const _ of source.frames()) void _; }, Error, 'DECODER_STALLED');
    }
    finally {
        stalled.restore();
    }
    const cancelled = installFakeDecoder();
    try {
        const source = await openMedia(await fixture('scroll.mp4'), fakeConvert as never);
        let count = 0;
        for await (const _ of source.frames()) {
            if (++count === 2)
                source.dispose();
        }
        assert(count < truth.frames);
    }
    finally {
        cancelled.restore();
    }
    const unsupported = installFakeDecoder({ unsupported: true });
    try {
        await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'UNSUPPORTED_CODEC');
    }
    finally {
        unsupported.restore();
    }
    const g = globalThis as unknown as Record<string, unknown>, previous = g.VideoDecoder;
    g.VideoDecoder = undefined;
    try {
        await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'WEBCODECS_UNAVAILABLE');
    }
    finally {
        g.VideoDecoder = previous;
    }
    const throwing = installFakeDecoder();
    (globalThis as unknown as { VideoDecoder: { isConfigSupported: () => Promise<never> } }).VideoDecoder.isConfigSupported = () => Promise.reject(new Error('boom'));
    try {
        await assertRejects(async () => openMedia(await fixture('scroll.mp4'), fakeConvert as never), Error, 'Unsupported codec configuration');
    }
    finally {
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
    const info: MediaInfo = { name: 'x', size: 1, width: 4, height: 2, codedWidth: 4, codedHeight: 2, rotation: 0, duration: .5, codec: 'native', mode: '', warnings: [] };
    const bitmap = (w: number, h: number) => ({ width: w, height: h, closed: false, close() { (this as { closed: boolean }).closed = true; } }) as unknown as ImageBitmap;
    const requested: number[] = [];
    const source = new CompatibilitySource(info, 10, (t) => { requested.push(t); return Promise.resolve(bitmap(4, 2)); }, (b) => ({ width: b.width, height: b.height, data: new Uint8ClampedArray(b.width * b.height * 4) }));
    assert(info.mode.includes('10 Hz'));
    let count = 0;
    for await (const f of source.frames()) {
        assertEquals(f.image.width, 4);
        assertEquals(f.duration, .1);
        count++;
    }
    assertEquals(count, 5);
    assertEquals(requested.length, 5);
    const bad = new CompatibilitySource({ ...info, notices: undefined }, 10, () => Promise.resolve(bitmap(5, 2)), () => { throw new Error('unreachable'); });
    await assertRejects(async () => { for await (const _ of bad.frames()) void _; }, Error, 'FRAME_GEOMETRY_CHANGED');
    const stopped = new CompatibilitySource(info, 10, () => Promise.resolve(bitmap(4, 2)), () => ({ width: 4, height: 2, data: new Uint8ClampedArray(32) }));
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
        convert({} as VideoFrame, { name: '', size: 0, width: 2, height: 2, codedWidth: 2, codedHeight: 2, rotation: 0, duration: 0, codec: '', mode: '', warnings: [] });
    }
    catch {
        threw = true;
    }
    assert(threw, 'no OffscreenCanvas in Deno');
    const read = bitmapReader();
    let readThrew = false;
    try {
        read({ width: 1, height: 1 } as ImageBitmap);
    }
    catch {
        readThrew = true;
    }
    assert(readThrew);
});
