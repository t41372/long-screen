import type { Diagnostic, Severity } from '../types.ts';
import type { KV, Row } from './db.ts';
import { pad } from '../core/math.ts';
// Rank used only to pick the highest severity seen for a code across a run (error > warning > info); it never
// reorders or replaces the severity carried on an individual event.
const severityRank: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
export class Diagnostics {
  counts: Record<string, number> = {};
  /** Highest severity observed so far for each code, persisted alongside `counts` so a badge or summary computed
   * from the totals (rather than from live events) never has to guess or default a code's severity. */
  severities: Record<string, Severity> = {};
  private pending: Row[] = [];
  private sequence = 0;
  private lastSent = new Map<string, number>();
  constructor(private db: KV, private onEvent: (event: Diagnostic) => void) {}
  async emit(event: Diagnostic): Promise<void> {
    this.counts[event.code] = (this.counts[event.code] || 0) + 1;
    const known = this.severities[event.code];
    if (!known || severityRank[event.severity] > severityRank[known]) {
      this.severities[event.code] = event.severity;
    }
    this.pending.push({ key: `diagnostic/${pad(this.sequence++)}`, value: event });
    const now = performance.now(), last = this.lastSent.get(event.code) || 0;
    if (!last || now - last > 750) {
      // event.count (when the caller supplies one, e.g. a decoder notice's own pre-aggregated tally) is an
      // explicit fact about that one event and must survive untouched; the running per-code total goes in its
      // own field instead of overwriting it.
      this.onEvent({ ...event, occurrences: this.counts[event.code] });
      this.lastSent.set(event.code, now);
    }
    if (this.pending.length >= 24) {
      await this.flush();
    }
  }
  async flush(): Promise<void> {
    if (!this.pending.length) {
      return;
    }
    // Copy, then only drop what was actually written once putMany has confirmed it — splicing first would lose
    // these rows for good if the write itself failed.
    const p = this.pending.slice();
    await this.db.putMany(p);
    this.pending.splice(0, p.length);
  }
}
