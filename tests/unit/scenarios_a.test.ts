import { checkScenario, writeReport, type ScenarioReport } from '../support/scenario-check.ts';
const reports: ScenarioReport[] = [];
Deno.test('scenario traversal: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('traversal')); });
Deno.test('scenario vertical: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('vertical')); });
Deno.test('scenario horizontal: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('horizontal')); });
Deno.test('scenario diagonal: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('diagonal')); });
Deno.test('scenario fling: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('fling')); });
Deno.test('scenario revisit: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('revisit')); });
Deno.test('scenario group a: write report', async () => { await writeReport(reports, 'scenarios-a.json'); });
