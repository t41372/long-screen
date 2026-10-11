/** The typed client side of the page↔worker protocol (src/protocol.ts) for one worker: id-tagged requests and their
 *  replies, plus a subscription to the events the worker pushes unprompted. The app's page holds one (src/ui/rpc.ts);
 *  the npm package (src/package/index.ts) makes one per reconstruction, each with its own worker. */
import type { CommandName, Commands, WorkerEvent, WorkerEventName } from './protocol.ts';

/** Commands with no payload (`capabilities`, `stop`) can be called with no second argument. */
export type ReqArgs<K extends CommandName> = Commands[K]['req'] extends Record<string, never> ? [payload?: Commands[K]['req']]
  : [payload: Commands[K]['req']];
export type EventOf<E extends WorkerEventName> = Extract<WorkerEvent, { event: E }>;

export interface WorkerClient {
  call<K extends CommandName>(type: K, ...args: ReqArgs<K>): Promise<Commands[K]['res']>;
  /** Subscribes to one worker event kind; multiple listeners on the same event all run. */
  on<E extends WorkerEventName>(event: E, fn: (m: EventOf<E>) => void): void;
  /** Rejects and forgets every request still waiting for a reply (the worker died), so no caller hangs. */
  rejectPending(error: Error): void;
}

/** Takes over `worker.onmessage`; the caller keeps `onerror`/`onmessageerror`. */
export function createWorkerClient(worker: Worker): WorkerClient {
  let requestId = 0;
  const requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  // deno-lint-ignore no-explicit-any
  const listeners = new Map<WorkerEventName, ((m: any) => void)[]>();
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
    listeners.get((m as WorkerEvent).event)?.forEach((fn) => fn(m));
  };
  return {
    call<K extends CommandName>(type: K, ...args: ReqArgs<K>): Promise<Commands[K]['res']> {
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        requests.set(id, { resolve: resolve as (value: unknown) => void, reject });
        worker.postMessage({ id, type, payload: args[0] ?? {} });
      });
    },
    on(event, fn) {
      let fns = listeners.get(event);
      if (!fns) listeners.set(event, fns = []);
      fns.push(fn);
    },
    rejectPending(error) {
      for (const pending of requests.values()) {
        pending.reject(error);
      }
      requests.clear();
    },
  };
}
