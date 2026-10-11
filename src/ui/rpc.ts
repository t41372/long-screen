/** The page's worker and its typed RPC client (src/rpc-client.ts): one request/response call keyed by `Commands`
 *  (src/protocol.ts), a `WorkerEvent` subscription, and the frame-request bridge the worker uses for compatibility-mode
 *  seeks. Command strings are frozen (tests call `longScreen.rpc('tile'|'open'|'capabilities')` directly) — `call()`
 *  keeps that exact name. */
import type { CommandName, Commands, LocaleMessage, WorkerEventName } from '../protocol.ts';
import { createWorkerClient, type EventOf, type ReqArgs } from '../rpc-client.ts';
import { locale } from '../i18n/page.ts';
import type { Capture } from '../media/capture.ts';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
// First message on the channel, so it is handled before any command (page.ts has already detected the language).
worker.postMessage({ type: 'locale', locale: locale() } satisfies LocaleMessage);
const client = createWorkerClient(worker);

export function call<K extends CommandName>(type: K, ...args: ReqArgs<K>): Promise<Commands[K]['res']> {
  return client.call(type, ...args);
}

/** Subscribes to one worker event kind; multiple listeners on the same event all run. */
export function on<E extends WorkerEventName>(event: E, fn: (m: EventOf<E>) => void): void {
  client.on(event, fn);
}

/** Answers the worker's `frame-request` with a captured bitmap or an error, exactly once per request id. `handler`
 *  does the actual seek + capture (video.ts); this function only owns the postMessage/transfer contract. */
export function onFrameRequest(handler: (time: number, coded: boolean) => Promise<Capture>): void {
  on('frame-request', (m) => {
    void handler(m.time, !!m.coded)
      .then(({ bitmap, coded }) => worker.postMessage({ type: 'frame-response', id: m.id, bitmap, coded }, [bitmap]))
      .catch((error) => worker.postMessage({ type: 'frame-response', id: m.id, error: String(error) }));
  });
}

/** A worker-level failure (not a rejected command): every pending request is rejected and cleared before `fn`
 *  runs, so a caller awaiting `call()` never hangs past a dead worker. */
export function onError(fn: (message: string) => void): void {
  worker.onerror = (event) => {
    client.rejectPending(new Error(event.message));
    fn(event.message);
  };
}
export function onMessageError(fn: () => void): void {
  worker.onmessageerror = fn;
}
