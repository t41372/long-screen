// Nested scrolling, measured. The solve pass finds a container that scrolls inside a moving region and solves it as a
// region of its own inside its footprint (docs/ARCHITECTURE.md §六), so each layer is checked against its own region
// (Layer.parent). A pixel where the nested layer shows what its parent shows under it counts for neither layer
// (docs/TESTING.md). These scenarios are not in the catalogue yet: margins the motion cannot place still count. This
// file records each run (test-results/nested-scroll.json) and guards it in two directions:
//
// - what is still wrong is pinned like a catalogue ratchet (it only moves down): when it reaches zero, the scenario
//   should move into the catalogue with exact checks;
// - what is right today must stay right.
import { assert, assertEquals } from '@std/assert';
import { buildScenario, NESTED_SCENARIO_NAMES } from '../../src/synthetic/scenarios.ts';
import { matchRegion, type RunResult, runScenario, verifyLayer } from '../support/run.ts';

interface LayerMeasure {
  region: string | null;
  regionKind: string | null;
  /** Another layer of the scenario matched the same engine region. */
  shared: boolean;
  /** The engine region's parent, for a nested container. */
  parent?: string | null;
  fragments?: number;
  moment?: number;
  momentMismatched?: number;
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
    const owners: Record<string, string | null> = {};
    for (const layer of scenario.layers) {
      try {
        owners[layer.id] = matchRegion(result, layer).id;
      } catch {
        owners[layer.id] = null;
      }
    }
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
          parent: result.regions.find((r) => r.id === region)?.parent ?? null,
          maxError: v.maxError,
          framesWithError: v.errors.filter((e) => e > 0).length,
          fragments: v.fragments.length,
          missing: v.missing,
          invented: v.invented,
          mismatched: v.mismatched,
          moment: v.moment,
          momentMismatched: v.momentMismatched,
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

// The margins: nested-scroll-box's box is 320 px wide and its cards leave 34 px on the left and 24 px on the right
// without texture, which the parent draws; the box's background there differs from the page's under the box, so the
// pixels are told apart and count as missing from the box's canvas (48 columns × the 710 rows it showed). The 20 px
// blank margin of pane-majority's narrow pane is the screen's background, which the parent shows there too, and does
// not count; its text starts 4 px further in than the footprint's edge.
//
// A parent's print shows its nested layer as it was in one state of its own scroll (`kernels/track/nested.rs`'s
// `Moments`): the verifier counts those pixels as `moment`, not as invented.
Deno.test('nested-scroll-box: the box is solved on its own inside the page, exact but for its blank margins', async () => {
  const m = await measure('nested-scroll-box');
  const page = m.layers.body, box = m.layers.box;
  assertEquals(m.codes.NESTED_LAYER_FOUND, 1, 'the solve pass finds the box');
  assert(!box.shared && box.parent === page.region, `the box has a region of its own inside the page's (${box.region})`);
  for (const [name, layer] of [['page', page], ['box', box]] as const) {
    assertEquals(layer.maxError, 0, `${name} placed exactly`);
    assertEquals(layer.fragments, 0, `${name} in one piece`);
    assertEquals(layer.mismatched, 0, `${name} mismatched`);
  }
  assertEquals(page.missing, 0);
  assertEquals(page.invented, 0);
  assertEquals(box.invented, 0);
  assertEquals(page.momentMismatched, 0);
  assertEquals(page.moment, 320 * 110, 'the page shows the whole box at one moment');
  // Known limitation: the margins. Ratchet: it only moves down; at zero the scenario joins the catalogue.
  assert(box.missing! <= 34080, `box missing ${box.missing}`);
});

Deno.test('pane-majority: the narrow pane is solved on its own inside the wide one, its 320 px scroll kept (own_a)', async () => {
  const m = await measure('pane-majority');
  const left = m.layers.left, right = m.layers.right;
  assertEquals(m.codes.NESTED_LAYER_FOUND, 1, 'the solve pass finds the narrow pane');
  assert(!right.shared && right.parent === left.region, `the narrow pane has a region of its own (${right.region})`);
  for (const [name, layer] of [['wide pane', left], ['narrow pane', right]] as const) {
    assertEquals(layer.fragments, 0, `${name} in one piece`);
    assertEquals(layer.mismatched, 0, `${name} mismatched`);
  }
  assertEquals(left.maxError, 0, 'the wide pane is placed exactly');
  assertEquals(left.missing, 0);
  assertEquals(left.invented, 0);
  assertEquals(right.invented, 0);
  assert(left.moment! > 0, 'the wide pane shows the narrow one at one moment');
  // Ratchets: one frame of the narrow pane 1 px off; the blank margin.
  assert(right.maxError! <= 1 && right.framesWithError! <= 1, `narrow pane error ${right.maxError} in ${right.framesWithError} frames`);
  assertEquals(left.momentMismatched, 0);
  assert(right.missing! <= 2624, `narrow pane missing ${right.missing}`);
});

Deno.test('pane-majority-revisit: the narrow pane is solved on its own, and the revisits at the end agree with it', async () => {
  const m = await measure('pane-majority-revisit');
  const left = m.layers.left, right = m.layers.right;
  assertEquals(m.codes.NESTED_LAYER_FOUND, 1, 'the solve pass finds the narrow pane');
  assert(!right.shared && right.parent === left.region, `the narrow pane has a region of its own (${right.region})`);
  // The first run still sees the revisits 320 px from the wide pane's trajectory; the narrow pane's own run does not.
  assert((m.codes.INCONSISTENT_LOOP_REJECTED ?? 0) >= 1, 'a revisit sees the missed scroll in the first run');
  assertEquals(left.fragments, 0);
  assertEquals(right.fragments, 0);
  assertEquals(left.mismatched, 0);
  // Ratchets: both layers measure the last frame's step 1 px short (before 2c too); the narrow pane's loop spreads that
  // over its trajectory, up to 0.95 px, which shows as mismatched and invented pixels; the margin.
  assert(right.maxError! < 1, `narrow pane error ${right.maxError}`);
  assert(right.mismatched! <= 13562, `narrow pane mismatched ${right.mismatched}`);
  assert(right.invented! <= 2018, `narrow pane invented ${right.invented}`);
  assert(left.maxError! <= 1 && left.framesWithError! <= 1, `wide pane error ${left.maxError} in ${left.framesWithError} frames`);
  assertEquals(left.invented, 0);
  assert(left.momentMismatched! <= 1101, `wide pane momentMismatched ${left.momentMismatched}`);
  assert(right.missing! <= 2839, `narrow pane missing ${right.missing}`);
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
  // Frozen into a fixed region, it is not inside any moving region the solve pass could find it in.
  assertEquals(m.codes.NESTED_LAYER_FOUND, undefined);
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
