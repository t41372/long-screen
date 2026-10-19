/** Japanese website catalogue, checked against the canonical catalogue in each section. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const ja = { ...pageSections, ...uiSections, ...pipelineSections };
