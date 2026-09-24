import { registerShard } from '../support/scenario-check.ts';
// Shard 3 of 4 over SCENARIO_CATALOGUE (see tests/support/scenario-check.ts); report file name kept as
// test-results/scenarios-c.json — cited by src/synthetic/scenarios.ts (repeated-list-reversal ratchet comment).
registerShard(import.meta.url);
