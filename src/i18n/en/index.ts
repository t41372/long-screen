/** The English catalogue. Each section file is typed against its zh counterpart, so a missing or extra key fails
 *  `deno task check`. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const en = { ...pageSections, ...uiSections, ...pipelineSections };
