/** Pool helper for the threaded core build (`core.threads.wasm`). It instantiates the same module on the shared
 *  memory it is handed, moves its stack (and TLS, if the build has any) onto blocks the owning instance allocated
 *  for it, reports ready, and then parks in `ls_pool_worker` for the life of the core — that call never returns,
 *  so this worker handles exactly one message. See rust/core/src/pool.rs for the job protocol. */
interface HelperInit {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  stackTop: number;
  tls: number;
}
interface HelperExports {
  __stack_pointer: WebAssembly.Global;
  __wasm_init_tls?: (ptr: number) => void;
  ls_pool_worker(): void;
}
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<HelperInit>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = async (e) => {
  const { module, memory, stackTop, tls } = e.data;
  try {
    const instance = await WebAssembly.instantiate(module, { env: { memory } });
    const exports = instance.exports as unknown as HelperExports;
    exports.__stack_pointer.value = stackTop;
    if (tls) exports.__wasm_init_tls?.(tls);
    scope.postMessage({ ready: true });
    exports.ls_pool_worker();
  } catch (error) {
    scope.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) });
  }
};
