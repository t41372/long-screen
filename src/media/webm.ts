import { BlobReader, type Demuxer, type Packet } from './reader.ts';
interface Element {
    id: number;
    start: number;
    data: number;
    end: number;
    unknown: boolean;
}
async function vint(r: BlobReader, p: number, id = false): Promise<{
    value: number;
    length: number;
    unknown: boolean;
}> {
    const first = (await r.read(p, 1))[0];
    let length = 1, mask = 128;
    while (length <= 8 && !(first & mask)) {
        length++;
        mask >>= 1;
    }
    if (length > 8 || (id && length > 4))
        throw new Error('Invalid EBML variable-length integer.');
    const a = await r.read(p, length);
    let value = id ? first : first & (mask - 1), unknown = !id && (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < length; i++) {
        value = value * 256 + a[i];
        unknown = unknown && a[i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value))
        throw new Error('EBML element exceeds safe integer precision.');
    return { value, length, unknown };
}
async function element(r: BlobReader, p: number, end = r.file.size): Promise<Element> {
    const id = await vint(r, p, true), size = await vint(r, p + id.length), data = p + id.length + size.length;
    if (!size.unknown && data + size.value > end)
        throw new Error('Truncated WebM element.');
    return { id: id.value, start: p, data, end: size.unknown ? end : data + size.value, unknown: size.unknown };
}
async function uint(r: BlobReader, e: Element): Promise<number> { const a = await r.read(e.data, e.end - e.data); if (a.length > 8)
    throw new Error('Oversized EBML integer.'); let n = 0; for (const b of a)
    n = n * 256 + b; return n; }
async function* elements(r: BlobReader, p: number, end: number): AsyncGenerator<Element> { while (p < end) {
    const e = await element(r, p, end);
    yield e;
    if (e.unknown)
        break;
    p = e.end;
} }
export class WebMDemuxer implements Demuxer {
    reader: BlobReader;
    config!: VideoDecoderConfig;
    width = 0;
    height = 0;
    rotation = 0;
    duration = 0;
    warnings: string[] = [];
    frameCount?: number;
    private segment!: Element;
    private track = 1;
    private scale = 1000000;
    private defaultDuration = 0;
    constructor(file: Blob) { this.reader = new BlobReader(file); }
    async init(): Promise<this> {
        const r = this.reader;
        let segment: Element | undefined;
        for await (const e of elements(r, 0, r.file.size))
            if (e.id === 0x18538067) {
                segment = e;
                break;
            }
        if (!segment)
            throw new Error('Missing WebM segment.');
        this.segment = segment;
        let found = false, codec = '', description: Uint8Array | undefined;
        for await (const e of elements(r, segment.data, segment.end)) {
            if (e.id === 0x1549a966) {
                for await (const c of elements(r, e.data, e.end)) {
                    if (c.id === 0x2ad7b1)
                        this.scale = await uint(r, c);
                    if (c.id === 0x4489) {
                        const v = await r.view(c.data, c.end - c.data);
                        this.duration = v.byteLength === 4 ? v.getFloat32(0) : v.getFloat64(0);
                    }
                }
            }
            if (e.id === 0x1654ae6b) {
                for await (const entry of elements(r, e.data, e.end))
                    if (entry.id === 0xae) {
                        let number = 0, type = 0, id = '', priv: Uint8Array | undefined, w = 0, h = 0, defaultDuration = 0;
                        for await (const c of elements(r, entry.data, entry.end)) {
                            if (c.id === 0xd7)
                                number = await uint(r, c);
                            if (c.id === 0x83)
                                type = await uint(r, c);
                            if (c.id === 0x86)
                                id = new TextDecoder().decode(await r.read(c.data, c.end - c.data));
                            if (c.id === 0x63a2)
                                priv = (await r.read(c.data, c.end - c.data)).slice();
                            if (c.id === 0x23e383)
                                defaultDuration = await uint(r, c);
                            if (c.id === 0xe0)
                                for await (const v of elements(r, c.data, c.end)) {
                                    if (v.id === 0xb0)
                                        w = await uint(r, v);
                                    if (v.id === 0xba)
                                        h = await uint(r, v);
                                }
                            if (c.id === 0x6d80)
                                this.warnings.push('Track content encodings are present; encrypted/compressed tracks may not decode.');
                        }
                        if (type === 1 && !found) {
                            this.track = number;
                            this.width = w;
                            this.height = h;
                            this.defaultDuration = defaultDuration;
                            codec = id;
                            description = priv;
                            found = true;
                        }
                    }
            }
            if (found && e.id === 0x1f43b675)
                break;
        }
        if (!found)
            throw new Error('WebM contains no video track.');
        const mapping: Record<string, string> = { 'V_VP8': 'vp8', 'V_VP9': 'vp09.00.10.08', 'V_AV1': 'av01.0.04M.08' };
        let codecString = mapping[codec];
        if (codec === 'V_MPEG4/ISO/AVC' && description)
            codecString = `avc1.${[...description.subarray(1, 4)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
        if (!codecString)
            throw new Error(`Unsupported Matroska codec ${codec}. Compatibility mode may support it.`);
        this.config = { codec: codecString, codedWidth: this.width, codedHeight: this.height };
        if (codec === 'V_MPEG4/ISO/AVC' && description)
            this.config.description = description;
        this.duration *= this.scale / 1e9;
        let count = 0, end = 0;
        for await (const p of this.packets()) {
            count++;
            end = Math.max(end, (p.timestamp + p.duration) / 1e6);
        }
        this.frameCount = count;
        this.duration = Math.max(this.duration, end);
        return this;
    }
    async *packets(): AsyncGenerator<Packet> {
        const r = this.reader;
        let p = this.segment.data, clusterTime = 0, inUnknownCluster = false;
        while (p < this.segment.end) {
            const e = await element(r, p, this.segment.end);
            if (e.id === 0x1f43b675) {
                if (e.unknown) {
                    inUnknownCluster = true;
                    clusterTime = 0;
                    p = e.data;
                    continue;
                }
                let time = 0;
                for await (const c of elements(r, e.data, e.end)) {
                    if (c.id === 0xe7)
                        time = await uint(r, c);
                    if (c.id === 0xa3)
                        yield* this.block(c, time, undefined);
                    if (c.id === 0xa0)
                        yield* this.group(c, time);
                }
            }
            else if (inUnknownCluster) {
                if (e.id === 0xe7)
                    clusterTime = await uint(r, e);
                if (e.id === 0xa3)
                    yield* this.block(e, clusterTime, undefined);
                if (e.id === 0xa0)
                    yield* this.group(e, clusterTime);
            }
            if (e.unknown)
                throw new Error('Unsupported unknown-length EBML element.');
            p = e.end;
        }
    }
    private async *group(e: Element, time: number): AsyncGenerator<Packet> {
        let block: Element | undefined, reference = false, duration = 0;
        for await (const c of elements(this.reader, e.data, e.end)) {
            if (c.id === 0xa1)
                block = c;
            if (c.id === 0xfb)
                reference = true;
            if (c.id === 0x9b)
                duration = await uint(this.reader, c);
        }
        if (block)
            yield* this.block(block, time, !reference, duration);
    }
    private async *block(e: Element, time: number, groupKey?: boolean, blockDuration = 0): AsyncGenerator<Packet> {
        const r = this.reader, t = await vint(r, e.data);
        if (t.value !== this.track)
            return;
        const h = await r.view(e.data + t.length, 3), relative = h.getInt16(0), flags = h.getUint8(2), lace = (flags >> 1) & 3;
        let p = e.data + t.length + 3, count = 1;
        const sizes: number[] = [];
        if (lace) {
            count = (await r.read(p++, 1))[0] + 1;
            if (lace === 1) {
                for (let i = 0; i < count - 1; i++) {
                    let size = 0, b = 255;
                    while (b === 255) {
                        b = (await r.read(p++, 1))[0];
                        size += b;
                    }
                    sizes.push(size);
                }
            }
            else if (lace === 2) {
                const total = e.end - p;
                if (total % count)
                    throw new Error('Invalid fixed-size WebM lacing.');
                for (let i = 0; i < count - 1; i++)
                    sizes.push(total / count);
            }
            else if (lace === 3) {
                const first = await vint(r, p);
                p += first.length;
                sizes.push(first.value);
                for (let i = 1; i < count - 1; i++) {
                    const v = await vint(r, p);
                    p += v.length;
                    const signed = v.value - (2 ** (7 * v.length - 1) - 1);
                    sizes.push(sizes[i - 1] + signed);
                }
            }
        }
        sizes.push(e.end - p - sizes.reduce((s, x) => s + x, 0));
        const duration = blockDuration ? Math.round(blockDuration * this.scale / 1000 / count) : Math.round(this.defaultDuration / 1000);
        for (let i = 0; i < count; i++) {
            const size = sizes[i];
            if (size < 0 || p + size > e.end)
                throw new Error('Invalid WebM lace length.');
            yield { offset: p, size, timestamp: Math.round((time + relative) * this.scale / 1000 + i * duration), duration, key: groupKey ?? !!(flags & 128) };
            p += size;
        }
    }
}
