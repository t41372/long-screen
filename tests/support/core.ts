/** Loads the Rust core for Deno tests from the workspace build output: the SIMD128 module when this runtime
 *  validates it (as the browser adapter would choose), otherwise the scalar baseline. `LONGSCREEN_CORE=scalar`
 *  forces the baseline so both builds can be exercised against the same tests. */
import { fromFileUrl } from '@std/path';
import { type Core, core, coreLoaded, loadCore, simdSupported } from '../../src/core/wasm.ts';

const root = fromFileUrl(new URL('../../', import.meta.url));
const variant = Deno.env.get('LONGSCREEN_CORE') === 'scalar' || !simdSupported() ? 'scalar' : 'simd';
export const CORE_WASM = `${root}rust/target/${variant}/wasm32-unknown-unknown/release/long_screen_core.wasm`;

export async function ensureCore(): Promise<Core> {
  if (coreLoaded()) return core();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await Deno.readFile(CORE_WASM) as Uint8Array<ArrayBuffer>;
  } catch {
    throw new Error(`Rust core missing at ${CORE_WASM}. Run: bash scripts/build-core.sh`);
  }
  return await loadCore(bytes);
}

// Importing this module is enough: every Deno test that touches the pipeline pulls it in (directly or via run.ts).
await ensureCore();
