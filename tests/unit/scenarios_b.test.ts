import { checkScenario, writeReport, type ScenarioReport } from '../support/scenario-check.ts';
const reports: ScenarioReport[] = [];
Deno.test('scenario panes: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('panes')); });
Deno.test('scenario gap: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('gap')); });
Deno.test('scenario dynamic: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('dynamic')); });
Deno.test('scenario lazy-load: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('lazy-load')); });
Deno.test('scenario zoom: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('zoom')); });
Deno.test('scenario blank: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => { reports.push(await checkScenario('blank')); });
Deno.test('scenario group b: write report', async () => { await writeReport(reports, 'scenarios-b.json'); });
