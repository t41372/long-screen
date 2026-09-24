import { registerShard } from '../support/scenario-check.ts';
// Shard 4 of 4 over SCENARIO_CATALOGUE (see tests/support/scenario-check.ts); report file name kept as
// test-results/scenarios-d.json — cited by src/synthetic/scenarios.ts (toolbar-collapse ratchet comment).
registerShard(import.meta.url);
