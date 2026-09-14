/** Compliance — books. Registered into ALL_JOBS through jobs/compliance/index.ts. */
import type { JobDefinition } from '../scheduler.js';
import { sweepRetention } from '../../domains/compliance/books.js';

export const JOBS: JobDefinition[] = [
  {
    name: 'runRetentionSweepJob',
    label: 'Records past their statutory retention floor',
    automationClass: 'data_maintenance',
    cron: '0 3 1 * *', // once a month
    run: async () => {
      const flagged = await sweepRetention();
      return { processed: flagged, notified: flagged > 0 ? 1 : 0, skippedIdempotent: 0, errors: [] };
    },
  },
];
