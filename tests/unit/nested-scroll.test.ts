// Nested scrolling, measured. The engine reconstructs one translation per region (docs/ARCHITECTURE.md §一), and
// nested scrolling is listed as not done (§九), so these scenarios do not pass the catalogue's exact checks: their
// layers end up in one engine region, where per-layer pixel checks count the other layer's pixels as invented. This
// file records what each run does today (test-results/nested-scroll.json) and guards it in two directions:
//
// - what is still wrong is pinned as a known limitation, like `unlearnedFixed` in the catalogue: when the engine
//   gives the nested layer a region of its own, or tracks it, the assertion fails, and the scenario should move into
//   the catalogue with exact checks;
// - what is right today (the outer layer's placements) must stay right.
import { assert, assertEquals } from '@std/assert';
import { buildScenario, NESTED_SCENARIO_NAMES } from '../../src/synthetic/scenarios.ts';
import type { Layer } from '../../src/synthetic/world.ts';
import { matchRegion, type RunResult, runScenario, verifyLayer } from '../support/run.ts';

interface LayerMeasure {
  region: string | null;
  regionKind: string | null;
  /** Another layer of the scenario matched the same engine region. */
  shared: boolean;
  maxError?: number;
  framesWithError?: number;
  missing?: number;
  invented?: number;
  mismatched?: number;
  covered?: number;
}

interface Measure {
  name: string;
  status: string;
  frames: number;
  regions: { id: string; kind: string; rect: { x: number; y: number; width: number; height: number } }[];
  canvases: number;
  codes: Record<string, number>;
  layers: Record<string, LayerMeasure>;
}

const reports: Measure[] = [];

async function measure(name: string): Promise<Measure> {
  const scenario = buildScenario(name);
  const result: RunResult = await runScenario(scenario, scenario.settings ?? {});
  try {
    assertEquals(result.project.status, 'complete', `${name}: status`);
    assertEquals(result.project.renderedFrames, scenario.frames.length, `${name}: every frame rendered`);
    const codes: Record<string, number> = {};
    for (const d of result.diagnostics) codes[d.code] = (codes[d.code] ?? 0) + 1;
    const owner = (layer: Layer): string | null => {
      try {
        return matchRegion(result, layer).id;
      } catch {
        return null;
      }
    };
    const owners = Object.fromEntries(scenario.layers.map((l) => [l.id, owner(l)]));
    const layers: Record<string, LayerMeasure> = {};
    for (const layer of scenario.layers) {
      const region = owners[layer.id];
      const shared = region !== null && scenario.layers.some((other) => other.id !== layer.id && owners[other.id] === region);
      const fixed = result.regions.filter((r) => r.kind === 'fixed').find((r) =>
        r.rect.x < layer.viewport.x + layer.viewport.width && layer.viewport.x < r.rect.x + r.rect.width &&
        r.rect.y < layer.viewport.y + layer.viewport.height && layer.viewport.y < r.rect.y + r.rect.height &&
        r.rect.y > 0
      );
      const m: LayerMeasure = { region: region ?? fixed?.id ?? null, regionKind: region ? 'moving' : fixed ? 'fixed' : null, shared };
      if (region !== null) {
        const v = await verifyLayer(result, layer);
        Object.assign(m, {
          maxError: v.maxError,
          framesWithError: v.errors.filter((e) => e > 0).length,
          missing: v.missing,
          invented: v.invented,
          mismatched: v.mismatched,
          covered: v.covered,
        });
      }
      layers[layer.id] = m;
    }
    const report: Measure = {
      name,
      status: result.project.status,
      frames: result.project.renderedFrames,
      regions: result.regions.map((r) => ({ id: r.id, kind: r.kind, rect: r.rect })),
      canvases: result.canvases.length,
      codes,
      layers,
    };
    reports.push(report);
    return report;
  } finally {
    result.dispose();
  }
}

Deno.test('nested-scroll-box: the box shares the page region, its own 600 px scroll is lost, the page stays exact', async () => {
  const m = await measure('nested-scroll-box');
  const page = m.layers.body, box = m.layers.box;
  assertEquals(page.maxError, 0, 'the page is placed exactly');
  assertEquals(page.missing, 0);
  assertEquals(page.invented, 0);
  // The box's rectangle on the page canvas shows the box at one moment (320 × 110 px), not the page under it.
  assert(page.mismatched! <= 320 * 110, `page mismatched ${page.mismatched}`);
  // Known limitation: the box rides on the page's pose, so every frame after it starts scrolling by itself is off by
  // its own scroll. A region of its own, or poses that follow it, fail this until the scenario joins the catalogue.
  assert(box.shared, 'the box got a region of its own: move nested-scroll-box into the catalogue');
  assertEquals(box.maxError, 600, 'the box is still placed by the page alone');
});

Deno.test('pane-majority: the narrow pane rides on the wide pane, 320 px of its scroll are lost (own_a)', async () => {
  const m = await measure('pane-majority');
  const left = m.layers.left, right = m.layers.right;
  assertEquals(left.maxError, 0, 'the wide pane is placed exactly');
  assertEquals(left.missing, 0);
  // Known limitation: one region for both panes; while the wide pane stands still the region stands still, so the
  // narrow pane's 320 px of scrolling are never counted.
  assert(right.shared, 'the narrow pane got a region of its own: move pane-majority into the catalogue');
  assertEquals(right.maxError, 320, 'the narrow pane is still placed by the wide pane alone');
});

Deno.test('pane-rare-scroll: a pane that scrolls in six frames is frozen as screen-fixed, the busy pane stays exact', async () => {
  const m = await measure('pane-rare-scroll');
  const left = m.layers.left, right = m.layers.right;
  assertEquals(left.maxError, 0);
  assertEquals(left.missing, 0);
  assertEquals(left.invented, 0);
  assertEquals(left.mismatched, 0);
  // Known limitation (docs/ARCHITECTURE.md §十, the stationary-region rule): its pixels stay in place in most frames, so
  // the rule makes it a fixed region and the 120 px it scrolled are not on any canvas.
  assertEquals(right.regionKind, 'fixed', 'the rarely scrolling pane is no longer frozen: update pane-rare-scroll');
});

Deno.test('nested scrolling: write report', async () => {
  assertEquals(reports.length, NESTED_SCENARIO_NAMES.length);
  await Deno.mkdir('test-results', { recursive: true });
  await Deno.writeTextFile(
    'test-results/nested-scroll.json',
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        runtime: `Deno ${Deno.version.deno}`,
        command: 'deno test --allow-read --allow-write --allow-env tests/unit/nested-scroll.test.ts',
        reports,
      },
      null,
      1,
    ),
  );
});
