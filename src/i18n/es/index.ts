/** Spanish, with each section checked against the canonical catalogue. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const es = { ...pageSections, ...uiSections, ...pipelineSections };
