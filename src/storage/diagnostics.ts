import type { Diagnostic } from '../types.ts';
import type { KV, Row } from './db.ts';
import { pad } from '../core/math.ts';
export class Diagnostics {
    counts: Record<string, number> = {};
    private pending: Row[] = [];
    private sequence = 0;
    private lastSent = new Map<string, number>();
    constructor(private db: KV, private onEvent: (event: Diagnostic) => void) { }
    async emit(event: Diagnostic): Promise<void> {
        this.counts[event.code] = (this.counts[event.code] || 0) + 1;
        this.pending.push({ key: `diagnostic/${pad(this.sequence++)}`, value: event });
        const now = performance.now(), last = this.lastSent.get(event.code) || 0;
        if (!last || now - last > 750) {
            this.onEvent({ ...event, count: this.counts[event.code] });
            this.lastSent.set(event.code, now);
        }
        if (this.pending.length >= 24)
            await this.flush();
    }
    async flush(): Promise<void> { if (this.pending.length) {
        const p = this.pending.splice(0);
        await this.db.putMany(p);
    } }
}
