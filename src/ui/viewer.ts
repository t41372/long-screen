import type { CanvasMeta, Rect, TilePayload } from '../types.ts';
interface Cached {
    bitmap: ImageBitmap | null;
    quality?: Uint8Array;
    conflicts?: Uint8Array;
    time: number;
}
export class TiledViewer {
    private ctx: CanvasRenderingContext2D;
    private cache = new Map<string, Cached>();
    private loading = new Set<string>();
    private generation = 0;
    private pointers = new Map<number, {
        x: number;
        y: number;
    }>();
    private requested = false;
    private scale = 1;
    private ox = 0;
    private oy = 0;
    private meta?: CanvasMeta;
    private overlay = false;
    private focus?: Rect;
    private maxCache = 48;
    private lastLOD = 0;
    private animation = 0;
    constructor(private canvas: HTMLCanvasElement, private fetch: (canvasId: string, level: number, x: number, y: number) => Promise<TilePayload | null>, private changed: (text: string) => void, private fail: (error: unknown) => void, private tileSize = 512) {
        this.ctx = canvas.getContext('2d')!;
        new ResizeObserver(() => this.schedule()).observe(canvas);
        canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); this.zoom(Math.exp(-e.deltaY * .0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
        canvas.addEventListener('pointerdown', e => { this.animation++; const r = canvas.getBoundingClientRect(); this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }); canvas.setPointerCapture(e.pointerId); });
        canvas.addEventListener('pointermove', e => {
            if (!this.pointers.has(e.pointerId))
                return;
            const before = [...this.pointers.values()], r = canvas.getBoundingClientRect();
            this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
            const after = [...this.pointers.values()];
            if (before.length === 1) {
                this.ox += after[0].x - before[0].x;
                this.oy += after[0].y - before[0].y;
            }
            else {
                const a = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 }, b = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
                const oldDistance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y), distance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
                this.zoom(distance / Math.max(1, oldDistance), a.x, a.y);
                this.ox += b.x - a.x;
                this.oy += b.y - a.y;
            }
            this.schedule();
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
            canvas.addEventListener(type, e => this.pointers.delete((e as PointerEvent).pointerId));
    }
    setCanvas(meta: CanvasMeta, tileSize: number): void { const different = this.meta?.id !== meta.id || this.tileSize !== tileSize; this.meta = meta; this.tileSize = tileSize; this.maxCache = globalThis.innerWidth < 700 ? 20 : 48; if (different) {
        this.invalidate();
        this.focus = undefined;
        this.fit(false);
    }
    else
        this.schedule(); }
    clear(): void { this.animation++; this.meta = undefined; this.invalidate(); this.schedule(); }
    invalidate(): void { this.generation++; for (const entry of this.cache.values())
        entry.bitmap?.close(); this.cache.clear(); this.loading.clear(); this.schedule(); }
    refresh(): void { for (const [key, t] of this.cache)
        if (!t.bitmap)
            this.cache.delete(key); this.schedule(); }
    setQuality(on: boolean): void { this.overlay = on; this.schedule(); }
    private moveTo(scale: number, ox: number, oy: number, animate: boolean): void {
        const token = ++this.animation;
        if (!animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            this.scale = scale; this.ox = ox; this.oy = oy; this.schedule(); return;
        }
        const from = { scale: this.scale, x: this.ox, y: this.oy }, start = performance.now();
        const step = (now: number) => {
            if (token !== this.animation) return;
            const t = Math.min(1, (now - start) / 220), ease = 1 - (1 - t) ** 3;
            this.scale = from.scale + (scale - from.scale) * ease;
            this.ox = from.x + (ox - from.x) * ease; this.oy = from.y + (oy - from.y) * ease;
            this.schedule(); if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }
    fit(animate = true): void {
        const m = this.meta; if (!m || !m.bounds.width || !m.bounds.height) return;
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const scale = Math.max(1e-8, Math.min((w - 64) / m.bounds.width, (h - 64) / m.bounds.height));
        this.moveTo(scale, (w - m.bounds.width * scale) / 2 - m.bounds.x * scale, (h - m.bounds.height * scale) / 2 - m.bounds.y * scale, animate);
    }
    native(): void { this.zoom(1 / this.scale, undefined, undefined, true); }
    zoom(factor: number, x = this.canvas.clientWidth / 2, y = this.canvas.clientHeight / 2, animate = false): void {
        const next = Math.min(12, Math.max(1e-9, this.scale * factor)), ratio = next / this.scale;
        this.moveTo(next, x - (x - this.ox) * ratio, y - (y - this.oy) * ratio, animate);
    }
    focusRegion(region: Rect): void { this.animation++; this.focus = region; this.scale = Math.min(this.canvas.clientWidth / (region.width + 80), this.canvas.clientHeight / (region.height + 80), 1.5); this.ox = this.canvas.clientWidth / 2 - (region.x + region.width / 2) * this.scale; this.oy = this.canvas.clientHeight / 2 - (region.y + region.height / 2) * this.scale; this.schedule(); }
    get current(): CanvasMeta | undefined { return this.meta; }
    private schedule(): void { if (!this.requested) {
        this.requested = true;
        requestAnimationFrame(() => { this.requested = false; this.draw(); });
    } }
    private draw(): void {
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (w < 1 || h < 1)
            return;
        if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
            this.canvas.width = Math.round(w * dpr);
            this.canvas.height = Math.round(h * dpr);
        }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const m = this.meta;
        if (!m)
            return;
        const level = Math.max(0, Math.min(m.maxLevel, Math.floor(Math.log2(1 / this.scale)))), unit = this.tileSize * 2 ** level;
        this.lastLOD = level;
        const x0 = Math.max(Math.floor(m.bounds.x / unit), Math.floor(-this.ox / this.scale / unit)), x1 = Math.min(Math.floor((m.bounds.x + m.bounds.width - 1) / unit), Math.floor((w - this.ox) / this.scale / unit)), y0 = Math.max(Math.floor(m.bounds.y / unit), Math.floor(-this.oy / this.scale / unit)), y1 = Math.min(Math.floor((m.bounds.y + m.bounds.height - 1) / unit), Math.floor((h - this.oy) / this.scale / unit));
        ctx.imageSmoothingEnabled = this.scale < 1;
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
                const key = `${m.id}/${level}/${x}_${y}`;
                const entry = this.cache.get(key);
                if (entry) {
                    this.cache.delete(key);
                    this.cache.set(key, entry);
                }
                if (entry === undefined && !this.loading.has(key) && this.loading.size < 6) {
                    this.loading.add(key);
                    const generation = this.generation;
                    void this.fetch(m.id, level, x, y).then(async (payload) => {
                        const bitmap = payload ? await createImageBitmap(payload.blob) : null;
                        if (generation !== this.generation) {
                            bitmap?.close();
                            return;
                        }
                        this.cache.set(key, { bitmap, quality: payload?.quality, conflicts: payload?.conflicts, time: performance.now() });
                    }).catch(error => { this.fail(error); this.cache.set(key, { bitmap: null, time: performance.now() }); }).finally(() => { if (generation === this.generation) {
                        this.loading.delete(key);
                        this.schedule();
                    } });
                }
                if (!entry?.bitmap)
                    continue;
                const px = this.ox + x * unit * this.scale, py = this.oy + y * unit * this.scale, size = unit * this.scale;
                ctx.drawImage(entry.bitmap, px, py, size, size);
                if (this.overlay && level === 0) {
                    const blocks = Math.ceil(this.tileSize / 16);
                    for (let b = 0; b < blocks * blocks; b++) {
                        const conflict = entry.conflicts?.[b], quality = entry.quality?.[b];
                        if (!conflict && (!quality || quality >= 153))
                            continue;
                        ctx.fillStyle = conflict ? 'rgba(193,60,40,.38)' : 'rgba(220,156,49,.32)';
                        ctx.fillRect(px + (b % blocks) * 16 * this.scale, py + Math.floor(b / blocks) * 16 * this.scale, 16 * this.scale, 16 * this.scale);
                    }
                }
            }
        while (this.cache.size > this.maxCache) {
            const [key, entry] = this.cache.entries().next().value!;
            entry.bitmap?.close();
            this.cache.delete(key);
        }
        if (this.focus) {
            ctx.strokeStyle = '#ca6146';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 4]);
            ctx.strokeRect(this.ox + this.focus.x * this.scale, this.oy + this.focus.y * this.scale, this.focus.width * this.scale, this.focus.height * this.scale);
            ctx.setLineDash([]);
        }
        this.changed(`${(this.scale * 100).toFixed(this.scale < .01 ? 2 : 0)}% · ${level ? `预览 L${level}（原尺寸未改变）` : '原像素 L0'}${this.overlay && level ? ' · 放大查看质量遮罩' : ''}`);
    }
}
