/** Loads and selects the running `Core` instance: which build (scalar/SIMD/threads) this engine should run,
 *  and the module-level "the loaded core" the rest of the app reaches through `core()`. */
import { Core, type CoreThreads } from './core.ts';

let active: Core | undefined;
/** The core must be loaded before any algorithm runs; there is deliberately no TypeScript fallback. */
export function core(): Core {
  if (!active) throw new Error('CORE_NOT_LOADED: call loadCore() before running the reconstruction pipeline.');
  return active;
}
export function coreLoaded(): boolean {
  return !!active;
}
export async function loadCore(source: BufferSource | Response | Promise<Response>, threads?: CoreThreads): Promise<Core> {
  active?.dispose();
  active = await Core.instantiate(source, threads);
  return active;
}
/** Which core build this engine should run and why. The threaded build needs shared memory, which browsers
 *  only grant to cross-origin-isolated pages (COOP/COEP); without it the SIMD or scalar single-thread build
 *  runs and `reason` says why, so the choice is reported rather than silent. */
export interface CorePlan {
  url: URL;
  variant: 'threads' | 'simd' | 'scalar';
  helpers: number;
  reason: string;
}
export function planCore(base: string | URL = import.meta.url): CorePlan {
  const simd = simdSupported();
  const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number } };
  const cores = g.navigator?.hardwareConcurrency || 1;
  const single = (reason: string): CorePlan => ({
    url: new URL(simd ? './core.simd.wasm' : './core.wasm', base),
    variant: simd ? 'simd' : 'scalar',
    helpers: 0,
    reason,
  });
  if (!simd) return single('WebAssembly SIMD128 unavailable');
  if (typeof SharedArrayBuffer === 'undefined' || g.crossOriginIsolated === false) {
    return single('page is not cross-origin isolated, so shared memory (threads) is unavailable');
  }
  if (typeof Worker === 'undefined') return single('Workers unavailable in this context');
  if (cores < 2) return single('a single logical CPU');
  // The calling thread computes too; cap the pool where dispatch and memory bandwidth stop paying.
  const helpers = Math.min(cores - 1, 7);
  return {
    url: new URL('./core.threads.wasm', base),
    variant: 'threads',
    helpers,
    reason: `${helpers + 1} threads (${cores} logical CPUs)`,
  };
}
/** Loads the planned core, falling back to the single-thread build (with the failure recorded in the returned
 *  plan's reason) when the threaded build cannot start. */
export async function loadPlannedCore(plan: CorePlan, helperURL: URL): Promise<CorePlan> {
  if (plan.variant === 'threads') {
    try {
      await loadCore(fetch(plan.url), { helpers: plan.helpers, helperURL });
      return loadedPlan = plan;
    } catch (error) {
      const fallback = new URL('./core.simd.wasm', plan.url);
      await loadCore(fetch(fallback));
      return loadedPlan = {
        url: fallback,
        variant: 'simd',
        helpers: 0,
        reason: `threaded core failed to start (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  await loadCore(fetch(plan.url));
  return loadedPlan = plan;
}
let loadedPlan: CorePlan | undefined;
/** The build the running core came from, for diagnostics; undefined when a caller loaded bytes directly. */
export function coreBuild(): { variant: string; threads: number; reason: string } {
  return {
    variant: loadedPlan?.variant ?? (active && active.threads > 1 ? 'threads' : 'direct'),
    threads: active?.threads ?? 0,
    reason: loadedPlan?.reason ?? 'loaded directly',
  };
}
/** True when this engine validates a module using v128 (SIMD128): Chrome 91+, Safari 16.4+, Firefox 89+. */
export function simdSupported(): boolean {
  try {
    // (module (func (result v128) v128.const i32x4 0 0 0 0 drop ...)) — the smallest module that needs SIMD.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}
