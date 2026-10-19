/** The Italian website catalogue, typed against the source catalogue. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const it = { ...pageSections, ...uiSections, ...pipelineSections };
