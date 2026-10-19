/** Dutch website catalogue, checked against the shared catalogue shape. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const nl = { ...pageSections, ...uiSections, ...pipelineSections };
