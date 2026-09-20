import { assert, assertEquals, assertRejects } from '@std/assert';
import { decodePNG, encodePNG, encodeRGBA } from '../../src/codec/png.ts';
import { CRC32, crc32, utf8 } from '../../src/export/crc.ts';
import { blobChunks, single, ZipWriter } from '../../src/export/zip.ts';
import { MemoryKV } from '../../src/storage/db.ts';
import { rng } from '../../src/core/math.ts';
import type { RGBA } from '../../src/types.ts';
function chunk(type: string, body: Uint8Array): Uint8Array {
    const name = utf8(type), out = new Uint8Array(body.length + 12), view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(name, 4);
    out.set(body, 8);
    const crc = new CRC32();
    crc.update(name);
    crc.update(body);
    view.setUint32(body.length + 8, crc.digest());
    return out;
}
async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new CompressionStream('deflate'), writer = stream.writable.getWriter();
    const done = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
    const parts: Uint8Array[] = [];
    for await (const part of stream.readable)
        parts.push(part);
    await done;
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
/** Builds a PNG by hand with a chosen colour type / filter so the decoder's every branch is exercised against known pixels. */
async function handmade(width: number, height: number, colour: 0 | 2 | 4 | 6, filter: number, depth = 8, interlace = 0, corruptCrc = false, declaredHeight = height): Promise<{ bytes: Uint8Array; expected: Uint8ClampedArray }> {
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour], random = rng(colour * 31 + filter), stride = width * channels;
    const raw = new Uint8Array(stride * height), rows: Uint8Array[] = [], expected = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = Uint8Array.from({ length: stride }, () => Math.floor(random() * 256));
        rows.push(row);
        for (let x = 0; x < width; x++) {
            const i = x * channels, o = (y * width + x) * 4;
            if (channels >= 3)
                expected.set([row[i], row[i + 1], row[i + 2], channels === 4 ? row[i + 3] : 255], o);
            else
                expected.set([row[i], row[i], row[i], channels === 2 ? row[i + 1] : 255], o);
        }
    }
    const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    const filtered = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = rows[y], prev = y ? rows[y - 1] : new Uint8Array(stride);
        filtered[y * (stride + 1)] = filter;
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? row[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
            let v = row[i];
            if (filter === 1)
                v -= a;
            else if (filter === 2)
                v -= b;
            else if (filter === 3)
                v -= (a + b) >> 1;
            else if (filter === 4)
                v -= paeth(a, b, c);
            filtered[y * (stride + 1) + 1 + i] = v & 255;
        }
        raw.set(row, y * stride);
    }
    const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, declaredHeight);
    ihdr[8] = depth;
    ihdr[9] = colour;
    ihdr[12] = interlace;
    const idat = chunk('IDAT', await deflate(filtered));
    if (corruptCrc)
        idat[idat.length - 1] ^= 0xff;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', utf8('comment')), idat, chunk('IEND', new Uint8Array())];
    const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
    }
    return { bytes, expected };
}
Deno.test('png: lossless RGBA round trip through the shipped encoder and decoder, including transparent holes', async () => {
    const width = 37, height = 53, random = rng(3), image: RGBA = { width, height, data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? (Math.floor(i / 4 / width) < 10 ? 0 : 255) : Math.floor(random() * 256)) };
    const bytes = await encodeRGBA(image);
    assertEquals([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const decoded = await decodePNG(bytes);
    assertEquals(decoded.width, width);
    assertEquals(decoded.height, height);
    assertEquals(decoded.data, image.data);
});
Deno.test('png: every filter type and colour type decodes to known pixels', async () => {
    for (const colour of [0, 2, 4, 6] as const)
        for (const filter of [0, 1, 2, 3, 4]) {
            const { bytes, expected } = await handmade(11, 7, colour, filter);
            const decoded = await decodePNG(bytes);
            assertEquals(decoded.data, expected, `colour ${colour} filter ${filter}`);
        }
});
Deno.test('png: malformed or unsupported input is rejected explicitly', async () => {
    await assertRejects(() => decodePNG(new Uint8Array([1, 2, 3])), Error, 'Not a PNG');
    await assertRejects(async () => decodePNG((await handmade(4, 4, 6, 0, 8, 0, true)).bytes), Error, 'CRC');
    await assertRejects(async () => decodePNG((await handmade(4, 4, 6, 0, 16)).bytes), Error, 'Unsupported');
    await assertRejects(async () => decodePNG((await handmade(4, 4, 6, 0, 8, 1)).bytes), Error, 'Unsupported');
    const { bytes } = await handmade(4, 4, 6, 0);
    await assertRejects(() => decodePNG(bytes.subarray(0, bytes.length - 2)), Error, 'Truncated');
    await assertRejects(() => decodePNG(bytes.subarray(0, bytes.length - 12)), Error, 'missing');
    await assertRejects(async () => decodePNG((await handmade(4, 4, 6, 7)).bytes), Error, 'Invalid PNG filter');
    await assertRejects(async () => decodePNG((await handmade(4, 4, 6, 0, 8, 0, false, 5)).bytes), Error, 'expected');
});
Deno.test('png: streaming encoder validates dimensions and row counts', async () => {
    await assertRejects(async () => { for await (const _ of encodePNG(0, 1, [])) void _; }, Error, 'Invalid PNG dimensions');
    await assertRejects(async () => { for await (const _ of encodePNG(4, 2, [new Uint8Array(16)])) void _; }, Error, 'Expected 2 PNG rows');
    await assertRejects(async () => { for await (const _ of encodePNG(4, 1, [new Uint8Array(3)])) void _; }, Error, 'incorrect byte length');
    await assertRejects(() => encodeRGBA({ width: 2, height: 2, data: new Uint8ClampedArray(3) }), Error, 'does not match');
    async function* rows() { yield new Uint8Array(16); yield new Uint8Array(16); }
    let count = 0;
    for await (const part of encodePNG(4, 2, rows())) {
        assert(part.length > 0);
        count++;
    }
    assert(count >= 4);
    // Early consumer exit cancels the deflate stream without leaking.
    const it = encodePNG(4, 2, rows());
    await it.next();
    await it.return(undefined);
});
Deno.test('crc32 matches the standard check vector and the convenience wrapper', () => {
    const crc = new CRC32();
    crc.update(utf8('123456789'));
    assertEquals(crc.digest(), 0xcbf43926);
    assertEquals(crc32(utf8('123456789')), 0xcbf43926);
});
Deno.test('zip: streaming ZIP64 writes valid records, UTF-8 names, spools the directory to storage and cleans up', async () => {
    const parts: Uint8Array[] = [], db = new MemoryKV(), sink = { write: async (data: Uint8Array) => { parts.push(data.slice()); }, close: async () => { } };
    const zip = new ZipWriter(sink, db);
    await zip.add('你好.txt', utf8('canvas\n'));
    await zip.add('transparent.bin', new Blob([new Uint8Array([0, 1, 2, 3])]));
    async function* stream() { yield new Uint8Array([9]); yield new Uint8Array([8, 7]); }
    await zip.add('stream.bin', stream());
    assertEquals((await db.scan('export-index/')).length, 3);
    await zip.finish();
    assertEquals((await db.scan('export-index/')).length, 0);
    const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
    }
    const view = new DataView(bytes.buffer);
    assertEquals(view.getUint32(0, true), 0x04034b50);
    assertEquals(view.getUint16(6, true), 0x808);
    assertEquals(view.getUint32(bytes.length - 22, true), 0x06054b50);
    assertEquals(view.getUint32(bytes.length - 42, true), 0x07064b50);
    const at = Number(view.getBigUint64(bytes.length - 34, true));
    assertEquals(view.getUint32(at, true), 0x06064b50);
    assertEquals(Number(view.getBigUint64(at + 32, true)), 3);
    const cd = Number(view.getBigUint64(at + 48, true));
    assertEquals(view.getUint32(cd, true), 0x02014b50);
    const chunks: Uint8Array[] = [];
    for await (const c of blobChunks(new Blob([new Uint8Array([1, 2]), new Uint8Array([3])])))
        chunks.push(c);
    assertEquals(chunks.reduce((s, c) => s + c.length, 0), 3);
    const one: Uint8Array[] = [];
    for await (const c of single(new Uint8Array([5])))
        one.push(c);
    assertEquals(one.length, 1);
});
