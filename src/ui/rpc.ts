/** The typed worker RPC client: one request/response call keyed by `Commands` (src/protocol.ts), a `WorkerEvent`
 *  subscription, and the frame-request bridge the worker uses for compatibility-mode seeks. Command strings are
 *  frozen (tests call `longScreen.rpc('tile'|'open'|'capabilities')` directly) — `call()` keeps that exact name. */
import type { CommandName, Commands, WorkerEvent, WorkerEventName } from '../protocol.ts';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let requestId = 0;
const requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** Commands with no payload (`capabilities`, `stop`) can be called with no second argument. */
type ReqArgs<K extends CommandName> = Commands[K]['req'] extends Record<string, never> ? [payload?: Commands[K]['req']]
  : [payload: Commands[K]['req']];

export function call<K extends CommandName>(type: K, ...args: ReqArgs<K>): Promise<Commands[K]['res']> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    requests.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker.postMessage({ id, type, payload: args[0] ?? {} });
  });
}

type EventOf<E extends WorkerEventName> = Extract<WorkerEvent, { event: E }>;
// deno-lint-ignore no-explicit-any
const listeners = new Map<WorkerEventName, ((m: any) => void)[]>();
/** Subscribes to one worker event kind; multiple listeners on the same event all run. */
export function on<E extends WorkerEventName>(event: E, fn: (m: EventOf<E>) => void): void {
  let fns = listeners.get(event);
  if (!fns) listeners.set(event, fns = []);
  fns.push(fn);
}
function emit(m: WorkerEvent): void {
  listeners.get(m.event)?.forEach((fn) => fn(m));
}

/** Answers the worker's `frame-request` with a captured bitmap or an error, exactly once per request id. `handler`
 *  does the actual seek + capture (video.ts); this function only owns the postMessage/transfer contract. */
export function onFrameRequest(handler: (time: number) => Promise<ImageBitmap>): void {
  on('frame-request', (m) => {
    void handler(m.time)
      .then((bitmap) => worker.postMessage({ type: 'frame-response', id: m.id, bitmap }, [bitmap]))
      .catch((error) => worker.postMessage({ type: 'frame-response', id: m.id, error: String(error) }));
  });
}

/** A worker-level failure (not a rejected command): every pending request is rejected and cleared before `fn`
 *  runs, so a caller awaiting `call()` never hangs past a dead worker. */
export function onError(fn: (message: string) => void): void {
  worker.onerror = (event) => {
    for (const pending of requests.values()) {
      pending.reject(new Error(event.message));
    }
    requests.clear();
    fn(event.message);
  };
}
export function onMessageError(fn: () => void): void {
  worker.onmessageerror = fn;
}

worker.onmessage = (event) => {
  const m = event.data;
  if ('id' in m && !('event' in m)) {
    const pending = requests.get(m.id);
    if (pending) {
      requests.delete(m.id);
      if ('error' in m) {
        pending.reject(new Error(m.error));
      } else {
        pending.resolve(m.result);
      }
    }
    return;
  }
  emit(m as WorkerEvent);
};
