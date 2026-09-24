import '../support/core.ts';
import { assertEquals } from '@std/assert';
import { RenderPass } from '../../src/pipeline/render.ts';
import type { RunContext } from '../../src/pipeline/context.ts';

/** `RenderPass.checkpointFlush()`'s 1200 ms gate reads its clock through a constructor argument (defaulting to
 * `performance.now` in production, see the coverage floor history in scripts/coverage.ts for why), so a test can
 * drive it with an in-memory clock and hit both branches deterministically regardless of wall-clock timing under
 * `deno test --parallel`. Fields the gate touches are reached through a cast, the same pattern the rest of this
 * suite uses for private members: the pass is never `setup()`, so only the fields `checkpointFlush()` itself
 * reads need a fake. */
function makePass(): { pass: RenderPass; clock: { value: number }; calls: string[] } {
  const clock = { value: 0 };
  const calls: string[] = [];
  const fakeCtx = {
    tiles: { flush: async (_settledBefore?: number) => void calls.push('tiles') },
    diagnostics: { flush: async () => void calls.push('diagnostics') },
    commitRows: async (rows: unknown[]) => {
      calls.push('commitRows');
      (rows as unknown[]).splice(0, rows.length);
    },
    store: { get: async () => undefined },
  } as unknown as RunContext;
  const pass = new RenderPass(fakeCtx, () => clock.value);
  const internal = pass as unknown as { lastFlush: number; compositor: { flush(): Promise<void> } };
  internal.lastFlush = 0;
  internal.compositor = { flush: async () => void calls.push('compositor') };
  return { pass, clock, calls };
}

function flush(pass: RenderPass): Promise<void> {
  return (pass as unknown as { checkpointFlush(): Promise<void> }).checkpointFlush();
}

Deno.test('render checkpointFlush: below the 1200ms gate does not flush', async () => {
  const { pass, clock, calls } = makePass();
  clock.value = 1199;
  await flush(pass);
  assertEquals(calls, []);
  assertEquals((pass as unknown as { lastFlush: number }).lastFlush, 0, 'lastFlush must not move when the gate does not trip');
});

Deno.test('render checkpointFlush: at the 1200ms gate flushes tiles/compositor/diagnostics/metas and advances the clock', async () => {
  const { pass, clock, calls } = makePass();
  clock.value = 1200;
  await flush(pass);
  assertEquals(calls, ['tiles', 'compositor', 'diagnostics']);
  assertEquals((pass as unknown as { lastFlush: number }).lastFlush, 1200);
});

Deno.test('render checkpointFlush: pending observations are committed when the gate trips', async () => {
  const { pass, clock, calls } = makePass();
  const pending = (pass as unknown as { pendingObservations: { key: string; value: unknown }[] }).pendingObservations;
  pending.push({ key: 'observation/000000', value: { frame: 0 } });
  clock.value = 1200;
  await flush(pass);
  assertEquals(calls, ['tiles', 'compositor', 'diagnostics', 'commitRows']);
  assertEquals(pending.length, 0);
});
