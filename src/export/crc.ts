const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  table[n] = c >>> 0;
}
export class CRC32 {
  private value = 0xffffffff;
  update(data: Uint8Array): void {
    for (const b of data) {
      this.value = table[(this.value ^ b) & 255] ^ (this.value >>> 8);
    }
  }
  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}
export function crc32(data: Uint8Array): number {
  const c = new CRC32();
  c.update(data);
  return c.digest();
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
