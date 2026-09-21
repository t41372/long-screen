import { checkScenario, type ScenarioReport, writeReport } from '../support/scenario-check.ts';
const reports: ScenarioReport[] = [];
Deno.test('scenario retina: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('retina'));
});
Deno.test('scenario factor4: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('factor4'));
});
Deno.test('scenario geometry-change: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('geometry-change'));
});
Deno.test('scenario toolbar-collapse: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('toolbar-collapse'));
});
Deno.test('scenario chrome-everything: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('chrome-everything'));
});
Deno.test('scenario fixture: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('fixture'));
});
Deno.test('scenario group d: write report', async () => {
  await writeReport(reports, 'scenarios-d.json');
});
