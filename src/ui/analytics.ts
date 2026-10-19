/** Usage counting on the hosted site: a page view, and one event when a run starts and one when it ends, so the
 *  owner can see how often the printer is used. Only coarse, fixed-vocabulary values are sent (settings, the core
 *  version, a frame-count bucket, diagnostic codes), never a file name, a pixel, an error message or anything else a
 *  user typed or recorded; src/i18n's help.privacyBody says the same to the user.
 *
 *  Only the hosted site counts: on any other host (a self-hosted copy, localhost, the portable build's file://) and
 *  under Do Not Track or Global Privacy Control nothing loads and nothing is sent. When it does count, main.js adds
 *  assets/analytics.js (src/analytics.ts, PostHog's SDK) as a module script and hands it the events queued here, so
 *  the SDK costs nothing on pages that do not count, and main.js stays free of a dynamic import(), which the portable
 *  build cannot load. The CSP in static/_headers admits the one host it sends to. */
import type { Project, Settings } from '../types.ts';

/** Hostnames that count. Pages preview deployments (`<hash>.long-screen.pages.dev`) do not. */
export const COUNTED_HOSTS: readonly string[] = ['long-screen.yi-ting.com', 'long-screen.pages.dev'];

export type AnalyticsEvent = [name: string, properties: Record<string, unknown>];
/** The queue src/analytics.ts drains: it replaces `push` with a direct send once the SDK is up. */
const QUEUE_KEY = '__LS_ANALYTICS__';

function counting(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  // tests/browser/analytics.test.ts stands in for the hosted site by naming its own host before the page loads.
  const hosts = (globalThis as { __LS_COUNTED_HOSTS__?: readonly string[] }).__LS_COUNTED_HOSTS__ ?? COUNTED_HOSTS;
  return hosts.includes(location.hostname) && nav.doNotTrack !== '1' && nav.globalPrivacyControl !== true;
}

const queue: AnalyticsEvent[] | undefined = counting() ? [] : undefined;
if (queue) {
  (globalThis as unknown as Record<string, unknown>)[QUEUE_KEY] = queue;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = new URL('./analytics.js', import.meta.url).href;
  document.head.append(script);
}

function send(name: string, properties: Record<string, unknown>): void {
  queue?.push([name, properties]);
}

/** A frame count as an order of magnitude: enough to tell a short clip from a long recording. */
export function frameBucket(frames: number): string {
  const edges = [100, 300, 1000, 3000, 10000];
  const upper = edges.find((edge) => frames < edge);
  if (upper === undefined) return `${edges.at(-1)}+`;
  const lower = edges[edges.indexOf(upper) - 1] ?? 0;
  return `${lower}-${upper - 1}`;
}

const coreVersion = () => document.getElementById('build-version')?.textContent?.replace(/^v/, '') || undefined;

let current: { started: number; demo: boolean; stopped: boolean } | undefined;

/** The user pressed Print (or the demo did) and the run passed its checks. */
export function runStarted(settings: Settings, demo: boolean, media?: { codec: string; height: number; duration: number }): void {
  current = { started: performance.now(), demo, stopped: false };
  send('run_started', {
    demo,
    core_version: coreVersion(),
    decoder: settings.decoder,
    compute: settings.compute,
    analysis_size: settings.analysisSize,
    memory_mb: settings.memoryMB,
    temporal_policy: settings.temporalPolicy,
    framing: settings.framing,
    manual_regions: settings.regions?.length ?? 0,
    threads: crossOriginIsolated,
    // The codec family only (avc1, hvc1, vp09…), not the full codec string.
    codec: media?.codec.split('.')[0],
    video_height: media?.height,
    video_minutes: media ? Math.ceil(media.duration / 60) : undefined,
  });
}

/** The user pressed Stop: the run goes on to assemble what it has, and ends as `stopped`. */
export function runStopped(): void {
  if (current) current.stopped = true;
}

/** The run ended: `project` when the worker reported a finished project, otherwise only how it ended. Sends once
 *  per started run. */
export function runEnded(status: 'finished' | 'error' | 'start_failed', project?: Project): void {
  if (!current) return;
  const { started, demo, stopped } = current;
  current = undefined;
  const severities = project?.severities ?? {};
  send('run_finished', {
    status: status === 'finished' ? (stopped ? 'stopped' : project?.status) : status,
    demo,
    core_version: coreVersion(),
    elapsed_s: Math.round((performance.now() - started) / 1000),
    frames: project ? frameBucket(project.renderedFrames) : undefined,
    canvases: project?.canvasCount,
    // Diagnostic codes are a fixed vocabulary (DIAG_CODES); messages, which can quote a file name, are never sent.
    error_codes: Object.keys(severities).filter((code) => severities[code] === 'error').sort(),
    warning_codes: Object.keys(severities).filter((code) => severities[code] === 'warning').sort(),
  });
}

/** A run that the browser killed or that crashed, found by the crash recorder (flight.ts) on the next load. */
export function runInterrupted(phase: string | undefined, frames: number | undefined): void {
  send('run_finished', {
    status: 'interrupted',
    core_version: coreVersion(),
    phase,
    frames: frames === undefined ? undefined : frameBucket(frames),
  });
}
