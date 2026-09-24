import type { WorkerProgress } from '../protocol.ts';
/** Crash recorder: the last known state of a reconstruction, kept in localStorage so that it survives the page being
 *  killed (Safari reloads a tab whose memory footprint crosses its limit; the limit is far lower while the tab is
 *  hidden) or crashing. On the next load an unfinished record is reported once and then cleared. Nothing leaves the
 *  device. */
const KEY = 'long-screen.flight';
const WRITE_INTERVAL_MS = 1000;
export interface FlightRecord {
  // Only ever written as 'running' — flightEnd() clears the record entirely (localStorage.removeItem) rather
  // than writing a terminal state, since a run that ended normally has nothing left to report.
  state: 'running';
  started: string;
  updated: string;
  userAgent: string;
  cores: number;
  crossOriginIsolated: boolean;
  file?: { name: string; size: number; type: string };
  phase?: string;
  frames?: number;
  total?: number;
  elapsedS: number;
  memoryMB?: number;
  peakMemoryMB?: number;
  conversion?: string;
  hiddenNow: boolean;
  hiddenS: number;
  hiddenTimes: number;
}
let record: FlightRecord | undefined, startedAt = 0, hiddenSince: number | undefined, lastWrite = 0;
// A page reload or close fires `pagehide` BEFORE the `visibilitychange` to 'hidden' that unloading also triggers
// (verified in Chrome and WebKit: both fire pagehide, then visibilitychange, in that order — see the HTML
// Standard's "unloading document cleanup steps"). That trailing visibilitychange is teardown, not the tab being
// backgrounded, so it must not count as another hidden period once pagehide has already fired. A bfcache-eligible
// pagehide (`event.persisted`) does not unload the page at all — the page can come back via `pageshow` with its
// JS state intact — so `unloading` must clear on `pageshow`, or every backgrounding after one bfcache round trip
// would go unrecorded for the rest of the page's life.
let unloading = false;
addEventListener('pagehide', (e) => {
  unloading = !e.persisted;
});
addEventListener('pageshow', () => {
  unloading = false;
});
const write = (force = false) => {
  if (!record || (!force && performance.now() - lastWrite < WRITE_INTERVAL_MS)) return;
  lastWrite = performance.now();
  record.updated = new Date().toISOString();
  record.elapsedS = Math.round((performance.now() - startedAt) / 1000);
  record.hiddenNow = document.visibilityState === 'hidden';
  const hidden = record.hiddenS + (hiddenSince === undefined ? 0 : (performance.now() - hiddenSince) / 1000);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...record, hiddenS: Math.round(hidden) }));
  } catch {
    // Storage unavailable or full: the recorder is best-effort.
  }
};
document.addEventListener('visibilitychange', () => {
  if (!record || unloading) return;
  if (document.visibilityState === 'hidden') {
    hiddenSince = performance.now();
    record.hiddenTimes++;
  } else if (hiddenSince !== undefined) {
    record.hiddenS += (performance.now() - hiddenSince) / 1000;
    hiddenSince = undefined;
  }
  write(true);
});
export function flightStart(file?: File): void {
  startedAt = performance.now();
  hiddenSince = document.visibilityState === 'hidden' ? performance.now() : undefined;
  record = {
    state: 'running',
    started: new Date().toISOString(),
    updated: '',
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    file: file && { name: file.name, size: file.size, type: file.type },
    elapsedS: 0,
    hiddenNow: false,
    hiddenS: 0,
    hiddenTimes: 0,
  };
  write(true);
}
export function flightProgress(p: WorkerProgress): void {
  if (!record) return;
  const phaseChanged = p.phase !== record.phase;
  Object.assign(record, { phase: p.phase, frames: p.frames, total: p.total, conversion: p.conversion ?? record.conversion });
  if (p.memoryMB !== undefined) {
    record.memoryMB = p.memoryMB;
    record.peakMemoryMB = Math.max(record.peakMemoryMB ?? 0, p.memoryMB);
  }
  write(phaseChanged);
}
/** The run ended in a way the page saw (finished, failed or stopped): nothing to report next time. */
export function flightEnd(): void {
  record = undefined;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // best-effort
  }
}
/** A run the page never saw end, from a previous load; cleared once read. */
export function takeInterruptedFlight(): FlightRecord | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const value = raw ? JSON.parse(raw) as FlightRecord : undefined;
    return value?.state === 'running' ? value : undefined;
  } catch {
    return undefined;
  }
}
