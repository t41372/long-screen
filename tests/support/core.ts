/** Loads the Rust core for Deno tests from the workspace build output, building it when missing or stale. */
import { fromFileUrl } from '@std/path';
import { type Core, core, coreLoaded, loadCore } from '../../src/core/wasm.ts';

const root = fromFileUrl(new URL('../../', import.meta.url));
export const CORE_WASM = `${root}rust/target/wasm32-unknown-unknown/release/long_screen_core.wasm`;

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
