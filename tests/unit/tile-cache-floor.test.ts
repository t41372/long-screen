// The tile cache's floor: however small the memory budget, the cache holds every tile one frame paints. A frame paints
// each of its regions (scrolling panes, fixed bars, dividers) into its own canvas, and a cache smaller than all of
// them together makes the LRU reload nearly every tile on every frame: c.mov (a scrolling page, a sidebar, a header,
// a footer and a sticky bar) reloaded 7,733 tiles over 170 frames at the default budget and ran 13.6 s instead of 7.3.
//
// Failure cases:
// - a frame that paints several regions overflows a cache sized for one frame-sized canvas, and the render and
//   reveal passes reload its tiles frame after frame;
// - the run never says the budget was raised;
// - the cache size leaks into the print.
import '../support/core.ts';
import { assert, assertEquals } from '@std/assert';
import { DEFAULT_SETTINGS } from '../../src/types.ts';
import { Engine } from '../../src/pipeline/engine.ts';
import { iterate, MemoryKV, Namespace } from '../../src/storage/db.ts';
import { ScenarioSource } from '../../src/synthetic/source.ts';
import { buildScenario } from '../../src/synthetic/scenarios.ts';

/** Runs `panes` with 64 px tiles and `memoryMB`; returns the tile decodes made before framing starts (framing reads
 *  every finished tile back once, which a cache smaller than the whole print pays for whatever its floor), the
 *  diagnostic codes and a hash of every stored tile. */
async function run(memoryMB: number) {
  const scenario = buildScenario('panes'), db = new MemoryKV(), codes = new Set<string>();
  let decodesBeforeFraming: number | undefined;
  const engine: Engine = new Engine(db, new ScenarioSource(scenario), { ...DEFAULT_SETTINGS, tileSize: 64, memoryMB }, {
    progress: (p) => {
      if (p.phase === 'framing') decodesBeforeFraming ??= engine.tiles.decodedTiles;
    },
    diagnostic: (d) => void codes.add(d.code),
    project: () => {},
  });
  const project = await engine.run();
  const tiles = new Map<string, string>();
  for await (const { key, value } of iterate<{ blob: Blob }>(new Namespace(db, `run/${project.id}/`), 'tile/')) {
    const digest = await crypto.subtle.digest('SHA-256', await value.blob.arrayBuffer());
    tiles.set(key, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  return { frames: scenario.frames.length, decodesBeforeFraming: decodesBeforeFraming!, limit: engine.tiles.maxTiles, codes, tiles };
}

Deno.test('tile cache floor: a frame painting two panes, a header and a divider does not reload its tiles every frame', async () => {
  // 1 MB leaves nothing once the frames are reserved, so the floor alone sizes the cache; 512 MB holds every tile.
  const tight = await run(1), roomy = await run(512);
  console.log(
    `panes, 64 px tiles: ${tight.decodesBeforeFraming} decodes before framing at the floor (cache ${tight.limit}), ` +
      `${roomy.decodesBeforeFraming} with room`,
  );
  assert(tight.codes.has('MEMORY_BUDGET_RAISED'), 'a budget below the floor is reported');
  // Reloading a frame's tiles even once per frame would be at least one decode per frame; a cache that holds them
  // reloads only what a revisit brings back after the pane has moved on.
  assert(
    tight.decodesBeforeFraming - roomy.decodesBeforeFraming < tight.frames,
    `${tight.decodesBeforeFraming} decodes at the floor against ${roomy.decodesBeforeFraming} with room over ${tight.frames} frames`,
  );
  assertEquals(tight.tiles.size, roomy.tiles.size, 'the same tiles');
  for (const [key, hash] of tight.tiles) assertEquals(hash, roomy.tiles.get(key), `tile ${key}`);
});
