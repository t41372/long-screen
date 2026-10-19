/** Hindi website catalogue. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const hi = { ...pageSections, ...uiSections, ...pipelineSections };
