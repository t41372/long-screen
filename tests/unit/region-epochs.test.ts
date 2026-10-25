// Ownership that changes during a run (`Region.epochs`, rust/long-screen/src/kernels/regions/epochs.rs), end to end.
// `toolbar-collapse` is issue #1's shape: a 96 px header collapses to 48 px at frame 30 and the page's viewport grows
// upward by 48 rows. Hand-placed regions say so with epochs: the header owns rows 48–96 only before frame 30, the
// page owns them only from frame 30 on. Every pass must then read the frame's own label plane: the page canvas has
// to hold exactly the page, with the rows the collapse uncovers and none of the header.
//
// Failure cases, listed before the code: a pass that keeps reading the first plane (the page never owns rows 48–96,
// or the header's lower half is composited as page); solve tracking with the first epoch's exclusions after the
// collapse; render's compositor taking the first plane's owned-pixel count (the rectangular fast path for a region
// that is not fully owned); reveal pushing frames with the wrong plane; a run without epochs changing at all (the
// synthetic fingerprint covers that one).
import { assert, assertEquals } from '@std/assert';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { constantFrames, linearPath, type Scenario, viewportAt } from '../../src/synthetic/world.ts';
import type { Region } from '../../src/types.ts';
import { RegionAtlas } from '../../src/core/layers.ts';
import { runScenario, verifyLayer } from '../support/run.ts';

const W = 640, H = 448, TALL = 96, SHORT = 48, COLLAPSE = 30;
const band = { x: 0, y: SHORT, width: W, height: TALL - SHORT };

function epochRegions(): Region[] {
  return [
    {
      id: 'bar',
      name: '固定界面',
      kind: 'fixed',
      rect: { x: 0, y: 0, width: W, height: TALL },
      epochs: [{ from: COLLAPSE, exclusions: [band] }],
    },
    {
      id: 'page',
      name: '内容画布 1',
      kind: 'moving',
      rect: { x: 0, y: SHORT, width: W, height: H - SHORT },
      epochs: [{ from: 0, exclusions: [band] }, { from: COLLAPSE, exclusions: [] }],
    },
  ];
}

Deno.test('region epochs: the atlas gives the collapsed rows to the bar before the collapse and to the page after it', () => {
  const regions = epochRegions(), atlas = new RegionAtlas(regions, W, H);
  try {
    assertEquals(atlas.starts, [0, COLLAPSE]);
    const bar = atlas.code(regions[0]), page = atlas.code(regions[1]);
    for (const [frame, owner] of [[0, bar], [COLLAPSE - 1, bar], [COLLAPSE, page], [50, page]]) {
      assertEquals(atlas.labelsAt(frame)[60 * W + 10], owner, `frame ${frame}, row 60`);
    }
    assertEquals(atlas.labelsAt(0)[20 * W], bar);
    assertEquals(atlas.labelsAt(50)[20 * W], bar);
    assertEquals(atlas.labelsAt(0)[200 * W], page);
    assertEquals(atlas.count(page, 0), W * (H - TALL));
    assertEquals(atlas.count(page, COLLAPSE), W * (H - SHORT));
    assertEquals(atlas.owned(page), [[COLLAPSE, W * (H - SHORT)]]);
    assertEquals(atlas.count(bar, COLLAPSE), W * SHORT);
  } finally {
    atlas.dispose();
  }
  // Without epochs: one plane, the same as before epochs existed.
  const plain = new RegionAtlas([{ id: 'p', name: '内容画布 1', kind: 'moving', rect: { x: 0, y: 0, width: W, height: H } }], W, H);
  try {
    assertEquals(plain.starts, [0]);
    assertEquals(plain.owned(1), []);
    assert(plain.residentAt(1000) === plain.resident);
  } finally {
    plain.dispose();
  }
});

/** `toolbar-collapse` as defined, or (`up`) a variant that turns round at the collapse and scrolls back up past where
 *  it started: the last rows it reaches show only in the band the collapse uncovers, so a pass that kept the first
 *  plane would leave them out. */
function collapse(up: boolean): Scenario {
  const s = buildScenario('toolbar-collapse');
  if (!up) return s;
  const layer = s.layers[0], raw = linearPath([{ x: 0, y: 400 }, { x: 0, y: 1000 }, { x: 0, y: 200 }], [COLLAPSE, COLLAPSE]);
  const viewports = raw.map((_, i) => {
    const y = i < COLLAPSE ? TALL : SHORT;
    return { x: 0, y, width: W, height: H - y };
  });
  layer.viewport = viewports[0];
  layer.viewports = viewports;
  layer.path = raw.map((p, i) => ({ x: p.x, y: p.y + viewports[i].y - viewports[0].y }));
  s.frames = constantFrames(raw.length);
  return s;
}

for (const up of [false, true]) {
  Deno.test(`region epochs: ${up ? 'a collapse that turns back up' : 'toolbar-collapse'} with hand-placed epochs reconstructs every page pixel exactly`, async () => {
    const scenario = collapse(up), layer = scenario.layers[0];
    const result = await runScenario(scenario, { ...scenario.settings, regions: epochRegions() });
    try {
      assertEquals(result.project.status, 'complete');
      assertEquals(result.project.renderedFrames, scenario.frames.length);
      const v = await verifyLayer(result, layer);
      // Every world row the page's viewport ever showed (`path` is the world offset of its top-left), full width.
      let top = Infinity, bottom = -Infinity;
      scenario.frames.forEach((_, i) => {
        top = Math.min(top, layer.path[i].y);
        bottom = Math.max(bottom, layer.path[i].y + viewportAt(layer, i).height);
      });
      const report = {
        maxError: v.maxError,
        missing: v.missing,
        invented: v.invented,
        mismatched: v.mismatched,
        contaminated: v.contaminated,
        provisional: v.mainCanvas.provisionalPixels,
        fragments: v.fragments.length,
        covered: v.covered,
        visible: W * (bottom - top),
      };
      reports[up ? 'up' : 'down'] = report;
      assertEquals(v.fragments.length, 0, 'one page canvas');
      assertEquals(v.maxError, 0, 'placements');
      assertEquals(v.missing, 0, 'observed page pixels missing from the canvas');
      assertEquals(v.invented, 0, 'canvas pixels outside every observed page viewport (the header)');
      assertEquals(v.mismatched, 0, 'canvas pixels matching no page content');
      assertEquals(v.covered, report.visible, 'every page pixel any frame showed is on the canvas');
    } finally {
      result.dispose();
    }
  });
}

const reports: Record<string, unknown> = {};
Deno.test('region epochs: write report', async () => {
  await Deno.mkdir('test-results', { recursive: true });
  await Deno.writeTextFile(
    'test-results/region-epochs.json',
    JSON.stringify({ command: 'deno test --allow-read --allow-write --allow-env tests/unit/region-epochs.test.ts', reports }, null, 1),
  );
});
