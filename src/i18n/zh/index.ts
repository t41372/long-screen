/** The zh (Simplified Chinese) catalogue: the reference shape every other catalogue is typed against (see
 *  ../catalog.ts). Split by where the text is shown so page, UI and pipeline strings can be edited independently. */
import { pageSections } from './page.ts';
import { uiSections } from './ui.ts';
import { pipelineSections } from './pipeline.ts';

export const zh = { ...pageSections, ...uiSections, ...pipelineSections };
