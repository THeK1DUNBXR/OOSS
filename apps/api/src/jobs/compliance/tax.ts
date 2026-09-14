import type { JobDefinition } from '../scheduler.js';
import { runTdsDepositDueJob, runMsmeLadder } from '../../domains/compliance/tax.js';

const counted = (n: number) => ({ processed: n, notified: n, skippedIdempotent: 0, errors: [] });

/** Compliance — tax. Registered into ALL_JOBS through jobs/compliance/index.ts. */
export const JOBS: JobDefinition[] = [
  {
    name: 'runTdsDepositDueJob',
    label: 'CMP-TDS-002 TDS deposit-due ladder',
    automationClass: 'threshold_response',
    cron: '0 6 * * *',
    run: async () => counted(await runTdsDepositDueJob()),
  },
  {
    name: 'runMsme45DayJob',
    label: 'CMP-TDS-003 MSME 45-day payment term sweep',
    automationClass: 'threshold_response',
    cron: '0 7 * * *',
    run: async () => counted(await runMsmeLadder()),
  },
];
