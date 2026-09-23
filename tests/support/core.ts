/** Loads the Rust core for Deno tests from the workspace build output: the SIMD128 module when this runtime
 *  validates it (as the browser adapter would choose), otherwise the scalar baseline. `LONGSCREEN_CORE=scalar`
 *  forces the baseline and `LONGSCREEN_CORE=threads` the shared-memory build with pool helpers
 *  (`LONGSCREEN_THREADS`, default 3), so every build can be exercised against the same tests. */
import { fromFileUrl } from '@std/path';
import { type Core, core, coreLoaded, loadCore, simdSupported } from '../../src/core/wasm.ts';

const root = fromFileUrl(new URL('../../', import.meta.url));
const requested = Deno.env.get('LONGSCREEN_CORE');
const variant = requested === 'scalar' || !simdSupported() ? 'scalar' : requested === 'threads' ? 'threads' : 'simd';
export const CORE_WASM = `${root}rust/target/${variant}/wasm32-unknown-unknown/release/long_screen_core.wasm`;

export async function ensureCore(): Promise<Core> {
  if (coreLoaded()) return core();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await Deno.readFile(CORE_WASM) as Uint8Array<ArrayBuffer>;
  } catch {
    throw new Error(`Rust core missing at ${CORE_WASM}. Run: bash scripts/build-core.sh`);
  }
  if (variant !== 'threads') return await loadCore(bytes);
  const loaded = await loadCore(bytes, {
    helpers: Number(Deno.env.get('LONGSCREEN_THREADS') || 3),
    helperURL: new URL('../../src/core/helper.ts', import.meta.url),
  });
  // Parked helpers would keep the test process alive; the pool is torn down with the process.
  globalThis.addEventListener('unload', () => loaded.dispose());
  return loaded;
}

// Importing this module is enough: every Deno test that touches the pipeline pulls it in (directly or via run.ts).
await ensureCore();
