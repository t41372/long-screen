/** Which file each core build is fetched from. Ways this goes wrong, each of which loads the wrong Wasm or a 404 in
 *  the browser (and, through a bundler, a file that was never emitted): a variant mapped to another build's file;
 *  a URL resolved somewhere other than next to the bundle that loads it; a plan whose URL disagrees with its
 *  variant. */
import { assertEquals } from '@std/assert';
import { coreURL, planCore } from '../../src/core/wasm/loader.ts';

const here = new URL('../../src/core/wasm/', import.meta.url);

Deno.test('loader: each core build has its own file, next to the module that loads it', () => {
  assertEquals(coreURL('scalar').href, new URL('core.wasm', here).href);
  assertEquals(coreURL('simd').href, new URL('core.simd.wasm', here).href);
  assertEquals(coreURL('threads').href, new URL('core.threads.wasm', here).href);
});

Deno.test('loader: the planned build is fetched from that build’s own file', () => {
  const plan = planCore();
  assertEquals(plan.url.href, coreURL(plan.variant).href);
  assertEquals(plan.helpers === 0, plan.variant !== 'threads', plan.reason);
});
