import type { JobDefinition } from '../scheduler.js';
import { detectLateGstFilings } from '../../domains/compliance/gst.js';

/** Compliance — gst. Registered into ALL_JOBS through jobs/compliance/index.ts. */
export const JOBS: JobDefinition[] = [
  {
    name: 'runGstLateFilingJob',
    label: 'GST late-filing exposure (Sec 47/50)',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: async () => {
      const raised = await detectLateGstFilings();
      return { processed: raised, notified: raised, skippedIdempotent: 0, errors: [] };
    },
  },
];
