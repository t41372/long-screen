/** Random-access Blob reader; at most eight 256-KiB pages, never file.arrayBuffer(). */
export class BlobReader {
    private pages = new Map<number, Uint8Array>();
    bytesRead = 0;
    constructor(readonly file: Blob, readonly pageSize = 262144, readonly maxPages = 8) { }
    async read(offset: number, length: number): Promise<Uint8Array> {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.file.size)
            throw new Error(`Truncated media: bytes ${offset}..${offset + length} exceed ${this.file.size}.`);
        if (length === 0)
            return new Uint8Array();
        if (length > this.pageSize) {
            this.bytesRead += length;
            return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
        }
        const start = Math.floor(offset / this.pageSize) * this.pageSize;
        if (offset + length > start + this.pageSize) {
            const a = await this.read(offset, start + this.pageSize - offset), b = await this.read(start + this.pageSize, length - a.length), out = new Uint8Array(length);
            out.set(a);
            out.set(b, a.length);
            return out;
        }
        let page = this.pages.get(start);
        if (!page) {
            page = new Uint8Array(await this.file.slice(start, Math.min(this.file.size, start + this.pageSize)).arrayBuffer());
            this.bytesRead += page.length;
            this.pages.set(start, page);
        }
        else {
            this.pages.delete(start);
            this.pages.set(start, page);
        }
        while (this.pages.size > this.maxPages)
            this.pages.delete(this.pages.keys().next().value!);
        return page.subarray(offset - start, offset - start + length);
    }
    async view(offset: number, length: number): Promise<DataView> { const a = await this.read(offset, length); return new DataView(a.buffer, a.byteOffset, a.byteLength); }
    async u32(offset: number): Promise<number> { return (await this.view(offset, 4)).getUint32(0); }
    async u16(offset: number): Promise<number> { return (await this.view(offset, 2)).getUint16(0); }
    async u64(offset: number): Promise<number> { const v = (await this.view(offset, 8)).getBigUint64(0); if (v > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('Media offset exceeds JavaScript safe-integer precision.'); return Number(v); }
    clear(): void { this.pages.clear(); }
}
export interface Packet {
    offset: number;
    size: number;
    timestamp: number;
    duration: number;
    key: boolean;
}
export interface Demuxer {
    reader: BlobReader;
    config: VideoDecoderConfig;
    width: number;
    height: number;
    rotation: number;
    duration: number;
    frameCount?: number;
    warnings: string[];
    packets(): AsyncGenerator<Packet>;
}
