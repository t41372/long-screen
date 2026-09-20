import { buildScenario, SCENARIO_NAMES } from '../synthetic/scenarios.ts';
import { ScenarioSource } from '../synthetic/source.ts';
export { SCENARIO_NAMES };
/** Built-in demos are the same ground-truth scenarios the test suite verifies. */
export class DemoSource extends ScenarioSource {
    constructor(readonly kind = 'traversal') {
        super(buildScenario(kind));
    }
    get path() {
        return this.scenario.layers[0].path;
    }
}
