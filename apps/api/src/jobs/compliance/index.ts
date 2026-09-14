/** Every compliance job, spread into ALL_JOBS by the scheduler. */
import type { JobDefinition } from '../scheduler.js';
import { JOBS as calendar } from './calendar.js';
import { JOBS as gst } from './gst.js';
import { JOBS as tax } from './tax.js';
import { JOBS as books } from './books.js';
import { JOBS as payroll } from './payroll.js';
import { JOBS as labour } from './labour.js';
import { JOBS as privacy } from './privacy.js';
import { JOBS as corporate } from './corporate.js';

export const COMPLIANCE_JOBS: JobDefinition[] = [
  ...calendar, ...gst, ...tax, ...books, ...payroll, ...labour, ...privacy, ...corporate,
];
