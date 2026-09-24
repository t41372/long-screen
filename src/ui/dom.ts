/** DOM lookup, the toast, and the handful of pure formatters every feature module needs. No feature state lives
 *  here beyond the toast's own dismiss timer. */
import { t, translateKey } from '../i18n/page.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, error = false): void {
  const el = $('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, error ? 16000 : 9000);
}

export const humanBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
export const timeText = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Shown both as a capability toast on load and as the reason start() itself refuses to run: kept as one constant
// so the two call sites (main.ts, run.ts) can never drift into two slightly different explanations of the same limit.
export const NO_COMPRESSION_STREAM = t('ui.dom.noCompressionStream');

/** `ui.phase.<phase>`, falling back to the raw phase word (matching the old `phaseNames[x] || x` lookup) when the
 *  phase is not one of the known keys. */
export function phaseName(phase: string): string {
  return translateKey(`ui.phase.${phase}`, phase);
}

/** Local storage quota, shown in the sidebar; re-queried after anything that changes usage (a run finishing, an
 *  export, a delete). Not re-queried when persist() is granted. */
export async function storageInfo(): Promise<void> {
  if (typeof navigator.storage?.estimate !== 'function') {
    $('storage-status').textContent = t('ui.dom.storageUnavailable');
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    $('storage-status').textContent = t('ui.dom.storageUsage', {
      used: humanBytes(estimate.usage || 0),
      quota: humanBytes(estimate.quota || 0),
    });
  } catch (error) {
    $('storage-status').textContent = t('ui.dom.storageQueryFailedStatus');
    toast(t('ui.dom.storageQueryFailed', { error: String(error) }), true);
  }
}
