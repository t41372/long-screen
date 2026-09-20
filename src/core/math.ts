import type { Rect, Point } from '../types.ts';
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const median = (values: number[]): number => {
    if (!values.length)
        return 0;
    const a = values.slice().sort((x, y) => x - y), m = a.length >> 1;
    return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const norm = (p: Point): number => Math.hypot(p.x, p.y);
export function union(a: Rect, b: Rect): Rect {
    if (a.width <= 0 || a.height <= 0)
        return { ...b };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
export function intersect(a: Rect, b: Rect): Rect {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
export const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
export const pad = (n: number): string => String(n).padStart(10, '0');
export function rng(seed = 0x9e3779b9): () => number {
    let x = seed | 0;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
export function popcount(v: number): number {
    v -= ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function hamming(a: Uint32Array, b: Uint32Array, limit = 257): number {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        d += popcount(a[i] ^ b[i]);
        if (d > limit)
            break;
    }
    return d;
}
export class DisjointSet {
    parent: Int32Array;
    size: Int32Array;
    constructor(n: number) { this.parent = Int32Array.from({ length: n }, (_, i) => i); this.size = new Int32Array(n).fill(1); }
    find(i: number): number { let r = i; while (this.parent[r] !== r)
        r = this.parent[r]; while (this.parent[i] !== i) {
        const next = this.parent[i];
        this.parent[i] = r;
        i = next;
    } return r; }
    join(a: number, b: number): void { a = this.find(a); b = this.find(b); if (a === b)
        return; if (this.size[a] < this.size[b])
        [a, b] = [b, a]; this.parent[b] = a; this.size[a] += this.size[b]; }
}
