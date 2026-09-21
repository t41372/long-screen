import { checkScenario, type ScenarioReport, writeReport } from '../support/scenario-check.ts';
const reports: ScenarioReport[] = [];
Deno.test('scenario repeated-list: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('repeated-list'));
});
Deno.test('scenario repeated-list-reversal: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('repeated-list-reversal'));
});
Deno.test('scenario comic: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('comic'));
});
Deno.test('scenario phone: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('phone'));
});
Deno.test('scenario vfr: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('vfr'));
});
Deno.test('scenario glimpse: exact placement, pixel identity, coverage set equality, fragments and diagnostics', async () => {
  reports.push(await checkScenario('glimpse'));
});
Deno.test('scenario group c: write report', async () => {
  await writeReport(reports, 'scenarios-c.json');
});
