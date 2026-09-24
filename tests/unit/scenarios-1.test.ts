import { registerShard } from '../support/scenario-check.ts';
// Shard 1 of 4 over SCENARIO_CATALOGUE (see tests/support/scenario-check.ts); report file name kept as
// test-results/scenarios-a.json for the citations in src/synthetic/scenarios.ts.
registerShard(import.meta.url);
