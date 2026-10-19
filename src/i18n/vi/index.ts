/** Vietnamese website catalogue, checked against the canonical catalogue in each section. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const vi = { ...pageSections, ...uiSections, ...pipelineSections };
