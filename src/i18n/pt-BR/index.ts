/** Brazilian Portuguese, with each section checked against the canonical catalogue. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const ptBR = { ...pageSections, ...uiSections, ...pipelineSections };
