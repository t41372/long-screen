import { assert, assertEquals } from '@std/assert';
import { buildScenario } from '../../src/synthetic/scenarios.ts';
import { renderFrame } from '../../src/synthetic/world.ts';
import type { Settings } from '../../src/types.ts';
import { runScenario, verifyFixed, verifyLayer, type RunResult } from './run.ts';
export interface ScenarioReport {
    name: string;
    seconds: number;
    frames: number;
    status: string;
    layers: Record<string, { maxError: number; missing: number; invented: number; mismatched: number; contaminated: number; skipped: number; fragments: number; covered: number }>;
    fixed: Record<string, { mismatched: number; conflicts: number; covered: number }>;
    codes: string[];
    memory: RunResult['memory'];
}
/** Runs a named scenario through the real engine and asserts its ground-truth invariants. */
export async function checkScenario(name: string, settings: Partial<Settings> = {}): Promise<ScenarioReport> {
    const scenario = buildScenario(name), result = await runScenario(scenario, settings), e = scenario.expect;
    assertEquals(result.project.status, e.status, `${name}: status ${result.project.status} (${result.project.error ?? ''})`);
    if (e.frames !== undefined)
        assertEquals(result.project.renderedFrames, e.frames, `${name}: rendered frames`);
    else
        assertEquals(result.project.renderedFrames, scenario.frames.length, `${name}: every frame rendered`);
    assertEquals(result.observations.length, result.project.renderedFrames, `${name}: one observation ledger row per frame`);
    for (const code of e.diagnostics.present)
        assert(result.codes.has(code), `${name}: expected diagnostic ${code}; got ${[...result.codes].join(',')}`);
    for (const code of e.diagnostics.absent)
        assert(!result.codes.has(code), `${name}: unexpected diagnostic ${code}`);
    assert(result.memory.peakResidentTiles <= result.memory.tileCacheLimit, `${name}: tile cache exceeded`);
    const report: ScenarioReport = { name, seconds: Number(result.seconds.toFixed(1)), frames: result.project.renderedFrames, status: result.project.status, layers: {}, fixed: {}, codes: [...result.codes], memory: result.memory };
    for (const layer of scenario.layers) {
        const v = await verifyLayer(result, layer), expectedFragments = e.fragments[layer.id];
        report.layers[layer.id] = { maxError: v.maxError, missing: v.missing, invented: v.invented, mismatched: v.mismatched, contaminated: v.contaminated, skipped: v.skipped, fragments: v.fragments.length, covered: v.covered };
        if (expectedFragments !== undefined && expectedFragments >= 0)
            assertEquals(v.fragments.length, expectedFragments, `${name}/${layer.id}: fragments`);
        if (Number.isFinite(e.maxError))
            assert(v.maxError <= e.maxError, `${name}/${layer.id}: max placement error ${v.maxError}px`);
        if (e.ambiguousPeriod) {
            // Pixel-identical rows: any error must be a whole number of rows, never an arbitrary misalignment.
            for (const err of v.errors)
                assert(Number.isFinite(err) && Math.abs(err / e.ambiguousPeriod - Math.round(err / e.ambiguousPeriod)) < 1e-9, `${name}/${layer.id}: error ${err}px is not a multiple of the ${e.ambiguousPeriod}px period`);
            assert(v.errors.some(err => err > 0), `${name}: the scenario is meant to be ambiguous; if it is now solved, promote it to an exact test`);
        }
        else if (e.limitation) {
            assert(v.mismatched < v.covered * .1 && v.invented < v.covered * .1, `${name}: known limitation exceeded 10% wrong pixels`);
        }
        else {
            assertEquals(v.invented, 0, `${name}/${layer.id}: pixels painted outside any observed viewport`);
            assertEquals(v.missing, 0, `${name}/${layer.id}: observed pixels missing from the canvas`);
            assertEquals(v.mismatched, 0, `${name}/${layer.id}: pixels that match no content version and no overlay`);
        }
        assert(v.framesOnMain + v.framesOnFragments + v.skipped === result.project.renderedFrames, `${name}/${layer.id}: every frame accounted for`);
    }
    for (const overlay of scenario.overlays.filter(o => o.kind === 'fixed')) {
        const rects = overlay.draw(renderFrame(scenario, 0).image, 0, 0);
        for (const rect of rects) {
            if (rect.width * rect.height < 4000)
                continue;
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
    await Deno.writeTextFile(`test-results/${file}`, JSON.stringify({ generated: new Date().toISOString(), runtime: `Deno ${Deno.version.deno}`, note: 'Synthetic ground-truth scenarios: max placement error, missing/invented/mismatched pixels are exact counts against the generating world, not similarity scores.', reports }, null, 2));
}
