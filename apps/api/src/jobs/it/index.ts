/** Every technology job, spread into ALL_JOBS by the scheduler. */
import type { JobDefinition } from '../scheduler.js';
import { JOBS as assets } from './assets.js';
import { JOBS as software } from './software.js';
import { JOBS as vendors } from './vendors.js';
import { JOBS as servicedesk } from './servicedesk.js';
import { JOBS as itsm } from './itsm.js';
import { JOBS as governance } from './governance.js';
import { JOBS as portfolio } from './portfolio.js';
import { JOBS as continuity } from './continuity.js';

export const IT_JOBS: JobDefinition[] = [
  ...assets, ...software, ...vendors, ...servicedesk, ...itsm, ...governance, ...portfolio, ...continuity,
];
