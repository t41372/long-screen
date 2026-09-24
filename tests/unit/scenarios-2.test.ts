import { registerShard } from '../support/scenario-check.ts';
// Shard 2 of 4 over SCENARIO_CATALOGUE (see tests/support/scenario-check.ts); report file name kept as
// test-results/scenarios-b.json.
registerShard(import.meta.url);
