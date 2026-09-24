import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { buildScenario, SCENARIO_NAMES } from '../../src/synthetic/scenarios.ts';
import { renderFrame } from '../../src/synthetic/world.ts';
import type { Settings } from '../../src/types.ts';
/** Every scenario checkScenario() can run: the named catalogue plus the one extra fixture-file-backed scenario
 *  ('fixture', not in SCENARIO_NAMES). registerShard() below derives each shard from this single list, so it and
 *  scripts/fingerprint-scenarios.ts always traverse exactly the same set in the same order. */
export const SCENARIO_CATALOGUE: readonly string[] = [...SCENARIO_NAMES, 'fixture'];
import type { FragmentReport } from '../../src/synthetic/verify.ts';
import { type RunResult, runScenario, verifyCanvasAccounting, verifyFixed, verifyLayer } from './run.ts';
export interface ScenarioReport {
  name: string;
  seconds: number;
  frames: number;
  status: string;
  /** Integer analysis downscale factor the engine computed for this scenario's frame size and settings. */
  factor: number;
  layers: Record<
    string,
    {
      maxError: number;
      missing: number;
      invented: number;
      mismatched: number;
      contaminated: number;
      contaminatedOverlay: number;
      contaminatedOverlayUnobservable: number;
      contaminatedOverlayRecoverable: number;
      unobservableProvisional: number;
      analyticUnobservable: number;
      contaminatedDynamic: number;
      provisionalPixels: number;
      skipped: number;
      fragments: number;
      covered: number;
      fragmentReports: FragmentReport[];
    }
  >;
  fixed: Record<string, { mismatched: number; conflicts: number; covered: number }>;
  codes: string[];
  memory: RunResult['memory'];
}
/** Runs a named scenario through the real engine and asserts its ground-truth invariants. */
export async function checkScenario(name: string, settings: Partial<Settings> = {}): Promise<ScenarioReport> {
  const scenario = buildScenario(name), result = await runScenario(scenario, { ...scenario.settings, ...settings }), e = scenario.expect;
  assertEquals(result.project.status, e.status, `${name}: status ${result.project.status} (${result.project.error ?? ''})`);
  if (e.frames !== undefined) {
    assertEquals(result.project.renderedFrames, e.frames, `${name}: rendered frames`);
  } else {
    assertEquals(result.project.renderedFrames, scenario.frames.length, `${name}: every frame rendered`);
  }
  assertEquals(result.observations.length, result.project.renderedFrames, `${name}: one observation ledger row per frame`);
  for (const code of e.diagnostics.present) {
    assert(result.codes.has(code), `${name}: expected diagnostic ${code}; got ${[...result.codes].join(',')}`);
  }
  for (const code of e.diagnostics.absent) {
    assert(!result.codes.has(code), `${name}: unexpected diagnostic ${code}`);
  }
  assert(result.memory.peakResidentTiles <= result.memory.tileCacheLimit, `${name}: tile cache exceeded`);
  if (e.factor !== undefined) {
    assertEquals(result.engine.factor, e.factor, `${name}: analysis factor`);
  }
  // Content-agnostic bookkeeping check: every canvas with tiles must have a level-0 tile-index whose row count matches
  // its own tileCount, and whose recomputed covered-bit total matches its own observedPixels. Covers moving, fixed and
  // presentation canvases alike, independent of the per-layer world-truth checks below.
  for (const canvas of result.canvases) {
    if (!canvas.tileCount) {
      continue;
    }
    const a = await verifyCanvasAccounting(result, canvas);
    assertEquals(a.tileRows, canvas.tileCount, `${name}/${canvas.id}: tile-index row count ${a.tileRows} vs tileCount ${canvas.tileCount}`);
    assertEquals(
      a.countedPixels,
      canvas.observedPixels,
      `${name}/${canvas.id}: recomputed covered pixels ${a.countedPixels} vs observedPixels ${canvas.observedPixels}`,
    );
  }
  const report: ScenarioReport = {
    name,
    seconds: Number(result.seconds.toFixed(1)),
    frames: result.project.renderedFrames,
    status: result.project.status,
    factor: result.engine.factor,
    layers: {},
    fixed: {},
    codes: [...result.codes],
    memory: result.memory,
  };
  for (const layer of scenario.layers) {
    const v = await verifyLayer(result, layer), expectedFragments = e.fragments[layer.id];
    report.layers[layer.id] = {
      maxError: v.maxError,
      missing: v.missing,
      invented: v.invented,
      mismatched: v.mismatched,
      contaminated: v.contaminated,
      contaminatedOverlay: v.contaminatedOverlay,
      contaminatedOverlayUnobservable: v.contaminatedOverlayUnobservable,
      contaminatedOverlayRecoverable: v.contaminatedOverlayRecoverable,
      unobservableProvisional: v.unobservableProvisional,
      analyticUnobservable: v.analyticUnobservable,
      contaminatedDynamic: v.contaminatedDynamic,
      provisionalPixels: v.mainCanvas.provisionalPixels,
      skipped: v.skipped,
      fragments: v.fragments.length,
      covered: v.covered,
      fragmentReports: v.fragmentReports,
    };
    if (expectedFragments !== undefined && expectedFragments >= 0) {
      assertEquals(v.fragments.length, expectedFragments, `${name}/${layer.id}: fragments`);
    }
    if (Number.isFinite(e.maxError)) {
      assert(v.maxError <= e.maxError, `${name}/${layer.id}: max placement error ${v.maxError}px`);
    }
    if (e.ambiguousPeriod) {
      // Pixel-identical rows: any error must be a whole number of rows, never an arbitrary misalignment.
      for (const err of v.errors) {
        assert(
          Number.isFinite(err) && Math.abs(err / e.ambiguousPeriod - Math.round(err / e.ambiguousPeriod)) < 1e-9,
          `${name}/${layer.id}: error ${err}px is not a multiple of the ${e.ambiguousPeriod}px period`,
        );
      }
      assert(
        v.errors.some((err) => err > 0),
        `${name}: the scenario is meant to be ambiguous; if it is now solved, promote it to an exact test`,
      );
    } else if (e.limitation) {
      assert(v.mismatched < v.covered * .1 && v.invented < v.covered * .1, `${name}: known limitation exceeded 10% wrong pixels`);
    } else {
      assertEquals(v.invented, 0, `${name}/${layer.id}: pixels painted outside any observed viewport`);
      assertEquals(v.missing, 0, `${name}/${layer.id}: observed pixels missing from the canvas`);
      assertEquals(v.mismatched, 0, `${name}/${layer.id}: pixels that match no content version and no overlay`);
    }
    // Additive, ratcheted bounds on top of the branch above: default 0 (exact). A scenario with a known, measured
    // deviation declares maxMissing/maxInvented/maxMismatched/maxContaminated explicitly instead of loosening the checks
    // above; these can only be lowered over time, never silently raised by a passing run.
    assert(v.missing <= (e.maxMissing ?? 0), `${name}/${layer.id}: missing ${v.missing} exceeds ratchet ${e.maxMissing ?? 0}`);
    assert(v.invented <= (e.maxInvented ?? 0), `${name}/${layer.id}: invented ${v.invented} exceeds ratchet ${e.maxInvented ?? 0}`);
    assert(
      v.mismatched <= (e.maxMismatched ?? 0),
      `${name}/${layer.id}: mismatched ${v.mismatched} exceeds ratchet ${e.maxMismatched ?? 0}`,
    );
    // maxContaminated stays available as the combined ratchet (defaulting to the sum of the split ratchets below
    // when not declared explicitly), but a scenario with any overlay/dynamic contamination must declare the
    // split explicitly: maxContaminatedOverlay targets the world-consistency mask (0 unless a scenario proves
    // it cannot reach 0), maxContaminatedDynamic covers the page-space dynamics that are allowed to keep one moment.
    const maxOverlay = e.maxContaminatedOverlay ?? 0, maxDynamic = e.maxContaminatedDynamic ?? 0;
    assert(
      v.contaminatedOverlay <= maxOverlay,
      `${name}/${layer.id}: contaminatedOverlay ${v.contaminatedOverlay} exceeds ratchet ${maxOverlay}`,
    );
    assert(
      v.contaminatedDynamic <= maxDynamic,
      `${name}/${layer.id}: contaminatedDynamic ${v.contaminatedDynamic} exceeds ratchet ${maxDynamic}`,
    );
    assert(
      v.contaminated <= (e.maxContaminated ?? maxOverlay + maxDynamic),
      `${name}/${layer.id}: contaminated ${v.contaminated} exceeds ratchet ${e.maxContaminated ?? maxOverlay + maxDynamic}`,
    );
    // Precise overlay-contamination targets (docs/ARCHITECTURE.md §七, issue #2): a pixel is only
    // a genuine detection miss (contaminatedOverlayRecoverable, target 0 — see maxContaminatedOverlayRecoverable
    // doc) if its world position was observed clean somewhere; otherwise no observation in the recording could
    // ever have healed it (contaminatedOverlayUnobservable), which is a property of the scenario's own overlay
    // geometry, not of engine behaviour. The coherence check (measured unobservable pixels never exceed the
    // scenario's analytic ceiling) is unconditional — it would fail only if verify.ts's own classification were
    // inconsistent with its own analytic computation, never as a result of engine behaviour.
    assert(
      v.contaminatedOverlayUnobservable <= v.analyticUnobservable,
      `${name}/${layer.id}: contaminatedOverlayUnobservable ${v.contaminatedOverlayUnobservable} exceeds the scenario's own analytic ceiling ${v.analyticUnobservable}`,
    );
    assert(
      v.analyticUnobservable <= (e.maxContaminatedOverlayUnobservable ?? 0),
      `${name}/${layer.id}: analyticUnobservable ${v.analyticUnobservable} exceeds ratchet ${e.maxContaminatedOverlayUnobservable ?? 0}`,
    );
    assert(
      v.contaminatedOverlayRecoverable <= (e.maxContaminatedOverlayRecoverable ?? 0),
      `${name}/${layer.id}: contaminatedOverlayRecoverable ${v.contaminatedOverlayRecoverable} exceeds ratchet ${
        e.maxContaminatedOverlayRecoverable ?? 0
      }`,
    );
    assert(
      v.mainCanvas.provisionalPixels <= (e.maxProvisional ?? 0),
      `${name}/${layer.id}: provisionalPixels ${v.mainCanvas.provisionalPixels} exceeds ratchet ${e.maxProvisional ?? 0}`,
    );
    assert(
      v.framesOnMain + v.framesOnFragments + v.skipped === result.project.renderedFrames,
      `${name}/${layer.id}: every frame accounted for`,
    );
    // Every fragment gets the same treatment as the main canvas above. A fragment containing a zoomed frame cannot be
    // pixel-checked (content is resampled); it only has to account for its frames and hold some observed pixels.
    for (const f of v.fragmentReports) {
      if (!f.pixelChecked) {
        const meta = v.fragments.find((c) => c.id === f.canvasId);
        assert(meta !== undefined && meta.observedPixels > 0, `${name}/${layer.id}/${f.canvasId}: zoomed fragment has no observed pixels`);
        continue;
      }
      assert(f.covered > 0, `${name}/${layer.id}/${f.canvasId}: fragment covers no pixels`);
      if (e.limitation) {
        assert(
          f.mismatched < f.covered * .1 && f.invented < f.covered * .1,
          `${name}/${f.canvasId}: known limitation exceeded 10% wrong pixels`,
        );
      } else if (!e.ambiguousPeriod) {
        assertEquals(f.invented, 0, `${name}/${layer.id}/${f.canvasId}: pixels painted outside any observed viewport`);
        assertEquals(f.missing, 0, `${name}/${layer.id}/${f.canvasId}: observed pixels missing from the canvas`);
        assertEquals(f.mismatched, 0, `${name}/${layer.id}/${f.canvasId}: pixels that match no content version and no overlay`);
      }
      assert(
        f.missing <= (e.maxMissing ?? 0),
        `${name}/${layer.id}/${f.canvasId}: missing ${f.missing} exceeds ratchet ${e.maxMissing ?? 0}`,
      );
      assert(
        f.invented <= (e.maxInvented ?? 0),
        `${name}/${layer.id}/${f.canvasId}: invented ${f.invented} exceeds ratchet ${e.maxInvented ?? 0}`,
      );
      assert(
        f.mismatched <= (e.maxMismatched ?? 0),
        `${name}/${layer.id}/${f.canvasId}: mismatched ${f.mismatched} exceeds ratchet ${e.maxMismatched ?? 0}`,
      );
      assert(
        f.contaminatedOverlay <= maxOverlay,
        `${name}/${layer.id}/${f.canvasId}: contaminatedOverlay ${f.contaminatedOverlay} exceeds ratchet ${maxOverlay}`,
      );
      assert(
        f.contaminatedDynamic <= maxDynamic,
        `${name}/${layer.id}/${f.canvasId}: contaminatedDynamic ${f.contaminatedDynamic} exceeds ratchet ${maxDynamic}`,
      );
      assert(
        f.contaminated <= (e.maxContaminated ?? maxOverlay + maxDynamic),
        `${name}/${layer.id}/${f.canvasId}: contaminated ${f.contaminated} exceeds ratchet ${e.maxContaminated ?? maxOverlay + maxDynamic}`,
      );
    }
  }
  for (const overlay of scenario.overlays.filter((o) => o.kind === 'fixed')) {
    const rects = overlay.draw(renderFrame(scenario, 0).image, 0, 0);
    for (const rect of rects) {
      if (rect.width * rect.height < 4000) {
        continue;
      }
      const f = await verifyFixed(result, rect);
      report.fixed[overlay.id] = { mismatched: f.mismatched, conflicts: f.conflicts, covered: f.covered };
      if (!e.limitation) {
        assertEquals(f.mismatched, 0, `${name}/${overlay.id}: fixed pixels differ from the observed band`);
        assertEquals(f.conflicts, 0, `${name}/${overlay.id}: a static band reported temporal conflicts`);
        assert(f.covered >= rect.width * rect.height * .5, `${name}/${overlay.id}: fixed canvas covers too little of the band`);
      }
    }
  }
  return report;
}
export async function writeReport(reports: ScenarioReport[], file: string): Promise<void> {
  await Deno.mkdir('test-results', { recursive: true });
  await Deno.writeTextFile(
    `test-results/${file}`,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        runtime: `Deno ${Deno.version.deno}`,
        note:
          'Synthetic ground-truth scenarios: max placement error, missing/invented/mismatched pixels are exact counts against the generating world, not similarity scores.',
        reports,
      },
      null,
      2,
    ),
  );
}
const SHARD_COUNT = 4;
/** Report-file label for shard index 0..SHARD_COUNT-1, in order — derived alongside the index in registerShard()
 *  below so a shard's number, its scenario slice and its report label can never drift apart from each other. */
const SHARD_LABELS = ['a', 'b', 'c', 'd'] as const;
if (SHARD_LABELS.length !== SHARD_COUNT) {
  throw new Error(`SHARD_LABELS has ${SHARD_LABELS.length} entries but SHARD_COUNT is ${SHARD_COUNT}`);
}
/** A deterministic, order-preserving slice of the catalogue: shard `index` of `count` gets
 *  SCENARIO_CATALOGUE[floor(n·index/count) .. floor(n·(index+1)/count)). Every entry lands in exactly one shard by
 *  construction, for any `count` that evenly (or near-evenly) divides the catalogue. */
function shardSlice(index: number, count: number): readonly string[] {
  const n = SCENARIO_CATALOGUE.length;
  const start = Math.floor(n * index / count), end = Math.floor(n * (index + 1) / count);
  return SCENARIO_CATALOGUE.slice(start, end);
}
// Self-check, run once at import time (pure and cheap — no dependency on the other shard files having run, which
// matters under `deno test --parallel`'s per-file process isolation). Two independent things are checked: (1) the
// floor(n·i/c) arithmetic is a true partition of SCENARIO_CATALOGUE for SHARD_COUNT shards — catches the catalogue
// changing under a stale SHARD_COUNT; (2) tests/unit contains exactly the files scenarios-1.test.ts..
// scenarios-SHARD_COUNT.test.ts — catches a shard file added, removed or duplicated (registerShard() below derives
// each file's own shard index from its filename, so (1) alone can no longer catch that: every index it can ever
// see is a real, distinct index by construction, whether or not the right set of files registered it).
(() => {
  const seen = new Map<string, number>();
  for (let i = 0; i < SHARD_COUNT; i++) {
    for (const name of shardSlice(i, SHARD_COUNT)) seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const missing = SCENARIO_CATALOGUE.filter((name) => !seen.has(name));
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  if (missing.length || duplicated.length) {
    throw new Error(`scenario shard partition is broken: missing=[${missing.join(',')}] duplicated=[${duplicated.join(',')}]`);
  }
  const dir = fromFileUrl(new URL('../unit/', import.meta.url));
  const expected = new Set(Array.from({ length: SHARD_COUNT }, (_, i) => `scenarios-${i + 1}.test.ts`));
  const found = new Set<string>();
  for (const entry of Deno.readDirSync(dir)) {
    if (/^scenarios-\d+\.test\.ts$/.test(entry.name)) found.add(entry.name);
  }
  const extra = [...found].filter((f) => !expected.has(f));
  const absent = [...expected].filter((f) => !found.has(f));
  if (extra.length || absent.length) {
    throw new Error(
      `tests/unit scenario shard files don't match SHARD_COUNT=${SHARD_COUNT}: missing=[${absent.join(',')}] extra=[${extra.join(',')}]`,
    );
  }
})();
/** Registers one Deno.test per scenario in the shard whose number is parsed out of `callerUrl` (the registering
 *  test file's own import.meta.url, e.g. ".../tests/unit/scenarios-3.test.ts" → shard index 2), plus a final
 *  "write report" test persisting test-results/scenarios-<label>.json. Deriving the index from the caller's own
 *  filename (instead of a hand-passed index/count pair) means a shard file can no longer register the wrong slice,
 *  duplicate another file's slice, or use a stale `count` — the self-check above then only has to confirm the set
 *  of files is exactly scenarios-1..SHARD_COUNT. */
export function registerShard(callerUrl: string): void {
  const match = /scenarios-(\d+)\.test\.ts$/.exec(callerUrl);
  const n = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > SHARD_COUNT) {
    throw new Error(`registerShard: caller ${callerUrl} is not one of tests/unit/scenarios-1..${SHARD_COUNT}.test.ts`);
  }
  const index = n - 1, label = SHARD_LABELS[index];
  const names = shardSlice(index, SHARD_COUNT), reports: ScenarioReport[] = [];
  for (const name of names) {
    Deno.test(`scenario ${name}: exact placement, pixel identity, coverage set equality, fragments and diagnostics`, async () => {
      reports.push(await checkScenario(name));
    });
  }
  Deno.test(`scenario group ${label}: write report`, async () => {
    await writeReport(reports, `scenarios-${label}.json`);
  });
}
